import { markRenderFailure } from '../render-failure-telemetry'
/** CPU-side queue-completion observations, never GPU timestamp duration or
 * queue.submit return/acknowledgement latency. Fixed-size driver-lifetime data.
 * Timing is opt-in; counts remain available without clock reads or samples. */
export const queueWaitReasons = ['readback', 'timing', 'prefix-scratch', 'interaction', 'periodic', 'admission', 'checkpoint', 'cancel', 'initialization', 'park'] as const
export type QueueWaitReason = typeof queueWaitReasons[number]
const upperBoundsMs = [1, 4, 8, 16, 33, 100, 1000] as const
const counter = () => ({ started: 0, completed: 0, rejected: 0, deviceLost: 0, pending: 0, cpuWaitMs: 0, maxCpuWaitMs: 0 })
export class QueueWaitStats {
  private submits = 0
  private submitFailures = 0
  private waits = counter()
  private reasons = Object.fromEntries(queueWaitReasons.map(reason => [reason, counter()])) as Record<QueueWaitReason, ReturnType<typeof counter>>
  private histogram = Array<number>(upperBoundsMs.length + 1).fill(0)
  constructor(readonly timingEnabled = false, private now: () => number = () => performance.now()) {}
  submit(action: () => void) {
    try { action(); this.submits++ } catch (error) { this.submitFailures++; throw markRenderFailure(error, { failureStage: 8 }) }
  }
  async wait(reason: QueueWaitReason, action: () => Promise<void>, lost: () => boolean) {
    const entry = this.reasons[reason]
    this.waits.started++; this.waits.pending++; entry.started++; entry.pending++
    const start = this.timingEnabled ? this.now() : 0
    try {
      await action()
      this.waits.completed++; entry.completed++
    } catch (error) {
      this.waits.rejected++; entry.rejected++
      throw markRenderFailure(error, { failureStage: 9 })
    } finally {
      this.waits.pending--; entry.pending--
      if (lost()) { this.waits.deviceLost++; entry.deviceLost++ }
      if (this.timingEnabled) {
        const elapsed = this.now() - start
        if (Number.isFinite(elapsed) && elapsed >= 0) {
          this.waits.cpuWaitMs += elapsed; entry.cpuWaitMs += elapsed
          this.waits.maxCpuWaitMs = Math.max(this.waits.maxCpuWaitMs, elapsed)
          entry.maxCpuWaitMs = Math.max(entry.maxCpuWaitMs, elapsed)
          const bucket = upperBoundsMs.findIndex(bound => elapsed <= bound)
          this.histogram[bucket < 0 ? upperBoundsMs.length : bucket]++
        }
      }
    }
  }
  snapshot(resourceEpoch: number, completedResourceEpoch: number) {
    return {
      scope: 'driver-lifetime' as const, metric: 'cpu-queue-completion-wait' as const,
      timingEnabled: this.timingEnabled, submitCalls: this.submits, submitFailures: this.submitFailures,
      resourceEpoch, completedResourceEpoch, pendingResourceEpochs: Math.max(0, resourceEpoch - completedResourceEpoch),
      ...this.waits,
      reasons: Object.fromEntries(queueWaitReasons.map(reason => [reason, { ...this.reasons[reason] }])),
      histogram: { upperBoundsMs: [...upperBoundsMs], counts: [...this.histogram] },
    }
  }
}
export type QueueWaitSnapshot = ReturnType<QueueWaitStats['snapshot']>
