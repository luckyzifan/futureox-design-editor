import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '../engine'
import { blank, node } from '../model'
import { createDesignAutomation } from './core'
import { LocalAutomationPermissions, type AutomationPermissionPolicy } from './permissions'
import type { AutomationExtension } from './types'
const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach(editor => editor.dispose()))
function setup(operations: string[], access: 'read' | 'write' = 'write', extensions: AutomationExtension[] = []) {
  const document = blank('Scoped'), n = node('rectangle', 0, 0, 20, 20)
  document.nodes[n.id] = n; document.pages[0].children.push(n.id)
  const editor = new Editor(document); editors.push(editor)
  const policy: AutomationPermissionPolicy = { grants: [{ resource: { documentId: document.id, session: editor.sessionGeneration }, operations, access }] }
  const api = createDesignAutomation(editor, extensions, [], policy)
  const call = (method: string, params = {}) => api.execute({ method, params, documentId: editor.state.doc.id, session: editor.sessionGeneration, expectedRevision: editor.state.version })
  return { editor, n, policy, api, call }
}
function denied(response: ReturnType<ReturnType<typeof createDesignAutomation>['execute']>, code = 'permission_denied') {
  expect(response.ok).toBe(false)
  if (!response.ok) expect(response.error.code).toBe(code)
}
describe('local operation and document-session authority at actual dispatcher', () => {
  it('defaults to deny for an explicit empty policy; unknown actions cannot execute', () => {
    const { api, call, editor } = setup([])
    expect(api.methods()).toEqual([])
    denied(call('document.get')); denied(call('history.undo'))
    denied(call('future.execute'), 'unsupported_method')
    expect(editor.canUndo).toBe(false)
  })
  it('filters capabilities and enforces positive and negative method grants', () => {
    const { api, call, editor, n } = setup(['api.capabilities', 'document.get', 'node.update'])
    expect(api.methods().map(m => m.name)).toEqual(['api.capabilities', 'document.get', 'node.update'])
    expect(call('document.get').ok).toBe(true)
    expect(call('node.update', { ids: [n.id], patch: { name: 'Allowed' } }).ok).toBe(true)
    expect(editor.state.doc.nodes[n.id].name).toBe('Allowed')
    const before = editor.state.doc
    denied(call('node.delete', { ids: [n.id] })); denied(call('history.undo'))
    expect(editor.state.doc).toBe(before)
    expect(editor.canUndo).toBe(true)
  })
  it('read-only access cannot acquire write via method name or a batch', () => {
    const { api, call, n } = setup(['document.get', 'node.update', 'batch.apply'], 'read')
    expect(api.methods().map(m => m.name)).toEqual(['document.get'])
    denied(call('node.update', { ids: [n.id], patch: { name: 'No' } }))
    denied(call('batch.apply', { operations: [{ method: 'node.update', params: { ids: [n.id], patch: { name: 'No' } } }] }))
  })
  it('checks every batch grant before any extension executes or state/history publishes', () => {
    const execute = vi.fn(() => null)
    const extension = { name: 'test.touch', description: 'test', mutates: true, inputSchema: { type: 'object' }, execute }
    const { call, editor, n } = setup(['batch.apply', 'test.touch'], 'write', [extension])
    const before = editor.state.doc, revision = editor.state.version
    denied(call('batch.apply', { operations: [ { method: 'test.touch' }, { method: 'node.update', params: { ids: [n.id], patch: { name: 'No' } } } ] }))
    expect(execute).not.toHaveBeenCalled(); expect(editor.state.doc).toBe(before)
    expect(editor.state.version).toBe(revision); expect(editor.canUndo).toBe(false)
  })
  it('commits permitted batches once and retains ordinary locked-node invariants', () => {
    const { call, editor, n } = setup(['batch.apply', 'node.update'])
    const before = editor.state.version
    expect(call('batch.apply', { operations: [{ method: 'node.update', params: { ids: [n.id], patch: { name: 'Yes' } } }] }).ok).toBe(true)
    expect(editor.state.version).toBe(before + 1)
    editor.update([n.id], { locked: true })
    denied(call('node.update', { ids: [n.id], patch: { name: 'No' } }), 'locked_node')
    expect(editor.state.doc.nodes[n.id].name).toBe('Yes')
  })
  it('cannot mutate a policy after construction or carry authority to another session', () => {
    const { api, call, policy, editor } = setup(['document.get'])
    ;(policy.grants[0].operations as string[]).push('history.undo')
    denied(call('history.undo'))
    const permissions = new LocalAutomationPermissions(policy), method = { name: 'document.get', mutates: false, description: '', inputSchema: {} }
    expect(permissions.allows(method, { documentId: editor.state.doc.id, session: editor.sessionGeneration + 1 })).toBe(false)
    expect(permissions.allows(method, { documentId: 'other', session: editor.sessionGeneration })).toBe(false)
    expect(permissions.allows(undefined, policy.grants[0].resource)).toBe(false)
    expect(api.methods().map(m => m.name)).toEqual(['document.get'])
    editor.load(blank('Replacement'))
    denied(call('document.get'))
    expect(api.methods()).toEqual([])
  })
  it('denies nested preflight operations and re-opening the same document', () => {
    const { api, call, editor, n } = setup(['batch.preflight', 'document.get'], 'read')
    denied(call('batch.preflight', { operations: [{ method: 'node.patch', params: { ids: [n.id], patch: { name: 'No' } } }] }))
    expect((api.capabilities().editing?.preflight as { methods: string[] }).methods).toEqual([])
    expect(api.capabilities().editing?.granular).toEqual([])
    const id = editor.state.doc.id
    editor.load(structuredClone(editor.state.doc))
    expect(editor.state.doc.id).toBe(id)
    denied(call('document.get'))
    expect(editor.canUndo).toBe(false)
  })
  it('rejects unrecognized policy shape, wildcard actions and request-supplied grants', () => {
    expect(() => new LocalAutomationPermissions({ grants: [{ resource: { documentId: 'doc', session: 0 }, operations: ['*'], access: 'write' }] })).toThrow()
    expect(() => new LocalAutomationPermissions({ grants: [], future: true } as unknown as AutomationPermissionPolicy)).toThrow()
    expect(() => new LocalAutomationPermissions({ grants: Array(257).fill({}) })).toThrow()
    const { api } = setup(['document.get'])
    denied(api.execute({ method: 'document.get', permissions: { grants: [] } }), 'invalid_request')
  })
})
