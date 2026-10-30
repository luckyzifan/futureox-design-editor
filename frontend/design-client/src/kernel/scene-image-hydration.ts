import { DecodedImageCache, decodedImageScope, validDecodedImage, type DecodedImage, type DecodedImageOwner } from './decoded-image-cache'
import { sceneIndex } from './gpu/scene-index'
import type { GpuScene } from './gpu/types'
import { largePngRowCandidate, nativeImageRows } from './image-row-source'

export type ImageVariant = 'byte' | 'linear'
export type ImagePersistence = {
  key: (uri: string, variant: ImageVariant, settings: string) => Promise<string | undefined>
  read: (key: string) => Promise<DecodedImage | undefined>
  write: (key: string, image: DecodedImage) => void
}
export type ImageDecoder = {
  image_info(uri: string): string
  image_info_at_level(uri: string, level: number): string
  image_rgba8(uri: string): Uint8Array
  image_rgba8_at_level(uri: string, level: number): Uint8Array
  image_linear(uri: string): Float32Array
  image_linear_at_level(uri: string, level: number): Float32Array
}
export type ImageContext = { kernel: ImageDecoder; scope: string; settings: string; current?: () => boolean;
  /** Worker-issued after exact snapshot/derivation admission, never a file ID. */
  resourceOwner?: DecodedImageOwner;
  /** Worker-owned document/resource/kernel fence, independent of one request. */
  ownerCurrent?: () => boolean }

declare const imageResidencyOwner: unique symbol
export type ImageResidencyOwner = { readonly [imageResidencyOwner]: true }
const residencyOwners = new WeakMap<ImageResidencyOwner, { current: () => boolean; revoked: boolean }>()
const loaderResidency = new WeakMap<object, () => ImageResidencyOwner | undefined>()
export function imageResidencyOwnerCurrent(owner: ImageResidencyOwner): boolean {
  const entry = residencyOwners.get(owner)
  if (!entry || entry.revoked) return false
  try { if (entry.current()) return true } catch { /* Fail closed on unknown ownership. */ }
  entry.revoked = true
  return false
}
function revokeOwner(owner: ImageResidencyOwner | undefined) {
  const entry = owner && residencyOwners.get(owner)
  if (entry) entry.revoked = true
}
/** Only loaders made here can grant this private capability. No scene field,
 * public function property, URI or mutable typed-array identity is a proof. */
export function imageLoaderResidencyOwner(loader: unknown): ImageResidencyOwner | undefined {
  return typeof loader === 'function' ? loaderResidency.get(loader)?.() : undefined
}

/** The renderer is shared between document lanes. Resolve its decoder from the
 * explicitly bound render context, never from the lane that created the GPU. */
