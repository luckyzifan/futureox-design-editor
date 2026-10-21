import { expect, test } from 'vitest'
import { Editor } from '../engine'
import { figmaFixture } from '../figma-fixtures'
import { blank, node, defaultLayout, defaultSizing, type DesignDocument } from '../model'
import { createEditorDesignAutomation } from '../automation/index'
import { multiply, rotate, translate } from './affine'
import { insertInstance, stampKeys } from '../components'
import { worldMatrix } from '../geometry'
import { selectionCommandAdmission, prepareSelectionArrangement, SelectionCommandError } from './selection-command'
const request = (editor: Editor, method: string, params: Record<string, unknown>) => ({ method, params, expectedRevision: editor.state.version, documentId: editor.state.doc.id, session: editor.sessionGeneration })
function pair(document: DesignDocument) { return [new Editor(structuredClone(document)), new Editor(structuredClone(document))] as const }
function completeParity(document: DesignDocument, ids: string[], uiAction: (editor: Editor) => unknown, method: string, params: (ui: Editor) => Record<string, unknown>, changed = true) {
  const [ui, mcp] = pair(document), api = createEditorDesignAutomation(mcp), events = [[], []] as string[][]
  const stops = [ui, mcp].map((editor, i) => editor.subscribeEdits(event => events[i].push(`${event.kind}:${event.source}`)))
  try {
    ui.select(ids); mcp.select(ids)
    const before = [ui.state.doc, mcp.state.doc]
    const uiResult = uiAction(ui), response = api.execute(request(mcp, method, params(ui)))
    expect(response.ok).toBe(true); expect(ui.state.doc).toEqual(mcp.state.doc); expect(ui.state.selection).toEqual(mcp.state.selection)
    const after = ui.state.doc
    expect(ui.state.version).toBe(changed ? 1 : 0); expect(mcp.state.version).toBe(changed ? 1 : 0)
    if (changed) {
      ui.undo('user'); mcp.undo('automation'); expect(ui.state.doc).toEqual(before[0]); expect(mcp.state.doc).toEqual(before[1])
      ui.redo('user'); mcp.redo('automation'); expect(ui.state.doc).toEqual(after); expect(mcp.state.doc).toEqual(after)
      expect(events).toEqual([['edit:user', 'undo:user', 'redo:user'], ['edit:automation', 'undo:automation', 'redo:automation']])
    } else {
      expect(uiResult).toMatchObject({ status: 'unchanged', revision: 0 })
      expect(response).toMatchObject({ ok: true, result: { noChange: true } })
      expect(events).toEqual([[], []]); expect(ui.canUndo).toBe(false); expect(mcp.canUndo).toBe(false)
    }
    return structuredClone(after)
  } finally { stops.forEach(stop => stop()); api.dispose(); ui.dispose(); mcp.dispose() }
}
function childrenFixture(kind: 'group' | 'frame' | 'section' | 'vector' = 'group') {
  const doc = blank(), wrapper = node(kind, 30, 40, 120, 100), a = node('rectangle', 10, 15, 30, 20), b = node('ellipse', 60, 50, 20, 30), outside = node('rectangle', 220, 80, 20, 20)
  wrapper.children = [a.id, b.id]; if (kind === 'vector') { wrapper.booleanOperation = 'union'; doc.schemaVersion = 4 }
  doc.nodes = Object.fromEntries([wrapper, a, b, outside].map(n => [n.id, n])); doc.pages[0].children = [wrapper.id, outside.id]
  return { doc, wrapper, a, b, outside }
}
function rejectedParity(doc: DesignDocument, ids: string[], uiAction: (editor: Editor) => unknown, method: string, params: Record<string, unknown>, code: string) {
  const [ui, mcp] = pair(doc), api = createEditorDesignAutomation(mcp)
  try {
    ui.select(ids); mcp.select(ids); const a = ui.state.doc, b = mcp.state.doc
    expect(uiAction(ui)).toMatchObject({ status: 'rejected', code })
    expect(api.execute(request(mcp, method, params))).toMatchObject({ ok: false, error: { code } })
    expect(ui.state.doc).toBe(a); expect(mcp.state.doc).toBe(b); expect(ui.state.version).toBe(0); expect(mcp.state.version).toBe(0)
    expect(ui.canUndo).toBe(false); expect(mcp.canUndo).toBe(false)
  } finally { api.dispose(); ui.dispose(); mcp.dispose() }
}

