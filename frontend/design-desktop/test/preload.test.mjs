import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const filename = process.env.CORE_DESKTOP_TEST_SOURCE
  ? new URL('preload.cjs', process.env.CORE_DESKTOP_TEST_SOURCE)
  : new URL('../src/preload.cjs', import.meta.url)
const source = await readFile(filename, 'utf8')
function load(argv = [], reply = { status: 'ok' }, window) {
  const events = new EventEmitter()
  const calls = []
  let api
  const ipcRenderer = Object.assign(events, {
    postMessage: (...args) => calls.push(args),
    invoke: async (...args) => {
      calls.push(args)
      return reply
    },
  })
  const contextBridge = {
    exposeInMainWorld: (name, value) => {
      assert.equal(name, 'coreDesktop')
      api = value
    },
  }
  const context = vm.createContext({
    process: { argv }, window,
    require: (name) => {
      assert.equal(name, 'electron', 'Sandboxed preload must load no filesystem/process library')
      return { ipcRenderer, contextBridge }
    },
  })
  vm.runInContext(source, context, { filename: String(filename), timeout: 1000 })
  return { api, events, calls, context }
}

test('preload exposes a frozen narrow API and no Node, raw IPC, filesystem, or shell handle', () => {
  const { api, context } = load()
  assert.equal(Object.isFrozen(api), true)
  assert.deepEqual(
    Object.keys(api).sort(),
    [
      'version',
      'plugins',
      'petConfigure',
      'petEvent',
      'onPetStatus',
      'diagnostics',
      'automation',
      'setInterfaceLocale',
      'rendererReady',
      'workspace',
      'workspaceRoot',
      'live',
      'clipboard',
      'designAi',
      'designAgent',
      'fonts',
      'performTextCommand',
      'renderPolicy',
      'renderDiagnostics',
      'renderDiagnosticsDetail',
      'preparation',
      'documentCodec',
      'listCatalog',
      'selectCatalogDirectory',
      'scanCatalogDirectory',
      'openCatalogFile',
      'openDocument',
      'inspectSketch',
      'sketchSession',
      'largeDocument',
      'openPendingDocument',
      'acceptDocument',
      'saveDocument',
      'exportProductFile',
      'exportAssetDirectory',
      'exportAssetZip',
      'readRecovery',
      'acceptRecovery',
      'writeRecovery',
      'clearRecovery',
      'setDirty',
      'respondToClose',
      'onCloseRequested',
      'onCommand',
      'nativeRender',
      'nativeRenderStats',
      'videoEncode',
    ].sort(),
  )
  assert.equal(Object.isFrozen(api.designAi),true)
  assert.deepEqual(Object.keys(api.designAi).sort(),['cancel','configure','run','status'])
  assert.equal(api.version, 1)
  for (const key of [
    'require',
    'process',
    'ipcRenderer',
    'send',
    'invoke',
    'fs',
    'exec',
    'shell',
  ]) {
    assert.equal(Object.hasOwn(api, key), false)
  }
  assert.equal(api.process, undefined)
})

