import { DOCUMENT_MEMORY_BYTES, DOCUMENT_BYTE_LIMIT } from '../src/document-capacity.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm, mkdir, writeFile, rename, realpath, symlink } from 'node:fs/promises'
import { makeFd, productZip } from './product-export-fixtures.mjs'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

// Exercise the real main module's registered handlers. Only OS/Electron/stdio boundaries
// are replaced; no production test hooks or renderer privilege exceptions are shipped.
async function host({ platform = 'darwin', savedWindow, startupFiles = [], gpuWorkingBudget, gpuStartupMemory = {}, prepare } = {}) {
  // macOS tmpdir is a /var -> /private/var symlink; resolved grant paths use it.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'forma-host-')))
  const key = `__formaHost_${randomUUID()}`
  const state = {
    root,
    gpuWorkingBudget,
    gpuStartupMemory,
    handlers: new Map(),
    open: [],
    save: [],
    messages: [{ response: 1 }], // Explicitly choose the legacy default in the startup chooser.
    prompts: [],
    requests: [],
    backends: [],
    children: [],
    relaunchCalls: 0,
    documents: new Map(),
    recoveries: new Map(),
    recoveryIssues: [],
    timers: [],
    closeCalls: 0,
    maxRecovery: 16,
    sent: [],
    listeners: new Map(),
    platform,
    windows: [],
    recent: [],
    quitCalls: 0,
    stopCalls: 0,
    protocolRegistrations: 0,
  }
  if (savedWindow) await writeFile(path.join(root, 'window-state-v1.json'), JSON.stringify(savedWindow))
  let ready
  const loaded = new Promise((resolve) => {
    ready = resolve
  })
  const app = new EventEmitter()
  Object.assign(app, {
    setName() {},
    enableSandbox() {},
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    whenReady: () => {
      for (const filePath of startupFiles) app.emit('open-file', { preventDefault() {} }, filePath)
      return Promise.resolve()
    },
    getPath: () => root,
    getAppPath: () => root,
    addRecentDocument: value => state.recent.push(value),
    quit() { state.quitCalls++ },
    relaunch() { state.relaunchCalls++; if (state.relaunchFailure) throw new Error('Relaunch failed') },
    exit() {},
  })
  class Window extends EventEmitter {
    constructor(options) {
      super()
      this.options = options
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height }
      this.webContents = new EventEmitter()
      Object.assign(this.webContents, {
        mainFrame: { url: '' },
        setWindowOpenHandler() {},
        setZoomFactor(value) { state.pageZoom = value },
        setIgnoreMenuShortcuts(value) { state.ignoreMenuShortcuts = value },
        undo() { state.textCommand = 'undo' }, redo() { state.textCommand = 'redo' },
        cut() { state.textCommand = 'cut' }, copy() { state.textCommand = 'copy' },
        paste() { state.textCommand = 'paste' }, selectAll() { state.textCommand = 'selectAll' },
        send(...args) {
          state.sent.push(args)
        },
      })
      state.window = this
      state.windows.push(this)
    }
    isDestroyed() {
      return Boolean(this.destroyed)
    }
    setDocumentEdited() {}
    getNormalBounds() { return this.bounds }
    getMinimumSize() { return this.minimum || [this.options.minWidth, this.options.minHeight] }
    setMinimumSize(width, height) { this.minimum = [width, height] }
    setBounds(value) { this.bounds = value }
    isMaximized() { return !!this.maximized }
    maximize() { this.maximized = true }
    isFullScreen() { return !!this.fullscreen }
    setFullScreen(value) { this.fullscreen = value }
    isMinimized() { return !!this.minimized }
    restore() { this.minimized = false }
    focus() { state.focused = this }
    async loadURL(url) {
      this.webContents.mainFrame.url = url
      this.emit('ready-to-show')
      ready()
    }
    show() {}
    close() {
      state.closeCalls++
      this.emit('close', { preventDefault() {} })
    }
  }
  const isolated = new EventEmitter()
  Object.assign(isolated, {
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    setDevicePermissionHandler() {},
    webRequest: { onBeforeRequest() {} },
    protocol: {
      handle(_scheme, handler) {
        state.protocolRegistrations++
        state.protocol = handler
      },
    },
  })
  state.session = isolated
  const dialog = {
    async showOpenDialog() {
      return state.open.shift() || { canceled: true, filePaths: [] }
    },
    async showSaveDialog() {
      return state.save.shift() || { canceled: true }
    },
    async showMessageBox(_window, prompt = _window) {
      state.prompts.push(prompt)
      return state.messages.shift() || { response: prompt.cancelId }
    },
  }
  const screen = new EventEmitter()
  state.displays = [{ id: 1, workArea: { x: 0, y: 25, width: 1728, height: 1092 } }]
  Object.assign(screen, { getAllDisplays: () => state.displays, getPrimaryDisplay: () => state.displays[0] })
  state.screen = screen
  state.electron = {
    app,
    screen,
    BrowserWindow: Window,
    dialog,
    ipcMain: {
      handle: (name, fn) => state.handlers.set(name, fn),
      on: (name, fn) => state.listeners.set(name, fn),
    },
    Menu: { buildFromTemplate: (value) => value, setApplicationMenu(value) { state.menu = value } },
    protocol: { registerSchemesAsPrivileged() {} },
    session: { fromPartition: () => isolated },
    nativeImage: {createFromBuffer: bytes => {state.clipboardDecoded=bytes;return {isEmpty:()=>false,getSize:()=>({width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)})}}},
    ClipboardItem: class {
      constructor(values){this.values=values;this.types=Object.keys(values)}
      async getType(type){const value=await this.values[type];if(value===undefined)throw new Error('Missing MIME');return value instanceof Blob?value:new Blob([value],{type})}
    },
    clipboard: {
      read: async()=>state.clipboardItems||[],
      write: async items=>{
        assert.ok(Array.isArray(items),'Electron 44 requires ClipboardItem[]')
        if(state.clipboardWriteFailure)throw new Error('Clipboard write failed')
        state.clipboardItems=items
        state.clipboardText=items[0].types.includes('text/plain')?await(await items[0].getType('text/plain')).text():''
        state.clipboardImage=items[0].types.includes('image/png')?Buffer.from(await(await items[0].getType('image/png')).arrayBuffer()):undefined
      },
    },
  }
  state.Sidecar = class {
    constructor(executable, recoveryDir, options) { state.backends.push({ executable, recoveryDir, ...options }) }
    async stop() {
      state.stopCalls++
      return true
    }
    async request(method, params = {}) {
      state.requests.push({ method, params })
      if (method === 'workspace.open') return { id: params.id }
      if (method === 'workspace.list') { if (state.workspaceFailure) throw Object.assign(new Error('Invalid workspace'), { code: state.workspaceFailure }); return { documents: [] } }
      if (method === 'catalog.list') return { projects: [], directories: [], files: [] }
      if (method === 'health') return { protocolVersion: 1, maxDocumentBytes: DOCUMENT_BYTE_LIMIT, documentTransferVersion: 1, documentCapacity: { memoryBytes: DOCUMENT_MEMORY_BYTES } }
      if (method === 'fonts.list') return { fonts: [{ id: 'font-1' }], truncated: false }
      if (method === 'fonts.read') {
        if (state.fontChanged) throw Object.assign(new Error('changed'), { code: 'FONT_CHANGED' })
        return { font: { id: params.id }, data: 'AA==' }
      }
      if (method === 'catalog.register') return {
        project: { id: 'project-1', name: 'Local', updatedAt: 1 },
        directory: { id: 'directory-1', projectId: 'project-1', path: params.path, updatedAt: 1 },
      }
      if (method === 'catalog.scan') return { directoryId: params.directoryId, truncated: false,
        files: [{ id: 'file-1', directoryId: params.directoryId, relativePath: 'drawing.fd', size: 2, modifiedAt: 1, indexedAt: 1 }] }
      if (method === 'sketch.inspect') return state.sketchResult?.(params) || {
        owner: { kernel_id: 'sketch', document_schema: 'sketch-native-v1', document_id: params.documentId, session_epoch: params.sessionEpoch },
        pageCount: 1, layerCount: 2, editable: false, renderable: false,
        path: params.path, documentJson: 'must never reach renderer',
      }
      if (method === 'open') {
        if (state.openFailure) throw Object.assign(new Error('Cannot open fixture'), { code: state.openFailure })
        return {
          path: params.path,
          hash: 'opened-hash',
          document: { name: path.basename(params.path) },
        }
      }
      if (method === 'stat')
        return {
          path: params.path,
          hash: state.documents.has(params.path) ? 'existing-hash' : null,
        }
      if (method === 'save') {
        state.documents.set(params.path, params.document)
        return { path: params.path, hash: 'saved-hash' }
      }
      if (method === 'recovery.list')
        return { entries: [...state.recoveries.values()], issues: state.recoveryIssues }
      if (method === 'recovery.read') return state.recoveries.get(params.recoveryId)
      if (method === 'recovery.write') {
        if (state.recoveries.size >= state.maxRecovery && !state.recoveries.has(params.recoveryId))
          throw Object.assign(new Error('full'), { code: 'RECOVERY_LIMIT' })
        state.recoveries.set(params.recoveryId, { ...params, hash: 'snapshot-hash' })
        return {}
      }
      if (method === 'recovery.remove')
        return { removed: state.recoveries.delete(params.recoveryId) }
      throw new Error(`Unexpected method ${method}`)
    }
  }
  state.spawn = () => {
    const child = new EventEmitter()
    child.unref = () => {}
    state.children.push(child)
    setImmediate(() => child.emit('spawn'))
    return child
  }
  globalThis[key] = state
  const src = new URL('../src/main.mjs', import.meta.url)
  let source = await readFile(src, 'utf8')
  source = source.replace(
    /import \{ app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, clipboard, screen, nativeImage, ClipboardItem, powerMonitor \} from 'electron'/,
    `const { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, clipboard, screen, nativeImage, ClipboardItem, powerMonitor } = globalThis[${JSON.stringify(key)}].electron`,
  )
  source = source.replace("from './render-terminal-diagnostics.mjs'", `from ${JSON.stringify(new URL('../src/render-terminal-diagnostics.mjs', import.meta.url).href)}`)
  source = source.replace("from './pet/host.mjs'", `from ${JSON.stringify(new URL('../src/pet/host.mjs', import.meta.url).href)}`)
  source = source.replace("from './diagnostic-file.mjs'", `from ${JSON.stringify(new URL('../src/diagnostic-file.mjs', import.meta.url).href)}`)
  source = source.replace("from './workspace-roots.mjs'", `from ${JSON.stringify(new URL('../src/workspace-roots.mjs', import.meta.url).href)}`)
  source = source.replace("from './document-capacity.mjs'", `from ${JSON.stringify(new URL('../src/document-capacity.mjs', import.meta.url).href)}`)
  source = source.replace("from './gpu-working-budget.mjs'", `from ${JSON.stringify(new URL('../src/gpu-working-budget.mjs', import.meta.url).href)}`)
  source = source.replace('process.env.CORE_GPU_WORKING_BUDGET_MIB', `globalThis[${JSON.stringify(key)}].gpuWorkingBudget`)
  source = source.replace('arch: process.arch, ...STARTUP_MEMORY', `arch: 'arm64', ...globalThis[${JSON.stringify(key)}].gpuStartupMemory`)
  source = source.replace("from './keyboard-shortcuts.mjs'", `from ${JSON.stringify(new URL('../src/keyboard-shortcuts.mjs', import.meta.url).href)}`)
  source = source.replace("from './figma-mcp-host.mjs'", `from ${JSON.stringify(new URL('../src/figma-mcp-host.mjs', import.meta.url).href)}`)
  source = source.replace("import { registerAutomationBridge } from './automation-bridge.mjs'",
    `import { registerAutomationBridge as registerRealAutomationBridge } from ${JSON.stringify(new URL('../src/automation-bridge.mjs', import.meta.url).href)}; const registerAutomationBridge = options => { globalThis[${JSON.stringify(key)}].automationOptions = options; return registerRealAutomationBridge(options) }`)

  source = source.replace("from './native-locale.mjs'", `from ${JSON.stringify(new URL('../src/native-locale.mjs', import.meta.url).href)}`)
  source = source.replace("from './design-ai.mjs'", `from ${JSON.stringify(new URL('../src/design-ai.mjs', import.meta.url).href)}`)
  source = source.replace("from './plugin-package.mjs'", `from ${JSON.stringify(new URL('../src/plugin-package.mjs', import.meta.url).href)}`)
  source = source.replace("from './plugin-ui.mjs'", `from ${JSON.stringify(new URL('../src/plugin-ui.mjs', import.meta.url).href)}`)
  source = source.replace("from './clipboard.mjs'", `from ${JSON.stringify(new URL('../src/clipboard.mjs', import.meta.url).href)}`)
  source = source.replace("import { spawn } from 'node:child_process'", `const { spawn } = globalThis[${JSON.stringify(key)}]`)
  source = source.replaceAll('process.platform' , `globalThis[${JSON.stringify(key)}].platform`)
  source = source.replace(
    "import { Sidecar } from './sidecar.mjs'",
    `const { Sidecar } = globalThis[${JSON.stringify(key)}]`,
  )
  source = source.replace("from './sketch-session.mjs'", `from ${JSON.stringify(new URL('../src/sketch-session.mjs', import.meta.url).href)}`)
  source = source.replace("from './kernel-admission.mjs'", `from ${JSON.stringify(new URL('../src/kernel-admission.mjs', import.meta.url).href)}`)
  source = source.replace("from './directory-grants.mjs'", `from ${JSON.stringify(new URL('../src/directory-grants.mjs', import.meta.url).href)}`)
  source = source.replace("from './window-state.mjs'", `from ${JSON.stringify(new URL('../src/window-state.mjs', import.meta.url).href)}`)
  source = source.replace("from './legacy-user-data.mjs'", `from ${JSON.stringify(new URL('../src/legacy-user-data.mjs', import.meta.url).href)}`)
  source = source.replace("from './native-render.mjs'", `from ${JSON.stringify(new URL('../src/native-render.mjs', import.meta.url).href)}`)
  source = source.replace("from './ffmpeg-encode.mjs'", `from ${JSON.stringify(new URL('../src/ffmpeg-encode.mjs', import.meta.url).href)}`)
  source = source.replace("from './preparation.mjs'", `from ${JSON.stringify(new URL('../src/preparation.mjs', import.meta.url).href)}`)
  source = source.replace("from './large-document.mjs'", `from ${JSON.stringify(new URL('../src/large-document.mjs', import.meta.url).href)}`)
  source = source.replace("from './render-check.mjs'", `from ${JSON.stringify(new URL('../src/render-check.mjs', import.meta.url).href)}`)
  source = source.replace("from './workspace-sqlite-worker-host.mjs'", `from ${JSON.stringify(new URL('../src/workspace-sqlite-worker-host.mjs', import.meta.url).href)}`)
  source = source.replace(
    "from './security.mjs'",
    `from ${JSON.stringify(new URL('../src/security.mjs', import.meta.url).href)}`,
  )
  source = source.replace(
    'const here = path.dirname(fileURLToPath(import.meta.url))',
    `const here = ${JSON.stringify(path.dirname(fileURLToPath(src)))}`,
  )
  // The data-URL harness needs absolute imports for every actual host module,
  // including newly added adapters that do not need a test double.
  source = source.replace(/from (['"])(\.\/[^'"]+)\1/g, (_match, _quote, relative) =>
    `from ${JSON.stringify(new URL(`../src/${relative.slice(2)}`, import.meta.url).href)}`)
  source = source.replaceAll('fileURLToPath(import.meta.url)', JSON.stringify(fileURLToPath(src)))
  source =
    'const setTimeout = (callback) => { globalThis[' +
    JSON.stringify(key) +
    '].timers.push(callback); return 0 }; const clearTimeout = () => {};\n' +
    source
  if (prepare) await prepare(root)
  try {
    await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  } catch (error) {
    delete globalThis[key]
    await rm(root, { recursive: true, force: true })
    throw error
  }
  await loaded
  state.invoke = (name, value, event) =>
    state.handlers.get(`design-desktop:${name}`)(
      event || {
        sender: state.window.webContents,
        senderFrame: state.window.webContents.mainFrame,
      },
      value,
    )
  await state.invoke('renderer-ready')
  state.startupPrompts = state.prompts.splice(0)
  state.startupRequests = state.requests.splice(0)
  state.startupStopCalls = state.stopCalls
  state.stopCalls = 0
  state.dispose = async () => {
    if (!state.window.destroyed) { state.window.destroyed = true; state.window.emit('closed') }
    app.emit('before-quit', { preventDefault() {} })
    const deadline = Date.now() + 2000
    while (!state.quitCalls && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
    delete globalThis[key]
    await rm(root, { recursive: true, force: true })
  }
  state.waitFor = async (predicate) => {
    const deadline = Date.now() + 2000
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
    assert.ok(predicate(), 'Host lifecycle did not reach the expected state')
  }
  state.finishClose = () => {
    state.window.destroyed = true
    state.window.emit('closed')
    app.emit('window-all-closed')
  }
  return state
}

test('host forwards a validated GPU working budget and leaves the lower-memory default implicit', async () => {
  for (const value of [undefined, 'auto', '256', '4096']) {
    const state = await host({ gpuWorkingBudget: value })
    try {
      const arguments_ = state.window.options.webPreferences.additionalArguments
      assert.deepEqual(arguments_.filter(value => value.startsWith('--core-gpu-working-budget-mib')), value === undefined || value === 'auto' ? [] : [`--core-gpu-working-budget-mib=${value}`])
      assert.equal(arguments_.includes('--core-cpu-only'), false)
    } finally { await state.dispose() }
  }
})

test('host forwards the automatic ceiling for a Mac with sufficient unified memory', async () => {
  const state = await host({ gpuWorkingBudget: 'auto', gpuStartupMemory: { total: 16 * 1024 ** 3, available: 4 * 1024 ** 3 } })
  try {
    assert.ok(state.window.options.webPreferences.additionalArguments.includes('--core-gpu-working-budget-mib=2048'))
  } finally { await state.dispose() }
})

test('invalid explicit GPU launch configuration rejects instead of creating a silently clamped window', async () => {
  for (const value of ['', '255', '4097', '4096.0', ' auto'])
    await assert.rejects(host({ gpuWorkingBudget: value }), /CORE_GPU_WORKING_BUDGET_MIB.*256.*4096/)
})

test('desktop zoom shortcuts dispatch canvas commands and keep page zoom at one', async () => {
  const state = await host()
  try {
    const commands = []
    for (const [key, command] of [['=', 'zoomIn'], ['+', 'zoomIn'], ['-', 'zoomOut'], ['0', 'zoom100']]) {
      let prevented = false
      state.window.webContents.emit('before-input-event', { preventDefault() { prevented = true } },
        { type: 'keyDown', key, meta: true, control: false, alt: false })
      assert.equal(prevented, true)
      commands.push(['design-desktop:command', command])
    }
    assert.deepEqual(state.sent, commands)
    assert.equal(state.pageZoom, 1)
  } finally { await state.dispose() }
})

test('native modified clipboard shortcuts retain their meaning before menu dispatch',async()=>{
 const state=await host()
 try{
  await state.invoke('renderer-ready')
  state.startupPrompts = state.prompts.splice(0)
  state.startupRequests = state.requests.splice(0)
  state.startupStopCalls = state.stopCalls
  state.stopCalls = 0
  state.sent=[]
  for(const [key,shift,command] of [['c',false,'copy'],['c',true,'copy-as-png'],['r',true,'paste-to-replace']]){
   let prevented=false
   state.window.webContents.emit('before-input-event',{preventDefault(){prevented=true}},{type:'keyDown',key,meta:true,control:false,alt:false,shift})
   assert.equal(prevented,true);assert.deepEqual(state.sent.at(-1),['design-desktop:command',command])
  }
 }finally{await state.dispose()}
})

test('Save As confirms the normalized existing .fd target and Cancel performs no write', async () => {
  const state = await host()
  try {
    state.documents.set('/tmp/project.fd', { old: true })
    state.save.push({ canceled: false, filePath: '/tmp/project' })
    state.messages.push({ response: 0 })
    const result = await state.invoke('save', { documentJson: '{"name":"new"}', saveAs: true })
    assert.equal(result.status, 'cancelled')
    assert.equal(state.requests.filter((request) => request.method === 'save').length, 0)
    assert.match(state.prompts[0].detail, /\/tmp\/project.fd/)
    state.save.push({ canceled: false, filePath: '/tmp/project' })
    state.messages.push({ response: 1 })
    assert.equal(
      (await state.invoke('save', { documentJson: '{"name":"new"}', saveAs: true })).status,
      'ok',
    )
    const saved = state.requests.find((request) => request.method === 'save')
    assert.equal(saved.params.path, '/tmp/project.fd')
    assert.equal(saved.params.expectedHash, 'existing-hash')
  } finally {
    await state.dispose()
  }
})
test('accepted active capability survives many cancelled renderer-open replacements', async () => {
  const state = await host()
  try {
    state.open.push({ canceled: false, filePaths: ['/tmp/active.fd'] })
    const current = await state.invoke('open')
    assert.equal((await state.invoke('document-accept', { handle: current.handle })).status, 'ok')
    for (let n = 0; n < 40; n++) {
      state.open.push({ canceled: false, filePaths: [`/tmp/cancelled-${n}.fd`] })
      assert.equal((await state.invoke('open')).status, 'ok')
    }
    assert.equal(
      (await state.invoke('recovery-write', { handle: current.handle, documentJson: '{}' })).status,
      'ok',
    )
    assert.equal(state.requests.findLast(request => request.method === 'recovery.write').params.sourcePath, '/tmp/active.fd')
    // Imported source grants remain usable, but exporting must choose an independent copy.
    state.save.push({ canceled: false, filePath: '/tmp/active-copy.fd' })
    assert.equal(
      (await state.invoke('save', { handle: current.handle, documentJson: '{"name":"active"}' }))
        .status,
      'ok',
    )
    assert.equal(
      state.requests.find((request) => request.method === 'save').params.path,
      '/tmp/active-copy.fd',
    )
    assert.equal(
      (await state.invoke('recovery-write', { handle: current.handle, documentJson: '{}' })).status,
      'ok',
    )
  } finally {
    await state.dispose()
  }
})
test('recovery adoption works at full quota and retains source unless cleanup names approved token', async () => {
  const state = await host()
  try {
    for (let n = 0; n < 16; n++)
      state.recoveries.set(`snapshot-${n}`, {
        recoveryId: `snapshot-${n}`,
        name: `Design ${n}`,
        updatedAt: n,
        hash: `hash-${n}`,
        document: { name: `Design ${n}` },
      })
    state.messages.push({ response: 0 })
    const restored = await state.invoke('recovery-read')
    assert.equal(restored.status, 'ok')
    assert.equal(restored.handle, undefined)
    assert.equal(
      (await state.invoke('recovery-accept', { recoveryHandle: restored.recoveryHandle })).status,
      'ok',
    )
    assert.equal(state.requests.filter((request) => request.method === 'recovery.write').length, 0)
    // A stale adoption followed by saving the previous canvas must not delete the source.
    assert.equal((await state.invoke('recovery-clear')).status, 'ok')
    assert.equal(state.recoveries.size, 16)
    assert.equal(
      (await state.invoke('recovery-clear', { recoveryHandle: restored.recoveryHandle })).status,
      'ok',
    )
    assert.equal(state.recoveries.has('snapshot-15'), false)
    assert.equal(state.recoveries.size, 15)
  } finally {
    await state.dispose()
  }
})
test('main rejects forged iframe sender and arbitrary path-bearing IPC before sidecar IO', async () => {
  const state = await host()
  try {
    const before = state.requests.length
    await assert.rejects(
      state.invoke('open', undefined, {
        sender: state.window.webContents,
        senderFrame: { url: 'design-app://app/index.html' },
      }),
    )
    assert.equal(
      (await state.invoke('save', { path: '/etc/passwd', documentJson: '{}' })).status,
      'error',
    )
    assert.equal(state.requests.length, before)
  } finally {
    await state.dispose()
  }
})

test('close replies are correlated and stale approvals never close a newer request', async () => {
  const state = await host()
  try {
    state.window.close()
    const first = state.sent.at(-1)[1].requestId
    assert.deepEqual(await state.invoke('close-response', { requestId: 'stale', allow: true }), {
      accepted: false,
    })
    assert.deepEqual(await state.invoke('close-response', { requestId: first, allow: false }), {
      accepted: true,
    })
    state.window.close()
    const second = state.sent.at(-1)[1].requestId
    assert.notEqual(first, second)
    assert.deepEqual(await state.invoke('close-response', { requestId: first, allow: true }), {
      accepted: false,
    })
    assert.deepEqual(await state.invoke('close-response', { requestId: second, allow: false }), {
      accepted: true,
    })
  } finally {
    await state.dispose()
  }
})
test('only own-window known Blob exports reach a native save dialog, with byte bound', async () => {
  const state = await host()
  try {
    const item = new EventEmitter()
    let blocked = 0
    let cancelled = false
    let options
    Object.assign(item, {
      getFilename: () => 'drawing.svg',
      getURL: () => 'blob:design-app://app/1234-abcd',
      getReceivedBytes: () => 65 * 1024 * 1024,
      getTotalBytes: () => 1024,
      getInitiatorOrigin: () => 'design-app://app',
      setSaveDialogOptions(value) {
        options = value
      },
      cancel() {
        cancelled = true
      },
    })
    state.session.emit(
      'will-download',
      {
        preventDefault() {
          blocked++
        },
      },
      item,
      {},
    )
    assert.equal(blocked, 1)
    assert.equal(options, undefined)
    state.session.emit(
      'will-download',
      {
        preventDefault() {
          blocked++
        },
      },
      item,
      state.window.webContents,
    )
    assert.equal(blocked, 1)
    assert.equal(options.defaultPath, 'drawing.svg')
    item.getFilename = () => 'board.svgz'
    state.session.emit(
      'will-download',
      {
        preventDefault() {
          blocked++
        },
      },
      item,
      state.window.webContents,
    )
    assert.equal(blocked, 1)
    assert.equal(options.defaultPath, 'board.svgz')
    item.getFilename = () => 'drawing.svg'
    item.emit('updated')
    assert.equal(cancelled, true)
    item.getURL = () => 'https://evil.example/script.svg'
    state.session.emit(
      'will-download',
      {
        preventDefault() {
          blocked++
        },
      },
      item,
      state.window.webContents,
    )
    assert.equal(blocked, 2)
    item.getURL = () => 'blob:design-app://app/1234-abcd'
    item.getFilename = () => 'script.sh'
    state.session.emit(
      'will-download',
      {
        preventDefault() {
          blocked++
        },
      },
      item,
      state.window.webContents,
    )
    assert.equal(blocked, 3)
    item.getFilename = () => 'document.fd'
    state.session.emit(
      'will-download',
      {
        preventDefault() {
          blocked++
        },
      },
      item,
      state.window.webContents,
    )
    assert.equal(blocked, 4)
    item.getFilename = () => 'drawing.svg'
    item.getInitiatorOrigin = () => 'https://evil.example'
    state.session.emit(
      'will-download',
      {
        preventDefault() {
          blocked++
        },
      },
      item,
      state.window.webContents,
    )
    assert.equal(blocked, 5)
    item.getInitiatorOrigin = () => 'design-app://app'
    item.getTotalBytes = () => 65 * 1024 * 1024
    state.session.emit(
      'will-download',
      {
        preventDefault() {
          blocked++
        },
      },
      item,
      state.window.webContents,
    )
    assert.equal(blocked, 6)
    item.getTotalBytes = () => 0
    state.session.emit(
      'will-download',
      {
        preventDefault() {
          blocked++
        },
      },
      item,
      state.window.webContents,
    )
    assert.equal(blocked, 7)
  } finally {
    await state.dispose()
  }
})

for (const response of [0, 1]) {
  test(`stale native fallback response ${response} cannot settle a newer close request`, async () => {
    const state = await host()
    try {
      let resolve
      state.messages.push(
        new Promise((done) => {
          resolve = done
        }),
      )
      state.window.close()
      const first = state.sent.at(-1)[1].requestId
      state.timers.at(-1)()
      await state.invoke('close-response', { requestId: first, allow: false })
      state.window.close()
      const second = state.sent.at(-1)[1].requestId
      resolve({ response })
      await new Promise((done) => setImmediate(done))
      assert.equal(state.closeCalls, 2)
      assert.deepEqual(await state.invoke('close-response', { requestId: second, allow: false }), {
        accepted: true,
      })
    } finally {
      await state.dispose()
    }
  })
}
for (const response of [0, 1, 2]) {
  test(`mixed corrupt recovery remains visible with valid snapshot choice ${response}`, async () => {
    const state = await host()
    try {
      assert.equal((await state.invoke('set-interface-locale', 'en')).status, 'ok')
      state.recoveryIssues.push({ message: 'Corrupt snapshot' })
      state.recoveries.set('valid', {
        recoveryId: 'valid',
        name: 'Older design',
        updatedAt: 1,
        hash: 'valid-hash',
        document: { name: 'Older design' },
      })
      state.messages.push({ response })
      const result = await state.invoke('recovery-read')
      assert.equal(result.status, response === 0 ? 'ok' : 'cancelled')
      assert.match(state.prompts[0].detail, /1 recovery file.*could not be read/i)
      assert.match(state.prompts[0].detail, /preserved/i)
      assert.equal(
        state.requests.some(({ method }) => method === 'recovery.remove'),
        false,
      )
      assert.equal(state.recoveries.size, 1)
    } finally {
      await state.dispose()
    }
  })
}

test('native fallback only settles its live owning window', async () => {
  const state = await host()
  try {
    let resolve
    state.messages.push(
      new Promise((done) => {
        resolve = done
      }),
    )
    state.window.close()
    state.timers.at(-1)()
    state.window.destroyed = true
    resolve({ response: 1 })
    await new Promise((done) => setImmediate(done))
    assert.equal(state.closeCalls, 1)
  } finally {
    await state.dispose()
  }
})
for (const response of [0, 1]) {
  test(`current native fallback response ${response} is honored`, async () => {
    const state = await host()
    try {
      state.messages.push({ response })
      state.window.close()
      const requestId = state.sent.at(-1)[1].requestId
      state.timers.at(-1)()
      await new Promise((done) => setImmediate(done))
      assert.equal(state.closeCalls, response === 1 ? 2 : 1)
      assert.deepEqual(await state.invoke('close-response', { requestId, allow: true }), {
        accepted: false,
      })
    } finally {
      await state.dispose()
    }
  })
}

test('catalog selection exposes opaque grant and replacement revokes document authority', async () => {
  const state = await host()
  try {
    const directory = path.join(state.root, 'project')
    await mkdir(directory)
    await writeFile(path.join(directory, 'drawing.fd'), '{}')
    state.open.push({ canceled: false, filePaths: [directory] })
    const selected = await state.invoke('catalog-select')
    assert.equal(selected.status, 'ok')
    assert.equal(selected.directory.path, undefined)
    const directoryHandle = selected.directory.directoryHandle
    assert.equal((await state.invoke('catalog-scan', { directoryHandle })).status, 'ok')
    const opened = await state.invoke('catalog-open', { directoryHandle, fileId: 'file-1' })
    assert.equal(opened.status, 'ok')
    assert.equal(state.requests.at(-1).params.directoryId, 'directory-1')
    const before = state.requests.length
    assert.equal((await state.invoke('catalog-open', { directoryHandle, fileId: 'file-1', path: '/etc/passwd' })).status, 'error')
    assert.equal(state.requests.length, before)
    await rename(directory, directory + '-old')
    await mkdir(directory)
    const revoked = await state.invoke('save', { handle: opened.handle, documentJson: '{}' })
    assert.equal(revoked.code, 'DIRECTORY_RESELECT')
    assert.equal(state.requests.length, before)
    assert.equal((await state.invoke('catalog-scan', { directoryHandle })).code, 'DIRECTORY_RESELECT')
    assert.equal((await state.invoke('recovery-write', { handle: opened.handle, documentJson: '{}' })).status, 'ok')
    state.save.push({ canceled: false, filePath: path.join(state.root, 'rescued.fd') })
    assert.equal((await state.invoke('save', { handle: opened.handle, documentJson: '{}', saveAs: true })).status, 'ok')
    const rescued = state.requests.findLast((request) => request.method === 'save')
    assert.equal(rescued.params.directoryId, undefined)
  } finally { await state.dispose() }
})

test('accepted catalog document keeps its root grant through sixteen later folder selections', async () => {
  const state = await host()
  try {
    const activePath = path.join(state.root, 'active-project')
    await mkdir(activePath)
    await writeFile(path.join(activePath, 'drawing.fd'), '{}')
    state.open.push({ canceled: false, filePaths: [activePath] })
    const selected = await state.invoke('catalog-select')
    const directoryHandle = selected.directory.directoryHandle
    await state.invoke('catalog-scan', { directoryHandle })
    const opened = await state.invoke('catalog-open', { directoryHandle, fileId: 'file-1' })
    assert.equal((await state.invoke('document-accept', { handle: opened.handle })).status, 'ok')
    for (let index = 0; index < 16; index++) {
      const next = path.join(state.root, `next-project-${index}`)
      await mkdir(next)
      state.open.push({ canceled: false, filePaths: [next] })
      assert.equal((await state.invoke('catalog-select')).status, 'ok')
    }
    assert.equal((await state.invoke('recovery-write', { handle: opened.handle, documentJson: '{}' })).status, 'ok')
    assert.equal(state.requests.findLast(request => request.method === 'recovery.write').params.sourcePath, path.join(activePath, 'drawing.fd'))
    state.save.push({ canceled: false, filePath: path.join(activePath, 'drawing-copy.fd') })
    const saved = await state.invoke('save', { handle: opened.handle, documentJson: '{}' })
    assert.equal(saved.status, 'ok')
    assert.equal(state.requests.at(-1).params.path, path.join(activePath, 'drawing-copy.fd'))
    assert.equal(state.requests.at(-1).params.directoryId, undefined)
    assert.ok(state.requests.filter(request => request.method === 'save').every(request => request.params.path !== path.join(activePath, 'drawing.fd')))
  } finally { await state.dispose() }
})


test('native clipboard keeps selected graph and readable text in one write', async () => {
  const state = await host()
  try {
    const graph = JSON.stringify({format:'forma-nodes',version:1,document:{name:'fixture'}})
    assert.deepEqual(await state.invoke('clipboard-write', {forma:graph,text:'Shape & text'}), {status:'ok'})
    assert.equal(state.clipboardText, 'Shape & text')
    assert.ok(state.clipboardItems[0].types.includes('web application/x-forma-nodes-v1'))
    assert.equal(await(await state.clipboardItems[0].getType('web application/x-forma-nodes-v1')).text(),graph)
    const read = await state.invoke('clipboard-read')
    assert.equal(read.forma,graph);assert.equal(read.text,'Shape & text')
    assert.equal((await state.invoke('clipboard-write',{text:'x',path:'/private'})).status,'error')
  } finally { await state.dispose() }
})

test('workspace bridge rejects paths, invalid revisions and untrusted senders before IPC', async () => {
  const state = await host()
  try {
    for (const [method, request] of [
      ['workspace-open',{id:'doc',path:'/private'}],
      ['workspace-commit',{documentJson:'{}',expectedRevision:0,mutationId:'m'}],
      ['workspace-commit',{documentJson:'{}',expectedRevision:null,mutationId:''}],
      ['workspace-trash',{id:'doc',expectedRevision:1.5,mutationId:'m'}],
      ['workspace-restore',{id:'doc',revision:-1,expectedRevision:1,mutationId:'m'}],
      ['workspace-list',{includeDeleted:'all'}],
      ['fonts-read',{id:'font',path:'/private'}],
    ]) {
      const before=state.requests.length
      assert.equal((await state.invoke(method,request)).status,'error')
      assert.equal(state.requests.length,before)
    }
    await assert.rejects(state.invoke('workspace-list', undefined, {sender:state.window.webContents,senderFrame:{url:'design-app://app/index.html'}}),/Untrusted/)
    assert.equal((await state.invoke('text-command','exec')).status,'error')
    assert.equal((await state.invoke('text-command','copy')).status,'ok')
    assert.equal(state.textCommand,'copy')
  } finally { await state.dispose() }
})

test('Finder files arriving before ready are bounded opaque reads and are consumed only after acceptance', async () => {
  const state = await host({ startupFiles: ['https://evil.example/design.fd', 'relative.fd', '/tmp/first.fd', '/tmp/first.fd', '/tmp/second.fd'] })
  try {
    assert.equal(state.requests.some(request => request.method === 'open'), false)
    assert.equal((await state.invoke('open-pending', { path: '/tmp/other.fd' })).status, 'error')
    const first = await state.invoke('open-pending')
    assert.equal(first.displayName, 'first.fd'); assert.equal(first.pendingCount, 1)
    assert.equal(first.path, undefined)
    const again = await state.invoke('open-pending')
    assert.equal(again.displayName, 'first.fd', 'Cancelled renderer replacement keeps the same Finder item')
    assert.equal(state.recent.length, 0)
    await state.invoke('document-accept', { handle: first.handle })
    assert.deepEqual(state.recent, ['/tmp/first.fd'])
    const second = await state.invoke('open-pending')
    assert.equal(second.displayName, 'second.fd'); assert.equal(second.pendingCount, 0)
    await state.invoke('document-accept', { handle: second.handle })
    assert.deepEqual(await state.invoke('open-pending'), { status: 'cancelled' })
  } finally { await state.dispose() }
})

test('Finder queue retains only sixteen unique native files and reports overflow', async () => {
  const state = await host({ startupFiles: Array.from({ length: 17 }, (_, index) => `/tmp/finder-${index}.fd`) })
  try {
    await state.waitFor(() => state.prompts.length > 0)
    assert.match(state.prompts[0].message, /16/)
    for (let index = 0; index < 16; index++) {
      const result = await state.invoke('open-pending')
      assert.equal(result.displayName, `finder-${index}.fd`)
      await state.invoke('document-accept', { handle: result.handle })
    }
    assert.equal((await state.invoke('open-pending')).status, 'cancelled')
  } finally { await state.dispose() }
})

test('macOS close keeps backend alive and Dock activation restores geometry with one protocol/download registration', async () => {
  const state = await host()
  try {
    const old = state.window
    old.bounds = { x: 77, y: 100, width: 1300, height: 850 }
    old.close()
    await state.invoke('close-response', { requestId: state.sent.at(-1)[1].requestId, allow: true })
    state.finishClose()
    assert.equal(state.stopCalls, 0); assert.equal(state.quitCalls, 0)
    state.electron.app.emit('activate')
    state.electron.app.emit('activate')
    await state.waitFor(() => state.windows.length === 2)
    assert.deepEqual(state.window.bounds, old.bounds)
    assert.equal(state.protocolRegistrations, 1)
    assert.equal(state.session.listenerCount('will-download'), 1)
    assert.equal(state.window.options.webPreferences.sandbox, true)
    await assert.rejects(state.invoke('open-pending', undefined, { sender: old.webContents, senderFrame: old.webContents.mainFrame }), /Untrusted/)
  } finally { await state.dispose() }
})

test('CmdQ honors cancelled close and only stops backend after an approved later quit', async () => {
  const state = await host()
  try {
    let prevented = 0
    state.electron.app.emit('before-quit', { preventDefault() { prevented++ } })
    await state.invoke('close-response', { requestId: state.sent.at(-1)[1].requestId, allow: false })
    assert.equal(prevented, 1); assert.equal(state.stopCalls, 0)
    state.window.close()
    await state.invoke('close-response', { requestId: state.sent.at(-1)[1].requestId, allow: true })
    state.finishClose()
    assert.equal(state.stopCalls, 0, 'Cancelling CmdQ also cancels its application-wide quit intent')
    state.electron.app.emit('activate')
    await state.waitFor(() => state.windows.length === 2)
    state.electron.app.emit('before-quit', { preventDefault() { prevented++ } })
    await state.invoke('close-response', { requestId: state.sent.at(-1)[1].requestId, allow: true })
    state.finishClose()
    await state.waitFor(() => state.quitCalls === 1)
    assert.equal(state.stopCalls, 1)
  } finally { await state.dispose() }
})

test('non-macOS last-window close still shuts down the owned backend', async () => {
  const state = await host({ platform: 'linux' })
  try {
    state.window.close()
    await state.invoke('close-response', { requestId: state.sent.at(-1)[1].requestId, allow: true })
    state.finishClose()
    await state.waitFor(() => state.quitCalls === 1)
    assert.equal(state.stopCalls, 1)
  } finally { await state.dispose() }
})

test('native file received with no window survives reopening and invalid file never reaches backend', async () => {
  const state = await host()
  try {
    state.window.close()
    await state.invoke('close-response', { requestId: state.sent.at(-1)[1].requestId, allow: true })
    state.finishClose()
    state.electron.app.emit('open-file', { preventDefault() {} }, '/tmp/readme.txt')
    state.electron.app.emit('open-file', { preventDefault() {} }, '/tmp/finder-reopen.fd')
    await state.waitFor(() => state.windows.length === 2)
    const result = await state.invoke('open-pending')
    assert.equal(result.displayName, 'finder-reopen.fd')
    assert.equal(state.requests.filter(request => request.method === 'open').length, 1)
  } finally { await state.dispose() }
})

test('display removal constrains a normal window to the remaining visible work area', async () => {
  const state = await host({ savedWindow: { version: 1, bounds: { x: 4000, y: -2000, width: 3000, height: 1900 }, maximized: false, fullscreen: false } })
  try {
    assert.deepEqual(state.window.bounds, state.displays[0].workArea)
    state.window.bounds = { x: -1500, y: 30, width: 1300, height: 800 }
    state.screen.emit('display-removed')
    assert.deepEqual(state.window.bounds, { x: 0, y: 30, width: 1300, height: 800 })
  } finally { await state.dispose() }
})

test('font listing is shared across repeated requests and invalidated by a changed source read', async () => {
  const state = await host()
  try {
    const first = await state.invoke('fonts-list')
    assert.deepEqual(await state.invoke('fonts-list'), first)
    assert.equal(state.requests.filter(request => request.method === 'fonts.list').length, 1)
    state.fontChanged = true
    assert.equal((await state.invoke('fonts-read', { id: 'font-1' })).code, 'FONT_CHANGED')
    await state.invoke('fonts-list')
    assert.equal(state.requests.filter(request => request.method === 'fonts.list').length, 2)
  } finally { await state.dispose() }
})

test('native commands after last-window close wait for the new renderer handshake', async () => {
  const state = await host()
  try {
      assert.equal((await state.invoke('set-interface-locale', 'en')).status, 'ok')
    state.window.close()
    await state.invoke('close-response', { requestId: state.sent.at(-1)[1].requestId, allow: true })
    state.finishClose()
    const file = state.menu.find(item => item.label === 'File')
    state.sent.length = 0
    file.submenu.find(item => item.label === 'New').click()
    await state.waitFor(() => state.windows.length === 2)
    assert.equal(state.sent.length, 0)
    await state.invoke('renderer-ready')
  state.startupPrompts = state.prompts.splice(0)
  state.startupRequests = state.requests.splice(0)
  state.startupStopCalls = state.stopCalls
  state.stopCalls = 0
    assert.deepEqual(state.sent, [['design-desktop:command', 'new']])
    await state.invoke('renderer-ready')
  state.startupPrompts = state.prompts.splice(0)
  state.startupRequests = state.requests.splice(0)
  state.startupStopCalls = state.stopCalls
  state.stopCalls = 0
    assert.equal(state.sent.length, 1, 'Repeated ready notifications do not replay native commands')
  } finally { await state.dispose() }
})

test('native Open while no window uses its own file dialog and the same acceptance queue', async () => {
  const state = await host()
  try {
      assert.equal((await state.invoke('set-interface-locale', 'en')).status, 'ok')
    state.window.close()
    await state.invoke('close-response', { requestId: state.sent.at(-1)[1].requestId, allow: true })
    state.finishClose()
    state.open.push({ canceled: false, filePaths: ['/tmp/menu-reopen.fd'] })
    state.menu.find(item => item.label === 'File').submenu.find(item => item.label === 'Open…').click()
    await state.waitFor(() => state.windows.length === 2)
    assert.equal((await state.invoke('open-pending')).displayName, 'menu-reopen.fd')
  } finally { await state.dispose() }
})

test('invalid Finder input reports failure without blocking the next item, while backend failure preserves retry', async () => {
  const state = await host({ startupFiles: ['/tmp/invalid.fd', '/tmp/valid.fd'] })
  try {
    state.openFailure = 'BACKEND_UNAVAILABLE'
    assert.equal((await state.invoke('open-pending')).status, 'error')
    state.openFailure = undefined
    assert.equal((await state.invoke('open-pending')).displayName, 'invalid.fd')
    state.openFailure = 'INVALID_DOCUMENT'
    assert.equal((await state.invoke('open-pending')).status, 'error')
    state.openFailure = undefined
    assert.equal((await state.invoke('open-pending')).displayName, 'valid.fd')
  } finally { await state.dispose() }
})


test('native PNG clipboard validates dimensions and bit depth before replacing clipboard contents', async () => {
  const state=await host()
  try {
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64')
    const data=bytes=>'data:image/png;base64,'+bytes.toString('base64')
    assert.equal((await state.invoke('clipboard-write',{image:data(png)})).status,'ok')
    assert.deepEqual(state.clipboardDecoded,png)
    assert.equal((await state.invoke('clipboard-read')).image,data(png))
    const saved=state.clipboardImage
    const huge=Buffer.from(png);huge.writeUInt32BE(16385,16)
    assert.equal((await state.invoke('clipboard-write',{image:data(huge)})).status,'error')
    const hdr=Buffer.from(png);hdr[24]=16
    assert.equal((await state.invoke('clipboard-write',{image:data(hdr)})).status,'error')
    assert.equal((await state.invoke('clipboard-write',{image:'data:image/jpeg;base64,AAAA'})).status,'error')
    assert.equal(state.clipboardImage,saved)
  } finally {await state.dispose()}
})

test('Sketch inspection uses only native selection and cannot replace the Forma canvas or leak paths', async () => {
  const state = await host()
  try {
    const rejected = await state.invoke('sketch-inspect', { path: '/untrusted/secret.sketch' })
    assert.equal(rejected.status, 'error')
    assert.equal(state.requests.filter(r => r.method === 'sketch.inspect').length, 0)
    state.open.push({ canceled: false, filePaths: [path.join(state.root, 'native.sketch')] })
    const result = await state.invoke('sketch-inspect')
    assert.equal(result.status, 'ok')
    assert.equal(result.owner.kernel_id, 'sketch')
    assert.equal(result.displayName, 'native.sketch')
    assert.equal(result.editable, false); assert.equal(result.renderable, false)
    assert.equal(result.path, undefined); assert.equal(result.documentJson, undefined); assert.equal(result.handle, undefined)
    assert.equal(state.documents.size, 0)
    const before = state.requests.length
    state.open.push({ canceled: true, filePaths: [] })
    assert.equal((await state.invoke('sketch-inspect')).status, 'cancelled')
    assert.equal(state.requests.length, before)
    state.sketchResult = p => ({ owner: { kernel_id: 'sketch', document_schema: 'future', document_id: p.documentId, session_epoch: p.sessionEpoch }, pageCount: 1, layerCount: 1, editable: false, renderable: false })
    state.open.push({ canceled: false, filePaths: [path.join(state.root, 'native.sketch')] })
    assert.equal((await state.invoke('sketch-inspect')).status, 'error')
  } finally { await state.dispose() }
})


for (const platform of ['darwin', 'win32', 'linux']) {
  test(`${platform}: registered input handler protects IME and consumes repeat before native menu dispatch`, async () => {
    const state = await host({ platform })
    try {
      await state.invoke('renderer-ready')
  state.startupPrompts = state.prompts.splice(0)
  state.startupRequests = state.requests.splice(0)
  state.startupStopCalls = state.stopCalls
  state.stopCalls = 0; state.sent = []
      const mod = platform === 'darwin' ? { meta: true, control: false } : { meta: false, control: true }
      let prevented = 0
      const emit = extra => state.window.webContents.emit('before-input-event', { preventDefault() { prevented++ } }, { type: 'keyDown', key: 'd', alt: false, shift: false, ...mod, ...extra })
      emit({}); emit({ isAutoRepeat: true }); emit({ isComposing: true })
      assert.deepEqual(state.sent, [['design-desktop:command', 'duplicate']]); assert.equal(prevented, 2); assert.equal(state.ignoreMenuShortcuts, true)
      emit({ control: true, meta: true }); assert.equal(state.sent.length, 1)
      emit({ key: 'z' }); assert.deepEqual(state.sent.at(-1), ['design-desktop:command', 'undo']); assert.equal(state.ignoreMenuShortcuts, false)
    } finally { await state.dispose() }
  })
}

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`${platform}: native paste-over-selection menu is distinct from paste-in-place and replacement`, async () => {
    const state = await host({ platform })
    try {
      assert.equal((await state.invoke('set-interface-locale', 'en')).status, 'ok')
      const edit = state.menu.find(item => item.label === 'Edit').submenu
      const over = edit.find(item => item.label === 'Paste Over Selection')
      const inPlace = edit.find(item => item.label === 'Paste in Place')
      const replace = edit.find(item => item.label === 'Paste to Replace')
      const paste = edit.find(item => item.label === 'Paste')
      assert.ok(over, 'Paste Over Selection must be available in the native Edit menu')
      assert.equal(over.accelerator, 'CmdOrCtrl+Shift+V')
      assert.equal(inPlace.accelerator, undefined, 'Paste in Place must not compete for Shift+Mod+V')
      assert.equal(replace.accelerator, 'CmdOrCtrl+Shift+R')
      assert.equal(paste.accelerator, 'CmdOrCtrl+V')
      const menuItems = items => items.flatMap(item => [item, ...menuItems(item.submenu || [])])
      assert.deepEqual(menuItems(state.menu).filter(item => item.accelerator === 'CmdOrCtrl+Shift+V'), [over])
      state.sent = []
      for (const item of [over, inPlace, replace, paste]) item.click()
      const center = state.menu.find(item => item.label === 'View').submenu.find(item => item.label === 'Center Selection')
      assert.equal(center.accelerator, undefined, 'Renderer retains profile-specific center-selection keys')
      center.click()
      assert.deepEqual(state.sent, ['paste-over-selection', 'paste-in-place', 'paste-to-replace', 'paste', 'center-selection'].map(command => ['design-desktop:command', command]))
      assert.equal(state.handlers.has('design-desktop:command'), false, 'No arbitrary renderer command IPC is exposed')
      assert.equal(state.pageZoom, 1)
    } finally { await state.dispose() }
  })
  test(`${platform}: registered paste-over-selection shortcut forwards once and preserves IME and repeat suppression`, async () => {
    const state = await host({ platform })
    try {
      state.sent = []
      const mod = platform === 'darwin' ? { meta: true, control: false } : { meta: false, control: true }
      let prevented = 0
      const emit = extra => state.window.webContents.emit('before-input-event', { preventDefault() { prevented++ } }, {
        type: 'keyDown', key: 'v', code: 'KeyV', alt: false, shift: true, ...mod, ...extra,
      })
      emit({})
      assert.deepEqual(state.sent, [['design-desktop:command', 'paste-over-selection']])
      assert.equal(prevented, 1)
      emit({ isAutoRepeat: true })
      assert.equal(state.ignoreMenuShortcuts, true)
      assert.equal(prevented, 2)
      for (const extra of [{ isComposing: true }, { keyCode: 229 }, { key: 'Dead' }, { key: 'Process' }]) {
        emit(extra)
        assert.equal(state.ignoreMenuShortcuts, true)
      }
      for (const extra of [{ type: 'keyUp' }, { control: true, meta: true }, { alt: true }]) emit(extra)
      assert.equal(state.sent.length, 1)
      assert.equal(prevented, 2)
      emit({})
      assert.deepEqual(state.sent, [
        ['design-desktop:command', 'paste-over-selection'],
        ['design-desktop:command', 'paste-over-selection'],
      ])
      assert.equal(state.ignoreMenuShortcuts, false)
      assert.equal(prevented, 3)
    } finally { await state.dispose() }
  })
}

