import { expect, test } from 'vitest'
import { Editor } from '../engine'
import { blank, defaultLayout, defaultSizing, node, type DesignDocument } from '../model'
import { createEditorDesignAutomation } from '../automation/index'
import { prepareLayoutAdd, prepareLayoutRemove } from './layout-command'
const request = (e: Editor, method: string, params: Record<string, unknown>) => ({ method, params, expectedRevision: e.state.version, documentId: e.state.doc.id, session: e.sessionGeneration })
function fixture() {
  const doc = blank(), frame = node('frame', 30, 50, 400, 250), a = node('rectangle', 100, 80, 30, 20), b = node('rectangle', 10, 10, 40, 30), c = node('rectangle', 10, 140, 20, 20)
  frame.children = [a.id, b.id, c.id]; doc.pages[0].children = [frame.id]
  for (const n of [frame, a, b, c]) doc.nodes[n.id] = n
  return { doc, frame, a, b, c }
}
function parity(doc: DesignDocument, ids: string[], mode: 'horizontal' | 'vertical' | 'none', wrapper = false) {
  const ui = new Editor(structuredClone(doc)), mcp = new Editor(structuredClone(doc)), api = createEditorDesignAutomation(mcp)
  try {
    ui.select(ids); mcp.select(ids)
    const before = ui.state.doc
    ui.autoLayout(mode)
    const r = api.execute(request(mcp, mode === 'none' ? 'layout.remove' : 'layout.add', { ids: [...ids].reverse(), ...(mode === 'none' ? {} : { mode }), ...(wrapper ? { id: ui.state.selection[0] } : {}) }))
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(mcp.state.doc).toEqual(ui.state.doc)
    // add selects the shared target; remove preserves explicit request order.
    if (mode !== 'none' || ids.length === 1) expect(mcp.state.selection).toEqual(ui.state.selection)
    expect(mcp.state.version).toBe(ui.state.version)
    const after = ui.state.doc
    if (ui.canUndo) {
      ui.undo(); mcp.undo(); expect(ui.state.doc).toEqual(before); expect(mcp.state.doc).toEqual(before)
      ui.redo(); mcp.redo(); expect(ui.state.doc).toEqual(after); expect(mcp.state.doc).toEqual(after)
    }
    return structuredClone(after)
  } finally { api.dispose(); ui.dispose(); mcp.dispose() }
}
test('ordinary scattered selection reflows, stable axis ties ignore request ordering; one undo/redo', () => {
  const f = fixture(), after = parity(f.doc, [f.a.id, f.b.id, f.c.id], 'horizontal', true)
  const wrapper = after.nodes[after.nodes[f.frame.id].children[0]]
  expect(wrapper.children).toEqual([f.b.id, f.c.id, f.a.id])
  expect(wrapper.layout).toMatchObject({ gap: 12, padding: [16, 16, 16, 16] })
  expect(after.nodes[f.b.id].transform[4]).toBe(16)
  expect(after.nodes[f.c.id].transform[5]).toBe(16)
})
test.each(['horizontal', 'vertical'] as const)('frame add and remove %s preserve normalized geometry and fill->fixed', mode => {
  const f = fixture(); f.frame.layout = { ...defaultLayout(), mode }; f.a.sizing = { ...defaultSizing(), width: 'fill' }
  f.b.constraints = { horizontal: 'end', vertical: 'stretch', referenceWidth: 100, referenceHeight: 80 }
  const e = new Editor(f.doc)
  let normalized: DesignDocument
  try {
    e.change('committed resize', d => { d.nodes[f.frame.id].width = 510; d.nodes[f.frame.id].height = 300 })
    normalized = structuredClone(e.state.doc)
  } finally { e.dispose() }
  const after = parity(normalized!, [f.frame.id], 'none')
  for (const id of [f.frame.id, ...f.frame.children]) {
    const a = after.nodes[id], b = normalized!.nodes[id]
    expect([a.transform, a.width, a.height, a.children]).toEqual([b.transform, b.width, b.height, b.children])
  }
  expect(after.nodes[f.a.id].sizing!.width).toBe('fixed')
  expect(after.nodes[f.b.id].constraints).toMatchObject({ referenceWidth: 510, referenceHeight: 300 })
})
test('empty frame add, single rectangle wrap and ordinary group conversion succeed', () => {
  const f = fixture(); f.frame.children = []; delete f.doc.nodes[f.a.id]; delete f.doc.nodes[f.b.id]; delete f.doc.nodes[f.c.id]
  parity(f.doc, [f.frame.id], 'horizontal')
  const g = fixture(); parity(g.doc, [g.a.id], 'vertical', true)
  g.frame.kind = 'group'; parity(g.doc, [g.frame.id], 'horizontal')
})
test('active equal layout and inactive remove are zero-history no-ops', () => {
  const f = fixture(); f.frame.layout = defaultLayout()
  const e = new Editor(f.doc), api = createEditorDesignAutomation(e)
  try {
    expect(api.execute(request(e, 'layout.add', { ids: [f.frame.id], mode: 'horizontal' })).ok).toBe(true)
    expect(e.canUndo).toBe(false)
    const g = fixture(), other = new Editor(g.doc)
    try { other.autoLayout('none', [g.frame.id]); expect(other.canUndo).toBe(false); expect(other.state.doc.nodes[g.frame.id].sizing).toBeUndefined() } finally { other.dispose() }
  } finally { api.dispose(); e.dispose() }
})
test.each(['target', 'ancestor', 'child'] as const)('in-place frame layout properties permit authored locked %s through UI and MCP', which => {
  const f = fixture()
  if (which === 'ancestor') {
    const outer = node('frame', 0, 0, 800, 600); outer.locked = true; outer.children = [f.frame.id]
    f.doc.nodes[outer.id] = outer; f.doc.pages[0].children = [outer.id]
  } else f.doc.nodes[which === 'child' ? f.a.id : f.frame.id].locked = true
  const added = parity(f.doc, [f.frame.id], 'horizontal')
  expect(added.nodes[f.frame.id].layout?.mode).toBe('horizontal')
  const removed = parity(added, [f.frame.id], 'none')
  expect(removed.nodes[f.frame.id].layout).toBeUndefined()
  for (const id of Object.keys(f.doc.nodes)) expect(removed.nodes[id].locked).toBe(f.doc.nodes[id].locked)
})
test.each(['target', 'ancestor', 'descendant', 'conversion'] as const)('structural layout wrap/type conversion still rejects authored locked %s', which => {
  const f = fixture(), outside = node('rectangle', 700, 0, 20, 20)
  f.doc.nodes[outside.id] = outside; f.doc.pages[0].children.push(outside.id)
  let ids = [f.a.id, f.b.id]
  if (which === 'target') f.a.locked = true
  if (which === 'ancestor') f.frame.locked = true
  if (which === 'descendant') { f.a.locked = true; ids = [f.frame.id, outside.id] }
  if (which === 'conversion') { f.frame.kind = 'group'; f.a.locked = true; ids = [f.frame.id] }
  const e = new Editor(f.doc), api = createEditorDesignAutomation(e)
  try {
    const before = e.state.doc
    expect(() => e.autoLayout('horizontal', ids)).toThrow()
    expect(api.execute(request(e, 'layout.add', { ids, mode: 'horizontal' }))).toMatchObject({ ok: false, error: { code: 'locked_node' } })
    expect(api.execute(request(e, 'layout.add', { ids, mode: 'horizontal', lockIntent: 'property' })).ok).toBe(false)
    expect(e.state.doc).toBe(before); expect(e.canUndo).toBe(false)
  } finally { api.dispose(); e.dispose() }
})
test('mixed remove targets, stale batch geometry and wrapper-only parameters reject without commits', () => {
  const f = fixture(); f.frame.layout = defaultLayout()
  const e = new Editor(f.doc), api = createEditorDesignAutomation(e)
  try {
    const before = e.state.doc
    for (const [method, params] of [
      ['layout.remove', { ids: [f.frame.id, f.a.id] }],
      ['layout.add', { ids: [f.frame.id], mode: 'horizontal', id: f.a.id }],
      ['batch.apply', { operations: [{ method: 'node.update', params: { ids: [f.frame.id], patch: { width: 900 } } }, { method: 'layout.remove', params: { ids: [f.frame.id] } }] }],
    ] as const) {
      expect(api.execute(request(e, method, params)).ok).toBe(false)
      expect(e.state.doc).toBe(before); expect(e.canUndo).toBe(false)
    }
  } finally { api.dispose(); e.dispose() }
})
test('explicit padding works, hidden and absolute slots persist, rotated reflected parent is admitted', () => {
  const f = fixture(); f.frame.transform = [0, -1, -1, 0, 300, 400]; f.b.visible = false; f.c.sizing = { ...defaultSizing(), absolute: true }
  const plan = prepareLayoutAdd(f.doc, [f.c.id, f.b.id, f.a.id], { mode: 'vertical', gap: 7, padding: { top: 1, right: 2, bottom: 3, left: 4 } }, { fresh: true })
  expect(plan.childOrder).toEqual([f.a.id, f.b.id, f.c.id]); expect(plan.layout.padding).toEqual([1, 2, 3, 4])
  f.frame.transform = [0, 0, 0, 0, 0, 0]
  expect(() => prepareLayoutAdd(f.doc, [f.a.id], { mode: 'horizontal' }, { fresh: true })).toThrow('invertible')
})
test('remove is nonrecursive and rejects responsive parents; no caller freshness proof', () => {
  const f = fixture(); f.frame.layout = defaultLayout(); f.a.kind = 'frame'; f.a.layout = defaultLayout()
  const after = parity(f.doc, [f.frame.id], 'none'); expect(after.nodes[f.a.id].layout).toEqual(defaultLayout())
  expect(() => prepareLayoutRemove(f.doc, [f.a.id], { fresh: true })).toThrow('layout ancestor')
  expect(() => prepareLayoutRemove(f.doc, [f.frame.id], { fresh: false })).toThrow('Commit')
})
test('component and instance-origin admission is explicit; no partial target mutation', () => {
  const f = fixture()
  f.a.instanceOrigin = { owner: f.frame.id, key: 'derived', source: f.b.id }
  let failure: unknown
  try { prepareLayoutAdd(f.doc, [f.b.id, f.a.id], { mode: 'horizontal' }, { fresh: true }) } catch (error) { failure = error }
  expect(failure).toMatchObject({ code: 'instance_structure' })
  expect(f.frame.children).toEqual([f.a.id, f.b.id, f.c.id])
})
test('wrapper and leaf permissions, stale fences and unsupported client freshness cannot bypass admission', () => {
  const f = fixture(), e = new Editor(f.doc)
  const api = createEditorDesignAutomation(e, { grants: [{ resource: { documentId: f.doc.id, session: e.sessionGeneration }, operations: ['batch.apply', 'layout.remove'], access: 'write' }] })
  try {
    const before = e.state.doc
    expect(api.methods().map(m => m.name)).not.toContain('layout.add')
    expect(api.execute(request(e, 'batch.apply', { operations: [{ method: 'layout.add', params: { ids: [f.a.id], mode: 'horizontal' } }] }))).toMatchObject({ ok: false, error: { code: 'permission_denied' } })
    expect(api.execute({ ...request(e, 'layout.remove', { ids: [f.frame.id] }), expectedRevision: 999 }).ok).toBe(false)
    expect(api.execute(request(e, 'layout.remove', { ids: [f.frame.id], normalized: true })).ok).toBe(false)
    expect(e.state.doc).toBe(before); expect(e.canUndo).toBe(false)
  } finally { api.dispose(); e.dispose() }
})
test.each(['horizontal', 'vertical'] as const)('remove freezes only %s parent-assigned stretch/hug text axis without text-anchor drift', mode => {
  const doc = blank(), frame = node('frame', 40, 60, 400, 180), text = node('text', 10, 20, 40, 20)
  text.text = 'Stretch then freeze'; text.sizing = { ...defaultSizing(), width: 'hug', height: 'hug', minWidth: 20, maxWidth: 600, minHeight: 10, maxHeight: 300 }
  text.textStyle = { ...text.textStyle!, align: 'center', wrap: true }
  frame.layout = { ...defaultLayout(), mode, align: 'stretch' }; frame.children = [text.id]
  doc.nodes = { [frame.id]: frame, [text.id]: text }; doc.pages[0].children = [frame.id]
  const e = new Editor(doc)
  let normalized: DesignDocument
  try { normalized = structuredClone(e.state.doc) } finally { e.dispose() }
  const after = parity(normalized!, [frame.id], 'none'), before = normalized!.nodes[text.id], result = after.nodes[text.id]
  expect([result.transform, result.width, result.height]).toEqual([before.transform, before.width, before.height])
  expect(result.sizing![mode === 'vertical' ? 'width' : 'height']).toBe('fixed')
  expect(result.sizing![mode === 'vertical' ? 'height' : 'width']).toBe('hug')
})
test.each(['alignSelf', 'overrideStart', 'absolute', 'hidden'] as const)('remove stretch admission respects %s and preserves unrelated hug intent', behavior => {
  const doc = blank(), frame = node('frame', 0, 0, 300, 100), text = node('text', 10, 10, 30, 30)
  text.text = 'Short'; text.sizing = { ...defaultSizing(), width: 'hug', height: 'fixed', alignSelf: behavior === 'alignSelf' ? 'stretch' : behavior === 'overrideStart' ? 'start' : null, absolute: behavior === 'absolute' }
  if (behavior === 'hidden') text.visible = false
  frame.layout = { ...defaultLayout(), mode: 'vertical', align: behavior === 'alignSelf' ? 'start' : 'stretch' }
  frame.children = [text.id]; doc.nodes = { [frame.id]: frame, [text.id]: text }; doc.pages[0].children = [frame.id]
  const e = new Editor(doc)
  let normalized: DesignDocument
  try { normalized = structuredClone(e.state.doc) } finally { e.dispose() }
  const after = parity(normalized!, [frame.id], 'none'), original = normalized!.nodes[text.id], result = after.nodes[text.id]
  expect([result.transform, result.width, result.height]).toEqual([original.transform, original.width, original.height])
  expect(result.sizing!.width).toBe(behavior === 'alignSelf' ? 'fixed' : 'hug')
})
test('no-argument UI inference preserves its historical 16-unit wrapper outset and inferred spacing', () => {
  const doc = blank(), a = node('rectangle', 10, 10, 30, 20), b = node('rectangle', 80, 10, 40, 20)
  doc.nodes = { [a.id]: a, [b.id]: b }; doc.pages[0].children = [a.id, b.id]
  const e = new Editor(doc)
  try {
    e.select([a.id, b.id]); const before = e.state.doc
    e.autoLayout()
    const frame = e.state.doc.nodes[e.state.selection[0]]
    expect(frame.layout).toMatchObject({ mode: 'horizontal', gap: 40, padding: [16, 16, 16, 16] })
    expect(frame.transform).toEqual([1, 0, 0, 1, -6, -6])
    expect(e.state.doc.nodes[a.id].transform).toEqual([1, 0, 0, 1, 16, 16])
    e.undo(); expect(e.state.doc).toEqual(before)
  } finally { e.dispose() }
})
test.each([
  ['horizontal', 0], ['vertical', 0], ['horizontal', 1e-10], ['vertical', 1e-10],
] as const)('remove %s preserves Hug when fit_axis skips a rotated child with coefficient %s', (mode, coefficient) => {
  const doc = blank(), frame = node('frame', 0, 0, 300, 180), text = node('text', 0, 0, 30, 30)
  text.text = 'Short'; text.sizing = { ...defaultSizing(), width: 'hug', height: 'hug' }
  text.transform = [coefficient, 1, -1, coefficient, 0, 0]
  frame.layout = { ...defaultLayout(), mode, align: 'stretch' }; frame.children = [text.id]
  doc.nodes = { [frame.id]: frame, [text.id]: text }; doc.pages[0].children = [frame.id]
  const e = new Editor(doc)
  let normalized: DesignDocument
  try { normalized = structuredClone(e.state.doc) } finally { e.dispose() }
  const after = parity(normalized!, [frame.id], 'none'), original = normalized!.nodes[text.id], result = after.nodes[text.id]
  expect([result.transform, result.width, result.height]).toEqual([original.transform, original.width, original.height])
  expect(result.sizing).toMatchObject({ width: 'hug', height: 'hug' })
})
test('remove native grid freezes both parent-assigned stretch/Hug text axes and preserves normalized geometry', () => {
  const doc = blank(), frame = node('frame', 20, 30, 300, 180), text = node('text', 0, 0, 30, 30)
  text.text = 'Short'; text.sizing = { ...defaultSizing(), width: 'hug', height: 'hug' }
  frame.layout = { ...defaultLayout(), mode: 'grid', columns: 1, fillRows: true, align: 'stretch' }; frame.children = [text.id]
  doc.nodes = { [frame.id]: frame, [text.id]: text }; doc.pages[0].children = [frame.id]
  const e = new Editor(doc)
  let normalized: DesignDocument
  try { normalized = structuredClone(e.state.doc) } finally { e.dispose() }
  expect([normalized!.nodes[text.id].width, normalized!.nodes[text.id].height]).toEqual([268, 148])
  const after = parity(normalized!, [frame.id], 'none'), original = normalized!.nodes[text.id], result = after.nodes[text.id]
  expect([result.transform, result.width, result.height]).toEqual([original.transform, original.width, original.height])
  expect(result.sizing).toMatchObject({ width: 'fixed', height: 'fixed' })
})
test('multi-frame remove is a property intent, while mixed nonframe removal rejects atomically', () => {
  const f = fixture(), other = node('frame', 600, 0, 100, 100)
  f.frame.layout = defaultLayout(); f.frame.locked = true; f.a.locked = true
  other.layout = defaultLayout(); other.locked = true; f.doc.nodes[other.id] = other; f.doc.pages[0].children.push(other.id)
  const e = new Editor(f.doc), api = createEditorDesignAutomation(e)
  try {
    const before = e.state.doc
    expect(api.execute(request(e, 'layout.remove', { ids: [f.frame.id, f.b.id] })).ok).toBe(false)
    expect(e.state.doc).toBe(before); expect(e.canUndo).toBe(false)
    expect(api.execute(request(e, 'layout.remove', { ids: [f.frame.id, other.id] })).ok).toBe(true)
    expect(e.state.doc.nodes[f.frame.id].layout).toBeUndefined(); expect(e.state.doc.nodes[other.id].layout).toBeUndefined()
    expect(e.state.doc.nodes[f.frame.id].locked).toBe(true); expect(e.state.doc.nodes[other.id].locked).toBe(true)
    e.undo(); expect(e.state.doc).toEqual(before)
  } finally { api.dispose(); e.dispose() }
})
test('authored locked property access never grants read-only callers write permission', () => {
  const f = fixture(); f.frame.locked = true
  const e = new Editor(f.doc), api = createEditorDesignAutomation(e, { grants: [{ resource: { documentId: f.doc.id, session: e.sessionGeneration }, operations: ['layout.add', 'layout.remove', 'batch.apply'], access: 'read' }] })
  try {
    const before = e.state.doc
    expect(api.methods()).toEqual([])
    for (const [method, params] of [['layout.add', { ids: [f.frame.id], mode: 'horizontal' }], ['layout.remove', { ids: [f.frame.id] }], ['batch.apply', { operations: [{ method: 'layout.remove', params: { ids: [f.frame.id] } }] }]] as const)
      expect(api.execute(request(e, method, params))).toMatchObject({ ok: false, error: { code: 'permission_denied' } })
    expect(e.state.doc).toBe(before); expect(e.canUndo).toBe(false)
  } finally { api.dispose(); e.dispose() }
})
