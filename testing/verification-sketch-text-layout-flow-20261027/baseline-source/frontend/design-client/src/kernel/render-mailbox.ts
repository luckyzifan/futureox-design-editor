type RasterJob = {
  current: () => boolean
  work: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

/** Serialize raster jobs while allowing navigation to supersede queued work.
 * Running work is not cancelled by a camera change: its world pixels may still
 * cover the new viewport. Content/session invalidation remains the owner's job.
 * Obsolete waiting jobs are removed immediately; a slow native call must not
 * retain one document/plan closure and promise-chain link per pointer event. */
export class RenderMailbox {
  private queued: RasterJob[] = []
  private running = false

  /** Revoke waiting goals at a known quiet/scope boundary without cancelling
   * useful work which has already entered the renderer. */
  discardSuperseded() { this.queued = this.queued.filter(job => this.admit(job)) }

  run<T>(current: () => boolean, work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.discardSuperseded()
      this.queued.push({ current, work, resolve: value => resolve(value as T), reject })
      if (!this.running) {
        this.running = true
        queueMicrotask(() => { void this.drain() })
      }
    })
  }

  private admit(job: RasterJob) {
    try {
      if (job.current()) return true
      job.reject(new Error('PREVIEW_CANCELLED'))
    } catch (error) { job.reject(error) }
    return false
  }

  private async drain() {
    try {
      while (this.queued.length) {
        const job = this.queued.shift()!
        if (!this.admit(job)) continue
        try { job.resolve(await job.work()) }
        catch (error) { job.reject(error) }
      }
    } finally { this.running = false }
  }
}