test('preload request methods map only to the fixed desktop IPC allowlist', async () => {
  const { api, calls } = load()
  const cases = [
    ['petConfigure', 'pet-configure', 'active'],
    ['petEvent', 'pet-event', 'save'],
    ['rendererReady', 'renderer-ready', undefined],
    ['listCatalog', 'catalog-list', undefined],
    ['selectCatalogDirectory', 'catalog-select', undefined],
    ['scanCatalogDirectory', 'catalog-scan', { directoryHandle: 'opaque' }],
    ['openCatalogFile', 'catalog-open', { directoryHandle: 'opaque', fileId: 'file' }],
    ['openDocument', 'open', undefined],
    ['inspectSketch', 'sketch-inspect', undefined],
    ['openPendingDocument', 'open-pending', undefined],
    ['acceptDocument', 'document-accept', { handle: '10000000-0000-0000-0000-000000000001' }],
    ['saveDocument', 'save', { documentJson: '{"test":true}', saveAs: true }],
    ['exportProductFile', 'export-product-file', { kind: 'fd', filename: 'design.fd', bytes: Uint8Array.of(70, 88) }],
    ['exportAssetDirectory', 'export-asset-directory', { files: [], manifest: { format: 'futureox.asset-batch.v1' } }],
    ['exportAssetZip', 'export-asset-zip', { filename: 'assets.zip', files: [], manifest: { format: 'futureox.asset-batch.v1' } }],
    ['readRecovery', 'recovery-read', undefined],
    [
      'acceptRecovery',
      'recovery-accept',
      { recoveryHandle: '10000000-0000-0000-0000-000000000002' },
    ],
    ['writeRecovery', 'recovery-write', { documentJson: '{}' }],
    ['clearRecovery', 'recovery-clear', { recoveryHandle: '10000000-0000-0000-0000-000000000002' }],
    ['setDirty', 'dirty', true],
    ['respondToClose', 'close-response', { requestId: 'fixture', allow: false }],
  ]
  for (const [name, channel, value] of cases) {
    assert.deepEqual(await api[name](value), { status: 'ok' })
    assert.deepEqual(calls.at(-1), [`design-desktop:${channel}`, value])
  }
  assert.equal(calls.length, cases.length)
})

test('command subscription strips IPC event, rejects invalid payloads and removes its own listener', () => {
  const { api, events } = load()
  const observed = []
  const event = { sender: { dangerous: 'never expose' } }
  const unsubscribe = api.onCommand((...args) => observed.push(args))
  const commands = ['plugins', 'copy-properties','paste-properties','select-matching','select-inverse','new', 'new-page', 'open', 'openPending', 'save', 'saveAs', 'recover', 'zoomIn', 'zoomOut', 'zoom100', 'undo', 'redo', 'cut', 'copy', 'paste', 'copy-as-png', 'copy-as-svg', 'paste-to-replace', 'paste-over-selection', 'paste-in-place', 'select-all', 'duplicate', 'group', 'ungroup', 'delete', 'zoom-fit', 'zoom-selection', 'center-selection']
  for (const command of commands) {
    events.emit('design-desktop:command', event, command)
  }
  assert.deepEqual(observed, commands.map((command) => [command]))
  for (const value of ['quit', 'exec', 'new-page ', 'New-page', { command: 'new-page' }, '', 'paste-over-selection ', 'Paste-over-selection', 'design-desktop:paste-over-selection', null, undefined, {}, { command: 'paste-over-selection' }, { toString: () => 'paste-over-selection' }, ['paste-over-selection'], ['open'], 1]) {
    events.emit('design-desktop:command', event, value)
  }
  assert.equal(observed.length, commands.length)
  unsubscribe()
  unsubscribe()
  assert.equal(events.listenerCount('design-desktop:command'), 0)
  events.emit('design-desktop:command', event, 'open')
  assert.equal(observed.length, commands.length)
})

test('close subscription strips event, validates requests, and independently cleans up callbacks', () => {
  const { api, events } = load()
  const observed = []
  const second = []
  const one = api.onCloseRequested((...args) => observed.push(args))
  const two = api.onCloseRequested((value) => second.push(value))
  const request = { requestId: 'test-request' }
  events.emit('design-desktop:close-request', { sender: 'private' }, request)
  assert.deepEqual(observed, [[request]])
  for (const value of [undefined, null, {}, 42, { requestId: 7 }]) {
    events.emit('design-desktop:close-request', {}, value)
  }
  assert.equal(observed.length, 1)
  one()
  assert.equal(events.listenerCount('design-desktop:close-request'), 1)
  events.emit('design-desktop:close-request', {}, request)
  assert.equal(observed.length, 1)
  assert.equal(second.length, 2)
  two()
  assert.equal(events.listenerCount('design-desktop:close-request'), 0)
})

test('subscriptions reject non-functions before registering any IPC listener', () => {
  const { api, events } = load()
  for (const method of ['onCommand', 'onCloseRequested']) {
    for (const invalid of [undefined, null, 'callback', 1, {}]) {
      assert.throws(() => api[method](invalid), /Expected a callback/)
    }
  }
  assert.deepEqual(events.eventNames(), [])
})

