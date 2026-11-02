import { afterEach, expect, test } from 'vitest'
import { Editor } from '../engine'
import { blank, node, uid, defaultLayout, type DesignDocument, type Matrix } from '../model'
import { around, multiply, rotate, translate, worldMatrix } from '../geometry'
import { createDesignAutomation } from '../automation/core'
import { registerPendingEdit } from '../pending-edits'
import { componentFixture } from '../component-fixtures'
import { createClip } from '../animation'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach(e => e.dispose()))
function editor(doc: DesignDocument) { const e = new Editor(doc); editors.push(e); return e }
function fixture() {
  const doc = blank(), frame = node('frame', 100, 50, 300, 200), a = node('rectangle', 10, 20, 30, 40), b = node('ellipse', 80, 20, 20, 20)
  frame.transform = [-1.2, .1, .2, .9, 100, 50]
  doc.nodes = Object.fromEntries([frame, a, b].map(n => [n.id, n])); frame.children = [a.id, b.id]; doc.pages[0].children = [frame.id]
  return { doc, frame, a, b }
}
function apiFor(e: Editor, denied = false) {
  const api = createDesignAutomation(e, [], [], denied ? { grants: [] } : undefined)
  const call = (method: string, params = {}) => api.execute({ method, params, expectedRevision: e.state.version,
    documentId: e.state.doc.id, session: e.sessionGeneration })
  const duplicate = (ids: string[], params = {}) => {
    const response = call('node.duplicate', { ids, ...params }); expect(response.ok, JSON.stringify(response)).toBe(true)
    if (!response.ok) throw Error(response.error.message)
    return (response.result as { operations: { result: { ids: string[] } }[] }).operations[0].result.ids
  }
  return { api, call, duplicate }
}
const close = (actual: Matrix, expected: Matrix) => actual.forEach((n, i) => expect(n).toBeCloseTo(expected[i], 9))

