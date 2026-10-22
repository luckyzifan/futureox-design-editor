/** Zero means defer without completion credit. Reusable pool storage stays
 * charged by workingBytes; only transient retirement consumes the 64 MiB cap.
 * Reasons: 1 invalid ledger/epoch, 2 mandatory boundary, 3 working watermark,
 * 4 transient limit, 5 bounded consecutive deferrals exhausted. */
export class MaintenanceResidency {
  private deferred = 0
  decide(required: number, mandatory: boolean, working: number, budget: number,
    pool: number, transient: number, epoch: number | undefined, completed: number | undefined): number {
    if (![required, working, budget, pool, transient, epoch, completed].every(v => Number.isSafeInteger(v) && v! >= 0) ||
      !budget || completed! > epoch! || pool + transient > working) return 1
    if (required !== 0 || mandatory) return 2
    if (working > budget * .75) return 3
    if (transient > Math.min(64 * 1024 * 1024, budget * .25)) return 4
    if (this.deferred >= 8) return 5
    this.deferred++
    return 0
  }
  completed() { this.deferred = 0 }
  get count() { return this.deferred }
}
