import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { MAX_FRAME_BYTES } from './security.mjs'
import { DOCUMENT_TRANSFER_BYTES, documentChildEnvironment, assertDocumentSerialization } from './document-capacity.mjs'
import { documentWrites, DocumentFrameAssembler } from './document-transport.mjs'
import { SQLITE_OFFTHREAD_BYTES } from './workspace-sqlite-worker-host.mjs'

function failure(code, message) {
  return Object.assign(new Error(message), { code })
}

/** Bounded NDJSON, no shell, sockets or renderer-selected executable. No automatic write retries. */
export const MAX_PENDING_BYTES = DOCUMENT_TRANSFER_BYTES + 8 * 1024 * 1024
// Reserve large result envelopes too; this is a wire/admission bound, not a JS RSS limit.
const responseReservations = new Map([
  ['large.scene', 64 * 1024], ['large.sceneRead', 768 * 1024], ['large.canvasLayout', 512 * 1024], ['large.canvasSnapshot', 512 * 1024],
  // A 2 MiB JSON fragment is itself a string inside the RPC envelope: reserve
  // its worst-case quote/backslash escaping as well as bounded metadata.
  ['large.read', 4 * 1024 * 1024 + 64 * 1024], ['large.project', 4 * 1024 * 1024 + 64 * 1024], ['large.children', 512 * 1024],
  ['automation.audit.list', 256 * 1024], ['automation.task.list', 512 * 1024],
  ['sketch.inspect',MAX_FRAME_BYTES],['sketch.session.preview',MAX_FRAME_BYTES],
  ['open', DOCUMENT_TRANSFER_BYTES],
  ['recovery.read', DOCUMENT_TRANSFER_BYTES],
  ['workspace.open', DOCUMENT_TRANSFER_BYTES],
  ['workspace.restore', DOCUMENT_TRANSFER_BYTES],
  ['workspace.observe', 16 * 1024 * 1024],
  ['workspace.list', 8 * 1024 * 1024],
  ['fonts.list', 1024 * 1024],
  ['fonts.read', 32 * 1024 * 1024],
  ['workspace.revisions', 2 * 1024 * 1024],
  ['catalog.list', 32 * 1024 * 1024],
  ['catalog.scan', 2 * 1024 * 1024],
])
const responseReservation = (method) => responseReservations.get(method) || 4096
const writeMethods = new Set(['automation.config.set', 'automation.audit.append', 'automation.task.put', 'sketch.session.resizeLegacyContainer', 'sketch.session.setTextOverride', 'sketch.session.setLeafFrame', 'sketch.session.saveAs', 'sketch.session.undo', 'sketch.session.redo', 'sketch.session.open', 'sketch.session.rename', 'sketch.session.close', 'save', 'recovery.write', 'recovery.remove', 'catalog.register', 'catalog.scan', 'workspace.commit', 'workspace.trash', 'workspace.restore'])

for(const method of ['large.open','large.apply','large.commitCanvas','large.sceneCommit','large.undo','large.redo','large.export'])writeMethods.add(method)
// Keep execution deadlines and cooperative cancellation on the same long-job set.
// Chunk reads are bounded control/data transfers, not another scene preparation.
const largeDocumentJobs = new Set(['large.open','large.export','large.project','large.scene','large.canvasLayout','large.canvasSnapshot','large.apply','large.commitCanvas','large.sceneCommit','large.undo','large.redo'])

