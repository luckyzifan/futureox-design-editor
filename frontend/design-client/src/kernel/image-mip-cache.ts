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
const METADATA_STORE = 'image-metadata'
const DB_NAME = 'forma-image-cache'
const DB_VERSION = 2
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

/** Upgrade existing profiles once. Normal eviction never opens a pixel cursor. */
function indexLegacyImages(images: IDBObjectStore, metadata: IDBObjectStore): void {
  const entries: ImageCacheMetadata<IDBValidKey>[] = []
  const request = images.openCursor()
  request.onsuccess = () => {
    const cursor = request.result
    if (!cursor) {
      const victims = new Set(imageCacheVictims(entries, MAX_STORE_BYTES))
      for (const entry of entries) {
        if (victims.has(entry.key)) images.delete(entry.key)
        else metadata.put(entry)
      }
      return
    }
    const record = cursor.value as CachedImage | undefined
    entries.push({
      key: cursor.key,
      bytes: validDecodedImage(record) ? record.data.buffer.byteLength : NaN,
      lastUsed: record?.lastUsed ?? NaN,
    })
    cursor.continue()
  }
}

function openDatabase(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    let blocked = false
    request.onupgradeneeded = ({ oldVersion }) => {
      const db = request.result
      if (oldVersion === 0) db.createObjectStore(STORE)
      const metadata = db.createObjectStore(METADATA_STORE, { keyPath: 'key' })
      if (oldVersion > 0) indexLegacyImages(request.transaction!.objectStore(STORE), metadata)
    }
    request.onblocked = () => {
      blocked = true
      reject(new Error('image cache upgrade blocked'))
    }
    request.onsuccess = () => {
      const db = request.result
      if (blocked) {
        db.close()
        return
      }
      db.onversionchange = () => {
        db.close()
        dbPromise = undefined
      }
      resolve(db)
    }
    request.onerror = () => reject(request.error ?? new Error('image cache open failed'))
  })
  return dbPromise
}

async function modifyCache(run: (images: IDBObjectStore, metadata: IDBObjectStore) => void): Promise<void> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    // A writer and an eviction cannot interleave between reading metadata
    // and deleting its matching payload.
    const tx = db.transaction([STORE, METADATA_STORE], 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error('image cache transaction aborted'))
    try {
      run(tx.objectStore(STORE), tx.objectStore(METADATA_STORE))
    } catch (error) {
      tx.abort()
      reject(error)
    }
  })
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
    const db = await openDatabase()
    const record = await new Promise<CachedImage | undefined>((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('image cache read failed'))
    })
    if (!validDecodedImage(record) || record.data.buffer.byteLength > MAX_STORE_BYTES) return undefined
    return record
  } catch {
    return undefined
  }
}

function evictOldImages(): Promise<void> {
  return modifyCache((images, metadata) => {
    const request = metadata.getAll()
    request.onsuccess = () => {
      const entries: ImageCacheMetadata<IDBValidKey>[] = request.result
      for (const key of imageCacheVictims(entries, MAX_STORE_BYTES)) {
        images.delete(key)
        metadata.delete(key)
      }
    }
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
        await evictOldImages()
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
      await modifyCache((images, metadata) => {
        const lastUsed = Date.now()
        images.put({ ...record, lastUsed }, key)
        metadata.put({ key, lastUsed, bytes: record.data.buffer.byteLength })
      })
      await trimStore()
    } catch {
      /* Storage is optional; decoding stays the fallback. */
    }
  })()
}
