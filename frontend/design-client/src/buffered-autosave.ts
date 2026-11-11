export const AUTOSAVE_IDLE_MS = 3000

/** Keep one trailing save request while the current snapshot is being written. */
export class BufferedAutosave {
  private timer?: ReturnType<typeof setTimeout>
  private ready = false
  private writing = false

  constructor(
    private readonly save: () => Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}

  schedule(delay = AUTOSAVE_IDLE_MS) {
    this.cancel()
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.ready = true
      void this.drain()
    }, delay)
  }

  cancel() {
    clearTimeout(this.timer)
    this.timer = undefined
    this.ready = false
  }

  private async drain() {
    if (!this.ready || this.writing) return
    this.ready = false
    this.writing = true
    try {
      await this.save()
    } catch (error) {
      this.onError(error)
    } finally {
      this.writing = false
      if (this.ready) void this.drain()
    }
  }
}
