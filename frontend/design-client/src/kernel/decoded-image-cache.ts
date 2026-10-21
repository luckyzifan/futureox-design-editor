/** Optional decoded-image residency. Eviction releases only the cache's
 * reference; a renderer borrowing the immutable pixels remains their owner. */
export type DecodedImage = { width: number; height: number; data: Uint8Array | Float32Array }
export const DECODED_IMAGE_CACHE_BYTES = 64 * 1024 * 1024

declare const decodedImageOwner: unique symbol
export type DecodedImageOwner = { readonly [decodedImageOwner]: true }
const ownerIds = new WeakMap<DecodedImageOwner, number>()
let nextOwnerId = 0
/** Private worker residency identity, never a document ID supplied by a file.
 * A synchronized interaction fork may borrow its canvas owner's exact pixels. */
export function createDecodedImageOwner(): DecodedImageOwner {
  const owner = Object.freeze({}) as DecodedImageOwner
  ownerIds.set(owner, ++nextOwnerId)
  return owner
}
export function decodedImageScope(owner: DecodedImageOwner, settings: string): string {
  const id = ownerIds.get(owner)
  if (id === undefined) throw Error('Unknown decoded image owner')
  // Full settings, not a hash or selected color fields. URI (including embedded
  // ICC/orientation bytes) and byte/linear variant are the per-entry key.
  return JSON.stringify([id, settings])
}

export function validDecodedImage(value: unknown): value is DecodedImage {
  if (!value || typeof value !== 'object') return false
  const { width, height, data } = value as DecodedImage
  const samples = width * height * 4
  return Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0 &&
    Number.isSafeInteger(samples) && (data instanceof Uint8Array || data instanceof Float32Array) &&
    data.length === samples
}

export class DecodedImageCache {
  private scope?: string
  private reserved = 0
  private entries = new Map<string, { image: DecodedImage; bytes: number }>()
  bytes = 0
  constructor(readonly limit = DECODED_IMAGE_CACHE_BYTES) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw Error('Invalid decoded image cache budget')
  }
  begin(scope: string) {
    if (scope === this.scope) return
    this.clear()
    const bytes = scope.length * 2 + 128
    if (bytes > this.limit) return
    this.scope = scope
    this.reserved = this.bytes = bytes
  }
  get(scope: string, key: string) {
    if (scope !== this.scope) return
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key); this.entries.set(key, entry)
    return entry.image
  }
  set(scope: string, key: string, image: DecodedImage): boolean {
    if (scope !== this.scope || !validDecodedImage(image)) return false
    // A short typed-array view can retain a much larger allocation.
    const bytes = image.data.buffer.byteLength + key.length * 2 + 128
    const previous = this.entries.get(key)
    if (previous) { this.entries.delete(key); this.bytes -= previous.bytes }
    if (bytes > this.limit - this.reserved) return false
    while (bytes > this.limit - this.bytes) {
      const first = this.entries.keys().next().value!
      this.bytes -= this.entries.get(first)!.bytes
      this.entries.delete(first)
    }
    this.entries.set(key, { image, bytes }); this.bytes += bytes
    return true
  }
  clear() { this.entries.clear(); this.scope = undefined; this.reserved = this.bytes = 0 }
  get size() { return this.entries.size }
}

export type ImageCacheMetadata<Key> = { key: Key; bytes: number; lastUsed: number }
/** Metadata only: deciding victims must not retain every decoded pixel buffer. */
export function imageCacheVictims<Key>(entries: ImageCacheMetadata<Key>[], budget: number): Key[] {
  if (!Number.isSafeInteger(budget) || budget < 0) throw Error('Invalid image store budget')
  let remaining = 0
  const invalid: Key[] = [], valid: ImageCacheMetadata<Key>[] = []
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !Number.isFinite(entry.lastUsed)) invalid.push(entry.key)
    else { remaining += entry.bytes; valid.push(entry) }
  }
  if (remaining <= budget) return invalid
  const target = Math.floor(budget * 0.75)
  valid.sort((a, b) => a.lastUsed - b.lastUsed)
  for (const entry of valid) {
    if (remaining <= target) break
    invalid.push(entry.key); remaining -= entry.bytes
  }
  return invalid
}