async function stageWorkspace(state, name = 'selected-workspace') {
  const selected = path.join(state.root, name)
  await mkdir(selected)
  state.open.push({ canceled: false, filePaths: [selected] })
  const result = await state.invoke('workspace-root-select')
  assert.equal(result.status, 'ok')
  return { selected, result }
}
async function savedWorkspace(state) {
  return JSON.parse(await readFile(path.join(state.root, 'workspace-selection-v1.json'), 'utf8'))
}

test('workspace startup explicitly chooses original default, probes both SQLite stores, and preserves default backend paths', async () => {
  const state = await host()
  try {
    assert.equal(state.startupPrompts[0].title, '选择本地工作区')
    assert.ok(state.startupRequests.some(r => r.method === 'workspace.list'))
    assert.ok(state.startupRequests.some(r => r.method === 'catalog.list'))
    assert.equal(state.startupStopCalls, 1)
    assert.equal(state.backends.at(-1).workspaceDb, path.join(state.root, 'workspace-v1.sqlite3'))
    assert.equal(state.backends.at(-1).catalogDb, path.join(state.root, 'catalog-v1.sqlite3'))
    assert.equal((await state.invoke('workspace-root-status')).isDefault, true)
  } finally { await state.dispose() }
})

test('native workspace stage and cancelled close never change the active or saved root', async () => {
  const state = await host()
  try {
    const { selected, result } = await stageWorkspace(state)
    assert.equal(state.backends.at(-1).workspaceDb, path.join(selected, '.futureox-workspace', 'workspace-v1.sqlite3'))
    assert.equal((await savedWorkspace(state)).kind, 'default')
    assert.equal((await state.invoke('workspace-root-activate', { selectionId: result.selectionId })).restarting, true)
    const requestId = state.sent.at(-1)[1].requestId
    assert.equal((await savedWorkspace(state)).kind, 'default')
    assert.deepEqual(await state.invoke('close-response', { requestId, allow: false }), { accepted: true })
    assert.equal(state.relaunchCalls, 0)
    assert.equal((await savedWorkspace(state)).kind, 'default')
    assert.equal((await state.invoke('workspace-root-status')).isDefault, true)
    assert.equal((await state.invoke('workspace-root-activate', { selectionId: result.selectionId })).status, 'error')
  } finally { await state.dispose() }
})

