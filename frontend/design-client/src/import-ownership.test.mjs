import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { ImportOwner, importStep } from './import-ownership.ts'

function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const editor = () => ({ sessionGeneration: 1, state: { doc: { id: 'same-document' } } })
test('completed same-canvas imports detach their subscription without aborting the next import', () => {
  const current = editor(), listeners = new Set()
  current.subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  const owner = new ImportOwner(), first = owner.begin(current)
  first.finish(); assert.equal(listeners.size, 0)
  const next = owner.begin(current)
  first.finish(); assert.equal(next.signal.aborted, false); assert.equal(listeners.size, 1)
  next.finish(); assert.equal(listeners.size, 0)
})

for (const stage of ['file read', 'font digest', 'library verification']) {
  test(`same-ID reopening fences a delayed ${stage}`, async () => {
    const current = editor(), owner = new ImportOwner(), request = owner.begin(current), response = deferred()
    const result = importStep(request, () => response.promise)
    current.sessionGeneration++
    response.resolve('old result')
    await assert.rejects(result, /导入请求已过期/)
    assert.equal(request.isCurrent(), false)
  })
}

test('the latest import invocation wins even when an older read completes first', async () => {
  const current = editor(), owner = new ImportOwner(), a = deferred(), b = deferred()
  const first = importStep(owner.begin(current), () => a.promise)
  const next = importStep(owner.begin(current), () => b.promise)
  a.resolve('A')
  await assert.rejects(first, /导入请求已过期/)
  b.resolve('B')
  assert.equal(await next, 'B')
})

test('cancel, another document choice, and unmount retire pending import work', async () => {
  for (const end of [owner => owner.invalidate(), owner => owner.dispose()]) {
    const current = editor(), owner = new ImportOwner(), request = owner.begin(current), response = deferred()
    const result = importStep(request, () => response.promise)
    end(owner)
    assert.equal(request.signal.aborted, true)
    response.resolve('retired')
    await assert.rejects(result, /导入请求已过期/)
    let calls = 0
    await assert.rejects(importStep(request, async () => { calls++; return 'never' }), /导入请求已过期/)
    assert.equal(calls, 0)
    owner.activate()
    assert.equal(request.isLatest(), false)
    assert.equal(await importStep(owner.begin(current), async () => 'new'), 'new')
  }
})

test('the final synchronous mutation fence covers replacement after an awaited helper result', async () => {
  const current = editor(), owner = new ImportOwner(), request = owner.begin(current)
  assert.equal(await importStep(request, async () => 'ready'), 'ready')
  current.sessionGeneration++
  assert.throws(() => request.assertCurrent(), /导入请求已过期/)
})

test('own adoption advances the session but only current request may publish its compatibility report', () => {
  const current = editor(), owner = new ImportOwner(), request = owner.begin(current)
  current.sessionGeneration++
  current.state.doc.id = 'imported-unique-id'
  assert.equal(request.isCurrent(), false)
  assert.equal(request.isLatest(), true)
  owner.invalidate()
  assert.equal(request.isLatest(), false)
})

test('direct workspace navigation aborts owned work while preserving report-generation fencing', () => {
  const current = editor(), listeners = new Set()
  current.subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  const owner = new ImportOwner(), request = owner.begin(current)
  for (const listener of listeners) listener()
  assert.equal(request.signal.aborted, false)
  current.sessionGeneration++
  for (const listener of listeners) listener()
  assert.equal(request.signal.aborted, true)
  assert.equal(request.isCurrent(), false)
  assert.equal(request.isLatest(), true)
  assert.equal(listeners.size, 0)
})