test('render policy is captured from trusted preload argv and deeply frozen', () => {
  const argv = ['--core-cpu-only']
  const { api } = load(argv)
  assert.equal(api.renderPolicy.cpuOnly, true)
  assert.equal(Object.isFrozen(api.renderPolicy), true)
  argv.length = 0
  assert.equal(api.renderPolicy.cpuOnly, true)
  assert.throws(() => { api.renderPolicy.cpuOnly = false }, TypeError)
  assert.equal(load(['?cpuOnly=true']).api.renderPolicy.cpuOnly, false)
})

test('GPU working budget is an optional immutable launch argument, separate from CPU policy', () => {
  assert.deepEqual(Object.keys(load().api.renderPolicy), ['cpuOnly'])
  assert.equal(Object.hasOwn(load().api.renderPolicy, 'gpuWorkingBudgetMiB'), false)
  for (const value of [256, 1024, 4096]) {
    const argv = [`--core-gpu-working-budget-mib=${value}`]
    const { api } = load(argv)
    assert.equal(api.renderPolicy.gpuWorkingBudgetMiB, value)
    assert.equal(api.renderPolicy.cpuOnly, false)
    assert.equal(Object.isFrozen(api.renderPolicy), true)
    argv[0] = '--core-gpu-working-budget-mib=512'
    assert.equal(api.renderPolicy.gpuWorkingBudgetMiB, value)
    assert.throws(() => { api.renderPolicy.gpuWorkingBudgetMiB = 512 }, TypeError)
  }
  assert.equal(load(['--core-cpu-only', '--core-gpu-working-budget-mib=4096']).api.renderPolicy.cpuOnly, true)
  assert.equal(Object.hasOwn(load(['?gpuWorkingBudgetMiB=4096']).api.renderPolicy, 'gpuWorkingBudgetMiB'), false)
})

test('malformed or duplicate host GPU budget arguments reject before exposing a bridge', () => {
  for (const value of ['', 'auto', '256 ', '256\n', '4096\r\n', '0256', '+256', '-256', '256.0', '1e3', '0x100', '255', '4097', 'Infinity'])
    assert.throws(() => load([`--core-gpu-working-budget-mib=${value}`]), /core-gpu-working-budget-mib.*256.*4096/)
  assert.throws(() => load(['--core-gpu-working-budget-mib']), /core-gpu-working-budget-mib.*256.*4096/)
  assert.throws(() => load(['--core-gpu-working-budget-mib=256', '--core-gpu-working-budget-mib=4096']), /must occur once/)
})


test('workspace, font and clipboard APIs are frozen fixed-method bridges', async () => {
  const { api, calls } = load()
  for (const key of ['workspace', 'fonts', 'clipboard']) assert.equal(Object.isFrozen(api[key]), true)
  for (const [name, channel] of [['list','workspace-list'],['open','workspace-open'],['commit','workspace-commit'],['trash','workspace-trash'],['revisions','workspace-revisions'],['restore','workspace-restore']]) {
    const value = { id: 'document' }
    await api.workspace[name](value)
    assert.deepEqual(calls.at(-1), [`design-desktop:${channel}`, value])
  }
  await api.clipboard.read(); assert.deepEqual(calls.at(-1), ['design-desktop:clipboard-read', undefined])
  await api.clipboard.write({ text: 'hello' }); assert.deepEqual(calls.at(-1), ['design-desktop:clipboard-write', {text:'hello'}])
  await api.fonts.list(); assert.deepEqual(calls.at(-1), ['design-desktop:fonts-list', undefined])
  await api.fonts.read({id:'font'}); assert.deepEqual(calls.at(-1), ['design-desktop:fonts-read', {id:'font'}])
  await api.performTextCommand('copy'); assert.deepEqual(calls.at(-1), ['design-desktop:text-command', 'copy'])
})

