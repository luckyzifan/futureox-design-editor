import type { Texture } from './types'

type Entry = { texture: Texture; epoch: number }

/** Device-local immutable coefficients. Insertion order is LRU order. A
 * frame returning is not a fence: only driver-proven completed epochs may
 * be evicted. In-flight entries can refuse admission but never exceed the
 * retained byte/count bounds. Uncached uploads remain owned by the caller. */
export class ImmutableKernelCache {
  private entries = new Map<string, Entry>()
  private textures = new Set<Texture>()
  bytes = 0
  constructor(
    readonly byteLimit: number,
    readonly countLimit: number,
    private destroy: (texture: Texture) => void,
  ) {}
  get size() { return this.entries.size }
  has(texture: Texture) { return this.textures.has(texture) }
  get(key: string, epoch: number) {
    const entry = this.entries.get(key)
    if (!entry) return
    entry.epoch = Math.max(entry.epoch, epoch)
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.texture
  }
  put(key: string, texture: Texture, epoch: number, completed: number) {
    if (texture.bytes > this.byteLimit || this.countLimit < 1) return false
    if (this.entries.has(key) || this.textures.has(texture)) throw new Error('Duplicate immutable kernel ownership')
    for (const [oldKey, entry] of this.entries) {
      if (this.bytes + texture.bytes <= this.byteLimit && this.size < this.countLimit) break
      if (entry.epoch <= completed) this.remove(oldKey, entry)
    }
    if (this.bytes + texture.bytes > this.byteLimit || this.size >= this.countLimit) return false
    this.entries.set(key, { texture, epoch })
    this.textures.add(texture)
    this.bytes += texture.bytes
    return true
  }
  evictCompleted(required: number, completed: number) {
    let released = 0
    for (const [key, entry] of this.entries) {
      if (released >= required) break
      if (entry.epoch > completed) continue
      released += entry.texture.bytes
      this.remove(key, entry)
    }
    return released
  }
  private remove(key: string, entry: Entry) {
    this.entries.delete(key)
    this.textures.delete(entry.texture)
    this.bytes -= entry.texture.bytes
    this.destroy(entry.texture)
  }
  /** Driver disposal owns physical resources, including pending submissions. */
  abandon() { this.entries.clear(); this.textures.clear(); this.bytes = 0 }
}

/** Number.toString is lossless for finite binary64 values; distinguish -0
 * explicitly. Operator/domain/version are mandatory independent key parts. */
export function immutableKernelKey(operator: string, radius: number, domain: string) {
  if (!Number.isFinite(radius)) throw new Error('Non-finite immutable kernel radius')
  return `coefficients-v1/${domain}/${operator}/${Object.is(radius, -0) ? '-0' : radius}`
}
