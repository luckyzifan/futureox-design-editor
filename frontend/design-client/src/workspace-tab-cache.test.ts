import { afterEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, type DesignDocument } from './model'
import { DesktopSession, type LeaveDecision } from './desktop-session'
import type { DesktopBridge, WorkspaceOpened } from './desktop'

const sessions: DesktopSession[] = []
const ok = { status: 'ok' } as const
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
const busy = { status: 'error' as const, code: 'BUSY', message: 'Another file operation is in progress' }

function fixture() {
  const alpha = blank('Alpha'), beta = blank('Beta'), editor = new Editor(blank()), rows = new Map<string, WorkspaceOpened>()
  const row = (d: DesignDocument, revision = 1) => ({ id: d.id, name: d.name, revision, hash: `hash-${revision}`, updatedAt: revision, deleted: false, documentJson: JSON.stringify(d) })
  rows.set(alpha.id, row(alpha)); rows.set(beta.id, row(beta))
  let block = new Set<string>()
  const open = vi.fn(async ({ id }: { id: string }) => block.has(id) ? busy : rows.has(id) ? { ...ok, ...rows.get(id)! } : { status: 'error' as const, code: 'WORKSPACE_NOT_FOUND', message: 'missing' })
  const decode = vi.fn(async (json: string) => JSON.parse(json))
  const bridge = { version: 1, documentCodec: { decode, encode: async (d: DesignDocument) => JSON.stringify(d) }, workspace: { open, commit: async () => ({ ...ok, ...row(alpha, 2) }), list: async () => ({ ...ok, documents: [] }) }, readRecovery: async () => ({ status: 'cancelled' }), clearRecovery: async () => ok, writeRecovery: async () => ok, setDirty: async () => {} } as unknown as DesktopBridge
  const session = new DesktopSession(bridge, editor, async (): Promise<LeaveDecision> => 'discard')
  sessions.push(session)
  return { alpha, beta, editor, rows, open, session, block }
}
afterEach(() => { sessions.splice(0).forEach(session => session.dispose()); vi.restoreAllMocks() })

test('a BUSY workspace read switches to the cached tab and does not report the file-lock error', async () => {
  const f = fixture()
  expect(await f.session.openWorkspace(f.alpha.id)).toBe(true)
  expect(await f.session.openWorkspace(f.beta.id)).toBe(true)
  expect(f.editor.state.doc.name).toBe('Beta')
  f.block.add(f.alpha.id)
  expect(await f.session.openWorkspace(f.alpha.id)).toBe(true)
  expect(f.editor.state.doc.id).toBe(f.alpha.id)
  expect(f.editor.state.doc.name).toBe('Alpha')
  expect(f.session.status.error).toBeUndefined()
  expect(f.editor.state.message).toContain('会话缓存')
  expect(f.editor.state.message).not.toContain('Another file operation is in progress')
})

test('repeated BUSY reads keep the requested tab queued and open it when the lock clears', async () => {
  const f = fixture()
  expect(await f.session.openWorkspace(f.alpha.id)).toBe(true)
  let busyReads = 0
  f.open.mockImplementation(async ({ id }: { id: string }) => {
    if (id === f.beta.id && busyReads < 6) {
      busyReads += 1
      return busy
    }
    return f.rows.has(id) ? { ...ok, ...f.rows.get(id)! } : { status: 'error' as const, code: 'WORKSPACE_NOT_FOUND', message: 'missing' }
  })
  expect(await f.session.openWorkspace(f.beta.id)).toBe(false)
  expect(f.editor.state.doc.id).toBe(f.alpha.id)
  expect(f.editor.state.message).not.toContain('Another file operation is in progress')
  await vi.waitFor(() => expect(f.editor.state.doc.id).toBe(f.beta.id), { timeout: 8000 })
  expect(f.session.status.error).toBeUndefined()
  expect(f.editor.state.message).not.toContain('Another file operation is in progress')
})

test('a tab requested during an in-flight open is switched after that operation releases the editor', async () => {
  const f = fixture()
  let release!: (value: WorkspaceOpened & { status: 'ok' }) => void
  const held = new Promise<WorkspaceOpened & { status: 'ok' }>(resolve => { release = resolve })
  f.open.mockImplementationOnce(() => held)
  const opening = f.session.openWorkspace(f.alpha.id)
  await flush()
  expect(await f.session.requestWorkspaceTab(f.beta.id)).toBe(false)
  expect(f.editor.state.doc.name).not.toBe('Beta')
  release({ ...ok, ...f.rows.get(f.alpha.id)! })
  expect(await opening).toBe(true)
  await vi.waitFor(() => expect(f.editor.state.doc.name).toBe('Beta'), { timeout: 2000 })
  expect(f.editor.state.doc.id).toBe(f.beta.id)
  expect(f.session.status.error).toBeUndefined()
})