test.each([{ offsetX: 50, offsetY: 0, x: 50, y: 0 }, { offsetX: 0, x: 0, y: 24 }, { offsetY: -7, x: 24, y: -7 }])('explicit offsets preserve established world-space behavior: %j', value => {
  const { doc, a } = fixture(), e = editor(doc), { x, y, ...offsets } = value, before = worldMatrix(e.state.doc, a.id)
  const [copy] = apiFor(e).duplicate([a.id], offsets)
  close(worldMatrix(e.state.doc, copy), multiply(translate(x, y), before)); expect(e.state.selection).toEqual([copy])
})
test.each(['ui-to-mcp', 'mcp-to-ui'] as const)('%s shares one Editor-owned translation/rotation repeat', route => {
  const { doc, a } = fixture(), e = editor(doc), api = apiFor(e); e.select([a.id])
  if (route === 'ui-to-mcp') e.duplicate(); else api.duplicate([a.id])
  const copy = e.state.selection[0], first = worldMatrix(e.state.doc, copy), delta = around({ x: 30, y: 40 }, rotate(20))
  e.transformSelection(delta)
  if (route === 'ui-to-mcp') api.duplicate([copy]); else e.duplicate()
  close(worldMatrix(e.state.doc, e.state.selection[0]), multiply(delta, multiply(translate(10, 10), multiply(delta, first))))
})
test('ten-pixel repetition remains exact under reflected affine parents', () => {
  const { doc, a } = fixture(), e = editor(doc), api = apiFor(e)
  let id = a.id, previous = worldMatrix(e.state.doc, a.id)
  for (let i = 0; i < 12; i++) {
    [id] = api.duplicate([id])
    const next = worldMatrix(e.state.doc, id)
    expect(next[4] - previous[4]).toBeCloseTo(10, 8)
    expect(next[5] - previous[5]).toBeCloseTo(10, 8)
    previous = next
  }
})
test('non-transform edit, Undo/Redo and same-ID load invalidate repeat', () => {
  for (const reset of ['edit', 'undo-redo', 'load'] as const) {
    const { doc, a, b } = fixture(), e = editor(doc); e.select([a.id]); e.duplicate(); e.transformSelection(translate(30, 0))
    const id = e.state.selection[0]
    if (reset === 'edit') e.update([b.id], { name: 'unrelated edit invalidates repeat' })
    else if (reset === 'undo-redo') { e.undo(); e.redo(); e.select([id]) }
    else { e.load(structuredClone(e.state.doc)); e.select([id]) }
    expect(e.duplicationRepeat()).toBeNull()
    const before = worldMatrix(e.state.doc, id); e.duplicate()
    const stepped = worldMatrix(e.state.doc, e.state.selection[0])
    expect(stepped[4] - before[4]).toBeCloseTo(10, 8)
    expect(stepped[5] - before[5]).toBeCloseTo(10, 8)
  }
})
test('pending input commits before duplicate captures its source; invalid input blocks atomically', () => {
  const { doc, a } = fixture(), e = editor(doc); e.select([a.id]); let dirty = true
  const release = registerPendingEdit(e, { dirty: () => dirty, commit: () => { dirty = false; e.update([a.id], { name: 'settled source' }); return true } })
  e.duplicate(); release(); expect(e.state.doc.nodes[e.state.selection[0]].name).toBe('settled source')
  const before = e.state.doc, version = e.state.version
  const blocked = registerPendingEdit(e, { dirty: () => true, commit: () => false }); e.duplicate(); blocked()
  expect(e.state.doc).toBe(before); expect(e.state.version).toBe(version)
})
test('mixed locked selection rejects in both routes without partial copies or history', () => {
  const { doc, a, b } = fixture(); doc.nodes[b.id].locked = true
  for (const route of ['ui', 'mcp']) {
    const e = editor(doc), before = e.state.doc; e.select([a.id, b.id])
    if (route === 'ui') expect(e.duplicate()).toMatchObject({ status: 'rejected', code: 'locked_node' })
    else expect(apiFor(e).call('node.duplicate', { ids: [a.id, b.id] })).toMatchObject({ ok: false, error: { code: 'locked_node' } })
    expect(e.state.doc).toBe(before); expect(e.canUndo).toBe(false)
  }
})
test('method permissions and malformed requests cannot duplicate or publish repeat state', () => {
  const { doc, a } = fixture(), e = editor(doc), before = e.state.doc
  expect(apiFor(e, true).call('node.duplicate', { ids: [a.id] })).toMatchObject({ ok: false, error: { code: 'permission_denied' } })
  expect(apiFor(e).call('node.duplicate', { ids: [a.id], index: 0 })).toMatchObject({ ok: false, error: { code: 'invalid_params' } })
  expect(e.state.doc).toBe(before); expect(e.duplicationRepeat()).toBeNull(); expect(e.canUndo).toBe(false)
})
test('implicit repeat rejects multi-operation batches atomically; explicit offsets do not consume repeat', () => {
  const { doc, a, b } = fixture(), e = editor(doc), api = apiFor(e); const [id] = api.duplicate([a.id]); e.transformSelection(translate(30, 0))
  const before = e.state.doc, version = e.state.version
  const response = api.call('batch.apply', { operations: [{ method: 'node.update', params: { ids: [b.id], patch: { name: 'must roll back' } } },
    { method: 'node.duplicate', params: { ids: [id] } }] })
  expect(response).toMatchObject({ ok: false, error: { code: 'unsupported_duplicate_repeat_batch' } })
  expect(e.state.doc).toBe(before); expect(e.state.version).toBe(version)
  const at = worldMatrix(e.state.doc, id), [copy] = api.duplicate([id], { offsetX: 0, offsetY: 0 })
  expect(worldMatrix(e.state.doc, copy)).toEqual(at)
})
test('derived batch duplication fails closed with no earlier resize left behind', () => {
  const { doc, frame, a } = fixture(); doc.nodes[a.id].constraints = { horizontal: 'end', vertical: 'start', referenceWidth: 300, referenceHeight: 200 }
  const e = editor(doc), before = e.state.doc
  expect(apiFor(e).call('batch.apply', { operations: [{ method: 'node.update', params: { ids: [frame.id], patch: { width: 400 } } },
    { method: 'node.duplicate', params: { ids: [a.id], offsetX: 24, offsetY: 0 } }] })).toMatchObject({ ok: false, error: { code: 'unsupported_derived_batch_geometry' } })
  expect(e.state.doc).toBe(before); expect(e.canUndo).toBe(false)
})
test('actual pointer commit receipt seeds repeat; copied, JSON and foreign results fail closed', () => {
  const { doc, a } = fixture(), e = editor(doc); e.select([a.id]); e.begin('drag copy')
  const [copy] = e.moveDuplication(true, [a.id]), reference = worldMatrix(e.state.doc, copy)
  e.preview({ [copy]: { transform: multiply(translate(10, 0), e.state.doc.nodes[copy].transform) } })
  const result = e.commit(); expect(result).toMatchObject({ status: 'committed' })
  expect(e.rememberDuplication({ ...result }, [copy], new Map([[copy, reference]]))).toBe(false)
  expect(e.rememberDuplication(JSON.parse(JSON.stringify(result)), [copy], new Map([[copy, reference]]))).toBe(false)
  expect(editor(doc).rememberDuplication(result, [copy], new Map([[copy, reference]]))).toBe(false)
  expect(e.rememberDuplication(result, [copy], new Map([[copy, reference]]))).toBe(true)
})
test('native complete instances duplicate but instance internals are rejected consistently', () => {
  const { doc, ids } = componentFixture()
  for (const route of ['ui', 'mcp']) {
    const e = editor(doc); e.select([ids.a])
    if (route === 'ui') e.duplicate(); else apiFor(e).duplicate([ids.a])
    expect(e.state.doc.nodes[e.state.selection[0]].instance?.componentId).toBe(ids.button)
    const internal = e.state.doc.nodes[ids.a].children[0], before = e.state.doc; e.select([internal])
    if (route === 'ui') expect(e.duplicate()).toMatchObject({ status: 'rejected', code: 'instance_structure' })
    else expect(apiFor(e).call('node.duplicate', { ids: [internal] })).toMatchObject({ ok: false, error: { code: 'instance_structure' } })
    expect(e.state.doc).toBe(before)
  }
})

