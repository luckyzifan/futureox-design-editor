import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '../engine'
import { blank, defaultLayout, defaultSizing, defaultTextStyle, node, paint, stroke, type DesignDocument, type TextRun } from '../model'
import { Graph } from '../kernel/graph'
import * as Picking from '../kernel/picking'
import { createEditorDesignAutomation } from './index'
import { createDesignAutomation } from './core'
import { designSystemExtensions } from './design-system'
import { stampKeys } from '../components'
import { CHANGE_SUMMARY_LIMITS, summarizeChanges } from './change-summary'
import type { AutomationResponse } from './types'

const editors: Editor[] = []
afterEach(() => { editors.splice(0).forEach(editor => editor.dispose()); vi.restoreAllMocks() })
function fixture(document?: DesignDocument) {
  const d = document || blank('Small changes'), frame = node('frame', 10, 20, 400, 300), rectangle = node('rectangle', 7, 9, 100, 50), text = node('text', 20, 30, 300, 80)
  frame.layout = { ...defaultLayout(), mode: 'none', gap: 17, padding: [10, 20, 30, 40] }
  frame.sizing = defaultSizing()
  rectangle.radii = [1, 2, 3, 4]; rectangle.fills.push(paint('#00ff00')); rectangle.strokes.push(stroke('#0000ff', 7))
  text.text = 'A👩‍💻éZ'; text.textStyle = defaultTextStyle(); text.textRuns = [{ start: 0, end: 9, weight: 700, color: '#ff0000' }]
  for (const n of [frame, rectangle, text]) d.nodes[n.id] = n
  frame.children.push(rectangle.id); d.pages[0].children.push(frame.id, text.id); d.schemaVersion = 4
  const editor = new Editor(d); editors.push(editor)
  const api = createEditorDesignAutomation(editor)
  const fence = () => ({ documentId: editor.state.doc.id, session: editor.sessionGeneration, expectedRevision: editor.state.version })
  const call = (method: string, params: Record<string, unknown> = {}) => api.execute({ method, params, ...fence() })
  return { editor, api, frame, rectangle, text, call, fence }
}
function ok(response: AutomationResponse): Record<string, any> {
  expect(response.ok, JSON.stringify(response)).toBe(true)
  if (!response.ok) throw Error(response.error.message)
  return response.result as Record<string, any>
}
function rejected(response: AutomationResponse, code: string) {
  expect(response).toMatchObject({ ok: false, error: { code } })
}
const op = (method: string, params: Record<string, unknown>) => ({ method, params })
function richFixture(text: string, textRuns?: TextRun[]) {
  const document = blank('Explicit range edits'), target = node('text', 0, 0, 300, 80)
  target.text = text; if (textRuns) target.textRuns = textRuns
  document.schemaVersion = 15; document.nodes[target.id] = target; document.pages[0].children.push(target.id)
  return { ...fixture(document), target }
}

