/** GPU texture lifetime. Logical retirement is not physical release: a texture
 * stays `retired-pending-completion` until the device epoch that encoded its
 * last read has completed. Only then is it `reclaimable`. Peak bytes stay the
 * high-water mark. Class and life totals are an accounting sample, not a
 * measured device allocation. */

export type ResourceLife = 'active' | 'retired-pending-completion' | 'reclaimable' | 'untracked'

export type ReleaseStep = 'skip' | 'held' | 'pool'

export const RESOURCE_CLASSES = [
  'unclassified', 'scratch', 'surface', 'coverage', 'material-field', 'image', 'kernel', 'atlas', 'upload',
] as const

export type ResourceClass = (typeof RESOURCE_CLASSES)[number]

export type LifeBucket = 'active' | 'retired-pending-completion' | 'reclaimable' | 'epoch-unknown'

export type ByteBreakdown = Record<ResourceClass, number>
export type LifeBreakdown = Record<LifeBucket, number>

export type ResidencySample = {
  chargedBytes: number
  classes: ByteBreakdown
  life: LifeBreakdown
}

export type TextureAttribution = ResidencySample & {
  peakBytes: number
  completedFreeBytes: number
  peakSample: ResidencySample | null
  completionSample: ResidencySample | null
}

const emptyClasses = (): ByteBreakdown => ({
  unclassified: 0, scratch: 0, surface: 0, coverage: 0, 'material-field': 0, image: 0, kernel: 0, atlas: 0, upload: 0,
})

const emptyLife = (): LifeBreakdown => ({
  active: 0, 'retired-pending-completion': 0, reclaimable: 0, 'epoch-unknown': 0,
})

type Track = { class: ResourceClass; parkedEpoch?: number }

const finiteBytes = (bytes: number) => Number.isSafeInteger(bytes) && bytes >= 0

export class ResourceLedger<Texture extends object, Surface extends { texture: Texture }> {
  bytes = 0
  peak = 0
  /** Bytes destroyed from the completed free pool. Peak stays the high-water
   * mark; this counter is the part of that peak that was spare residency. */
  completedFreeBytes = 0
  readonly aliases = new Map<Texture, number>()
  released = new WeakSet<Surface>()
  readonly poolEpochs = new WeakMap<Texture, number>()
  readonly classes: ByteBreakdown = emptyClasses()
  readonly lifeBytes: LifeBreakdown = emptyLife()
  peakSample: ResidencySample | null = null
  completionSample: ResidencySample | null = null
  private readonly tracked = new WeakMap<Texture, Track>()
  private readonly pendingEpochs = new Map<number, number>()

  charge(bytes: number, klass: ResourceClass = 'unclassified') {
    this.applyDelta(bytes, klass)
  }

  discharge(bytes: number, klass: ResourceClass = 'unclassified') {
    this.applyDelta(-bytes, klass)
  }

  /** One signed change of the charged total. A new high-water mark copies the
   * class totals from before any life move the caller still has to record. */
  applyDelta(delta: number, klass: ResourceClass) {
    if (!Number.isFinite(delta) || delta === 0) return
    this.bytes += delta
    this.classes[klass] += delta
    if (this.bytes > this.peak) {
      this.peak = this.bytes
      this.peakSample = this.sample()
    }
  }

  sample(): ResidencySample {
    return { chargedBytes: this.bytes, classes: { ...this.classes }, life: { ...this.lifeBytes } }
  }

  attribution(): TextureAttribution {
    return {
      ...this.sample(),
      peakBytes: this.peak,
      completedFreeBytes: this.completedFreeBytes,
      peakSample: this.peakSample,
      completionSample: this.completionSample,
    }
  }

  trackedClass(texture: Texture) {
    return this.tracked.get(texture)?.class
  }

  /** Charge `texture.bytes` and remember it as active. A second call does not
   * add the life bytes again. */
  chargeTracked(texture: Texture & { bytes: number }, klass: ResourceClass) {
    const bytes = texture.bytes
    if (!finiteBytes(bytes)) return
    const seen = this.tracked.has(texture)
    this.applyDelta(bytes, klass)
    if (!seen) {
      this.tracked.set(texture, { class: klass })
      this.lifeBytes.active += bytes
      if (this.peak === this.bytes) this.peakSample = this.sample()
    }
  }

