import type { Texture } from './types'
type Entry = { key: string; bits: Uint32Array; texture: Texture; bytes: number; frame: number }

/** Exact, bounded coverage reuse. A hash indexes candidates; it never proves equality.
 * Entries referenced by the current command buffer stay pinned until frame completion.
 */
export class CoverageCache {
  private entries = new Set<Entry>()
  private buckets = new Map<string, Set<Entry>>()
  private textures = new Map<Texture, Set<Entry>>()
  private eviction?: SetIterator<Entry>
  private frame = 0
  bytes = 0
  rejectedOversize = 0
  rejectedPinned = 0
  rejectedBytes = 0
  private diagnostics = false
  hits = 0
  missKeys = 0
  missWords = 0
  constructor(
    private limit: number,
    private countLimit: number,
    private destroy: (t: Texture) => void,
  ) {}
  begin(diagnostics = false) {
    this.diagnostics=diagnostics;this.hits=this.missKeys=this.missWords=0
    this.rejectedOversize = this.rejectedPinned = this.rejectedBytes = 0
    this.frame++
    this.eviction = this.entries.values()
  }
  has(texture: Texture) {
    return this.textures.has(texture)
  }
  get(key: string, bits: Uint32Array): Texture | undefined {
    const bucket=this.buckets.get(key)
    for (const e of bucket || []) {
      if (bits.length !== e.bits.length) continue
      // Compare every word, including NaN payloads and signed zero. A plain
      // indexed loop avoids a JS callback for every path word on each phase.
      let same = true
      for (let i = 0; i < bits.length; i++) if (bits[i] !== e.bits[i]) { same = false; break }
      if (!same) continue
      e.frame = this.frame
      this.entries.delete(e)
      this.entries.add(e)
      if(this.diagnostics)this.hits++
      return e.texture
    }
    if(this.diagnostics){if(bucket?.size)this.missWords++;else this.missKeys++}
    return undefined
  }
  put(key: string, bits: Uint32Array, texture: Texture): boolean {
    const bytes = bits.byteLength + texture.bytes
    if (bytes > this.limit) { this.rejectedOversize++; this.rejectedBytes += bytes; return false }
    // The caller is using this physical texture in this frame, even if a new
    // alias cannot be admitted. Evicting an older alias must not destroy it.
    for (const entry of this.textures.get(texture) || []) entry.frame = this.frame
    while (this.bytes + bytes > this.limit || this.entries.size >= this.countLimit) {
      const entry = this.nextEvictable()
      if (!entry) break
      this.removeEntry(entry)
    }
    if (this.bytes + bytes > this.limit || this.entries.size >= this.countLimit) {
      this.rejectedPinned++; this.rejectedBytes += bytes; return false
    }
    // Copy only this mesh, not a view retaining the entire frame vertex buffer.
    const entry = { key, bits: bits.slice(), texture, bytes, frame: this.frame }
    const bucket = this.buckets.get(key) || new Set<Entry>()
    bucket.add(entry)
    this.buckets.set(key, bucket)
    this.entries.add(entry)
    const aliases = this.textures.get(texture) || new Set<Entry>()
    aliases.add(entry); this.textures.set(texture, aliases)
    this.bytes += bytes
    return true
  }
  /** Release completed-frame entries if the compositor needs its global budget. */
  evictUnused(required: number) {
    let released = 0
    while (released < required) {
      const entry = this.nextEvictable()
      if (!entry) break
      released += this.removeEntry(entry)
    }
  }
  private nextEvictable() {
    this.eviction ||= this.entries.values()
    for (;;) {
      const next = this.eviction.next()
      if (next.done) return
      if (next.value.frame !== this.frame) return next.value
    }
  }
  /** Detach every cache alias without destroying a texture still used by
   * submitted commands. The caller takes ownership and may return it to an
   * ordered render-target pool after its last logical read has been encoded.
   */
  remove(texture: Texture): boolean {
    let found = false
    for (const entry of this.textures.get(texture) || []) {
      this.removeEntry(entry, false)
      found = true
    }
    return found
  }
  private removeEntry(e: Entry, destroy = true) {
    this.entries.delete(e)
    const bucket = this.buckets.get(e.key)!
    bucket.delete(e)
    if (!bucket.size) this.buckets.delete(e.key)
    const aliases = this.textures.get(e.texture)!
    aliases.delete(e)
    if (!aliases.size) this.textures.delete(e.texture)
    this.bytes -= e.bytes
    if (destroy && !aliases.size) { this.destroy(e.texture); return e.texture.bytes }
    return 0
  }
  clear() {
    for (const e of this.entries) this.removeEntry(e)
    this.eviction = undefined
  }
}
