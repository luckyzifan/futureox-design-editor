/** Serialize raster jobs while allowing navigation to supersede queued work.
 * Running work is not cancelled by a camera change: its world pixels may still
 * cover the new viewport. Content/session invalidation remains the owner's job. */
export class RenderMailbox {
  private tail: Promise<void> = Promise.resolve()

  run<T>(current: () => boolean, work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => {
      if (!current()) throw new Error('PREVIEW_CANCELLED')
      return work()
    })
    this.tail = result.then(() => {}, () => {})
    return result
  }
}