test('approved workspace switch saves pointer only after close handshake and relaunches after backend drains', async () => {
  const state = await host()
  try {
    const { selected, result } = await stageWorkspace(state)
    await state.invoke('workspace-root-activate', { selectionId: result.selectionId })
    assert.equal(state.relaunchCalls, 0)
    const requestId = state.sent.at(-1)[1].requestId
    assert.equal((await state.invoke('live-new-window', { id: '10000000-0000-0000-0000-000000000001' })).code, 'BUSY')
    assert.equal(state.children.length, 0)
    const [first, duplicate] = await Promise.all([
      state.invoke('close-response', { requestId, allow: true }),
      state.invoke('close-response', { requestId, allow: true }),
    ])
    assert.equal(first.accepted, true); assert.equal(duplicate.accepted, false)
    assert.equal(state.relaunchCalls, 1)
    assert.equal((await savedWorkspace(state)).rootPath, selected)
    // No backend replacement occurs in this process, even after native approval.
    assert.equal((await state.invoke('workspace-root-status')).isDefault, true)
    state.finishClose(); await state.waitFor(() => state.quitCalls === 1)
    assert.ok(state.stopCalls >= 3, 'Both probes and the original backend must stop')
  } finally { await state.dispose() }
})

test('workspace native relaunch failure rolls preference back and rejects close so renderer can resume', async () => {
  const state = await host()
  try {
    const { result } = await stageWorkspace(state)
    state.relaunchFailure = true
    await state.invoke('workspace-root-activate', { selectionId: result.selectionId })
    const requestId = state.sent.at(-1)[1].requestId
    assert.deepEqual(await state.invoke('close-response', { requestId, allow: true }), { accepted: false })
    assert.equal((await savedWorkspace(state)).kind, 'default')
    assert.equal(state.quitCalls, 0)
    assert.equal(state.closeCalls, 1, 'A failed restart must not permit the final native close')
    assert.equal(state.prompts.at(-1).title, '工作区未切换')
    assert.equal((await state.invoke('workspace-list')).status, 'ok')
  } finally { await state.dispose() }
})

