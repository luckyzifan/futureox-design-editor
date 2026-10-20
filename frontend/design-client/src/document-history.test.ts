import { describe, expect, test, vi } from 'vitest'
import { blank, type DesignDocument } from './model'

vi.mock('./local-store', () => ({
  listRevisions: vi.fn(async () => [
    { documentId: 'local-document', revision: 2, createdAt: 50 },
    { documentId: 'local-document', revision: 1, summary: '恢复自 r1', createdAt: 40 },
  ]),
  getRevision: vi.fn(async (_id: string, revision: number) =>
    revision === 2 ? { document: blank('本地快照'), revision, updatedAt: 50 } : null),
  restoreRevision: vi.fn(async () => ({ document: blank('本地恢复'), revision: 3, updatedAt: 60 })),
}))
import { restoreRevision } from './local-store'
import { createDocumentHistory, selectHistoryRoute, type HistorySession } from './document-history'
const asSession = (value: unknown) => value as HistorySession

describe('history routing picks the sidecar only for workspace-capable sessions', () => {
  test('a missing, plain or workspace-less session falls back to IndexedDB', () => {
    expect(selectHistoryRoute(undefined)).toBe('local')
    expect(selectHistoryRoute(null)).toBe('local')
    expect(selectHistoryRoute({ supportsWorkspace: () => false })).toBe('local')
    expect(createDocumentHistory().route).toBe('local')
  })
  test('a desktop session with a workspace routes to the sidecar', () => {
    expect(selectHistoryRoute({ supportsWorkspace: () => true })).toBe('desktop')
    expect(createDocumentHistory(asSession({ supportsWorkspace: () => true })).route).toBe('desktop')
  })
})

describe('local route delegates to the IndexedDB revision store', () => {
  test('list, load and restore map onto the stored revision records', async () => {
    const history = createDocumentHistory(null)
    const page = await history.list('local-document')
    expect(page).toEqual({
      entries: [
        { revision: 2, createdAt: 50 },
        { revision: 1, summary: '恢复自 r1', createdAt: 40 },
      ],
      hasMore: false,
    })
    expect((await history.load('local-document', 2))?.document.name).toBe('本地快照')
    expect(await history.load('local-document', 1)).toBeNull()
    const restored = await history.restore('local-document', 2, 7)
    // Durable but not adopted: the caller must load it into the editor itself.
    expect(restored).toEqual({ restored: true, document: expect.objectContaining({ name: '本地恢复' }), revision: 3, adopted: false })
    expect(restoreRevision).toHaveBeenCalledWith('local-document', 2, 7)
  })
})

describe('desktop route delegates to the session sidecar bridge', () => {
  const revisionEntry = (revision: number) => ({
    id: 'desktop-document', name: '桌面设计', revision, hash: 'hash', updatedAt: revision * 10, deleted: false,
  })
  function session(overrides: Record<string, unknown> = {}) {
    return {
      supportsWorkspace: () => true,
      listRevisions: vi.fn(async () => ({
        status: 'ok',
        revisions: [revisionEntry(4), revisionEntry(3)],
        hasMore: true,
        nextBeforeRevision: 3,
      })),
      readWorkspaceRevision: vi.fn(async (): Promise<{ document: DesignDocument; updatedAt: number } | null> => ({
        document: blank('桌面快照'), updatedAt: 40,
      })),
      restoreWorkspace: vi.fn(async () => ({ document: blank('桌面恢复'), revision: 5 })),
      ...overrides,
    }
  }
  test('list maps workspace entries and pagination onto history entries', async () => {
    const desktop = session()
    const history = createDocumentHistory(asSession(desktop))
    expect(await history.list('desktop-document')).toEqual({
      entries: [
        { revision: 4, createdAt: 40 },
        { revision: 3, createdAt: 30 },
      ],
      hasMore: true,
      nextBeforeRevision: 3,
    })
    expect(desktop.listRevisions).toHaveBeenCalledWith('desktop-document', undefined)
  })
  test('load returns the read-only snapshot and null when the revision is gone', async () => {
    const missing = session({ readWorkspaceRevision: vi.fn(async () => null) })
    expect((await createDocumentHistory(asSession(missing)).load('desktop-document', 9))).toBeNull()
    const present = session()
    const snapshot = await createDocumentHistory(asSession(present)).load('desktop-document', 3)
    expect(snapshot).toMatchObject({ revision: 3, createdAt: 40 })
    expect(snapshot?.document.name).toBe('桌面快照')
  })
  test('restore reports the session-adopted outcome, including a declined restore', async () => {
    const desktop = session()
    const restored = await createDocumentHistory(asSession(desktop)).restore('desktop-document', 3)
    expect(restored).toEqual({ restored: true, document: expect.objectContaining({ name: '桌面恢复' }), revision: 5, adopted: true })
    const declined = session({ restoreWorkspace: vi.fn(async () => false) })
    expect(await createDocumentHistory(asSession(declined)).restore('desktop-document', 3)).toBe(false)
  })
  test('backend failures surface the sidecar message instead of empty history', async () => {
    const failing = session({ listRevisions: vi.fn(async () => ({ status: 'error', code: 'WORKSPACE_ERROR', message: '本机库读取失败' })) })
    await expect(createDocumentHistory(asSession(failing)).list('desktop-document')).rejects.toThrow('本机库读取失败')
    const cancelled = session({ listRevisions: vi.fn(async () => ({ status: 'cancelled' })) })
    await expect(createDocumentHistory(asSession(cancelled)).list('desktop-document')).rejects.toThrow('已取消')
  })
})
