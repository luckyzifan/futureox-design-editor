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

export type TrackedResource = {
  id: number
  class: ResourceClass
  bytes: number
  width: number
  height: number
  life: LifeBucket
  poolEpoch: number
}

/** Same-condition identity. Cold and warm are different keys, so a warm-up
 * sample is not a cyclic trend point. */
export type ResidencyCondition = {
  viewport: string
  materialKeys: string
  scale: string
  dpr: string
  thermal: 'cold' | 'warm'
}

export type CyclePoint = {
  cycle: number
  conditionKey: string
  chargedBytes: number
  /** Charged bytes after this completion's physical releases. Retired-pending
   * bytes are still included. */
  stableBytes: number
  peakBytes: number
  releasedBytes: number
  classes: ByteBreakdown
  life: LifeBreakdown
}

export type PressureTrend = {
  conditionKey: string | null
  thermal: 'cold' | 'warm' | null
  cycles: number
  stableBytes: number[]
  peakBytes: number[]
  delta: number
  grew: boolean
  crossConditionResets: number
}

export type TextureAttribution = ResidencySample & {
  peakBytes: number
  completedFreeBytes: number
  peakSample: ResidencySample | null
  completionSample: ResidencySample | null
  stableBytes: number | null
  conditionKey: string | null
  resources: TrackedResource[]
  trend: PressureTrend
}

const emptyClasses = (): ByteBreakdown => ({
  unclassified: 0, scratch: 0, surface: 0, coverage: 0, 'material-field': 0, image: 0, kernel: 0, atlas: 0, upload: 0,
})

const emptyLife = (): LifeBreakdown => ({
  active: 0, 'retired-pending-completion': 0, reclaimable: 0, 'epoch-unknown': 0,
})

type Track = { id: number; class: ResourceClass; width: number; height: number; parkedEpoch?: number }

const finiteDim = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : 0

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
  private readonly tracked = new Map<Texture, Track>()
  private readonly pendingEpochs = new Map<number, number>()
  private nextId = 1
  private conditionKey: string | null = null
  private conditionThermal: 'cold' | 'warm' | null = null
  private cycle = 0
  private trend: CyclePoint[] = []
  private latestResources: TrackedResource[] = []
  crossConditionResets = 0

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
      stableBytes: this.trend.length ? this.trend[this.trend.length - 1].stableBytes : null,
      conditionKey: this.conditionKey,
      resources: this.latestResources.map(row => ({ ...row })),
      trend: this.pressureTrend(),
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
      const shape = texture as { width?: number; height?: number }
      this.tracked.set(texture, { id: this.nextId++, class: klass, width: finiteDim(shape.width), height: finiteDim(shape.height) })
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

  /** Drop per-resource rows after the device is gone. Byte charges stay with
   * the caller; this only stops the row table from pinning destroyed textures. */
  forgetTracked() {
    this.tracked.clear()
    this.pendingEpochs.clear()
    this.lifeBytes.active = 0
    this.lifeBytes['retired-pending-completion'] = 0
    this.lifeBytes.reclaimable = 0
    this.lifeBytes['epoch-unknown'] = 0
    this.latestResources = []
  }

  bindCondition(condition: ResidencyCondition) {
    if (!validCondition(condition)) return false
    const key = residencyConditionKey(condition)
    if (this.conditionKey !== key) {
      if (this.conditionKey !== null) this.crossConditionResets++
      this.conditionKey = key
      this.conditionThermal = condition.thermal
      this.trend = []
      this.cycle = 0
    }
    return true
  }

  /** Record one same-condition sample. `releasedBytes` must already have been
   * destroyed. This does not subtract retired-pending or reclaimable bytes. */
  recordCycle(completed: number | undefined, releasedBytes: number): CyclePoint | null {
    if (!this.conditionKey) return null
    if (!Number.isSafeInteger(completed) || completed! < 0) return null
    if (!Number.isSafeInteger(releasedBytes) || releasedBytes < 0) return null
    if (!Number.isSafeInteger(this.bytes) || this.bytes < 0) return null
    this.noteCompletion(completed)
    this.cycle += 1
    const point: CyclePoint = {
      cycle: this.cycle, conditionKey: this.conditionKey, chargedBytes: this.bytes, stableBytes: this.bytes,
      peakBytes: this.peak, releasedBytes, classes: { ...this.classes }, life: { ...this.lifeBytes },
    }
    this.trend.push(point)
    if (this.trend.length > 8) this.trend.shift()
    this.latestResources = this.resources(completed)
    return point
  }

  resources(completed?: number): TrackedResource[] {
    const rows: TrackedResource[] = []
    for (const [texture, slot] of this.tracked) {
      const bytes = (texture as { bytes?: number }).bytes
      if (!finiteBytes(bytes ?? -1)) continue
      rows.push({
        id: slot.id, class: slot.class, bytes: bytes!, width: slot.width, height: slot.height,
        life: this.rowLife(slot, completed), poolEpoch: slot.parkedEpoch ?? 0,
      })
    }
    rows.sort((left, right) => left.id - right.id)
    return rows
  }

  pressureTrend(): PressureTrend {
    const stableBytes = this.trend.map(point => point.stableBytes)
    let grew = false
    for (let index = 1; index < stableBytes.length; index++) if (stableBytes[index] > stableBytes[index - 1]) grew = true
    return {
      conditionKey: this.conditionKey, thermal: this.conditionThermal, cycles: this.trend.length, stableBytes,
      peakBytes: this.trend.map(point => point.peakBytes),
      delta: stableBytes.length >= 2 ? stableBytes[stableBytes.length - 1] - stableBytes[0] : 0,
      grew, crossConditionResets: this.crossConditionResets,
    }
  }

  private rowLife(slot: Track, completed: number | undefined): LifeBucket {
    if (slot.parkedEpoch === undefined) return 'active'
    if (slot.parkedEpoch === 0) return 'epoch-unknown'
    return Number.isSafeInteger(completed) && slot.parkedEpoch <= completed! ? 'reclaimable' : 'retired-pending-completion'
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

const bounded = (value: string) => value.length <= 512 && !value.includes('\0')

function validCondition(condition: ResidencyCondition) {
  return (condition.thermal === 'cold' || condition.thermal === 'warm') &&
    [condition.viewport, condition.materialKeys, condition.scale, condition.dpr].every(value => typeof value === 'string' && bounded(value))
}

export function residencyBaseKey(condition: Pick<ResidencyCondition, 'viewport' | 'materialKeys' | 'scale' | 'dpr'>) {
  return [condition.viewport, condition.materialKeys, condition.scale, condition.dpr].join('\n')
}

export function residencyConditionKey(condition: ResidencyCondition) {
  return `${residencyBaseKey(condition)}\n${condition.thermal}`
}

function fnv128(text: string) {
  let a = 0x811c9dc5, b = 0x01000193, c = 0x811c9dc5 ^ 0x01000193, d = 0x9e3779b1
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    a = Math.imul(a ^ code, 0x01000193)
    b = Math.imul(b ^ (code + 0x9e), 0x01000193)
    c = Math.imul(c ^ (code + 0x7f), 0x01000193)
    d = Math.imul(d ^ (code + 3), 0x01000193)
  }
  return [a, b, c, d].map(part => (part >>> 0).toString(16).padStart(8, '0')).join('')
}