test('root replacement while dirty-close decision is pending fails closed without changing preference', async () => {
  const state = await host()
  try {
    const { selected, result } = await stageWorkspace(state)
    await state.invoke('workspace-root-activate', { selectionId: result.selectionId })
    await rename(selected, `${selected}-moved`); await mkdir(selected)
    assert.deepEqual(await state.invoke('close-response', { requestId: state.sent.at(-1)[1].requestId, allow: true }), { accepted: false })
    assert.equal((await savedWorkspace(state)).kind, 'default')
    assert.equal(state.relaunchCalls, 0)
  } finally { await state.dispose() }
})

test('workspace selection refuses renderer paths and untrusted frames, cancellation is non-mutating', async () => {
  const state = await host()
  try {
    const before = state.backends.length
    assert.equal((await state.invoke('workspace-root-select', { path: state.root })).status, 'error')
    assert.equal((await state.invoke('workspace-root-default', { path: state.root })).status, 'error')
    assert.equal((await state.invoke('workspace-root-activate', { selectionId: 'forged', path: state.root })).status, 'error')
    await assert.rejects(state.invoke('workspace-root-status', undefined, { sender: state.window.webContents, senderFrame: { url: 'https://evil.example/' } }), /Untrusted/)
    assert.deepEqual(await state.invoke('workspace-root-select'), { status: 'cancelled' })
    assert.equal(state.backends.length, before)
    assert.equal((await savedWorkspace(state)).kind, 'default')
  } finally { await state.dispose() }
})

