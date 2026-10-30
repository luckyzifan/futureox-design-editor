import { afterEach, expect, test } from 'vitest'
import { Editor } from '../engine'
import { blank, node } from '../model'
import { createEditorDesignAutomation } from './index'
import type { AutomationResponse } from './types'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()) })
function fixture() {
  const doc = blank('Old owner'), a = node('rectangle'), b = node('rectangle', 100, 0), c = node('rectangle', 200, 0)
  doc.nodes = { [a.id]: a, [b.id]: b, [c.id]: c }; doc.pages[0].children = [a.id, b.id, c.id]
  const second = { ...doc.pages[0], id: crypto.randomUUID(), name: 'Second', children: [] as string[] }
  doc.pages.push(second)
  const editor = new Editor(doc), api = createEditorDesignAutomation(editor)
  cleanups.push(() => editor.dispose(), () => api.dispose()); editor.select([a.id])
  const owner = { documentId: editor.state.doc.id, session: editor.sessionGeneration, expectedRevision: editor.state.version }
  const request = { method: 'batch.apply', ...owner, params: { mutationId: 'committed-owner-probe', operations: [
    { method: 'node.update', params: { ids: [a.id], patch: { name: 'Committed old owner' } } },
    { method: 'selection.set', params: { ids: [b.id] } },
  ] } }
  return { doc, a, b, c, second, editor, api, owner, request }
}
function successful(response: AutomationResponse) {
  expect(response.ok, JSON.stringify(response)).toBe(true)
  if (!response.ok) throw Error(response.error.message)
  return response.result as Record<string, any>
}
function assertOriginalCommit(f: ReturnType<typeof fixture>, response: AutomationResponse) {
  expect(response).toMatchObject({ documentId: f.owner.documentId, session: f.owner.session, revision: f.owner.expectedRevision + 1 })
  const result = successful(response)
  expect(result.noChange).toBe(false)
  expect(result.changedIds).toEqual([f.a.id]); expect(result.createdIds).toEqual([])
  expect(result.completion).toEqual({ status: 'committed', superseded: true, contextApplied: false, retry: 'do-not-retry',
    documentId: f.owner.documentId, session: f.owner.session, revision: f.owner.expectedRevision + 1 })
  expect(result.receipt.revision).toBe(f.owner.expectedRevision + 1)
  expect(JSON.stringify(result)).not.toContain('PRIVATE_NEW_OWNER_VALUE')
  return result
}

test.each(['different-id', 'same-id'] as const)('%s load during commit cannot replace the result owner or receive stale selection', replacement => {
  const f = fixture(); let entered = false, adopted!: Editor['state']
  const off = f.editor.subscribe(() => {
    if (entered || f.editor.state.version !== f.owner.expectedRevision + 1) return
    entered = true
    const next = structuredClone(f.doc); if (replacement === 'different-id') next.id = crypto.randomUUID()
    next.name = 'PRIVATE_NEW_OWNER_VALUE'; next.nodes[f.b.id].name = 'PRIVATE_NEW_OWNER_VALUE'
    expect(f.editor.load(next)).toBe(true); f.editor.select([f.c.id]); adopted = f.editor.state
  }); cleanups.push(off)
  const response = f.api.execute(f.request), result = assertOriginalCommit(f, response)
  expect(entered).toBe(true); expect(f.editor.state).toBe(adopted); expect(f.editor.state.selection).toEqual([f.c.id])
  expect(result.receipt.replayAvailable).toBe(false)
  const retry = f.api.execute(f.request)
  expect(retry.ok).toBe(false); expect(f.editor.state).toBe(adopted)
})

test('a same-session nested edit is not included in the earlier commit diff or revision', () => {
  const f = fixture(); let entered = false, after!: Editor['state']
  const off = f.editor.subscribe(() => {
    if (entered || f.editor.state.version !== f.owner.expectedRevision + 1) return
    entered = true
    f.editor.change('Later subscriber edit', d => { d.nodes[f.b.id].name = 'PRIVATE_NEW_OWNER_VALUE' })
    f.editor.select([f.c.id]); after = f.editor.state
  }); cleanups.push(off)
  const response = f.api.execute(f.request); assertOriginalCommit(f, response)
  expect(f.editor.state).toBe(after); expect(f.editor.state.version).toBe(f.owner.expectedRevision + 2)
  const replay = successful(f.api.execute(f.request))
  expect(replay.receipt.replayed).toBe(true); expect(replay.receipt.revision).toBe(f.owner.expectedRevision + 1)
  expect(f.editor.state).toBe(after)
})

test('a load during post-commit page publication cannot receive the remaining context or contaminate the result', () => {
  const f = fixture(); let entered = false, adopted!: Editor['state']
  f.request.params.operations.splice(1, 1, { method: 'page.setCurrent', params: { id: f.second.id } } as any)
  const off = f.editor.subscribe(() => {
    if (entered || f.editor.state.page !== f.second.id || f.editor.state.version !== f.owner.expectedRevision + 1) return
    entered = true
    const next = structuredClone(f.doc); next.id = crypto.randomUUID(); next.name = 'PRIVATE_NEW_OWNER_VALUE'
    expect(f.editor.load(next)).toBe(true); f.editor.select([f.c.id]); adopted = f.editor.state
  }); cleanups.push(off)
  const response = f.api.execute(f.request); assertOriginalCommit(f, response)
  expect(entered).toBe(true); expect(f.editor.state).toBe(adopted)
})