describe('explicit text replacement through native Editor transactions', () => {
  it('deletes the intended repeated substring and preserves all other document paths, then undoes once', () => {
    const f = richFixture('aaaa', [100, 200, 300, 400].map((weight, start) => ({ start, end: start + 1, weight }))), before = f.editor.state.doc
    const result = ok(f.call('text.replaceRange', { nodeId: f.target.id, start: 0, end: 1, text: '', expectedText: 'a' }))
    const expected = structuredClone(before)
    expected.nodes[f.target.id].text = 'aaa'
    expected.nodes[f.target.id].textRuns = [200, 300, 400].map((weight, start) => ({ start, end: start + 1, weight }))
    expect(f.editor.state.doc).toEqual(expected)
    expect(result.changedPaths.every((path: string) => path === `/nodes/${f.target.id}/text` || path.startsWith(`/nodes/${f.target.id}/textRuns/`))).toBe(true)
    ok(f.call('history.undo')); expect(f.editor.state.doc).toEqual(before); expect(f.editor.canUndo).toBe(false)
    ok(f.call('history.redo')); expect(f.editor.state.doc).toEqual(expected)
  })
  it('preserves mixed outside attributes, defines boundary insertion inheritance, and keeps identical replacement a no-op', () => {
    const f = richFixture('abcdef', [{ start: 0, end: 2, weight: 700, underline: true }, { start: 2, end: 4, color: '#123456' }, { start: 4, end: 6, link: 'https://example.com' }])
    const before = f.editor.state.doc, revision = f.editor.state.version
    expect(ok(f.call('text.replaceRange', { nodeId: f.target.id, start: 1, end: 5, text: 'bcde', expectedText: 'bcde' })).noChange).toBe(true)
    expect(f.editor.state.doc).toBe(before); expect(f.editor.state.version).toBe(revision); expect(f.editor.canUndo).toBe(false)
    ok(f.call('text.replaceRange', { nodeId: f.target.id, start: 2, end: 2, text: 'XY', expectedText: '' }))
    expect(f.editor.state.doc.nodes[f.target.id].textRuns).toEqual([
      { start: 0, end: 2, weight: 700, underline: true }, { start: 2, end: 4, color: '#123456' },
      { start: 4, end: 6, color: '#123456' }, { start: 6, end: 8, link: 'https://example.com' },
    ])
    ok(f.call('history.undo')); expect(f.editor.state.doc).toEqual(before)
    ok(f.call('text.replaceRange', { nodeId: f.target.id, start: 1, end: 5, text: '👩‍💻', expectedText: 'bcde' }))
    expect(f.editor.state.doc.nodes[f.target.id].text).toBe('a👩‍💻f')
    expect(f.editor.state.doc.nodes[f.target.id].textRuns).toEqual([
      { start: 0, end: 1, weight: 700, underline: true }, { start: 1, end: 6, weight: 700, underline: true }, { start: 6, end: 7, link: 'https://example.com' },
    ])
  })
  it('rejects conflicting text, missing guards, malformed UTF-16, grapheme joins and unsafe batches before publication', () => {
    const f = richFixture('ex'), before = f.editor.state.doc
    const base = { nodeId: f.target.id, start: 1, end: 1, text: 'x', expectedText: '' }
    rejected(f.call('text.replaceRange', { ...base, expectedText: 'wrong' }), 'value_conflict')
    const { expectedText: _expectedText, ...unguarded } = base
    rejected(f.call('text.replaceRange', unguarded), 'invalid_params')
    for (const params of [{ text: '\u0301' }, { text: '\ud800' }, { start: 2, end: 1 }, { start: 3, end: 3 }, { text: 'x'.repeat(100000) }])
      rejected(f.call('text.replaceRange', { ...base, ...params }), 'invalid_text_range')
    rejected(f.call('text.replaceRange', { ...base, constructor: 1 }), 'invalid_request')
    rejected(f.call('text.replaceRange', { ...base, nodeId: f.rectangle.id }), 'invalid_kind')
    rejected(f.call('batch.apply', { operations: [op('node.patch', { ids: [f.rectangle.id], patch: { name: 'Must roll back' } }), op('text.replaceRange', { ...base, text: '\u0301' })] }), 'invalid_text_range')
    expect(f.editor.state.doc).toBe(before); expect(f.editor.canUndo).toBe(false)
    for (const [text, start, end, selected, inserted] of [['👩‍💻', 0, 2, '👩', 'x'], ['👩💻', 2, 2, '', '\u200d'], ['🇦x🇧', 2, 3, 'x', '']] as const) {
      const g = richFixture(text), original = g.editor.state.doc
      rejected(g.call('text.replaceRange', { nodeId: g.target.id, start, end, text: inserted, expectedText: selected }), 'invalid_text_range')
      expect(g.editor.state.doc).toBe(original)
    }
    ok(f.call('node.patch', { ids: [f.target.id], patch: { locked: true } }))
    rejected(f.call('text.replaceRange', base), 'locked_node')
  })
  it('stages replacement without kernel calls, preserves fences, and replays one atomic commit even after undo', () => {
    const f = richFixture('ab', [{ start: 0, end: 2, weight: 700 }]), before = f.editor.state.doc, state = { ...f.editor.state }, epoch = Picking.pickingGeometryEpoch()
    const change = vi.spyOn(f.editor, 'change'), layout = vi.spyOn(Picking, 'kernelLayout'), graph = vi.spyOn(Graph.prototype, 'applyOps'), fonts = vi.spyOn(Picking, 'activateDocumentFonts')
    const operations = [op('text.replaceRange', { nodeId: f.target.id, start: 1, end: 2, text: 'XY', expectedText: 'b' })]
    const staged = ok(f.call('batch.preflight', { operations }))
    expect(staged).toMatchObject({ derivedResolution: 'deferred', authoritativeCommitValidationRequired: true, receiptConsumed: false })
    expect(f.editor.state).toEqual(state); expect(Picking.pickingGeometryEpoch()).toBe(epoch)
    for (const spy of [change, layout, graph, fonts]) expect(spy).not.toHaveBeenCalled()
    const request = { method: 'batch.apply', ...f.fence(), params: { operations, mutationId: 'text-range' } }
    expect(ok(f.api.execute(request)).receipt.replayed).toBe(false); expect(change).toHaveBeenCalledTimes(1)
    rejected(f.api.execute({ ...request, method: 'text.replaceRange', params: operations[0].params }), 'stale_revision')
    expect(ok(f.api.execute(request)).receipt.replayed).toBe(true); expect(change).toHaveBeenCalledTimes(1)
    ok(f.call('history.undo')); expect(f.editor.state.doc).toEqual(before)
    expect(ok(f.api.execute(request)).receipt.replayed).toBe(true); expect(f.editor.state.doc).toEqual(before)
  })
  it('captures native text and run overrides while unrelated main fields continue to propagate', () => {
    const f = richFixture('aaaa', [{ start: 0, end: 2, weight: 700 }, { start: 2, end: 4, underline: true }])
    const main = ok(f.call('component.create', { nodeIds: [f.target.id] })).operations[0].result.id
    const instance = ok(f.call('component.instantiate', { componentId: main, x: 500, y: 0 })).operations[0].result.id
    const child = f.editor.state.doc.nodes[instance].children[0], before = f.editor.state.doc
    ok(f.call('text.replaceRange', { nodeId: child, start: 0, end: 1, text: 'XY', expectedText: 'a' }))
    const changed = f.editor.state.doc, key = changed.nodes[child].instanceOrigin!.key
    expect(changed.nodes[instance].instance!.overrides[key].text).toBe('XYaaa')
    expect(changed.nodes[instance].instance!.overrides[key].textRuns).toEqual(changed.nodes[child].textRuns)
    expect(changed.nodes[f.target.id]).toEqual(before.nodes[f.target.id])
    ok(f.call('node.patch', { ids: [f.target.id], patch: { opacity: .4 } }))
    expect(f.editor.state.doc.nodes[child]).toMatchObject({ text: 'XYaaa', opacity: .4 })
  })
})

