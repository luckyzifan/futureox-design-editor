/** A child queues its actual composition before the parent's layout effect.
 * Stage that complete snapshot by render identity, then publish it atomically
 * when the parent commits. Imperative moves under the committed identity may
 * publish immediately. Abandoned/late render identities cannot replace it. */
export class CompositeFrameWitness<T> {
  current: T | null = null
  private owner?: object
  private staged = new WeakMap<object, T>()
  stage(owner: object, frame: T) {
    if (owner === this.owner) this.current = frame
    else this.staged.set(owner, frame)
  }
  commit(owner: object, fallback?: T | null) {
    this.owner = owner
    if (this.staged.has(owner)) this.current = this.staged.get(owner)!
    else if (fallback !== undefined) this.current = fallback
    this.staged.delete(owner)
  }
}
