/** Scheduling observations only. Completion here cannot free textures,
 * scratch, image tables, or advance a resource epoch. Those owners retain
 * their existing explicit lifetime fences. */
export class RasterQueuePacer {
  private observations: { sequence: number; done: Promise<void> }[] = []
  private failure?: { error: unknown }
  private check() { if (this.failure) throw this.failure.error }

  async yield(sequence: number, completed: number, observe: () => Promise<void>) {
    this.check()
    this.observations = this.observations.filter(item => item.sequence > completed)
    if (sequence <= completed) return
    if (this.observations.at(-1)?.sequence !== sequence) {
      const record = { sequence, done: Promise.resolve() }
      // Install both outcomes immediately, including synchronous queue errors.
      // An unattended low-water observation must never reject unhandled.
      let pending: Promise<void>
      try { pending = observe() } catch (error) { pending = Promise.reject(error) }
      record.done = pending.then(() => {
        this.observations = this.observations.filter(item => item !== record)
      }, error => { this.failure = { error } })
      this.observations.push(record)
    }
    if (sequence - completed >= 2) {
      // Wait only for the oldest recorded prefix, not for work/presentation
      // submitted after it. New camera composition can run during this await.
      await this.observations[0]?.done
      this.check()
    }
  }
}

export const RASTER_SLICE_COMMANDS = 64