describe('granular edits through the actual Editor and native WASM history', () => {
  it('changes exactly the requested transform/corner leaves and keeps node identities, paint stacks and unrelated nodes', () => {
    const f = fixture(), before = f.editor.state.doc
    const result = ok(f.call('node.patch', { ids: [f.rectangle.id], patch: { transform: { x: 12 }, radii: { topRight: 8 } }, expected: { transform: { x: 7 }, radii: { topRight: 2 } } }))
    const after = f.editor.state.doc, expected = structuredClone(before)
    expected.nodes[f.rectangle.id].transform[4] = 12; expected.nodes[f.rectangle.id].radii[1] = 8
    expect(after).toEqual(expected)
    expect(after.nodes[f.text.id]).toBe(before.nodes[f.text.id])
    expect(result.changedPaths.sort()).toEqual([`/nodes/${f.rectangle.id}/radii/1`, `/nodes/${f.rectangle.id}/transform/4`].sort())
    expect(result.changes).toContainEqual({ path: `/nodes/${f.rectangle.id}/radii/1`, kind: 'replace', before: 2, after: 8 })
    ok(f.call('history.undo')); expect(f.editor.state.doc).toEqual(before); expect(f.editor.canUndo).toBe(false)
    ok(f.call('history.redo')); expect(f.editor.state.doc).toEqual(after)
  })
  it('patches only one padding side, one gap and one stable-ID paint', () => {
    const f = fixture(), before = f.editor.state.doc, id = before.nodes[f.rectangle.id].fills[1].id
    const result = ok(f.call('batch.apply', { operations: [
      op('layout.patch', { ids: [f.frame.id], patch: { layout: { gap: 22, padding: { right: 25 } } } }),
      op('paint.patch', { ids: [f.rectangle.id], target: 'fill', paintId: id, patch: { color: '#112233' }, expected: { color: '#00ff00' } }),
    ] }))
    const expected = structuredClone(before); expected.nodes[f.frame.id].layout!.gap = 22; expected.nodes[f.frame.id].layout!.padding[1] = 25; expected.nodes[f.rectangle.id].fills[1].color = '#112233'
    expect(f.editor.state.doc).toEqual(expected)
    expect(result.changedPaths.sort()).toEqual([`/nodes/${f.frame.id}/layout/gap`, `/nodes/${f.frame.id}/layout/padding/1`, `/nodes/${f.rectangle.id}/fills/1/color`].sort())
    expect(f.editor.state.doc.nodes[f.rectangle.id].fills[0]).toEqual(before.nodes[f.rectangle.id].fills[0])
    ok(f.call('history.undo')); expect(f.editor.state.doc).toEqual(before); expect(f.editor.canUndo).toBe(false)
  })
  it('lets real layout resolve dependent positions and includes those changes in the committed diff', () => {
    const f = fixture()
    ok(f.call('layout.set', { ids: [f.frame.id], layout: { mode: 'vertical' } }))
    const before = f.editor.state.doc
    const staged = ok(f.call('batch.preflight', { operations: [op('layout.patch', { ids: [f.frame.id], patch: { layout: { padding: { top: 24 } } } })] }))
    expect(staged.changedPaths).toEqual([`/nodes/${f.frame.id}/layout/padding/0`])
    expect(staged.derivedResolution).toBe('deferred')
    const applied = ok(f.call('layout.patch', { ids: [f.frame.id], patch: { layout: { padding: { top: 24 } } } }))
    expect(f.editor.state.doc.nodes[f.rectangle.id].transform[5]).not.toBe(before.nodes[f.rectangle.id].transform[5])
    expect(applied.changedPaths).toContain(`/nodes/${f.rectangle.id}/transform/5`)
    rejected(f.call('node.patch', { ids: [f.rectangle.id], patch: { transform: { x: 55 } } }), 'auto_layout_position')
  })
  it('styles a complete emoji grapheme and preserves text and every outside run attribute', () => {
    const f = fixture(), before = f.editor.state.doc
    ok(f.call('text.styleRange', { nodeId: f.text.id, start: 1, end: 6, patch: { color: '#0000ff', underline: true }, expectedText: '👩‍💻' }))
    const text = f.editor.state.doc.nodes[f.text.id]
    expect(text.text).toBe(before.nodes[f.text.id].text)
    expect(text.textRuns).toEqual([
      { start: 0, end: 1, color: '#ff0000', weight: 700 },
      { start: 1, end: 6, color: '#0000ff', weight: 700, underline: true },
      { start: 6, end: 9, color: '#ff0000', weight: 700 },
    ])
    expect(text.fills).toEqual(before.nodes[f.text.id].fills)
    for (const [start, end] of [[1, 2], [1, 3], [3, 6], [6, 7], [6, 6], [0, 20]])
      rejected(f.call('text.styleRange', { nodeId: f.text.id, start, end, patch: { weight: 500 } }), 'invalid_text_range')
    rejected(f.call('text.styleRange', { nodeId: f.text.id, start: 1, end: 6, patch: { weight: 500 }, expectedText: 'other' }), 'value_conflict')
    rejected(f.call('text.styleRange', { nodeId: f.text.id, start: 1, end: 6, patch: { link: 'javascript:alert(1)' } }), 'unsafe_url')
    expect(f.editor.state.doc.nodes[f.text.id]).toEqual(text)
  })
  it('rejects unsafe/unknown/structural paths, nonfinite data, missing facets and stale expected leaves atomically', () => {
    const f = fixture(), before = f.editor.state.doc
    for (const patch of [{ id: 'new' }, { parentId: f.frame.id }, { children: [] }, { radii: { unknown: 2 } }, { transform: { constructor: 1 } }, { layout: { prototype: {} } }, {}, { radii: {} }, { toString: 42 }, { valueOf: 42 }, { hasOwnProperty: 42 }, { __defineGetter__: 42 }, { transform: { toString: 42 } }, { layout: { toString: 42 } }])
      expect(f.call('node.patch', { ids: [f.rectangle.id], patch }).ok).toBe(false)
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const patch = JSON.parse(`{"transform":{"${key}":1}}`)
      expect(f.call('node.patch', { ids: [f.rectangle.id], patch }).ok).toBe(false)
    }
    rejected(f.call('node.patch', { ids: [f.rectangle.id], patch: { width: Infinity } }), 'invalid_request')
    rejected(f.call('node.patch', { ids: [f.rectangle.id], patch: { width: -1 } }), 'invalid_params')
    rejected(f.call('layout.patch', { ids: [f.rectangle.id], patch: { layout: { gap: 20 } } }), 'missing_facet')
    rejected(f.call('batch.apply', { operations: [op('node.patch', { ids: [f.rectangle.id], patch: { name: 'Will roll back' } }), op('node.patch', { ids: [f.rectangle.id], patch: { opacity: .5 }, expected: { opacity: .2 } })] }), 'value_conflict')
    expect(f.editor.state.doc).toBe(before); expect(f.editor.canUndo).toBe(false)
    ok(f.call('node.patch', { ids: [f.frame.id], patch: { locked: true } }))
    rejected(f.call('paint.patch', { ids: [f.rectangle.id], target: 'fill', paintId: f.rectangle.fills[0].id, patch: { color: '#ffffff' } }), 'locked_node')
  })
  it('rejects unsupported per-kind leaves while retaining valid gradient and shape controls', () => {
    const f = fixture(), before = f.editor.state.doc, paintId = before.nodes[f.rectangle.id].fills[0].id
    for (const patch of [{ fit: 'contain' }, { angle: 20 }, { transform: { x: 1 } }])
      rejected(f.call('paint.patch', { ids: [f.rectangle.id], target: 'fill', paintId, patch }), 'invalid_kind')
    for (const patch of [{ points: 5 }, { innerRadius: .2 }, { cornerRadius: 4 }])
      rejected(f.call('node.patch', { ids: [f.rectangle.id], patch }), 'invalid_kind')
    expect(f.editor.state.doc).toBe(before)
    const star = ok(f.call('node.create', { kind: 'star' })).operations[0].result.id
    ok(f.call('node.patch', { ids: [star], patch: { points: 6, innerRadius: .3, cornerRadius: 2 } }))
    const gradient = paint('#223344', 'linear'); gradient.transform = [1, 0, 0, 1, 0, 0]
    ok(f.call('style.set', { ids: [f.rectangle.id], fills: [gradient] }))
    ok(f.call('paint.patch', { ids: [f.rectangle.id], target: 'fill', paintId: gradient.id, patch: { angle: 45, transform: { x: .2 } } }))
    expect(f.editor.state.doc.nodes[f.rectangle.id].fills[0]).toMatchObject({ angle: 45, transform: [1, 0, 0, 1, .2, 0] })
  })
  it('uses the native component override capture and still propagates unrelated main changes', () => {
    const f = fixture()
    const main = ok(f.call('component.create', { nodeIds: [f.rectangle.id] })).operations[0].result.id
    const instance = ok(f.call('component.instantiate', { componentId: main, x: 500, y: 0 })).operations[0].result.id
    const child = f.editor.state.doc.nodes[instance].children[0], before = f.editor.state.doc
    ok(f.call('node.patch', { ids: [child], patch: { radii: { topRight: 19 } }, expected: { radii: { topRight: 2 } } }))
    const after = f.editor.state.doc, origin = after.nodes[child].instanceOrigin!
    expect(after.nodes[instance].instance!.overrides[origin.key].radii).toEqual([1, 19, 3, 4])
    expect(after.nodes[f.rectangle.id]).toEqual(before.nodes[f.rectangle.id])
    ok(f.call('node.patch', { ids: [f.rectangle.id], patch: { opacity: .4 } }))
    expect(f.editor.state.doc.nodes[child].opacity).toBe(.4)
    expect(f.editor.state.doc.nodes[child].radii).toEqual([1, 19, 3, 4])
  })
  it('rejects stroke paints controlled by a shared full paint style in apply and authored preflight', () => {
    const f = fixture(), sharedStroke = stroke('#334455', 4)
    const style = ok(f.call('style.create', { name: 'Full paint', kind: 'paint', value: [paint('#ffffff')], strokes: [sharedStroke] })).operations[0].result.id
    ok(f.call('style.apply', { nodeId: f.rectangle.id, field: 'fills', styleId: style }))
    const before = f.editor.state.doc, params = { ids: [f.rectangle.id], target: 'stroke', paintId: before.nodes[f.rectangle.id].strokes[0].paint.id, patch: { color: '#123456' } }
    rejected(f.call('paint.patch', params), 'shared_style_property')
    rejected(f.call('batch.preflight', { operations: [op('paint.patch', params)] }), 'shared_style_property')
    expect(f.editor.state.doc).toBe(before)
  })
  it('keeps unrelated stroke paints editable when a shared fill style has an empty stroke stack', () => {
    const f = fixture()
    const style = ok(f.call('style.create', { name: 'Fill only', kind: 'paint', value: [paint('#ffffff')], strokes: [] })).operations[0].result.id
    ok(f.call('style.apply', { nodeId: f.rectangle.id, field: 'fills', styleId: style }))
    const before = f.editor.state.doc, paintId = before.nodes[f.rectangle.id].strokes[0].paint.id
    ok(f.call('paint.patch', { ids: [f.rectangle.id], target: 'stroke', paintId, patch: { opacity: .4 } }))
    expect(f.editor.state.doc.nodes[f.rectangle.id].strokes[0].paint.opacity).toBe(.4)
    expect(f.editor.state.doc.nodes[f.rectangle.id].fills).toEqual(before.nodes[f.rectangle.id].fills)
  })
  it('keeps existing variable binding tools and requires explicit unbind before scalar edits', () => {
    const f = fixture()
    const collection = ok(f.call('collection.create', { name: 'Spacing', modes: ['Base'] })).operations[0].result.id
    const variable = ok(f.call('variable.create', { collectionId: collection, name: 'Gap', kind: 'number', values: { Base: 32 } })).operations[0].result.id
    ok(f.call('variable.bind', { nodeId: f.frame.id, path: 'layout.gap', variableId: variable }))
    const before = f.editor.state.doc
    rejected(f.call('layout.patch', { ids: [f.frame.id], patch: { layout: { gap: 40 } } }), 'bound_property')
    expect(f.editor.state.doc).toBe(before)
    ok(f.call('batch.apply', { operations: [op('variable.unbind', { nodeId: f.frame.id, path: 'layout.gap' }), op('layout.patch', { ids: [f.frame.id], patch: { layout: { gap: 40 } } })] }))
    expect(f.editor.state.doc.nodes[f.frame.id].layout!.gap).toBe(40)
  })
})

