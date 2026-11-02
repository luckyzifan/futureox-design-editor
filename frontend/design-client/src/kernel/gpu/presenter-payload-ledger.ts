/** Admission accounting for nominal presenter-owned texture/output payload.
 * Not physical VRAM: canvas backing, uniforms, overlay retirement and renderer
 * pools are outside this ledger. A settled prefix is not proof of device health
 * or that a browser/driver physically freed an allocation. */
export type PayloadKind = 'surface' | 'capture' | 'readback'
export type PayloadToken = Readonly<{ bytes: number; kind: PayloadKind }>
type Entry = { token: PayloadToken; state: 'reserved' | 'live' | 'retired' | 'released' }
type Waiter = { bytes: number; kind: 'capture' | 'readback'; resolve: (token: PayloadToken) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
const budgetError = (reason: string) => Error(`GPU display resident budget exceeded (${reason})`)
export class PresenterPayloadLedger {
  private entries = new WeakMap<PayloadToken, Entry>()
  private liveBytes = 0
  private allocationReservedBytes = 0
  private captureReservedBytes = 0
  private readbackReservedBytes = 0
  private retiringBytes = 0
  private pendingCaptures = 0
  private pendingReadbacks = 0
  private waiting: Entry[] = []
  private observing = false
  private generation = 0
  private closed = 0 // 0 open, 1 disposed, 2 known lost, 3 failed queue observer
  private waiters: Waiter[] = []
  constructor(private queuePrefix: () => Promise<void>, readonly budget: number,
    private externalBytes: () => number = () => 0, private timeoutMs = 2000) {}
  snapshot() {
    return { liveBytes: this.liveBytes, allocationReservedBytes: this.allocationReservedBytes,
      captureReservedBytes: this.captureReservedBytes, readbackReservedBytes: this.readbackReservedBytes,
      retiringBytes: this.retiringBytes, pendingCaptures: this.pendingCaptures,
      pendingReadbacks: this.pendingReadbacks, waiters: this.waiters.length, closed: this.closed }
  }
  assertOpen() { if (this.closed) throw budgetError('presenter retired or completion unavailable') }
  private validate(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw budgetError('invalid payload size')
  }
  private external() {
    const bytes = this.externalBytes()
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw budgetError('invalid external payload')
    return bytes
  }
  private fits(bytes: number, kind: PayloadKind) {
    return !(kind === 'capture' && this.pendingCaptures >= 1) && !(kind === 'readback' && this.pendingReadbacks >= 8) && this.liveBytes + this.allocationReservedBytes +
      this.captureReservedBytes + this.readbackReservedBytes + this.retiringBytes + this.external() + bytes <= this.budget
  }
  private admit(bytes: number, kind: PayloadKind) {
    const token = Object.freeze({ bytes, kind })
    this.entries.set(token, { token, state: 'reserved' })
    if (kind === 'surface') this.allocationReservedBytes += bytes
    else if (kind === 'capture') { this.captureReservedBytes += bytes; this.pendingCaptures++ }
    else { this.readbackReservedBytes += bytes; this.pendingReadbacks++ }
    return token
  }
  reserve(bytes: number, kind: PayloadKind = 'surface'): PayloadToken {
    this.assertOpen(); this.validate(bytes)
    if (!this.fits(bytes, kind)) throw budgetError('payload or concurrent capture limit')
    return this.admit(bytes, kind)
  }
  reserveNavigationBacking(bytes: number, nextFrameBytes: number): PayloadToken | undefined {
    this.assertOpen(); this.validate(bytes); this.validate(nextFrameBytes)
    if (this.fits(bytes + nextFrameBytes, 'surface')) return this.admit(bytes, 'surface')
  }
  reserveAsync(bytes: number, kind: 'capture' | 'readback'): Promise<PayloadToken> {
    try {
      this.assertOpen(); this.validate(bytes)
      if (this.fits(bytes, kind)) return Promise.resolve(this.admit(bytes, kind))
      // These bytes cannot settle on their own. Do not wait forever for a frame
      // that cannot fit even after retirement and other outputs have finished.
      if (this.liveBytes + this.allocationReservedBytes + this.external() + bytes > this.budget)
        throw budgetError('required payload cannot fit')
      if (this.waiters.length >= 16) throw budgetError('too many pending outputs')
      return new Promise((resolve, reject) => {
        const waiter: Waiter = { bytes, kind, resolve, reject, timer: setTimeout(() => {
          this.waiters = this.waiters.filter(item => item !== waiter)
          reject(budgetError('output admission timed out'))
        }, this.timeoutMs) }
        this.waiters.push(waiter)
      })
    } catch (error) { return Promise.reject(error) }
  }
  private entry(token: PayloadToken) {
    const entry = this.entries.get(token)
    if (!entry) throw Error('Presenter payload owner mismatch')
    return entry
  }
  private unreserve(token: PayloadToken) {
    if (token.kind === 'surface') this.allocationReservedBytes -= token.bytes
    else if (token.kind === 'capture') { this.captureReservedBytes -= token.bytes; this.pendingCaptures-- }
    else { this.readbackReservedBytes -= token.bytes; this.pendingReadbacks-- }
  }
  commit(token: PayloadToken) {
    this.assertOpen()
    const entry = this.entry(token)
    if (token.kind !== 'surface' || entry.state !== 'reserved') throw Error('Invalid presenter payload commit')
    this.unreserve(token); this.liveBytes += token.bytes; entry.state = 'live'
  }
  cancel(token: PayloadToken) {
    const entry = this.entry(token)
    if (entry.state !== 'reserved') return
    this.unreserve(token); entry.state = 'released'; this.wake()
  }
  /** Caller certifies output completion/handoff, not physical deallocation. */
  complete(token: PayloadToken) {
    this.assertOpen()
    this.cancel(token)
  }
  /** Caller has removed the CPU owner and will never submit a later use. */
  retire(token: PayloadToken) {
    const entry = this.entry(token)
    if (entry.state === 'released' || entry.state === 'retired') return
    if (entry.state === 'live') this.liveBytes -= token.bytes
    else this.unreserve(token)
    entry.state = 'retired'; this.retiringBytes += token.bytes
    this.waiting.push(entry); this.observe()
  }
  private observe() {
    if (this.closed || this.observing || !this.waiting.length) return
    // Detach BEFORE calling the queue: later retirements belong to a later
    // prefix even when a mocked/host callback is reentrant.
    const cohort = this.waiting; this.waiting = []
    const generation = this.generation
    this.observing = true
    let pending: Promise<void>
    try { pending = this.queuePrefix() } catch { this.failObserver(); return }
    Promise.resolve(pending).then(() => {
      if (this.closed || generation !== this.generation) return
      for (const entry of cohort) { this.retiringBytes -= entry.token.bytes; entry.state = 'released' }
      this.observing = false
      this.observe(); this.wake()
    }, () => { if (!this.closed && generation === this.generation) this.failObserver() })
  }
  private failObserver() {
    this.closed = 3; this.generation++; this.rejectWaiters(budgetError('queue completion failed'))
  }
  private wake() {
    if (this.closed) return
    for (const waiter of [...this.waiters]) {
      if (!this.fits(waiter.bytes, waiter.kind)) continue
      this.waiters = this.waiters.filter(item => item !== waiter); clearTimeout(waiter.timer)
      waiter.resolve(this.admit(waiter.bytes, waiter.kind))
    }
  }
  private rejectWaiters(error: Error) {
    const waiters = this.waiters; this.waiters = []
    for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(error) }
  }
  close(reason: 'lost' | 'disposed') {
    if (this.closed) return
    this.closed = reason === 'lost' ? 2 : 1; this.generation++
    // Keep charged counters. A loss-compatible promise cannot credit this
    // retired owner, much less an unrelated fresh presenter incarnation.
    this.rejectWaiters(budgetError('presenter retired or device lost'))
  }
}