export function managedSceneImageLoader(cache: DecodedImageCache, context: () => ImageContext,
  persistence: ImagePersistence): import('./gpu/renderer').ManagedImageLoader {
  let retained: { owner: ImageResidencyOwner; kernel: ImageDecoder; scope: string; settings: string; resourceOwner?: DecodedImageOwner } | undefined
  const revokedRequests = new WeakSet<ImageContext>()
  const checkRequest = (next: ImageContext) => {
    const current = !next.current || next.current()
    if (next.ownerCurrent && (revokedRequests.has(next) || !current)) {
      revokedRequests.add(next)
      throw Error('PREVIEW_CANCELLED')
    }
    if (!current) throw Error('PREVIEW_CANCELLED')
  }
  const load = (uri: string, byte = false, level = 0) => {
    const next = context()
    checkRequest(next)
    if (next.ownerCurrent && !next.ownerCurrent()) {
      revokeOwner(retained?.owner); retained = undefined; throw Error('PREVIEW_CANCELLED')
    }
    const { kernel, scope, settings } = next
    cache.begin(scope)
    const key = `${byte ? 'b' : 'f'}:${uri}`
    if (level === 0) {
      const hit = cache.get(scope, key)
      if (hit) return byte
        ? { width: hit.width, height: hit.height, pixels: new Float32Array(0), bytes: hit.data as Uint8Array }
        : { width: hit.width, height: hit.height, pixels: hit.data as Float32Array }
    }
    const rows = (reason:1|2=1) => {
      // Keep native-resolution rows transient. They must not become an empty
      // full-image cache entry or a persistent decoded-pixel receipt.
      return {...nativeImageRows(uri, settings, () => {
        checkRequest(next)
        if(next.ownerCurrent&&!next.ownerCurrent())throw Error('PREVIEW_CANCELLED')
      }),linearRowReason:reason}
    }
    if (!byte && level === 0 && largePngRowCandidate(uri)) return rows()
    let width:number,height:number,data:Uint8Array|Float32Array
    try {
      [width,height] = JSON.parse(level > 0 ? kernel.image_info_at_level(uri, level) : kernel.image_info(uri)) as [number,number]
      data = byte
        ? level > 0 ? kernel.image_rgba8_at_level(uri, level) : kernel.image_rgba8(uri)
        : level > 0 ? kernel.image_linear_at_level(uri, level) : kernel.image_linear(uri)
    } catch(error) {
      // A source can fit individually while other decoded assets already fill
      // the native cache. Do not evict borrowed pixels or enlarge its quota:
      // use the same bounded row decoder only for the exact capacity rejection.
      const message=error instanceof Error?error.message:typeof error==='string'?error:''
      if(!byte&&level===0&&uri.startsWith('data:image/png;base64,')&&
        /^Decoded image budget exceeded(?:: [0-9]{1,10}x[0-9]{1,10} source pixels cannot fit without loss; automatic downsampling is disabled)?$/.test(message))return rows(2)
      throw error
    }
    if (level === 0) {
      const image = { width, height, data }
      cache.set(scope, key, image)
      // The captured settings and immutable pixels still certify a persistent
      // write after a lane change; it must never mutate the new lane's residency.
      void persistence.key(uri, byte ? 'byte' : 'linear', settings).then(key => {
        if (key) persistence.write(key, image)
      }).catch(() => { /* Optional persistence never fails a render. */ })
    }
    return byte ? { width, height, pixels: new Float32Array(0), bytes: data as Uint8Array }
      : { width, height, pixels: data as Float32Array }
  }
  loaderResidency.set(load, () => {
    let next: ImageContext
    try {
      next = context()
      if (!next.ownerCurrent ||
          typeof next.scope !== 'string' || !next.scope || typeof next.settings !== 'string') {
        revokeOwner(retained?.owner); retained = undefined; return
      }
      if (!next.ownerCurrent()) {
        revokeOwner(retained?.owner); retained = undefined; throw Error('PREVIEW_CANCELLED')
      }
    } catch (error) { revokeOwner(retained?.owner); retained = undefined; throw error }
    // An obsolete request cannot borrow pixels, but does not revoke its still
    // synchronized document owner. The next request gets a fresh context.
    checkRequest(next)
    let resourceOwner: DecodedImageOwner | undefined
    if (next.resourceOwner) {
      try { if(decodedImageScope(next.resourceOwner,next.settings)===next.scope)resourceOwner=next.resourceOwner }
      catch { /* Unknown caller tokens cannot authorize cross-decoder reuse. */ }
    }
    const shared=retained&&resourceOwner&&retained.resourceOwner===resourceOwner&&
      retained.scope===next.scope&&retained.settings===next.settings
    const entry=retained&&residencyOwners.get(retained.owner)
    // Adopt the live snapshot's proof before querying the previous request's
    // lifetime. A lane switch expires requests, not immutable shared pixels.
    // A resource which was actually revoked is never revived by adoption.
    if(shared&&entry&&!entry.revoked)entry.current=next.ownerCurrent!
    if (retained && (!imageResidencyOwnerCurrent(retained.owner) || !shared&&retained.kernel !== next.kernel ||
        retained.scope !== next.scope || retained.settings !== next.settings)) {
      revokeOwner(retained.owner); retained = undefined
    }
    if (!retained) {
      const owner = Object.freeze({}) as ImageResidencyOwner
      residencyOwners.set(owner, { current: next.ownerCurrent!, revoked: false })
      retained = { owner, kernel: next.kernel, scope: next.scope, settings: next.settings, resourceOwner }
    }
    return retained.owner
  })
  return load
}