test('original default can be explicitly selected without restart and new peer window blocks staged switch', async () => {
  const state = await host()
  try {
    const original = await state.invoke('workspace-root-default')
    assert.equal(original.isDefault, true)
    assert.deepEqual(await state.invoke('workspace-root-activate', { selectionId: original.selectionId }), { status: 'ok', restarting: false })
    assert.equal(state.closeCalls, 0)
    const { result } = await stageWorkspace(state)
    assert.equal((await state.invoke('live-new-window', { id: '10000000-0000-0000-0000-000000000001' })).status, 'ok')
    assert.equal((await state.invoke('workspace-root-status')).canSwitch, false)
    assert.equal((await state.invoke('workspace-root-select')).code, 'WORKSPACE_ROOT_PEERS')
    assert.equal((await state.invoke('workspace-root-activate', { selectionId: result.selectionId })).code, 'WORKSPACE_ROOT_PEERS')
    assert.equal(state.closeCalls, 0)
    state.children[0].emit('exit')
    assert.equal((await state.invoke('workspace-root-status')).canSwitch, true)
  } finally { await state.dispose() }
})

test('target SQLite failure rejects stage and late target probe failure cancels approved close', async () => {
  const state = await host()
  try {
    const selected = path.join(state.root, 'broken-workspace'); await mkdir(selected)
    state.workspaceFailure = 'WORKSPACE_FUTURE_SCHEMA'
    state.open.push({ canceled: false, filePaths: [selected] })
    assert.equal((await state.invoke('workspace-root-select')).code, 'WORKSPACE_FUTURE_SCHEMA')
    assert.equal((await savedWorkspace(state)).kind, 'default')
    state.workspaceFailure = undefined
    const { result } = await stageWorkspace(state, 'valid-before-close')
    await state.invoke('workspace-root-activate', { selectionId: result.selectionId })
    state.workspaceFailure = 'WORKSPACE_INVALID'
    assert.deepEqual(await state.invoke('close-response', { requestId: state.sent.at(-1)[1].requestId, allow: true }), { accepted: false })
    assert.equal((await savedWorkspace(state)).kind, 'default')
    assert.equal(state.relaunchCalls, 0)
  } finally { await state.dispose() }
})


