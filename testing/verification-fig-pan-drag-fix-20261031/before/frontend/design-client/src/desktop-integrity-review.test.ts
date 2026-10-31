import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'
import { DesktopSession } from './desktop-session'
import { dispatchEditorCommand } from './editor-commands'
import type { DesktopBridge, WorkspaceBridge, WorkspaceOpened, WorkspaceDocument } from './desktop'

// Independent review regressions. These exercise the actual session/editor and
// Rust/WASM admission code, with only the asynchronous storage/OS boundary mocked.
const sessions: DesktopSession[] = []
const ok = { status: 'ok' } as const
function fixture(initial = blank()) {
  const rows = new Map<string, WorkspaceOpened>()
  const receipts = new Map<string, WorkspaceDocument>()
  const store: WorkspaceBridge = {
    list: vi.fn(async () => ({ ...ok, documents: [...rows.values()] })),
    open: vi.fn(async ({ id }) => rows.has(id) ? { ...ok, ...rows.get(id)! } : { status: 'error' as const, code: 'WORKSPACE_NOT_FOUND', message: 'missing' }),
    commit: vi.fn(async request => {
      if (receipts.has(request.mutationId)) return { ...ok, ...receipts.get(request.mutationId)! }
      const document = JSON.parse(request.documentJson)
      const previous = rows.get(document.id)
      if ((previous?.revision ?? null) !== request.expectedRevision)
        return { status: 'conflict' as const, code: 'WORKSPACE_CONFLICT', message: 'revision changed' }
      const row = { id: document.id, name: document.name, revision: (previous?.revision || 0) + 1, hash: 'hash', updatedAt: 1, deleted: false, documentJson: request.documentJson }
      rows.set(document.id, row); receipts.set(request.mutationId, row)
      return { ...ok, ...row }
    }),
    trash: vi.fn(async () => { throw new Error('unused') }),
    revisions: vi.fn(async () => ({ ...ok, revisions: [] })),
    restore: vi.fn(async () => { throw new Error('unused') }),
  }
  const bridge = {
    version: 1, renderPolicy: { cpuOnly: true }, workspace: store,
    readRecovery: vi.fn(async () => ({ status: 'cancelled' } as const)),
    writeRecovery: vi.fn(async () => ok), clearRecovery: vi.fn(async () => ok),
    setDirty: vi.fn(async () => {}), acceptDocument: vi.fn(async () => ok),
    openDocument: vi.fn(async () => ({ status: 'cancelled' } as const)),
  } as unknown as DesktopBridge
  const editor = new Editor(initial)
  const confirm = vi.fn(async () => 'save' as const)
  const session = new DesktopSession(bridge, editor, confirm)
  sessions.push(session)
  const rename = (name: string) => editor.change('rename', document => { document.name = name })
  const row = (document: ReturnType<typeof blank>, revision = 1, updatedAt = 1) => ({ id: document.id, name: document.name, revision, updatedAt, hash: 'hash', deleted: false, documentJson: JSON.stringify(document) })
  return { rows, receipts, store, bridge, editor, session, confirm, rename, row }
}
afterEach(() => { sessions.splice(0).forEach(session => session.dispose()); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('desktop data integrity independent review', () => {
  it('opening the active library document after choosing Save never replaces the new head with the previously read old snapshot', async () => {
    vi.useFakeTimers()
    const f = fixture(); await f.session.start()
    f.rename('version one'); await f.session.save()
    const id = f.editor.state.doc.id
    f.rename('version two pending')
    expect(await f.session.openWorkspace(id)).toBe(true)
    expect(f.confirm).toHaveBeenCalledWith('open')
    expect(f.rows.get(id)?.name).toBe('version two pending')
    expect(f.editor.state.doc.name).toBe('version two pending')
    expect(f.session.status).toMatchObject({ dirty: false, revision: 2 })
  })

  it('a retried uncertain write that loses CAS does not poison saving an explicitly created local copy', async () => {
    vi.useFakeTimers()
    const f = fixture(); await f.session.start()
    f.rename('my uncertain version')
    vi.mocked(f.store.commit).mockResolvedValueOnce({ status: 'error', code: 'BACKEND_TIMEOUT', message: 'outcome unknown' })
    expect(await f.session.save()).toBe(false)
    const originalId = f.editor.state.doc.id
    const external = { ...f.editor.state.doc, name: 'external version' }
    f.rows.set(originalId, f.row(external))
    expect(await f.session.save()).toBe(false)
    expect(f.session.status.conflict).toBe(true)
    expect(await f.session.saveCopy()).toBe(true)
    const copiedId = f.editor.state.doc.id
    expect(copiedId).not.toBe(originalId)
    f.rename('copy next edit')
    expect(await f.session.save()).toBe(true)
    expect(f.rows.get(copiedId)?.name).toBe('copy next edit')
    expect(f.rows.get(originalId)?.name).toBe('external version')
  })

  it('manual save never persists an uncommitted drag preview as a durable history revision', async () => {
    vi.useFakeTimers()
    const document = blank('drag fixture'), shape = node('rectangle', 10, 20, 30, 40)
    document.nodes[shape.id] = shape; document.pages[0].children = [shape.id]
    const f = fixture(document); await f.session.start()
    f.editor.begin('move')
    f.editor.preview({ [shape.id]: { transform: [1, 0, 0, 1, 900, 500] } })
    expect(f.editor.interactionActive).toBe(true)
    await f.session.save()
    expect(f.store.commit).not.toHaveBeenCalled()
    f.editor.cancel()
    expect(f.editor.state.doc.nodes[shape.id].transform[4]).toBe(10)
  })

  it('a portable import whose ID already exists in SQLite can be admitted durably without a create-only conflict', async () => {
    vi.useFakeTimers()
    const f = fixture(), stored = blank('library original'), other = blank('latest other document')
    f.rows.set(stored.id, f.row(stored, 3, 1)); f.rows.set(other.id, f.row(other, 1, 2))
    await f.session.start()
    const imported = { ...stored, name: 'portable imported version' }
    vi.mocked(f.bridge.openDocument).mockResolvedValueOnce({ ...ok, handle: 'portable-handle', displayName: 'design.fd', documentJson: JSON.stringify(imported) })
    expect(await f.session.open()).toBe(true)
    expect(f.editor.state.doc.name).toBe('portable imported version')
    expect(f.session.status.conflict).toBe(false)
    expect(f.session.dirty).toBe(false)
    expect(f.rows.get(f.editor.state.doc.id)?.name).toBe('portable imported version')
  })

  it('native Cut cannot mutate canvas objects behind an active leave-confirmation dialog', async () => {
    const document = blank('dialog fixture'), shape = node('rectangle', 10, 20, 30, 40)
    document.nodes[shape.id] = shape; document.pages[0].children = [shape.id]
    const editor = new Editor(document); editor.select([shape.id])
    const write = vi.fn(async () => ok)
    const modal = { getAttribute: (name: string) => name === 'aria-modal' ? 'true' : null }
    vi.stubGlobal('document', { activeElement: { closest: (selector: string) => selector.includes('role=') ? modal : null }, querySelector: () => modal })
    vi.stubGlobal('window', { coreDesktop: { version: 1, clipboard: { write } } })
    await dispatchEditorCommand(editor, 'cut')
    expect(editor.state.doc.nodes[shape.id]).toBeDefined()
    expect(write).not.toHaveBeenCalled()
  })
})
