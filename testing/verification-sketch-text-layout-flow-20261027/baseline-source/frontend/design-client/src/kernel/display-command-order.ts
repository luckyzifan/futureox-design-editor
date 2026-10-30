/** Submission order belongs to display commands, not to reusable tile data.
 * A stale command never releases the cache textures it happens to reference. */
export class DisplayCommandOrder {
  private sequence = 0
  dropped = 0
  accept(sequence: number) {
    if (!Number.isSafeInteger(sequence) || sequence <= this.sequence) { this.dropped++; return false }
    this.sequence = sequence
    return true
  }
}