/** One request's optional persistent reads. The exact compiler owns dependency
 * selection (including clip/effect/backdrop sources); no geometry is culled here.
 * Cache values remain immutable and eviction releases only our reference. */
export class SceneImageHydration {
  private attempted = new Set<string>()
  private keyBytes = 0
  private readBytes = 0
  private unavailable = false
  private pending = Promise.resolve()
  constructor(private cache: DecodedImageCache, private context: ImageContext,
    private persistence: ImagePersistence, private ownerCurrent: () => boolean,
    private requestCurrent: () => boolean = () => true,
    private limits = { entries: 1024, keyBytes: 4 * 1024 * 1024, readBytes: cache.limit }) {}

  hydrate(scene: GpuScene, current = this.requestCurrent, uploaded?: (uri: string) => boolean): Promise<void> {
    // A request can have multiple consumers, but never duplicates an in-flight
    // read or holds more than one persisted payload at a time.
    const task = this.pending.then(() => this.run(scene, current, uploaded))
    this.pending = task.catch(() => {})
    return task
  }
  private async run(scene: GpuScene, current: () => boolean, uploaded?: (uri: string) => boolean) {
    const check = () => {
      if (!this.ownerCurrent() || !current()) throw Error('PREVIEW_CANCELLED')
    }
    check()
    const { scope, settings } = this.context
    this.cache.begin(scope)
    if (this.unavailable) return
    const variant = scene.floatCompositing || scene.colorManagement ? 'linear' : 'byte'
    for (const uri of sceneIndex(scene).images) {
      check()
      const key = `${variant === 'byte' ? 'b' : 'f'}:${uri}`
      if (this.cache.get(scope, key) || this.attempted.has(key) || uploaded?.(uri)) continue
      // Long/invalid sources are still validated by the renderer. Skipping
      // optional acceleration must not become a different source-error policy.
      if (uri.length >= 2_000_000 || !/^data:image\/(png|jpeg|webp);base64,/.test(uri)) continue
      const bytes = key.length * 2 + 128
      if (this.attempted.size >= this.limits.entries || bytes > this.limits.keyBytes - this.keyBytes ||
          this.readBytes >= this.limits.readBytes) return
      this.attempted.add(key); this.keyBytes += bytes
      let persistentKey: string | undefined
      try { persistentKey = await this.persistence.key(uri, variant, settings) } catch { /* Cache miss. */ }
      check()
      if (!persistentKey) { this.unavailable = true; return }
      let record: DecodedImage | undefined
      try { record = await this.persistence.read(persistentKey) } catch { /* Cache miss. */ }
      check()
      // Charge every returned typed payload, including wrong-variant records,
      // before admission. Malformed records rejected inside persistence remain
      // bounded by the separate request-count cap. This is not a guarantee on
      // IndexedDB's internal clone allocation, which precedes our validation.
      if (record?.data instanceof Uint8Array || record?.data instanceof Float32Array) {
        const readBytes = record.data.buffer.byteLength
        if (readBytes > this.limits.readBytes - this.readBytes) { this.readBytes = this.limits.readBytes; return }
        this.readBytes += readBytes
      }
      if (!validDecodedImage(record) || !(variant === 'byte' ? record.data instanceof Uint8Array : record.data instanceof Float32Array)) continue
      this.cache.set(scope, key, record)
    }
  }
}