test.each(['source-page', 'destination-page'] as const)('legitimate non-active %s publication seeds repeat for its actual owner page', route => {
  const { doc, a, frame } = fixture(), second = { ...doc.pages[0], id: uid(), name: 'Second', children: [] as string[] }
  if (route === 'source-page') { second.children = [frame.id]; doc.pages[0].children = [] }
  doc.pages.push(second)
  const e = editor(doc), api = apiFor(e), [copy] = api.duplicate([a.id], route === 'destination-page' ? { parentId: second.id } : {})
  expect(e.state.page).toBe(second.id); expect(e.duplicationRepeat()?.roots).toEqual([copy])
  e.transformSelection(translate(30, 5)); const current = worldMatrix(e.state.doc, copy), [next] = api.duplicate([copy])
  close(worldMatrix(e.state.doc, next), multiply(translate(40, 15), current))
})

test.each([{ transform: [2, 0, 0, 2, 0, 0] as Matrix }, { transform: [1, 0, .2, 1, 0, 0] as Matrix }])('scale/skew invalidates unsupported repeat rather than inferring another affine command: %j', ({ transform }) => {
  const { doc, a } = fixture(), e = editor(doc); e.select([a.id]); e.duplicate(); e.transformSelection(transform)
  expect(e.duplicationRepeat()).toBeNull()
  const current = worldMatrix(e.state.doc, e.state.selection[0]); e.duplicate()
  close(worldMatrix(e.state.doc, e.state.selection[0]), multiply(translate(10, 10), current))
})
test('selection-publication exceptions report the accepted mutation and do not publish a repeat seed', () => {
  const { doc, a } = fixture(), e = editor(doc), before = e.state.doc, api = apiFor(e); let fired = false
  const release = e.subscribe(() => {
    if (!fired && e.state.version === 1 && e.state.selection.length) { fired = true; throw Error('selection publication fixture') }
  })
  const response = api.call('node.duplicate', { ids: [a.id] }); release()
  expect(response).toMatchObject({ ok: false, error: { details: { committed: true, retry: 'do-not-retry' } } })
  expect(e.state.version).toBe(1); expect(Object.keys(e.state.doc.nodes)).toHaveLength(Object.keys(before.nodes).length + 1)
  expect(e.duplicationRepeat()).toBeNull(); e.undo(); expect(e.state.doc).toEqual(before)
})
test('pointer receipt cannot seed a same-ID reopened owner even when duplicate IDs survive', () => {
  const { doc, a } = fixture(), e = editor(doc); e.select([a.id]); e.begin('drag copy')
  const [copy] = e.moveDuplication(true, [a.id]), reference = worldMatrix(e.state.doc, copy), session = e.sessionGeneration
  let loaded = false
  const release = e.subscribe(() => { if (!loaded && e.state.version === 1) { loaded = true; e.load(structuredClone(e.state.doc)) } })
  const result = e.commit(); release()
  expect(loaded).toBe(true); expect(e.committedEditReceipt(result)?.session).toBe(session)
  expect(e.sessionGeneration).not.toBe(session); expect(e.state.doc.nodes[copy]).toBeDefined()
  expect(e.rememberDuplication(result, [copy], new Map([[copy, reference]]))).toBe(false); expect(e.duplicationRepeat()).toBeNull()
})

