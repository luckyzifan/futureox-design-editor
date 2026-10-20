/** Renderer-private immutable CPU coefficient payloads, not GPU resources.
 * Consumers must only read borrowed values and must never transfer their buffer.
 * Admission copies once so a producer/WASM allocation cannot alias storage;
 * hits borrow the owned bytes without a per-frame clone. */
export class CoefficientByteCache {
  private entries = new Map<string, Uint8Array>()
  bytes = 0
  constructor(readonly byteLimit: number, readonly countLimit: number) {
    if (!Number.isSafeInteger(byteLimit) || byteLimit < 0 ||
        !Number.isSafeInteger(countLimit) || countLimit < 0)
      throw new Error('Invalid coefficient byte cache limits')
  }
  get size() { return this.entries.size }
  get(key: string): Uint8Array | undefined {
    const value = this.entries.get(key)
    if (!value) return
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }
  put(key: string, value: Uint8Array): Uint8Array | undefined {
    if (!value.byteLength || value.byteLength > this.byteLimit || this.countLimit === 0) return
    if (this.entries.has(key)) throw new Error('Duplicate coefficient byte cache key')
    // Obtain independent ownership before changing the existing LRU on failure.
    const owned = value.slice()
    while (this.bytes + owned.byteLength > this.byteLimit || this.entries.size >= this.countLimit) {
      const oldest = this.entries.entries().next().value!
      this.entries.delete(oldest[0]); this.bytes -= oldest[1].byteLength
    }
    this.entries.set(key, owned); this.bytes += owned.byteLength
    return owned
  }
  clear() { this.entries.clear(); this.bytes = 0 }
}
