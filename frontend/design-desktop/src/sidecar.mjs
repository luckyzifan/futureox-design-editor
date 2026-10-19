import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { MAX_FRAME_BYTES } from './security.mjs'

function failure(code, message) {
  return Object.assign(new Error(message), { code })
}

/** Bounded NDJSON, no shell, sockets or renderer-selected executable. No automatic write retries. */
export const MAX_PENDING_BYTES = 96 * 1024 * 1024
// Reserve large result envelopes too; this is a wire/admission bound, not a JS RSS limit.
const responseReservations = new Map([
  ['sketch.inspect',MAX_FRAME_BYTES],['sketch.session.preview',MAX_FRAME_BYTES],
  ['open', MAX_FRAME_BYTES],
  ['recovery.read', MAX_FRAME_BYTES],
  ['workspace.open', MAX_FRAME_BYTES],
  ['workspace.restore', MAX_FRAME_BYTES],
  ['workspace.observe', 16 * 1024 * 1024],
  ['workspace.list', 8 * 1024 * 1024],
  ['fonts.list', 1024 * 1024],
  ['fonts.read', 32 * 1024 * 1024],
  ['workspace.revisions', 2 * 1024 * 1024],
  ['catalog.list', 32 * 1024 * 1024],
  ['catalog.scan', 2 * 1024 * 1024],
])
const responseReservation = (method) => responseReservations.get(method) || 4096
const writeMethods = new Set(['sketch.session.resizeLegacyContainer', 'sketch.session.setTextOverride', 'sketch.session.setLeafFrame', 'sketch.session.saveAs', 'sketch.session.undo', 'sketch.session.redo', 'sketch.session.open', 'sketch.session.rename', 'sketch.session.close', 'save', 'recovery.write', 'recovery.remove', 'catalog.register', 'catalog.scan', 'workspace.commit', 'workspace.trash', 'workspace.restore'])

export class Sidecar extends EventEmitter {
  constructor(executable, recoveryDir, { timeoutMs = 30_000, spawnProcess = spawn, catalogDb, workspaceDb, maxPendingBytes = MAX_PENDING_BYTES } = {}) {
    super()
    if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes < 1 || maxPendingBytes > MAX_PENDING_BYTES)
      throw new TypeError('Invalid aggregate request byte limit')
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
    this.bufferBytes = 0
    this.stopped = false
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
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !/^(ELECTRON_|NODE_OPTIONS$|LD_PRELOAD$|DYLD_)/.test(key),
        ),
      ),
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
      try {
        const response = JSON.parse(line.toString('utf8'))
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
      } catch {
        this.fail(failure('BACKEND_UNAVAILABLE', 'Malformed backend response'))
        return
      }
    }
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
      const { frame, pending } = this.writeQueue.shift()
      pending.sent = true
      try {
        const accepted = this.child.stdin.write(frame, (error) => {
          pending.written = true
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

  request(method, params = {}) {
    if (this.stopped || this.closing) return Promise.reject(failure('BACKEND_UNAVAILABLE', 'Backend unavailable'))
    if (this.admittedCount >= 8) return Promise.reject(failure('BUSY', 'Backend queue full'))
    const id = randomUUID()
    let frame
    try { frame = JSON.stringify({ id, method, params }) + '\n' }
    catch { return Promise.reject(failure('INVALID_REQUEST', 'Request is not serializable')) }
    const wireBytes = Buffer.byteLength(frame)
    const bytes = Math.max(wireBytes, responseReservation(method))
    if (wireBytes - 1 > MAX_FRAME_BYTES)
      return Promise.reject(failure('TOO_LARGE', 'Request frame too large'))
    if (this.pendingBytes + bytes > this.maxPendingBytes)
      return Promise.reject(failure('BUSY', 'Backend aggregate byte budget full'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A transmitted commit may have reached disk. Never claim rollback or retry it.
        this.fail(failure('BACKEND_TIMEOUT', 'Backend timed out; verify files before retrying'))
      }, this.timeoutMs)
      const pending = { resolve, reject, timer, bytes, method, sent: false, written: false, completed: false }
      this.pendingBytes += bytes
      this.admittedCount++
      this.pending.set(id, pending)
      this.writeQueue.push({ frame, pending })
      this.flushWrites()
    })
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
