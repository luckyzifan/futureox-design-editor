/** One complete immutable compilation witness per coordinate
 * slot. No approximate hashes or geometry canonicalization participate in hits. */
export function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}

const encoder = new TextEncoder()
export const compilationWitness = (raw: string) => encoder.encode(raw)

/** Small coordinate keys preserve the entire f64 camera/phase, including -0.
 * JSON serialization is used only for compiler inputs exactly as production;
 * its output, never a reserialized parsed scene, is the pixel witness. */
export function coordinateSlot(numbers: readonly number[]) {
  const data = new DataView(new ArrayBuffer(numbers.length * 8))
  numbers.forEach((n, i) => {
    if (!Number.isFinite(n)) throw new Error('Invalid exact tile coordinate')
    data.setFloat64(i * 8, n, true)
  })
  return [...new Uint8Array(data.buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export class ExactTileCache<T> {
  // Count fixed entry metadata conservatively in addition to retained buffers
  // and UTF16 slot characters. This is a cache payload cap, not a JS heap limit.
  static readonly entryOverhead = 512
  private values = new Map<string, { witness: Uint8Array; value: T; bytes: number; certified: boolean }>()
  private reserved = 0
  bytes = 0
  evictions = 0
  constructor(readonly limit = 128 * 1024 * 1024) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid exact cache budget')
  }
  get(slot: string, witness: Uint8Array): T | undefined {
    const entry = this.values.get(slot)
    if (!entry) return
    if (!sameBytes(entry.witness, witness)) {
      // Retire this coordinate's obsolete payload before new work is inserted.
      // Otherwise a growing content-key LRU can evict later unchanged tiles.
      this.delete(slot)
      return
    }
    this.values.delete(slot)
    entry.certified = true
    this.values.set(slot, entry)
    return entry.value
  }
  /** A previous actual compilation remains valid only while the kernel's
   * conservative damage certificate proves this coordinate unaffected. */
  certified(slot: string): T | undefined {
    const entry = this.values.get(slot)
    if (!entry?.certified) return
    this.values.delete(slot); this.values.set(slot, entry)
    return entry.value
  }
  revoke(predicate: (value: T) => boolean) {
    for (const entry of this.values.values()) if (predicate(entry.value)) entry.certified = false
  }
  set(slot: string, witness: Uint8Array, value: T, payloadBytes: number) {
    if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0)
      throw new Error('Invalid exact cache payload budget')
    const bytes = payloadBytes + witness.byteLength + slot.length * 2 + ExactTileCache.entryOverhead
    this.delete(slot)
    if (bytes + this.reserved > this.limit) return
    while (this.bytes + bytes > this.limit) {
      this.delete(this.values.keys().next().value!)
      this.evictions++
    }
    this.values.set(slot, { witness: witness.slice(), value, bytes, certified: true })
    this.bytes += bytes
  }
  delete(slot: string) {
    const old = this.values.get(slot)
    if (old) this.bytes -= old.bytes
    this.values.delete(slot)
  }
  clear() {
    this.values.clear()
    this.bytes = 0
    this.evictions = 0
    this.reserved = 0
  }
  reserve(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limit)
      throw new Error('Invalid exact cache envelope budget')
    this.clear()
    this.reserved = this.bytes = bytes
  }
  get size() { return this.values.size }
}
