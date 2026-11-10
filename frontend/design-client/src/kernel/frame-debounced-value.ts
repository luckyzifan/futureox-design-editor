/** Frame-debounced value. Initial values publish immediately; a changed queued value
 * restarts the frame countdown. Repeating the queued value does not postpone
 * publication. In particular, queueing the committed value while another
 * value is pending still waits two frames. */
export class FrameDebouncedValue<T> {
  private current: { value: T } | null = null
  private queued: { value: T } | null = null
  private remaining = -1
  private readonly delayFrames: number
  private readonly equals: (a: T, b: T) => boolean

  constructor(delayFrames = 2, equals: (a: T, b: T) => boolean = Object.is) {
    this.delayFrames = delayFrames
    this.equals = equals
    if (!Number.isSafeInteger(delayFrames) || delayFrames < 1) throw Error('Invalid frame debounce')
  }

  queue(value: T): boolean {
    if (!this.current) { this.current = { value }; return true }
    if (this.queued ? this.equals(this.queued.value, value) : this.equals(this.current.value, value)) return false
    this.queued = { value }
    this.remaining = this.delayFrames
    return false
  }

  onFrame(): boolean {
    if (this.remaining <= 0 || --this.remaining > 0) return false
    this.current = this.queued
    this.queued = null
    this.remaining = -1
    return true
  }

  get value(): T | undefined { return this.current?.value }
  get pending(): boolean { return this.queued !== null }
  clear() { this.current = this.queued = null; this.remaining = -1 }
}
