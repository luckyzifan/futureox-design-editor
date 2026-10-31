import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '../engine'
import { blank } from '../model'
import { DesktopSession } from '../desktop-session'
import type { DesktopBridge, WorkspaceBridge, WorkspaceDocument, WorkspaceOpened } from '../desktop'
import { registerPendingEdit } from '../pending-edits'
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()); vi.restoreAllMocks() })
const ok = { status: 'ok' } as const
const cancelled = { status: 'cancelled' } as const
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
async function fixture() {
  const rows = new Map<string, WorkspaceOpened>(), history = new Map<string, WorkspaceOpened[]>(), receipts = new Map<string, WorkspaceDocument>()
  const store: WorkspaceBridge = {
    list: vi.fn<WorkspaceBridge['list']>(async () => ({ ...ok, documents: [...rows.values()] })),
    open: vi.fn<WorkspaceBridge['open']>(async ({ id, revision }) => { const row = revision ? history.get(id)?.find(row => row.revision === revision) : rows.get(id); return row ? { ...ok, ...row } : { status: 'error', code: 'WORKSPACE_NOT_FOUND', message: 'missing' } }),
    commit: vi.fn<WorkspaceBridge['commit']>(async request => {
      if (receipts.has(request.mutationId)) return { ...ok, ...receipts.get(request.mutationId)! }
      const document = JSON.parse(request.documentJson), prior = rows.get(document.id)
      if ((prior?.revision ?? null) !== request.expectedRevision) return { status: 'conflict', code: 'WORKSPACE_CONFLICT', message: 'changed' }
      const row = { id: document.id, name: document.name, revision: (prior?.revision ?? 0) + 1, hash: 'snapshot-hash', updatedAt: Date.now(), deleted: false, documentJson: request.documentJson }
      rows.set(row.id, row); history.set(row.id, [...history.get(row.id) ?? [], row]); receipts.set(request.mutationId, row)
      return { ...ok, ...row }
    }),
    revisions: vi.fn<WorkspaceBridge['revisions']>(async ({ id }) => ({ ...ok, revisions: history.get(id) ?? [] })),
    trash: vi.fn<WorkspaceBridge['trash']>(async () => cancelled),
    restore: vi.fn<WorkspaceBridge['restore']>(async request => {
      if (receipts.has(request.mutationId)) return { ...ok, ...receipts.get(request.mutationId)!, documentJson: rows.get(request.id)!.documentJson }
      const previous = rows.get(request.id)!, selected = history.get(request.id)!.find(row => row.revision === request.revision)!
      if (previous.revision !== request.expectedRevision) return { status: 'conflict', code: 'WORKSPACE_CONFLICT', message: 'changed' }
      const row = { ...selected, revision: previous.revision + 1 }
      rows.set(row.id, row); history.set(row.id, [...history.get(row.id)!, row]); receipts.set(request.mutationId, row)
      return { ...ok, ...row }
    }),
  }
  const bridge = { workspace: store, version: 1, readRecovery: async () => cancelled, writeRecovery: async () => ok, clearRecovery: async () => ok, setDirty: async () => {}, renderPolicy: { cpuOnly: true } } as unknown as DesktopBridge
  const editor = new Editor(blank('Current document')), confirm = vi.fn(async () => 'discard' as const), session = new DesktopSession(bridge, editor, confirm)
  cleanups.push(() => editor.dispose(), () => session.dispose())
  await session.start(); await session.save()
  const guard = () => ({ documentId: editor.state.doc.id, session: editor.sessionGeneration, expectedRevision: editor.state.version })
  const call = (method: 'workspace.open' | 'workspace.save' | 'workspace.restore', params: Record<string, unknown>, signal = new AbortController().signal) => session.automationWorkspace(method, params, guard(), signal)
  return { rows, history, receipts, store, bridge, editor, confirm, session, guard, call }
}
describe('actual DesktopSession and Editor automation boundaries', () => {
  it('clears a definitively rejected validation write but preserves the next manual Save', async () => {
    const f = await fixture()
    f.editor.change('Still savable', document => { document.name = 'Valid current draft' })
    vi.mocked(f.store.commit).mockResolvedValueOnce({ status: 'error', code: 'INVALID_REQUEST', message: 'Definitively rejected before commit' })
    await expect(f.call('workspace.save', { expectedStorageRevision: 1, mutationId: 'valid-id' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await f.session.save()).toBe(true); expect(f.session.dirty).toBe(false)
    expect(f.store.commit).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 1, mutationId: expect.not.stringContaining('valid-id') }))
  })
  it('saves immutable bytes with caller CAS and mutationId, returning metadata only', async () => {
    const f = await fixture(); f.editor.change('Rename', document => { document.name = 'Changed'; (document as unknown as Record<string, unknown>).privateBody = 'private snapshot content'.repeat(1000) })
    const result = await f.call('workspace.save', { expectedStorageRevision: 1, mutationId: 'caller-save' })
    expect(f.store.commit).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 1, mutationId: 'caller-save' }))
    expect(result.revision).toBe(2); expect(Object.keys(result).sort()).toEqual(['deleted', 'hash', 'id', 'name', 'revision', 'updatedAt'].sort())
    expect(JSON.stringify(result)).not.toContain('private snapshot'); expect(f.session.dirty).toBe(false)
  })
  it('opens a clean saved document without a discard prompt and strips its private JSON', async () => {
    const f = await fixture(), target = blank('Other saved document')
    ;(target as unknown as Record<string, unknown>).privateBody = 'private other document'.repeat(1000)
    await f.store.commit({ documentJson: JSON.stringify(target), expectedRevision: null, mutationId: 'seed-other' })
    const generation = f.editor.sessionGeneration
    const result = await f.call('workspace.open', { id: target.id })
    expect(f.editor.state.doc.id).toBe(target.id); expect(f.editor.sessionGeneration).toBeGreaterThan(generation)
    expect(f.confirm).not.toHaveBeenCalled(); expect(result).not.toHaveProperty('documentJson'); expect(JSON.stringify(result)).not.toContain('private other document')
  })
  it('does not commit pending input, permit gestures, or silently discard dirty documents', async () => {
    const f = await fixture(), commit = vi.fn(() => true), stop = registerPendingEdit(f.editor, { dirty: () => true, commit })
    await expect(f.call('workspace.save', { expectedStorageRevision: 1, mutationId: 'pending' })).rejects.toMatchObject({ code: 'PENDING_EDITS' })
    expect(commit).not.toHaveBeenCalled(); stop()
    const gesture = vi.spyOn(f.editor, 'interactionActive', 'get').mockReturnValue(true)
    await expect(f.call('workspace.save', { expectedStorageRevision: 1, mutationId: 'gesture' })).rejects.toMatchObject({ code: 'INTERACTION_ACTIVE' }); gesture.mockRestore()
    f.editor.change('New draft', document => { document.name = 'Keep this' })
    await expect(f.call('workspace.open', { id: 'other' })).rejects.toMatchObject({ code: 'DIRTY_DOCUMENT' }); expect(f.confirm).not.toHaveBeenCalled()
  })
  it('rejects a newer edit or revocation during async encoding before any durable write', async () => {
    const f = await fixture(), gate = deferred<string>(), encode = vi.fn(() => gate.promise)
    f.editor.change('Rename', document => { document.name = 'Before encoding' })
    Object.defineProperty(f.bridge, 'documentCodec', { value: { encode, decode: async (text: string) => JSON.parse(text) }, configurable: true })
    const calls = vi.mocked(f.store.commit).mock.calls.length, controller = new AbortController()
    const running = f.call('workspace.save', { expectedStorageRevision: 1, mutationId: 'encoded' }, controller.signal)
    await flush(); f.editor.change('Newer edit', document => { document.name = 'Keep latest' }); gate.resolve(JSON.stringify(f.editor.state.doc))
    await expect(running).rejects.toMatchObject({ code: 'REVISION_CONFLICT' }); expect(f.store.commit).toHaveBeenCalledTimes(calls); expect(f.editor.state.doc.name).toBe('Keep latest')
  })
  it('acknowledges only the submitted generation when a newer edit arrives during SQLite commit', async () => {
    const f = await fixture(), gate = deferred<Awaited<ReturnType<WorkspaceBridge['commit']>>>(), commit = vi.mocked(f.store.commit).getMockImplementation()!
    f.editor.change('Before save', document => { document.name = 'Persist exact snapshot' })
    vi.mocked(f.store.commit).mockImplementationOnce(async request => { const result = await commit(request); await gate.promise; return result })
    const running = f.call('workspace.save', { expectedStorageRevision: 1, mutationId: 'save-await' }); await flush()
    f.editor.change('During save', document => { document.name = 'Keep newer canvas' }); gate.resolve(cancelled)
    await expect(running).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(f.rows.get(f.editor.state.doc.id)?.name).toBe('Persist exact snapshot'); expect(f.editor.state.doc.name).toBe('Keep newer canvas'); expect(f.session.status).toMatchObject({ dirty: true, revision: 2 })
  })
  it('validates history before restoring, honors exact CAS, and preserves edits arriving after durable restore', async () => {
    const f = await fixture(), id = f.editor.state.doc.id
    f.editor.change('Second version', document => { document.name = 'Second' }); await f.session.save()
    await expect(f.call('workspace.restore', { id, revision: 1, expectedStorageRevision: 1, mutationId: 'no-max' })).rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
    expect(f.store.restore).toHaveBeenLastCalledWith({ id, revision: 1, expectedRevision: 1, mutationId: 'no-max' })
    const original = f.history.get(id)![0].documentJson; f.history.get(id)![0].documentJson = '{}'
    const count = vi.mocked(f.store.restore).mock.calls.length
    await expect(f.call('workspace.restore', { id, revision: 1, expectedStorageRevision: 2, mutationId: 'invalid-history' })).rejects.toThrow(); expect(f.store.restore).toHaveBeenCalledTimes(count)
    f.history.get(id)![0].documentJson = original
    const restore = vi.mocked(f.store.restore).getMockImplementation()!, gate = deferred<void>()
    vi.mocked(f.store.restore).mockImplementationOnce(async request => { const result = await restore(request); await gate.promise; return result })
    const running = f.call('workspace.restore', { id, revision: 1, expectedStorageRevision: 2, mutationId: 'restore-await' }); await flush()
    f.editor.change('Keep during restore', document => { document.name = 'New canvas edit' }); gate.resolve()
    await expect(running).rejects.toMatchObject({ code: 'REVISION_CONFLICT' }); expect(f.editor.state.doc.name).toBe('New canvas edit'); expect(f.rows.get(id)?.revision).toBe(3)
  })
  it('blocks a second automation write while the first persistence outcome is unresolved', async () => {
    const f = await fixture()
    vi.mocked(f.store.commit).mockResolvedValueOnce({ status: 'error', code: 'BACKEND_UNAVAILABLE', message: 'unknown outcome' })
    await expect(f.call('workspace.save', { expectedStorageRevision: 1, mutationId: 'uncertain' })).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
    const count = vi.mocked(f.store.commit).mock.calls.length
    await expect(f.call('workspace.save', { expectedStorageRevision: 1, mutationId: 'next' })).rejects.toMatchObject({ code: 'BUSY' }); expect(f.store.commit).toHaveBeenCalledTimes(count)
  })
})
