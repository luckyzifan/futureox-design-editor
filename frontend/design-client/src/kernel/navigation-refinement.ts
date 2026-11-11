import type { RenderMailbox } from './render-mailbox'

export type NavigationRefinementGoal = {
  /** Includes content/session, viewport, DPR and presenter-device ownership. */
  scope: string
  /** Identifies a useful demand for this single raster turn. */
  sequence: number | string
  continuous?: boolean
  budgetMs?: number
  current(): boolean
  /** Resolve one current visible native miss at execution time, then await it. */
  run(): Promise<void | boolean>
  failed(error: unknown): void
}

/** Bounded fairness between continuity previews and actual screen-density
 * tiles. At most one queued/running turn, no private render queue and no
 * unbounded on-screen exemption. Camera updates replace the goal, not useful
 * already-started world pixels. A scope change revokes queued work. */
export class NavigationRefinementScheduler {
  private goal?: NavigationRefinementGoal
  private busy = false
  private credit?: { scope: string; sequence: NavigationRefinementGoal['sequence'] }

  constructor(private readonly mailbox: Pick<RenderMailbox, 'run'>) {}

  update(goal?: NavigationRefinementGoal) { this.goal = goal }

  async request(): Promise<boolean> {
    const requested = this.goal
    if (!requested || this.busy || !requested.current() ||
        this.credit?.scope === requested.scope && this.credit.sequence === requested.sequence) return false
    this.busy = true
    this.credit = { scope: requested.scope, sequence: requested.sequence }
    const owns = () => this.goal?.scope === requested.scope && this.goal.current()
    try {
      let more = false, spent = 0, turns = 0
      do {
      more = false
      await this.mailbox.run(owns, async () => {
        // Read the latest goal only after older preview work releases the
        // mailbox. Never refine the obsolete camera which earned the turn.
        const goal = this.goal
        if (goal && owns()) {
          // A queued turn may retarget to a newer sample. Spend that actual
          // sample's credit as well, so it cannot earn a second identical turn.
          this.credit = { scope: goal.scope, sequence: goal.sequence }
          const started = performance.now()
          more = await goal.run() === true && goal.continuous === true
          spent += performance.now() - started
        }
      })
      turns++
      // Release queue ownership after every tile. Actual measured work bounds
      // a burst; a slow tile cannot imply a millisecond preemption guarantee.
      } while (more && owns() && turns < 4 && spent < (this.goal?.budgetMs ?? Infinity))
      return true
    } catch (error) {
      if (!String(error).includes('PREVIEW_CANCELLED') && owns()) this.goal!.failed(error)
      return false
    } finally { this.busy = false }
  }
}
