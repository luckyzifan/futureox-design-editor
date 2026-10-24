import { afterEach, expect, test, vi } from 'vitest'
import { listRevisions, type LocalRevisionEntry } from './local-store'

// Storage protocol double only. It checks cursor API use, returned metadata
// and transaction ownership, not retained-object counts, GC, browser RSS or
// actual IndexedDB clone cost/durable persistence.
function revisionDatabase(rows: LocalRevisionEntry[], failure?: 'cursor' | 'transaction' | 'continue') {
  const getAll = vi.fn(() => { throw new Error('History must not read all binary snapshots') })
  const snapshotAccess = vi.fn(() => { throw new Error('Listing must not retain snapshot payloads') })
  const tx: any = { error: new Error('transaction aborted'), abort: vi.fn(() => tx.onabort?.()) }
  const openCursor = vi.fn((_range: unknown, direction: string) => {
    expect(direction).toBe('prev')
    const request: any = {}
    let position = 0
    const advance = () => queueMicrotask(() => {
      if (failure === 'cursor' && position === 1) {
        request.error = new Error('cursor failed')
        request.onerror?.()
        return
      }
      const row = rows[position++]
      request.result = row ? {
        value: Object.defineProperty({ ...row }, 'bytes', { get: snapshotAccess }),
        continue() {
          if (failure === 'continue') throw new Error('cursor inactive')
          advance()
        },
      } : null
      request.onsuccess?.()
      if (!row) queueMicrotask(() => failure === 'transaction' ? tx.onabort?.() : tx.oncomplete?.())
    })
    advance()
    return request
  })
  tx.objectStore = vi.fn(() => ({ getAll, openCursor }))
  const database = { transaction: vi.fn(() => tx), close: vi.fn(), onversionchange: undefined }
  vi.stubGlobal('IDBKeyRange', { bound: (lower: unknown, upper: unknown) => ({ lower, upper }) })
  vi.stubGlobal('indexedDB', { open: () => {
    const request: any = {}
    queueMicrotask(() => { request.result = database; request.onsuccess?.() })
    return request
  } })
  return { database, tx, getAll, snapshotAccess, openCursor }
}
afterEach(() => vi.unstubAllGlobals())

test('revision listing uses a document-scoped newest-first cursor and returns metadata only', async () => {
  const rows = [
    { documentId: 'doc', revision: 50, createdAt: 500, summary: 'latest' },
    { documentId: 'doc', revision: 49, createdAt: 490 },
  ]
  const fixture = revisionDatabase(rows)
  expect(await listRevisions('doc')).toEqual(rows)
  expect(fixture.database.transaction).toHaveBeenCalledWith(['revisions'], 'readonly')
  expect(fixture.openCursor).toHaveBeenCalledWith({ lower: ['doc', -Infinity], upper: ['doc', Infinity] }, 'prev')
  expect(fixture.getAll).not.toHaveBeenCalled()
  expect(fixture.snapshotAccess).not.toHaveBeenCalled()
  expect(fixture.database.close).toHaveBeenCalledOnce()
})

test('an empty history remains empty and closes its transaction connection', async () => {
  const fixture = revisionDatabase([])
  expect(await listRevisions('missing')).toEqual([])
  expect(fixture.database.close).toHaveBeenCalledOnce()
})

test.each([
  ['cursor', 'cursor failed'], ['transaction', 'transaction aborted'], ['continue', 'cursor inactive'],
] as const)('%s failure never publishes a partial history', async (failure, message) => {
  const fixture = revisionDatabase([{ documentId: 'doc', revision: 2, createdAt: 20 }], failure)
  await expect(listRevisions('doc')).rejects.toThrow(message)
  expect(fixture.database.close).toHaveBeenCalledOnce()
})
