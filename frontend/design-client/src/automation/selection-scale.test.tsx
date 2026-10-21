import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Editor } from '../engine'
import { Inspector } from '../Inspector'
import { blank, node, stroke, effect, defaultLayout, type DesignDocument } from '../model'
import { around, multiply, worldMatrix } from '../geometry'
import { scaleAnchor, selectionScaleFrame } from '../selection-scale'
import { selectionMetric, resizeNodeDimension, setNodePosition } from '../selection-properties'
import { propertyUnits } from '../property-units'
import { selectionParentBounds } from '../canvas-view'
import { registerPendingEdit } from '../pending-edits'
import { createDesignAutomation } from './core'
import { createEditorDesignAutomation } from './index'
import { displayProperties } from './display-properties'
import { exportDesignCode } from './export'
import { OperationBackend } from '../../../design-mcp/src/operation-backend.mjs'
vi.mock('react', async original => {
  const actual = await original<typeof import('react')>()
  return { ...actual, useSyncExternalStore: (subscribe: any, snapshot: any, server: any) => actual.useSyncExternalStore(subscribe, snapshot, server || snapshot) }
})
const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()); vi.restoreAllMocks() })
function source() {
  const doc = blank(), frame = node('frame', 10, 20, 100, 80), child = node('text', 8, 12, 40, 30), other = node('rectangle', 180, 50, 30, 20)
  child.text = 'Scale'; child.fontSize = 12
  child.strokes = [{ ...stroke(), width: 2 }]; child.effects = [{ ...effect('shadow'), radius: 3, x: 2, y: 4, spread: 1 }]
  frame.children = [child.id]; doc.nodes = { [frame.id]: frame, [child.id]: child, [other.id]: other }; doc.pages[0].children = [frame.id, other.id]
  return { doc, frame, child, other }
}
function setup(doc: DesignDocument, full = false) {
  const editor = new Editor(structuredClone(doc)); cleanup.push(() => editor.dispose())
  const api = full ? createEditorDesignAutomation(editor) : createDesignAutomation(editor)
  if ('dispose' in api && typeof api.dispose === 'function') cleanup.push(() => api.dispose())
  const fence = () => ({ documentId: editor.state.doc.id, session: editor.sessionGeneration, expectedRevision: editor.state.version })
  const call = (method: string, params: Record<string, unknown> = {}) => api.execute({ method, params, ...fence() })
  return { editor, api, call, fence }
}
function result(response: ReturnType<ReturnType<typeof createDesignAutomation>['execute']>): any {
  expect(response.ok, JSON.stringify(response)).toBe(true)
  if (!response.ok) throw Error(response.error.message)
  return response.result
}
describe('shared UI/MCP scale through real Editor admission and history', () => {
  it('keeps default node.get output unchanged and exposes actual Inspector dimensions/styles only on request', () => {
    const { doc, frame, child } = source(), f = setup(doc), before = f.editor.state.doc
    result(f.call('selection.scale', { ids: [frame.id], factor: 2, anchor: 0 }))
    expect(f.editor.state.doc.nodes[frame.id].transform).toEqual([2, 0, 0, 2, 10, 20])
    expect(f.editor.state.doc.nodes[child.id]).toEqual(before.nodes[child.id])
    const plain = result(f.call('node.get', { id: child.id })), explicitFalse = result(f.call('node.get', { id: child.id, includeDisplayProperties: false }))
    expect(JSON.stringify(plain)).toBe(JSON.stringify(explicitFalse)); expect(plain).not.toHaveProperty('displayProperties')
    const projected = result(f.call('node.get', { id: child.id, includeDisplayProperties: true })), { displayProperties: display, ...original } = projected
    expect(JSON.stringify(original)).toBe(JSON.stringify(plain))
    expect(display).toMatchObject({ units: 'effective-document', width: 80, height: 60, fontSize: 24, strokes: [{ width: 4 }], effects: [{ radius: 6, x: 4, y: 8, spread: 2 }] })
    f.editor.select([child.id]); const html = renderToStaticMarkup(<Inspector editor={f.editor} />)
    for (const [label, value] of [['W', 80], ['H', 60], ['字号', 24], ['粗细', 4], ['模糊', 6]])
      expect(html).toMatch(new RegExp(`aria-label="${label}"[^>]+aria-valuenow="${value}"`))
    const exported = exportDesignCode(f.editor.state.doc)
    expect(exported.css).toContain('transform:matrix(2,0,0,2,10,20)'); expect(exported.css).toContain('font-size:12px')
    const after = f.editor.state.doc
    f.editor.undo(); expect(f.editor.state.doc).toEqual(before); expect(f.editor.canUndo).toBe(false)
    f.editor.redo(); expect(f.editor.state.doc).toEqual(after)
  })
  it('effective dimension edits after scale convert once and preserve unrelated local styles', () => {
    const { doc, frame, child } = source(), f = setup(doc)
    result(f.call('selection.scale', { ids: [frame.id], factor: 2, anchor: 0 }))
    const before = f.editor.state.doc
    f.editor.updateProperties([child.id], n => resizeNodeDimension(n, 'width', 120, f.editor.state.doc))
    expect(f.editor.state.doc.nodes[child.id].width).toBe(60)
    expect(displayProperties(f.editor.state.doc, child.id).width).toBe(120)
    expect(f.editor.state.doc.nodes[child.id].effects).toEqual(before.nodes[child.id].effects)
    expect(f.editor.state.doc.nodes[child.id].fontSize).toBe(12)
    f.editor.undo(); expect(f.editor.state.doc).toEqual(before)
  })
  it.each(Array.from({ length: 9 }, (_, n) => n))('uses identical anchored transforms for UI and MCP at anchor %i under a rotated/reflected parent', anchor => {
    const { doc, frame, child } = source(); frame.transform = [0, -1.5, -1.5, 0, 140.25, -60.5]
    const ui = setup(doc), mcp = setup(doc), original = ui.editor.state.doc
    ui.editor.select([child.id]); mcp.editor.select([frame.id])
    const point = scaleAnchor(selectionScaleFrame(original, original.pages[0].id, [child.id]), anchor)
    const expected = multiply(around(point, [1.375, 0, 0, 1.375, 0, 0]), worldMatrix(original, child.id))
    expect(ui.editor.scaleSelection(1.375, anchor)).toBe(true)
    result(mcp.call('selection.scale', { ids: [child.id], factor: 1.375, anchor }))
    expect(mcp.editor.state.doc).toEqual(ui.editor.state.doc); expect(mcp.editor.state.selection).toEqual([frame.id])
    worldMatrix(mcp.editor.state.doc, child.id).forEach((v, i) => expect(v).toBeCloseTo(expected[i], 10))
    expect(displayProperties(mcp.editor.state.doc, child.id)).toEqual(displayProperties(ui.editor.state.doc, child.id))
    ui.editor.undo(); mcp.editor.undo(); expect(ui.editor.state.doc).toEqual(original); expect(mcp.editor.state.doc).toEqual(original)
  })
  it('uses one multi-selection union and never double-scales nested selected roots', () => {
    const { doc, frame, child, other } = source(), ui = setup(doc), mcp = setup(doc)
    const ids = [frame.id, child.id, other.id]; ui.editor.select(ids)
    expect(ui.editor.scaleSelection(2, 4)).toBe(true)
    result(mcp.call('selection.scale', { ids, factor: 2 }))
    expect(mcp.editor.state.doc).toEqual(ui.editor.state.doc)
    expect(worldMatrix(mcp.editor.state.doc, child.id)[0]).toBe(2)
    expect(mcp.editor.state.doc.nodes[child.id].transform).toEqual(doc.nodes[child.id].transform)
  })
  it.each(Array.from({ length: 9 }, (_, n) => n))('matches independent numeric multi-root union expectations at anchor %i', anchor => {
    const { doc, frame, child, other } = source(), f = setup(doc)
    // Explicit arithmetic for union (10,20,200,80), not the production bounds helper.
    const ax = 10 + 100 * (anchor % 3), ay = 20 + 40 * Math.floor(anchor / 3)
    result(f.call('selection.scale', { ids: [frame.id, child.id, other.id], factor: 2, anchor }))
    expect(f.editor.state.doc.nodes[frame.id].transform).toEqual([2, 0, 0, 2, 20 - ax, 40 - ay])
    expect(f.editor.state.doc.nodes[other.id].transform).toEqual([2, 0, 0, 2, 360 - ax, 100 - ay])
    expect(f.editor.state.doc.nodes[child.id].transform).toEqual(child.transform)
  })
  it('is a validated no-op at factor one with no undo or revision', () => {
    const { doc, frame } = source(), f = setup(doc), before = f.editor.state.doc, version = f.editor.state.version
    result(f.call('selection.scale', { ids: [frame.id], factor: 1 }))
    expect(f.editor.state.doc).toBe(before); expect(f.editor.state.version).toBe(version); expect(f.editor.canUndo).toBe(false)
  })
})