function num(value: unknown): string | undefined {
  if (value === undefined) return ''
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Object.is(value, -0) ? '-0' : String(value)
}

export type SceneResidencySource = {
  view?: { x?: unknown; y?: unknown; zoom?: unknown; dpr?: unknown }
  output?: { x?: unknown; y?: unknown; w?: unknown; h?: unknown }
  extent?: { w?: unknown; h?: unknown }
  width?: unknown
  height?: unknown
  resolve?: { scale?: unknown }
  presentation?: { scale?: unknown }
  densePaint?: { width?: unknown; height?: unknown; nodes?: Record<string, unknown>; sources?: Record<string, unknown> }
}

/** Viewport, material-key set, scale, DPR and cold/warm. Missing DPR is an
 * empty token; a non-finite DPR rejects the sample instead of mixing it. */
export function sceneResidencyCondition(scene: SceneResidencySource, warm: boolean): ResidencyCondition | undefined {
  const view = scene.view
  if (!view) return undefined
  const x = num(view.x), y = num(view.y), zoom = num(view.zoom), dpr = num(view.dpr)
  if (!x || !y || !zoom || dpr === undefined) return undefined
  const output = scene.output, extent = scene.extent
  const parts = [x, y, zoom,
    output ? num(output.x) : '', output ? num(output.y) : '', output ? num(output.w) : '', output ? num(output.h) : '',
    extent ? num(extent.w) : '', extent ? num(extent.h) : '', num(scene.width), num(scene.height)]
  if (parts.some(part => part === undefined)) return undefined
  const scales = [num(scene.resolve?.scale), num(scene.presentation?.scale)]
  if (scales.some(part => part === undefined)) return undefined
  const dense = scene.densePaint
  let materialKeys = '0'
  if (dense) {
    const width = num(dense.width), height = num(dense.height)
    if (!width || !height) return undefined
    const nodes = dense.nodes && typeof dense.nodes === 'object' ? Object.keys(dense.nodes).sort() : []
    const sources = dense.sources && typeof dense.sources === 'object' ? Object.keys(dense.sources).sort() : []
    materialKeys = `${nodes.length}+${sources.length}:${fnv128(nodes.join('\n') + '\n' + sources.join('\n') + '\n' + width + 'x' + height)}`
  }
  const condition: ResidencyCondition = {
    viewport: (parts as string[]).join(','), materialKeys,
    scale: scales.filter(part => part !== '').join(',') || '1', dpr, thermal: warm ? 'warm' : 'cold',
  }
  return validCondition(condition) ? condition : undefined
}
