import { afterEach, expect, test, vi } from 'vitest'
import {
  LOCAL_REVISION_RETENTION,
  getRevision,
  listRevisions,
  localOpen,
  localSave,
  restoreRevision,
} from './local-store'
import { blank } from './model'

// A Map-backed IndexedDB doubling with compound keys for the revisions store.
// Real admission/encoding (WASM) still runs; only the storage boundary is fake.
function fakeIndexedDb() {
  const stores = new Map<string, Map<unknown, unknown>>([
    ['documents', new Map()],
    ['catalog', new Map()],
    ['session', new Map()],
    ['outbox', new Map()],
    ['remote', new Map()],
    ['revisions', new Map()],
  ])
  let closed = false
  const cmp = (a: any, b: any): number => {
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const order = cmp(a[i], b[i])
        if (order) return order
      }
      return 0
    }
    return a < b ? -1 : a > b ? 1 : 0
  }
  const inRange = (key: unknown, range: { lower: unknown; upper: unknown } | undefined) =>
    !range || (cmp(key, range.lower) >= 0 && cmp(key, range.upper) <= 0)
  // IndexedDB compares compound keys by value; Map keys compare by identity.
  const mapKey = (key: unknown) => (Array.isArray(key) ? JSON.stringify(key) : key)
  const decodeStoredKey = (stored: unknown) =>
    typeof stored === 'string' && stored.startsWith('[') ? (JSON.parse(stored) as unknown) : stored
  const database = {
    close() { closed = true },
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore(name: string) { stores.set(name, new Map()) },
    transaction() {
      let pending = 0
      let finished = false
      const settle = () =>
        queueMicrotask(() => {
          if (pending === 0 && !finished) {
            finished = true
            tx.oncomplete?.()
          }
        })
      const tracked = (complete: (request: any) => void) => {
        const request: any = {}
        pending++
        queueMicrotask(() => {
          complete(request)
          pending--
          settle()
        })
        return request
      }
      const tx: any = {
        oncomplete: null,
        onabort: null,
        onerror: null,
        abort() {
          finished = true
          tx.onabort?.()
        },
        objectStore(name: string) {
          const store = stores.get(name)!
          return {
            get: (key: unknown) =>
              tracked((request: any) => {
                request.result = structuredClone(store.get(mapKey(key)))
                request.onsuccess?.()
              }),
            getAll: (range?: any) =>
              tracked((request: any) => {
                request.result = [...store.entries()]
                  .map(([stored, value]) => [decodeStoredKey(stored), value] as [unknown, unknown])
                  .filter(([key]) => inRange(key, range))
                  .sort(([a], [b]) => cmp(a, b))
                  .map(([, value]) => structuredClone(value))
                request.onsuccess?.()
              }),
            openCursor: (range?: any, direction = 'next') => {
              const values = [...store.entries()]
                .map(([stored, value]) => [decodeStoredKey(stored), value] as [unknown, unknown])
                .filter(([key]) => inRange(key, range))
                .sort(([a], [b]) => direction === 'prev' ? cmp(b, a) : cmp(a, b))
              const request: any = {}
              let index = 0
              const advance = () => {
                pending++
                queueMicrotask(() => {
                  const entry = values[index++]
                  request.result = entry ? { value: structuredClone(entry[1]), continue: advance } : null
                  request.onsuccess?.()
                  pending--
                  settle()
                })
              }
              advance()
              return request
            },
            getAllKeys: (range?: any) =>
              tracked((request: any) => {
                request.result = [...store.keys()]
                  .map(decodeStoredKey)
                  .filter((key) => inRange(key, range))
                  .sort(cmp)
                request.onsuccess?.()
              }),
            put: (value: any, key?: unknown) => {
              const stored = name === 'revisions' && key === undefined
                ? [value.documentId, value.revision]
                : key
              store.set(mapKey(stored), structuredClone(value))
            },
            delete: (key: unknown) => { store.delete(mapKey(key)) },
          }
        },
      }
      return tx
    },
  }
  vi.stubGlobal('IDBKeyRange', {
    bound: (lower: unknown, upper: unknown) => ({ lower, upper }),
  })
  vi.stubGlobal('indexedDB', {
    open() {
      const request: any = {}
      queueMicrotask(() => {
        request.result = database
        request.onsuccess?.()
      })
      return request
    },
  })
  return { stores, closed: () => closed }
}
afterEach(() => { vi.unstubAllGlobals() })

test('each save files one revision snapshot and retention keeps only the newest 50', async () => {
  fakeIndexedDb()
  const document = blank('历史保留')
  let revision = 0
  for (let i = 0; i < LOCAL_REVISION_RETENTION + 5; i++)
    revision = (await localSave(document, revision)).revision
  expect(revision).toBe(LOCAL_REVISION_RETENTION + 5)
  const entries = await listRevisions(document.id)
  expect(entries).toHaveLength(LOCAL_REVISION_RETENTION)
  expect(entries[0].revision).toBe(LOCAL_REVISION_RETENTION + 5)
  expect(entries[0].summary).toBeUndefined()
  expect(entries.at(-1)!.revision).toBe(6)
  expect(await getRevision(document.id, 5)).toBeNull()
})

test('restoreRevision writes the old snapshot as a new head revision labelled 恢复自 rN', async () => {
  fakeIndexedDb()
  let document = blank('第一版')
  document.fdCompatibility = { contractVersion: 1, requiredCapabilities: [], extensions: { 'org.example/history': { preserved: true } } }
  let record = await localSave(document, 0)
  document = { ...document, name: '第二版' }
  record = await localSave(document, record.revision)
  document = { ...document, name: '第三版' }
  record = await localSave(document, record.revision)
  expect(record.revision).toBe(3)
  const restored = await restoreRevision(document.id, 1)
  expect(restored.revision).toBe(4)
  expect(restored.document.name).toBe('第一版')
  const entries = await listRevisions(document.id)
  expect(entries[0]).toMatchObject({ revision: 4, summary: '恢复自 r1' })
  expect(entries).toHaveLength(4)
  // The restored head is durable and re-opens through the normal local path.
  const reopened = await localOpen(document.id)
  expect(reopened?.revision).toBe(4)
  expect(reopened?.document.name).toBe('第一版')
  expect(reopened?.document.fdCompatibility).toEqual(document.fdCompatibility)
  const snapshot = await getRevision(document.id, 4)
  expect(snapshot?.document.name).toBe('第一版')
})

test('missing or invalid revisions are reported, never fabricated', async () => {
  fakeIndexedDb()
  const document = blank('边界')
  await localSave(document, 0)
  expect(await getRevision(document.id, 99)).toBeNull()
  await expect(getRevision(document.id, 0)).rejects.toThrow('历史版本号无效')
  await expect(restoreRevision(document.id, 99)).rejects.toThrow('不存在')
})

test('restore rejects a stale viewed head, preserves newer head and all snapshots', async () => {
  fakeIndexedDb()
  const document = blank('Original')
  await localSave(document, 0)
  await localSave({ ...document, name: 'Viewed head' }, 1)
  await localSave({ ...document, name: 'Concurrent edit' }, 2)
  await expect(restoreRevision(document.id, 1, 2)).rejects.toThrow('另一标签页')
  expect((await localOpen(document.id))?.document.name).toBe('Concurrent edit')
  expect(await listRevisions(document.id)).toHaveLength(3)
  expect((await restoreRevision(document.id, 1, 3)).revision).toBe(4)
  expect((await getRevision(document.id, 3))?.document.name).toBe('Concurrent edit')
})
