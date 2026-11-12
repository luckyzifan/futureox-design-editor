import { webPath } from '../web-path'
/** Persistent decoded-image cache (Sketch's MSImageDataMipMap disk cache
 * equivalent). Level-0 decodes are frozen kernel
 * outputs — residency only, never a different value — so this store may
 * serve bytes that an earlier session produced with the same kernel.
 *
 * Key binding mirrors the reference validation (colorspace/bpp/ICC
 * checks): the fingerprint covers the asset bytes, the decode variant
 * (premultiplied RGBA8 vs managed linear float), the engine color settings
 * at decode time, and the kernel build (wasm digest) — any of those changing
 * is a miss, never a stale hit.
 *
 * In Electron the underlying IndexedDB persists in the user profile, so the
 * desktop client shares this cache with no extra plumbing. */

import { imageCacheVictims, validDecodedImage, type ImageCacheMetadata } from './decoded-image-cache'

const STORE = 'design-image-mip-cache'
const DB_NAME = 'forma-image-cache'
const DB_VERSION = 1
/** Persistent payload cap, separate from worker decoded-image residency. */
const MAX_STORE_BYTES = 256 * 1024 * 1024

export type CachedImage = {
  width: number
  height: number
  /** Premultiplied RGBA8 (byte variant) or linear f32 (managed variant). */
  data: Uint8Array | Float32Array
  lastUsed: number
}

let dbPromise: Promise<IDBDatabase> | undefined

function openDatabase(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('image cache open failed'))
  })
  return dbPromise
}

function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode)
        const request = run(tx.objectStore(STORE))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('image cache request failed'))
      }),
  )
}

/** One-time kernel-build digest: cached decodes are only valid for the exact
 * wasm binary that produced them. When the asset is unreadable (tests,
 * stripped hosts) persistence is disabled rather than keyed unsafely. */
let kernelDigest: Promise<string | undefined> | undefined
function kernelBuildKey(): Promise<string | undefined> {
  kernelDigest ??= (async () => {
    try {
      const bytes = new Uint8Array(await (await fetch(webPath('/kernel/design_kernel_bg.wasm'))).arrayBuffer())
      const digest = await crypto.subtle.digest('SHA-256', bytes)
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
    } catch {
      return undefined
    }
  })()
  return kernelDigest
}

async function digestHex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function imageCacheKey(
  uri: string,
  variant: 'byte' | 'linear',
  colorSettings: string,
): Promise<string | undefined> {
  const build = await kernelBuildKey()
  if (!build) return undefined
  const asset = await digestHex(uri)
  const settings = colorSettings === '' ? 'sdr' : await digestHex(colorSettings)
  return `${build.slice(0, 16)}/${asset}/${variant}/${settings.slice(0, 16)}`
}

/** Best-effort read; any failure is a miss and the deterministic kernel path
 * re-decodes. */
export async function readCachedImage(key: string): Promise<CachedImage | undefined> {
  try {
    const record = await transaction<CachedImage | undefined>('readonly', (store) => store.get(key))
    if (!validDecodedImage(record) || record.data.buffer.byteLength > MAX_STORE_BYTES) return undefined
    return record
  } catch {
    return undefined
  }
}

async function allMetadata(): Promise<ImageCacheMetadata<IDBValidKey>[]> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const entries: ImageCacheMetadata<IDBValidKey>[] = []
    const tx = db.transaction(STORE, 'readonly'), request = tx.objectStore(STORE).openCursor()
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return
      const record = cursor.value as CachedImage
      entries.push({ key: cursor.key, bytes: validDecodedImage(record) ? record.data.buffer.byteLength : NaN,
        lastUsed: record?.lastUsed })
      // Drop the current decoded buffer before advancing. getAll/Promise.all
      // would materialize the entire disk cache on every individual write.
      cursor.continue()
    }
    tx.oncomplete = () => resolve(entries)
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('image cache scan failed'))
  })
}

let trimming: Promise<void> | undefined
let trimAgain = false
function trimStore() {
  trimAgain = true
  if (trimming) return trimming
  trimming = (async () => {
    try {
      while (trimAgain) {
        trimAgain = false
        const victims = imageCacheVictims(await allMetadata(), MAX_STORE_BYTES)
        for (const key of victims) await transaction('readwrite', store => store.delete(key))
      }
    } finally { trimming = undefined }
  })()
  return trimming
}

/** Fire-and-forget persist with a byte cap. Oldest writes retire first. Writes never block or fail
 * a render. */
export function writeCachedImage(key: string, record: Omit<CachedImage, 'lastUsed'>): void {
  void (async () => {
    try {
      if (!key || !validDecodedImage(record) || record.data.buffer.byteLength > MAX_STORE_BYTES) return
      await transaction('readwrite', (store) => store.put({ ...record, lastUsed: Date.now() }, key))
      await trimStore()
    } catch {
      /* Storage is optional; decoding stays the fallback. */
    }
  })()
}
