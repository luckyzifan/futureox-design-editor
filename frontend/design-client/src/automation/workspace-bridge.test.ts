import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '../engine'
import { blank } from '../model'
import { registerPendingEdit } from '../pending-edits'
import type { DesktopAutomationRequest } from './bridge'
import { createWorkspaceAutomationRenderer, type WorkspaceAutomationAdapter } from './workspace-bridge'
const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()))
function fixture() {
  const editor = new Editor(blank('Workspace adapter')); cleanup.push(() => editor.dispose())
  const state = { storageRevision: 2, dirty: false, busy: false }
  const execute = vi.fn<WorkspaceAutomationAdapter['execute']>(async () => ({ revision: 3 }))
  const host = createWorkspaceAutomationRenderer(editor, { inspect: () => state, execute })
  const payload = (method = 'workspace.save', params: Record<string, unknown> = { expectedStorageRevision: 2, mutationId: 'save' }): DesktopAutomationRequest => ({ requestId: 'request', kind: 'host', scope: 'read', sessionId: 'owner',
    documentId: editor.state.doc.id, session: editor.sessionGeneration, deadline: Date.now() + 10000,
    request: { method, documentId: editor.state.doc.id, session: editor.sessionGeneration, expectedRevision: editor.state.version }, hostOperation: { method, params } })
  return { editor, state, execute, host, payload, call: (value = payload(), signal = new AbortController().signal) => host.execute(value, signal) }
}
describe('trusted renderer workspace factory with real Editor', () => {
  it('inspects actual editor identity and delegates exact guarded operations without requiring document write permission', async () => {
    const f = fixture()
    expect(await f.call(f.payload('inspect', {}))).toMatchObject({ documentId: f.editor.state.doc.id, revision: 0, storageRevision: 2, pendingEdits: false })
    expect(await f.call()).toEqual({ revision: 3 })
    expect(f.execute).toHaveBeenCalledWith('workspace.save', { expectedStorageRevision: 2, mutationId: 'save' }, { documentId: f.editor.state.doc.id, session: f.editor.sessionGeneration, expectedRevision: 0, grantSessionId: 'owner' }, expect.any(AbortSignal))
  })
  it('preserves an uncommitted input and rejects stale revisions before the adapter can write', async () => {
    const f = fixture(), commit = vi.fn(() => true)
    const stop = registerPendingEdit(f.editor, { dirty: () => true, commit }); cleanup.push(stop)
    await expect(f.call()).rejects.toMatchObject({ code: 'PENDING_EDITS' }); expect(commit).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled()
    stop()
    const stale = f.payload(); f.editor.change('Manual rename', document => { document.name = 'New edit' })
    await expect(f.call(stale)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' }); expect(f.execute).not.toHaveBeenCalled()
  })
  it('blocks dirty navigation and busy editor operations but still permits metadata reads', async () => {
    const f = fixture(); f.state.dirty = true
    await expect(f.call(f.payload('workspace.open', { id: 'issued-by-native-host' }))).rejects.toMatchObject({ code: 'DIRTY_DOCUMENT' })
    await expect(f.call(f.payload('workspace.restore', { id: 'native-id', revision: 1, expectedStorageRevision: 2, mutationId: 'restore' }))).rejects.toMatchObject({ code: 'DIRTY_DOCUMENT' })
    expect(await f.call(f.payload('inspect', {}))).toMatchObject({ dirty: true })
    f.state.dirty = false; f.editor.set({ busy: true }); expect(await f.call(f.payload('inspect', {}))).toMatchObject({ busy: true }); f.editor.set({ busy: false }); f.state.busy = true
    await expect(f.call()).rejects.toMatchObject({ code: 'BUSY' }); expect(f.execute).not.toHaveBeenCalled()
  })
  it('rejects malformed internal operations, wrong owner identity, expired or cancelled calls', async () => {
    const f = fixture()
    await expect(f.call(f.payload('shell.execute', { command: 'anything' }))).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    await expect(f.call(f.payload('workspace.save', { path: '/private', mutationId: 'wrong' }))).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    for (const mutationId of ['', 'save:1', 'save.1', 'x'.repeat(129), '非ASCII']) await expect(f.call(f.payload('workspace.save', { expectedStorageRevision: 2, mutationId }))).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    await expect(f.call(f.payload('workspace.save', { mutationId: 'missing-cas' }))).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    await expect(f.call({ ...f.payload(), documentId: 'different' })).rejects.toMatchObject({ code: 'STALE_SESSION' })
    await expect(f.call({ ...f.payload(), deadline: Date.now() - 1 })).rejects.toMatchObject({ code: 'TIMEOUT' })
    const controller = new AbortController(); controller.abort(Object.assign(new Error('revoked'), { code: 'SESSION_CLOSED' }))
    await expect(f.call(f.payload(), controller.signal)).rejects.toMatchObject({ code: 'SESSION_CLOSED' }); expect(f.execute).not.toHaveBeenCalled()
  })
  it('does not label a completed result with an editor session that changed across an await', async () => {
    const f = fixture(); let finish!: (value: unknown) => void
    f.execute.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const running = f.call(); f.editor.load(blank('Different design')); finish({ opened: true })
    await expect(running).rejects.toMatchObject({ code: 'STALE_SESSION' })
  })
})
