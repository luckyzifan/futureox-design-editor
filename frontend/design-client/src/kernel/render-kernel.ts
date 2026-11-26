import { markRenderFailure } from './render-failure-telemetry'
import type { PreparationStateReceiptV1 } from './preparation-state'
import type { GpuScene } from './gpu/types'
import { VectorEngine, unpack_native_pose_packet } from '../generated/design-kernel/design_kernel'
import { blank } from '../model'
import type { PaintDamage } from './paint-damage'
import { renderCpuFrame } from './cpu-frame'
import { PreparationChannel, type PreparationMethod } from './preparation-channel'
import { bindContentOwner, pixelSourceContract } from './gpu/page-background'
import { FrameResources } from './gpu/frame-resources'
import { decodeScenePacket, copyScenePacket, CompiledScenePacket } from './gpu/scene-packet'
import { PreparedPacket, waitForPacket } from './prepared-packet'
import { canRebuildImageDecoder } from './image-decode-recovery'
import type { DocumentPatch } from '../document-patch'
export type NativeSourceIdentity={documentId:string;pageId:string;stageId:string;nodes:number}
/** Motion registers curve blocks. Native translation releases can reuse
 * blocks held by this receiver, with the inline route for a cold scope. */
export type ScenePacketTransport = 'exact' | 'curves' | 'inline-lz4' | 'confirmed-curves'
function sceneTransport(transport: boolean | ScenePacketTransport | undefined): ScenePacketTransport {
  if (transport === true || transport === 'curves') return 'curves'
  if (transport === 'inline-lz4' || transport === 'confirmed-curves') return transport
  return 'exact'
}

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
  imageDecodeRecoveries = 0
  private resources = new FrameResources()
  private contentOwner:object = {}
  /** Worker-private identity bound to compiled pixel sources; never on wire. */
  get contentIdentity() { return this.contentOwner }
  private revision = 0
  private pendingMutations = 0
  private pendingPackets = new Map<string, { revision: number; bytes: Promise<Uint8Array>; shared: boolean }>()
  packetCoalesced = 0
  private hostFonts?: Promise<boolean>
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
  private decodeImage<T>(uri:string,decode:(assets:VectorEngine)=>T):T {
    try{return decode(this.assets)}catch(error){
      // Only the image-only engine is replaceable. A CPU engine also owns the
      // authored document and must never be reset by an asset decode failure.
      if(!this.preparation||!canRebuildImageDecoder(error,uri))throw error
      const next=new VectorEngine()
      try{
        next.set_image_mips(this.imageMips)
        const colorManagement=JSON.parse(this.settings)||undefined
        next.load_document(JSON.stringify({...blank(),schemaVersion:colorManagement?3:2,
          rasterProfile:colorManagement?'figma':'analytic',colorManagement}))
      }catch(failure){next.free();throw failure}
      const previous=this.assets,lease=this.assetLease
      this.assets=next;this.assetLease={users:1}
      if(--lease.users===0)previous.free()
      // One exact retry, with the same bytes, mip and colour policy. A genuine
      // malformed image still fails, and another lane keeps its old decoder.
      const value=decode(next);this.imageDecodeRecoveries++;return value
    }
  }
  async initialize(mips: boolean, font?: Uint8Array) {
    this.detachImageDecoder()
    this.imageMips = mips
    this.assets.set_image_mips(mips)
    if (this.preparation) await this.call('initialize', [mips])
    else if (font) this.assets.load_font(font)
  }
  /** Native preparation owns the retained Sketch source names. Install the
   * exact host faces it resolved into the local WASM engine as well, so a
   * worker-side document/export lane never falls back to NotoSansSC alone.
   * Absent native transport, empty payloads and transport errors are
   * non-fatal; the bundled terminal fallback and pure-browser behavior are
   * unchanged. */
  private loadHostFonts(): Promise<void> {
    this.hostFonts ??= this.fetchHostFonts()
    const pending = this.hostFonts
    return pending.then(loaded => {
      if (!loaded && this.hostFonts === pending) this.hostFonts = undefined
    })
  }
  private async fetchHostFonts(): Promise<boolean> {
    try {
      if (!this.preparation?.hostFonts) return false
      const reply = await this.preparation.request(this.lane, 'host_fonts_v1')
      const payload = reply.value
      if (!(payload instanceof Uint8Array) || payload.byteLength <= 2 ||
          payload.byteLength > 48 * 1024 * 1024) return false
      const json = new TextDecoder().decode(payload)
      // The generated bindings are rebuilt with the kernel; older bundles do
      // not expose this optional transport yet.
      const install = (this.assets as unknown as { load_local_fonts?(value: string): number }).load_local_fonts
      return typeof install === 'function' && install.call(this.assets, json) > 0
    } catch {
      // Host font discovery is optional fidelity, never a document gate.
      return false
    }
  }
  private async call<T>(method: Exclude<PreparationMethod, 'warm_resources' | 'host_fonts_v1'>, args: unknown[] = [], signal?: AbortSignal): Promise<T> {
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
      if (reply.unpackedPoseBytes !== undefined) {
        const size = reply.unpackedPoseBytes
        if (method !== 'compile_gpu_packet' || this.lane !== 'interaction' ||
            !(reply.value instanceof Uint8Array) || !Number.isSafeInteger(size) ||
            size < 262_144 || size > 33_554_432 || reply.value.length >= size)
          throw Error('Invalid packed native pose reply')
        return unpack_native_pose_packet(reply.value, size) as T
      }
      return reply.value as T
    }
    if(method==='load_source_snapshot'||method==='source_hit')throw Error('NATIVE_SOURCE_UNSUPPORTED')
    if (method === 'derive_document_v1' || method === 'preparation_capabilities_v1') throw Error('DERIVATION_UNSUPPORTED')
    if (method === 'render_cpu_frame') return renderCpuFrame(this.assets, args[0] as string, args[1] as PaintDamage | undefined) as T
    if (method === 'initialize') return undefined as T
    const result = (this.assets[method] as (...args: any[]) => unknown).apply(this.assets, args)
    this.settings = this.assets.color_settings()
    return result as T
    } catch (error) {
      const stage = method === 'load_document' || method === 'load_source_snapshot' || method === 'initialize' ? 2 : method === 'derive_document_v1' ? 3 :
        method === 'apply_document_patch_with_damage' || method === 'apply_interaction_transforms' || method === 'interaction_pose_damage' ? 4 :
        method === 'compile_gpu_packet' ? 5 :
        ['render_linear','render_png','render_color_png','render_region_png','render_cpu_frame'].includes(method) ? 7 : 0
      throw markRenderFailure(error, { failureStage: stage })
    }
  }
  async load_document(value: string) {
    this.documentLoadForked = false
    this.contentOwner={}; this.revision++; this.pendingMutations++; this.pendingPackets.clear(); this.resources.clear()
    try {
      await this.call<void>('load_document', [value])
      // The native lane retained this document's source names during the call
      // above; fetch their host faces once, before any worker-side render.
      await this.loadHostFonts()
    }
    finally { this.pendingMutations-- }
  }
  async load_source_snapshot(token:string):Promise<NativeSourceIdentity> {
    if(this.lane!=='canvas'||!this.preparation||!await this.preparation.supportsNativeSource())throw Error('NATIVE_SOURCE_UNSUPPORTED')
    this.contentOwner={};this.revision++;this.pendingMutations++;this.pendingPackets.clear();this.resources.clear()
    try {
      const identity=await this.call<NativeSourceIdentity>('load_source_snapshot',[token])
      if(!identity||['documentId','pageId','stageId'].some(key=>typeof identity[key as keyof NativeSourceIdentity]!=='string')||
        !Number.isSafeInteger(identity.nodes)||identity.nodes<1||!this.preparationStateReceipt)throw Error('Invalid native source identity')
      await this.loadHostFonts()
      return identity
    }finally{this.pendingMutations--}
  }
  async apply_document_patch_with_damage(value: string, expectedBaseReceipt?: PreparationStateReceiptV1,
    expandedBitmapPatch?: DocumentPatch) {
    if (expectedBaseReceipt && !await this.supportsAcknowledgedPatches()) throw Error('PATCH_GUARD_UNSUPPORTED')
    const compact = !!expandedBitmapPatch && !!await this.preparation?.supportsBitmapRotationPatch()
    const patch = expandedBitmapPatch && !compact ? JSON.stringify(expandedBitmapPatch) : value
    const options = { ...(expectedBaseReceipt ? { expectedBaseReceipt } : {}), ...(compact ? { bitmapRotation: true } : {}) }
    const previousPixelOwner=this.contentOwner
    this.contentOwner={}; this.revision++; this.pendingMutations++; this.pendingPackets.clear(); this.resources.invalidate()
    const mutationRevision=this.revision
    try {
      const result = await this.call<string>('apply_document_patch_with_damage', expectedBaseReceipt || compact ? [patch, options] : [patch])
      let samePixels=false
      try{
        const damage=JSON.parse(result) as PaintDamage
        samePixels=damage.full===false&&damage.bounds==null&&(!damage.rects||Array.isArray(damage.rects)&&damage.rects.length===0)&&
          Object.keys((JSON.parse(patch) as {fields?:object}).fields||{}).every(key=>key==='name')
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
  private async compileOwned<T>(options:string,signal:AbortSignal|undefined,own:(bytes:Uint8Array,shared:boolean)=>T,transport: boolean | ScenePacketTransport = false):Promise<T> {
    if (signal?.aborted) throw Error('PREVIEW_CANCELLED')
    const mode = sceneTransport(transport)
    // Curve reuse and inline compression both depend on this lease. They cannot
    // share an in-flight exact packet that was built for a different acknowledgement.
    const enabled = !!this.preparation && mode === 'exact'
    const revision = this.revision
    const pending = enabled && !this.pendingMutations ? this.pendingPackets.get(options) : undefined
    if (pending?.revision === revision) {
      this.packetCoalesced++
      pending.shared = true
      // The first consumer may transfer or mutate its packet immediately.
      // Each waiter needs independent ownership, including before cache admission.
      return own(await waitForPacket(pending.bytes, signal),true)
    }
    const entry = { revision, bytes: this.compileFrame(options, revision, signal, mode), shared: false }
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
  async prepare_gpu_scene(options: string, signal?: AbortSignal, transport: boolean | ScenePacketTransport = false): Promise<PreparedPacket<CompiledScenePacket>> {
    if(this.pendingMutations)throw Error('DOCUMENT_PREPARATION_PENDING')
    const revision=this.revision,settings=this.settings
    const scene=await this.compileOwned(options,signal,(bytes,shared)=>CompiledScenePacket.from(bytes,shared),transport)
    const current=()=>revision===this.revision&&!this.pendingMutations&&settings===this.settings
    if(!current())throw Error('STALE_PREPARED_PACKET')
    return new PreparedPacket({lane:this.lane,revision,options,settings},scene,current,signal)
  }
  async interaction_pose_damage(value: string) {
    if (this.lane !== 'interaction') throw Error('Transform-only updates require the interaction lane')
    return await this.call<string>('interaction_pose_damage', [value])
  }
  async apply_interaction_transforms(value: string) {
    if (this.lane !== 'interaction') throw Error('Transform-only updates require the interaction lane')
    this.contentOwner={}; this.revision++; this.pendingMutations++; this.pendingPackets.clear(); this.resources.invalidate()
    try { return await this.call<boolean>('apply_interaction_transforms', [value]) }
    finally { this.pendingMutations-- }
  }
  private async compileFrame(options:string, revision:number, signal?:AbortSignal, transport: ScenePacketTransport = 'exact') {
    const lease=this.resources.capture(),owner=this.contentOwner
    try {
const acknowledgement = lease.acknowledgement
      const { clippedPoseEncoding, ...renderOptions } = JSON.parse(options)
      const reuseCurves = transport === 'curves' || transport === 'confirmed-curves' && this.resources.hasCurvePrograms
      const frameResources = this.preparation && (clippedPoseEncoding === 'resources' || clippedPoseEncoding === 'inline')
        ? { ...acknowledgement, curvePrograms: clippedPoseEncoding === 'resources', clippedPoseTransport: true }
        : transport === 'exact' ? acknowledgement
        : { ...acknowledgement, sceneLz4: true, ...(reuseCurves ? { curvePrograms: true } : {}) }
      const request=JSON.stringify({...renderOptions,frameResources})
      const bytes=await this.call<Uint8Array>('compile_gpu_packet',[request],signal)
      const scene=decodeScenePacket(bytes,revision===this.revision&&!this.pendingMutations?this.resources:undefined,lease)
      bindContentOwner(scene,owner,pixelSourceContract(renderOptions))
      return bytes
    } finally {lease.release()}
  }
  render_linear(options: string) { return this.call<Float32Array>('render_linear', [options]) }
  render_png(options: string) { return this.call<Uint8Array>('render_png', [options]) }
  render_color_png(options: string, output: string) { return this.call<Uint8Array>('render_color_png', [options, output]) }
  render_region_png(options: string) { return this.call<Uint8Array>('render_region_png', [options]) }
  render_cpu_frame(options: string, damage?: PaintDamage, signal?: AbortSignal) {
    return this.call<Uint8Array>('render_cpu_frame', [options, damage], signal)
  }
  stats() { return this.call<string>('stats') }
  gpu_memory_breakdown() { return this.call<string>('gpu_memory_breakdown') }
  color_settings() { return this.settings }
  image_info(uri: string) { return this.decodeImage(uri,assets=>assets.image_info(uri)) }
  image_info_at_level(uri: string, level: number) { return this.decodeImage(uri,assets=>assets.image_info_at_level(uri, level)) }
  image_rgba8(uri: string) { return this.decodeImage(uri,assets=>assets.image_rgba8(uri)) }
  image_rgba8_at_level(uri: string, level: number) { return this.decodeImage(uri,assets=>assets.image_rgba8_at_level(uri, level)) }
  image_linear(uri: string) { return this.decodeImage(uri,assets=>assets.image_linear(uri)) }
  image_linear_at_level(uri: string, level: number) { return this.decodeImage(uri,assets=>assets.image_linear_at_level(uri, level)) }
}