describe('group bounds regression and safe read projection', () => {
  it('does not use stale authored group width for Inspector dimensions or subsequent resizing', () => {
    const doc = blank(), group = node('group', 10, 20, 999, 777), child = node('rectangle', 12, 15, 40, 30)
    group.children = [child.id]; group.transform = [0, 2, -2, 0, 10, 20]
    doc.nodes = { [group.id]: group, [child.id]: child }; doc.pages[0].children = [group.id]
    // Previous selectionMetric returned 1998/1554 from the stale 999/777 box.
    expect(selectionScaleFrame(doc, doc.pages[0].id, [group.id]).width).toBe(80)
    expect(selectionMetric(group, 'width', doc)).toBe(80); expect(selectionMetric(group, 'height', doc)).toBe(60)
    resizeNodeDimension(group, 'width', 120, doc)
    expect(selectionMetric(group, 'width', doc)).toBe(120)
    expect(group.width).toBe(999); expect(child.width).toBe(40)
  })
  it('shared single/multi Inspector X/Y edits move rotated/reflected offset groups to the requested parent-axis position', () => {
    const doc = blank(), parent = node('frame', 0, 0, 1000, 1000), group = node('group', 10, 20, 999, 777), child = node('rectangle', 12, 15, 40, 30)
    parent.transform = [0, 2, 2, 0, 0, 0]; parent.children = [group.id]
    group.transform = [0, 1, -1, 0, 10, 20]; group.children = [child.id]
    doc.nodes = { [parent.id]: parent, [group.id]: group, [child.id]: child }; doc.pages[0].children = [parent.id]
    expect(selectionParentBounds(doc, group.id)).toEqual({ x: -35, y: 32, width: 30, height: 40 })
    expect(selectionMetric(group, 'x', doc)).toBe(-70); expect(selectionMetric(group, 'y', doc)).toBe(64)
    const f = setup(doc), before = f.editor.state.doc, beforeChild = before.nodes[child.id], originalWorld = worldMatrix(before, child.id)
    const oldPosition = selectionParentBounds(before, group.id)
    const oldDimensions = [selectionMetric(before.nodes[group.id], 'width', before), selectionMetric(before.nodes[group.id], 'height', before)]
    f.editor.select([group.id])
    f.editor.updateProperties([group.id], n => { setNodePosition(n, 'x', 120, f.editor.state.doc); setNodePosition(n, 'y', 180, f.editor.state.doc) })
    const after = f.editor.state.doc, moved = after.nodes[group.id]
    expect(selectionMetric(moved, 'x', after)).toBe(120); expect(selectionMetric(moved, 'y', after)).toBe(180)
    expect(selectionParentBounds(after, group.id)).toMatchObject({ x: 60, y: 90 })
    expect([selectionMetric(moved, 'width', after), selectionMetric(moved, 'height', after)]).toEqual(oldDimensions)
    expect(after.nodes[child.id]).toEqual(beforeChild)
    const newWorld = worldMatrix(after, child.id)
    expect(newWorld.slice(0, 4)).toEqual(originalWorld.slice(0, 4))
    expect(newWorld[4] - originalWorld[4]).toBeCloseTo(2 * (90 - oldPosition.y), 10)
    expect(newWorld[5] - originalWorld[5]).toBeCloseTo(2 * (60 - oldPosition.x), 10)
    const html = renderToStaticMarkup(<Inspector editor={f.editor} />)
    expect(html).toMatch(/aria-label="X"[^>]+aria-valuenow="120"/); expect(html).toMatch(/aria-label="Y"[^>]+aria-valuenow="180"/)
    f.editor.undo(); expect(f.editor.state.doc).toEqual(before)
  })
  it('empty groups retain authored-box fallback for position, dimensions and position edits', () => {
    const doc = blank(), group = node('group', 10, 20, 40, 30)
    group.transform = [0, -2, -2, 0, 10, 20]; doc.nodes[group.id] = group; doc.pages[0].children = [group.id]
    expect(selectionParentBounds(doc, group.id)).toEqual({ x: -50, y: -60, width: 60, height: 80 })
    setNodePosition(group, 'x', 70, doc); setNodePosition(group, 'y', 90, doc)
    expect(selectionParentBounds(doc, group.id)).toEqual({ x: 70, y: 90, width: 60, height: 80 })
    expect([selectionMetric(group, 'width', doc), selectionMetric(group, 'height', doc)]).toEqual([80, 60])
  })
  it('omits ambiguous scalar distances for skew/non-uniform transforms, without changing raw node data', () => {
    const { doc, child, frame } = source(); frame.transform = [2, 0, 1, 3, 0, 0]
    const before = JSON.stringify(doc), read = displayProperties(doc, child.id)
    expect(read.width).toBe(selectionMetric(child, 'width', doc)); expect(read.height).toBe(selectionMetric(child, 'height', doc))
    expect(read).not.toHaveProperty('fontSize'); expect(read).not.toHaveProperty('strokes'); expect(read.unsupported[0]).toContain('non-uniform')
    expect(JSON.stringify(doc)).toBe(before)
    frame.transform = [0, -2, -2, 0, 0, 0]
    expect(displayProperties(doc, child.id)).toMatchObject({ fontSize: 24 })
    expect(propertyUnits(doc, child.id).style).toBe(2)
  })
})

