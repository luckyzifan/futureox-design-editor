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

const STORE = 'design-image-mip-cache'
const DB_NAME = 'forma-image-cache'
const DB_VERSION = 1
/** Resident cap for cached decodes; entries evict least-recently-used. */
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
      const bytes = new Uint8Array(await (await fetch('/kernel/design_kernel_bg.wasm')).arrayBuffer())
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
    if (!record || !record.width || !record.height || !record.data) return undefined
    return record
  } catch {
    return undefined
  }
}

async function allEntries(): Promise<[IDBValidKey, CachedImage][]> {
  const keys = await transaction<IDBValidKey[]>('readonly', (store) => store.getAllKeys())
  const records = await Promise.all(
    keys.map(async (key) => [key, await transaction<CachedImage | undefined>('readonly', (store) => store.get(key))] as const),
  )
  return records.filter((entry): entry is [IDBValidKey, CachedImage] => !!entry[1])
}

/** Fire-and-forget persist with an LRU byte cap. Writes never block or fail
 * a render. */
export function writeCachedImage(key: string, record: Omit<CachedImage, 'lastUsed'>): void {
  void (async () => {
    try {
      if (!key) return
      await transaction('readwrite', (store) => store.put({ ...record, lastUsed: Date.now() }, key))
      const entries = await allEntries()
      const total = entries.reduce((n, [, e]) => n + e.data.byteLength, 0)
      if (total <= MAX_STORE_BYTES) return
      const victims = entries
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
        .slice(0, entries.length - Math.floor((MAX_STORE_BYTES * 3) / 4 / 1))
      for (let i = 0; i < victims.length; i++) {
        const [, entry] = victims[i]
        if (total - entry.data.byteLength < MAX_STORE_BYTES * 0.75) break
        await transaction('readwrite', (store) => store.delete(victims[i][0]))
      }
    } catch {
      /* Storage is optional; decoding stays the fallback. */
    }
  })()
}
