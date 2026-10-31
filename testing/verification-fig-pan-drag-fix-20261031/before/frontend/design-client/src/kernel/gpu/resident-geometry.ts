/** CPU mirror of one device-owned geometry buffer. Compare IEEE-754 words,
 * not approximate floats; only changed bytes are uploaded. Reallocation/loss
 * explicitly invalidates the mirror before the next use. */
export class ResidentGeometry {
  private words = new Uint32Array(0)
  private length = 0
  get bytes() { return this.words.byteLength }
  reset() { this.words = new Uint32Array(0); this.length = 0 }
  update(values: Float32Array): { offset: number; data: Uint32Array<ArrayBuffer> } | undefined {
    const next = new Uint32Array(values.buffer, values.byteOffset, values.length)
    let first = 0
    while (first < Math.min(this.length, next.length) && this.words[first] === next[first]) first++
    if (first === next.length) { this.length = next.length; return }
    let end = next.length
    while (end > first && end <= this.length && this.words[end - 1] === next[end - 1]) end--
    if (next.length > this.words.length) {
      const resized = new Uint32Array(Math.max(4, 2 ** Math.ceil(Math.log2(next.length))))
      resized.set(this.words); this.words = resized
    }
    this.words.set(next.subarray(first, end), first); this.length = next.length
    return { offset: first * 4, data: this.words.subarray(first, end) }
  }
}
