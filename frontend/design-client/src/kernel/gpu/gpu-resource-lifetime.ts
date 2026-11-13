import {
  device_loss_owner_reset,
  pool_epoch_reclaimable,
  retired_upload_due,
  select_completed_pool_drops,
} from '../../generated/design-kernel/design_kernel'
import { ResourceLedger, type ResourceClass } from './resource-ledger'
import { SurfacePool } from './surface-pool'

/** Pool key shared by acquire, retire, and physical release. Scalar wins when
 * both coverage modes are set, matching the previous inline format. */
export function surfacePoolKey(width: number, height: number, binary = false, scalar = false) {
  return `${scalar ? 'scalar:' : binary ? 'binary:' : ''}${width}:${height}`
}

type PoolTexture = {
  bytes: number
  width: number
  height: number
  scalarCoverage?: boolean
  binaryCoverage?: boolean
}

export type LifetimeHost<Texture extends PoolTexture> = {
  /** Material fields and gradient-phase resources have their own owner. */
  protectedTexture(texture: Texture): boolean
  dropPhase(texture: Texture): void
  frameUse(texture: Texture): boolean
  dropFrameUse(texture: Texture): void
  pinned(texture: Texture): boolean
  destroy(texture: Texture): void
  resourceEpoch(): number | undefined
  completedEpoch(): number | undefined
}

/**
 * Unique owner for GPU texture hold, retire, and physical release.
 *
 * Call path: `GpuRenderer` → this owner → the kernel receipt
 * (`pool_epoch_reclaimable`, `select_completed_pool_drops`,
 * `retired_upload_due`, `device_loss_owner_reset`)
 * → `driver.destroy` only after that receipt.
 * WebGPU texture objects stay in JavaScript. Logical retirement is not
 * physical release, and device loss forgets aliases without clearing the
 * charged byte total.
 */
export class GpuResourceLifetime<Texture extends PoolTexture, Surface extends { texture: Texture }> {
  readonly ledger = new ResourceLedger<Texture, Surface>()
  readonly free = new SurfacePool<Texture>()
  readonly busy = new Set<Texture>()
  readonly lastUsed = new Map<Texture, number>()
  readonly retiredUploads: Texture[] = []
  readonly retiredKernels: { texture: Texture; epoch: number }[] = []
  deviceLossReceipts = 0
  private generation = 0

  constructor(private readonly host: LifetimeHost<Texture>) {}

  hold(surface: Surface): Surface {
    this.ledger.retain(surface.texture)
    return { ...surface }
  }

  /** Logical retirement. Alias holders stay out of the pool. The texture is
   * not destroyed; its encode epoch becomes the completion receipt. */
  retire(surfaces: readonly (Surface | undefined)[]) {
    for (const surface of new Set(surfaces)) {
      if (!surface || this.host.protectedTexture(surface.texture)) continue
      if (this.ledger.beginRelease(surface) !== 'pool') continue
      if (!this.busy.delete(surface.texture)) continue
      const key = surfacePoolKey(surface.texture.width, surface.texture.height, !!surface.texture.binaryCoverage, !!surface.texture.scalarCoverage)
      const list = this.free.get(key) || []
      list.push(surface.texture)
      this.free.added?.(surface.texture)
      this.ledger.notePoolReturn(surface.texture, this.host.resourceEpoch())
      this.ledger.park(surface.texture, this.host.resourceEpoch(), this.host.completedEpoch())
      if (this.free.setOwned) this.free.setOwned(key, list)
      else this.free.set(key, list)
      this.touch(surface.texture)
    }
  }

  touch(texture: Texture) {
    const age = ++this.generation
    this.lastUsed.set(texture, age)
    this.free.touched?.(texture, age)
  }

  /** Pop one queue-ordered free texture. An emptied list stays, as acquire
   * previously left the key in place. */
  takePooled(key: string): Texture | undefined {
    const list = this.free.get(key)
    const texture = list?.pop()
    if (!texture) return
    this.ledger.unpark(texture, this.host.completedEpoch())
    this.free.removed?.(texture)
    return texture
  }

  /** Queue a parameter upload until a completed checkpoint. Protected fields
   * stay with their cache. `detach` runs only when the upload is actually
   * queued, before it becomes eligible for release. */
  queueUploadRetirement(texture: Texture, detach: () => void) {
    if (this.host.protectedTexture(texture)) return
    detach()
    this.retiredUploads.push(texture)
  }

  /** Physical release of one upload or coordinate texture. Callers must
   * already hold a completion receipt or a lost-device destroy. */
  releaseUpload(texture: Texture) {
    this.host.dropPhase(texture)
    this.busy.delete(texture)
    this.host.dropFrameUse(texture)
    this.lastUsed.delete(texture)
    this.host.destroy(texture)
    this.ledger.dischargeTracked(texture, this.host.completedEpoch())
  }

  reapRetiredKernels() {
    const completed = this.host.completedEpoch() ?? -1
    const kept: { texture: Texture; epoch: number }[] = []
    for (const entry of this.retiredKernels) {
      if (!retired_upload_due(entry.epoch, completed)) kept.push(entry)
      else this.releaseUpload(entry.texture)
    }
    this.retiredKernels.length = 0
    for (const entry of kept) this.retiredKernels.push(entry)
  }