test('mutable MCP duplication preserves source prototype/animation snapshots and remaps copied targets', () => {
  const { doc, a, b } = fixture(); doc.schemaVersion = 4
  doc.prototype = { interactions: { [a.id]: [{ trigger: 'click', actions: [{ kind: 'navigate', target: b.id, durationMs: 0 }] }] } }
  doc.animations = [createClip(doc, doc.pages[0].id, [a.id])]
  const e = editor(doc), before = e.state.doc, [first, second] = apiFor(e).duplicate([a.id, b.id])
  const content = e.state.doc.nodes[first].kind === 'group' ? e.state.doc.nodes[first].children[0] : first
  expect(e.state.doc.prototype?.interactions[content][0].actions[0].target).toBe(second)
  expect(e.state.doc.prototype?.interactions[a.id]).toEqual(before.prototype?.interactions[a.id])
  expect(e.state.doc.animations).toHaveLength(1)
  expect(e.state.doc.animations?.[0].tracks.filter(track => track.nodeId === content)).toHaveLength(1)
  expect(before.animations?.[0].tracks.some(track => track.nodeId === content)).toBe(false)
  expect(e.state.doc.nodes[a.id]).toEqual(before.nodes[a.id]); e.undo(); expect(e.state.doc).toEqual(before)
})


test('derived destination geometry rejects the entire batch before publishing copies', () => {
  const { doc, a } = fixture(), destination = node('frame', 500, 0, 100, 100)
  destination.layout = { ...defaultLayout(), mode: 'horizontal' }
  doc.nodes[destination.id] = destination; doc.pages[0].children.push(destination.id)
  const e = editor(doc), before = e.state.doc
  expect(apiFor(e).call('batch.apply', { operations: [
    { method: 'node.update', params: { ids: [destination.id], patch: { width: 200 } } },
    { method: 'node.duplicate', params: { ids: [a.id], parentId: destination.id, offsetX: 0, offsetY: 0 } },
  ] })).toMatchObject({ ok: false, error: { code: 'unsupported_derived_batch_geometry' } })
  expect(e.state.doc).toBe(before); expect(e.canUndo).toBe(false)
})
test('UI/MCP ordinary duplicate authored graph, child order and style are completely equal modulo generated IDs', () => {
  const { doc, a } = fixture(), ui = editor(doc), mcp = editor(doc)
  ui.select([a.id]); mcp.select([a.id]); ui.duplicate(); const [copy] = apiFor(mcp).duplicate([a.id])
  const remapped = JSON.parse(JSON.stringify(ui.state.doc).replaceAll(ui.state.selection[0], copy))
  expect(mcp.state.doc).toEqual(remapped)
})
