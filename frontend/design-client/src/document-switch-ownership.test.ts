import { afterEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, type DesignDocument } from './model'
import { DesktopSession, type LeaveDecision } from './desktop-session'
import { prepareDocument, forkPreparedDocument, takePreparedDocument } from './prepared-document'
import * as picking from './kernel/picking'
import type { DesktopBridge, WorkspaceOpened } from './desktop'
const sessions: DesktopSession[] = []
const ok = { status: 'ok' } as const
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
function fixture() {
  const document = blank('Target'), editor = new Editor(blank()), rows = new Map<string, WorkspaceOpened>()
  const row = (d: DesignDocument) => ({ id: d.id, name: d.name, revision: 1, hash: 'unchanged-label', updatedAt: 1, deleted: false, documentJson: JSON.stringify(d) })
  const open = vi.fn(async ({ id }: { id: string }) => rows.has(id) ? { ...ok, ...rows.get(id)! } : { status: 'error' as const, code: 'WORKSPACE_NOT_FOUND', message: 'missing' })
  const decode = vi.fn(async (json: string) => JSON.parse(json))
  const commit = vi.fn(async ({ documentJson }: { documentJson: string }) => { const d = JSON.parse(documentJson), next = { ...row(d), revision: (rows.get(d.id)?.revision || 0) + 1 }; rows.set(d.id, next); return { ...ok, ...next } })
  const bridge = { version: 1, documentCodec: { decode, encode: async (d: DesignDocument) => JSON.stringify(d) }, workspace: { open, commit, list: async () => ({ ...ok, documents: [] }) }, readRecovery: async () => ({ status: 'cancelled' }), clearRecovery: async () => ok, writeRecovery: async () => ok, setDirty: async () => {} } as unknown as DesktopBridge
  const confirm = vi.fn(async (): Promise<LeaveDecision> => 'discard'), session = new DesktopSession(bridge, editor, confirm)
  sessions.push(session); rows.set(document.id, row(document))
  return { document, editor, rows, row, open, decode, commit, confirm, session }
}
afterEach(() => { sessions.splice(0).forEach(s => s.dispose()); vi.restoreAllMocks() })
test('identical fresh bytes decode and prepare exactly once, while reading the durable head twice', async () => {
  const f = fixture(), prepare = vi.spyOn(picking, 'prepareDocumentForEditing')
  expect(await f.session.openWorkspace(f.document.id)).toBe(true)
  expect(f.open).toHaveBeenCalledTimes(2); expect(f.decode).toHaveBeenCalledTimes(1); expect(prepare).toHaveBeenCalledTimes(1)
  expect(f.editor.state.doc.id).toBe(f.document.id); expect(f.session.dirty).toBe(false)
})
test('changed bytes with identical revision/hash labels must be decoded and validated again', async () => {
  const f = fixture(), changed = { ...f.document, name: 'Changed under identical labels' }
  f.open.mockImplementationOnce(async () => { const result = { ...ok, ...f.rows.get(f.document.id)! }; f.rows.set(f.document.id, f.row(changed)); return result })
  expect(await f.session.openWorkspace(f.document.id)).toBe(true)
  expect(f.decode).toHaveBeenCalledTimes(2); expect(f.editor.state.doc.name).toBe(changed.name)
})
test('fresh invalid content with identical labels preserves current document and undo', async () => {
  const f = fixture(); f.editor.change('Current edit', d => { d.name = 'Keep' }); const before = f.editor.state.doc
  f.open.mockImplementationOnce(async () => { const result = { ...ok, ...f.rows.get(f.document.id)! }; f.rows.get(f.document.id)!.documentJson = '{'; return result })
  expect(await f.session.openWorkspace(f.document.id)).toBe(false); expect(f.editor.state.doc).toBe(before); expect(f.editor.canUndo).toBe(true)
})
test.each(['missing', 'deleted', 'wrong-id'] as const)('fresh target %s cannot consume the old prepared target', async kind => {
  const f = fixture(), before = f.editor.state.doc
  f.open.mockImplementationOnce(async () => { const result = { ...ok, ...f.rows.get(f.document.id)! }; if (kind === 'missing') f.rows.delete(f.document.id); else if (kind === 'deleted') f.rows.get(f.document.id)!.deleted = true; else f.rows.get(f.document.id)!.id = 'wrong-id'; return result })
  expect(await f.session.openWorkspace(f.document.id)).toBe(false); expect(f.editor.state.doc).toBe(before)
})
test('cancel after validation retains dirty document and avoids the fresh-head read', async () => {
  const f = fixture(); await f.session.start(); f.editor.change('Current edit', d => { d.name = 'Keep' }); const before = f.editor.state.doc
  f.confirm.mockResolvedValueOnce('cancel')
  expect(await f.session.openWorkspace(f.document.id)).toBe(false); expect(f.editor.state.doc).toBe(before); expect(f.open).toHaveBeenCalledTimes(1); expect(f.session.dirty).toBe(true)
})
test('Save of the same target advances its bytes and cannot adopt the pre-save prepared snapshot', async () => {
  const f = fixture(); await f.session.start(); expect(await f.session.openWorkspace(f.document.id)).toBe(true)
  f.editor.change('Save newer edit', d => { d.name = 'Newest saved version' }); f.confirm.mockResolvedValueOnce('save'); f.decode.mockClear()
  expect(await f.session.openWorkspace(f.document.id)).toBe(true); expect(f.editor.state.doc.name).toBe('Newest saved version'); expect(f.decode).toHaveBeenCalledTimes(2); expect(f.session.dirty).toBe(false)
})
test('edits during the fresh-head await keep the newer document and undo history', async () => {
  const f = fixture(), gate = deferred<any>(); f.open.mockResolvedValueOnce({ ...ok, ...f.rows.get(f.document.id)! }); f.open.mockReturnValueOnce(gate.promise)
  const pending = f.session.openWorkspace(f.document.id); await flush(); f.editor.change('Late edit', d => { d.name = 'Keep late' }); const before = f.editor.state.doc
  gate.resolve({ ...ok, ...f.rows.get(f.document.id)! }); expect(await pending).toBe(false); expect(f.editor.state.doc).toBe(before); expect(f.editor.canUndo).toBe(true)
})
test('disposal during a pending fresh read prevents adoption and repeated navigation remains gated', async () => {
  const f = fixture(), gate = deferred<any>(), before = f.editor.state.doc
  f.open.mockResolvedValueOnce({ ...ok, ...f.rows.get(f.document.id)! }); f.open.mockReturnValueOnce(gate.promise)
  const pending = f.session.openWorkspace(f.document.id); await flush(); expect(await f.session.openWorkspace(f.document.id)).toBe(false)
  f.session.dispose(); gate.resolve({ ...ok, ...f.rows.get(f.document.id)! }); expect(await pending).toBe(false); expect(f.editor.state.doc).toBe(before)
})
test('identity fork consumes its old owner and remains isolated from caller and snapshot aliases', () => {
  const source = blank('Private owner'), original = prepareDocument(source), copy = original.snapshot(), fork = forkPreparedDocument(original)
  expect(fork.id).not.toBe(original.id); expect(() => takePreparedDocument(original)).toThrow('已被接收'); expect(() => forkPreparedDocument(original)).toThrow('已被接收')
  source.name = 'mutated'; copy.name = 'mutated'; const owned = takePreparedDocument(fork)!
  expect(owned.name).toBe('Private owner'); expect(owned.id).toBe(fork.id); expect(() => takePreparedDocument(fork)).toThrow('已被接收')
})

test('a bridge mutating its old response object cannot counterfeit exact-byte reuse', async () => {
  const f = fixture(), shared = { ...ok, ...f.rows.get(f.document.id)! }
  f.open.mockImplementationOnce(async () => shared)
  f.open.mockImplementationOnce(async () => { shared.documentJson = JSON.stringify({ ...f.document, name: 'Fresh mutated response' }); return shared })
  expect(await f.session.openWorkspace(f.document.id)).toBe(true); expect(f.decode).toHaveBeenCalledTimes(2); expect(f.editor.state.doc.name).toBe('Fresh mutated response')
})