  /** Remove one texture from its free list and destroy it. Only call this for
   * textures whose GPU commands provably completed. */
  destroyPooled(texture: Texture) {
    if (this.host.pinned(texture)) return
    const key = surfacePoolKey(texture.width, texture.height, !!texture.binaryCoverage, !!texture.scalarCoverage)
    const list = this.free.get(key)
    if (!list) return
    const at = list.indexOf(texture)
    if (at < 0) return
    list.splice(at, 1)
    this.free.removed?.(texture)
    if (!list.length) this.free.delete(key)
    this.host.dropFrameUse(texture)
    this.lastUsed.delete(texture)
    this.host.destroy(texture)
    this.ledger.dischargeTracked(texture, this.host.completedEpoch())
  }

  /** Completed free-pool duplicates are physical residency, not a future read.
   * In-flight epochs and an unknown completion stay. Two survivors per size
   * remain so the next identical allocation can reuse them. Reclaimability is
   * the kernel receipt; survivor identity stays on these texture objects. */
  reapCompletedFree() {
    const completed = this.host.completedEpoch()
    if (!Number.isSafeInteger(completed) || completed! < 0) return
    for (const [key, list] of [...this.free]) {
      const ready: Texture[] = []
      for (const texture of list) {
        if (this.host.pinned(texture)) continue
        const epoch = this.ledger.poolEpochs.get(texture)
        if (!pool_epoch_reclaimable(epoch !== undefined, epoch ?? 0, completed!)) continue
        ready.push(texture)
      }
      ready.sort((a, b) => (this.lastUsed.get(a) || 0) - (this.lastUsed.get(b) || 0))
      const keep = ready.slice(Math.max(0, ready.length - 2))
      const drop = new Set(ready.filter(texture => !keep.includes(texture)))
      if (!drop.size) continue
      if (new Set(list).size === list.length) {
        const hasEpoch = new Uint8Array(list.length)
        const epochs = new Float64Array(list.length)
        const ages = new Float64Array(list.length)
        const pinned = new Uint8Array(list.length)
        for (let index = 0; index < list.length; index++) {
          const texture = list[index]
          const epoch = this.ledger.poolEpochs.get(texture)
          hasEpoch[index] = epoch === undefined ? 0 : 1
          epochs[index] = epoch ?? 0
          ages[index] = this.lastUsed.get(texture) || 0
          pinned[index] = this.host.pinned(texture) ? 1 : 0
        }
        const predicted = [...select_completed_pool_drops(hasEpoch, epochs, ages, pinned, completed!)].sort((a, b) => a - b)
        const actual = [...drop].map(texture => list.indexOf(texture)).sort((a, b) => a - b)
        if (predicted.length !== actual.length || predicted.some((index, at) => index !== actual[at]))
          throw new Error('GPU 资源回收回执不一致')
      }
      const retained = list.filter(texture => !drop.has(texture))
      for (const texture of drop) {
        this.host.dropFrameUse(texture)
        this.lastUsed.delete(texture)
        this.ledger.dischargeTracked(texture, this.host.completedEpoch())
        this.ledger.clearPoolEpoch(texture)
        this.host.destroy(texture)
        this.free.removed?.(texture)
        this.ledger.noteCompletedFree(texture.bytes)
      }
      if (retained.length) {
        if (this.free.setOwned) this.free.setOwned(key, retained)
        else this.free.set(key, retained)
      } else this.free.delete(key)
    }
  }

  /** Previous frame completion is the receipt. Textures referenced by that
   * frame stay; large trim may drop unreferenced or excess sizes. */
  discardUnreferencedFree(trimLarge: boolean, upcoming: Set<string> | undefined) {
    for (const [key, list] of this.free) {
      let largeKept = 0
      const retained = list.filter(texture => {
        if (this.host.frameUse(texture) && (!trimLarge || texture.bytes <= 8 * 1024 * 1024 ||
          upcoming!.has(`${texture.width}:${texture.height}`) && largeKept++ < 2)) return true
        this.host.destroy(texture)
        this.free.removed?.(texture)
        this.ledger.dischargeTracked(texture, this.host.completedEpoch())
        this.lastUsed.delete(texture)
        return false
      })
      if (retained.length) {
        if (this.free.setOwned) this.free.setOwned(key, retained)
        else this.free.set(key, retained)
      } else this.free.delete(key)
    }
  }

  /** Device loss forgets alias and surface-release identity. Charged bytes,
   * the peak, and pool epochs stay until a later physical destroy. */
  onDeviceLoss() {
    const preserved = device_loss_owner_reset(this.ledger.bytes)
    if (!Number.isFinite(preserved) || preserved !== this.ledger.bytes)
      throw new Error('GPU 设备丢失不能改写已记账字节')
    this.ledger.forgetOwners()
    this.deviceLossReceipts += 1
  }

  charge(texture: Texture, klass: ResourceClass) {
    this.ledger.chargeTracked(texture, klass)
  }
}