test('actual main binds MCP workspace callbacks to the same native root and close-transition guards as UI', async () => {
  const state = await host()
  try {
    const workspace = state.automationOptions.workspace
    assert.equal(typeof workspace.verifyRoot, 'function')
    assert.equal(workspace.getRoot().storagePath, state.root)
    assert.deepEqual(workspace.status(), await state.invoke('workspace-root-status'))
    await workspace.verifyRoot(workspace.getRoot())
    const selected = path.join(state.root, 'mcp-native-selection'); await mkdir(selected)
    state.open.push({ canceled: false, filePaths: [selected] })
    const staged = await workspace.select(false)
    assert.equal(staged.status, 'ok'); assert.equal((await savedWorkspace(state)).kind, 'default')
    assert.equal((await workspace.activate(staged.selectionId)).restarting, true)
    const requestId = state.sent.at(-1)[1].requestId
    state.open.push({ canceled: true, filePaths: [] })
    assert.throws(() => workspace.select(false), { code: 'BUSY' })
    assert.equal((await state.invoke('workspace-root-select')).code, 'BUSY')
    assert.equal(state.open.length, 1, 'Neither callback consumes the picker while closing')
    await state.invoke('close-response', { requestId, allow: false })
    assert.equal((await workspace.select(false)).status, 'cancelled')
    assert.equal((await savedWorkspace(state)).kind, 'default'); assert.equal(state.relaunchCalls, 0)
  } finally { await state.dispose() }
})

