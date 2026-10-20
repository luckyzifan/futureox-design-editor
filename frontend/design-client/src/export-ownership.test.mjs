import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
// Resolve through our direct Vite dependency even with isolated Bun installs.
const viteRequire = createRequire(import.meta.resolve('vite'))
const { parseAst } = await import(pathToFileURL(viteRequire.resolve('rolldown/parseAst')).href)
import { ExportOwner, commitExportEdits } from './export-ownership.ts'
import { registerPendingEdit, hasPendingEdits } from './pending-edits.ts'
import { beginEditorAction } from './editor-action-route.ts'
import { CanvasAction, ActionSource, ActionOutcome, ActionReason } from './canvas-action-diagnostics.ts'
import { desktopPet } from './desktop-pet.ts'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const app = read('./App.tsx'), color = read('./ColorPanel.tsx'), batch = read('./ExportPanel.tsx')
// Execute the actual production callback bodies in a controlled async host.
// This is not a React DOM test. AST boundaries avoid capturing unrelated
// neighboring functions when a panel acquires additional imports or handlers.
function callbacks(source, names, result) {
  const tree = parseAst(source, { lang: 'tsx' }, 'panel.tsx')
  const found = new Map(names.map(name => [name, []]))
  const visit = node => {
    if (node.type === 'FunctionDeclaration' && found.has(node.id?.name)) found.get(node.id.name).push(node)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(item => { if (item?.type) visit(item) })
      else if (value?.type) visit(value)
    }
  }
  visit(tree)
  const blocks = names.map(name => {
    assert.equal(found.get(name).length, 1, `unique production callback ${name}`)
    return source.slice(found.get(name)[0].start, found.get(name)[0].end)
  })
  const block = blocks.join('\n')
  assert.match(block, /await import\(['"]\.\/export['"]\)/)
  return stripTypeScriptTypes(`${block.replaceAll(/await import\(['"]\.\/export['"]\)/g, 'await loadExportModule()')}\n;(${result})`)
}
const appScript = callbacks(app, ['generateExport'], 'generateExport')
const colorScript = callbacks(color, ['closePanel', 'output'], '{ output, closePanel }')
const batchScript = callbacks(batch, ['generate'], 'generate')

test('callback isolation preserves multiple lazy imports and excludes neighboring callbacks', () => {
  const script = callbacks(`async function generate() { if (true) await import('./export'); else await import('./export') }
async function unrelated() { throw new Error('must not execute') }`, ['generate'], 'generate')
  assert.equal(script.match(/loadExportModule/g).length, 2)
  assert.doesNotMatch(script, /unrelated/)
  assert.throws(() => callbacks('function other() {}', ['generate'], 'generate'), /unique production callback/)
})
function harness() {
  const listeners = new Set(), messages = [], errors = [], busy = [], created = [], revoked = [], loaders = [], calls = []
  let closed = 0
  const editor = {
    sessionGeneration: 1,
    state: { doc: { id: 'document', nodes: { n: { text: 'original' } } }, page: 'page', selection: ['n'], version: 0 },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    notify(message) { messages.push(message); for (const fn of listeners) fn() },
  }
  const urlApi = {
    createObjectURL(blob) { const url = `blob:owned-${created.length}`; created.push({ url, blob }); return url },
    revokeObjectURL(url) { revoked.push(url) },
  }
  const owner = new ExportOwner(urlApi)
  owner.activate(editor)
  const loadExportModule = () => { const request = deferred(); loaders.push(request); return request.promise }
  const exportsModule = Object.fromEntries(['exportImage', 'exportVisualSvg', 'exportRasterBatch', 'exportPdfVector'].map(name => [name, (...args) => {
    const reply = deferred(); calls.push({ name, args, reply }); return reply.promise
  }]))
  const context = vm.createContext({ exports: owner, editor, loadExportModule, commitExportEdits, sdrToneMap: 'clip',
    beginEditorAction, CanvasAction, ActionSource, ActionOutcome, ActionReason, desktopPet,
    request: { current: null }, kind: 'selection', format: 'png', padding: '40', region: { x: '0', y: '0', width: '10', height: '10' }, scales: [1],
    structuredClone, AbortController, URL: urlApi, urls: { current: [] }, setAssets() {}, setStatus() {}, release() {},
    exportRequest: { current: null }, setBusy: value => busy.push(value), setError: value => errors.push(value), onClose: () => { closed++ },
  })
  const menu = vm.runInContext(appScript, context), panel = vm.runInContext(colorScript, context), generate = vm.runInContext(batchScript, context)
  return {
    editor, owner, context, messages, errors, busy, created, revoked, loaders, calls, menu, panel, generate,
    get closed() { return closed },
    change(update) { update(editor); for (const listener of [...listeners]) listener() },
    async importReady(index = loaders.length - 1) { loaders[index].resolve(exportsModule); await Promise.resolve(); await Promise.resolve() },
    resolve(index = calls.length - 1, name = 'result.png') {
      const asset = { name, blob: new Blob(['pixels']), width: 10, height: 10, scale: 1 }
      calls[index].reply.resolve(calls[index].name === 'exportRasterBatch' ? [asset] : asset)
    },
  }
}

for (const origin of ['menu', 'color']) {
  const start = api => origin === 'menu' ? api.menu('png') : api.panel.output('srgb')
  test(`${origin}: same-tick duplicates start one import and one render`, async () => {
    const api = harness(), first = start(api), duplicate = start(api)
    assert.equal(api.loaders.length, 1)
    await api.importReady(); assert.equal(api.calls.length, 1)
    api.resolve(); await Promise.all([first, duplicate])
    assert.equal(api.created.length, 1)
    assert.equal(api.owner.getSnapshot().name, 'result.png')
    api.owner.dispose(); assert.deepEqual(api.revoked, ['blob:owned-0'])
  })

  test(`${origin}: close before import resolution prevents render and URL adoption`, async () => {
    const api = harness(), pending = start(api)
    if (origin === 'menu') api.owner.close(); else api.panel.closePanel()
    await api.importReady(); await pending
    assert.equal(api.calls.length, 0); assert.equal(api.created.length, 0)
    assert.equal(api.owner.getSnapshot(), null); assert.deepEqual(api.errors, [])
  })

  test(`${origin}: close during rendering suppresses result and error publication`, async () => {
    for (const fails of [false, true]) {
      const api = harness(), pending = start(api); await api.importReady()
      if (origin === 'menu') api.owner.close(); else api.panel.closePanel()
      if (fails) api.calls[0].reply.reject(new Error('retired render')); else api.resolve()
      await pending
      assert.equal(api.created.length, 0); assert.deepEqual(api.errors, [])
      assert.equal(api.messages.some(message => message.includes('retired render')), false)
    }
  })
}

for (const nextOrigin of ['menu', 'color']) {
  test(`shared ownership: newer ${nextOrigin} export wins across menu and Color sources`, async () => {
    const api = harness()
    const old = nextOrigin === 'color' ? api.menu('png') : api.panel.output('srgb')
    await api.importReady(0)
    const next = nextOrigin === 'color' ? api.panel.output('display-p3') : api.menu('svg')
    assert.equal(api.calls[0].args.at(-1)?.aborted, true)
    await api.importReady(1)
    api.resolve(1, 'new.svg'); await next
    api.resolve(0, 'old.png'); await old
    assert.equal(api.created.length, 1); assert.equal(api.owner.getSnapshot().name, 'new.svg')
  })
}

for (const transition of ['session ABA', 'page ABA', 'selection ABA', 'same-document edit']) {
  test(`${transition} retires pending results even when identity values return`, async () => {
    const api = harness(), pending = api.menu('png'); await api.importReady()
    if (transition === 'session ABA') {
      api.change(editor => { editor.sessionGeneration++; editor.state.doc = { ...editor.state.doc } })
    } else if (transition === 'page ABA') {
      api.change(editor => { editor.state.page = 'other' }); api.change(editor => { editor.state.page = 'page' })
    } else if (transition === 'selection ABA') {
      api.change(editor => { editor.state.selection = [] }); api.change(editor => { editor.state.selection = ['n'] })
    } else {
      api.change(editor => { editor.state.doc.nodes.n.text = 'edited'; editor.state.version++ })
      assert.equal(api.calls[0].args[0].nodes.n.text, 'original', 'render input is detached')
    }
    api.resolve(); await pending
    assert.equal(api.created.length, 0); assert.equal(api.owner.getSnapshot(), null)
  })
}

test('replacing, editing and disposing previews revoke only the owned URL once', async () => {
  const api = harness(); let pending = api.menu('png'); await api.importReady(); api.resolve(); await pending
  assert.equal(api.owner.getSnapshot().url, 'blob:owned-0')
  pending = api.menu('svg'); assert.deepEqual(api.revoked, ['blob:owned-0'])
  await api.importReady(); api.resolve(); await pending
  api.change(editor => { editor.state.version++ })
  assert.equal(api.owner.getSnapshot(), null)
  api.owner.dispose(); api.owner.close()
  assert.deepEqual(api.revoked, ['blob:owned-0', 'blob:owned-1'])
})

test('Color close cancels only its request and cannot abort a newer menu request', async () => {
  const api = harness(), old = api.panel.output('srgb'); await api.importReady(0)
  const next = api.menu('png'); api.panel.closePanel(); await api.importReady(1)
  assert.equal(api.calls[1].args.at(-1).aborted, false)
  api.resolve(1, 'menu.png'); await next
  api.resolve(0, 'color.png'); await old
  assert.equal(api.owner.getSnapshot().name, 'menu.png')
})

test('unmount and reactivation retire old requests while preserving new exports', async () => {
  const api = harness(), old = api.menu('visual-svg'); await api.importReady(0)
  api.owner.dispose(); api.owner.activate(api.editor)
  const next = api.menu('png'); await api.importReady(1)
  api.resolve(0, 'old.svg'); await old; assert.equal(api.created.length, 0)
  api.resolve(1, 'new.png'); await next; assert.equal(api.owner.getSnapshot().name, 'new.png')
})

test('current render failures stay visible and snapshot failure starts no import', async () => {
  const api = harness(), pending = api.panel.output('srgb'); await api.importReady()
  api.calls[0].reply.reject(new Error('current failure')); await pending
  assert.match(api.errors[0], /current failure/)
  api.editor.state.doc.uncloneable = () => {}
  await api.menu('png')
  assert.equal(api.loaders.length, 1)
  assert.ok(api.messages.some(message => /clone|function|could not/i.test(message)))
})

test('reentrant close during object URL creation revokes the unadopted URL', () => {
  const api = harness(), revoked = []
  const owner = new ExportOwner({ createObjectURL() { owner.close(); return 'blob:unadopted' }, revokeObjectURL(url) { revoked.push(url) } })
  owner.activate(api.editor)
  const request = owner.begin(api.editor, 'png')
  assert.equal(owner.publish(request, { blob: new Blob(['pixels']), name: 'closed.png' }), false)
  assert.deepEqual(revoked, ['blob:unadopted']); assert.equal(owner.getSnapshot(), null)
})

test('production wiring shares the owner and synchronously handles preview/panel close', () => {
  assert.match(app, /exports\.activate\(editor\)[\s\S]*return \(\) => exports\.dispose\(\)/)
  // A JSX arrow contains `>`; end at this self-closing component instead.
  const colorElements = app.match(/<ColorPanel\b[\s\S]*?\/>/g) ?? []
  assert.equal(colorElements.length, 1, 'exactly one ColorPanel must receive the shared owner')
  assert.doesNotMatch(colorElements[0].slice(1), /</, 'unexpected nested JSX in ColorPanel wiring')
  assert.match(colorElements[0], /\bexports=\{exports\}(?=\s|\/>)/)
  assert.match(app, /onClick=\{\(\) => exports\.close\(\)\}/)
  assert.doesNotMatch(app + color, /setExportAsset|URL\.createObjectURL/)
  assert.match(color, /useLayoutEffect\(\(\) =>[\s\S]*exports\.cancel\(exportRequest\.current\)[\s\S]*exportRequest\.current = null/)
  assert.match(color, /if \(e\.key === 'Escape'\) closePanel\(\)/)
  assert.match(color, /onClick=\{closePanel\}/)
})


for (const origin of ['menu', 'color', 'batch']) {
  const start = api => origin === 'menu' ? api.menu('png') : origin === 'color' ? api.panel.output('srgb') : api.generate()
  test(`${origin}: pending valid edit commits before the immutable export snapshot`, async () => {
    const api = harness(); let dirty = true
    const unregister = registerPendingEdit(api.editor, { dirty: () => dirty, commit() {
      api.change(editor => { editor.state.doc.nodes.n.text = 'committed draft'; editor.state.version++ })
      dirty = false; return true
    } })
    try {
      const pending = start(api); await api.importReady()
      assert.equal(api.calls[0].args[0].nodes.n.text, 'committed draft')
      assert.equal(hasPendingEdits(api.editor), false)
      api.editor.state.doc.nodes.n.text = 'later caller mutation'
      assert.equal(api.calls[0].args[0].nodes.n.text, 'committed draft')
      api.resolve(); await pending
    } finally { unregister(); api.owner.dispose() }
  })

  test(`${origin}: property preview settlement refusal preserves drafts and starts no export`, async () => {
    const api = harness(), boundaries = []; let commits = 0
    api.editor.settleOwnedPropertyPreview = boundary => { boundaries.push(boundary); return false }
    const unregister = registerPendingEdit(api.editor, { dirty: () => true, commit() { commits++; return true } })
    try {
      const pending = start(api)
      assert.deepEqual(boundaries, ['export'])
      assert.equal(commits, 0, 'settlement refusal must precede draft commits')
      assert.equal(hasPendingEdits(api.editor), true)
      assert.equal(api.loaders.length, 0); assert.equal(api.calls.length, 0)
      assert.equal(api.created.length, 0); assert.equal(api.owner.getSnapshot(), null)
      assert.equal(api.context.request.current, null); assert.equal(api.context.exportRequest.current, null)
      await pending
    } finally { unregister(); api.owner.dispose() }
  })

  test(`${origin}: invalid and composing drafts veto export without creating requests or URLs`, async () => {
    for (const label of ['invalid draft', 'IME composition']) {
      const api = harness(), unregister = registerPendingEdit(api.editor, { dirty: () => true, commit: () => false })
      try {
        await start(api)
        assert.equal(api.loaders.length, 0, label); assert.equal(api.calls.length, 0, label)
        assert.equal(api.created.length, 0, label); assert.equal(api.context.request.current, null)
        assert.equal(hasPendingEdits(api.editor), true, label)
        assert.ok(api.messages.some(message => message.includes('当前输入已保留')), label)
      } finally { unregister(); api.owner.dispose() }
    }
  })

  test(`${origin}: commit-triggered session change and page/selection ABA cancel the export target`, async () => {
    for (const transition of ['session', 'page', 'selection']) {
      const api = harness(); let dirty = true
      const unregister = registerPendingEdit(api.editor, { dirty: () => dirty, commit() {
        dirty = false
        if (transition === 'session') api.change(editor => { editor.sessionGeneration++ })
        if (transition === 'page') { api.change(editor => { editor.state.page = 'other' }); api.change(editor => { editor.state.page = 'page' }) }
        if (transition === 'selection') { api.change(editor => { editor.state.selection = [] }); api.change(editor => { editor.state.selection = ['n'] }) }
        return true
      } })
      try {
        await start(api)
        assert.equal(api.loaders.length, 0); assert.equal(api.created.length, 0)
        assert.ok(api.messages.some(message => message.includes('导出已取消')))
      } finally { unregister(); api.owner.dispose() }
    }
  })
}


test('owner rejects live property previews even when a caller bypasses settlement', () => {
  const api = harness()
  api.editor.propertyPreviewActive = true
  assert.equal(api.owner.begin(api.editor, 'png'), null)
  assert.equal(api.created.length, 0); assert.equal(api.owner.getSnapshot(), null)
  api.owner.dispose()
})

test('foreign owner cannot publish, cancel or finish another owner request', () => {
  const api = harness(), foreign = new ExportOwner({
    createObjectURL() { assert.fail('foreign owner must not create a URL') },
    revokeObjectURL() { assert.fail('foreign owner must not revoke a URL') },
  })
  foreign.activate(api.editor)
  const request = api.owner.begin(api.editor, 'png')
  assert.ok(request)
  const asset = { blob: new Blob(['pixels']), name: 'owned.png' }
  assert.equal(foreign.publish(request, asset), false)
  foreign.cancel(request); foreign.finish(request)
  assert.equal(request.isCurrent(), true)
  assert.equal(api.owner.publish(request, asset), true)
  assert.equal(api.owner.getSnapshot().name, 'owned.png')
  assert.equal(foreign.getSnapshot(), null)
  foreign.dispose(); api.owner.dispose()
  assert.deepEqual(api.revoked, ['blob:owned-0'])
})

test('reentrant replacement during URL creation rejects the old result without cancelling the new request', () => {
  const api = harness(), revoked = []; let replacement, created = 0
  const owner = new ExportOwner({
    createObjectURL() {
      const url = `blob:reentrant-${created++}`
      if (!replacement) replacement = owner.begin(api.editor, 'new')
      return url
    },
    revokeObjectURL(url) { revoked.push(url) },
  })
  owner.activate(api.editor)
  const old = owner.begin(api.editor, 'old')
  assert.equal(owner.publish(old, { blob: new Blob(['old']), name: 'old.png' }), false)
  assert.deepEqual(revoked, ['blob:reentrant-0'])
  assert.equal(old.signal.aborted, true); assert.equal(owner.getSnapshot(), null)
  assert.equal(replacement.isCurrent(), true)
  owner.finish(old)
  assert.equal(replacement.isCurrent(), true)
  assert.equal(owner.publish(replacement, { blob: new Blob(['new']), name: 'new.png' }), true)
  assert.equal(owner.getSnapshot().name, 'new.png')
  owner.dispose(); api.owner.dispose()
  assert.deepEqual(revoked, ['blob:reentrant-0', 'blob:reentrant-1'])
})
