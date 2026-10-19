import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '../engine'
import { blank, node } from '../model'
import { Graph } from '../kernel/graph'
import { registerPendingEdit } from '../pending-edits'
import { createDesignAutomation } from './core'
import { createEditorDesignAutomation } from './index'
import { worldMatrix } from '../geometry'
import type { AutomationResponse } from './types'
const editors: Editor[] = []
afterEach(() => { editors.splice(0).forEach(e => e.dispose()); vi.restoreAllMocks() })
function fixture() {
  const d = blank('Automation'), n = node('rectangle', 10, 20, 30, 40)
  d.nodes[n.id] = n; d.pages[0].children.push(n.id)
  const editor = new Editor(d); editors.push(editor)
  const api = createDesignAutomation(editor)
  const read = (method: string, params: Record<string, unknown> = {}) => api.execute({ method, params })
  const call = (method: string, params: Record<string, unknown> = {}) => api.execute({ method, params,
    expectedRevision: editor.state.version, documentId: editor.state.doc.id, session: editor.sessionGeneration })
  return { editor, api, n, read, call }
}
function success(response: AutomationResponse): Record<string, unknown> {
  expect(response.ok, JSON.stringify(response)).toBe(true)
  if (!response.ok) throw Error(response.error.message)
  return response.result as Record<string, unknown>
}
function failure(response: AutomationResponse, code: string) {
  expect(response.ok, JSON.stringify(response)).toBe(false)
  if (!response.ok) expect(response.error.code).toBe(code)
}
describe('real Editor automation boundary', () => {
  it('discovers schemas and returns detached document/node data', () => {
    const { editor, n, read } = fixture()
    expect((success(read('api.capabilities')).methods as unknown[]).length).toBeGreaterThan(20)
    const result = success(read('node.get', { id: n.id }))
    ;(result.node as { name: string }).name = 'Tampered'
    expect(editor.state.doc.nodes[n.id].name).not.toBe('Tampered')
    expect(success(read('document.get')).nodeCount).toBe(1)
  })
  it('commits a complete batch as one native undo entry', () => {
    const { editor, n, call } = fixture(), before = editor.state.doc, version = editor.state.version
    const out = success(call('batch.apply', { operations: [
      { method: 'node.create', params: { id: '11111111-1111-4111-8111-111111111111', kind: 'frame', x: 100, y: 100, width: 300, height: 200 } },
      { method: 'node.move', params: { ids: [n.id], parentId: '11111111-1111-4111-8111-111111111111' } },
      { method: 'node.update', params: { ids: [n.id], patch: { name: 'Renamed' } } },
      { method: 'selection.set', params: { ids: ['11111111-1111-4111-8111-111111111111'] } },
    ] }))
    expect(editor.state.version).toBe(version + 1)
    expect(editor.state.doc.nodes['11111111-1111-4111-8111-111111111111'].children).toEqual([n.id])
    expect(editor.state.doc.nodes[n.id].transform.slice(4)).toEqual([-90, -80])
    expect(out.createdIds).toContain('11111111-1111-4111-8111-111111111111')
    expect(editor.state.selection).toEqual(['11111111-1111-4111-8111-111111111111'])
    success(call('history.undo')); expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
    success(call('history.redo')); expect(editor.state.doc.nodes[n.id].name).toBe('Renamed')
  })
  it('rolls invalid batches back without history or state changes', () => {
    const { editor, n, call } = fixture(), before = editor.state.doc, version = editor.state.version
    failure(call('batch.apply', { operations: [
      { method: 'node.update', params: { ids: [n.id], patch: { name: 'Must not commit' } } },
      { method: 'node.move', params: { ids: [n.id], parentId: 'missing' } },
    ] }), 'not_found')
    expect(editor.state.doc).toBe(before); expect(editor.state.version).toBe(version); expect(editor.canUndo).toBe(false)
  })
  it('reports actual kernel history rejection and permits a later retry', () => {
    const { editor, n, call } = fixture(), before = editor.state.doc
    vi.spyOn(Graph.prototype, 'applyOps').mockImplementationOnce(() => { throw Error('kernel history rejected') })
    failure(call('node.update', { ids: [n.id], patch: { name: 'Rejected' } }), 'commit_failed')
    expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
    success(call('node.update', { ids: [n.id], patch: { name: 'Accepted' } }))
    expect(editor.state.doc.nodes[n.id].name).toBe('Accepted')
  })
  it('recognizes no-op and rejects model errors', () => {
    const { editor, n, call } = fixture(), version = editor.state.version
    expect(success(call('node.update', { ids: [n.id], patch: { name: n.name } })).noChange).toBe(true)
    expect(editor.state.version).toBe(version)
    failure(call('node.update', { ids: [n.id], patch: { width: -5 } }), 'commit_failed')
    expect(editor.state.doc.nodes[n.id].width).toBe(30)
  })
  it('requires revision/document/session fences', () => {
    const { editor, api, n, call } = fixture()
    failure(api.execute({ method: 'node.delete', params: { ids: [n.id] } }), 'missing_revision')
    const request = { method: 'node.delete', params: { ids: [n.id] }, documentId: editor.state.doc.id, session: editor.sessionGeneration, expectedRevision: editor.state.version }
    success(call('node.update', { ids: [n.id], patch: { name: 'new version' } }))
    failure(api.execute(request), 'stale_revision')
    failure(api.execute({ ...request, expectedRevision: editor.state.version, session: 999 }), 'session_mismatch')
  })
  it('preserves active gestures and pending user input', () => {
    const { editor, n, call } = fixture(); editor.begin('User drag')
    failure(call('node.delete', { ids: [n.id] }), 'interaction_active'); expect(editor.interactionActive).toBe(true)
    editor.cancel()
    const unregister = registerPendingEdit(editor, { dirty: () => true, commit: () => { throw Error('Do not commit user input') } })
    try { failure(call('node.delete', { ids: [n.id] }), 'pending_edits'); expect(editor.state.doc.nodes[n.id]).toBeTruthy() } finally { unregister() }
  })
  it('guards locks, cycles, duplicate IDs, structural properties and unsafe URLs', () => {
    const { editor, n, call } = fixture()
    success(call('node.update', { ids: [n.id], patch: { locked: true } }))
    failure(call('node.delete', { ids: [n.id] }), 'locked_node')
    success(call('node.update', { ids: [n.id], patch: { locked: false } }))
    failure(call('node.create', { id: n.id, kind: 'text' }), 'duplicate_id')
    failure(call('node.update', { ids: [n.id], patch: { children: [] } }), 'invalid_params')
    failure(call('node.create', { kind: 'text', patch: { text: 'unsafe', textRuns: [{ start: 0, end: 1, link: 'javascript:alert(1)' }] } }), 'unsafe_url')
    success(call('node.create', { id: '22222222-2222-4222-8222-222222222222', kind: 'frame' }))
    success(call('node.create', { id: '33333333-3333-4333-8333-333333333333', kind: 'frame', parentId: '22222222-2222-4222-8222-222222222222' }))
    failure(call('node.move', { ids: ['22222222-2222-4222-8222-222222222222'], parentId: '33333333-3333-4333-8333-333333333333' }), 'cyclic_parent')
    expect(editor.state.doc.nodes['22222222-2222-4222-8222-222222222222'].children).toEqual(['33333333-3333-4333-8333-333333333333'])
  })
  it('rejects non-JSON, prototype keys and unknown parameters', () => {
    const { api, read, call } = fixture()
    failure(api.execute(JSON.parse('{"method":"document.get","params":{"__proto__":{}}}')), 'invalid_request')
    failure(read('node.find', { limit: Infinity }), 'invalid_request')
    const circular: Record<string, unknown> = {}; circular.self = circular
    failure(api.execute(circular), 'request_budget')
    failure(read('document.get', { unknown: true }), 'invalid_params')
    failure(call('node.create', { kind: 'made-up' }), 'invalid_params')
    failure(read('arbitrary.eval', { code: '1+1' }), 'unsupported_method')
    const accessor = { method: 'document.get' }; Object.defineProperty(accessor, 'toJSON', { get: () => { throw Error('Accessor must never execute') } })
    failure(api.execute(accessor), 'invalid_request')
    const array: unknown[] = []; Object.defineProperty(array, 'toJSON', { value: () => { throw Error('Array hook must never execute') } })
    failure(api.execute({ method: 'node.find', params: { ids: array } }), 'invalid_request')
  })
  it('paginates queries with revision-bound cursors', () => {
    const { read, call, n } = fixture(); success(call('node.create', { kind: 'text', id: '44444444-4444-4444-8444-444444444444' }))
    const first = success(read('node.find', { limit: 1 })), cursor = first.nextCursor
    expect(first.total).toBe(2); expect(typeof cursor).toBe('string')
    expect((success(read('node.find', { limit: 1, cursor })).nodes as unknown[])).toHaveLength(1)
    success(call('node.update', { ids: [n.id], patch: { name: 'new' } }))
    failure(read('node.find', { limit: 1, cursor }), 'stale_cursor')
  })
  it('duplicates native subtrees and manages page lifecycles', () => {
    const { editor, call, n } = fixture(), originalPage = editor.state.page
    const duplicated = success(call('node.duplicate', { ids: [n.id], offsetX: 50, offsetY: 0 }))
    expect((duplicated.createdIds as string[])).toHaveLength(1)
    expect(editor.state.doc.nodes[(duplicated.createdIds as string[])[0]].transform[4]).toBe(60)
    success(call('page.create', { id: '55555555-5555-4555-8555-555555555555', makeCurrent: true })); expect(editor.state.page).toBe('55555555-5555-4555-8555-555555555555')
    success(call('page.delete', { id: '55555555-5555-4555-8555-555555555555' })); expect(editor.state.page).toBe(originalPage)
    failure(call('page.delete', { id: originalPage }), 'last_page')
  })
  it('groups and ungroups transformed nodes without moving their world geometry', () => {
    const { editor, call, n } = fixture()
    const other = '66666666-6666-4666-8666-666666666666', group = '77777777-7777-4777-8777-777777777777'
    success(call('node.create', { id: other, kind: 'ellipse', x: 100, y: 70, width: 40, height: 50, patch: { transform: [0, 1, -1, 0, 100, 70] } }))
    const matrices = [worldMatrix(editor.state.doc, n.id), worldMatrix(editor.state.doc, other)]
    success(call('node.group', { ids: [other, n.id], id: group }))
    expect(editor.state.doc.nodes[group].children).toEqual([n.id, other])
    expect(worldMatrix(editor.state.doc, n.id)).toEqual(matrices[0]); expect(worldMatrix(editor.state.doc, other)).toEqual(matrices[1])
    success(call('node.ungroup', { ids: [group] }))
    expect(editor.state.doc.nodes[group]).toBeUndefined()
    expect(worldMatrix(editor.state.doc, n.id)).toEqual(matrices[0]); expect(worldMatrix(editor.state.doc, other)).toEqual(matrices[1])
  })
  it('aligns native world bounds and distributes equal edge gaps', () => {
    const { editor, call, n } = fixture(), second = '88888888-8888-4888-8888-888888888888', third = '99999999-9999-4999-8999-999999999999'
    success(call('node.create', { id: second, kind: 'rectangle', x: 80, y: 50, width: 30, height: 40 }))
    success(call('node.create', { id: third, kind: 'rectangle', x: 210, y: 80, width: 30, height: 40 }))
    success(call('node.align', { ids: [n.id, second, third], axis: 'y', mode: 'start' }))
    expect([n.id, second, third].map(id => editor.state.doc.nodes[id].transform[5])).toEqual([20, 20, 20])
    success(call('node.distribute', { ids: [n.id, second, third], axis: 'x' }))
    expect([n.id, second, third].map(id => editor.state.doc.nodes[id].transform[4])).toEqual([10, 110, 210])
    failure(call('node.distribute', { ids: [n.id, second], axis: 'x' }), 'invalid_params')
  })
  it('commits actual prototype/animation/review extensions atomically and undoes them', () => {
    const { editor, n } = fixture(), api = createEditorDesignAutomation(editor), before = editor.state.doc
    const call = (method: string, params: Record<string, unknown> = {}) => api.execute({ method, params, expectedRevision: editor.state.version, documentId: editor.state.doc.id, session: editor.sessionGeneration })
    const pageId = editor.state.page
    success(call('batch.apply', { operations: [
      { method: 'prototype.set', params: { prototype: { startNode: n.id, interactions: { [n.id]: [{ trigger: 'click', actions: [{ kind: 'navigate', target: n.id }] }] } } } },
      { method: 'animation.create', params: { pageId, nodeIds: [n.id], name: 'Pulse' } },
      { method: 'review.create', params: { pageId, nodeId: n.id, x: 10, y: 20, text: 'Check this shape' } },
    ] }))
    expect(editor.state.doc.animations).toHaveLength(1); expect(editor.state.doc.reviews).toHaveLength(1); expect(editor.state.doc.prototype?.startNode).toBe(n.id)
    expect(editor.state.doc.reviews![0].messages[0].author).toBe('Automation')
    success(call('history.undo')); expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
    success(call('history.redo')); expect(editor.state.doc.animations).toHaveLength(1)
    const good = editor.state.doc, version = editor.state.version
    failure(call('batch.apply', { operations: [
      { method: 'review.create', params: { pageId, x: 0, y: 0, text: 'Never published' } },
      { method: 'prototype.set', params: { prototype: { interactions: { [n.id]: [{ trigger: 'click', actions: [{ kind: 'navigate', target: 'missing' }] }] } } } },
    ] }), 'invalid_operation')
    expect(editor.state.doc).toBe(good); expect(editor.state.version).toBe(version)
    failure(call('review.create', { pageId, x: 0, y: 0, text: 'x', author: 'Impersonated user' }), 'invalid_params')
    failure(call('animation.update', { id: good.animations![0].id, durationMs: -1 }), 'invalid_params')
  })

  it('admits extended prototype schema and rejects malformed extras atomically', () => {
    const { editor, n } = fixture(), api = createEditorDesignAutomation(editor)
    const call = (params: Record<string, unknown>) => api.execute({ method: 'prototype.set', params, expectedRevision: editor.state.version, documentId: editor.state.doc.id, session: editor.sessionGeneration })
    const prototype = { interactions: { [n.id]: [{ trigger: 'click', actions: [{ kind: 'navigate', target: n.id, easingCurve: 'ease-in-out', transitionPreserveScroll: true }] }] } }
    success(call({ prototype })); expect(editor.state.doc.schemaVersion).toBeGreaterThanOrEqual(12)
    const before = editor.state.doc, version = editor.state.version
    failure(call({ prototype: { interactions: { [n.id]: [{ trigger: 'click', actions: [{ kind: 'navigate', target: n.id, transitionPreserveScroll: 'yes' }] }] } } }), 'commit_failed')
    expect(editor.state.doc).toBe(before); expect(editor.state.version).toBe(version)
  })
  it('preserves live instance appearance when a main is deleted, but rejects unmaterialized same-batch loss', () => {
    const { editor, n } = fixture(), api = createEditorDesignAutomation(editor)
    const call = (method: string, params: Record<string, unknown> = {}) => api.execute({ method, params, expectedRevision: editor.state.version, documentId: editor.state.doc.id, session: editor.sessionGeneration })
    const resultId = (r: Record<string, unknown>) => ((r.operations as { result: { id: string } }[])[0].result.id)
    const mainId = resultId(success(call('component.create', { nodeIds: [n.id] })))
    const instanceId = resultId(success(call('component.instantiate', { componentId: mainId, x: 300, y: 100 })))
    expect(editor.state.doc.nodes[instanceId].children).toHaveLength(1)
    const instanceWorld = worldMatrix(editor.state.doc, instanceId), childId = editor.state.doc.nodes[instanceId].children[0], childWidth = editor.state.doc.nodes[childId].width
    const beforeInvalid = editor.state.doc
    failure(call('batch.apply', { operations: [
      { method: 'component.instantiate', params: { componentId: mainId } },
      { method: 'node.delete', params: { ids: [mainId] } },
    ] }), 'unmaterialized_instance')
    expect(editor.state.doc).toBe(beforeInvalid)
    success(call('node.delete', { ids: [mainId] }))
    expect(editor.state.doc.nodes[instanceId].instance).toBeUndefined()
    expect(editor.state.doc.nodes[instanceId].children).toEqual([childId])
    expect(editor.state.doc.nodes[childId].width).toBe(childWidth)
    expect(worldMatrix(editor.state.doc, instanceId)).toEqual(instanceWorld)
    success(call('history.undo')); expect(editor.state.doc.nodes[instanceId].instance?.componentId).toBe(mainId)
  })

})