  /** Drop a tracked texture's life first, then its class charge. An unknown
   * texture still subtracts `unclassified` bytes so the total cannot drift
   * past a destroy the caller already performed. */
  dischargeTracked(texture: Texture & { bytes: number }, completed: number | undefined) {
    if (!finiteBytes(texture.bytes)) return
    const klass = this.untrack(texture, completed) ?? 'unclassified'
    this.applyDelta(-texture.bytes, klass)
    this.noteCompletion(completed)
  }

  noteCompletedFree(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) return
    this.completedFreeBytes += bytes
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

  /** A positive pool stamp is still ahead of device completion. A missing
   * completion proof keeps that stamp pending. Epoch 0 and a missing stamp
   * are not this proof. */
  poolReleasePending(poolEpoch: number | undefined, completedEpoch: number | undefined) {
    if (!Number.isSafeInteger(poolEpoch) || poolEpoch! <= 0) return false
    if (!Number.isSafeInteger(completedEpoch) || completedEpoch! < 0) return true
    return poolEpoch! > completedEpoch!
  }

  noteCompletion(completed: number | undefined) {
    this.fold(completed)
    if (Number.isSafeInteger(completed) && completed! >= 0) this.completionSample = this.sample()
  }

  /** Move one active tracked texture into the pool life that `epoch` proves.
   * Bytes stay charged. Epoch 0 means the device never reported an encode. */
  park(texture: Texture & { bytes: number }, epoch: number | undefined, completed: number | undefined) {
    const slot = this.tracked.get(texture)
    if (!slot || slot.parkedEpoch !== undefined || !finiteBytes(texture.bytes)) return
    this.fold(completed)
    this.lifeBytes.active -= texture.bytes
    const known = Number.isSafeInteger(epoch) && epoch! > 0
    if (!known) {
      this.lifeBytes['epoch-unknown'] += texture.bytes
      slot.parkedEpoch = 0
    } else if (Number.isSafeInteger(completed) && epoch! <= completed!) {
      this.lifeBytes.reclaimable += texture.bytes
      slot.parkedEpoch = epoch
    } else {
      this.lifeBytes['retired-pending-completion'] += texture.bytes
      this.pendingEpochs.set(epoch!, (this.pendingEpochs.get(epoch!) || 0) + texture.bytes)
      slot.parkedEpoch = epoch
    }
    this.noteCompletion(completed)
  }

  unpark(texture: Texture & { bytes: number }, completed: number | undefined) {
    const slot = this.tracked.get(texture)
    if (!slot || slot.parkedEpoch === undefined || !finiteBytes(texture.bytes)) return
    this.fold(completed)
    this.takeParked(texture.bytes, slot.parkedEpoch, completed)
    slot.parkedEpoch = undefined
    this.lifeBytes.active += texture.bytes
    this.noteCompletion(completed)
  }

  private untrack(texture: Texture & { bytes: number }, completed: number | undefined) {
    const slot = this.tracked.get(texture)
    if (!slot) return undefined
    this.fold(completed)
    if (slot.parkedEpoch === undefined) this.lifeBytes.active -= texture.bytes
    else this.takeParked(texture.bytes, slot.parkedEpoch, completed)
    this.tracked.delete(texture)
    return slot.class
  }

  private fold(completed: number | undefined) {
    if (!Number.isSafeInteger(completed) || completed! < 0) return
    for (const [epoch, bytes] of [...this.pendingEpochs]) {
      if (epoch <= completed!) {
        this.pendingEpochs.delete(epoch)
        this.lifeBytes['retired-pending-completion'] -= bytes
        this.lifeBytes.reclaimable += bytes
      }
    }
  }

  private takeParked(bytes: number, epoch: number, completed: number | undefined) {
    if (epoch === 0) {
      this.lifeBytes['epoch-unknown'] -= bytes
      return
    }
    if (Number.isSafeInteger(completed) && epoch <= completed!) {
      this.lifeBytes.reclaimable -= bytes
      return
    }
    this.lifeBytes['retired-pending-completion'] -= bytes
    const left = (this.pendingEpochs.get(epoch) || 0) - bytes
    if (left <= 0) this.pendingEpochs.delete(epoch)
    else this.pendingEpochs.set(epoch, left)
  }
}
