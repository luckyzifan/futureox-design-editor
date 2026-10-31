import { markRenderFailure } from './render-failure-telemetry'
import type { PreparationStateReceiptV1 } from './preparation-state'
import type { GpuScene } from './gpu/types'
import { VectorEngine } from '../generated/design-kernel/design_kernel'
import { blank } from '../model'
import type { PaintDamage } from './paint-damage'
import { renderCpuFrame } from './cpu-frame'
import { PreparationChannel, type PreparationMethod } from './preparation-channel'
import { bindContentOwner, pixelSourceContract } from './gpu/page-background'
import { FrameResources } from './gpu/frame-resources'
import { decodeScenePacket, copyScenePacket, CompiledScenePacket } from './gpu/scene-packet'
import { PreparedPacket, waitForPacket } from './prepared-packet'
export type NativeSourceIdentity={documentId:string;pageId:string;stageId:string;nodes:number}

/** The GPU worker keeps only the image decoder on its synchronous boundary.
 * Document/layout/geometry work lives in the preparation worker. CPU-only hosts
 * keep their existing local engine; the same async facade serves both paths. */
export class RenderKernel {
  compileStats?:Record<string,unknown>
  documentForks = 0
  private documentLoadForked = false
  get lastDocumentLoadWasForked() { return this.documentLoadForked }
  private settings = 'null'
  private assetLease = { users: 1 }
  private imageMips = false
  private resources = new FrameResources()
  private contentOwner:object = {}
  /** Worker-private identity bound to compiled pixel sources; never on wire. */
  get contentIdentity() { return this.contentOwner }
  private revision = 0
  private pendingMutations = 0
  private pendingPackets = new Map<string, { revision: number; bytes: Promise<Uint8Array>; shared: boolean }>()
  packetCoalesced = 0
  get preparationStateReceipt() { return this.preparation?.currentReceipt(this.lane) }
  supportsDocumentDerivation() {
    if (import.meta.env.VITE_DESIGN_DOCUMENT_DERIVATION === '0') return Promise.resolve(false)
    return this.preparation?.supportsDerivation() ?? Promise.resolve(false)
  }
  supportsAcknowledgedPatches() {
    if (import.meta.env.VITE_DESIGN_DOCUMENT_DERIVATION === '0') return Promise.resolve(false)
    return this.preparation?.supportsGuardedPatch() ?? Promise.resolve(false)
  }
  async derive_document_v1(baseReceipt: PreparationStateReceiptV1) {
    if (this.lane !== 'interaction' || !this.preparation || !await this.supportsDocumentDerivation()) throw Error('DERIVATION_UNSUPPORTED')
    const expectedTarget = this.preparationStateReceipt ?? null
    this.contentOwner={}; this.revision++; this.pendingMutations++; this.pendingPackets.clear(); this.resources.clear()
    try {
      await this.call('derive_document_v1', [{ operationId: this.preparation.nextDerivationOperation(), baseReceipt,
        target: 'interaction', expectedTarget, delta: [] }])
      if (!this.preparationStateReceipt) throw Error('DERIVATION_RECEIPT_MISSING')
    } finally { this.pendingMutations-- }
  }
  get canPrepareConcurrently() { return !!this.preparation }
  get frameResourceHits() { return this.resources.hits }
  get frameResourceBytes() { return this.resources.bytes }
  constructor(private assets: VectorEngine, private lane: string, private preparation?: PreparationChannel) {
    if(!preparation)assets.bind_frame_scene_scope(crypto.randomUUID())
  }
  /** Native/worker preparation owns documents independently. Only its local
   * image-only decoder may be shared after the render worker proves a common
   * immutable resource owner. A settings change copies this decoder owner,
   * never mutates the other lane's colour configuration. */
  shareImageDecoder(source: RenderKernel): boolean {
    if (!this.preparation || this.preparation !== source.preparation || this === source ||
        this.settings !== source.settings || this.imageMips !== source.imageMips) return false
    if (this.assets === source.assets) return true
    if (--this.assetLease.users === 0) this.assets.free()
    this.assets = source.assets
    this.assetLease = source.assetLease
    this.assetLease.users++
    return true
  }
  private detachImageDecoder() {
    if (this.assetLease.users === 1) return
    this.assetLease.users--
    this.assetLease = { users: 1 }
    this.assets = new VectorEngine()
    this.assets.set_image_mips(this.imageMips)
    const colorManagement=JSON.parse(this.settings)||undefined
    this.assets.load_document(JSON.stringify({...blank(),schemaVersion:colorManagement?3:2,
      rasterProfile:colorManagement?'figma':'analytic',colorManagement}))
  }
  async initialize(mips: boolean, font?: Uint8Array) {
    this.detachImageDecoder()
    this.imageMips = mips
    this.assets.set_image_mips(mips)
    if (this.preparation) await this.call('initialize', [mips])
    else if (font) this.assets.load_font(font)
  }
  private async call<T>(method: Exclude<PreparationMethod, 'warm_resources'>, args: unknown[] = [], signal?: AbortSignal): Promise<T> {
    try {
    if (this.preparation) {
      const reply = await this.preparation.request(this.lane, method, args, signal)
      if(reply.compileStats)this.compileStats=reply.compileStats
      if (reply.documentFork) this.documentForks++
      if (method === 'load_document') this.documentLoadForked = reply.documentFork === true && !!reply.stateReceipt
      if (reply.settings !== undefined && reply.settings !== this.settings) {
        const colorManagement = JSON.parse(reply.settings) || undefined
        this.detachImageDecoder()
        this.assets.load_document(JSON.stringify({ ...blank(), schemaVersion: colorManagement ? 3 : 2,
          rasterProfile: colorManagement ? 'figma' : 'analytic', colorManagement }))
        this.settings = reply.settings
      }
      return reply.value as T
    }
    if(method==='load_source_snapshot')throw Error('NATIVE_SOURCE_UNSUPPORTED')
    if (method === 'derive_document_v1' || method === 'preparation_capabilities_v1') throw Error('DERIVATION_UNSUPPORTED')
    if (method === 'render_cpu_frame') return renderCpuFrame(this.assets, args[0] as string, args[1] as PaintDamage | undefined) as T
    if (method === 'initialize') return undefined as T
    const result = (this.assets[method] as (...args: any[]) => unknown).apply(this.assets, args)
    this.settings = this.assets.color_settings()
    return result as T
    } catch (error) {
      const stage = method === 'load_document' || method === 'load_source_snapshot' || method === 'initialize' ? 2 : method === 'derive_document_v1' ? 3 :
        method === 'apply_document_patch_with_damage' || method === 'apply_interaction_transforms' ? 4 :
        method === 'compile_gpu_packet' ? 5 :
        ['render_linear','render_png','render_color_png','render_region_png','render_cpu_frame'].includes(method) ? 7 : 0
      throw markRenderFailure(error, { failureStage: stage })
    }
  }
  async load_document(value: string) {
    this.documentLoadForked = false
    this.contentOwner={}; this.revision++; this.pendingMutations++; this.pendingPackets.clear(); this.resources.clear()
    try { await this.call<void>('load_document', [value]) }
    finally { this.pendingMutations-- }
  }
  async load_source_snapshot(token:string):Promise<NativeSourceIdentity> {
    if(this.lane!=='canvas'||!this.preparation||!await this.preparation.supportsNativeSource())throw Error('NATIVE_SOURCE_UNSUPPORTED')
    this.contentOwner={};this.revision++;this.pendingMutations++;this.pendingPackets.clear();this.resources.clear()
    try {
      const identity=await this.call<NativeSourceIdentity>('load_source_snapshot',[token])
      if(!identity||['documentId','pageId','stageId'].some(key=>typeof identity[key as keyof NativeSourceIdentity]!=='string')||
        !Number.isSafeInteger(identity.nodes)||identity.nodes<1||!this.preparationStateReceipt)throw Error('Invalid native source identity')
      return identity
    }finally{this.pendingMutations--}
  }
  async apply_document_patch_with_damage(value: string, expectedBaseReceipt?: PreparationStateReceiptV1) {
    if (expectedBaseReceipt && !await this.supportsAcknowledgedPatches()) throw Error('PATCH_GUARD_UNSUPPORTED')
    const previousPixelOwner=this.contentOwner
    this.contentOwner={}; this.revision++; this.pendingMutations++; this.pendingPackets.clear(); this.resources.invalidate()
    const mutationRevision=this.revision
    try {
      const result = await this.call<string>('apply_document_patch_with_damage', expectedBaseReceipt ? [value, { expectedBaseReceipt }] : [value])
      let samePixels=false
      try{
        const damage=JSON.parse(result) as PaintDamage
        samePixels=damage.full===false&&damage.bounds==null&&(!damage.rects||Array.isArray(damage.rects)&&damage.rects.length===0)&&
          Object.keys((JSON.parse(value) as {fields?:object}).fields||{}).every(key=>key==='name')
      }catch{ /* An unavailable optional proof never authorizes pixel reuse. */ }
      // Native no-paint proof can preserve existing pixels across names and
      // inert node metadata. Keep transport revisions/resources independent;
      // document identity, page structure and render-policy fields still revoke
      // this owner, even when an older backend reports no visible damage.
      if(this.revision===mutationRevision&&this.pendingMutations===1&&samePixels)
        this.contentOwner=previousPixelOwner
      return result
    } catch (error) { this.resources.invalidate(); throw error }
    finally { this.pendingMutations-- }
  }
  async compile_gpu_packet(options: string, signal?: AbortSignal) {
    return this.compileOwned(options,signal,(bytes,shared)=>shared?copyScenePacket(bytes):bytes)
  }
  private async compileOwned<T>(options:string,signal:AbortSignal|undefined,own:(bytes:Uint8Array,shared:boolean)=>T):Promise<T> {
    if (signal?.aborted) throw Error('PREVIEW_CANCELLED')
    const enabled = !!this.preparation
    const revision = this.revision
    const pending = enabled && !this.pendingMutations ? this.pendingPackets.get(options) : undefined
    if (pending?.revision === revision) {
      this.packetCoalesced++
      pending.shared = true
      // The first consumer may transfer or mutate its packet immediately.
      // Each waiter needs independent ownership, including before cache admission.
      return own(await waitForPacket(pending.bytes, signal),true)
    }
    const entry = { revision, bytes: this.compileFrame(options, revision, signal), shared: false }
    // A cancellable physical compile cannot be the shared owner of an exact
    // request (or another preview owner). Only noncancellable jobs are shared.
    if (enabled && !this.pendingMutations && !signal) this.pendingPackets.set(options, entry)
    // Only shared requests need an extra private copy. Never let an old
    // completion remove a newer revision's request under the same key.
    let value: T
    try { const result = await entry.bytes; value = own(result,entry.shared) }
    finally { if (this.pendingPackets.get(options) === entry) this.pendingPackets.delete(options) }
    return value
  }
  /** A packet may wait outside GPU ownership only with this version receipt.
   * Its bytes have one consumer and admission rechecks the kernel epoch. */
  async prepare_gpu_packet(options: string, signal?: AbortSignal): Promise<PreparedPacket> {
    if (this.pendingMutations) throw Error('DOCUMENT_PREPARATION_PENDING')
    const revision = this.revision, settings = this.settings
    const bytes = await this.compile_gpu_packet(options, signal)
    const current = () => revision === this.revision && !this.pendingMutations && settings === this.settings
    if (!current()) throw Error('STALE_PREPARED_PACKET')
    return new PreparedPacket({ lane: this.lane, revision, options, settings }, bytes, current, signal)
  }
  async prepare_gpu_scene(options: string, signal?: AbortSignal): Promise<PreparedPacket<CompiledScenePacket>> {
    if(this.pendingMutations)throw Error('DOCUMENT_PREPARATION_PENDING')
    const revision=this.revision,settings=this.settings
    const scene=await this.compileOwned(options,signal,(bytes,shared)=>CompiledScenePacket.from(bytes,shared))
    const current=()=>revision===this.revision&&!this.pendingMutations&&settings===this.settings
    if(!current())throw Error('STALE_PREPARED_PACKET')
    return new PreparedPacket({lane:this.lane,revision,options,settings},scene,current,signal)
  }
  async apply_interaction_transforms(value: string) {
    if (this.lane !== 'interaction') throw Error('Transform-only updates require the interaction lane')
    this.contentOwner={}; this.revision++; this.pendingMutations++; this.pendingPackets.clear(); this.resources.invalidate()
    try { return await this.call<boolean>('apply_interaction_transforms', [value]) }
    finally { this.pendingMutations-- }
  }
  private async compileFrame(options:string, revision:number, signal?:AbortSignal) {
    const lease=this.resources.capture(),owner=this.contentOwner
    try {
      const request=JSON.stringify({...JSON.parse(options),frameResources:lease.acknowledgement})
      const bytes=await this.call<Uint8Array>('compile_gpu_packet',[request],signal)
      const scene=decodeScenePacket(bytes,revision===this.revision&&!this.pendingMutations?this.resources:undefined,lease)
      bindContentOwner(scene,owner,pixelSourceContract(JSON.parse(options)))
      return bytes
    } finally {lease.release()}
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
