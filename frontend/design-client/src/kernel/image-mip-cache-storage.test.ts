import { afterEach, expect, test, vi } from 'vitest'
import { validDecodedImage } from './decoded-image-cache'
import type { CachedImage } from './image-mip-cache'

// Exercise the real persistence control flow at a 32-byte budget. No browser,
// GPU, database package or hundreds-of-MiB fixture allocation is required.
vi.mock('./decoded-image-cache', async importOriginal => {
  const actual = await importOriginal<typeof import('./decoded-image-cache')>()
  return { ...actual, imageCacheVictims: (entries: Parameters<typeof actual.imageCacheVictims>[0]) => actual.imageCacheVictims(entries, 32) }
})

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

function storage(initial: Map<string, CachedImage>) {
  const records = new Map(initial), deleted: string[] = []
  const metadata = new Map(Array.from(initial, ([key, record]) => [key, {
    key, bytes: validDecodedImage(record) ? record.data.buffer.byteLength : NaN, lastUsed: record.lastUsed,
  }]))
  let scans = 0, activeScans = 0, maxActiveScans = 0
  const db = {
    transaction(names: string | string[], mode: IDBTransactionMode) {
      const images = 'design-image-mip-cache', index = 'image-metadata'
      if (mode === 'readwrite') expect(names).toEqual([images, index])
      const tx: any = { objectStore: (name: string) => name === images ? imageStore : metadataStore }
      let pending = 0
      function operation(action: () => unknown) {
        const request: any = {}
        pending++
        queueMicrotask(() => {
          request.result = action(); request.onsuccess?.()
          if (--pending === 0) tx.oncomplete?.()
        })
        return request
      }
      const imageStore = {
        put(value: CachedImage, key: string) { return operation(() => { records.set(key, structuredClone(value)); return key }) },
        get(key: string) { return operation(() => structuredClone(records.get(key))) },
        delete(key: string) { return operation(() => { deleted.push(key); records.delete(key) }) },
        getAll() { throw Error('Do not clone all cached image payloads') },
        openCursor() { throw Error('Do not scan pixel payloads during normal writes') },
      }
      const metadataStore = {
        put(entry: { key: string; bytes: number; lastUsed: number }) {
          return operation(() => { metadata.set(entry.key, structuredClone(entry)); return entry.key })
        },
        delete(key: string) { return operation(() => metadata.delete(key)) },
        getAll() {
          scans++; activeScans++; maxActiveScans = Math.max(maxActiveScans, activeScans)
          return operation(() => {
            activeScans--
            return structuredClone([...metadata.values()])
          })
        },
      }
      return tx
    },
  }
  vi.stubGlobal('indexedDB', {
    open(_name: string, version: number) {
      expect(version).toBe(2)
      const request: any = { result: db }
      queueMicrotask(() => request.onsuccess?.())
      return request
    },
  })
  return { records, metadata, deleted, get scans() { return scans }, get maxActiveScans() { return maxActiveScans } }
}

const pixels = { width: 2, height: 2, data: new Uint8Array(16) }

test('real write path evicts oldest byte payloads with one metadata scan', async () => {
  const db = storage(new Map([['old', { ...pixels, lastUsed: 1 }], ['middle', { ...pixels, lastUsed: 2 }]]))
  const { writeCachedImage, readCachedImage } = await import('./image-mip-cache')
  writeCachedImage('new', pixels)
  await vi.waitFor(() => expect([...db.records.keys()]).toEqual(['new']))
  expect(db.deleted).toEqual(['old', 'middle'])
  expect([...db.metadata.keys()]).toEqual(['new'])
  expect(db.scans).toBe(1)
  expect((await readCachedImage('new'))?.data).toEqual(pixels.data)
})

test('overlapping writes coalesce cleanup and malformed stored decodes become misses', async () => {
  const db = storage(new Map([['malformed', { width: 2, height: 2, data: new Uint8Array(4), lastUsed: 1 }]]))
  const { writeCachedImage, readCachedImage } = await import('./image-mip-cache')
  expect(await readCachedImage('malformed')).toBeUndefined()
  for (let i = 0; i < 10; i++) writeCachedImage(`new-${i}`, pixels)
  await vi.waitFor(() => {
    expect(db.records.has('malformed')).toBe(false)
    expect(db.records.size).toBeLessThanOrEqual(2)
    expect(db.records.has('new-9')).toBe(true)
  })
  expect(db.maxActiveScans).toBe(1)
  expect(db.scans).toBeLessThan(10)
})

test('persistent byte accounting includes the backing allocation of a short view', async () => {
  const db = storage(new Map())
  const { writeCachedImage } = await import('./image-mip-cache')
  writeCachedImage('short-view', { ...pixels, data: new Uint8Array(new ArrayBuffer(64), 0, 16) })
  await vi.waitFor(() => expect(db.deleted).toEqual(['short-view']))
  expect(db.records.size).toBe(0)
  expect(db.metadata.size).toBe(0)
})
