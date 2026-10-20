import type { GpuScene } from './gpu/types'
import { VectorEngine } from '../generated/design-kernel/design_kernel'
import { blank } from '../model'
import type { PaintDamage } from './paint-damage'
import { renderCpuFrame } from './cpu-frame'
import { PreparationChannel, type PreparationMethod } from './preparation-channel'
import { CompiledPacketCache } from './compiled-packet-cache'
import { SceneDeltaDecoder } from './gpu/scene-delta'

/** The GPU worker keeps only the image decoder on its synchronous boundary.
 * Document/layout/geometry work lives in the preparation worker. CPU-only hosts
 * keep their existing local engine; the same async facade serves both paths. */
export class RenderKernel {
  compileStats?:Record<string,unknown>
  private sceneUpdates = new SceneDeltaDecoder()
  sceneUpdateBytes = 0
  documentForks = 0
  private settings = 'null'
  private packets = new CompiledPacketCache()
  private revision = 0
  private pendingMutations = 0
  private pendingPackets = new Map<string, { revision: number; bytes: Promise<Uint8Array>; shared: boolean }>()
  packetCoalesced = 0
  private packetKeys = new WeakMap<Uint8Array,{key:string;revision:number}>()
  get canPrepareConcurrently() { return !!this.preparation }
  get packetCacheHits() { return this.packets.hits }
  get packetCacheBytes() { return this.packets.bytes }
  constructor(private assets: VectorEngine, private lane: string, private preparation?: PreparationChannel) {}
  async initialize(mips: boolean, font?: Uint8Array) {
    this.assets.set_image_mips(mips)
    if (this.preparation) await this.call('initialize', [mips])
    else if (font) this.assets.load_font(font)
  }
  private async call<T>(method: Exclude<PreparationMethod, 'warm_resources'>, args: unknown[] = [], signal?: AbortSignal): Promise<T> {
    if (this.preparation) {
      const reply = await this.preparation.request(this.lane, method, args, signal)
      if(reply.compileStats)this.compileStats=reply.compileStats
      if (reply.documentFork) this.documentForks++
      if (reply.settings !== undefined && reply.settings !== this.settings) {
        const colorManagement = JSON.parse(reply.settings) || undefined
        this.assets.load_document(JSON.stringify({ ...blank(), schemaVersion: colorManagement ? 3 : 2,
          rasterProfile: colorManagement ? 'figma' : 'analytic', colorManagement }))
        this.settings = reply.settings
      }
      return reply.value as T
    }
    if (method === 'render_cpu_frame') return renderCpuFrame(this.assets, args[0] as string, args[1] as PaintDamage | undefined) as T
    if (method === 'initialize') return undefined as T
    const result = (this.assets[method] as (...args: any[]) => unknown).apply(this.assets, args)
    this.settings = this.assets.color_settings()
    return result as T
  }
  async load_document(value: string) {
    this.sceneUpdates.clear()
    this.revision++; this.pendingMutations++; this.pendingPackets.clear(); this.packets.clear()
    try { await this.call<void>('load_document', [value]) }
    finally { this.pendingMutations-- }
  }
  async apply_document_patch_with_damage(value: string) {
    this.revision++; this.pendingMutations++; this.pendingPackets.clear()
    try {
      const result = await this.call<string>('apply_document_patch_with_damage', [value])
      const patch = JSON.parse(value), damage = JSON.parse(result) as PaintDamage
      if (this.lane !== 'canvas' || Object.keys(patch.fields || {}).length) this.packets.clear()
      else this.packets.applyDamage(damage, Object.keys(patch.nodes || {}))
      return result
    } catch (error) { this.packets.clear(); throw error }
    finally { this.pendingMutations-- }
  }
  async compile_gpu_packet(options: string, signal?: AbortSignal) {
    if (signal?.aborted) throw Error('PREVIEW_CANCELLED')
    const enabled = !!this.preparation && import.meta.env.VITE_DESIGN_PACKET_CACHE !== '0'
    const hit = enabled && !this.pendingMutations ? this.packets.get(options) : undefined
    if (hit) { this.packetKeys.set(hit,{key:options,revision:this.revision}); return hit }
    const revision = this.revision
    const pending = enabled && !this.pendingMutations ? this.pendingPackets.get(options) : undefined
    if (pending?.revision === revision) {
      this.packetCoalesced++
      pending.shared = true
      // The first consumer may transfer or mutate its packet immediately.
      // Each waiter needs independent ownership, including before cache admission.
      const bytes = (await pending.bytes).slice()
      if (revision === this.revision && !this.pendingMutations)
        this.packetKeys.set(bytes, { key: options, revision })
      return bytes
    }
    const entry = { revision, bytes: this.call<Uint8Array>('compile_gpu_packet', [options], signal), shared: false }
    if (enabled && !this.pendingMutations) this.pendingPackets.set(options, entry)
    // Only shared requests need an extra private copy. Never let an old
    // completion remove a newer revision's request under the same key.
    let bytes: Uint8Array
    try { const result = await entry.bytes; bytes = entry.shared ? result.slice() : result }
    finally { if (this.pendingPackets.get(options) === entry) this.pendingPackets.delete(options) }
    if (enabled && !this.pendingMutations && revision === this.revision) {
      const request = JSON.parse(options)
      this.packetKeys.set(bytes,{key:options,revision})
      this.packets.put(options, bytes, this.lane === 'canvas' && !!request.gpuViewport && !request.animation && !request.pixelPreview)
    }
    return bytes
  }
  async apply_interaction_transforms(value: string) {
    if (this.lane !== 'interaction') throw Error('Transform-only updates require the interaction lane')
    this.revision++; this.pendingMutations++; this.pendingPackets.clear(); this.packets.clear()
    try { return await this.call<boolean>('apply_interaction_transforms', [value]) }
    finally { this.pendingMutations-- }
  }
  async compile_gpu_scene_update(options: string, reset: boolean) {
    if (this.lane !== 'interaction') throw Error('Scene updates require the interaction lane')
    const bytes = await this.call<Uint8Array>('compile_gpu_scene_update', [options, reset])
    this.sceneUpdateBytes = bytes.byteLength
    return this.sceneUpdates.decode(bytes)
  }
  observePacket(bytes:Uint8Array,scene:GpuScene) {
    const identity=this.packetKeys.get(bytes)
    if(identity&&identity.revision===this.revision&&!this.pendingMutations)this.packets.certify(identity.key,scene)
  }
  render_linear(options: string) { return this.call<Float32Array>('render_linear', [options]) }
  render_png(options: string) { return this.call<Uint8Array>('render_png', [options]) }
  render_color_png(options: string, output: string) { return this.call<Uint8Array>('render_color_png', [options, output]) }
  render_region_png(options: string) { return this.call<Uint8Array>('render_region_png', [options]) }
  render_cpu_frame(options: string, damage?: PaintDamage) { return this.call<Uint8Array>('render_cpu_frame', [options, damage]) }
  stats() { return this.call<string>('stats') }
  gpu_memory_breakdown() { return this.call<string>('gpu_memory_breakdown') }
  color_settings() { return this.settings }
  image_info(uri: string) { return this.assets.image_info(uri) }
  image_info_at_level(uri: string, level: number) { return this.assets.image_info_at_level(uri, level) }
  image_rgba8(uri: string) { return this.assets.image_rgba8(uri) }
  image_rgba8_at_level(uri: string, level: number) { return this.assets.image_rgba8_at_level(uri, level) }
  image_linear(uri: string) { return this.assets.image_linear(uri) }
  image_linear_at_level(uri: string, level: number) { return this.assets.image_linear_at_level(uri, level) }
}
