import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '../engine'
import { blank, defaultTextStyle, node } from '../model'
import { createEditorDesignAutomation } from './index'
import { createDesignAutomation } from './core'
import type { AutomationPermissionPolicy } from './permissions'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach(editor => editor.dispose()))
function fixture(count = 3, permissions?: (documentId: string) => AutomationPermissionPolicy) {
  const document = blank('Explicit bulk edits')
  const nodes = Array.from({ length: count }, (_, i) => {
    const n = node('text', i * 20, 0, 100, 40)
    n.name = `Label ${i}`; n.text = `Hello ${i}`; n.textStyle = defaultTextStyle()
    n.textRuns = [{ start: 0, end: 5, weight: 700 }]
    document.nodes[n.id] = n; document.pages[0].children.push(n.id)
    return n
  })
  const editor = new Editor(document); editors.push(editor)
  const api = createEditorDesignAutomation(editor, permissions?.(document.id))
  const call = (method: string, params: Record<string, unknown> = {}) => api.execute({ method, params,
    documentId: editor.state.doc.id, session: editor.sessionGeneration, expectedRevision: editor.state.version })
  return { editor, api, nodes, call }
}
function success(value: ReturnType<ReturnType<typeof fixture>['call']>) { expect(value.ok, JSON.stringify(value)).toBe(true) }

