/** One complete immutable compilation witness per coordinate
 * slot. No approximate hashes or geometry canonicalization participate in hits. */
import {copyWitness,sameByteSpan,sameWitness,type CompilationWitness,type WitnessLookup} from './compilation-witness'
export function sameBytes(a: Uint8Array, b: Uint8Array) {
  return a.byteLength === b.byteLength && sameByteSpan(a, 0, b)
}

const encoder = new TextEncoder()
export const compilationWitness = (raw: string) => encoder.encode(raw)

const hexByte = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1
/** Small coordinate keys preserve the entire f64 camera/phase, including -0.
 * JSON serialization is used only for compiler inputs exactly as production;
 * its output, never a reserialized parsed scene, is the pixel witness.
 * Tiles of one frame repeat the same camera, so a bitwise-equal lookup of the
 * last encoding returns the identical string without re-encoding. */
let memoValues: Float64Array | undefined
let memoSlot = ''
export function coordinateSlot(numbers: readonly number[]) {
  const memo = memoValues
  if (memo && memo.length === numbers.length) {
    let equal = true
    for (let i = 0; i < numbers.length; i++) {
      const n = numbers[i]
      if (!Number.isFinite(n)) throw new Error('Invalid exact tile coordinate')
      if (!Object.is(memo[i], n)) { equal = false; break }
    }
    if (equal) return memoSlot
  }
  const values = new Float64Array(numbers.length)
  for (let i = 0; i < numbers.length; i++) {
    const n = numbers[i]
    if (!Number.isFinite(n)) throw new Error('Invalid exact tile coordinate')
    values[i] = n
  }
  let bytes: Uint8Array
  if (littleEndian) bytes = new Uint8Array(values.buffer)
  else {
    const data = new DataView(new ArrayBuffer(numbers.length * 8))
    values.forEach((n, i) => data.setFloat64(i * 8, n, true))
    bytes = new Uint8Array(data.buffer)
  }
  let slot = ''
  for (let i = 0; i < bytes.length; i++) slot += hexByte[bytes[i]]
  memoValues = values
  memoSlot = slot
  return slot
}

export class ExactTileCache<T> {
  // Count fixed entry metadata conservatively in addition to retained buffers
  // and UTF16 slot characters. This is a cache payload cap, not a JS heap limit.
  static readonly entryOverhead = 512
  private values = new Map<string, { witness: Uint8Array; value: T; bytes: number; certified: boolean }>()
  private reserved = 0
  bytes = 0
  evictions = 0
  constructor(readonly limit = 128 * 1024 * 1024, private diagnostic?: (reasonCode:number,bytes:number)=>void) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid exact cache budget')
  }
  private report(reasonCode:number) {try{this.diagnostic?.(reasonCode,this.bytes)}catch{}}
  get(slot: string, witness: WitnessLookup): T | undefined {
    const entry = this.values.get(slot)
    if (!entry) {this.report(10);return}
    if (!sameWitness(entry.witness,typeof witness==='function'?witness():witness)) {
      // Retire this coordinate's obsolete payload before new work is inserted.
      // Otherwise a growing content-key LRU can evict later unchanged tiles.
      this.report(11)
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
    if (!entry?.certified) {this.report(entry?12:10);return}
    this.values.delete(slot); this.values.set(slot, entry)
    return entry.value
  }
  revoke(predicate: (value: T, slot: string) => boolean) {
    for (const [slot, entry] of this.values) if (predicate(entry.value, slot)) entry.certified = false
  }
  set(slot: string, witness: CompilationWitness, value: T, payloadBytes: number) {
    if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0)
      throw new Error('Invalid exact cache payload budget')
    const bytes = payloadBytes + witness.byteLength + slot.length * 2 + ExactTileCache.entryOverhead
    this.delete(slot)
    if (bytes + this.reserved > this.limit) {this.report(13);return}
    while (this.bytes + bytes > this.limit) {
      this.delete(this.values.keys().next().value!)
      this.evictions++
      this.report(14)
    }
    this.values.set(slot, { witness: copyWitness(witness), value, bytes, certified: true })
    this.bytes += bytes
  }
  delete(slot: string) {
    const old = this.values.get(slot)
    if (old) this.bytes -= old.bytes
    this.values.delete(slot)
  }
  deleteWhere(predicate: (slot: string) => boolean) {
    for (const slot of this.values.keys()) if (predicate(slot)) this.delete(slot)
  }
  clear() {
    this.report(15)
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