test('Sketch session preload is frozen and maps named methods without accepting open paths', async () => {
  const { api, calls } = load()
  assert.equal(Object.isFrozen(api.sketchSession), true)
  assert.deepEqual(Object.keys(api.sketchSession).sort(), ['close', 'leafFrame', 'open', 'preview', 'redo', 'rename', 'resizeLegacyContainer', 'saveAs', 'setLeafFrame', 'setTextOverride', 'status', 'textTargets', 'textValue', 'undo'])
  await api.sketchSession.open({ path: '/renderer/supplied.sketch' })
  const rename = { owner: { kernel_id: 'sketch' }, expectedRevision: 0, layerId: 'P', name: 'Name' }
  await api.sketchSession.rename(rename)
  const close = { owner: rename.owner, expectedRevision: 1, discard: false }
  await api.sketchSession.close(close)
  assert.deepEqual(calls, [ ['design-desktop:sketch-session-open', undefined], ['design-desktop:sketch-session-rename', rename], ['design-desktop:sketch-session-close', close] ])
  const query = { owner: rename.owner, expectedRevision: 1, layerId: 'R' }
  await api.sketchSession.leafFrame(query)
  const frame = { ...query, x: -1, y: 2, width: 10, height: 12 }
  await api.sketchSession.setLeafFrame(frame)
  assert.deepEqual(calls.slice(3), [['design-desktop:sketch-session-leaf-frame', query], ['design-desktop:sketch-session-set-leaf-frame', frame]])
  const text = { owner: rename.owner, expectedRevision: 1, instanceId: 'I', targetPath: 'G/T', text: 'New text' }
  await api.sketchSession.setTextOverride(text)
  assert.deepEqual(calls.at(-1), ['design-desktop:sketch-session-set-text-override', text])

})

test('local window API stays frozen and uses only three fixed IPC methods',async()=>{
 const {api,calls}=load();assert.equal(Object.isFrozen(api.live),true);assert.deepEqual(Object.keys(api.live).sort(),['initial','observe','openWindow'].sort());
 await api.live.initial();await api.live.observe({documentId:'d',viewHash:''});await api.live.openWindow({id:'d'});
 assert.deepEqual(calls.map(c=>c[0]),['design-desktop:live-initial','design-desktop:live-observe','design-desktop:live-new-window']);
})

test('native render API is frozen, maps the fixed native-render channels, and stats fail safe to null', async () => {
  const { api, calls } = load()
  assert.equal(Object.isFrozen(api.nativeRender), true)
  assert.deepEqual(Object.keys(api.nativeRender).sort(), ['frame', 'load', 'stats', 'stop'])
  await api.nativeRender.load('{"schemaVersion":1}')
  await api.nativeRender.frame({ pageId: 'p', width: 8, height: 8, view: { x: 0, y: 0, zoom: 1 } }, 2)
  await api.nativeRender.stats()
  await api.nativeRender.stop()
  assert.deepEqual(calls.map((c) => c[0]), ['native-render:load', 'native-render:frame', 'native-render:stats', 'native-render:stop'])
  // The stub invoke answers { status: 'ok' } (no ok/gpu_memory): the stats
  // convenience must report absence rather than fabricate a breakdown.
  assert.equal(await api.nativeRenderStats(), null)
})

test('video encode preload is frozen and does not accept a filesystem path', async () => {
  const { api, calls } = load()
  assert.equal(Object.isFrozen(api.videoEncode), true)
  assert.deepEqual(Object.keys(api.videoEncode).sort(), ['encode', 'status'])
  await api.videoEncode.status()
  await api.videoEncode.encode({ format: 'mp4', fps: 12, frames: [] })
  assert.deepEqual(calls.map(call => call[0]), ['design-desktop:video-encode-status', 'design-desktop:video-encode'])
  assert.equal(calls[1][1].format, 'mp4')
  assert.equal(Object.hasOwn(calls[1][1], 'ffmpegPath'), false)
})


