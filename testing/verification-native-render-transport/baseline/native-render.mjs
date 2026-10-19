'use strict'
// design-render serve-mode bridge for the Electron main process. This is the
// .mjs port of frontend/design-client/src/kernel/electron/native-render-main.ts
// — the desktop main process is plain ESM and cannot import the TS modules.
// Keep the protocol in sync with native-render-bridge.ts (stdin/stdout JSON
// lines; see that file for the exact message shapes).
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { MAX_FRAME_BYTES } from './security.mjs'

export const NATIVE_RENDER_MAX_PENDING = 8
export const NATIVE_RENDER_MAX_PENDING_BYTES = 96 * 1024 * 1024

export function nativeRenderPaths(resourcesRoot) {
  return {
    binary: path.join(resourcesRoot, 'bin', `design-render${process.platform === 'win32' ? '.exe' : ''}`),
    font: path.join(resourcesRoot, 'fonts', 'NotoSansSC.ttf'),
  }
}

export class NativeRenderProcess {
  constructor(binaryPath, fontPath, backend, { timeoutMs = 120_000, spawnProcess = spawn } = {}) {
    this.binaryPath = binaryPath
    this.fontPath = fontPath
    this.backend = backend
    this.proc = undefined
    this.spawn = spawnProcess
    this.timeoutMs = timeoutMs
    this.parts = []
    this.bufferBytes = 0
    this.pending = undefined
    this.queue = []
    this.pendingBytes = 0
    this.writeBlocked = false
    this.closed = false
  }

  get available() {
    return !this.closed && this.proc !== undefined && this.proc.exitCode === null && this.proc.signalCode === null
  }

  spawnProcess() {
    const args = ['--serve', '--backend', this.backend]
    if (this.fontPath) args.push('--font', this.fontPath)
    this.proc = this.spawn(this.binaryPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const fail = error => { void this.stop(error) }
    this.proc.stdout.on('data', chunk => this.consume(chunk))
    this.proc.stdout.on('error', fail)
    // A full stderr pipe must never stall rendering. Do not expose document diagnostics.
    this.proc.stderr.on('data', () => {})
    this.proc.stderr.on('error', fail)
    this.proc.stdin.on('error', fail)
    this.proc.stdin.on('drain', () => { this.writeBlocked = false; this.flush() })
    this.proc.on('error', fail)
    // stdout can still contain the final reply after exit; settle only on close.
    this.proc.on('close', () => fail(new Error('Native render process exited')))
  }

  consume(chunk) {
    if (this.closed) return
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset)
      const end = newline < 0 ? chunk.length : newline
      const part = chunk.subarray(offset, end)
      if (this.bufferBytes + part.length > MAX_FRAME_BYTES) {
        void this.stop(new Error('Native render response exceeded limit')); return
      }
      this.parts.push(part); this.bufferBytes += part.length
      if (newline < 0) return
      const line = Buffer.concat(this.parts, this.bufferBytes)
      this.parts = []; this.bufferBytes = 0; offset = newline + 1
      if (!line.length) continue
      try { this.dispatch(JSON.parse(line.toString('utf8'))) }
      catch { void this.stop(new Error('Malformed native render response')); return }
      if (this.closed) return
    }
  }

  settle(request, error, value) {
    clearTimeout(request.timer)
    this.pendingBytes -= request.bytes
    if (error) request.reject(error)
    else request.resolve(value)
  }

  flush() {
    if (this.closed || this.pending || this.writeBlocked || !this.queue.length) return
    const request = this.queue.shift()
    this.pending = request
    try {
      this.writeBlocked = !this.proc.stdin.write(request.frame, error => {
        if (error) void this.stop(error)
      })
    } catch (error) { void this.stop(error) }
  }

  dispatch(msg) {
    const pending = this.pending
    if (!pending || !msg || (msg.type !== 'error' && msg.type !== pending.kind))
      throw new Error('Unexpected native render response')
    this.pending = undefined
    this.settle(pending, msg.type === 'error' ? new Error(msg.message || 'Native render error') : undefined, msg)
    this.flush()
  }

  request(kind, msg) {
    if (!this.available) throw new Error('Native render process is not running')
    if (this.queue.length + Number(!!this.pending) >= NATIVE_RENDER_MAX_PENDING)
      return Promise.reject(new Error('Native render queue full'))
    const frame = JSON.stringify(msg) + '\n'
    const bytes = Buffer.byteLength(frame)
    if (bytes - 1 > MAX_FRAME_BYTES || this.pendingBytes + bytes > NATIVE_RENDER_MAX_PENDING_BYTES)
      return Promise.reject(new Error('Native render request byte budget exceeded'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void this.stop(new Error('Native render timed out')) }, this.timeoutMs)
      this.pendingBytes += bytes
      this.queue.push({ resolve, reject, kind, frame, bytes, timer })
      this.flush()
    })
  }

  async load(documentJson) {
    if (this.closed) throw new Error('Native render bridge closed')
    if (!this.available) {
      // Do not replace an exited child until its stdout/close boundary settles.
      if (this.proc) throw new Error('Native render process is exiting')
      this.spawnProcess()
    }
    await this.request('loaded', { cmd: 'load', document: documentJson })
  }

  async frame(options, pan = 0) {
    const msg = await this.request('frame', { cmd: 'frame', options, pan })
    return { width: msg.width, height: msg.height, rgba: msg.rgba, stats: msg.stats }
  }

  async stats() {
    const msg = await this.request('stats', { cmd: 'stats' })
    return msg.stats || {}
  }

  stop(error = new Error('Bridge stopped')) {
    if (this.stopping) return this.stopping
    this.closed = true
    const child = this.proc
    this.proc = undefined
    this.parts = []; this.bufferBytes = 0
    if (this.pending) this.settle(this.pending, error)
    this.pending = undefined
    for (const request of this.queue) this.settle(request, error)
    this.queue = []
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
    this.stopping = new Promise(resolve => {
      const force = setTimeout(() => child.kill('SIGKILL'), 2000)
      force.unref()
      child.once('close', () => { clearTimeout(force); resolve() })
      // Stop is an ownership boundary: do not queue a graceful command behind
      // an expensive frame and leave a closed window's renderer alive.
      child.kill('SIGTERM')
    })
    return this.stopping
  }
}