for (const matrix of [multiply(translate(40, 20), rotate(30)), [-2, .4, .2, 3, 17, -8] as const]) test(`parent-local curve wrap and alignment parity under ${matrix.join(',')}`, () => {
  const doc = figmaFixture('curve'), frame = doc.nodes[doc.pages[0].children[0]], id = frame.children[0]; frame.transform = [...matrix]
  const after = completeParity(doc, [id], ui => ui.group(), 'node.group', ui => ({ ids: [id], id: ui.state.selection[0] }))
  worldMatrix(after, id).forEach((v, i) => expect(v).toBeCloseTo(worldMatrix(doc, id)[i], 8))
  completeParity(doc, [id], ui => ui.align('y', 'end'), 'node.align', () => ({ ids: [id], axis: 'y', mode: 'end' }))
})
test('hidden explicit targets and hidden descendants use one geometry policy', () => {
  const f = childrenFixture(); f.a.visible = false; f.wrapper.visible = false
  completeParity(f.doc, [f.wrapper.id], ui => ui.group(), 'node.group', ui => ({ ids: [f.wrapper.id], id: ui.state.selection[0] }))
})
test('boolean ungroup cancels the combination without baking container styles', () => {
  const f = childrenFixture('vector'); f.wrapper.opacity = .4; f.a.fills[0].color = '#ff0000'; f.b.fills[0].color = '#00ff00'
  const after = completeParity(f.doc, [f.wrapper.id], ui => ui.ungroup(), 'node.ungroup', () => ({ ids: [f.wrapper.id] }))
  expect(after.nodes[f.wrapper.id]).toBeUndefined(); expect(after.nodes[f.a.id].fills).toEqual(f.a.fills); expect(after.nodes[f.a.id].opacity).toBe(1)
})
test('ungroup releases direct masks but preserves nested masks and outside sibling fields', () => {
  const f = childrenFixture(), nested = node('group', 0, 0, 10, 10), leaf = node('rectangle', 1, 1, 4, 4)
  nested.children = [leaf.id]; nested.mask = true; leaf.mask = true; f.a.mask = true; f.wrapper.children.push(nested.id)
  f.doc.nodes[nested.id] = nested; f.doc.nodes[leaf.id] = leaf
  const after = completeParity(f.doc, [f.wrapper.id], ui => ui.ungroup(), 'node.ungroup', () => ({ ids: [f.wrapper.id] }))
  expect(after.nodes[f.a.id].mask).toBe(false); expect(after.nodes[nested.id].mask).toBe(false); expect(after.nodes[leaf.id].mask).toBe(true)
  expect(after.nodes[f.outside.id]).toEqual(f.outside)
})
for (const locked of ['root', 'ancestor', 'child'] as const) test(`locked ${locked} rejects both routes atomically`, () => {
  const f = childrenFixture()
  if (locked === 'child') f.a.locked = true
  else if (locked === 'root') f.wrapper.locked = true
  else { const outer = node('group'); outer.locked = true; outer.children = [f.wrapper.id]; f.doc.nodes[outer.id] = outer; f.doc.pages[0].children[0] = outer.id }
  rejectedParity(f.doc, [f.wrapper.id], ui => ui.ungroup(), 'node.ungroup', { ids: [f.wrapper.id] }, 'locked_node')
})
test('mixed valid and invalid unwrap never removes the valid container first', () => {
  const f = childrenFixture(); rejectedParity(f.doc, [f.wrapper.id, f.outside.id], ui => ui.ungroup(), 'node.ungroup', { ids: [f.wrapper.id, f.outside.id] }, 'invalid_kind')
})
for (const operation of ['align', 'wrap', 'unwrap'] as const) test(`auto-layout ${operation} refusal has UI/MCP parity`, () => {
  const f = childrenFixture('frame'); f.wrapper.layout = { ...defaultLayout(), mode: 'horizontal' }
  const ids = operation === 'unwrap' ? [f.wrapper.id] : [f.a.id]
  const method = operation === 'align' ? 'node.align' : operation === 'wrap' ? 'node.group' : 'node.ungroup'
  const params = operation === 'align' ? { ids, axis: 'x', mode: 'start' } : { ids }
  rejectedParity(f.doc, ids, ui => operation === 'align' ? ui.align('x', 'start') : operation === 'wrap' ? ui.group() : ui.ungroup(), method, params, operation === 'align' ? 'auto_layout_position' : 'unsupported_layout_topology')
})
test('absolute auto-layout child remains alignable', () => {
  const f = childrenFixture('frame'); f.wrapper.layout = { ...defaultLayout(), mode: 'horizontal' }; f.a.sizing = { ...defaultSizing(), absolute: true }
  completeParity(f.doc, [f.a.id], ui => ui.align('x', 'end'), 'node.align', () => ({ ids: [f.a.id], axis: 'x', mode: 'end' }))
})
test('two-object distribution is a truthful unchanged result without history', () => {
  const f = childrenFixture(); completeParity(f.doc, [f.a.id, f.b.id], ui => ui.align('x', 'distribute'), 'node.distribute', () => ({ ids: [f.a.id, f.b.id], axis: 'x' }), false)
})
test('equal edge gaps have full parity and fixed outer objects', () => {
  const doc = blank(), a = node('rectangle', 0, 0, 10, 20), b = node('rectangle', 20, 10, 20, 20), c = node('rectangle', 100, 30, 10, 20)
  doc.nodes = Object.fromEntries([a, b, c].map(n => [n.id, n])); doc.pages[0].children = [a.id, b.id, c.id]
  const after = completeParity(doc, [c.id, b.id, a.id], ui => ui.align('x', 'distribute'), 'node.distribute', () => ({ ids: [c.id, b.id, a.id], axis: 'x' }))
  expect(after.nodes[a.id]).toEqual(a); expect(after.nodes[c.id]).toEqual(c); expect(after.nodes[b.id].transform[4]).toBe(45)
})
test('overlap/containment distribution is explicitly unsupported on both routes', () => {
  const doc = blank(), a = node('rectangle', 0, 0, 100, 20), b = node('rectangle', 10, 10, 20, 20), c = node('rectangle', 150, 30, 10, 20)
  doc.nodes = Object.fromEntries([a, b, c].map(n => [n.id, n])); doc.pages[0].children = [a.id, b.id, c.id]; const ids = [a.id, b.id, c.id]
  rejectedParity(doc, ids, ui => ui.align('x', 'distribute'), 'node.distribute', { ids, axis: 'x' }, 'unsupported_distribution_geometry')
})
test('batch simple vector measurements are fresh after earlier mutation, with one commit and exact retry', () => {
  const doc = figmaFixture('curve'), frame = doc.nodes[doc.pages[0].children[0]], id = frame.children[0], [ui, mcp] = pair(doc), api = createEditorDesignAutomation(mcp)
  try {
    ui.select([id]); ui.align('x', 'start'); ui.align('x', 'end')
    const before = mcp.state.doc, req = request(mcp, 'batch.apply', { mutationId: 'core-geometry', operations: [
      { method: 'node.align', params: { ids: [id], axis: 'x', mode: 'start' } }, { method: 'node.align', params: { ids: [id], axis: 'x', mode: 'end' } },
    ] })
    expect(api.execute(req).ok).toBe(true); expect(mcp.state.doc).toEqual(ui.state.doc); expect(mcp.state.version).toBe(1)
    const after = mcp.state.doc; expect(api.execute(req)).toMatchObject({ ok: true, result: { receipt: { replayed: true } } }); expect(mcp.state.doc).toBe(after)
    mcp.undo('automation'); expect(mcp.state.doc).toEqual(before); mcp.redo('automation'); expect(mcp.state.doc).toEqual(after)
  } finally { api.dispose(); ui.dispose(); mcp.dispose() }
})
test('unproven derived batch geometry refuses the whole request rather than using stale boolean networks', () => {
  const f = childrenFixture('vector'), editor = new Editor(f.doc), api = createEditorDesignAutomation(editor)
  try {
    const before = editor.state.doc
    expect(api.execute(request(editor, 'batch.apply', { operations: [
      { method: 'node.update', params: { ids: [f.a.id], patch: { transform: [1, 0, 0, 1, 55, 15] } } },
      { method: 'node.group', params: { ids: [f.wrapper.id] } },
    ] }))).toMatchObject({ ok: false, error: { code: 'unsupported_derived_batch_geometry' } })
    expect(editor.state.doc).toBe(before); expect(editor.state.version).toBe(0); expect(editor.canUndo).toBe(false)
    expect(() => prepareSelectionArrangement(before, [f.a.id], 'x', 'start', { fresh: false })).toThrow(SelectionCommandError)
  } finally { api.dispose(); editor.dispose() }
})
test('shared admission keeps instance structural restrictions without forging authority', () => {
  const f = childrenFixture(); f.wrapper.component = { variants: {}, properties: {} }
  rejectedParity(f.doc, [f.wrapper.id], ui => ui.ungroup(), 'node.ungroup', { ids: [f.wrapper.id] }, 'instance_structure')
  const editor = new Editor(childrenFixture().doc), api = createEditorDesignAutomation(editor, { grants: [] })
  try { expect(api.execute(request(editor, 'node.group', { ids: [editor.state.doc.pages[0].children[0]] }))).toMatchObject({ ok: false, error: { code: 'permission_denied' } }) }
  finally { api.dispose(); editor.dispose() }
  expect(selectionCommandAdmission(f.doc, [f.wrapper.id], 'unwrap')).toMatchObject({ ok: false, code: 'instance_structure' })
})

