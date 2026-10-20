/** Numeric-only, opt-in navigation diagnostics. Never retains caller payloads. */
export interface NavigationJournalClock {
  now(): number
  readonly timeOrigin: number
  schedule(callback: () => void, delayMs: number): unknown
  cancel(handle: unknown): void
}
const fields = ['requestId', 'sequence', 'channel', 'x', 'y', 'zoom', 'width', 'height', 'compileMs', 'graphMs', 'finishMs', 'tiles', 'frames'] as const
export type NavigationJournalEvent = { at: number; stage: number } & Partial<Record<(typeof fields)[number], number>>
export interface NavigationJournalReport {
  timeOrigin: number
  /** Event at values are monotonic milliseconds relative to timeOrigin. */
  clock: 'performance.now'
  capacity: number
  dropped: number
  recording: boolean
  events: NavigationJournalEvent[]
  /** 0 unset, 1 manual, 2 timeout, 3 restart, 4 dispose, 5 device loss. */
  stopReason: number
}
export function validateNavigationJournalOptions(options: unknown): { capacity: number; durationMs: number } {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) throw new TypeError('options must be an object')
  if (Reflect.ownKeys(options).some(key => key !== 'capacity' && key !== 'durationMs')) throw new TypeError('unknown journal option')
  const value = options as Record<string, unknown>
  const capacity = value.capacity === undefined ? 2048 : value.capacity
  const durationMs = value.durationMs === undefined ? 10000 : value.durationMs
  if (typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity < 16 || capacity > 4096) throw new RangeError('capacity must be an integer between 16 and 4096')
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 100 || durationMs > 30000) throw new RangeError('durationMs must be between 100 and 30000')
  return { capacity, durationMs }
}
const defaultClock: NavigationJournalClock = {
  now: () => performance.now(),
  get timeOrigin() { return performance.timeOrigin },
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}
export class NavigationJournal {
  private ring: Array<NavigationJournalEvent | undefined> = []
  private capacity = 2048
  private count = 0
  private next = 0
  private dropped = 0
  private active = false
  private timeOrigin = 0
  private deadline = 0
  private stopReason = 0
  private timer: unknown
  private hasTimer = false
  private sessionGeneration = 0
  constructor(private readonly clock: NavigationJournalClock = defaultClock) {}
  get recording(): boolean { return this.active }
  /** Changes at stop/restart, for discarding completions from older sessions. */
  get generation(): number { return this.sessionGeneration }
  start(options: { capacity?: number; durationMs?: number } = {}): void {
    const { capacity, durationMs } = validateNavigationJournalOptions(options)
    this.stop(3)
    this.capacity = capacity
    this.ring = new Array(capacity)
    this.count = this.next = this.dropped = 0
    this.timeOrigin = this.clock.timeOrigin
    this.deadline = this.clock.now() + durationMs
    this.stopReason = 0
    this.active = true
    const generation = this.sessionGeneration
    this.timer = this.clock.schedule(() => {
      if (generation === this.sessionGeneration && this.active) this.stop(2)
    }, durationMs)
    this.hasTimer = true
  }
  stop(reason = 1): void {
    if (!Number.isInteger(reason) || reason < 1 || reason > 5) throw new RangeError('stop reason must be an integer between 1 and 5')
    this.sessionGeneration++
    if (this.hasTimer) this.clock.cancel(this.timer)
    this.hasTimer = false
    this.timer = undefined
    if (this.active) this.stopReason = reason
    this.active = false
  }
  dispose(): void { this.stop(4) }
  record(stage: number, values: Record<string, unknown> = {}): void {
    // The disabled hot path performs no clock reads.
    if (!this.active) return
    if (!Number.isInteger(stage) || stage < 1 || stage > 10) return
    const at = this.clock.now()
    if (at >= this.deadline) { this.stop(2); return }
    if (!Number.isFinite(at)) return
    const event: NavigationJournalEvent = { at, stage }
    for (const field of fields) {
      if (!Object.prototype.hasOwnProperty.call(values, field)) continue
      const value = values[field]
      if (typeof value === 'number' && Number.isFinite(value)) event[field] = value
    }
    this.ring[this.next] = event
    this.next = (this.next + 1) % this.capacity
    if (this.count === this.capacity) this.dropped++
    else this.count++
  }
  report(): NavigationJournalReport {
    const events: NavigationJournalEvent[] = []
    const first = (this.next - this.count + this.capacity) % this.capacity
    for (let i = 0; i < this.count; i++) events.push({ ...this.ring[(first + i) % this.capacity]! })
    return { timeOrigin: this.timeOrigin, clock: 'performance.now', capacity: this.capacity, dropped: this.dropped, recording: this.active, events, stopReason: this.stopReason }
  }
}