/**
 * Register the native-render:* IPC handlers. `resourcesRoot` is the directory
 * that holds bin/design-render and fonts/NotoSansSC.ttf (dist in development,
 * process.resourcesPath when packaged). A missing binary is not fatal: the
 * handlers report { ok: false } and the renderer keeps its WASM worker path.
 */
export function registerNativeRender(ipcMain, { resourcesRoot, cpuOnly = false, assertSender }) {
  const { binary, font } = nativeRenderPaths(resourcesRoot)
  const binaryPath = existsSync(binary) ? binary : undefined
  if (!binaryPath) console.warn(`原生渲染桥:design-render 未安装于 ${binary},native-render:* 调用将返回错误`)
  const fontPath = existsSync(font) ? font : undefined
  const backend = cpuOnly ? 'cpu' : process.platform === 'darwin' ? 'metal' : 'auto'
  let bridge
  let owner
  const retiring = new Set()
  const retire = () => {
    const previous = bridge
    bridge = undefined
    owner = undefined
    if (previous) {
      const done = previous.stop()
      retiring.add(done)
      void done.finally(() => retiring.delete(done))
    }
    return Promise.all([...retiring])
  }
  const owners = new Set()
  const observeOwner = event => {
    const sender = event.sender
    if (owner !== undefined && owner !== sender.id) void retire()
    owner = sender.id
    if (owners.has(sender.id)) return
    owners.add(sender.id)
    sender.once('destroyed', () => {
      owners.delete(sender.id)
      if (owner === sender.id) void retire()
    })
    sender.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
      if (isMainFrame && !inPlace && owner === sender.id) void retire()
    })
  }
  const session = () => {
    if (!binaryPath) throw new Error(`design-render binary not installed at ${binary}`)
    if (!bridge) bridge = new NativeRenderProcess(binaryPath, fontPath, backend)
    return bridge
  }
  const handle = (name, action) => {
    ipcMain.handle(`native-render:${name}`, async (event, ...args) => {
      try {
        assertSender?.(event)
        if (bridge?.closed) void retire()
        observeOwner(event)
        return { ok: true, ...(await action(...args)) }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    })
  }
  handle('load', async (documentJson) => {
    if (typeof documentJson !== 'string' || !documentJson) throw new Error('Invalid document')
    await session().load(documentJson)
    return {}
  })
  handle('frame', async (options, pan) => {
    const result = await session().frame(options, typeof pan === 'number' ? pan : 0)
    return { width: result.width, height: result.height, rgba: result.rgba, stats: result.stats }
  })
  handle('stats', async () => ({ stats: await session().stats() }))
  handle('stop', async () => { await retire(); return {} })
  return retire
}