test('diagnostics fixed-path IPC persists sanitized local records and rejects untrusted senders', async () => {
 const h = await host()
 try {
  const data = JSON.stringify({schema:1,dropped:0,records:[{time:Date.now(),component:'workspace',code:'STORAGE_ERROR',severity:'error',message:'private document',requestId:'token'}]})
  const write = await h.invoke('diagnostics-write', data)
  assert.equal(write.ok,true)
  const read = await h.invoke('diagnostics-read')
  assert.equal(read.ok,true);assert.equal(JSON.parse(read.data).records.length,1)
  assert.ok(!read.data.includes('private'));assert.ok(!read.data.includes('token'))
  assert.equal((await h.invoke('diagnostics-write', 'broken')).status,'error')
  await assert.rejects(h.invoke('diagnostics-read', undefined, {sender:h.window.webContents,senderFrame:{url:'design-app://app/index.html'}}))
 } finally { await h.dispose() }
})

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`${platform}: New Page menu has no profile-blind accelerator and Shift+Mod+N reaches renderer`, async () => {
    const state = await host({ platform })
    try {
      for (const locale of ['zh-CN', 'en']) {
        assert.equal((await state.invoke('set-interface-locale', locale)).status, 'ok')
        const chinese = locale === 'zh-CN'
        const file = state.menu.find(item => item.label === (chinese ? '文件' : 'File')).submenu
        const page = file.find(item => item.label === (chinese ? '新建页面' : 'New Page'))
        assert.ok(page)
        assert.equal(page.accelerator, undefined)
        assert.equal(file.find(item => item.label === (chinese ? '新建' : 'New')).accelerator, 'CmdOrCtrl+N')
        state.sent = []; page.click()
        assert.deepEqual(state.sent, [['design-desktop:command', 'new-page']])
        state.sent = []; let prevented = false
        const mod = platform === 'darwin' ? { meta: true, control: false } : { meta: false, control: true }
        state.window.webContents.emit('before-input-event', { preventDefault() { prevented = true } }, {
          type: 'keyDown', key: 'N', code: 'KeyN', alt: false, shift: true, ...mod,
        })
        assert.deepEqual(state.sent, []); assert.equal(prevented, false)
      }
    } finally { await state.dispose() }
  })
  test(`${platform}: actual main locale switching retains menu commands, shortcuts and document authority`, async () => {
    const state = await host({ platform })
    try {
      assert.ok(state.menu.find(item => item.label === '文件'), 'Default locale matches renderer Chinese default')
      const beforeRequests = state.requests.length
      const beforePrompts = state.prompts.length
      for (const locale of ['en', 'zh-CN', 'en']) {
        assert.deepEqual(await state.invoke('set-interface-locale', locale), { status: 'ok' })
        const chinese = locale === 'zh-CN'
        const file = state.menu.find(item => item.label === (chinese ? '文件' : 'File'))
        const edit = state.menu.find(item => item.label === (chinese ? '编辑' : 'Edit'))
        const save = file.submenu.find(item => item.label === (chinese ? '导出副本…' : 'Export copy…'))
        const paste = edit.submenu.find(item => item.label === (chinese ? '粘贴到所选图层上方' : 'Paste Over Selection'))
        const settings = edit.submenu.find(item => item.label === (chinese ? '设置…' : 'Settings…'))
        assert.equal(file.submenu.find(item => item.label === (chinese ? '编辑会自动保存' : 'Edits are saved automatically')).enabled, false)
        assert.equal(save.accelerator, 'CmdOrCtrl+Shift+S')
        assert.equal(paste.accelerator, 'CmdOrCtrl+Shift+V')
        assert.equal(settings.accelerator, 'CmdOrCtrl+,')
        assert.equal(file.submenu.find(item => item.role === 'close').role, 'close')
        state.sent = []; save.click(); paste.click(); settings.click()
        assert.deepEqual(state.sent, ['saveAs', 'paste-over-selection', 'settings'].map(command => ['design-desktop:command', command]))
        assert.equal(state.pageZoom, 1)
      }
      assert.equal(state.requests.length, beforeRequests, 'Locale and menu dispatch do not create sidecar document mutations')
      assert.equal(state.prompts.length, beforePrompts)
    } finally { await state.dispose() }
  })
}

test('actual main rejects unsupported locale and forged sender without changing menus or issuing IO', async () => {
  const state = await host()
  try {
    const before = state.requests.length, menu = state.menu
    for (const value of ['de', '', 'en-US', null, undefined, { locale: 'en' }, ['en']]) {
      assert.equal((await state.invoke('set-interface-locale', value)).status, 'error')
      assert.equal(state.menu, menu)
    }
    for (const event of [
      { sender: state.window.webContents, senderFrame: { url: 'design-app://app/index.html' } },
      { sender: {}, senderFrame: state.window.webContents.mainFrame },
    ]) {
      await assert.rejects(state.invoke('set-interface-locale', 'en', event), /Untrusted desktop IPC sender/)
      assert.equal(state.menu, menu)
    }
    assert.equal(state.requests.length, before)
    assert.equal((await state.invoke('set-interface-locale', 'en')).status, 'ok')
    assert.ok(state.menu.find(item => item.label === 'File'))
  } finally { await state.dispose() }
})

test('native filter display names follow locale while extensions, defaults and cancellation authority remain unchanged', async () => {
  const state = await host()
  try {
    const openOptions = [], saveOptions = []
    state.electron.dialog.showOpenDialog = async (...args) => { openOptions.push(args.at(-1)); return { canceled: true, filePaths: [] } }
    state.electron.dialog.showSaveDialog = async (...args) => { saveOptions.push(args.at(-1)); return { canceled: true } }
    const before = state.requests.length
    for (const locale of ['en', 'zh-CN', 'en']) {
      await state.invoke('set-interface-locale', locale)
      const chinese = locale === 'zh-CN'
      assert.equal((await state.invoke('open')).status, 'cancelled')
      assert.deepEqual(openOptions.at(-1).filters, [{ name: chinese ? 'futureox-desgin 设计文件' : 'futureox-desgin design', extensions: ['fd'] }])
      assert.deepEqual(openOptions.at(-1).properties, ['openFile'])
      assert.equal((await state.invoke('sketch-inspect')).status, 'cancelled')
      assert.deepEqual(openOptions.at(-1).filters, [{ name: chinese ? 'Sketch 原生文档' : 'Sketch native document', extensions: ['sketch'] }])
      assert.equal((await state.invoke('save', { documentJson: '{"name":"用户名称"}', saveAs: true })).status, 'cancelled')
      assert.deepEqual(saveOptions.at(-1).filters, [{ name: chinese ? 'futureox-desgin 设计文件' : 'futureox-desgin design', extensions: ['fd'] }])
      assert.equal(saveOptions.at(-1).defaultPath, 'Untitled.fd')
      assert.deepEqual(saveOptions.at(-1).properties, ['showOverwriteConfirmation', 'createDirectory'])
      let options, blocked = 0
      const item = Object.assign(new EventEmitter(), {
        getFilename: () => '用户名称.svg', getURL: () => 'blob:design-app://app/1234-abcd',
        getReceivedBytes: () => 1024, getTotalBytes: () => 1024, getInitiatorOrigin: () => 'design-app://app',
        setSaveDialogOptions: value => { options = value }, cancel() {},
      })
      state.session.emit('will-download', { preventDefault() { blocked++ } }, item, state.window.webContents)
      assert.equal(blocked, 0)
      assert.deepEqual(options.filters, [{ name: chinese ? '设计导出文件' : 'Design export', extensions: ['svg'] }])
      assert.equal(options.defaultPath, '用户名称.svg')
      assert.deepEqual(options.properties, ['showOverwriteConfirmation'])
    }
    assert.equal(state.requests.length, before, 'Cancelled native dialogs and export configuration perform no sidecar IO')
  } finally { await state.dispose() }
})

test('startup enables declared plugins in the menu without exposing filesystem paths', async () => {
  const state = await host({
    prepare: async root => {
      const plugins = path.join(root, 'plugins')
      const declared = path.join(plugins, 'save-plugin')
      const figjam = path.join(plugins, 'figjam-only')
      const outside = path.join(root, 'outside-plugin')
      await mkdir(declared, { recursive: true })
      await mkdir(figjam, { recursive: true })
      await mkdir(outside, { recursive: true })
      const manifest = (name, id, editorType = ['figma']) => JSON.stringify({ name, id, api: '1.0.0', main: 'code.js', editorType })
      await writeFile(path.join(declared, 'manifest.json'), manifest('Save', 'local.save'))
      await writeFile(path.join(declared, 'code.js'), 'figma.notify("ok")')
      await writeFile(path.join(figjam, 'manifest.json'), manifest('FigJam only', 'local.figjam', ['figjam']))
      await writeFile(path.join(figjam, 'code.js'), 'figma.closePlugin()')
      await writeFile(path.join(outside, 'manifest.json'), manifest('Outside', 'local.outside'))
      await writeFile(path.join(outside, 'code.js'), 'secret')
      await symlink(outside, path.join(plugins, 'linked'), 'dir')
    },
  })
  try {
    const listed = await state.invoke('plugins-list')
    assert.equal(listed.status, 'ok')
    assert.equal(listed.plugins.length, 1)
    assert.equal(listed.plugins[0].name, 'Save')
    assert.equal(listed.plugins[0].id, 'local.save')
    assert.equal(listed.plugins[0].displayName, 'Save')
    assert.equal(Object.hasOwn(listed.plugins[0], 'root'), false)
    const encoded = JSON.stringify(listed)
    assert.equal(encoded.includes(state.root), false)
    assert.equal(encoded.includes('save-plugin'), false)
    assert.equal(encoded.includes('secret'), false)
    assert.equal(encoded.includes('FigJam'), false)
    const menu = state.menu.find(item => item.label === '插件')
    assert.deepEqual(menu.submenu.map(item => item.label ?? item.type), ['打开插件宿主…', 'separator', 'Save'])
    assert.equal(menu.submenu[2].preserveLabel, undefined)
    state.sent = []
    menu.submenu[2].click()
    assert.deepEqual(state.sent, [
      ['design-desktop:command', 'plugins'],
      ['design-desktop:plugin-launch', { grant: listed.plugins[0].grant }],
    ])
    const read = await state.invoke('plugins-read', { grant: listed.plugins[0].grant, paths: ['code.js'] })
    assert.equal(read.files['code.js'], 'figma.notify("ok")')
    assert.equal((await state.invoke('plugins-read', { grant: listed.plugins[0].grant, paths: ['../secret.js'] })).status, 'error')
    assert.equal((await state.invoke('plugins-list', { plugins: [] })).status, 'error')
    assert.equal((await state.invoke('set-interface-locale', 'en')).status, 'ok')
    const english = state.menu.find(item => item.label === 'Plugins')
    assert.equal(english.submenu[0].label, 'Open plugin host…')
    assert.equal(english.submenu[2].label, 'Save')
    const fileSave = state.menu.find(item => item.label === 'File').submenu.find(item => item.label === 'Export copy…')
    assert.equal(fileSave.accelerator, 'CmdOrCtrl+Shift+S')
  } finally { await state.dispose() }
})

