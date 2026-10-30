/** Keep Figma's settle-then-refine behavior without starving refinement during
 * a continuous gesture. The age and scale guards are our host policy, not
 * constants recovered from Figma's viewer. */
export class InteractionDensity {
  value: number
  private target: number
  private changedAt = 0
  private queuedAt: number | undefined
  private stableFrames = 0
  constructor(value: number) {
    this.value = this.target = value
  }
  queue(value: number, now: number): boolean {
    if (value === this.target) return false
    this.target = value
    this.changedAt = now
    this.stableFrames = 0
    this.queuedAt ??= now
    // A large zoom jump must request useful pixels immediately, rather than
    // first filling the new viewport at the old, severely undersampled scale.
    if (value > this.value * 1.5 || value < this.value * 0.5) return this.publish()
    return false
  }
  frame(now: number): boolean {
    if (!this.pending) return false
    if (now > this.changedAt) this.stableFrames++
    return this.stableFrames >= 2 || now - this.queuedAt! >= 80 ? this.publish() : false
  }
  private publish() {
    const changed = this.value !== this.target
    this.value = this.target
    this.queuedAt = undefined
    this.stableFrames = 0
    return changed
  }
  get pending() {
    return this.queuedAt !== undefined
  }
}
