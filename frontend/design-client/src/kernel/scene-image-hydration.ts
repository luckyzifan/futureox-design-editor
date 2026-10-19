import { DecodedImageCache, validDecodedImage, type DecodedImage } from './decoded-image-cache'
import { sceneIndex } from './gpu/scene-index'
import type { GpuScene } from './gpu/types'

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
export type ImageContext = { kernel: ImageDecoder; scope: string; settings: string; current?: () => boolean }

/** The renderer is shared between document lanes. Resolve its decoder from the
 * explicitly bound render context, never from the lane that created the GPU. */
export function managedSceneImageLoader(cache: DecodedImageCache, context: () => ImageContext,
  persistence: ImagePersistence) {
  return (uri: string, byte = false, level = 0) => {
    const { kernel, scope, settings, current } = context()
    if (current && !current()) throw Error('PREVIEW_CANCELLED')
    cache.begin(scope)
    const key = `${byte ? 'b' : 'f'}:${uri}`
    if (level === 0) {
      const hit = cache.get(scope, key)
      if (hit) return byte
        ? { width: hit.width, height: hit.height, pixels: new Float32Array(0), bytes: hit.data as Uint8Array }
        : { width: hit.width, height: hit.height, pixels: hit.data as Float32Array }
    }
    const [width, height] = JSON.parse(level > 0 ? kernel.image_info_at_level(uri, level) : kernel.image_info(uri)) as [number, number]
    const data = byte
      ? level > 0 ? kernel.image_rgba8_at_level(uri, level) : kernel.image_rgba8(uri)
      : level > 0 ? kernel.image_linear_at_level(uri, level) : kernel.image_linear(uri)
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

  hydrate(scene: GpuScene, current = this.requestCurrent): Promise<void> {
    // A request can have multiple consumers, but never duplicates an in-flight
    // read or holds more than one persisted payload at a time.
    const task = this.pending.then(() => this.run(scene, current))
    this.pending = task.catch(() => {})
    return task
  }
  private async run(scene: GpuScene, current: () => boolean) {
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
      if (this.cache.get(scope, key) || this.attempted.has(key)) continue
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