test('MCP scopes, stale fences and forged freshness metadata cannot bypass the shared command', () => {
  const f = childrenFixture(), editor = new Editor(f.doc), api = createEditorDesignAutomation(editor)
  try {
    const before = editor.state.doc, params = { ids: [f.a.id], axis: 'x', mode: 'start' }
    expect(api.execute({ ...request(editor, 'node.align', params), expectedRevision: 99 })).toMatchObject({ ok: false, error: { code: 'stale_revision' } })
    expect(api.execute({ ...request(editor, 'node.align', params), selectionGeometryFresh: true })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect(api.execute(request(editor, 'node.align', { ...params, selectionGeometryFresh: true }))).toMatchObject({ ok: false, error: { code: 'invalid_params' } })
    expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
  } finally { api.dispose(); editor.dispose() }
})


function actualInstanceFixture() {
  const f = childrenFixture('frame'); f.wrapper.component = { variants: {}, properties: {} }; stampKeys(f.doc, f.wrapper.id)
  const id = insertInstance(f.doc, f.wrapper.id, f.doc.pages[0].id, { x: 350, y: 0 }), normalized = new Editor(f.doc)
  try { return { doc: structuredClone(normalized.state.doc), id, child: normalized.state.doc.nodes[id].children[0], outside: f.outside.id } }
  finally { normalized.dispose() }
}
test('real materialized instance roots and internal children cannot be structurally wrapped or unwrapped', () => {
  const f = actualInstanceFixture()
  expect(f.doc.nodes[f.child].instanceOrigin?.owner).toBe(f.id)
  for (const id of [f.id, f.child])
    rejectedParity(f.doc, [id], ui => ui.group(), 'node.group', { ids: [id] }, 'instance_structure')
  rejectedParity(f.doc, [f.id], ui => ui.ungroup(), 'node.ungroup', { ids: [f.id] }, 'instance_structure')
})
test('real instance root alignment preserves links and internal alignment uses native overrides', () => {
  const f = actualInstanceFixture()
  const root = completeParity(f.doc, [f.id, f.outside], ui => ui.align('y', 'start'), 'node.align', () => ({ ids: [f.id, f.outside], axis: 'y', mode: 'start' }))
  expect(root.nodes[f.id].instance).toEqual(f.doc.nodes[f.id].instance)
  const internal = completeParity(f.doc, [f.child], ui => ui.align('x', 'end'), 'node.align', () => ({ ids: [f.child], axis: 'x', mode: 'end' }))
  expect(internal.nodes[f.child].instanceOrigin).toEqual(f.doc.nodes[f.child].instanceOrigin)
  expect(Object.keys(internal.nodes[f.id].instance!.overrides)).not.toHaveLength(0)
})
test('cross-page selection rejects atomically and cross-parent same-page alignment preserves full parity', () => {
  const f = childrenFixture('frame'), second = blank().pages[0], other = node('rectangle', 200, 300, 20, 20)
  f.doc.pages.push(second); second.children = [other.id]; f.doc.nodes[other.id] = other
  rejectedParity(f.doc, [f.a.id, other.id], ui => ui.align('y', 'start'), 'node.align', { ids: [f.a.id, other.id], axis: 'y', mode: 'start' }, 'different_pages')
  completeParity(f.doc, [f.a.id, f.outside.id], ui => ui.align('y', 'end'), 'node.align', () => ({ ids: [f.a.id, f.outside.id], axis: 'y', mode: 'end' }))
})
test('noncontiguous sibling grouping uses scene order, not request order', () => {
  const doc = blank(), a = node('rectangle', 0, 0, 10, 10), middle = node('rectangle', 20, 0, 10, 10), b = node('rectangle', 40, 0, 10, 10)
  doc.nodes = Object.fromEntries([a, middle, b].map(n => [n.id, n])); doc.pages[0].children = [a.id, middle.id, b.id]
  const after = completeParity(doc, [b.id, a.id], ui => ui.group(), 'node.group', ui => ({ ids: [b.id, a.id], id: ui.state.selection[0] }))
  const wrapper = after.nodes[after.pages[0].children[0]]
  expect(wrapper.children).toEqual([a.id, b.id]); expect(after.pages[0].children[1]).toBe(middle.id); expect(after.nodes[middle.id]).toEqual(middle)
})


test('constraint-derived geometry after a parent resize refuses the batch atomically', () => {
  const f = childrenFixture('frame'); f.a.constraints = { horizontal: 'end', vertical: 'start', referenceWidth: 120, referenceHeight: 100 }
  const editor = new Editor(f.doc), api = createEditorDesignAutomation(editor)
  try {
    const before = editor.state.doc
    expect(api.execute(request(editor, 'batch.apply', { operations: [
      { method: 'node.update', params: { ids: [f.wrapper.id], patch: { width: 200 } } },
      { method: 'node.align', params: { ids: [f.a.id], axis: 'x', mode: 'end' } },
    ] }))).toMatchObject({ ok: false, error: { code: 'unsupported_derived_batch_geometry' } })
    expect(editor.state.doc).toBe(before); expect(editor.state.version).toBe(0); expect(editor.canUndo).toBe(false)
  } finally { api.dispose(); editor.dispose() }
})


for (const anchor of ['end', 'stretch', 'scale'] as const) for (const operation of ['wrap', 'unwrap'] as const)
  test(`constrained ${anchor} ${operation} preserves native world geometry, child styles and exact undo`, () => {
    const f = childrenFixture('frame'), outer = node('frame', 70, 90, 500, 400)
    outer.children = [f.wrapper.id]; f.doc.nodes[outer.id] = outer; f.doc.pages[0].children[0] = outer.id
    f.a.constraints = { horizontal: anchor, vertical: anchor, referenceWidth: 120, referenceHeight: 100 }; f.a.opacity = .6
    const ids = operation === 'wrap' ? [f.a.id] : [f.wrapper.id]
    const after = completeParity(f.doc, ids, ui => operation === 'wrap' ? ui.group() : ui.ungroup(), operation === 'wrap' ? 'node.group' : 'node.ungroup', ui => ({ ids, ...(operation === 'wrap' ? { id: ui.state.selection[0] } : {}) }))
    worldMatrix(after, f.a.id).forEach((v, i) => expect(v).toBeCloseTo(worldMatrix(f.doc, f.a.id)[i], 8))
    expect(after.nodes[f.a.id].width).toBe(f.a.width); expect(after.nodes[f.a.id].height).toBe(f.a.height)
    expect(after.nodes[f.a.id].fills).toEqual(f.a.fills); expect(after.nodes[f.a.id].opacity).toBe(.6)
    expect(after.nodes[f.a.id].constraints).toMatchObject({ horizontal: anchor, vertical: anchor })
  })


test('already-aligned real instance roots explicitly return unchanged without history', () => {
  const f = actualInstanceFixture()
  completeParity(f.doc, [f.id, f.outside], ui => ui.align('y', 'end'), 'node.align', () => ({ ids: [f.id, f.outside], axis: 'y', mode: 'end' }), false)
})