test('production imports capture ownership before read/hash/verify and wire cancellation', () => {
  const read = file => readFileSync(new URL(file, import.meta.url), 'utf8')
  const font = read('./TextStylePanel.tsx'), library = read('./DesignTools.tsx'), app = read('./App.tsx')
  assert.match(font, /const request = imports\.begin\(editor\)/)
  assert.match(font, /importStep\(request, \(\) => selected\.arrayBuffer\(\)\)/)
  assert.match(font, /importStep\(request, \(\) => crypto\.subtle\.digest/)
  assert.match(font, /request\.assertCurrent\(\)\s+editor\.change\('导入文档字体'/)
  assert.match(library, /importStep\(request, \(\) => f\.text\(\)\)/)
  assert.match(library, /importStep\(request, \(\) => verifyLibrary\(JSON\.parse\(source\)\)\)/)
  assert.match(library, /request\.assertCurrent\(\)\s+editor\.change\('安装组件库'/)
  for (const source of [font, library]) {
    assert.match(source, /return \(\) => imports\.dispose\(\)/)
    assert.match(source, /input\?\.addEventListener\('cancel', onCancel\)/)
    assert.match(source, /input\?\.removeEventListener\('cancel', onCancel\)/)
  }
  const input = app.slice(app.indexOf('  async function importDesignFile('), app.indexOf('  const switchLifetime'))
  assert.ok(input.indexOf('const request = fileImports.begin(editor)') < input.indexOf('readDesignFile(f, request.signal)'))
  assert.match(app, /accept="\.fd,\.json,\.svg,\.fig,\.sketch,\.pdf"/)
  assert.match(input, /switchDocument\(document, undefined, true, request\)/)
  assert.match(input, /request\.isLatest\(\) && editor\.state\.doc\.id === document\.id/)
  assert.match(app, /desktopSession\.replace\(document, adoption\.isCurrent\)/)
  assert.match(app, /onCloseRequested\(\(\{ requestId \}\) => \{\s+fileImports\.invalidate\(\)/)
  assert.match(app, /switchLifetime\.current\+\+\s+switchGate\.current = null\s+fileImports\.dispose\(\)/)
  assert.match(app, /fileImports\.invalidate\(\); setMenu\(false\); setShowCatalog\(true\)/)
  assert.match(app, /fileImports\.invalidate\(\); setShowCatalog\(false\)/)
})

// Execute the production switch and cleanup callbacks, without importing App/React,
// WASM, a DOM or renderer. Storage doubles expose only the asynchronous boundaries.
function switchHarness() {
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  const header = '  async function switchDocument(\n    document: DesignDocument,\n    record?: LocalRecord,\n    preserveCurrent = true,\n    request?: ImportRequest,\n  ) {'
  const end = '\n  async function openLocalFiles()'
  assert.equal(source.split(header).length, 2, 'switchDocument signature changed; review extraction')
  assert.equal(source.split(end).length, 2, 'switchDocument boundary changed; review extraction')
  const start = source.indexOf(header), stop = source.indexOf(end, start)
  assert.ok(stop > start)
  const callback = source.slice(start, stop).replace(header, 'async function switchDocument(document, record, preserveCurrent = true, request) {')
  const lifecycle = source.match(/  useEffect\(\(\) => \{\n    switchLifetime\.current\+\+[\s\S]*?\n  \}, \[fileImports\]\)/g)
  assert.equal(lifecycle?.length, 1, 'import lifecycle callback missing or ambiguous')
  const current = editor(), fileImports = new ImportOwner(), changes = [], notices = []
  current.state.version = 0
  current.notify = message => notices.push(message)
  current.load = document => { current.state = { doc: document, version: 0 }; current.sessionGeneration++; return true }
  let cleanup
  const context = vm.createContext({
    editor: current, fileImports, desktopSession: undefined, ready: true,
    switchLifetime: { current: 0 }, switchGate: { current: null },
    useEffect: setup => { cleanup = setup() },
    commitPendingEdits: () => true, cancelPendingOperations: () => {}, hasPendingEdits: () => false,
    initializePicking: async () => {}, localOpen: async () => null,
    prepareDocumentForEditing: document => document,
    localSave: async document => ({ document, revision: 1 }), localSelect: async () => {},
    saver: { save: async () => {}, open: () => {} },
    uid: () => 'backup-id', copyName: name => name,
    ...Object.fromEntries(['setSwitching', 'setRemoteId', 'setRevision', 'setMenu', 'setLocalFiles', 'setReady']
      .map(name => [name, value => changes.push([name, value])])),
  })
  const setup = () => vm.runInContext(lifecycle[0], context)
  setup()
  const switchDocument = vm.runInContext(`${callback}\nswitchDocument`, context)
  return { context, current, fileImports, changes, notices, switchDocument, setup, cleanup: () => cleanup() }
}

for (const invalidate of ['new selection', 'same-ID reopening']) {
  test(`the actual switch catch suppresses an old storage failure after ${invalidate}`, async () => {
    const h = switchHarness(), entered = deferred(), storage = deferred()
    h.context.localSave = () => { entered.resolve(); return storage.promise }
    const request = h.fileImports.begin(h.current)
    const pending = h.switchDocument({ id: 'imported' }, undefined, false, request)
    await entered.promise
    if (invalidate === 'new selection') h.fileImports.invalidate()
    else h.current.sessionGeneration++
    storage.reject(new Error('old storage failure'))
    assert.equal(await pending, false)
    assert.deepEqual(h.notices, [])
    assert.equal(h.current.state.doc.id, 'same-document')
    assert.equal(h.context.switchGate.current, null)
    assert.deepEqual(h.changes.at(-1), ['setSwitching', false])
  })
}

test('the actual switch catch still reports a current post-adoption localSelect failure', async () => {
  const h = switchHarness()
  h.context.localSelect = async () => { throw new Error('current selection write failed') }
  assert.equal(await h.switchDocument({ id: 'imported' }, undefined, false, h.fileImports.begin(h.current)), false)
  assert.equal(h.current.state.doc.id, 'imported')
  assert.deepEqual(h.notices, ['Error: current selection write failed'])
})

test('actual cleanup fences old finally and catch from a remounted replacement operation', async () => {
  const h = switchHarness(), enteredA = deferred(), enteredB = deferred(), storageA = deferred(), storageB = deferred()
  h.context.localSave = document => {
    if (document.id === 'A') { enteredA.resolve(); return storageA.promise }
    enteredB.resolve(); return storageB.promise
  }
  const a = h.switchDocument({ id: 'A' }, undefined, false, h.fileImports.begin(h.current))
  await enteredA.promise
  h.cleanup()
  h.setup()
  const b = h.switchDocument({ id: 'B' }, undefined, false, h.fileImports.begin(h.current))
  await enteredB.promise
  const operationB = h.context.switchGate.current
  storageA.reject(new Error('unmounted storage failure'))
  assert.equal(await a, false)
  assert.equal(h.context.switchGate.current, operationB)
  assert.deepEqual(h.notices, [])
  assert.deepEqual(h.changes, [['setSwitching', true], ['setSwitching', true]])
  storageB.resolve({ document: { id: 'B' }, revision: 1 })
  assert.equal(await b, true)
  assert.equal(h.current.state.doc.id, 'B')
  assert.equal(h.context.switchGate.current, null)
  assert.deepEqual(h.changes.at(-1), ['setSwitching', false])
})

test('a busy rejected direct switch does not retire the already accepted request', async () => {
  const h = switchHarness(), entered = deferred(), storage = deferred()
  h.context.localSave = () => { entered.resolve(); return storage.promise }
  const first = h.switchDocument({ id: 'accepted' }, undefined, false)
  await entered.promise
  assert.equal(await h.switchDocument({ id: 'rejected' }, undefined, false), false)
  storage.resolve({ document: { id: 'accepted' }, revision: 1 })
  assert.equal(await first, true)
  assert.equal(h.current.state.doc.id, 'accepted')
})

test('actual native cancel effects invalidate ownership and detach from replaced input refs', () => {
  for (const name of ['App.tsx', 'TextStylePanel.tsx', 'DesignTools.tsx']) {
    const source = readFileSync(new URL(name, import.meta.url), 'utf8')
    const match = source.match(/  useEffect\(\(\) => \{\n    const input = file\.current\n    const onCancel = \(\) => (?:fileImports|imports)\.invalidate\(\)[\s\S]*?\n  \}\)/g)
    assert.equal(match?.length, 1, `${name} native cancel effect changed`)
    const owner = new ImportOwner(), current = editor(), inputA = new EventTarget(), inputB = new EventTarget()
    const file = { current: inputA }
    let cleanup
    const context = vm.createContext({ file, imports: owner, fileImports: owner, useEffect: setup => { cleanup = setup() } })
    vm.runInContext(match[0], context)
    const first = owner.begin(current)
    inputA.dispatchEvent(new Event('cancel'))
    assert.equal(first.isCurrent(), false)
    cleanup()
    file.current = inputB
    vm.runInContext(match[0], context)
    const next = owner.begin(current)
    inputA.dispatchEvent(new Event('cancel'))
    assert.equal(next.isCurrent(), true)
    inputB.dispatchEvent(new Event('cancel'))
    assert.equal(next.isCurrent(), false)
    cleanup()
  }
})