describe('scale fail-closed schemas, scopes, batch and permissions', () => {
  it('rejects malformed/excess targets, factor/anchor and unknown controls without changing history', () => {
    const { doc, frame } = source(), f = setup(doc), before = f.editor.state.doc
    for (const params of [
      { ids: [], factor: 2 }, { ids: [frame.id, frame.id], factor: 2 }, { ids: Array.from({ length: 1001 }, (_, i) => String(i)), factor: 2 },
      ...[0, -.5, .001, 10001].map(factor => ({ ids: [frame.id], factor })),
      ...[-1, 9, .5, '4'].map(anchor => ({ ids: [frame.id], factor: 2, anchor })),
      { ids: [frame.id], factor: 2, width: 50 }, { ids: [frame.id], factor: 2, selectionGeometryFresh: true },
    ]) expect(f.call('selection.scale', params)).toMatchObject({ ok: false, error: { code: 'invalid_params' } })
    expect(f.call('node.get', { id: frame.id, includeDisplayProperties: 1 })).toMatchObject({ ok: false, error: { code: 'invalid_params' } })
    expect(f.editor.state.doc).toBe(before); expect(f.editor.canUndo).toBe(false)
  })
  it('rejects mixed locked targets, locked ancestors, missing targets and cross-page targets atomically', () => {
    for (const mode of ['mixed-lock', 'ancestor-lock', 'missing', 'different-page'] as const) {
      const { doc, frame, child, other } = source()
      if (mode === 'mixed-lock') other.locked = true
      if (mode === 'ancestor-lock') frame.locked = true
      if (mode === 'different-page') { const page = { ...doc.pages[0], id: '11111111-1111-4111-8111-111111111111', children: [other.id] }; doc.pages.push(page); doc.pages[0].children = [frame.id] }
      const f = setup(doc), before = f.editor.state.doc, ids = mode === 'ancestor-lock' ? [child.id] : [frame.id, mode === 'missing' ? 'missing' : other.id]
      expect(f.call('selection.scale', { ids, factor: 2 })).toMatchObject({ ok: false, error: { code: mode.includes('lock') ? 'locked_node' : mode === 'missing' ? 'not_found' : 'different_pages' } })
      f.editor.select(ids.filter(id => !!f.editor.state.doc.nodes[id]))
      if (mode !== 'missing') expect(f.editor.scaleSelection(2)).toBe(false)
      expect(f.editor.state.doc).toBe(before); expect(f.editor.canUndo).toBe(false)
    }
  })
  it.each(Array.from({ length: 9 }, (_, n) => n))('rejects single/mixed/all-hidden and hidden-ancestor selections atomically at anchor %i', anchor => {
    for (const mode of ['single', 'mixed', 'all-hidden', 'hidden-ancestor'] as const) {
      const { doc, frame, child, other } = source()
      const ids = mode === 'hidden-ancestor' ? [child.id] : mode === 'single' ? [other.id] : [frame.id, other.id]
      if (mode === 'hidden-ancestor') frame.visible = false
      else other.visible = false
      if (mode === 'all-hidden') frame.visible = false
      const f = setup(doc), before = f.editor.state.doc
      expect(f.call('selection.scale', { ids, factor: 2, anchor })).toMatchObject({ ok: false, error: { code: 'invalid_selection' } })
      f.editor.select(ids); expect(f.editor.scaleSelection(2, anchor)).toBe(false)
      expect(f.editor.state.doc).toBe(before); expect(f.editor.canUndo).toBe(false)
    }
  })
  it('rejects instance internals on UI and MCP, while allowing a real materialized instance root', () => {
    const { doc, frame } = source(), f = setup(doc, true)
    const created = result(f.call('component.create', { nodeIds: [frame.id] }))
    const componentId = created.operations[0].result.id
    const instantiated = result(f.call('component.instantiate', { componentId }))
    const instanceId = instantiated.operations[0].result.id, innerId = f.editor.state.doc.nodes[instanceId].children[0]
    expect(innerId).toBeTruthy()
    const before = f.editor.state.doc, version = f.editor.state.version
    expect(f.call('selection.scale', { ids: [innerId], factor: 2 })).toMatchObject({ ok: false, error: { code: 'instance_structure' } })
    f.editor.select([innerId]); expect(f.editor.scaleSelection(2)).toBe(false)
    expect(f.editor.state.doc).toBe(before); expect(f.editor.state.version).toBe(version)
    result(f.call('selection.scale', { ids: [instanceId], factor: 2, anchor: 0 }))
    expect(f.editor.state.doc.nodes[instanceId].transform[0]).toBe(2)
    f.editor.undo(); expect(f.editor.state.doc).toEqual(before)
  })
  it('rejects auto-layout flow children and stale derived batch geometry with rollback of earlier edits', () => {
    const { doc, frame, child } = source(); frame.layout = defaultLayout()
    const f = setup(doc), before = f.editor.state.doc
    expect(f.call('selection.scale', { ids: [child.id], factor: 2 })).toMatchObject({ ok: false, error: { code: 'auto_layout_position' } })
    expect(f.call('batch.apply', { operations: [
      { method: 'node.update', params: { ids: [frame.id], patch: { name: 'must rollback' } } },
      { method: 'selection.scale', params: { ids: [frame.id], factor: 2 } },
    ] })).toMatchObject({ ok: false, error: { code: 'unsupported_derived_batch_geometry' } })
    expect(f.editor.state.doc).toBe(before); expect(f.editor.canUndo).toBe(false)
  })
  it('preserves stale revision fences, busy state, active gestures and pending Inspector drafts', () => {
    const { doc, frame } = source(), f = setup(doc), before = f.editor.state.doc
    const params = { ids: [frame.id], factor: 2 }
    expect(f.api.execute({ method: 'selection.scale', params, ...f.fence(), expectedRevision: -1 })).toMatchObject({ ok: false })
    f.editor.set({ busy: true })
    expect(f.call('selection.scale', params)).toMatchObject({ ok: false, error: { code: 'editor_busy' } })
    f.editor.set({ busy: false }); f.editor.begin('pending gesture')
    expect(f.call('selection.scale', params)).toMatchObject({ ok: false, error: { code: 'interaction_active' } })
    f.editor.cancel()
    const unregister = registerPendingEdit(f.editor, { dirty: () => true, commit: () => { throw Error('Do not consume user input') } })
    try { expect(f.call('selection.scale', params)).toMatchObject({ ok: false, error: { code: 'pending_edits' } }) } finally { unregister() }
    expect(f.editor.state.doc).toBe(before); expect(f.editor.canUndo).toBe(false)
  })
  it('validates a bounded plain-geometry batch and publishes it as one undo entry', () => {
    const { doc, other } = source(), f = setup(doc), before = f.editor.state.doc
    result(f.call('batch.apply', { operations: [
      { method: 'node.update', params: { ids: [other.id], patch: { name: 'Scaled' } } },
      { method: 'selection.scale', params: { ids: [other.id], factor: 2, anchor: 0 } },
    ] }))
    expect(f.editor.state.doc.nodes[other.id].name).toBe('Scaled')
    expect(f.editor.state.doc.nodes[other.id].transform[0]).toBe(2)
    f.editor.undo(); expect(f.editor.state.doc).toEqual(before); expect(f.editor.canUndo).toBe(false)
  })
  it('cannot bypass read-only grants, batch leaf grants or MCP adapter read scope; read projection needs only node.get', async () => {
    const { doc, frame } = source(), f = setup(doc), before = f.editor.state.doc
    const api = createDesignAutomation(f.editor, [], [], { grants: [{ resource: { documentId: doc.id, session: f.editor.sessionGeneration }, operations: ['node.get', 'selection.scale'], access: 'read' }] })
    expect(api.execute({ method: 'node.get', params: { id: frame.id, includeDisplayProperties: true } }).ok).toBe(true)
    expect(api.execute({ method: 'selection.scale', params: { ids: [frame.id], factor: 2 }, ...f.fence() })).toMatchObject({ ok: false, error: { code: 'permission_denied' } })
    const batchOnly = createDesignAutomation(f.editor, [], [], { grants: [{ resource: { documentId: doc.id, session: f.editor.sessionGeneration }, operations: ['batch.apply'], access: 'write' }] })
    expect(batchOnly.execute({ method: 'batch.apply', params: { operations: [{ method: 'selection.scale', params: { ids: [frame.id], factor: 2 } }] }, ...f.fence() })).toMatchObject({ ok: false, error: { code: 'permission_denied' } })
    const backend = new OperationBackend({ capabilities: { version: 1, methods: f.api.methods() }, execute: request => f.api.execute(request), scope: 'read' })
    expect(backend.listTools().some(t => t.name === 'design_selection_scale')).toBe(false)
    await expect(backend.callTool('design_selection_scale', { params: { ids: [frame.id], factor: 2 }, ...f.fence() })).rejects.toBeTruthy()
    expect(f.editor.state.doc).toBe(before); expect(f.editor.canUndo).toBe(false)
  })
})