describe('bounded pure authored preflight and session-local batch receipts', () => {
  it('preflights without calling editor/kernel, changing selection/history/epochs or consuming the apply receipt', () => {
    const f = fixture(), before = f.editor.state.doc, state = { ...f.editor.state }, epoch = Picking.pickingGeometryEpoch()
    const change = vi.spyOn(f.editor, 'change'), layout = vi.spyOn(Picking, 'kernelLayout'), graph = vi.spyOn(Graph.prototype, 'applyOps')
    const fonts = vi.spyOn(Picking, 'activateDocumentFonts'), geometry = vi.spyOn(Picking, 'invalidateGeometry'), bounds = vi.spyOn(Picking, 'kernelBounds')
    const operations = [op('node.patch', { ids: [f.rectangle.id], patch: { radii: { topLeft: 11 } } })]
    const result = ok(f.call('batch.preflight', { operations }))
    expect(result).toMatchObject({ validation: 'authored-only', derivedResolution: 'deferred', authoritativeCommitValidationRequired: true, receiptConsumed: false })
    expect(f.editor.state.doc).toBe(before); expect(f.editor.state).toEqual(state); expect(f.editor.canUndo).toBe(false); expect(f.editor.canRedo).toBe(false)
    expect(Picking.pickingGeometryEpoch()).toBe(epoch); expect(change).not.toHaveBeenCalled(); expect(layout).not.toHaveBeenCalled(); expect(graph).not.toHaveBeenCalled(); expect(fonts).not.toHaveBeenCalled(); expect(geometry).not.toHaveBeenCalled(); expect(bounds).not.toHaveBeenCalled()
    expect(ok(f.call('batch.apply', { operations, mutationId: 'first' })).receipt.replayed).toBe(false)
    expect(change).toHaveBeenCalledTimes(1)
    rejected(f.call('batch.preflight', { operations: [op('font.import', { data: 'AAAA', embeddingAllowed: true })] }), 'unsupported_preflight_operation')
    rejected(f.call('batch.preflight', { operations, mutationId: 'forbidden' }), 'invalid_params')
  })
  it('returns original committed results for exact retries after stale revisions and undo, but never replays another session or conflicting payload', () => {
    const f = fixture(), original = f.editor.state.doc
    const request = { method: 'batch.apply', ...f.fence(), params: { mutationId: 'edit-one', operations: [op('node.patch', { ids: [f.rectangle.id], patch: { name: 'Only once' } })] } }
    const first = ok(f.api.execute(request)), revision = f.editor.state.version
    expect(first.receipt).toEqual({ mutationId: 'edit-one', revision, replayed: false })
    const replay = ok(f.api.execute({ ...request, id: 'transport-retry' }))
    expect(replay.receipt).toEqual({ mutationId: 'edit-one', revision, replayed: true })
    expect(f.editor.state.version).toBe(revision)
    rejected(f.api.execute({ ...request, params: { ...request.params, label: 'changed input' } }), 'mutation_conflict')
    ok(f.call('history.undo')); expect(f.editor.state.doc).toEqual(original)
    const afterUndo = f.editor.state.version
    ok(f.api.execute(request)); expect(f.editor.state.version).toBe(afterUndo); expect(f.editor.state.doc).toEqual(original)
    f.editor.load(blank('Another file'))
    rejected(f.api.execute(request), 'document_mismatch')
  })
  it('failed history commits consume no receipt and remain retryable, while stale unreceipted writes fail', () => {
    const f = fixture(), before = f.editor.state.doc
    const request = { method: 'batch.apply', ...f.fence(), params: { mutationId: 'retry-failed', operations: [op('node.patch', { ids: [f.rectangle.id], patch: { name: 'Retry accepted' } })] } }
    vi.spyOn(Graph.prototype, 'applyOps').mockImplementationOnce(() => { throw Error('Actual graph transaction rejection') })
    rejected(f.api.execute(request), 'commit_failed')
    expect(f.editor.state.doc).toBe(before); expect(f.editor.canUndo).toBe(false)
    expect(ok(f.api.execute(request)).receipt.replayed).toBe(false)
    rejected(f.api.execute({ ...request, params: { operations: request.params.operations } }), 'stale_revision')
  })
  it('does not evict successful receipts or create undo entries for no-ops', () => {
    const f = fixture(), before = f.editor.state.doc, operations = [op('node.patch', { ids: [f.rectangle.id], patch: { opacity: 1 } })]
    const firstRequest = { method: 'batch.apply', ...f.fence(), params: { operations, mutationId: 'no-op-0' } }
    for (let i = 0; i < 128; i++) {
      const result = ok(f.call('batch.apply', { operations, mutationId: `no-op-${i}` }))
      expect(result.noChange).toBe(true); expect(result.changedPaths).toEqual([])
    }
    rejected(f.call('batch.apply', { operations, mutationId: 'overflow' }), 'receipt_limit')
    expect(ok(f.api.execute(firstRequest)).receipt.replayed).toBe(true)
    expect(f.editor.state.doc).toBe(before); expect(f.editor.canUndo).toBe(false)
    f.editor.load(structuredClone(before))
    rejected(f.api.execute(firstRequest), 'session_mismatch')
  })
  it('pre-admits complete receipt bytes before real commits and preserves earlier exact large receipts', () => {
    const f = fixture(), payload = 'x'.repeat(7 * 1024 * 1024)
    // Exercise the public trusted-extension/result budget, while every change
    // still commits through the actual Editor and native Graph history.
    const api = createDesignAutomation(f.editor, [{ name: 'test.largeResult', description: 'Receipt budget test', mutates: true,
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
      execute(doc, params) { doc.nodes[f.rectangle.id].name = params.name as string; return payload },
    }])
    const request = (i: number) => ({ method: 'batch.apply', ...f.fence(), params: { mutationId: `large-${i}`, operations: [op('test.largeResult', { name: `Change ${i}` })] } })
    const first = request(0)
    try {
      for (let i = 0; i < 4; i++) expect(ok(api.execute(i === 0 ? first : request(i))).receipt.replayed).toBe(false)
      const before = f.editor.state.doc, revision = f.editor.state.version
      rejected(api.execute(request(4)), 'receipt_limit')
      expect(f.editor.state.doc).toBe(before); expect(f.editor.state.version).toBe(revision)
      expect(ok(api.execute(first)).operations[0].result).toBe(payload)
      expect(f.editor.state.version).toBe(revision)
    } finally { api.dispose() }
  })
  it('reserves an in-flight mutation identity against synchronous same-ID retries', () => {
    const f = fixture(), request = { method: 'batch.apply', ...f.fence(), params: { mutationId: 'in-flight',
      operations: [op('node.patch', { ids: [f.rectangle.id], patch: { name: 'Outer commit' } })] } }
    let exact: AutomationResponse | undefined, conflicting: AutomationResponse | undefined
    const stop = f.editor.subscribeEdits(() => {
      exact = f.api.execute(request)
      conflicting = f.api.execute({ ...request, ...f.fence(), params: { ...request.params,
        operations: [op('node.patch', { ids: [f.rectangle.id], patch: { name: 'Must not commit' } })] } })
    })
    const first = ok(f.api.execute(request)); stop()
    expect(exact).toMatchObject({ ok: false, error: { code: 'mutation_in_progress' } })
    expect(conflicting).toMatchObject({ ok: false, error: { code: 'mutation_conflict' } })
    expect(f.editor.state.version).toBe(request.expectedRevision + 1)
    expect(f.editor.state.doc.nodes[f.rectangle.id].name).toBe('Outer commit')
    const replay = ok(f.api.execute(request))
    expect(replay).toEqual({ ...first, receipt: { ...first.receipt, replayed: true } })
  })
  it('protects in-flight receipt bytes from a different-ID reentrant commit', () => {
    const f = fixture(), api = createDesignAutomation(f.editor, [{ name: 'test.payload', description: 'Bounded receipt fixture', mutates: true,
      inputSchema: { type: 'object', properties: { size: { type: 'integer' }, name: { type: 'string' } }, required: ['size', 'name'], additionalProperties: false },
      execute(doc, params) { doc.name = params.name as string; return 'x'.repeat(params.size as number) },
    }])
    const request = (id: string, size: number) => ({ method: 'batch.apply', ...f.fence(), params: { mutationId: id,
      operations: [op('test.payload', { size, name: id })] } })
    try {
      for (let i = 0; i < 4; i++) ok(api.execute(request(`seed-${i}`, 7 * 1024 ** 2)))
      let nested: AutomationResponse | undefined
      const stop = f.editor.subscribeEdits(() => { if (!nested) nested = api.execute(request('nested', 2 * 1024 ** 2)) })
      const outerRequest = request('outer', 3 * 1024 ** 2), first = ok(api.execute(outerRequest)); stop()
      expect(nested).toMatchObject({ ok: false, error: { code: 'receipt_limit' } })
      expect(f.editor.state.version).toBe(outerRequest.expectedRevision + 1)
      expect(f.editor.state.doc.name).toBe('outer')
      expect(first.receipt.replayAvailable).toBeUndefined()
      const replay = ok(api.execute(outerRequest))
      expect(replay).toEqual({ ...first, receipt: { ...first.receipt, replayed: true } })
    } finally { api.dispose() }
  })
  it('admits actual native materialized receipt IDs and rejects overflow before history or publication', () => {
    const document = blank('Materialized receipt'), main = node('frame', 0, 0, 100, 100)
    main.component = { properties: {}, variants: {} }
    document.nodes[main.id] = main; document.pages[0].children.push(main.id)
    for (let i = 0; i < 1100; i++) {
      const child = node('rectangle', 0, 0, 1, 1)
      document.nodes[child.id] = child; main.children.push(child.id)
    }
    stampKeys(document, main.id)
    const f = fixture(document), api = createDesignAutomation(f.editor, [...designSystemExtensions, {
      name: 'test.payload', description: 'Bounded receipt fixture', mutates: true,
      inputSchema: { type: 'object', properties: { size: { type: 'integer' }, name: { type: 'string' } }, required: ['size', 'name'], additionalProperties: false },
      execute(doc, params) { doc.name = params.name as string; return 'x'.repeat(params.size as number) },
    }])
    const seed = (i: number, size: number) => ({ method: 'batch.apply', ...f.fence(), params: { mutationId: `seed-${i}`,
      operations: [op('test.payload', { size, name: `seed-${i}` })] } })
    const instantiate = () => ({ method: 'batch.apply', ...f.fence(), params: { mutationId: 'materialized',
      operations: [op('component.instantiate', { componentId: main.id, x: 200 })] } })
    try {
      const firstSeed = seed(0, 7 * 1024 ** 2)
      for (let i = 0; i < 4; i++) ok(api.execute(i === 0 ? firstSeed : seed(i, 7 * 1024 ** 2)))
      ok(api.execute(seed(4, Math.floor(3.9 * 1024 ** 2))))
      const before = f.editor.state.doc, version = f.editor.state.version
      const layout = vi.spyOn(Picking, 'kernelLayout'), ops = vi.spyOn(Graph.prototype, 'applyOps'), replace = vi.spyOn(Graph.prototype, 'replaceDocument')
      rejected(api.execute(instantiate()), 'receipt_limit')
      expect(layout).toHaveBeenCalledTimes(1)
      const resolved = layout.mock.results[0].value as DesignDocument
      expect(Object.keys(resolved.nodes).length - Object.keys(before.nodes).length).toBe(1101)
      expect(ops).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled()
      expect(f.editor.state.doc).toBe(before); expect(f.editor.state.version).toBe(version)
      expect(ok(api.execute(firstSeed)).receipt.replayed).toBe(true)
      // A fresh receipt session has room, and an exact lost-response retry must
      // return all generated IDs without another instance or undo entry.
      const request = instantiate(), first = ok(f.api.execute(request)), revision = f.editor.state.version
      expect(first.createdIds).toHaveLength(1101)
      const replay = ok(f.api.execute(request))
      expect(replay).toEqual({ ...first, receipt: { ...first.receipt, replayed: true } })
      expect(f.editor.state.version).toBe(revision)
    } finally { api.dispose() }
  }, 60_000)
  it('bounds changed paths and never emits full image/font bytes', () => {
    const before = blank(), after = structuredClone(before), n = node('rectangle')
    before.nodes[n.id] = structuredClone(n); after.nodes[n.id] = structuredClone(n)
    before.nodes[n.id].fills[0].image = 'data:image/png;base64,SECRETOLD'
    after.nodes[n.id].fills[0].image = 'data:image/png;base64,SECRETNEW'
    before.fonts = { secret: { family: 'Font', data: 'OLDSECRET' } }; after.fonts = { secret: { family: 'Font', data: 'NEWSECRET' } }
    const result = summarizeChanges(before, after)
    expect(JSON.stringify(result)).not.toMatch(/SECRET/)
    expect(result.changes.every(change => change.beforeOmitted && change.afterOmitted)).toBe(true)
    for (let i = 0; i < 1200; i++) { const n = node('rectangle'); before.nodes[n.id] = n; after.nodes[n.id] = { ...n, opacity: .5 } }
    const bounded = summarizeChanges(before, after)
    expect(bounded.changes).toHaveLength(CHANGE_SUMMARY_LIMITS.maxPaths)
    expect(bounded.changesTruncated).toBe(true)
    expect(new TextEncoder().encode(JSON.stringify(bounded)).byteLength).toBeLessThan(CHANGE_SUMMARY_LIMITS.maxBytes + 1024)
  })
})
