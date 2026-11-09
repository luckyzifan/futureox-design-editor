/** GPU texture lifetime. Logical retirement is not physical release: a texture
 * stays `retired-pending-completion` until the device epoch that encoded its
 * last read has completed. Only then is it `reclaimable`. */

export type ResourceLife = 'active' | 'retired-pending-completion' | 'reclaimable' | 'untracked'

export type ReleaseStep = 'skip' | 'held' | 'pool'

export class ResourceLedger<Texture extends object, Surface extends { texture: Texture }> {
  bytes = 0
  peak = 0
  readonly aliases = new Map<Texture, number>()
  released = new WeakSet<Surface>()
  readonly poolEpochs = new WeakMap<Texture, number>()

  charge(bytes: number) {
    this.bytes += bytes
    if (this.bytes > this.peak) this.peak = this.bytes
  }

  discharge(bytes: number) {
    this.bytes -= bytes
  }

  retain(texture: Texture) {
    this.aliases.set(texture, (this.aliases.get(texture) || 1) + 1)
  }

  /** One release of this surface. Alias holders stay out of the pool. The
   * caller still has to prove the texture is busy before recycling it. */
  beginRelease(surface: Surface | undefined): ReleaseStep {
    if (!surface || this.released.has(surface)) return 'skip'
    this.released.add(surface)
    const references = this.aliases.get(surface.texture)
    if (references) {
      if (references > 1) {
        this.aliases.set(surface.texture, references - 1)
        return 'held'
      }
      this.aliases.delete(surface.texture)
    }
    return 'pool'
  }

  notePoolReturn(texture: Texture, epoch: number | undefined) {
    if (Number.isSafeInteger(epoch) && epoch! > 0) this.poolEpochs.set(texture, epoch!)
    else this.poolEpochs.delete(texture)
  }

  clearPoolEpoch(texture: Texture) {
    this.poolEpochs.delete(texture)
  }

  /** Device loss drops alias and surface-release identity. Pool epochs and
   * byte charges remain until the caller destroys the physical textures. */
  forgetOwners() {
    this.aliases.clear()
    this.released = new WeakSet()
  }

  life(input: { busy: boolean; poolEpoch?: number; completedEpoch?: number }): ResourceLife {
    if (input.busy) return 'active'
    if (input.poolEpoch === undefined) return 'untracked'
    const completed = input.completedEpoch ?? -1
    return input.poolEpoch <= completed ? 'reclaimable' : 'retired-pending-completion'
  }
}