export class Sidecar extends EventEmitter {
  constructor(executable, recoveryDir, { timeoutMs = 30_000, queueTimeoutMs = 600_000, spawnProcess = spawn, catalogDb, workspaceDb, maxPendingBytes = MAX_PENDING_BYTES, sqliteCodec = null } = {}) {
    super()
    if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes < 1 || maxPendingBytes > MAX_PENDING_BYTES)
      throw new TypeError('Invalid aggregate request byte limit')
    this.queueTimeoutMs = Math.max(timeoutMs, queueTimeoutMs)
    this.timeoutMs = timeoutMs
    this.maxPendingBytes = maxPendingBytes
    this.pendingBytes = 0
    this.admittedCount = 0
    this.writeQueue = []
    this.writeBlocked = false
    this.closing = false
    this.inputEnded = false
    this.pending = new Map()
    this.parts = []
    this.assembler = new DocumentFrameAssembler(DOCUMENT_TRANSFER_BYTES)
    this.bufferBytes = 0
    this.stopped = false
    this.sqliteCodec = sqliteCodec
    this.decoding = undefined
    this.exited = false
    this.closed = false
    this.termination = null
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve
    })
    this.child = spawnProcess(executable, ['--recovery-dir', recoveryDir, ...(catalogDb ? ['--catalog-db', catalogDb] : []), ...(workspaceDb ? ['--workspace-db', workspaceDb] : [])], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      // Do not pass Electron's node-mode or arbitrary dynamic-loader settings to the backend.
      env: documentChildEnvironment(Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !/^(ELECTRON_|NODE_OPTIONS$|LD_PRELOAD$|DYLD_)/.test(key),
        ),
      )),
    })
    this.child.stdout.on('error', () => this.fail(failure('BACKEND_UNAVAILABLE', 'Backend output closed')))
    this.child.stdout.on('data', (chunk) => this.consume(Buffer.from(chunk)))
    this.child.stderr.on('data', () => {
      /* Do not leak document contents or local paths to renderer/logs. */
    })
    this.child.stdin.on('drain', () => { this.writeBlocked = false; this.flushWrites() })
    this.child.stdin.on('error', () =>
      this.fail(failure('BACKEND_UNAVAILABLE', 'Backend input closed')),
    )
    this.child.on('error', () =>
      this.fail(failure('BACKEND_UNAVAILABLE', 'Backend could not start')),
    )
    this.child.on('exit', (code, signal) => {
      this.exited = true
      this.exitDescription = `Backend exited (${code ?? signal})`
      // Wait for close: stdout can still contain the accurate commit response after exit.
    })
    this.child.on('close', () => {
      this.closed = true
      this.exited = true
      this.resolveExit(true)
      this.fail(failure('BACKEND_UNAVAILABLE', this.exitDescription || 'Backend closed'))
    })
  }

  consume(chunk) {
    if (this.stopped) return
    // Inspect each line independently, including a chunk containing several responses.
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset)
      const end = newline < 0 ? chunk.length : newline
      const part = chunk.subarray(offset, end)
      if (this.bufferBytes + part.length > MAX_FRAME_BYTES) {
        this.fail(failure('BACKEND_UNAVAILABLE', 'Backend frame exceeded limit'))
        return
      }
      this.parts.push(part)
      this.bufferBytes += part.length
      if (newline < 0) return
      const line = Buffer.concat(this.parts, this.bufferBytes)
      this.parts = []
      this.bufferBytes = 0
      offset = newline + 1
      this.enqueueLine(line)
    }
  }

  enqueueLine(line) {
    if (this.stopped) return
    const heavy = !!(this.sqliteCodec && line.length >= SQLITE_OFFTHREAD_BYTES && !line.subarray(0, 17).toString().startsWith('{"desktopChunk":'))
    if (!heavy && !this.decoding) {
      this.decodeLineSync(line)
      return
    }
    // A large SQLite document is parsed on the codec worker. Later lines wait
    // so scheduling receipts and results keep their original order.
    this.decoding = (this.decoding ?? Promise.resolve()).then(() => this.decodeLineAsync(line)).catch(() => {
      this.fail(failure('BACKEND_UNAVAILABLE', 'Malformed backend response'))
    })
    const current = this.decoding
    void current.finally(() => { if (this.decoding === current) this.decoding = undefined })
  }

  decodeLineSync(line) {
    try {
      const assembled = this.assembler.accept(line)
      if (!assembled) return
      this.applyResponse(JSON.parse(assembled.toString('utf8')))
    } catch {
      this.fail(failure('BACKEND_UNAVAILABLE', 'Malformed backend response'))
    }
  }

  async decodeLineAsync(line) {
    if (this.stopped) return
    const assembled = this.assembler.accept(line)
    if (!assembled) return
    const response = this.sqliteCodec && assembled.length >= SQLITE_OFFTHREAD_BYTES
      ? (await this.sqliteCodec.decodeResponse(assembled)).response
      : JSON.parse(assembled.toString('utf8'))
    this.applyResponse(response)
  }

  applyResponse(response) {
    if (Object.hasOwn(response, 'desktopScheduling')) {
      const event=response.desktopScheduling, pending=this.pending.get(event?.id)
      if(Object.keys(response).length!==1 || !event || Object.keys(event).length!==2 || !pending ||
        !['queued','running'].includes(event.phase) ||
        event.phase==='queued' && pending.phase!=='submitted' ||
        event.phase==='running' && pending.phase!=='queued') throw Error('Invalid scheduling receipt')
      clearTimeout(pending.timer);pending.phase=event.phase
      pending.timer=setTimeout(()=>this.fail(failure('BACKEND_TIMEOUT',event.phase==='queued'?'Backend queue wait exceeded its bound':'Backend execution timed out; verify files before retrying')),
        event.phase==='queued'?this.queueTimeoutMs:this.executionTimeout(pending.method))
      return
    }
    const pending = this.pending.get(response.id)
    if (!pending || !!response.error === Object.hasOwn(response, 'result'))
      throw new Error('Invalid response')
    clearTimeout(pending.timer)
    this.pending.delete(response.id)
    pending.completed = true
    this.releaseBytes(pending)
    if (response.error)
      pending.reject(
        failure(
          response.error.code || 'BACKEND_ERROR',
          response.error.message || 'Backend request failed',
        ),
      )
    else pending.resolve(response.result)
  }

  releaseBytes(pending) {
    if (!this.stopped && pending.completed && pending.written && !pending.released) {
      pending.released = true
      this.pendingBytes -= pending.bytes
      this.admittedCount--
    }
  }

  flushWrites() {
    if (this.stopped || this.writeBlocked) return
    while (this.writeQueue.length && !this.writeBlocked && !this.stopped) {
      const queued = this.writeQueue[0]
      const { pending } = queued
      const frame = queued.next.value
      queued.next = queued.frames.next()
      if (queued.next.done) { this.writeQueue.shift(); pending.allQueued = true }
      pending.outstandingWrites++
      pending.sent = true
      try {
        const accepted = this.child.stdin.write(frame, (error) => {
          pending.outstandingWrites--
          pending.written = pending.allQueued && pending.outstandingWrites === 0
          this.releaseBytes(pending)
          if (error) this.fail(failure('BACKEND_UNAVAILABLE', 'Backend write failed'))
        })
        if (!accepted) this.writeBlocked = true
      } catch { this.fail(failure('BACKEND_UNAVAILABLE', 'Backend write failed')) }
    }
    if (this.closing && !this.writeQueue.length && !this.writeBlocked && !this.inputEnded) {
      this.inputEnded = true
      this.child.stdin.end()
    }
  }

  executionTimeout(method) {
    return largeDocumentJobs.has(method) ? Math.max(this.timeoutMs, 600_000) : this.timeoutMs
  }
  request(method, params = {}) {
    if (this.stopped || this.closing) return Promise.reject(failure('BACKEND_UNAVAILABLE', 'Backend unavailable'))
    // Reserve one small control request for cancelling already-admitted work.
    // This cannot add a ninth data job or bypass its byte admission.
    const control = method === 'cancel' && typeof params.requestId === 'string' && this.pending.has(params.requestId) && ![...this.pending.values()].some(p => p.method === 'cancel')
    if (this.admittedCount >= 8 && !control) return Promise.reject(failure('BUSY', 'Backend queue full'))
    const id = randomUUID()
    let frame, bytes
    try {
      const wireBytes = assertDocumentSerialization({ id, method, params, scheduling:true }, DOCUMENT_TRANSFER_BYTES)
      bytes = Math.max(wireBytes, responseReservation(method))
      if (this.pendingBytes + bytes > this.maxPendingBytes + (control ? 4096 : 0))
        return Promise.reject(failure('BUSY', 'Backend aggregate byte budget full'))
      frame = JSON.stringify({ id, method, params, scheduling:true })
    } catch (error) { return Promise.reject(failure(/working-memory/.test(error.message) ? 'TOO_LARGE' : 'INVALID_REQUEST', error.message)) }
    return this.enqueue(method, id, Buffer.from(frame), bytes)
  }

  // `frame` is the JSON object without its newline. The caller already counted
  // `wireBytes` with the same admission walk the inline path uses.
  requestFrame(method, id, frame, wireBytes) {
    if (this.stopped || this.closing) return Promise.reject(failure('BACKEND_UNAVAILABLE', 'Backend unavailable'))
    if (this.admittedCount >= 8) return Promise.reject(failure('BUSY', 'Backend queue full'))
    if (typeof method !== 'string' || typeof id !== 'string' || id.length < 1 || id.length > 128 || this.pending.has(id))
      return Promise.reject(failure('INVALID_REQUEST', 'Invalid prepared SQLite frame'))
    if (!Buffer.isBuffer(frame) || !Number.isSafeInteger(wireBytes) || wireBytes < 2 || frame.length > DOCUMENT_TRANSFER_BYTES || wireBytes > DOCUMENT_TRANSFER_BYTES)
      return Promise.reject(failure('TOO_LARGE', 'Document exceeds the available working-memory allowance'))
    const bytes = Math.max(frame.length, wireBytes, responseReservation(method))
    if (this.pendingBytes + bytes > this.maxPendingBytes) return Promise.reject(failure('BUSY', 'Backend aggregate byte budget full'))
    return this.enqueue(method, id, frame, bytes)
  }

  enqueue(method, id, frame, bytes) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A transmitted commit may have reached disk. Never claim rollback or retry it.
        this.fail(failure('BACKEND_TIMEOUT', 'Backend timed out; verify files before retrying'))
      }, this.executionTimeout(method))
      const pending = { resolve, reject, timer, bytes, method, phase:'submitted', sent: false, written: false, completed: false, allQueued: false, outstandingWrites: 0 }
      this.pendingBytes += bytes
      this.admittedCount++
      this.pending.set(id, pending)
      const frames = documentWrites(frame, id, MAX_FRAME_BYTES)
      this.writeQueue.push({ frames, next: frames.next(), pending })
      this.flushWrites()
    })
  }

  async cancelLargeDocument() {
    const jobs = [...this.pending].filter(([, pending]) => largeDocumentJobs.has(pending.method))
    const results = []
    for (const [requestId] of jobs) results.push(await this.request('cancel', { requestId }))
    return { requested: jobs.length, running: results.some(result => result.running), cancelled: results.some(result => result.cancelled) }
  }

  fail(error) {
    if (this.stopped) return
    this.stopped = true
    this.parts = []
    this.bufferBytes = 0
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      const outcomeUnknown = pending.sent && writeMethods.has(pending.method)
      pending.reject(Object.assign(failure(error.code, error.message), { outcomeUnknown }))
      // Prevent late writable callbacks from releasing the cleared ledger twice.
      pending.released = true
    }
    this.pending.clear()
    this.assembler.clear()
    this.writeQueue = []
    this.pendingBytes = 0
    this.admittedCount = 0
    void this.terminate()
    this.emit('unavailable', error)
  }

  terminate() {
    if (this.termination) return this.termination
    if (this.closed) return Promise.resolve(true)
    this.termination = (async () => {
      if (!this.exited) this.child.kill('SIGTERM')
      let timer
      const exited = await Promise.race([
        this.exitPromise,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), 1_000)
        }),
      ])
      clearTimeout(timer)
      if (exited) return true
      if (!this.exited) this.child.kill('SIGKILL')
      const reaped = await Promise.race([
        this.exitPromise,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), 2_000)
        }),
      ])
      clearTimeout(timer)
      return reaped
    })()
    return this.termination
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise
    this.stopPromise = (async () => {
      if (this.stopped) return this.terminate()
      this.closing = true
      const hadPending = this.pending.size > 0
      this.flushWrites()
      let timer
      const drained = await Promise.race([
        this.exitPromise,
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), hadPending ? this.timeoutMs : 100) }),
      ])
      clearTimeout(timer)
      if (drained) return true
      this.fail(failure('BACKEND_UNAVAILABLE', 'Backend shutdown interrupted; verify pending writes before retrying'))
      return this.terminate()
    })()
    return this.stopPromise
  }
}