test('automation preload is frozen and routes only named IPC methods', async () => {
  const { api, calls } = load()
  const requests = {
    status: ['automation-status', false], config: ['automation-config', false],
    configure: ['automation-configure', true], auditHistory: ['automation-audit-history', true],
    storageStatus: ['automation-storage-status', false], enable: ['automation-enable', true],
    disable: ['automation-disable', false], copyConnection: ['automation-copy-connection', false],
    register: ['automation-register', true], recordEdit: ['automation-record-edit', true],
    respond: ['automation-response', true],
  }
  assert.equal(Object.isFrozen(api.automation), true)
  assert.deepEqual(Object.keys(api.automation).sort(), [...Object.keys(requests), 'onStatus', 'onRequest', 'onCancel'].sort())
  for (const key of ['require', 'process', 'ipcRenderer', 'send', 'invoke', 'fs', 'exec', 'shell']) {
    assert.equal(Object.hasOwn(api.automation, key), false)
  }
  const value = { requestId: 'test', channel: 'arbitrary-channel-must-not-be-used' }
  for (const [method, [channel, forwards]] of Object.entries(requests)) {
    assert.deepEqual(await api.automation[method](value), { status: 'ok' })
    assert.deepEqual(calls.at(-1), [`design-desktop:${channel}`, forwards ? value : undefined])
  }
  assert.equal(calls.length, Object.keys(requests).length)
})

test('automation subscriptions filter payloads, strip IPC events and independently unsubscribe', () => {
  const { api, events } = load()
  const cases = [
    ['onStatus', 'automation-status', [{ enabled: true }, { enabled: false }], [{}, { enabled: 1 }]],
    ['onRequest', 'automation-request', [{ requestId: 'a', kind: 'capabilities' }, { requestId: 'b', kind: 'execute' }], [{ requestId: 1, kind: 'execute' }, { requestId: 'x', kind: 'shell' }, {}]],
    ['onCancel', 'automation-cancel', [{ requestId: 'a' }], [{ requestId: 1 }, {}]],
  ]
  for (const [method, suffix, valid, invalid] of cases) {
    const channel = `design-desktop:${suffix}`
    assert.throws(() => api.automation[method](null), /Expected a callback/)
    assert.equal(events.listenerCount(channel), 0)
    const first = [], second = []
    const removeFirst = api.automation[method]((...args) => first.push(args))
    const removeSecond = api.automation[method]((...args) => second.push(args))
    const privateEvent = { sender: { secret: true } }
    for (const payload of [...invalid, null, undefined, 42]) events.emit(channel, privateEvent, payload)
    assert.deepEqual(first, [])
    for (const payload of valid) events.emit(channel, privateEvent, payload)
    assert.deepEqual(first, valid.map(value => [value]))
    assert.deepEqual(second, first)
    removeFirst(); removeFirst()
    assert.equal(events.listenerCount(channel), 1)
    events.emit(channel, privateEvent, valid[0])
    assert.equal(first.length, valid.length)
    assert.equal(second.length, valid.length + 1)
    removeSecond()
    assert.equal(events.listenerCount(channel), 0)
  }
})


test('workspace root selection is a frozen capability and never forwards renderer paths', async () => {
  const { api, calls } = load()
  assert.equal(Object.isFrozen(api.workspaceRoot), true)
  assert.deepEqual(Object.keys(api.workspaceRoot).sort(), ['activate', 'select', 'status', 'useDefault'])
  await api.workspaceRoot.status('/renderer/path')
  await api.workspaceRoot.select({ path: '/renderer/path' })
  await api.workspaceRoot.useDefault({ path: '/renderer/path' })
  await api.workspaceRoot.activate({ selectionId: 'opaque' })
  assert.deepEqual(calls, [
    ['design-desktop:workspace-root-status', undefined],
    ['design-desktop:workspace-root-select', undefined],
    ['design-desktop:workspace-root-default', undefined],
    ['design-desktop:workspace-root-activate', { selectionId: 'opaque' }],
  ])
})

 test('diagnostics API has only fixed read/write channels', async () => {
  const {api, calls} = load()
  assert.equal(Object.isFrozen(api.diagnostics), true)
  await api.diagnostics.read(); await api.diagnostics.write('safe-json')
  assert.deepEqual(calls, [['design-desktop:diagnostics-read', undefined], ['design-desktop:diagnostics-write', 'safe-json']])
 })

