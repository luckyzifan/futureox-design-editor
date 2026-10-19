import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const filename = process.env.CORE_DESKTOP_TEST_SOURCE
  ? new URL('preload.cjs', process.env.CORE_DESKTOP_TEST_SOURCE)
  : new URL('../src/preload.cjs', import.meta.url)
const source = await readFile(filename, 'utf8')
function load(argv = []) {
  const events = new EventEmitter()
  const calls = []
  let api
  const ipcRenderer = Object.assign(events, {
    invoke: async (...args) => {
      calls.push(args)
      return { status: 'ok' }
    },
  })
  const contextBridge = {
    exposeInMainWorld: (name, value) => {
      assert.equal(name, 'coreDesktop')
      api = value
    },
  }
  const context = vm.createContext({
    process: { argv },
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
      'rendererReady',
      'workspace',
      'live',
      'clipboard',
      'fonts',
      'performTextCommand',
      'renderPolicy',
      'preparation',
      'documentCodec',
      'listCatalog',
      'selectCatalogDirectory',
      'scanCatalogDirectory',
      'openCatalogFile',
      'openDocument',
      'inspectSketch',
      'sketchSession',
      'openPendingDocument',
      'acceptDocument',
      'saveDocument',
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
    ].sort(),
  )
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
  const commands = ['copy-properties','paste-properties','select-matching','select-inverse','new', 'open', 'openPending', 'save', 'saveAs', 'recover', 'zoomIn', 'zoomOut', 'zoom100', 'undo', 'redo', 'cut', 'copy', 'paste', 'paste-in-place', 'select-all', 'duplicate', 'group', 'ungroup', 'delete', 'zoom-fit', 'zoom-selection']
  for (const command of commands) {
    events.emit('design-desktop:command', event, command)
  }
  assert.deepEqual(observed, commands.map((command) => [command]))
  for (const value of ['quit', 'exec', '', null, {}, ['open'], 1]) {
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
