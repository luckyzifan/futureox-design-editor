/** One speculative CPU job, independent of the GPU encoder. Errors are held
 * until consumption; cancellation drains ownership without an unhandled rejection. */
export class PrepareAhead<T> {
  private pending?: { index: number; result: Promise<{ value: T } | { error: unknown }> }
  starts = 0
  hits = 0
  start(index: number, work: () => Promise<T>) {
    if (this.pending) return
    this.starts++
    this.pending = { index, result: Promise.resolve().then(work).then(value => ({ value }), error => ({ error })) }
  }
  async take(index: number): Promise<T | undefined> {
    if (this.pending?.index !== index) return
    const pending = this.pending; this.pending = undefined
    const result = await pending.result
    this.hits++
    if ('error' in result) throw result.error
    return result.value
  }
  async drain() {
    const pending = this.pending; this.pending = undefined
    await pending?.result
  }
}