describe('compact explicit multi-target edits', () => {
  it('changes per-target leaves and keeps one native undo, exact untouched fields, and redo', () => {
    const f = fixture(), before = f.editor.state.doc
    success(f.call('node.patchMany', { targets: f.nodes.map((n, i) => ({ nodeId: n.id,
      patch: { name: `New ${i}`, width: 120 + i, textStyle: { weight: 500 + i } }, expected: { name: n.name, width: n.width } })) }))
    const after = f.editor.state.doc
    for (const [i, n] of f.nodes.entries()) {
      expect(after.nodes[n.id]).toEqual({ ...before.nodes[n.id], name: `New ${i}`, width: 120 + i,
        textStyle: { ...before.nodes[n.id].textStyle, weight: 500 + i } })
    }
    success(f.call('history.undo')); expect(f.editor.state.doc).toEqual(before); expect(f.editor.canUndo).toBe(false)
    success(f.call('history.redo')); expect(f.editor.state.doc).toEqual(after)
  })
  it('uses existing rich-text range replacement and preserves outside styles', () => {
    const f = fixture()
    success(f.call('text.replaceMany', { targets: f.nodes.map(n => ({ nodeId: n.id, start: 6, end: 7, expectedText: n.text.slice(6), text: 'world' })) }))
    for (const n of f.nodes) { expect(f.editor.state.doc.nodes[n.id].text).toBe('Hello world'); expect(f.editor.state.doc.nodes[n.id].textRuns).toEqual(n.textRuns) }
  })
  it('rejects last-target conflicts, missing nodes, locked targets and invalid schemas without partial commit', () => {
    for (const failure of ['conflict', 'missing', 'locked', 'schema']) {
      const f = fixture()
      if (failure === 'locked') success(f.call('node.patch', { ids: [f.nodes[2].id], patch: { locked: true } }))
      const before = f.editor.state.doc, revision = f.editor.state.version
      const targets = f.nodes.map(n => ({ nodeId: n.id, patch: { name: 'Changed' }, expected: { name: n.name } }))
      if (failure === 'conflict') targets[2].expected.name = 'Wrong'
      if (failure === 'missing') targets[2].nodeId = 'missing-node'
      if (failure === 'schema') Object.assign(targets[2].patch, { madeUp: 1 })
      expect(f.call('node.patchMany', { targets }).ok).toBe(false)
      expect(f.editor.state.doc).toBe(before); expect(f.editor.state.version).toBe(revision)
    }
  })
  it('rejects duplicate targets and oversized work, including expanded work nested in batch.apply', () => {
    const f = fixture(), before = f.editor.state.doc
    const target = { nodeId: f.nodes[0].id, patch: { name: 'Changed' } }
    expect(f.call('node.patchMany', { targets: [target, target] }).ok).toBe(false)
    expect(f.call('node.patchMany', { targets: Array.from({ length: 501 }, (_, i) => ({ ...target, nodeId: `node-${i}` })) }).ok).toBe(false)
    const targets = Array.from({ length: 251 }, (_, i) => ({ ...target, nodeId: `node-${i}` }))
    expect(f.call('batch.apply', { operations: [0, 1].map(() => ({ method: 'node.patchMany', params: { targets } })) })).toMatchObject({ ok: false, error: { code: 'invalid_params', message: 'A request must contain 1–500 expanded mutation operations' } })
    expect(f.editor.state.doc).toBe(before); expect(f.editor.canUndo).toBe(false)
  })
  it('supports authored preflight without consuming history and nested bulk receipt retry', () => {
    const f = fixture(), before = f.editor.state.doc
    const operations = [{ method: 'node.patchMany', params: { targets: f.nodes.map(n => ({ nodeId: n.id, patch: { name: 'Prepared' }, expected: { name: n.name } })) } }]
    success(f.call('batch.preflight', { operations })); expect(f.editor.state.doc).toBe(before); expect(f.editor.canUndo).toBe(false)
    const request = { method: 'batch.apply', params: { operations, mutationId: 'bulk-retry' }, documentId: before.id,
      session: f.editor.sessionGeneration, expectedRevision: f.editor.state.version }
    success(f.api.execute(request)); const after = f.editor.state.doc
    success(f.api.execute(request)); expect(f.editor.state.doc).toBe(after)
    success(f.call('history.undo')); expect(f.editor.state.doc).toEqual(before); expect(f.editor.canUndo).toBe(false)
    const capabilities = f.api.capabilities()
    expect((capabilities.editing?.preflight as { methods: string[] }).methods).toContain('node.patchMany')
    expect(() => structuredClone(capabilities)).not.toThrow()
  })
  it('shares paint and rich style validation and preserves all untargeted data', () => {
    const f = fixture(), before = f.editor.state.doc
    success(f.call('paint.patchMany', { targets: f.nodes.map(n => ({ nodeId: n.id, target: 'fill', paintId: n.fills[0].id,
      patch: { opacity: 0.5 }, expected: { opacity: n.fills[0].opacity } })) }))
    for (const n of f.nodes) expect(f.editor.state.doc.nodes[n.id].fills[0]).toEqual({ ...before.nodes[n.id].fills[0], opacity: 0.5 })
    success(f.call('text.styleMany', { targets: f.nodes.map(n => ({ nodeId: n.id, start: 0, end: 5, expectedText: 'Hello', patch: { weight: 800 } })) }))
    for (const n of f.nodes) expect(f.editor.state.doc.nodes[n.id].textRuns?.[0].weight).toBe(800)
  })
  it('requires expected text, preserves no-op history, and honors stale revisions', () => {
    const f = fixture(), before = f.editor.state.doc
    success(f.call('node.patchMany', { targets: f.nodes.map(n => ({ nodeId: n.id, patch: { name: n.name } })) }))
    expect(f.editor.canUndo).toBe(false); expect(f.editor.state.doc).toBe(before)
    expect(f.call('text.replaceMany', { targets: [{ nodeId: f.nodes[0].id, start: 0, end: 5, text: 'Bye' }] })).toMatchObject({ ok: false, error: { code: 'invalid_params' } })
    expect(f.api.execute({ method: 'node.patchMany', params: { targets: [{ nodeId: f.nodes[0].id, patch: { name: 'Stale' } }] },
      documentId: before.id, session: f.editor.sessionGeneration, expectedRevision: 999 })).toMatchObject({ ok: false, error: { code: 'stale_revision' } })
    expect(f.editor.state.doc).toBe(before)
  })
  it('rejects recursive trusted expansion before executing a leaf', () => {
    const f = fixture(), before = f.editor.state.doc
    let executed = false
    const api = createDesignAutomation(f.editor, [{ name: 'test.recursive', mutates: true, description: 'Invalid recursive wrapper',
      inputSchema: { type: 'object' }, expand: () => [{ method: 'test.recursive' }], execute: () => { executed = true } }])
    expect(api.execute({ method: 'test.recursive', documentId: before.id, session: f.editor.sessionGeneration,
      expectedRevision: f.editor.state.version })).toMatchObject({ ok: false, error: { code: 'invalid_operation' } })
    expect(executed).toBe(false); expect(f.editor.state.doc).toBe(before)
    api.dispose()
  })
  it('requires both wrapper and underlying permissions in the exact document session', () => {
    for (const operations of [['node.patchMany'], ['node.patch']]) {
      const f = fixture(3, documentId => ({ grants: [{ resource: { documentId, session: 0 }, access: 'write', operations }] }))
      const before = f.editor.state.doc
      expect(f.call('node.patchMany', { targets: [{ nodeId: f.nodes[0].id, patch: { name: 'Denied' } }] })).toMatchObject({ ok: false, error: { code: 'permission_denied' } })
      expect(f.editor.state.doc).toBe(before)
    }
    const f = fixture(3, documentId => ({ grants: [{ resource: { documentId, session: 0 }, access: 'write', operations: ['node.patchMany', 'node.patch'] }] }))
    success(f.call('node.patchMany', { targets: [{ nodeId: f.nodes[0].id, patch: { name: 'Allowed' } }] }))
  })
})