test('handled desktop failures notify diagnostics while storage failures do not recurse', async () => {
  const {api} = load([], {status:'error',code:'BACKEND_TIMEOUT',message:'private file path'})
  const records=[];const stop=api.diagnostics.onError(value=>records.push(value))
  await api.openDocument();await api.diagnostics.read();await api.diagnostics.write('{}')
  assert.equal(records.length,1);assert.equal(records[0].code,'BACKEND_TIMEOUT');assert.equal(records[0].message,undefined)
  stop();await api.openDocument();assert.equal(records.length,1)
})

test('pet health subscription validates payload, strips IPC event and unsubscribes', () => {
  const {api, events}=load(), received=[]
  const unsubscribe=api.onPetStatus(value=>received.push(value))
  events.emit('design-desktop:pet-status',{}, {mode:'active',phase:'starting',revision:1})
  events.emit('design-desktop:pet-status',{}, {mode:'active',phase:'ready',revision:2})
  events.emit('design-desktop:pet-status',{}, {mode:'off',phase:'unavailable',revision:3})
  events.emit('design-desktop:pet-status',{}, {mode:'active',phase:'unknown',revision:4})
  assert.equal(received.length,3)
  unsubscribe(); assert.equal(events.listenerCount('design-desktop:pet-status'),0)
})

test('local plugin preload lists startup plugins and accepts only a grant launch', async () => {
  const { api, calls, events } = load()
  assert.equal(Object.isFrozen(api.plugins), true)
  assert.deepEqual(await api.plugins.list({ path: '/tmp/plugins' }), { status: 'ok' })
  assert.deepEqual(calls.at(-1), ['design-desktop:plugins-list', undefined])
  const seen = []
  const stop = api.plugins.onLaunch(value => seen.push(value))
  const grant = '00000000-0000-4000-8000-000000000001'
  events.emit('design-desktop:plugin-launch', { sender: { secret: true } }, { grant })
  events.emit('design-desktop:plugin-launch', {}, { grant, root: '/tmp/plugins' })
  events.emit('design-desktop:plugin-launch', {}, { grant: '../plugins' })
  events.emit('design-desktop:plugin-launch', {}, null)
  assert.deepEqual(seen, [{ grant }])
  stop()
  events.emit('design-desktop:plugin-launch', {}, { grant })
  assert.equal(seen.length, 1)
  assert.equal(events.listenerCount('design-desktop:plugin-launch'), 0)
})

test('terminal diagnostics is disabled unless explicit native launch flag is present',()=>{assert.equal(load().api.renderDiagnostics,false);assert.equal(load(['--core-render-diagnostics']).api.renderDiagnostics,true)})

test('detail mode is separately explicit',()=>{assert.equal(load().api.renderDiagnosticsDetail,false);assert.equal(load(['--core-render-diagnostics','--core-render-diagnostics-detail']).api.renderDiagnosticsDetail,true)})

test('document capacity is frozen trusted launch policy and cannot be supplied by a document request',()=>{
 const {api}=load(['--core-document-memory-bytes=1073741824'])
 assert.equal(api.documentCapacity.memoryBytes,1073741824)
 assert.equal(Object.isFrozen(api.documentCapacity),true)
 for(const value of ['0','Infinity','1073741824.5','-1','9007199254740992']) assert.throws(()=>load([`--core-document-memory-bytes=${value}`]))
 assert.throws(()=>load(['--core-document-memory-bytes=1073741824','--core-document-memory-bytes=1073741824']))
})

test('preload transfers one pose port only from its own window and issued session',async()=>{
 let handle
 const window={addEventListener(name,listener){if(name==='message')handle=listener}}
 const {api,calls}=load([],'session',window)
 const port={},send=(source,session)=>handle({source,data:{type:'futureox-terminal-port-v1',session},ports:[port]})
 assert.equal(api.preparation.terminalPortV1,true)
 send(window,'session');await api.preparation.open();send({},'session');send(window,'other')
 assert.equal(calls.length,1);send(window,'session');send(window,'session')
 assert.equal(calls.length,2);assert.equal(calls[1][0],'native-preparation:terminal-port');assert.equal(calls[1][2][0],port)
 await api.preparation.open();await api.preparation.close('session');send(window,'session');assert.equal(calls.length,4)
})
