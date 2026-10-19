'use strict'
// design-render serve-mode bridge for the Electron main process. This is the
// .mjs port of frontend/design-client/src/kernel/electron/native-render-main.ts
// — the desktop main process is plain ESM and cannot import the TS modules.
// Keep the protocol in sync with native-render-bridge.ts (stdin/stdout JSON
// lines; see that file for the exact message shapes).
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export function nativeRenderPaths(resourcesRoot) {
  return {
    binary: path.join(resourcesRoot, 'bin', `design-render${process.platform === 'win32' ? '.exe' : ''}`),
    font: path.join(resourcesRoot, 'fonts', 'NotoSansSC.ttf'),
  }
}

class NativeRenderProcess {
  constructor(binaryPath, fontPath, backend) {
    this.binaryPath = binaryPath
    this.fontPath = fontPath
    this.backend = backend
    this.proc = undefined
    this.buffer = ''
    this.pending = undefined
  }

  get available() {
    return this.proc !== undefined && this.proc.exitCode === null
  }

  spawnProcess() {
    const args = ['--serve', '--backend', this.backend]
    if (this.fontPath) args.push('--font', this.fontPath)
    this.proc = spawn(this.binaryPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString('utf-8')
      const lines = this.buffer.split('\n')
      this.buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          this.dispatch(JSON.parse(line))
        } catch { /* incomplete line */ }
      }
    })
    this.proc.on('error', (error) => {
      this.pending?.reject(error)
      this.pending = undefined
    })
    this.proc.on('exit', () => {
      this.pending?.reject(new Error('Native render process exited'))
      this.pending = undefined
      this.proc = undefined
    })
  }

  dispatch(msg) {
    const pending = this.pending
    if (!pending) return
    if (msg.type === 'error') {
      this.pending = undefined
      pending.reject(new Error(msg.message || 'Native render error'))
    } else if (msg.type === pending.kind) {
      this.pending = undefined
      pending.resolve(msg)
    }
  }

  request(kind, msg) {
    if (!this.available) throw new Error('Native render process is not running')
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, kind }
      this.proc.stdin.write(JSON.stringify(msg) + '\n')
    })
  }

  async load(documentJson) {
    if (!this.available) this.spawnProcess()
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

  stop() {
    if (this.stopping) return this.stopping
    const child = this.proc
    this.proc = undefined
    this.buffer = ''
    this.pending?.reject(new Error('Bridge stopped'))
    this.pending = undefined
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