function downloadProbe(state, filename) {
  let options
  let blocked = 0
  const before = state.prompts.length
  const item = Object.assign(new EventEmitter(), {
    getFilename: () => filename,
    getURL: () => 'blob:design-app://app/1234-abcd',
    getReceivedBytes: () => 32,
    getTotalBytes: () => 32,
    getInitiatorOrigin: () => 'design-app://app',
    setSaveDialogOptions(value) { options = value },
    cancel() {},
  })
  state.session.emit('will-download', { preventDefault() { blocked += 1 } }, item, state.window.webContents)
  return { blocked, options, prompt: state.prompts.length > before ? state.prompts.at(-1) : undefined }
}

test('blob downloads still reject .fd and .zip and name the extension that failed', async () => {
  const state = await host()
  try {
    const svg = downloadProbe(state, 'drawing.svg')
    assert.equal(svg.blocked, 0)
    assert.equal(svg.options.defaultPath, 'drawing.svg')
    assert.equal(svg.prompt, undefined)
    const fd = downloadProbe(state, 'design.fd')
    assert.equal(fd.blocked, 1)
    assert.equal(fd.options, undefined)
    assert.match(fd.prompt.message, /\.fd/)
    assert.match(fd.prompt.message, /另存为/)
    const zip = downloadProbe(state, 'design-html.zip')
    assert.equal(zip.blocked, 1)
    assert.equal(zip.options, undefined)
    assert.match(zip.prompt.message, /\.zip/)
    assert.equal(zip.prompt.message.includes('.fd'), false)
    const script = downloadProbe(state, 'script.sh')
    assert.equal(script.blocked, 1)
    assert.match(script.prompt.message, /\.sh/)
    assert.equal(script.prompt.message.includes('.fd'), false)
    assert.equal((await state.invoke('set-interface-locale', 'en')).status, 'ok')
    const english = downloadProbe(state, 'design-html.zip')
    assert.equal(english.blocked, 1)
    assert.match(english.prompt.message, /\.zip/)
    assert.equal(english.prompt.message.includes('.fd'), false)
    assert.match(downloadProbe(state, 'design.fd').prompt.message, /Save As/)
  } finally { await state.dispose() }
})

test('product export channel writes validated FD and HTML ZIP only at the dialog path', async () => {
  const state = await host()
  try {
    const dialogs = []
    state.electron.dialog.showSaveDialog = async (...args) => {
      dialogs.push(args.at(-1))
      return state.save.shift() || { canceled: true }
    }
    const requests = state.requests.length
    const fd = Uint8Array.from(makeFd('panel-fd'))
    const fdPath = path.join(state.root, 'design.fd')
    state.save.push({ canceled: false, filePath: fdPath })
    const savedFd = await state.invoke('export-product-file', { kind: 'fd', filename: '../outside.fd', bytes: fd })
    assert.equal(savedFd.status, 'ok')
    assert.equal(savedFd.displayName, 'design.fd')
    assert.equal(JSON.stringify(savedFd).includes(state.root), false)
    assert.equal(dialogs.at(-1).defaultPath, 'design.fd')
    assert.deepEqual(dialogs.at(-1).filters, [{ name: '设计导出文件', extensions: ['fd'] }])
    assert.deepEqual(dialogs.at(-1).properties, ['showOverwriteConfirmation', 'createDirectory'])
    assert.deepEqual(await readFile(fdPath), Buffer.from(fd))
    const outside = path.join(path.dirname(state.root), 'outside.fd')
    await assert.rejects(readFile(outside), /ENOENT/)

    const zip = Uint8Array.from(productZip())
    const zipPath = path.join(state.root, 'design-html.zip')
    state.save.push({ canceled: false, filePath: zipPath })
    const savedZip = await state.invoke('export-product-file', {
      kind: 'html-zip', filename: 'https://evil.example/design-html.zip', bytes: zip,
    })
    assert.equal(savedZip.status, 'ok')
    assert.equal(savedZip.displayName, 'design-html.zip')
    assert.equal(dialogs.at(-1).defaultPath, 'design-html.zip')
    assert.deepEqual(dialogs.at(-1).filters[0].extensions, ['zip'])
    assert.deepEqual(await readFile(zipPath), Buffer.from(zip))

    const dialogsAfterValid = dialogs.length
    const tampered = Uint8Array.from(fd)
    tampered[tampered.length - 1] ^= 1
    const badFd = await state.invoke('export-product-file', { kind: 'fd', filename: 'design.fd', bytes: tampered })
    assert.equal(badFd.status, 'error')
    assert.match(badFd.message, /\.fd/)
    assert.equal(badFd.message.includes('ZIP'), false)
    assert.equal(dialogs.length, dialogsAfterValid)
    await assert.rejects(readFile(path.join(state.root, 'bad.fd')), /ENOENT/)
    const badZip = await state.invoke('export-product-file', {
      kind: 'html-zip', filename: 'design-html.zip', bytes: productZip({ extra: [['payload.exe', Buffer.from('MZ')]] }),
    })
    assert.equal(badZip.status, 'error')
    assert.match(badZip.message, /ZIP/)
    assert.equal(badZip.message.includes('.fd'), false)
    assert.equal(dialogs.length, dialogsAfterValid)

    state.save.push({ canceled: false, filePath: path.join(state.root, 'notes.txt') })
    const wrong = await state.invoke('export-product-file', { kind: 'fd', filename: 'design.fd', bytes: fd })
    assert.equal(wrong.status, 'error')
    assert.match(wrong.message, /\.txt/)
    assert.match(wrong.message, /\.fd/)
    assert.equal(wrong.message.includes('ZIP'), false)
    await assert.rejects(readFile(path.join(state.root, 'notes.txt')), /ENOENT/)

    state.save.push({ canceled: false, filePath: path.join(state.root, 'copy') })
    const appended = await state.invoke('export-product-file', { kind: 'html-zip', filename: 'design-html.zip', bytes: zip })
    assert.equal(appended.status, 'ok')
    assert.equal(appended.displayName, 'copy.zip')
    assert.deepEqual(await readFile(path.join(state.root, 'copy.zip')), Buffer.from(zip))
    state.save.push({ canceled: false, filePath: path.join(state.root, 'copy') })
    const exists = await state.invoke('export-product-file', { kind: 'html-zip', filename: 'design-html.zip', bytes: zip })
    assert.equal(exists.status, 'error')
    assert.match(exists.message, /\.zip/)
    assert.equal(exists.message.includes('.fd'), false)
    assert.deepEqual(await readFile(path.join(state.root, 'copy.zip')), Buffer.from(zip))

    const kept = path.join(state.root, 'kept.txt')
    await writeFile(kept, 'keep')
    const link = path.join(state.root, 'link.fd')
    await symlink(kept, link)
    state.save.push({ canceled: false, filePath: link })
    const linked = await state.invoke('export-product-file', { kind: 'fd', filename: 'design.fd', bytes: fd })
    assert.equal(linked.status, 'error')
    assert.match(linked.message, /\.fd/)
    assert.equal(await readFile(kept, 'utf8'), 'keep')

    state.save.push({ canceled: true })
    assert.equal((await state.invoke('export-product-file', { kind: 'fd', filename: 'design.fd', bytes: fd })).status, 'cancelled')
    const networked = await state.invoke('export-product-file', { kind: 'fd', filename: 'design.fd', bytes: fd, url: 'https://evil.example/design.fd' })
    assert.equal(networked.status, 'error')
    assert.equal((await state.invoke('export-product-file', { kind: 'zip', filename: 'design.zip', bytes: zip })).message.includes('.fd'), false)
    await assert.rejects(
      state.invoke('export-product-file', { kind: 'fd', filename: 'design.fd', bytes: fd }, { sender: {}, senderFrame: state.window.webContents.mainFrame }),
      /Untrusted desktop IPC sender/,
    )
    assert.equal(state.requests.length, requests)
    assert.equal(state.requests.some(request => request.method === 'save'), false)
    assert.deepEqual(state.recent, [])
    assert.equal(downloadProbe(state, 'design.fd').blocked, 1)
    assert.equal(downloadProbe(state, 'design-html.zip').blocked, 1)
  } finally { await state.dispose() }
})

test('TIFF Blob exports reach the owned native save dialog while FD and ZIP stay rejected', async () => {
  const state = await host()
  try {
    for (const filename of ['drawing.tiff', 'drawing.tif']) {
      const result = downloadProbe(state, filename)
      assert.equal(result.blocked, 0, filename)
      assert.equal(result.options.defaultPath, filename)
      assert.deepEqual(result.options.properties, ['showOverwriteConfirmation'])
    }
    for (const filename of ['drawing.fd', 'drawing.zip']) assert.equal(downloadProbe(state, filename).blocked, 1)
  } finally { await state.dispose() }
})
