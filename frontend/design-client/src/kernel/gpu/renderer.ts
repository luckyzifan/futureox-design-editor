import { prefixAlignedStrip, prefixAlignedRgbStrip } from './prefix-band'
import { PREFIX_SCRATCH_BYTES } from './texture-prefix'
import { IMAGE_RESOLVE_STEP_MODE } from './image-resolve-step'
import { exactFilterKey, fullSampleCoverage, HorizontalFilterCache } from './horizontal-filter-cache'
import { StaticImageBlurCache, largeStaticImageBlurWindow, type StaticImageBlurSource } from './static-image-blur-cache'
import { planNestedPrefix, type NestedPrefixPlan } from './nested-prefix-plan'
import { planDisplayMaterialSource } from './display-material-source'
import { planSequentialDisplay, type SequentialDisplayPlan } from './sequential-display-plan'
import { isRecoverablePreviewBudget } from '../preview-budget-recovery'
import { planExactImageXTable } from './exact-image-x-table'
import type { ExactImageTable } from './types'
import { completeFilterAxisSupport } from './opaque-filter'
import { gpuDiagnosticsEnabled, recordGpuDiagnostic } from '../../../../design-desktop/src/render-terminal-diagnostics.mjs'
import { markRenderFailure } from '../render-failure-telemetry'
import { backdropEffect, backdropRadius, classifyCompiledSourceReuse } from '../render-dependency'
import { prefixRationalUnsupported } from './prefix-preflight'
import { renderErrorWithBudget, sanitizeRenderBudget, type RenderBudgetDiagnostic } from '../render-diagnostics'
import { textureByteLength } from './texture-byte-length'
import { movingBackdropKey, staticBackdropKey } from './static-backdrop'
import { workingSetBudget } from './working-set-budget'
import {rectangleBorder} from './rect-partition'
import {disjointNeutralGroup} from './neutral-group'
import { backdropOverlap, exactBlendLattice, interactionEffectRegion, interactionHalo } from './effect-region'
import { gradient_blur_composite_uniforms } from '../../generated/design-kernel/design_kernel'
import { inverse } from '../../geometry'
import { EncodeYield } from './encode-yield'
import { sceneIndex, sceneScale as scale, type SceneIndex } from './scene-index'
import type {
  Driver,
  GpuAdmissionDiagnostic,
  Texture,
  Rect,
  GpuNode,
  GpuScene,
  PathMesh,
  GpuPaint,
  GlassCaptureTile,
  TextureReplayTile,
  TextureReplayPlan,
  TextureSourcePlan,
} from './types'
import { parameters, blends, rect, intersect } from './types'
import type { Paint, Effect, ImageAdjust } from '../../model'
import { CoverageCache } from './coverage-cache'
import { ImmutableKernelCache, immutableKernelKey } from './immutable-kernel-cache'
import { CoefficientByteCache } from './coefficient-byte-cache'
import { ReverseIndexMap } from './reverse-index-map'
import { solidRgba8 } from './rgba8'
import { batchableSolid, solidInstances } from './solid-batch'
import { displayFilterWeights } from './display-filter'
import {
  imageAdjustActive,
  imageAdjustTag,
  adjustRgba8Premultiplied,
  adjustLinearPremultiplied,
} from './image-adjust'
import {
  quantized_tent_kernel_rgba,
  rational_tent_kernel_rgba,
  certified_tent_kernel_rgba,
  certified_box_kernel_rgba,
  image_sampling_grid_placed,
  image_sampling_axes_placed,
  image_mip_level,
  image_byte_sampling_field,
  image_byte_sampling_field_placed,
  gradient_sampling_grid,
  rational_box_kernel_rgba,
  gaussian_box_radii,
  texture_sampling_grid,
  texture_material_field,
  glass_material_uniforms,
  glass_geometry_field,
  glass_geometry_interior,
  glass_capture_tiles,
  figma_gradient_lookup,
  figma_gradient_field,
  texture_replay_tiles,
  texture_replay_field,
  texture_clip_math_atlas,
} from '../../generated/design-kernel/design_kernel'
/** One ledger for every on-device surface: the ordered colour pool, parameter
 * uploads, filter kernels and decoded images all share it. An allocation that
 * does not fit first evicts resources whose GPU commands provably completed
 * (oldest first), and only then fails explicitly. */
// Initial admission before the first scene. renderAttempt selects the actual
// physical working-set budget. This renderer runs in a Worker on both hosts:
// window/desktop globals and system RAM are not available-VRAM measurements.
const SURFACE_BUDGET_BYTES = 256 * 1024 * 1024
/** Frame-scratch reclamation starts once the ledger passes this share and
 * destroys at most one bounded batch per completed checkpoint cycle. */
const RECLAIM_BATCH_BYTES = 48 * 1024 * 1024
const RECLAIM_BATCH_RESOURCES = 64
/** Past this share a completed checkpoint also drops least-recently-used
 * images; they reload through the same deterministic decoder when sampled
 * again, so no pixel value can change. */
/** Atlas pages pack grid-sampled images with a zero border per slot: an
 * out-of-bounds neighbour fetch reads zero either way, so packed output is
 * byte-identical to standalone textures. Pages are the eviction unit. */
const ATLAS_SIDE = 2048
const ATLAS_MAX_IMAGE = 512
const ATLAS_PAD = 1
type AtlasPage = {
  texture: Texture
  x: number
  y: number
  rowHeight: number
  entries: Map<string, string>
}
export type Surface = { texture: Texture; rect: Rect; opaqueInterior?:Rect }
const containsRect = (outer: Rect | undefined, inner: Rect) => !!outer &&
  outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.w >= inner.x + inner.w && outer.y + outer.h >= inner.y + inner.h
const sameSurface = (a: Surface | undefined, b: Surface | undefined) => a === b || !!a && !!b &&
  a.texture === b.texture && a.rect.x === b.rect.x && a.rect.y === b.rect.y && a.rect.w === b.rect.w && a.rect.h === b.rect.h
const rgb = (hex: string) => {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error('无效颜色')
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
}
/** Check if an image cache key matches a base URI (handles level/atlas/adjust variants) */
const isLevelKey = (key: string, baseUri: string): boolean => {
  // key formats: "uri", "uri#level", "uri#level@a", "uri#level~adjust", "uri#level@a~adjust"
  return key === baseUri || key.startsWith(`${baseUri}#`)
}
export function gaussianRadii(sigma: number): number[] {
  return Array.from(gaussian_box_radii(sigma))
}
export type ManagedImageLoader = (uri: string, byte?: boolean, level?: number) => {
  width: number
  height: number
  pixels: Float32Array
  bytes?: Uint8Array
}
/** Mirror of the kernel's `image_mipmap::mip_levels`: the base plus one level
 * per ceil-halving until both extents reach one texel. Kept inline so the
 * selected level always clamps against the same chain the kernel builds. */
export function mipLevelsFor(dims: [number, number]): number {
  let [w, h] = dims, levels = 1
  while (w > 1 || h > 1) {
    w = (w + 1) >> 1
    h = (h + 1) >> 1
    levels++
  }
  return levels
}
export class GpuRenderer {
  private encodeYield = new EncodeYield()
  private frameCurrent?: () => boolean
  private checkFrameCurrent() {
    if (this.frameCurrent && !this.frameCurrent()) throw new Error('PREVIEW_CANCELLED')
  }
  private yieldEncoding() {
    this.checkFrameCurrent()
    const pause = this.encodeYield.checkpoint(this.driver.captureDisplay === true || !!this.frameCurrent)
    return pause?.then(() => {
      // Let control messages invalidate this frame before its next GPU submit.
      // Cancellation abandons this unsubmitted encoder through the existing
      // abort/fence path; already submitted resources keep that same lifetime.
      this.checkFrameCurrent()
      if (import.meta.env.VITE_DESIGN_ENCODE_SUBMIT !== '0') this.driver.submitPending?.()
    })
  }
  lastBudgetFailure?: RenderBudgetDiagnostic
  private frameBudget = SURFACE_BUDGET_BYTES
  private horizontalFilters = new HorizontalFilterCache(plane => this.release(plane))
  private staticImageBlurs = new StaticImageBlurCache(plane => this.release(plane), texture => this.driver.imageTableRange?.(texture))
  private staticImageTableProofs = new WeakMap<ExactImageTable, { source: StaticImageBlurSource; input: Rect }>()
  private staticImageBlurEligible = 0
  private staticImageBlurHits = 0
  private staticImageBlurPixels = 0
  private displayMaterial?: { source: Texture; key: string; surface: Surface; published: boolean }
  private displayMaterialBorrowed = false
  private displayMaterialBuilds = 0
  private displayMaterialHits = 0
  private sequentialDisplayFrames = 0
  // Later bands still read these immutable images. Their ownership is
  // independent of shorter nested table/cache borrows.
  private sequentialImagePins = new Set<Texture>()
  private sequentialRejectionDiagnostics = 0
  /** Bounded numeric opt-in diagnostics. Codes 601..613 identify admission
   * exits without logging node names, source URIs or authored pixel content. */
  private sequentialRejected(reasonCode: number, region?: Rect, fields: Record<string, number> = {}) {
    if (!this.scene?.sequentialDisplay || !gpuDiagnosticsEnabled() || this.sequentialRejectionDiagnostics >= 64) return
    this.sequentialRejectionDiagnostics++
    recordGpuDiagnostic('skip', { mode: 48, reasonCode, zoom: this.scene.view.zoom,
      ...(region ? { x: region.x, y: region.y, width: region.w, height: region.h } : {}), ...fields })
  }
  private retireDisplayMaterial() {
    if (this.displayMaterialBorrowed) return
    const retained = this.displayMaterial
    this.displayMaterial = undefined
    if (retained) this.release(retained.surface)
  }
  private imageXTableBuilds = 0
  private imageXTablePixels = 0
  private imageXTableBytes = 0
  private wholeFilterAxes = 0
  private pendingImageTableSources = new Set<Texture>()
  private horizontalFilterHits = 0
  private horizontalFilterPixels = 0
  private horizontalFilterRows = 0
  /** Called only by the worker that created the local tile-fill owner. */
  releaseFilterBatch(lease: object) { this.horizontalFilters.clear(lease) }
  private backdropReuseFrames=0
  private backdropReusePixels=0
  private backdropEligibleFrames=0
  private backdropAdmittedFrames=0
  memoryPolicy() { return { workingBudgetBytes: this.frameBudget, interactionBudgetBytes: this.interactionBudget,
    staticImageBlurEligible:this.staticImageBlurEligible,staticImageBlurHits:this.staticImageBlurHits,
    staticImageBlurPixels:this.staticImageBlurPixels,staticImageBlurBytes:this.staticImageBlurs.bytes,
    staticImageBlurEntries:this.staticImageBlurs.count,
    displayMaterialBuilds:this.displayMaterialBuilds,displayMaterialHits:this.displayMaterialHits,
    displayMaterialBytes:this.displayMaterial?.surface.texture.bytes || 0,
    sequentialDisplayFrames:this.sequentialDisplayFrames,
    backdropReuseFrames:this.backdropReuseFrames,backdropReusePixels:this.backdropReusePixels,
    backdropEligibleFrames:this.backdropEligibleFrames,backdropAdmittedFrames:this.backdropAdmittedFrames } }
  /** Retained subtree pixels have their own cap; they are not scratch. */
  private get workingBytes() { return this.bytes - (this.driver.captureDisplay ? this.interactionBytes - this.nestedPrefixBytes : 0) }
  private get interactionBudget() {
    return this.driver.captureDisplay ? 512 * 1024 * 1024 : 64 * 1024 * 1024
  }
  private interactionRoots = new Map<GpuNode, { anchor: Rect; planes: Surface[]; source?: boolean }>()
  private interactionArithmetic = ''
  private interactionCapturing = false
  private interactionTextures = new Set<Texture>()
  private interactionBytes = 0
  private interactionHits = 0
  private interactionInvalid = false
  // A single unchanged nested prefix, before the final moving foreground.
  // Unlike general presentation residency, these four planes also remain in
  // the common working ledger. Retaining them never buys allocation headroom.
  private nestedPrefix?: { plan: NestedPrefixPlan; policy: string; planes: Surface[] }
  private nestedPrefixBytes = 0
  private nestedPrefixAllowed = true
  private nestedPrefixPressure = false
  private retireNestedPrefix() {
    const old = this.nestedPrefix
    if (!old) return
    this.nestedPrefix = undefined
    for (const { texture } of old.planes) {
      this.interactionTextures.delete(texture)
      this.interactionBytes -= texture.bytes
      this.nestedPrefixBytes -= texture.bytes
    }
    // Returning storage to the ordinary ordered pool preserves queued readers;
    // reclaimScratch still requires its real completion proof before destroy.
    this.release(...old.planes)
  }
  private nestedPrefixPolicy(scopeId: string, targets: Surface[]) {
    return exactFilterKey([scopeId, targets.map(p => p.rect), this.scene.view,
      this.scene.width, this.scene.height, this.scene.extent, this.scene.output,
      this.scene.resolve, this.scene.presentation, this.scene.colorManagement,
      this.scene.floatCompositing, this.scene.coherentSamples, this.scene.integratedBlur,
      this.scene.displayFilters, this.scene.displayFilterRadiusLimit, this.scene.softwareRaster, this.driver.name,
      this.scene.displayImageSource, this.scene.displayMaterialSource, this.driver.displayMath, this.driver.linearLight, this.driver.hdr])
  }
  private nestedPrefixMatches(plan: NestedPrefixPlan, policy: string) {
    const old = this.nestedPrefix
    return !!old && old.policy === policy && old.plan.lease === plan.lease &&
      old.plan.scopeId === plan.scopeId && old.plan.selectedId === plan.selectedId &&
      old.plan.count === plan.count && old.plan.prefixIds.length === plan.prefixIds.length &&
      old.plan.prefixIds.every((id, i) => id === plan.prefixIds[i]) &&
      old.plan.sources.length === plan.sources.length &&
      old.plan.sources.every((entry, i) => entry.id === plan.sources[i].id && entry.node === plan.sources[i].node)
  }
  private saveNestedPrefix(plan: NestedPrefixPlan, policy: string, targets: Surface[]) {
    const needed = targets.reduce((bytes, p) => bytes + p.rect.w * p.rect.h * 16, 0)
    if (!policy || this.nestedPrefix || targets.length !== 4 || needed > 64 * 1024 * 1024 ||
      this.interactionBytes + needed > this.interactionBudget || this.overBudget(needed)) return
    const planes: Surface[] = []
    try { for (const target of targets) planes.push(this.copyInteractionSource(target)) }
    catch (error) {
      this.release(...planes)
      if (error instanceof Error && error.message === 'GPU 表面内存预算超限') return
      throw error
    }
    this.nestedPrefix = { plan, policy, planes }
    for (const { texture } of planes) {
      this.interactionTextures.add(texture)
      this.interactionBytes += texture.bytes
      this.nestedPrefixBytes += texture.bytes
    }
    recordGpuDiagnostic('cache', { nestedPrefixBuilds: 1, nestedPrefixBytes: needed })
  }

  private stationaryBackdrop?: { lease: object; key: string; plane: Surface }
  private movingBackdrop?: { lease: object; key: string; plane: Surface }
  private releaseMovingBackdrop() {
    const entry=this.movingBackdrop
    if(!entry)return
    this.movingBackdrop=undefined
    this.interactionTextures.delete(entry.plane.texture)
    this.interactionBytes-=entry.plane.texture.bytes
    // This frame may already have sampled it. Queue-ordered pool reuse is
    // safe; immediate destruction before a completed fence would not be.
    this.release(entry.plane)
  }
  private retireStationaryBackdrop() {
    const entry=this.stationaryBackdrop
    if(!entry)return
    const texture=entry.plane.texture
    this.interactionTextures.delete(texture);this.busy.delete(texture);this.used.delete(texture)
    this.lastUsed.delete(texture);this.aliases.delete(texture)
    this.driver.destroy(texture);this.bytes-=texture.bytes;this.interactionBytes-=texture.bytes
    this.stationaryBackdrop=undefined
  }
  private interactionBackdrop(n: GpuNode, backdrop: Surface, sigma: number): Surface {
    const proof=import.meta.env.VITE_DESIGN_STATIC_BACKDROP!=='0'?staticBackdropKey(this.scene,n):undefined
    const support=this.scene.integratedBlur?Math.ceil(sigma*2)+2:gaussianRadii(sigma).reduce((n,r)=>n+r,2)
    const capture=import.meta.env.VITE_DESIGN_EFFECT_REGIONS!=='0'&&!this.interactionCapturing
      ?interactionEffectRegion(this.scene,n.rect,support):n.rect
    const movingProof=import.meta.env.VITE_DESIGN_MOVING_BACKDROP==='1'&&!this.interactionCapturing
      ?movingBackdropKey(this.scene,n):undefined
    if(movingProof && exactBlendLattice([capture]) && capture.w*capture.h<=4_194_304){
      this.backdropEligibleFrames++
      const lease=this.scene.interactionLease!,key=JSON.stringify([movingProof,sigma])
      const old=this.movingBackdrop
      const overlap=old?.lease===lease&&old.key===key?backdropOverlap(old.plane.rect,capture,support):undefined
      const area=capture.w*capture.h,needed=area*16
      const regionWork=overlap?.dirty.reduce((sum,r)=>sum+r.input.w*r.input.h,0)??area
      // Bound the extra cache and admit only genuinely smaller filter work.
      // Allocation/precision failures keep the established full exact graph.
      if(this.interactionBytes-(old?.plane.texture.bytes||0)+needed<=this.interactionBudget &&
          !this.overBudget(needed*3)){
        this.backdropAdmittedFrames++
        const previousCapturing=this.interactionCapturing
        // A later pose can expose today's filter halo. Compute every cached
        // pixel, including that halo, rather than storing scissored zeros.
        this.interactionCapturing=true
        try {
        let result:Surface
        if(overlap&&regionWork<area*.6){
          this.backdropReuseFrames++;this.backdropReusePixels+=area-regionWork
          result=this.copy(old!.plane,capture)
          this.releaseMovingBackdrop()
          for(const {input,output} of overlap.dirty){
            const source=this.copy(backdrop,input),filtered=this.blur(source,sigma)
            const u=parameters(capture,filtered.rect);u[16]=0
            this.driver.pass(result.texture,u,[filtered.texture],
              {x:output.x-capture.x,y:output.y-capture.y,w:output.w,h:output.h})
            this.passPixels+=output.w*output.h
            this.release(source,filtered)
          }
          this.interactionHits++
        }else{
          this.releaseMovingBackdrop()
          const source=this.copy(backdrop,capture)
          result=this.blur(source,sigma)
          if(result!==source)this.release(source)
        }
        const plane=this.copyInteractionSource(result)
        this.movingBackdrop={lease,key,plane}
        this.interactionTextures.add(plane.texture);this.interactionBytes+=plane.texture.bytes
        return result
        } finally { this.interactionCapturing=previousCapturing }
      }
    }
    const key=proof===undefined?undefined:JSON.stringify([proof,sigma,capture])
    const lease=this.scene.interactionLease||sceneIndex(this.scene),known=this.stationaryBackdrop
    if(known&&known.lease===lease&&known.key===key){
      this.used.add(known.plane.texture);this.interactionHits++
      return this.retain(known.plane)
    }
    if(key&&known)this.retireStationaryBackdrop()
    const captured=this.copy(backdrop,capture),blurred=this.blur(captured,sigma)
    if(captured!==blurred)this.release(captured)
    const needed=blurred.rect.w*blurred.rect.h*16
    if(key&&needed<=64*1024*1024&&this.interactionBytes+needed<=this.interactionBudget&&!this.overBudget(needed)){
      const plane=this.copyInteractionSource(blurred)
      this.stationaryBackdrop={lease,key,plane}
      this.interactionTextures.add(plane.texture);this.interactionBytes+=plane.texture.bytes
    }
    return blurred
  }
  private nativeChanging = new Set<string>()
  private interactionWarm = false
  private interactionPrefix?: { index: SceneIndex; key: string; count: number; planes: Surface[] }
  private prefixHits = 0
  private retireInteractionPrefix() {
    for (const {texture} of this.interactionPrefix?.planes || []) {
      this.interactionTextures.delete(texture); this.busy.delete(texture); this.used.delete(texture)
      this.lastUsed.delete(texture); this.aliases.delete(texture)
      this.driver.destroy(texture); this.bytes -= texture.bytes; this.interactionBytes -= texture.bytes
    }
    this.interactionPrefix = undefined
  }
  private imageAxisFields = 0
  private imageFieldBytes = 0
  private imageAxes = new WeakMap<Texture, boolean>()
  private retireInteractionRoots(keep = new Set<GpuNode>()) {
    for (const [key, cached] of this.interactionRoots) if (!keep.has(key)) {
      for (const { texture } of cached.planes) {
        this.interactionTextures.delete(texture); this.busy.delete(texture); this.used.delete(texture)
        this.lastUsed.delete(texture); this.aliases.delete(texture)
        this.driver.destroy(texture); this.bytes -= texture.bytes; this.interactionBytes -= texture.bytes
      }
      this.interactionRoots.delete(key)
    }
  }
  /** Cache isolated root contributions, then composite them over the current
   * background at the current placement/blend. Internal masks and backdrop
   * effects stay inside their isolation boundary. External backdrop reads and
   * pass-through roots always run the normal render graph. */
  private async drawInteractionRoots(targets: Surface[]) {
    const draw = async (id: string, surfaces: Surface[]) => surfaces.length === 4
      ? this.drawBundle([id], surfaces) : [await this.drawList([id], surfaces[0])]
    const index=sceneIndex(this.scene)
    const moving=new Set((this.scene.interactionSelection||[]).map(id=>index.rootFor.get(id)))
    const firstMoving=this.scene.roots.findIndex(id=>moving.has(id))
    // A single already-isolated root costs one composition, exactly like a
    // prefix restore. Retaining it only spends memory without removing work.
    const worthwhilePrefix=firstMoving>1||firstMoving===1&&(() => {
      const first=this.scene.nodes[this.scene.roots[0]]
      return !!first&&(!!first.passthrough||!!first.mask||!!backdropEffect(first.effects))
    })()
    const canRetainPrefix=index.unknownEffectSubtrees.size===0&&this.driver.captureDisplay&&this.driver.displayMath&&!this.scene.coherentSamples&&
      import.meta.env.VITE_DESIGN_RETAIN_PREFIX==='1'&&worthwhilePrefix&&
      this.scene.roots.slice(0,firstMoving).every(id=>!this.scene.nodes[id]?.previewDynamic)
    const {nodes:_nodes,vertices:_vertices,curves:_curves,...policy}=this.scene
    const prefixKey=canRetainPrefix?JSON.stringify([policy,this.scene.roots.slice(0,firstMoving).map(id=>{
      const node=this.scene.nodes[id];return[node?.rect,node?.matrix]
    })],(_key,value)=>Object.is(value,-0)?'-0':value):''
    if(this.interactionPrefix&&(this.interactionPrefix.index!==index||this.interactionPrefix.key!==prefixKey))this.retireInteractionPrefix()
    let begin=0
    if(this.interactionPrefix){
      this.release(...targets)
      targets=this.interactionPrefix.planes.map(plane=>{this.used.add(plane.texture);return this.copyInteractionSource(plane)})
      begin=this.interactionPrefix.count;this.prefixHits++
    }
    for (let at=begin;at<this.scene.roots.length;at++) {
      // Prefix captures include all prior blend/backdrop operations in their
      // original order. Only a prefix independent of the moving roots survives.
      if(at===firstMoving&&canRetainPrefix&&!this.interactionPrefix){
        const needed=targets.reduce((bytes,p)=>bytes+p.rect.w*p.rect.h*16,0)
        if(this.interactionBytes+needed<=this.interactionBudget&&!this.overBudget(needed)){
          const planes:Surface[]=[]
          try{for(const target of targets)planes.push(this.copyInteractionSource(target))}
          catch(error){this.release(...planes);throw error}
          this.interactionPrefix={index,key:prefixKey,count:firstMoving,planes}
          for(const {texture} of planes){this.interactionTextures.add(texture);this.interactionBytes+=texture.bytes}
        }
      }
      const id=this.scene.roots[at]
      const n = this.scene.nodes[id]
      if (!n || !classifyCompiledSourceReuse(n, index.unknownEffectSubtrees.has(id)).reusable) {
        targets = await draw(id, targets); continue
      }
      const key = n.previewSource || n, cached = this.interactionRoots.get(key)
      let contribution: Surface[]
      if (cached && cached.planes.length === targets.length && cached.anchor.w === n.rect.w && cached.anchor.h === n.rect.h) {
        const dx = n.rect.x - cached.anchor.x, dy = n.rect.y - cached.anchor.y
        contribution = cached.planes.map(plane => this.retain({ ...plane, rect: { ...plane.rect, x: plane.rect.x + dx, y: plane.rect.y + dy } }))
        for (const plane of contribution) this.used.add(plane.texture)
        this.interactionHits++
      } else {
        if (cached) this.retireInteractionRoots(new Set([...this.interactionRoots.keys()].filter(source => source !== key)))
        const needed = n.rect.w * n.rect.h * 16 * targets.length
        if (this.interactionBytes + needed > this.interactionBudget || this.interactionRoots.size >= 128 || this.overBudget(needed * 2)) {
          targets = await draw(id, targets); continue
        }
        this.interactionCapturing = true
        try { contribution = await draw(id, targets.length === 4 ? this.emptyBundle(n.rect) : [this.empty(n.rect)]) }
        finally { this.interactionCapturing = false }
        // Dedicated immutable copies give each persistent plane one owner;
        // frame-local aliases may then be cleared safely at the frame boundary.
        const planes: Surface[] = []
        try {
          for (const plane of contribution) planes.push(this.copyInteractionSource(plane))
        } catch (error) { this.release(...planes, ...contribution); throw error }
        this.interactionRoots.set(key, { anchor: { ...n.rect }, planes })
        for (const { texture } of planes) { this.interactionTextures.add(texture); this.interactionBytes += texture.bytes }
      }
      for (let i = 0; i < targets.length; i++) {
        this.sampleIndex = this.scene.coherentSamples ? i : undefined
        const regional = import.meta.env.VITE_DESIGN_RETAINED_ROOT_BLEND !== '0'
        const next = regional ? this.merge(contribution[i], targets[i], n.blend) : this.compose(contribution[i],targets[i],n.blend)
        if(!regional)this.release(targets[i])
        this.release(contribution[i]); targets[i] = next
      }
    }
    return targets
  }
  private free = new Map<string, Texture[]>()
  private busy = new Set<Texture>()
  private aliases = new Map<Texture, number>()
  private releasedAliases = new WeakSet<Surface>()
  private constantTargets = new Map<string, Surface>()
  private independentSampleNodes = new Map<string, boolean>()
  private prefixAllowed = true
  private bytes = 0
  private peak = 0
  private passPixels = 0
  private hybridEffects = 0
  private checkpointMs = 0
  private activeNode = ''
  private traceSurfaces = new WeakMap<Texture, { node: string; mode: number; sample?: number }>()
  private used = new Set<Texture>()
  private images = new Map<string, Surface>()
  private imageDims = new Map<string, [number, number]>()
  private imageOrigins = new Map<string, [number, number]>()
  private atlasPages: AtlasPage[] = []
  private scene!: GpuScene
  private masks = new ReverseIndexMap<string, Surface, Texture>(surface => [surface.texture])
  // Conservative per-frame use history, not a lifetime refcount. A mask ever
  // used by another node cannot be retired by a leaf in the current frame.
  private maskOwners = new ReverseIndexMap<Texture, Set<string>, string>(owners => owners)
  private blurKernels = new Map<string, Surface>()
  private certifiedKernels = new Map<string, Surface>()
  private kernelCache = new ImmutableKernelCache(4 * 1024 * 1024, 64, texture => this.forgetUpload(texture))
  // CPU-only retention for the pure certified-tent constructor. This does
  // not enable GPU kernel residency or alter any upload/fence lifetime.
  private coefficientBytes = new CoefficientByteCache(1024 * 1024, 64)
  private retiredKernels: { texture: Texture; epoch: number }[] = []
  private kernelBuilds = 0
  private kernelResidentHits = 0
  private kernelUploadBytes = 0
  // Opt-in pending real-device validation. Drivers without a completion
  // contract retain the original per-attempt lifetime, even with the flag.
  private get retainKernels() {
    return this.optimized && import.meta.env.VITE_DESIGN_KERNEL_CACHE === '1' &&
      this.driver.resourceEpoch !== undefined && this.driver.completedResourceEpoch !== undefined
  }
  private coordinateMaps = new Set<Texture>()
  // Row strips share one immutable, certified support field per sample.
  // Samples that cannot separate keep their original dense strip fallback.
  private filterImageFields?: { rect: Rect; fields: Map<string, Surface | null>; pinned: Set<Texture> }
  private imageGrids = new Map<GpuPaint, Map<number, Surface>>()
  private gradientLookups = new Map<GpuPaint, Surface>()
  private textureLookups = new Map<string, Surface>()
  private textureMath: Surface | undefined
  private replayParameters: Texture | undefined
  // Monotonic use counter: every pool hand-out, pool return, parameter upload
  // and image sample stamps it, ordering LRU/age candidates within and across
  // frames. It never gates destruction - the checkpoint discipline does.
  private generation = 0
  private lastUsed = new Map<Texture, number>()
  // A pool entry has no future reader until acquire removes it. Stamp actual
  // pool return, not allocation: cached coverage may be read in a newer frame.
  private poolReleaseEpoch = new WeakMap<Texture, number>()
  // Parameter uploads whose last read has been encoded. Destroying them early
  // could race queued commands and pooling them would let a later writeTexture
  // overtake pending reads, so only a completed checkpoint may destroy them.
  private retiredUploads: Texture[] = []
  private meshBits = new Uint32Array(0)
  private curveBits = new Uint32Array(0)
  private sharedMasks = new ReverseIndexMap<string, { bits: Uint32Array; texture: Texture }[], Texture>(entries => entries.map(entry => entry.texture))
  private maskHits = 0
  private maskRasterizations = 0
  private sampleIndex: number | undefined
  private backdropReads = 0
  private orderedEffectLayers = 0
  private coverage = new CoverageCache(64 * 1024 * 1024, 4096, (texture) => {
    this.maskOwners.delete(texture)
    this.busy.delete(texture)
    this.used.delete(texture)
    this.lastUsed.delete(texture)
    this.driver.destroy(texture)
    this.bytes -= texture.bytes
  })
  // Immutable geometry fields share the compositor's global budget. Cache only
  // exact full-parameter keys; cached fields never enter the writable color pool.
  private fieldHits = 0
  private fieldBuilds = 0
  private fieldBuildMs = 0
  private fieldUploadBytes = 0
  // Streamed filters produce many small exact sample-coordinate fields. Two
  // revisited views can exceed 64 entries without approaching the 32 MiB limit.
  // Retain their bounded LRU working set; current-frame pins and byte budget
  // still control eviction and admission independently of this entry ceiling.
  private materialFields = new CoverageCache(32 * 1024 * 1024, 256, texture => {
    this.busy.delete(texture)
    this.used.delete(texture)
    this.lastUsed.delete(texture)
    this.driver.destroy(texture)
    this.bytes -= texture.bytes
  })
  private materialField<T extends Float32Array | Uint8Array>(inputs: unknown[], r: Rect, build: () => T,
    upload: (values: T, width: number, height: number) => Texture,
    layout?: (values: T) => [number, number], admissionBytes = r.w * r.h * 16, allowCache = true): Surface {
    const key = JSON.stringify(inputs, (_key, value) => Object.is(value, -0) ? '-0' : value)
    const bits = new Uint32Array(0)
    let texture = this.optimized && allowCache ? this.materialFields.get(key, bits) : undefined
    if (texture) this.fieldHits++
    else {
      if (this.overBudget(admissionBytes, layout ? undefined : r.w, layout ? undefined : r.h)) throw this.budgetError('GPU 表面内存预算超限')
      const start = performance.now()
      const values = build()
      this.fieldBuildMs += performance.now() - start
      this.fieldBuilds++
      const [width,height] = layout?.(values) || [r.w,r.h]
      if (values.length !== width * height * 4) throw Error('无效的参数字段布局')
      if (this.overBudget(values.byteLength, width, height)) throw this.budgetError('GPU 表面内存预算超限')
      texture = upload.call(this.driver, values, width, height)
      this.fieldUploadBytes += values.byteLength
      this.bytes += texture.bytes
      this.peak = Math.max(this.peak, this.bytes)
      if (!this.optimized || !allowCache || !this.materialFields.put(key, bits, texture)) this.coordinateMaps.add(texture)
    }
    this.busy.add(texture)
    this.used.add(texture)
    this.touch(texture)
    return { texture, rect: r }
  }
  constructor(
    readonly driver: Driver,
    private optimized = true,
    private allowSolidBatch = true,
    private managedImageLoader?: ManagedImageLoader,
    private imageMips = false,
    private imageAtlas = false,
    private readonly gpuWorkingBudgetMiB?: number,
  ) {
    this.frameBudget = workingSetBudget(0, 0, false, 0, gpuWorkingBudgetMiB)
    this.bytes = driver.scratchBytes || 0
    this.peak = this.bytes


  }
  private color(s: string): number[] {
    return this.scene.colors?.[s]?.slice(0, 3) || rgb(s)
  }
  private alpha(s: string): number {
    return this.scene.colors?.[s]?.[3] ?? 1
  }
  private acquire(r: Rect, binaryCoverage = false, scalarCoverage = false): Surface {
    if (r.w < 1 || r.h < 1) throw new Error('空 GPU 表面')
    const required = textureByteLength(r.w, r.h, this.driver.managed && !binaryCoverage && !scalarCoverage ? 16 : 4)
    if (![r.x, r.y, r.x + r.w, r.y + r.h].every(value => Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER))
      throw new Error('无效的 GPU 表面边界')
    const key = `${scalarCoverage ? 'scalar:' : binaryCoverage ? 'binary:' : ''}${r.w}:${r.h}`,
      list = this.free.get(key)
    let texture = list?.pop()
    if (!texture) {
      // Over-budget pressure first evicts the oldest generations of the free
      // pool and the least-recently-used images (both re-create identically).
      if (this.overBudget(required, r.w, r.h)) {
        if (import.meta.env.DEV && import.meta.env.VITE_DESIGN_TRACE_PASSES === 'tile') {
          const busy = new Map<string, number>()
          for (const texture of this.busy) {
            const key = `${texture.width}x${texture.height}`
            busy.set(key, (busy.get(key) || 0) + 1)
          }
          console.debug('DESIGN_GPU_BUDGET ' + JSON.stringify({ node: this.activeNode,
            view: this.scene.view, bytes: this.bytes, required, allocation: r,
            busy: [...busy], surfaces: [...this.busy].map(t => ({ width:t.width,height:t.height,bytes:t.bytes,
              binary:!!t.binaryCoverage,scalar:!!t.scalarCoverage,aliases:this.aliases.get(t)||1,...this.traceSurfaces.get(t) })),
            coordinates: this.coordinateMaps.size, stack: new Error().stack }))
        }
        throw this.budgetError('GPU 表面内存预算超限')
      }
      texture = scalarCoverage ? this.driver.createScalarCoverage!(r.w,r.h) : binaryCoverage ? this.driver.createBinaryCoverage!(r.w, r.h) : this.driver.create(r.w, r.h)
      this.bytes += texture.bytes
      this.peak = Math.max(this.peak, this.bytes)
    }
    this.poolReleaseEpoch.delete(texture)
    delete texture.transparentZero
    delete texture.uniformColor
    delete texture.finitePixels
    delete texture.opaqueAlpha
    this.touch(texture)
    this.busy.add(texture)
    this.used.add(texture)
    return { texture, rect: r }
  }
  private touch(texture: Texture) {
    this.lastUsed.set(texture, ++this.generation)
  }
  /** Remove one texture from its free list and destroy it. Only call this for
   * textures whose GPU commands provably completed. */
  private destroyFree(texture: Texture) {
    const key = `${texture.scalarCoverage ? 'scalar:' : texture.binaryCoverage ? 'binary:' : ''}${texture.width}:${texture.height}`,
      list = this.free.get(key)
    if (!list) return
    const at = list.indexOf(texture)
    if (at < 0) return
    list.splice(at, 1)
    if (!list.length) this.free.delete(key)
    this.used.delete(texture)
    this.lastUsed.delete(texture)
    this.driver.destroy(texture)
    this.bytes -= texture.bytes
  }
  /** Evict least-recently-used images until `required` bytes are free. Outside
   * a completed checkpoint only images unreferenced by this frame's commands
   * may go; after one, `forced` broadens the set to every image. Evicted
   * images reload through the same deterministic decoder, so sampled values
   * are bit-identical after a reload. */
  private evictImages(required: number, forced = false) {
    if (required <= 0) return
    const pageTextures = new Set(this.atlasPages.map((p) => p.texture))
    const candidates = [...this.images]
      .filter(([, surface]) => !pageTextures.has(surface.texture))
      .filter(([, surface]) => !this.pendingImageTableSources.has(surface.texture) && !this.driver.hasActiveImageTableSource?.(surface.texture))
      .filter(([, surface]) => !this.sequentialImagePins.has(surface.texture))
      .filter(([, surface]) => !this.staticImageBlurs.pinsSource(surface.texture))
      .filter(([, surface]) => forced || !this.used.has(surface.texture))
      .sort((a, b) => (this.lastUsed.get(a[1].texture) || 0) - (this.lastUsed.get(b[1].texture) || 0))
    for (const [uri, surface] of candidates) {
      if (required <= 0) break
      this.images.delete(uri)
      this.used.delete(surface.texture)
      this.lastUsed.delete(surface.texture)
      this.driver.destroy(surface.texture)
      this.bytes -= surface.texture.bytes
      required -= surface.texture.bytes
    }
    // Atlas pages evict whole (shared texture). A page pinned by any sampled
    // slot survives outside forced (post-checkpoint) pressure.
    for (const page of [...this.atlasPages]) {
      if (required <= 0) break
      if (this.pendingImageTableSources.has(page.texture) || this.driver.hasActiveImageTableSource?.(page.texture)) continue
      if (this.sequentialImagePins.has(page.texture)) continue
      if (this.staticImageBlurs.pinsSource(page.texture)) continue
      if (!forced && this.used.has(page.texture)) continue
      this.destroyAtlasPage(page)
      required -= page.texture.bytes
    }
  }
  /** Budget gate shared by every allocation site: returns whether `required`
   * bytes still do not fit after evicting provably completed resources.
   * Coverage entries, pool textures and images untouched by this frame were
   * last referenced before the previous frame completed, so destroying them
   * cannot race queued commands. Callers keep throwing their explicit errors;
   * nothing is silently downgraded. */
  private overBudget(required: number, width?: number, height?: number): boolean {
    this.lastBudgetFailure = undefined
    this.staticImageBlurs.collect(this.driver.completedResourceEpoch)
    if (!Number.isSafeInteger(required) || required < 0) throw new Error('无效的 GPU 分配字节数')
    if (this.workingBytes + required <= this.frameBudget) return false
    if (this.nestedPrefix) this.nestedPrefixPressure = true
    this.staticImageBlurs.discardPending(this.driver.resourceEpoch)
    // Optional retained filter work never expands the common working budget.
    // Pool release preserves ordering when the entry was copied this frame.
    this.horizontalFilters.clear()
    this.reapRetiredKernels()
    this.kernelCache.evictCompleted(this.workingBytes + required - this.frameBudget, this.driver.completedResourceEpoch ?? -1)
    this.materialFields.evictUnused(this.workingBytes + required - this.frameBudget)
    this.coverage.evictUnused(this.workingBytes + required - this.frameBudget)
    if (this.workingBytes + required <= this.frameBudget) return false
    // Only evict textures not referenced by this frame's commands. A large
    // viewport resize must not require both old and new pools to fit at once.
    const stale: Texture[] = []
    for (const list of this.free.values())
      for (const texture of list) if (!this.used.has(texture)) stale.push(texture)
    stale.sort((a, b) => (this.lastUsed.get(a) || 0) - (this.lastUsed.get(b) || 0))
    for (const texture of stale) {
      if (this.workingBytes + required <= this.frameBudget) break
      this.destroyFree(texture)
    }
    if (this.workingBytes + required <= this.frameBudget) return false
    this.evictImages(this.workingBytes + required - this.frameBudget)
    if (this.workingBytes + required > this.frameBudget) {
      this.staticImageBlurs.clear()
      this.retireDisplayMaterial()
      // Only GPU-completed entries can reach the pool here. Borrowed or
      // in-flight results retain their source/plane pins until their fence.
      for (const list of [...this.free.values()]) for (const texture of [...list]) {
        if (this.workingBytes + required <= this.frameBudget) break
        if (!this.used.has(texture)) this.destroyFree(texture)
      }
      this.evictImages(this.workingBytes + required - this.frameBudget)
    }
    if (this.workingBytes + required > this.frameBudget && !this.driver.captureDisplay && !this.scene?.interactionRetained && this.interactionRoots.size)
      this.retireInteractionRoots()
    const exceeded = this.workingBytes + required > this.frameBudget
    if (exceeded)
      this.lastBudgetFailure = sanitizeRenderBudget({ requestedBytes: required, workingBytes: this.workingBytes,
        budgetBytes: this.frameBudget, width, height, coherent: this.scene?.coherentSamples })
    return exceeded
  }
  /** Consume at the immediate allocation rejection, before any recovery can
   * clear/reuse this renderer. Optional failed admissions own no error. */
  private budgetError(message: string): Error {
    const diagnostic = this.lastBudgetFailure
    this.lastBudgetFailure = undefined
    return markRenderFailure(renderErrorWithBudget(message, undefined, diagnostic), { failureStage: 13, failureCategory: 3, failureCode: 200 })
  }
  private release(...surfaces: (Surface | undefined)[]) {
    for (const s of new Set(surfaces)) {
      if (!s || this.materialFields.has(s.texture) || this.releasedAliases.has(s)) continue
      this.releasedAliases.add(s)
      const references = this.aliases.get(s.texture)
      if (references) {
        if (references > 1) { this.aliases.set(s.texture, references - 1); continue }
        this.aliases.delete(s.texture)
      }
      if (!this.busy.delete(s.texture)) continue
      const key = `${s.texture.scalarCoverage ? 'scalar:' : s.texture.binaryCoverage ? 'binary:' : ''}${s.texture.width}:${s.texture.height}`,
        list = this.free.get(key) || []
      list.push(s.texture)
      const epoch = this.driver.resourceEpoch
      if (Number.isSafeInteger(epoch) && epoch! > 0) this.poolReleaseEpoch.set(s.texture, epoch!)
      else this.poolReleaseEpoch.delete(s.texture)
      this.free.set(key, list)
      // Returning to the pool is the end of this texture's latest use; stamp
      // it so pressure eviction prefers the least recently used entry.
      this.touch(s.texture)
    }
  }
  private retain(surface: Surface): Surface {
    this.aliases.set(surface.texture, (this.aliases.get(surface.texture) || 1) + 1)
    return { ...surface }
  }
  private empty(r: Rect) {
    if (this.optimized && this.driver.managed && !this.allowSolidBatch && this.driver.zeroTextureSampling) {
      // Isolation ancestors need logical transparent planes, not full-sized
      // RGBA32F allocations. Keep a cache reference so this input can never be
      // selected for an in-place update. Sampling uses the original bounds;
      // in particular source D may share source A's rectangle at resolve.
      let zero = this.constantTargets.get('transparent-zero')
      if (!zero) {
        zero = this.acquire(rect(0, 0, 1, 1))
        this.driver.clear(zero.texture)
        zero.texture.transparentZero = true
        this.constantTargets.set('transparent-zero', zero)
      }
      return { ...this.retain(zero), rect: r }
    }
    const s = this.acquire(r)
    this.driver.clear(s.texture)
    if (import.meta.env.DEV && import.meta.env.VITE_DESIGN_TRACE_PASSES === 'tile')
      this.traceSurfaces.set(s.texture,{node:this.activeNode,mode:-1,sample:this.sampleIndex})
    return s
  }
  private emptyBundle(r: Rect): Surface[] {
    const first=this.empty(r)
    // Managed composition writes fresh targets. The four zero sample planes
    // are identical immutable inputs until consumed, just like the already
    // shared background. Byte/hardware-blended targets remain independent.
    return this.optimized&&this.driver.managed&&!this.allowSolidBatch
      ? [first,this.retain(first),this.retain(first),this.retain(first)]
      : [first,this.empty(r),this.empty(r),this.empty(r)]
  }
  private drawRegion(r:Rect):Rect|undefined {
    let region:Rect|undefined
    const window=this.scene.interactionWindow
    if(window&&this.scene.interactionRetained&&!this.interactionCapturing&&this.driver.name==='webgpu'&&
        import.meta.env.VITE_DESIGN_INTERACTION_SCISSOR!=='0'){
      // Geometry keeps a generous movement guard; per-sample shading only
      // needs the visible interior plus the compiler's complete effect halo.
      // Cached subtree captures stay full-size for subsequent translations.
      const halo=interactionHalo(this.scene)
      const clip=intersect(r,{x:Math.floor(window.x-halo),y:Math.floor(window.y-halo),w:Math.ceil(window.w+halo*2+2),h:Math.ceil(window.h+halo*2+2)})
      const x=Math.max(0,Math.floor(clip.x-r.x)),y=Math.max(0,Math.floor(clip.y-r.y))
      region={x,y,w:Math.max(0,Math.min(r.w-x,Math.ceil(clip.x+clip.w-r.x)-x)),h:Math.max(0,Math.min(r.h-y,Math.ceil(clip.y+clip.h-r.y)-y))}
    }
    return region
  }
  private run(mode: number, r: Rect, inputs: Surface[], configure?: (u: Float32Array) => void, channels = 15, filter?: {kind: 'tent'; radius: number}, scalarOutput = false, destination?: Surface) {
    if (destination && (mode !== 22 || !filter || channels !== 15 || scalarOutput || !this.driver.managed ||
        r.w <= 0 || r.h <= 0 || !exactBlendLattice([r, destination.rect]) || !Object.keys(r).every(key => Object.is(r[key as keyof Rect], destination.rect[key as keyof Rect])) ||
        destination.texture.width !== r.w || destination.texture.height !== r.h || destination.texture.bytes !== r.w * r.h * 16 ||
        destination.texture.binaryCoverage || destination.texture.scalarCoverage || !this.busy.has(destination.texture) ||
        this.releasedAliases.has(destination) || (this.aliases.get(destination.texture) || 1) > 1 ||
        this.coverage.has(destination.texture) || this.materialFields.has(destination.texture) || this.interactionTextures.has(destination.texture) ||
        this.horizontalFilters.has(destination.texture) || this.staticImageBlurs.has(destination.texture) ||
        inputs.some(input => input.texture === destination.texture || input.texture.resource === destination.texture.resource)))
      throw Error('Invalid private exact filter destination')
    const out = destination || this.acquire(r, false, scalarOutput),
      u = parameters(r, inputs[0]?.rect, inputs[1]?.rect, inputs[2]?.rect)
    if (import.meta.env.DEV && import.meta.env.VITE_DESIGN_TRACE_PASSES === 'tile')
      this.traceSurfaces.set(out.texture,{node:this.activeNode,mode,sample:this.sampleIndex})
    u[16] = mode
    configure?.(u)
    const region=this.drawRegion(r)
    if (destination && region) throw Error('Private exact filter destination cannot be scissored')
    if(region&&(!region.w||!region.h)){this.driver.clear(out.texture);return out}
    if (filter && this.prefixAllowed) {
      const before = this.driver.scratchBytes || 0
      this.driver.prepareFilterPass?.(out.texture, u, inputs.map((s) => s.texture), channels, filter, this.frameBudget - this.workingBytes)
      this.bytes += (this.driver.scratchBytes || 0) - before
      this.peak = Math.max(this.peak, this.bytes)
    }
    this.driver.pass(
      out.texture,
      u,
      inputs.map((s) => s.texture),
      region, channels, this.prefixAllowed || filter && this.driver.usesDisplayFilter?.(filter.radius, channels) ? filter : undefined, !!region,
    )
    this.passPixels += region ? region.w * region.h : r.w * r.h
    return out
  }
  private copy(s: Surface, r = s.rect) {
    return this.run(0, r, [s])
  }
  // A non-isolated source already contains the backdrop. Interpolate the
  // complete group; source-over would count the backdrop alpha a second time.
  private interpolate(src: Surface, dst: Surface, opacity = 1, mask?: Surface) {
    return this.run(28, dst.rect, mask ? [src, dst, mask] : [src, dst], (u) => {
      u.set([28, this.scene.integratedBlur ? 1 : 0, opacity, mask ? 1 : 0], 16)
    })
  }
  private trackMask(surface: Surface): Surface {
    const owners = this.maskOwners.get(surface.texture) || new Set<string>()
    // Empty activeNode is deliberately an unknown owner and blocks retirement.
    owners.add(this.activeNode)
    this.maskOwners.set(surface.texture, owners)
    return surface
  }
  /** Call only after every read of this leaf's fill masks has been encoded.
   * Drop every cache alias before returning the allocation to the ordered
   * render-target pool. Only a later completed checkpoint may destroy it.
   * The threshold shares the reclaim cadence: mask retirement keeps pace with
   * incremental scratch reclamation instead of waiting for a 96 MiB backlog.
   */
  private retireLeafMasks(n: GpuNode, masks: Surface[] | undefined, clip: Surface[] | undefined, targets: Surface[], completed = false) {
    if (this.bytes < this.frameBudget * .25 || n.children.length && !completed) return
    if(this.driver.captureDisplay&&this.scene.interactionRetained&&
      (this.interactionWarm||this.workingBytes<this.frameBudget*.875))return
    const protectedTextures = new Set([...targets, ...(clip || [])].map((surface) => surface.texture))
    for (const texture of masks ? new Set(masks.map((surface) => surface.texture)) : this.maskOwners.keysFor(n.id)) {
      const owners = this.maskOwners.get(texture)
      if (!owners || owners.size !== 1 || !owners.has(n.id) || protectedTextures.has(texture) || !this.busy.has(texture)) continue
      this.coverage.remove(texture)
      for (const key of this.masks.keysFor(texture)) this.masks.delete(key)
      for (const key of this.sharedMasks.keysFor(texture)) {
        const entries = this.sharedMasks.get(key)!
        const retained = entries.filter((entry) => entry.texture !== texture)
        if (retained.length) this.sharedMasks.set(key, retained)
        else this.sharedMasks.delete(key)
      }
      this.maskOwners.delete(texture)
      this.release({ texture, rect: rect(0, 0, texture.width, texture.height) })
    }
  }
  private mask(path: PathMesh) {
    const analytic =
      path.analyticRect
        ?.map((v, i) => Math.fround(v - (i % 2 ? path.rect.y : path.rect.x)))
        .join(',') || ''
    const program = path.area
      ? `area-${path.area.first}-${path.area.count}`
      : path.analytic
        ? `ray-${path.analytic.first}-${path.analytic.count}`
        : 'mesh'
    const key = `${this.sampleIndex ?? 'resolved'}:${program}:${path.sampleCount || 16}:${analytic}:${path.first}:${path.count}:${path.rule}:${path.rect.x}:${path.rect.y}:${path.rect.w}:${path.rect.h}`
    let s = this.masks.get(key)
    if (s) return this.trackMask({...s,opaqueInterior:path.opaqueRect})
    const bits = path.area
      ? this.curveBits.subarray(path.area.first * 4, (path.area.first + path.area.count) * 4)
      : path.analytic
        ? this.curveBits.subarray(
            path.analytic.first * 4,
            path.analytic.first * 4 + path.analytic.count * 16,
          )
        : this.meshBits.subarray(path.first * 2, (path.first + path.count) * 2)
    let fingerprint:string
    if(path.area?.fingerprint && import.meta.env.VITE_DESIGN_COVERAGE_FINGERPRINT!=='0')
      fingerprint=`u64:${path.area.fingerprint[0]}:${path.area.fingerprint[1]}`
    else {
      let hash=2166136261
      for(const bit of bits)hash=Math.imul(hash^bit,16777619)
      fingerprint=`u32:${hash>>>0}`
    }
    // Reuse the kernel's already-computed bucket. Both cache lookups below
    // still compare every word; a fingerprint never proves pixel equality.
    const shapeKey = `${this.sampleIndex ?? 'resolved'}:${path.area ? 'area' : path.analytic ? 'ray' : 'mesh'}:${path.sampleCount || 16}:${analytic}:${path.rule}:${path.rect.w}:${path.rect.h}:${path.count}:${fingerprint}`
    const retained = this.optimized ? this.coverage.get(shapeKey, bits) : undefined
    if (retained) {
      this.used.add(retained)
      s = { texture: retained, rect: path.rect }
      this.masks.set(key, s)
      this.maskHits++
      return this.trackMask({...s,opaqueInterior:path.opaqueRect})
    }
    const candidates = this.sharedMasks.get(shapeKey) || []
    if (this.optimized)
      for (const candidate of candidates) {
        // Hash equality is only an index. Every vertex is checked before reuse,
        // including subpixel positions, winding order and viewport clipping.
        if (bits.length===candidate.bits.length&&bits.every((bit, i) => bit === candidate.bits[i])) {
          s = { texture: candidate.texture, rect: path.rect }
          this.masks.set(key, s)
          this.maskHits++
          return this.trackMask({...s,opaqueInterior:path.opaqueRect})
        }
      }
    // Figma sample programs and analytic winding return exactly 0 or 1.
    // Continuous-area, rectangle-integral and mesh coverage stay RGBA32F.
    const header = path.area && new Float32Array(this.curveBits.buffer,
      this.curveBits.byteOffset + path.area.first * 16, 1)[0]
    const binary = !!(this.optimized && this.driver.managed && this.driver.createBinaryCoverage &&
      this.sampleIndex !== undefined && (path.area ? header === 3 || header === 4 : !!path.analytic))
    // Continuous coverage is one f32 repeated across RGBA, including each
    // coherent sample. R32F keeps its exact bits; bind expands it at every
    // sampling boundary. Binary sample programs already use four-byte storage.
    const scalar = !!(this.optimized && this.driver.managed && this.driver.createScalarCoverage &&
      !binary && path.area &&
      import.meta.env.VITE_DESIGN_SCALAR_COVERAGE !== '0')
    s = this.acquire(path.rect, binary, scalar)
    if (path.count) this.driver.mask(path, s.texture, this.sampleIndex)
    else this.driver.clear(s.texture)
    this.masks.set(key, s)
    this.maskRasterizations++
    if (this.optimized) this.coverage.put(shapeKey, bits, s.texture)
    candidates.push({ bits, texture: s.texture })
    this.sharedMasks.set(shapeKey, candidates)
    return this.trackMask({...s,opaqueInterior:path.opaqueRect})
  }
  private nodeMask(n: GpuNode) {
    if (!n.opaqueCoverage || !this.optimized) return this.mask(n.fill)
    const key = `opaque:${n.rect.x}:${n.rect.y}:${n.rect.w}:${n.rect.h}`
    const known = this.masks.get(key)
    if (known) return this.trackMask(known)
    const mask = this.acquire(n.rect, !!(this.driver.managed && this.driver.createBinaryCoverage))
    const u = parameters(n.rect)
    u[16] = 12
    u.set([1, 1, 1, 1], 48)
    this.driver.pass(mask.texture, u, [])
    this.passPixels += n.rect.w * n.rect.h
    this.masks.set(key, mask)
    return this.trackMask(mask)
  }
  private combine(a: Surface, b: Surface, r: Rect, outside = false) {
    return this.run(1, r, [a, b], (u) => {
      u[36] = outside ? 1 : 0
    })
  }
  private compose(src: Surface, dst: Surface, mode = 'normal', opacity = 1, mask?: Surface) {
    const blend = blends.indexOf(mode)
    if (blend < 0) throw new Error(`未知混合模式 ${mode}`)
    return this.run(3, dst.rect, mask ? [src, dst, mask] : [src, dst], (u) => {
      u[17] = blend
      u[18] = opacity
      u[19] = mask ? 1 : 0
    })
  }
  /** A private managed target can be updated in place after preserving only
   * the affected destination rectangle. Keep the positive bilinear neighbours
   * in the copy so integer-centre sampling has the same inputs at the edge.
   * Shared sample planes and texture feedback retain the full-target path. */
  private regionalOver(
    mode: number, bounds: Rect, dst: Surface, sources: Surface[],
    configure: (u: Float32Array) => void,
  ): Surface | undefined {
    if (!this.optimized || !this.driver.managed || (this.aliases.get(dst.texture) || 1) > 1 ||
        sources.some(s => s.texture === dst.texture) ||
        [bounds, dst.rect, ...sources.map(s => s.rect)].some(r =>
          Object.values(r).some(v => !Number.isInteger(v) || Math.abs(v) > 1048576))) return
    const region = intersect(bounds, dst.rect)
    if (!region.w || !region.h) return dst
    // A full-surface update gains nothing from the extra copy.
    if (region.w * region.h * 2 >= dst.rect.w * dst.rect.h) return
    const before = this.run(0, intersect({ ...region, w: region.w + 1, h: region.h + 1 }, dst.rect), [dst])
    const u = parameters(dst.rect, before.rect, sources[0]?.rect, sources[1]?.rect)
    u[16] = mode
    configure(u)
    this.driver.pass(dst.texture, u, [before.texture, ...sources.map(s => s.texture)],
      rect(region.x - dst.rect.x, region.y - dst.rect.y, region.w, region.h))
    this.passPixels += region.w * region.h
    this.release(before)
    return dst
  }
  private paintOver(n: GpuNode, paint: GpuPaint, mask: Surface, dst: Surface, clip?: Surface) {
    const constantColor = paint.constantColor ?? (paint.kind === 'solid' ? paint.color : undefined)
    if (
      this.optimized &&
      !clip &&
      (n.opaqueCoverage || (containsRect(mask.opaqueInterior, dst.rect) && containsRect(n.rect, dst.rect) &&
        exactBlendLattice([mask.rect, dst.rect, n.rect]))) &&
      constantColor &&
      paint.blend === 'normal' &&
      paint.opacity === 1 &&
      this.alpha(constantColor) === 1
    ) {
      if (this.driver.managed && !this.allowSolidBatch) {
        // Every sample sees the identical opaque constant across this entire
        // region. Share its exact RGBA32F pixels; later composition writes a
        // fresh target. The cache owns one reference, each plane owns another.
        const key = JSON.stringify([dst.rect, this.color(constantColor)])
        let constant = this.constantTargets.get(key)
        if (!constant) {
          constant = this.run(12, dst.rect, [], (u) => u.set([...this.color(constantColor), 1], 48))
          this.constantTargets.set(key, constant)
        }
        const out = this.retain(constant)
        this.release(dst)
        return out
      }
      const out = this.run(12, dst.rect, [], (u) => u.set([...this.color(constantColor), 1], 48))
      this.release(dst)
      return out
    }
    if (this.optimized && this.driver.managed && this.driver.exactSolidPaintOver &&
        paint.kind === 'solid' && paint.blend === 'normal' &&
        [...this.color(paint.color), this.alpha(paint.color), paint.opacity].every((v) => Number.isFinite(Math.fround(v))) &&
        [n.rect, mask.rect, dst.rect, ...(clip ? [clip.rect] : [])].every((r) => Object.values(r).every((v) => Number.isInteger(v) && Math.abs(v) <= 1048576))) {
      // The original paint target is only sampled at integer pixel centers by
      // normal composition. Finite solid color and [0,1] coverage prove every
      // painted neighbor finite, including the zero-weight neighbors. Execute
      // the same round-to-nearest operations and zero canonicalization in one
      // pass, retaining the original paint rectangle as its transparency bound.
      const configure = (u: Float32Array) => {
        this.configurePaint(u, n, paint)
        u.set([n.rect.x, n.rect.y, n.rect.w, n.rect.h], 52)
        u[19] = clip ? 1 : 0
      }
      const region = clip ? intersect(intersect(n.rect, mask.rect), clip.rect) : intersect(n.rect, mask.rect)
      const inplace = this.regionalOver(47, region, dst, clip ? [mask, clip] : [mask], configure)
      if (inplace) return inplace
      const out = this.run(47, dst.rect, clip ? [dst, mask, clip] : [dst, mask], configure)
      this.release(dst)
      return out
    }
    if (!clip && !this.driver.managed && constantColor && paint.blend === 'normal') {
      const alpha = this.alpha(constantColor),
        opacity = Math.fround(paint.opacity)
      const source = [
        ...this.color(constantColor).map((c) => Math.fround(Math.fround(c * alpha) * opacity)),
        Math.fround(alpha * opacity),
      ]
      const out = this.run(35, dst.rect, [dst, mask], (u) => u.set(source, 28))
      this.release(dst)
      return out
    }
    if (
      !clip && !this.driver.managed &&
      paint.figmaGradient &&
      paint.blend === 'normal' &&
      this.sampleIndex !== undefined
    ) {
      const lookup = this.figmaGradientLookup(paint)
      const field = this.figmaGradientField(n, paint, this.sampleIndex)
      const out = this.run(42, dst.rect, [dst, mask, lookup, field], (u) => {
        u[32] = paint.opacity
        u.set([n.rect.x, n.rect.y, n.rect.w, n.rect.h], 52)
      })
      this.release(dst)
      return out
    }
    const source = this.paint(n, paint, mask)
    const out = this.merge(source, dst, paint.blend, 1, clip)
    this.release(source)
    return out
  }
  /** Consumes dst; retains src/mask. Source-over writes only the affected area. */
  private merge(src: Surface, dst: Surface, mode = 'normal', opacity = 1, mask?: Surface) {
    const exactNormalRegion = mode === 'normal' && exactBlendLattice([src.rect,dst.rect,...(mask?[mask.rect]:[])])
    if(this.optimized&&this.driver.managed&&
      (exactNormalRegion || (this.driver.displayMath||import.meta.env.VITE_DESIGN_EXACT_REGIONAL_BLEND==='1'&&
        exactBlendLattice([src.rect,dst.rect,...(mask?[mask.rect]:[])]))&&this.scene.interactionRetained&&!this.scene.coherentSamples)&&
      (this.aliases.get(dst.texture)||1)===1&&src.texture!==dst.texture&&mask?.texture!==dst.texture&&
      import.meta.env.VITE_DESIGN_REGIONAL_BLEND!=='0'){
      // Transient placement can be fractional. Align the affected rectangle
      // to the destination's own pixel lattice, retaining a bilinear halo on
      // both source coverage and the saved destination. Paint order and blend
      // equations are unchanged; untouched destination texels are preserved.
      const affected=intersect({x:src.rect.x-1,y:src.rect.y-1,w:src.rect.w+2,h:src.rect.h+2},dst.rect)
      const x=Math.max(0,Math.floor(affected.x-dst.rect.x)),y=Math.max(0,Math.floor(affected.y-dst.rect.y))
      const w=Math.max(0,Math.min(dst.rect.w,Math.ceil(affected.x+affected.w-dst.rect.x))-x)
      const h=Math.max(0,Math.min(dst.rect.h,Math.ceil(affected.y+affected.h-dst.rect.y))-y)
      if(!w||!h)return dst
      if(w*h*2<dst.rect.w*dst.rect.h){
        const left=Math.max(0,x-1),top=Math.max(0,y-1)
        const save={x:dst.rect.x+left,y:dst.rect.y+top,w:Math.min(dst.rect.w,x+w+2)-left,h:Math.min(dst.rect.h,y+h+2)-top}
        const before=this.copy(dst,save)
        const u=parameters(dst.rect,src.rect,before.rect,mask?.rect)
        const blend=blends.indexOf(mode)
        if(blend<0)throw Error(`未知混合模式 ${mode}`)
        u.set([this.scene.integratedBlur&&mode==='normal'&&opacity<1?29:3,blend,opacity,mask?1:0],16)
        this.driver.pass(dst.texture,u,mask?[src.texture,before.texture,mask.texture]:[src.texture,before.texture],{x,y,w,h})
        this.passPixels+=w*h;this.release(before);return dst
      }
    }
    if (this.scene.integratedBlur && !this.driver.managed && mode === 'normal') {
      let region = intersect(src.rect, dst.rect)
      if (mask) region = intersect(region, mask.rect)
      if (!region.w || !region.h || opacity <= 0) return dst
      const before = this.run(0, region, [dst])
      const u = parameters(dst.rect, src.rect, before.rect, mask?.rect)
      u.set([29, 0, opacity, mask ? 1 : 0], 16)
      this.driver.pass(
        dst.texture,
        u,
        mask ? [src.texture, before.texture, mask.texture] : [src.texture, before.texture],
        rect(region.x - dst.rect.x, region.y - dst.rect.y, region.w, region.h),
      )
      this.passPixels += region.w * region.h
      this.release(before)
      return dst
    }
    if (this.scene.integratedBlur && mode === 'normal' && opacity < 1) {
      const result = this.run(29, dst.rect, mask ? [src, dst, mask] : [src, dst], (u) =>
        u.set([29, 0, opacity, mask ? 1 : 0], 16),
      )
      this.release(dst)
      return result
    }
    if (!this.optimized || this.driver.managed || mode !== 'normal') {
      const result = this.compose(src, dst, mode, opacity, mask)
      this.release(dst)
      return result
    }
    let region = intersect(src.rect, dst.rect)
    if (mask) region = intersect(region, mask.rect)
    if (!region.w || !region.h || opacity <= 0) return dst
    const u = parameters(dst.rect, src.rect, dst.rect, mask?.rect)
    u.set([15, 0, opacity, mask ? 1 : 0], 16)
    this.driver.over(
      dst.texture,
      u,
      mask ? [src.texture, src.texture, mask.texture] : [src.texture],
      rect(region.x - dst.rect.x, region.y - dst.rect.y, region.w, region.h),
    )
    this.passPixels += region.w * region.h
    return dst
  }
  private transform(u: Float32Array, n: GpuNode) {
    u.set(n.inverse.slice(0, 4), 20)
    u.set([n.inverse[4], n.inverse[5], ...n.size], 24)
    u.set(n.matrix.slice(0, 4), 180)
  }
  private staticImageSourceDescriptor(uri: string, level: number, intoAtlas: boolean, adjust?: ImageAdjust) {
    if (import.meta.env.VITE_DESIGN_STATIC_IMAGE_BLUR_CACHE !== '1' || level !== 0 || intoAtlas ||
      this.driver.name !== 'webgpu' || !this.driver.managed || this.driver.displayMath) return
    const policy = exactFilterKey([adjust, this.scene.colorManagement, this.scene.floatCompositing,
      this.driver.name, this.driver.linearLight, this.driver.hdr])
    return policy ? { uri, policy } : undefined
  }
  private uploadImage(uri: string, level: number, intoAtlas: boolean, adjust?: ImageAdjust): Surface {
    if (uri.length > 12 * 1024 * 1024 || !/^data:image\/(png|jpeg|webp);base64,/.test(uri))
      throw new Error('无效的 GPU 图片资源')
    // Image adjustments (image-adjust math, ported in image-adjust.ts) run on the
    // decoded texels at upload time: premultiplied storage in and out, so no
    // shader/uniform contract changes. Copies are out-of-place because the
    // loader's arrays may be shared with the worker's persistent image cache.
    const managed = this.scene.floatCompositing || this.scene.colorManagement
    const bake = (bytes: Uint8Array) =>
      imageAdjustActive(adjust) ? adjustRgba8Premultiplied(bytes, adjust) : bytes
    const bakeFloats = (values: Float32Array) =>
      imageAdjustActive(adjust) ? adjustLinearPremultiplied(values, adjust) : values
    if (managed) {
      if (!this.managedImageLoader || !this.driver.uploadLinear)
        throw new Error('后端缺少受管理的浮点图片解码器')
      const image = this.managedImageLoader(uri, false, level)
      // Images share the one surface ledger; pressure evicts older images
      // first instead of failing the frame.
      if (this.overBudget(image.width * image.height * 16, image.width, image.height)) throw this.budgetError('GPU 浮点图片内存预算超限')
      if (intoAtlas && image.width <= ATLAS_MAX_IMAGE && image.height <= ATLAS_MAX_IMAGE)
        return this.writeAtlasSlot(uri, level, image.width, image.height, { floats: bakeFloats(image.pixels) }, adjust)
      const texture = this.driver.uploadLinear(bakeFloats(image.pixels), image.width, image.height)
      const descriptor = this.staticImageSourceDescriptor(uri, level, intoAtlas, adjust), proof = this.driver.imageTableRange?.(texture)
      if (descriptor && proof) this.staticImageBlurs.registerUpload(texture, proof, descriptor.uri, descriptor.policy)
      this.bytes += texture.bytes
      this.peak = Math.max(this.peak, this.bytes)
      this.used.add(texture)
      this.touch(texture)
      return { texture, rect: rect(0, 0, image.width, image.height) }
    }
    if (!this.managedImageLoader || !this.driver.uploadRgba8)
      throw new Error('后端缺少统一的图片解码器')
    // Source assets share Rust's ICC/orientation/premultiplication boundary.
    // The GPU still samples and composites every scene pixel itself.
    const image = this.managedImageLoader(uri, true, level)
    if (!image.bytes || image.bytes.length !== image.width * image.height * 4)
      throw new Error('无效的预乘 RGBA8 图片资源')

    // Do not silently substitute a coarser source when this admission fails.
    // The caller must retain the error/retry contract rather than cache lower
    // fidelity pixels as a successfully rendered native-density tile.
    if (level === 0 && image.width * image.height > 16_777_216)
      throw new Error('GPU 图片像素预算超限')
    if (this.overBudget(image.bytes.length, image.width, image.height)) throw this.budgetError('GPU 图片总内存预算超限')
    if (intoAtlas && image.width <= ATLAS_MAX_IMAGE && image.height <= ATLAS_MAX_IMAGE)
      return this.writeAtlasSlot(uri, level, image.width, image.height, { bytes: bake(image.bytes) }, adjust)
    const texture = this.driver.uploadRgba8(bake(image.bytes), image.width, image.height)
    this.bytes += texture.bytes
    this.peak = Math.max(this.peak, this.bytes)
    this.used.add(texture)
    this.touch(texture)
    return { texture, rect: rect(0, 0, image.width, image.height) }
  }
  private imageKey(uri: string, level: number, intoAtlas: boolean, adjust?: ImageAdjust): string {
    // The tag sits after `#level` so the loader's `startsWith(`${uri}#`)`
    // eviction still matches every variant of one asset together.
    const tag = imageAdjustActive(adjust) ? `~${imageAdjustTag(adjust)}` : ''
    if (intoAtlas) return `${uri}#${level}@a${tag}`
    return level === 0 && !tag ? uri : `${uri}#${level}${tag}`
  }
  /** Shelf-pack one decoded image into an atlas page. Slots carry a zero
   * border, so neighbour fetches at slot edges read exactly what a standalone
   * texture's out-of-bounds fetch would: zero. */
  private writeAtlasSlot(
    uri: string,
    level: number,
    width: number,
    height: number,
    payload: { bytes?: Uint8Array; floats?: Float32Array },
    adjust?: ImageAdjust,
  ): Surface {
    if (payload.floats) {
      if (!this.driver.uploadAtlasLinear) throw new Error('后端不支持浮点图集写入')
    } else if (!this.driver.uploadAtlasRgba8) throw new Error('后端不支持字节图集写入')
    const slotW = width + ATLAS_PAD * 2,
      slotH = height + ATLAS_PAD * 2
    const fits = (page: AtlasPage) =>
      (page.x + slotW <= ATLAS_SIDE && page.y + Math.max(page.rowHeight, slotH) <= ATLAS_SIDE) ||
      (slotW <= ATLAS_SIDE && page.y + page.rowHeight + slotH <= ATLAS_SIDE)
    let page = [...this.atlasPages].reverse().find(fits)
    let fresh = false
    if (!page) {
      const texture = this.driver.create(ATLAS_SIDE, ATLAS_SIDE)
      if (this.overBudget(texture.bytes, texture.width, texture.height)) {
        this.driver.destroy(texture)
        throw this.budgetError('GPU 图集页内存预算超限')
      }
      this.bytes += texture.bytes
      this.peak = Math.max(this.peak, this.bytes)
      page = { texture, x: 0, y: 0, rowHeight: 0, entries: new Map() }
      this.atlasPages.push(page)
      fresh = true
    }
    if (!fresh && page.x + slotW > ATLAS_SIDE) {
      page.y += page.rowHeight
      page.x = 0
      page.rowHeight = 0
    }
    const x = page.x + ATLAS_PAD,
      y = page.y + ATLAS_PAD
    page.x += slotW
    page.rowHeight = Math.max(page.rowHeight, slotH)
    if (payload.floats)
      this.driver.uploadAtlasLinear!(page.texture, x, y, width, height, payload.floats)
    else this.driver.uploadAtlasRgba8!(page.texture, x, y, width, height, payload.bytes!)
    const key = this.imageKey(uri, level, true, adjust)
    page.entries.set(key, uri)
    this.imageOrigins.set(key, [x, y])
    this.used.add(page.texture)
    this.touch(page.texture)
    // The uniform image rect doubles as the byte path's fetch bounds, so an
    // atlas entry must claim the whole page: grid coordinates are slot-space
    // and never leave the slot (plus its zero pad), while a dim-sized rect
    // would classify every slot coordinate as out of bounds.
    return { texture: page.texture, rect: rect(0, 0, ATLAS_SIDE, ATLAS_SIDE) }
  }
  private destroyAtlasPage(page: AtlasPage) {
    for (const key of page.entries.keys()) {
      const surface = this.images.get(key)
      if (surface) this.images.delete(key)
      this.imageOrigins.delete(key)
      this.lastUsed.delete(page.texture)
    }
    this.used.delete(page.texture)
    this.lastUsed.delete(page.texture)
    this.driver.destroy(page.texture)
    this.bytes -= page.texture.bytes
    this.atlasPages = this.atlasPages.filter((p) => p !== page)
  }
  /** Base asset dimensions, cached from the shared deterministic decoder.
   * Level selection and grid compilation need the base extent, and the wasm
   * side caches the decode, so this never decodes twice. */
  private baseDims(uri: string): [number, number] {
    let dims = this.imageDims.get(uri)
    if (!dims) {
      if (!this.managedImageLoader) throw new Error('后端缺少统一的图片解码器')
      const info = this.managedImageLoader(uri, !(this.scene.floatCompositing || this.scene.colorManagement), 0)
      dims = [info.width, info.height]
      this.imageDims.set(uri, dims)
    }
    return dims
  }
  /** Pure geometric level selection, mirroring the kernel sampler: the max
   * axis texel stride of the device→texel mapping, floor(log2), clamped to
   * the chain. Level 0 whenever mips are disabled (bit-identical to the
   * historical single-tap path). Node and paint transforms determine texel
   * demand; the page's zoom percentage alone cannot choose a correct level.
   */
  private imageLevel(n: GpuNode, p: GpuPaint): number {
    if (!this.imageMips || !p.image) return 0

    const dims = this.baseDims(p.image)
    const paintJson = JSON.stringify({ kind: 'image', color: p.color, fit: p.fit, transform: p.transform, tile: p.tile })

    // Call Rust to compute geometric mip level based on screen-space size
    const raw = image_mip_level(
      JSON.stringify((n.previewSource || n).rect),
      new Float64Array((n.previewSource || n).matrix),
      new Float64Array(n.size),
      new Uint32Array(dims),
      paintJson,
    )
    return Math.min(raw, mipLevelsFor(dims) - 1)
  }
  /** Images evicted under budget pressure reload on demand through the same
   * deterministic decoder; a reload reproduces identical sampled bytes.
   * Standalone keys are `uri` (level 0) or `uri#level`; adjusted uploads add
   * `~tag` (slider values); atlas slots are `uri#level[@a][~tag]` and evict
   * as whole pages (the shared texture is the unit that can be destroyed
   * safely). */
  private imageFor(uri: string, level = 0, intoAtlas = false, adjust?: ImageAdjust): Surface {
    if (!uri) throw new Error('缺少图片资源')
    const key = this.imageKey(uri, level, intoAtlas, adjust)
    let surface = this.images.get(key)
    if (!surface) {
      surface = this.uploadImage(uri, level, intoAtlas, adjust)
      this.images.set(key, surface)
    }
    // Stamp the use: this frame's commands pin the image against synchronous
    // eviction until a completed checkpoint proves them finished.
    this.used.add(surface.texture)
    this.touch(surface.texture)
    return surface
  }
  private async loadImages(scene: GpuScene) {
    const needed = sceneIndex(scene).images

    const pageTextures = new Set(this.atlasPages.map(page => page.texture))
    for (const [key, surface] of this.images) {
      // An atlas page has one physical lifetime and ledger entry, even when
      // some of its image slots are no longer needed by this scene.
      if (pageTextures.has(surface.texture)) continue
      if ([...needed].some(uri => isLevelKey(key, uri))) continue
      this.staticImageBlurs.retireSource(surface.texture)
      // A canceled prior frame can still own GPU reads. Such an optional
      // source leaves on a later completed frame, never before those reads.
      if (this.staticImageBlurs.pinsSource(surface.texture)) continue
      this.images.delete(key)
      this.used.delete(surface.texture)
      this.lastUsed.delete(surface.texture)
      this.driver.destroy(surface.texture)
      this.bytes -= surface.texture.bytes
    }
    // generation counts resource touches, not frames. Retain current assets
    // across arbitrary graph work; existing pressure-driven LRU eviction owns
    // reclamation of their old mip/adjustment variants.
    // Atlas pages retire only when none of their slots' assets remain needed.
    for (const page of [...this.atlasPages]) {
      if ([...page.entries.values()].some((uri) => needed.has(uri))) continue
      this.destroyAtlasPage(page)
    }
    for (const uri of this.imageDims.keys())
      if (!needed.has(uri)) this.imageDims.delete(uri)
    // Validate every referenced source eagerly (same failure point as before),
    // but upload lazily at first sampling: an eagerly uploaded but not yet
    // sampled image would pin its bytes against eviction for the whole frame,
    // defeating the shared-budget working set this ledger provides.
    for (const uri of needed) {
      if ([...this.images.keys()].some((key) => isLevelKey(key, uri))) continue
      if (uri.length > 12 * 1024 * 1024 || !/^data:image\/(png|jpeg|webp);base64,/.test(uri))
        throw new Error('无效的 GPU 图片资源')
      if ((scene.floatCompositing || scene.colorManagement) &&
        (!this.managedImageLoader || !this.driver.uploadLinear))
        throw new Error('后端缺少受管理的浮点图片解码器')
      if (!(scene.floatCompositing || scene.colorManagement) &&
        (!this.managedImageLoader || !this.driver.uploadRgba8))
        throw new Error('后端缺少统一的图片解码器')
    }
  }
  private imageGrid(n: GpuNode, p: GpuPaint, image: Surface, level = 0, origin: [number, number] = [0, 0]): Surface {
    const sample = this.sampleIndex ?? 4
    let grids = this.imageGrids.get(p)
    const known = grids?.get(sample)
    if (known) {
      this.touch(known.texture)
      return known
    }
    if (!this.driver.uploadParameters) throw new Error('后端不支持精确图片坐标字段')
    // The grid compiles against the BASE dimensions plus level and page
    // origin so the coordinates land in the (atlas) level surface's texel space.
    const baseDims = p.image ? this.baseDims(p.image) : [image.rect.w, image.rect.h] as [number, number]
    const paintJson = JSON.stringify({ kind: 'image', color: p.color, fit: p.fit, transform: p.transform, tile: p.tile })
    const arguments_: Parameters<typeof image_sampling_grid_placed> = [JSON.stringify((n.previewSource || n).rect), new Float64Array((n.previewSource || n).matrix),
      new Float64Array(n.size), new Uint32Array(baseDims), paintJson, sample, level, new Int32Array(origin)]
    // Separable axes carry the same binary64-derived cells/fractions as the
    // dense field. Preserve the original GPU budget check before a dense
    // fallback allocates its (bounded) CPU coordinate array.
    const compact = this.driver.managed && this.driver.name === 'webgpu' && this.scene.compactImageFields !== false && import.meta.env.VITE_DESIGN_IMAGE_AXES !== '0'
    const scope = compact && import.meta.env.VITE_DESIGN_STREAM_IMAGE_FIELDS !== '0' ? this.filterImageFields : undefined
    if (scope && containsRect(scope.rect, n.rect) && exactBlendLattice([scope.rect, n.rect])) {
      const key = JSON.stringify([(n.previewSource || n).matrix, n.size, baseDims, paintJson, sample, level, origin],
        (_key, value) => Object.is(value, -0) ? '-0' : value)
      let field = scope.fields.get(key)
      if (field === undefined) {
        const inputs = ['image-axes-support', scope.rect, key]
        const retain = this.optimized && import.meta.env.VITE_DESIGN_RETAIN_PARAMETER_FIELDS !== '0'
        const cached = retain ? this.materialFields.get(JSON.stringify(inputs,
          (_key, value) => Object.is(value, -0) ? '-0' : value), new Uint32Array()) : undefined
        field = null
        if (cached) {
          this.fieldHits++
          this.busy.add(cached); this.used.add(cached)
          field = {texture: cached, rect: scope.rect}
        } else {
          // Whole-support admission is optional. A larger proof may fail the
          // composed-transform precision/size guard even when a strip is valid.
          // Let the unchanged strip path report genuinely invalid input.
          const started = performance.now()
          let values: Float32Array = new Float32Array()
          try {
            values = image_sampling_axes_placed(JSON.stringify(scope.rect), ...arguments_.slice(1) as
              [Float64Array, Float64Array, Uint32Array, string, number, number, Int32Array])
          } catch { /* bounded strip proof below remains authoritative */ }
          this.fieldBuildMs += performance.now() - started
          if (values.length && this.workingBytes + values.byteLength <= this.frameBudget) {
            field = this.materialField(inputs, scope.rect, () => {
              this.imageFieldBytes += values.byteLength
              return values
            }, this.driver.uploadParameters, () => [Math.max(scope.rect.w, scope.rect.h), 2], values.byteLength, retain)
          }
        }
        if (field) {
          this.imageAxes.set(field.texture, true)
          // Cache admission can fail at its byte/count ceiling. Such a
          // transient must survive checkpoints until the filter's last read.
          scope.pinned.add(field.texture)
        }
        scope.fields.set(key, field)
      }
      if (field) {
        this.touch(field.texture)
        this.imageAxisFields++
        return field
      }
    }
    let separated: boolean | undefined
    const surface = this.materialField(['image-grid',this.driver.managed,compact,[n.rect.w,n.rect.h],(n.previewSource || n).rect,
      (n.previewSource || n).matrix,n.size,baseDims,paintJson,sample,level,origin], n.rect, () => {
      let values = compact ? image_sampling_axes_placed(...arguments_) : new Float32Array()
      if (!values.length) {
        if (this.driver.managed && this.overBudget(n.rect.w * n.rect.h * 16, n.rect.w, n.rect.h)) throw this.budgetError('GPU 表面内存预算超限')
        values = this.driver.managed ? image_sampling_grid_placed(...arguments_) : image_byte_sampling_field_placed(...arguments_)
      }
      separated = this.driver.managed ? values[3] === -1 : values[3] === 1
      this.imageFieldBytes += values.byteLength
      return values
    }, this.driver.uploadParameters, () => [separated ? Math.max(n.rect.w,n.rect.h) : n.rect.w, separated ? 2 : n.rect.h], 0,
      import.meta.env.VITE_DESIGN_RETAIN_PARAMETER_FIELDS !== '0')
    if (separated !== undefined) this.imageAxes.set(surface.texture,separated)
    if (this.driver.managed && this.imageAxes.get(surface.texture)) this.imageAxisFields++
    if (!grids) {
      grids = new Map()
      this.imageGrids.set(p, grids)
    }
    grids.set(sample, surface)
    return surface
  }
  private gradientGrid(n: GpuNode, p: GpuPaint): Surface {
    const sample = this.sampleIndex ?? 4
    let grids = this.imageGrids.get(p)
    const known = grids?.get(sample)
    if (known) {
      this.touch(known.texture)
      return known
    }
    if (!this.driver.uploadLinear) throw new Error('后端不支持精确渐变参数字段')
    const parameters = {
      kind: p.kind,
      color: '#000000',
      angle: p.angle,
      transform: p.transform,
      stops: p.stops.map((s) => ({ offset: s.offset, color: '#000000' })),
    }
    const source=n.previewSource||n
    const surface=this.materialField(['gradient-grid',[n.rect.w,n.rect.h],source.rect,source.matrix,n.size,parameters,sample],n.rect,
      ()=>gradient_sampling_grid(JSON.stringify(source.rect),new Float64Array(source.matrix),new Float64Array(n.size),JSON.stringify(parameters),sample),
      this.driver.uploadLinear,undefined,n.rect.w*n.rect.h*16,import.meta.env.VITE_DESIGN_RETAIN_PARAMETER_FIELDS !== '0')
    if (!grids) {
      grids = new Map()
      this.imageGrids.set(p, grids)
    }
    grids.set(sample, surface)
    return surface
  }
  private figmaGradientLookup(paint: GpuPaint): Surface {
    const known = this.gradientLookups.get(paint)
    if (known) {
      this.touch(known.texture)
      return known
    }
    if (!this.driver.uploadRgba8) throw new Error('后端不支持渐变查找表')
    const surface=this.materialField(['gradient-lookup',paint],rect(0,0,1024,2),()=>figma_gradient_lookup(JSON.stringify(paint)),
      this.driver.uploadRgba8,undefined,1024*2*4,import.meta.env.VITE_DESIGN_RETAIN_PARAMETER_FIELDS !== '0')
    this.gradientLookups.set(paint, surface)
    return surface
  }
  private figmaGradientField(n: GpuNode, paint: GpuPaint, sample: number): Surface {
    if (!this.driver.uploadParameters) throw new Error('后端不支持渐变数学参数字段')
    const source=n.previewSource||n
    return this.materialField(['figma-gradient-field',[n.rect.w,n.rect.h],source.rect,source.matrix,n.size,paint,sample,!!this.scene.softwareRaster],n.rect,
      ()=>figma_gradient_field(JSON.stringify(source.rect),new Float64Array(source.matrix),new Float64Array(n.size),JSON.stringify(paint),sample,!!this.scene.softwareRaster),
      this.driver.uploadParameters,undefined,n.rect.w*n.rect.h*16,import.meta.env.VITE_DESIGN_RETAIN_PARAMETER_FIELDS !== '0')
  }

  private paint(n: GpuNode, p: GpuPaint, mask: Surface, material?: Surface): Surface {
    let image: Surface | undefined
    let imageLevel = 0
    let imageOrigin: [number, number] = [0, 0]
    if (p.kind === 'image') {
      const uri = p.image || ''
      // Atlas slots exist only where the address field drives sampling; the
      // inline-coordinate branches keep standalone textures.
      const gridPath =
        this.driver.managed || (this.scene.coherentSamples && this.sampleIndex !== undefined)
      const intoAtlas = this.imageAtlas && gridPath
      // Source fidelity and grid coordinates use the same geometric level.
      // Memory pressure must never silently substitute a coarser image.
      imageLevel = this.imageLevel(n, p)
      image = material || this.imageFor(uri, imageLevel, intoAtlas, p.adjust)
      if (intoAtlas)
        imageOrigin = this.imageOrigins.get(this.imageKey(uri, imageLevel, true, p.adjust)) ?? [0, 0]
    }
    const inputs = image
      ? this.driver.managed || (this.scene.coherentSamples && this.sampleIndex !== undefined)
        ? [mask, image, mask, this.imageGrid(n, p, image, imageLevel, imageOrigin)]
        : [mask, image]
      : this.driver.managed &&
          ['linear', 'radial', 'angular', 'diamond'].includes(p.kind)
        ? [mask, mask, mask, this.gradientGrid(n, p)]
        : [mask]
    return this.run(2, n.rect, inputs, (u) => {
      this.configurePaint(u, n, p)
      if (p.kind === 'image' && inputs[3])
        u.set([inputs[3].rect.x, inputs[3].rect.y], 204)
    })
  }
  private configurePaint(u: Float32Array, n: GpuNode, p: GpuPaint) {
    this.transform(u, n)
    if (p.transform) {
      u.set(inverse(p.transform), 244)
      u[250] = 1
    }
    const offset =
      this.sampleIndex === undefined
        ? [0, 0]
        : [
            [-0.125, -0.375],
            [0.375, -0.125],
            [-0.375, 0.125],
            [0.125, 0.375],
          ][this.sampleIndex]
    u.set(offset, 184)
    const kind = ['solid', 'linear', 'radial', 'image', 'angular', 'diamond'].indexOf(p.kind)
    if (kind < 0) throw new Error('不支持的填充类型')
    u.set([kind, ...this.color(p.color)], 28)
    u[241] = this.alpha(p.color)
    u[186] =
      kind === 0 &&
      this.alpha(p.color) === 1 &&
      !this.driver.managed &&
      this.scene.coherentSamples &&
      this.sampleIndex !== undefined
        ? 1
        : 0
    u[187] =
      !this.driver.managed && this.scene.coherentSamples && this.sampleIndex !== undefined ? 1 : 0
    if (u[186]) u.set(solidRgba8(this.color(p.color), p.opacity), 192)
    const stops = [...p.stops].sort((a, b) => a.offset - b.offset)
    if (stops.length > 32) throw new Error('渐变色标超过 32 个')
    u.set(
      [
        p.opacity,
        (p.angle * Math.PI) / 180,
        ['cover', 'contain', 'stretch'].indexOf(p.fit),
        stops.length,
      ],
      32,
    )
    const angle = (p.angle * Math.PI) / 180,
      c = Math.cos(angle),
      s = Math.sin(angle)
    u.set([c, s, Math.abs(c) + Math.abs(s), 0], 196)
    if (p.gradientPlane) {
      u.set([...p.gradientPlane, 1], 200)
      u.set([n.rect.x, n.rect.y, 0, 0], 204)
    }
    stops.forEach((s, i) => {
      u.set([s.offset, ...this.color(s.color)], (13 + i) * 4)
      u[208 + i] = this.alpha(s.color)
    })
    if (p.fixedGradient) {
      p.fixedGradient.words.forEach((word, i) => u.set(word, 196 + i * 4))
      u[252] = p.fixedGradient.bits
      u[253] = u[254] = 0
    }
  }
  private direct(n: GpuNode | undefined) {
    if (
      !n ||
      !this.optimized ||
      this.driver.managed ||
      n.children.length ||
      n.effects.length ||
      n.blend !== 'normal'
    )
      return undefined
    // In the byte-quantized profile layer opacity follows layer materialization.
    // Combining it with fractional coverage skips that required rounding stage.
    if (this.scene.integratedBlur && n.opacity !== 1) return undefined
    if (!n.strokes.length && n.fills.length === 1 && n.fills[0].blend === 'normal')
      return { path: n.fill, paint: n.fills[0] }
    // A single centered stroke is already a union coverage mesh. Like a single
    // fill, it can paint directly into the target with opacity applied once.
    // Alignment masks, multiple paints, effects and blend modes retain isolation.
    const s = n.strokes[0]
    if (
      !n.fills.length &&
      n.strokes.length === 1 &&
      s.align === 'center' &&
      s.paint.blend === 'normal'
    )
      return { path: s.path, paint: s.paint }
    return undefined
  }
  private async drawList(ids: string[], target: Surface, clip?: Surface, skip?: string): Promise<Surface> {
    const children = skip ? ids.filter((id) => id !== skip) : ids
    for (let i = 0; i < children.length; ) {
      let end = i
      // Coverage is independent of paint and backdrop. Prepare a consecutive
      // leaf run first so one target render pass can preserve every paint order.
      // Stop at effects, groups or non-normal blends; their dependency order stays intact.
      while (end < children.length && this.direct(this.scene.nodes[children[end]])) {
        const pause = this.yieldEncoding()
        if (pause) await pause
        const n = this.scene.nodes[children[end]]
        let region = intersect(n.rect, target.rect)
        if (clip) region = intersect(region, clip.rect)
        if (region.w && region.h && n.opacity > 0) this.mask(this.direct(n)!.path)
        end++
      }
      if (end === i) end++
      while (i < end) {
        const pause = this.yieldEncoding()
        if (pause) await pause
        const id = children[i++], previous = this.activeNode
        this.activeNode = id
        try {
          const upcoming = this.scene.nodes[id]
          if (upcoming && this.driver.managed && this.scene.interactionRetained && !this.interactionRoots.has(upcoming.previewSource||upcoming))
            await this.reclaimForSurface(upcoming.rect,backdropEffect(upcoming.effects)?3:2)
          target = await this.drawNode(id, target, clip)
          const node = this.scene.nodes[id]
          // Single-sample interaction used to keep every mask alive until
          // frame end. Match the four-plane path's ordered retirement after
          // all reads of this node, retaining ancestor/shared clip ownership.
          if (node && this.driver.managed && import.meta.env.VITE_DESIGN_RETIRE_NODE_MASKS !== '0') {
            this.retireLeafMasks(node, undefined, clip ? [clip] : undefined, [target], true)
            await this.reclaimScratch()
          }
        } finally { this.activeNode = previous }
      }
    }
    return target
  }
  private async drawNode(id: string, target: Surface, clip?: Surface): Promise<Surface> {
    const n = this.scene.nodes[id]
    if (!n || n.opacity <= 0) return target

    // The kernel already culls dependency-aware bounds in global raster
    // coordinates, including tile origins and filter halos. Do not compare
    // n.rect to a world-space or origin-zero viewport here.

    if(this.optimized&&(this.driver.displayMath||import.meta.env.VITE_DESIGN_EXACT_NEUTRAL==='1'&&
       exactBlendLattice([n.rect,target.rect,...n.children.map(id=>this.scene.nodes[id]?.rect).filter((r):r is Rect=>!!r)]))&&!this.scene.coherentSamples&&
       (!this.scene.interactionRetained||this.nativeChanging.has(id))&&
       import.meta.env.VITE_DESIGN_NEUTRAL_REGIONS!=='0'&&disjointNeutralGroup(this.scene,n,clip))
      // Its own clip remains at the original child-paint stage. Only the
      // ancestor clip proved to be one throughout this group is redundant.
      return this.drawList(n.children,target,n.clip?this.mask(n.fill):clip)
    // A neutral normal group is associative source-over when its immediate
    // children have independent sources. Preserve every backdrop, pass-through,
    // mask and clipping boundary. During transient capture this avoids a full
    // extra surface for each nested empty group; existing useful caches win.
    const key=n.previewSource||n,needed=n.rect.w*n.rect.h*16
    if(this.optimized&&this.driver.displayMath&&!this.scene.coherentSamples&&!clip&&n.opacity===1&&n.blend==='normal'&&
        !n.passthrough&&!n.mask&&!n.maskId&&!n.clip&&!n.fills.length&&!n.strokes.length&&!n.effects.length&&n.children.length&&
        n.children.every(id=>{const child=this.scene.nodes[id];return !child||!child.mask&&!child.passthrough&&child.blend==='normal'&&!backdropEffect(child.effects)})&&
        (!this.scene.interactionRetained||this.interactionCapturing||!this.interactionRoots.has(key)&&this.interactionBytes+needed>this.interactionBudget))
      return this.drawList(n.children,target)
    const direct = this.direct(n)
    if(this.optimized&&this.driver.managed&&n.opacity===1&&n.blend==='normal'&&!n.passthrough&&
      !n.maskId&&!n.children.length&&!n.effects.length&&!n.strokes.length&&n.fills.length===1&&
      n.fills[0].visible&&n.fills[0].blend==='normal'&&(!this.scene.interactionRetained||n.rect.w*n.rect.h<262144||this.nativeChanging.has(id))){
      // The single-sample route has the same transparent-source identity as
      // drawBundle. Reuse its paint-over implementation rather than creating
      // an empty leaf, painting it, then blending the leaf twice.
      return this.paintOver(n,n.fills[0],this.nodeMask(n),target,clip)
    }
    if (direct) {
      const p = direct.paint
      let region = intersect(n.rect, target.rect)
      if (clip) region = intersect(region, clip.rect)
      if (!region.w || !region.h || n.opacity <= 0) return target
      const mask = this.mask(direct.path),
        image =
          p.kind === 'image'
            ? this.imageFor(p.image || '', this.imageLevel(n, p), false, p.adjust)
            : undefined
      const u = parameters(target.rect, mask.rect, image?.rect, clip?.rect)
      this.configurePaint(u, n, p)
      u.set([16, 0, n.opacity, clip ? 1 : 0], 16)
      const inputs = [mask.texture, (image || mask).texture]
      if (clip) inputs.push(clip.texture)
      this.driver.over(
        target.texture,
        u,
        inputs,
        rect(region.x - target.rect.x, region.y - target.rect.y, region.w, region.h),
      )
      this.passPixels += region.w * region.h
      return target
    }
    const source = await this.nodeSource(id, target)
    if (!source) return target
    // Child capture can consume the remaining headroom after the node's
    // admission check. Reclaim completed scratch before allocating its final
    // blend target, while both live inputs remain pinned.
    if(this.driver.managed&&this.scene.interactionRetained)
      await this.reclaimForSurface(target.rect)
    const next = n.passthrough
      ? this.interpolate(source, target, n.opacity, clip)
      : this.merge(source, target, n.blend, n.opacity, clip)
    if (n.passthrough) this.release(target)
    this.release(source)
    return next
  }
  private async nodeSource(id: string, backdrop: Surface): Promise<Surface | undefined> {
    const n = this.scene.nodes[id]
    if (!n) return
    if (n.opacity <= 0) return this.empty(n.rect)
    // An externally blurred root must resample its backdrop, but its isolated
    // child groups need not repaint hundreds of paths. Cache raw child sources
    // before parent opacity/blend/clip, preserving those live dependencies.
    const cacheable = !n.previewDynamic && !this.nativeChanging.has(id) && this.scene.interactionRetained && this.optimized && this.driver.managed &&
      !this.scene.coherentSamples && !this.interactionCapturing && !sceneIndex(this.scene).roots.has(id) &&
      (n.children.length > 1 || n.fills.some(paint=>paint.kind==='image') ||
        n.effects.some(effect=>effect.visible) || n.rect.w*n.rect.h>=262144&&n.fills.length>0) &&
      classifyCompiledSourceReuse(n, sceneIndex(this.scene).unknownEffectSubtrees.has(id)).reusable
    if (!cacheable) return this.node(id, backdrop)
    const key = n.previewSource || n, cached = this.interactionRoots.get(key)
    if (cached?.source && cached.anchor.w === n.rect.w && cached.anchor.h === n.rect.h) {
      const source = cached.planes[0], dx = n.rect.x - cached.anchor.x, dy = n.rect.y - cached.anchor.y
      this.used.add(source.texture); this.interactionHits++
      return this.retain({ ...source, rect: { ...source.rect, x: source.rect.x + dx, y: source.rect.y + dy } })
    }
    if (cached) this.retireInteractionRoots(new Set([...this.interactionRoots.keys()].filter(source => source !== key)))
    const needed = n.rect.w * n.rect.h * 16
    if (this.interactionBytes + needed > this.interactionBudget || this.interactionRoots.size >= 128 || this.overBudget(needed * 2))
      return this.node(id, backdrop)
    this.interactionCapturing = true
    let source: Surface | undefined
    try { source = await this.node(id, backdrop) }
    finally { this.interactionCapturing = false }
    if (source) {
      const saved = this.copyInteractionSource(source)
      this.interactionRoots.set(key, { anchor: { ...n.rect }, planes: [saved], source: true })
      this.interactionTextures.add(saved.texture); this.interactionBytes += saved.texture.bytes
    }
    return source
  }
  private copyInteractionSource(source:Surface) {
    const previous=this.interactionCapturing
    this.interactionCapturing=true
    try{return this.copy(source)}finally{this.interactionCapturing=previous}
  }
  private shadow(source: Surface, blurredAlpha: Surface, n: GpuNode, fx: Effect, composite = false) {
    return this.run(composite ? 50 : 6, n.rect, [source, blurredAlpha], (u) => {
      u.set([0, ...this.color(fx.color)], 28)
      u[32] = fx.opacity * this.alpha(fx.color)
      u.set(
        [
          this.scene.integratedBlur ? 1 : 0,
          n.matrix[0] * fx.x + n.matrix[2] * fx.y,
          n.matrix[1] * fx.x + n.matrix[3] * fx.y,
          fx.kind === 'inner-shadow' ? 1 : 0,
        ],
        36,
      )
    })
  }
  /** Queue a dead parameter upload for destruction at the next completed
   * checkpoint. Destroying earlier could race queued sampling commands;
   * pooling it would let a later writeTexture overtake pending reads. */
  private retireUpload(texture: Texture) {
    if (this.materialFields.has(texture)) return
    this.coordinateMaps.delete(texture)
    this.retiredUploads.push(texture)
  }
  private forgetUpload(texture: Texture) {
    this.busy.delete(texture)
    this.used.delete(texture)
    this.lastUsed.delete(texture)
    this.driver.destroy(texture)
    this.bytes -= texture.bytes
  }
  /** Destroy one still-cached coordinate upload and detach every alias, so a
   * later cache miss re-uploads identical bytes instead of binding a
   * destroyed texture. Only call after a completed checkpoint. */
  private forgetCoordinateTexture(texture: Texture) {
    this.coordinateMaps.delete(texture)
    for (const [paint, grids] of this.imageGrids) {
      for (const [sample, surface] of grids) if (surface.texture === texture) grids.delete(sample)
      if (!grids.size) this.imageGrids.delete(paint)
    }
    for (const [paint, surface] of this.gradientLookups)
      if (surface.texture === texture) this.gradientLookups.delete(paint)
    for (const [key, surface] of this.textureLookups)
      if (surface.texture === texture) this.textureLookups.delete(key)
    if (this.textureMath?.texture === texture) this.textureMath = undefined
    if (this.replayParameters === texture) this.replayParameters = undefined
    this.forgetUpload(texture)
  }
  private async reclaimForSurface(r:Rect,copies=1) {
    // A free surface is already reusable in queue order. Do not wait for the
    // GPU and destroy it merely to "make room" for the same dimensions.
    const available=this.free.get(`${r.w}:${r.h}`)?.length||0
    const missing=Math.max(0,copies-available)
    if(missing)await this.reclaimScratch(r.w*r.h*16*missing)
  }
  /** Forced image retirement still excludes an exact-table source. Atlas
   * slots share that ownership with their entire page, including empty pages. */
  private hasEvictableImage() {
    const eligible = (texture: Texture) => !this.pendingImageTableSources.has(texture) &&
      !this.sequentialImagePins.has(texture) &&
      !this.driver.hasActiveImageTableSource?.(texture) && !this.staticImageBlurs.pinsSource(texture)
    for (const surface of this.images.values()) if (eligible(surface.texture)) return true
    for (const page of this.atlasPages) if (eligible(page.texture)) return true
    return false
  }
  private async reclaimScratch(required = 0) {
    this.checkFrameCurrent()
    this.staticImageBlurs.collect(this.driver.completedResourceEpoch)
    const pressure = required > 0 && this.workingBytes + required > this.frameBudget
    if (pressure) {
      this.retireDisplayMaterial()
      if (this.nestedPrefix) this.nestedPrefixPressure = true
      this.retireNestedPrefix()
      this.horizontalFilters.clear(); this.staticImageBlurs.discardPending(this.driver.resourceEpoch)
    }
    // The shared worker replaces two former 256 MiB raster owners. Keep the
    // active interaction working set warm below its bounded pressure line.
    if (!pressure && this.driver.captureDisplay && this.scene.interactionRetained &&
      (this.interactionWarm || this.workingBytes < this.frameBudget * .875)) return
    const retiredImageTableBytes = this.driver.retiredImageTableBytes || 0
    const imageTablePressure = pressure && retiredImageTableBytes > 0
    if ((!imageTablePressure && this.bytes < this.frameBudget * .25) || !this.driver.checkpoint) return
    for (const [key, surface] of this.constantTargets) if ((this.aliases.get(surface.texture) || 1) === 1) {
      this.constantTargets.delete(key)
      this.release(surface)
    }
    const pooled: Texture[] = []
    for (const list of this.free.values()) pooled.push(...list)
    const coordinates = [...this.coordinateMaps].filter(texture => !this.filterImageFields?.pinned.has(texture))
    // Dead uploads leave first, then the oldest pool generations and the
    // oldest cached coordinates. One bounded batch per checkpoint cycle keeps
    // each GPU wait short and lets younger reusable entries survive.
    const imagesUnderPressure = this.workingBytes > this.frameBudget * .75 && this.hasEvictableImage()
    const staticCachePressure = pressure && this.staticImageBlurs.bytes > 0
    // A free surface can be reused in this command queue before completion.
    // Keep pooled storage when the requested allocation still fits, instead of
    // fencing to destroy surfaces the next node may reuse. Logically retired
    // tables stay charged and pinned until periodic finish or real pressure.
    // Allocation/image pressure and upload/coordinate retirement retain their
    // real completion fences; this return grants no completion proof.
    if (this.workingBytes <= this.frameBudget && !pressure && !imagesUnderPressure &&
        !this.retiredUploads.length && !coordinates.length) return
    if (!this.retiredUploads.length && !pooled.length && !coordinates.length && !imagesUnderPressure && !staticCachePressure && !imageTablePressure)
      return
    // A large managed source image or ancestor surface can keep the ledger
    // above 64 MiB throughout a frame. Waiting on the GPU for every tiny dead
    // leaf then destroys reusable targets and serializes hundreds of nodes.
    // Reclaim one meaningful batch, or synchronize immediately at the pressure
    // line; the unchanged allocation gate still enforces the 256 MiB ceiling.
    const reclaimableBytes = [...pooled, ...this.retiredUploads, ...coordinates]
      .reduce((sum, texture) => sum + texture.bytes, retiredImageTableBytes)
    if (!pressure && !imagesUnderPressure && reclaimableBytes < RECLAIM_BATCH_BYTES) return
    const batchLimit = pressure ? Math.max(RECLAIM_BATCH_BYTES, this.workingBytes + required - this.frameBudget) : RECLAIM_BATCH_BYTES
    const resourceLimit = pressure ? 4096 : RECLAIM_BATCH_RESOURCES
    // Preserve the exact oldest-first batch. Only a pool-only maintenance
    // batch below image pressure can use prior-frame completion evidence.
    pooled.sort((a, b) => (this.lastUsed.get(a) || 0) - (this.lastUsed.get(b) || 0))
    let completedPoolEpoch: number | undefined
    if (required === 0 && !this.retiredUploads.length && !coordinates.length &&
        this.workingBytes <= this.frameBudget * .75) {
      const completed = this.driver.completedResourceEpoch, current = this.driver.resourceEpoch
      if (Number.isSafeInteger(completed) && Number.isSafeInteger(current)) {
        let bytes = 0, count = 0, newest = 0, proven = pooled.length > 0
        for (const texture of pooled) {
          if (count >= resourceLimit || bytes >= batchLimit) break
          const epoch = this.poolReleaseEpoch.get(texture)
          if (!Number.isSafeInteger(epoch) || epoch! <= 0 || epoch! > completed! || epoch! >= current!) proven = false
          else newest = Math.max(newest, epoch!)
          count++; bytes += texture.bytes
        }
        if (proven) completedPoolEpoch = newest
      }
    }
    const checkpointStart = performance.now()
    // Diagnostic-only snapshot of the decision already made above. The fence
    // record precedes destruction, so these are candidate bytes, not freed bytes.
    const diagnostic: GpuAdmissionDiagnostic | undefined = gpuDiagnosticsEnabled() ? {
      admissionKind: required > 0 ? 1 : 0, admissionPressure: pressure ? 1 : 0,
      admissionRequiredBytes: required, admissionWorkingBytes: this.workingBytes,
      admissionBudgetBytes: this.frameBudget, admissionReclaimableBytes: reclaimableBytes,
      admissionPoolBytes: pooled.reduce((bytes, texture) => bytes + texture.bytes, 0),
      admissionPoolCount: pooled.length,
      admissionUploadCount: this.retiredUploads.length + coordinates.length,
      admissionRetiredKinds: (pooled.length ? 1 : 0) | (this.retiredUploads.length ? 2 : 0) | (coordinates.length ? 4 : 0) | (imagesUnderPressure ? 8 : 0) | (retiredImageTableBytes ? 16 : 0),
      admissionRetiredUploadCount: this.retiredUploads.length,
      admissionCoordinateCount: coordinates.length,
      admissionImageCount: this.images.size,
    } : undefined
    // Submission is still mandatory. Only the completion wait may be omitted,
    // and the driver independently validates the already-completed epoch.
    const checkpointScratch = this.driver.scratchBytes || 0
    try {
      if (completedPoolEpoch === undefined) await this.driver.checkpoint('admission', diagnostic)
      else await this.driver.checkpoint('admission', diagnostic, completedPoolEpoch)
    } finally {
      // A real checkpoint can now collect logically retired image tables.
      // Preserve actual scratch accounting even when a later step rejects.
      this.bytes += (this.driver.scratchBytes || 0) - checkpointScratch
    }
    this.checkpointMs += performance.now() - checkpointStart
    this.staticImageBlurs.collect(this.driver.completedResourceEpoch)
    // Every surface still needed by an ancestor is in busy. Completion is
    // proven for every selected destruction: by this fence, or (pool-only)
    // by the completed prior-frame release stamps checked above.
    let destroyed = 0,
      batchBytes = 0
    while (
      this.retiredUploads.length &&
      destroyed < resourceLimit &&
      batchBytes < batchLimit
    ) {
      const texture = this.retiredUploads.shift()!
      this.forgetUpload(texture)
      destroyed++
      batchBytes += texture.bytes
    }
    // The preselected oldest-first order leaves survivor free-list LIFO intact.
    for (const texture of pooled) {
      if (destroyed >= resourceLimit || batchBytes >= batchLimit) break
      this.destroyFree(texture)
      destroyed++
      batchBytes += texture.bytes
    }
    const uploads = coordinates.sort(
      (a, b) => (this.lastUsed.get(a) || 0) - (this.lastUsed.get(b) || 0),
    )
    for (const texture of uploads) {
      if (destroyed >= resourceLimit || batchBytes >= batchLimit) break
      this.forgetCoordinateTexture(texture)
      destroyed++
      batchBytes += texture.bytes
    }
    // The completed checkpoint proves no command references any image; with
    // the ledger still above the image pressure line, drop the
    // least-recently-used ones so later nodes keep allocation headroom.
    if (this.workingBytes > this.frameBudget * .75)
      this.evictImages(this.workingBytes - this.frameBudget * .75, true)
    if (pressure && this.workingBytes + required > this.frameBudget) {
      this.staticImageBlurs.clear()
      this.staticImageBlurs.collect(this.driver.completedResourceEpoch)
      // This checkpoint completed all prior reads. Prefer ordinary reclaimable
      // storage above; retire optional blur residency only as a last resort.
      for (const list of [...this.free.values()]) for (const texture of [...list]) {
        if (this.workingBytes + required <= this.frameBudget) break
        if ((this.poolReleaseEpoch.get(texture) ?? Infinity) <= (this.driver.completedResourceEpoch ?? -1))
          this.destroyFree(texture)
      }
      if (this.workingBytes + required > this.frameBudget)
        this.evictImages(this.workingBytes + required - this.frameBudget, true)
    }
  }
  private independentSamples(n: GpuNode): boolean {
    const cached = this.independentSampleNodes.get(n.id)
    if (cached !== undefined) return cached
    const independent = !n.passthrough && !n.mask && !n.maskId && !n.clip &&
      !n.effects.some(fx => fx.visible) && n.children.every(id => {
        const child = this.scene.nodes[id]
        return !child || this.independentSamples(child)
      })
    this.independentSampleNodes.set(n.id, independent)
    return independent
  }
  private async drawBundle(
    ids: string[],
    targets: Surface[],
    clip?: Surface[],
    prefix?: { plan: NestedPrefixPlan; policy: string },
  ): Promise<Surface[]> {
    const previousNode = this.activeNode
    const previousCapturing = this.interactionCapturing
    try {
    let begin = 0
    if (prefix) {
      if (this.nestedPrefixMatches(prefix.plan, prefix.policy)) {
        const cached = this.nestedPrefix!
        // Always restore into mutable frame storage. A later source-over can
        // write its destination in place and must never modify saved pixels.
        for (const plane of cached.planes) this.used.add(plane.texture)
        this.release(...targets)
        const restored: Surface[] = []
        try { for (const plane of cached.planes) restored.push(this.copyInteractionSource(plane)) }
        catch (error) { this.release(...restored); throw error }
        targets = restored
        begin = prefix.plan.count
        this.prefixHits++
        recordGpuDiagnostic('cache', { nestedPrefixHits: 1, nestedPrefixBytes: this.nestedPrefixBytes })
      } else this.retireNestedPrefix()
    }
    // A cached background must cover the whole fixed capture, including
    // pixels outside this pose's swept interaction window. Only the moving
    // suffix may use that window's scissor/halo optimization.
    if (prefix && begin === 0) this.interactionCapturing = true
    for (let at = begin; at < ids.length; at++) {
      if (prefix && at === prefix.plan.count) {
        this.interactionCapturing = previousCapturing
        if (!this.nestedPrefix) this.saveNestedPrefix(prefix.plan, prefix.policy, targets)
      }
      const pause = this.yieldEncoding()
      if (pause) await pause
      const id = ids[at]
      this.activeNode = id
      const n = this.scene.nodes[id]
      if (!n || n.opacity <= 0) continue
      const streamed = await this.streamIsolatedFilter(n, targets, clip)
      if (streamed) { targets = streamed; continue }
      if (this.optimized && this.driver.managed && !this.driver.displayMath &&
          n.children.length && this.independentSamples(n)) {
        // No descendant resolves or reads another sample plane. Finish and
        // merge one sample's isolated subtree before allocating the next;
        // retain each node's original blend/opacity and paint order.
        for (let sample = 0; sample < 4; sample++) {
          await this.reclaimScratch()
          this.sampleIndex = sample
          targets[sample] = await this.drawNode(id, targets[sample], clip?.[sample])
          this.retireLeafMasks(n, undefined, clip, targets, true)
        }
        continue
      }
      if (this.replayTexture(n, targets, clip)) continue
      if (this.optimized && this.allowSolidBatch && this.driver.solidBatch && batchableSolid(n)) {
        const start = at
        const run: GpuNode[] = [n]
        while (at + 1 < ids.length && batchableSolid(this.scene.nodes[ids[at + 1]]))
          run.push(this.scene.nodes[ids[++at]])
        if (run.length >= 8) {
          const data = solidInstances(run, targets[0].rect)
          for (let i = 18; i < data.length; i += 20) this.passPixels += data[i] * data[i + 1] * 4
          if (data.length)
            for (let i = 0; i < 4; i++) {
              await this.reclaimScratch()
              const target = targets[i],
                boundary = clip?.[i],
                u = parameters(target.rect, undefined, undefined, boundary?.rect)
              u[19] = boundary ? 1 : 0
              u[37] = i
              this.driver.solidBatch(target.texture, u, data, boundary?.texture)
            }
          continue
        }
        // Small isolated shapes keep their cached masks; avoid re-running a
        // complex curve shader just to save a handful of submissions.
        at = start
      }
      await this.reclaimScratch()
      const solid = n.fills[0]
      if (
        this.optimized &&
        n.opacity === 1 &&
        n.blend === 'normal' &&
        !n.children.length &&
        !n.strokes.length &&
        !n.effects.length &&
        n.fills.length === 1 &&
        solid.visible &&
        !this.driver.managed &&
        solid.opacity === 1 &&
        solid.kind === 'solid' &&
        solid.blend === 'normal'
      ) {
        const leafMasks: Surface[] = []
        // Each retained sample mask is binary. An opaque UNORM8 solid can
        // replace covered samples directly, with no intermediate rounding.
        // Large-scene traces showed three passes per leaf/sample previously.
        for (let i = 0; i < 4; i++) {
          await this.reclaimScratch()
          this.sampleIndex = i
          const target = targets[i],
            mask = this.nodeMask(n),
            boundary = clip?.[i]
          leafMasks.push(mask)
          let region = intersect(mask.rect, target.rect)
          if (boundary) region = intersect(region, boundary.rect)
          if (!region.w || !region.h) continue
          const u = parameters(target.rect, mask.rect, undefined, boundary?.rect)
          this.configurePaint(u, n, solid)
          u.set([16, 0, 1, boundary ? 1 : 0], 16)
          this.driver.over(
            target.texture,
            u,
            boundary ? [mask.texture, mask.texture, boundary.texture] : [mask.texture],
            rect(region.x - target.rect.x, region.y - target.rect.y, region.w, region.h),
          )
          this.passPixels += region.w * region.h
        }
        this.retireLeafMasks(n, undefined, clip, targets)
        continue
      }
      const maskId = n.maskId || n.children.find((id) => this.scene.nodes[id]?.mask)
      const leafBackdrop = backdropEffect(n.effects)
      if (this.optimized && this.driver.managed && !n.passthrough && n.blend === 'normal' &&
          n.opacity === 1 && !n.children.length && !maskId && leafBackdrop &&
          n.effects.every((fx) => !fx.visible || fx.kind === 'glass' || fx.kind === 'background-blur') &&
          (leafBackdrop.kind === 'background-blur' || (n.glassShape && leafBackdrop.glass))) {
        targets = await this.drawBackdropLeaf(n, targets, clip, leafBackdrop)
        continue
      }
      if (this.optimized && n.passthrough && n.opacity === 1 && !n.clip &&
          !maskId && !n.fills.length && !n.strokes.length && !n.effects.length) {
        // With no clip or isolation, this container never consumes coverage.
        // Recurse before allocating four unused, frame-pinned sample masks.
        targets = await this.drawBundle(n.children, targets, clip)
        continue
      }
      // A single normal paint in an otherwise empty isolated leaf first merges
      // over transparent, an identity before its final source-over. Retain the
      // exact paint/mask/opacity operations, but avoid four redundant isolation
      // surfaces. Ancestor clipping still happens at the original final merge.
      if (this.optimized && n.opacity === 1 && n.blend === 'normal' && !n.passthrough &&
          !maskId && !n.children.length && !n.effects.length && !n.strokes.length &&
          n.fills.length === 1 && n.fills[0].visible && n.fills[0].blend === 'normal' &&
          // The measured gradient's lookup/dither pipeline belongs to paintOver;
          // the generic paint shortcut does not execute those source stages.
          (this.driver.managed || !n.fills[0].figmaGradient)) {
        for (let i = 0; i < 4; i++) {
          await this.reclaimScratch()
          this.sampleIndex = i
          const mask = this.nodeMask(n)
          // The existing exact fused solid pass also applies the ancestor's
          // clip after paint coverage. Avoid a paint texture and a second pass
          // for each of four samples, preserving every rounding operation.
          targets[i] = this.paintOver(n, n.fills[0], mask, targets[i], clip?.[i])
          this.retireLeafMasks(n, undefined, clip, targets)
        }
        continue
      }
      const masks: Surface[] = []
      const firstEffect = n.effects.find(fx => fx.visible)
      const streamBlur = this.optimized && this.driver.managed && !this.driver.displayMath &&
        this.driver.sequentialSampleResolve && !n.passthrough && !n.children.length &&
        !maskId && !leafBackdrop && !n.strokes.length && firstEffect?.kind === 'blur' && firstEffect.radius > 0
      // An isolation-only container consumes its children's colors, never
      // its own path coverage. Do not pin four full-halo masks on every
      // such ancestor while drawing the descendants.
      const needsFillCoverage = !this.optimized || n.clip || !!leafBackdrop || n.fills.some(p => p.visible) ||
        n.strokes.some(stroke => stroke.align !== 'center')
      for (let i = 0; !streamBlur && needsFillCoverage && i < 4; i++) {
        await this.reclaimScratch()
        this.sampleIndex = i
        masks.push(this.nodeMask(n))
      }
      if (
        this.optimized &&
        n.passthrough &&
        n.opacity === 1 &&
        !maskId &&
        !n.fills.length &&
        !n.strokes.length &&
        !n.effects.length
      ) {
        // Pure pass-through containers introduce no isolation. Replaying
        // children into their parent's sample targets preserves group
        // invariance and avoids a full backdrop copy at every nesting level.
        const combined =
          n.clip && clip ? masks.map((mask, i) => this.combine(mask, clip[i], n.rect)) : undefined
        targets = await this.drawBundle(n.children, targets, combined || (n.clip ? masks : clip))
        if (combined) this.release(...combined)
        continue
      }
      const first = n.fills.find((p) => p.visible)
      const inPlace =
        !clip &&
        !maskId &&
        n.opacity === 1 &&
        n.blend === 'normal' &&
        !n.passthrough &&
        !n.effects.length &&
        !n.strokes.length &&
        (n.clip || n.opaqueCoverage) &&
        first?.opacity === 1 &&
        this.alpha(first.color) === 1 &&
        first.stops.every((s) => this.alpha(s.color) === 1) &&
        first.blend === 'normal' &&
        first.kind !== 'image'
      if (inPlace) {
        for (let i = 0; i < 4; i++) {
          await this.reclaimScratch()
          this.sampleIndex = i
          for (const paint of n.fills) {
            if (!paint.visible) continue
            targets[i] = this.paintOver(n, paint, masks[i], targets[i])
          }
        }
        targets = await this.drawBundle(n.children, targets, n.clip ? masks : undefined)
        this.retireLeafMasks(n, undefined, clip, targets)
        continue
      }
      let layers: Surface[] = []
      let resolvedFirstBlur: Surface | undefined
      let sharedEmpty:Surface|undefined
      const layer = (i: number) => layers[i] ??= n.passthrough
        ? this.copy(targets[i], n.rect)
        : this.optimized&&this.driver.managed&&!this.allowSolidBatch
          ? this.retain(sharedEmpty??=this.empty(n.rect)) : this.empty(n.rect)
      const coverage: { value?: Surface[]; owned?: boolean } = {}
      const selectedBackdrop = backdropEffect(n.effects)
      const backgrounds = selectedBackdrop ? [selectedBackdrop] : []
      if (backgrounds.length) {
        const replay =
          !this.driver.managed && n.captureReplay && n.glassShape && backgrounds[0].glass
        const cropped = backgrounds.every((e) => e.kind === 'background-blur')
        const box = n.backdropBox
        const capture = cropped && box ? rect(box[0], box[1], box[2], box[3]) : n.rect
        let background = replay ? undefined : this.run(26, capture, targets)
        this.backdropReads++
        for (const fx of backgrounds) {
          if (!background) break
          const blurred = this.blur(background, (backdropRadius(fx) * scale(n.matrix)) / 2, cropped)
          if (blurred !== background) this.release(background)
          background = blurred
          if (fx.kind === 'glass' && !(n.glassShape && fx.glass)) {
            const geometry = this.run(23, n.rect, masks)
            const refracted = this.glass(background, geometry, n, fx, true)
            this.release(background, geometry)
            background = refracted
          }
        }
        if (cropped && background) {
          const expanded = this.run(27, n.rect, [background])
          this.release(background)
          background = expanded
        }
        for (let i = 0; i < 4; i++) {
          await this.reclaimScratch()
          const fx = backgrounds[0]
          const base = background || targets[i]
          const optical =
            n.glassShape && fx.glass ? this.glass(base, masks[i], n, fx, true, i) : undefined
          // Backdrop capture/blur/optics never reads the empty isolation layers.
          // Allocate each only when its sample is actually composed.
          const filled = this.compose(optical || base, layer(i), 'normal', 1, masks[i])
          if (optical) this.release(optical)
          this.release(layers[i])
          layers[i] = filled
        }
        this.release(background)
        // Only foreground blur mutates the replacement footprint. Otherwise
        // consume cached coverage read-only, with its original global rect;
        // sampling outside that rect remains transparent, like the copied form.
        coverage.owned = !this.optimized || n.effects.some((fx) => fx.visible && fx.kind === 'blur' && fx.radius > 0)
        coverage.value = coverage.owned ? masks.map((m) => this.copy(m, n.rect)) : masks
      }
      for (let i = 0; i < 4; i++) {
        await this.reclaimScratch()
        this.sampleIndex = i
        if (streamBlur && needsFillCoverage) masks[i] = this.nodeMask(n)
        layer(i)
        for (const paint of n.fills) {
          if (!paint.visible) continue
          layers[i] = this.paintOver(n, paint, masks[i], layers[i])
        }
        if (streamBlur) {
          // Foreground blur first resolves its four independent leaf samples.
          // Preserve meanFourRN's scale-each then left-to-right additions, but
          // consume each plane immediately instead of pinning all four.
          const next = this.run(48, n.rect, resolvedFirstBlur ? [layers[i], resolvedFirstBlur] : [layers[i]], u => { u[17] = i })
          this.release(layers[i], resolvedFirstBlur)
          resolvedFirstBlur = next
          this.retireLeafMasks(n, undefined, clip, [...targets, next])
        }
      }
      if (streamBlur) layers = []
      this.release(sharedEmpty)
      if (maskId) {
        const maskNode = this.scene.nodes[maskId], maskPaint = maskNode?.fills[0]
        // An opaque normal solid alpha mask has exactly the path's coverage:
        // multiplying by one and compositing over zero cannot change it. Keep
        // these cache-owned samples borrowed instead of creating four color
        // planes (and their paint/composite scratch) solely to read alpha.
        const coverageMask = this.optimized && this.driver.managed && maskNode &&
          maskNode.maskType !== 'luminance' && !maskNode.passthrough &&
          maskNode.opacity === 1 && maskNode.blend === 'normal' &&
          !maskNode.children.length && !maskNode.strokes.length && !maskNode.effects.length &&
          maskNode.fills.length === 1 && maskPaint.visible && maskPaint.kind === 'solid' &&
          maskPaint.blend === 'normal' && maskPaint.opacity === 1 && this.alpha(maskPaint.color) === 1
        let maskTargets: Surface[] = []
        if (coverageMask) {
          for (let i = 0; i < 4; i++) {
            await this.reclaimScratch()
            this.sampleIndex = i
            maskTargets.push(this.nodeMask(maskNode))
          }
        } else {
          maskTargets = this.emptyBundle(n.rect)
          maskTargets = await this.drawBundle([maskId], maskTargets)
        }
        if (this.scene.nodes[maskId]?.maskType === 'luminance')
          maskTargets = maskTargets.map((s) => {
            const out = this.run(30, s.rect, [s])
            this.release(s)
            return out
          })
        let content = n.passthrough?layers.map(layer=>this.copy(layer)):this.emptyBundle(n.rect)
        content = await this.drawBundle(
          n.children.filter((id) => id !== maskId),
          content,
          n.clip ? masks : undefined,
        )
        for (let i = 0; i < 4; i++) {
          await this.reclaimScratch()
          const combined = n.passthrough
            ? this.interpolate(content[i], layers[i], 1, maskTargets[i])
            : this.compose(content[i], layers[i], 'normal', 1, maskTargets[i])
          this.release(layers[i])
          layers[i] = combined
          // These two sample inputs will never be read again. Keeping all
          // four until the loop ended pinned eight large mask/content planes.
          this.release(content[i], coverageMask ? undefined : maskTargets[i])
        }
        this.release(...content, ...(coverageMask ? [] : maskTargets))
      } else {
        const plan = this.nestedPrefixAllowed && import.meta.env.VITE_DESIGN_NESTED_PREFIX !== '0'
          ? planNestedPrefix(this.scene, n.id, this.nativeChanging) : undefined
        const policy = plan && !n.clip ? this.nestedPrefixPolicy(n.id, layers) : undefined
        if (this.nestedPrefix && (this.nestedPrefix.plan.scopeId === n.id || plan) &&
            (!plan || !policy || !this.nestedPrefixMatches(plan, policy))) this.retireNestedPrefix()
        const needed = plan ? layers.reduce((bytes, p) => bytes + p.rect.w * p.rect.h * 16, 0) : 0
        const admitted = !!(plan && policy && (this.nestedPrefixMatches(plan, policy) ||
          needed <= 64 * 1024 * 1024 && this.interactionBytes + needed <= this.interactionBudget && !this.overBudget(needed)))
        layers = await this.drawBundle(n.children, layers, n.clip ? masks : undefined,
          admitted && plan && policy ? { plan, policy } : undefined)
      }
      for (let i = 0; i < 4; i++) {
        await this.reclaimScratch()
        this.sampleIndex = i
        for (const stroke of n.strokes) {
          let mask = this.mask(stroke.path),
            aligned: Surface | undefined
          if (stroke.align !== 'center') {
            aligned = this.combine(mask, masks[i], n.rect, stroke.align === 'outside')
            mask = aligned
          }
          layers[i] = this.paintOver(n, stroke.paint, mask, layers[i])
          this.release(aligned)
        }
      }
      // Fills and strokes have consumed leaf coverage. Foreground effects
      // read the color planes and (for a backdrop) the replacement footprint.
      // Do not pin four no-longer-needed masks throughout their scratch passes.
      this.retireLeafMasks(n, undefined, clip,
        [...targets, ...layers, ...(coverage.value || [])])
      if (n.effects.some((e) => e.visible)) {
        layers = await this.applySampleEffects(n, layers, coverage, resolvedFirstBlur)
        this.orderedEffectLayers++
      }
      const mergedSamples: { src: Surface; dst: Surface; mask?: Surface; out: Surface }[] = []
      const shareMerge = this.optimized && this.driver.managed && !this.allowSolidBatch &&
        !n.passthrough && !coverage.value
      for (let i = 0; i < 4; i++) {
        await this.reclaimScratch()
        const src = layers[i], dst = targets[i], mask = clip?.[i]
        const shared = shareMerge && mergedSamples.find(s =>
          sameSurface(s.src, src) && sameSurface(s.dst, dst) && sameSurface(s.mask, mask))
        if (shared) {
          targets[i] = this.retain(shared.out)
          this.release(dst, src)
          continue
        }
        if (n.passthrough) {
          const old = targets[i]
          targets[i] = this.interpolate(layers[i], old, n.opacity, clip?.[i])
          this.release(old)
        } else if (coverage.value) {
          const old = targets[i],
            mask = clip?.[i],
            knockout = coverage.value[i]
          targets[i] = this.run(25, old.rect, [layers[i], old, mask || knockout, knockout], (u) => {
            u.set([25, blends.indexOf(n.blend), n.opacity, mask ? 1 : 0], 16)
            u.set([knockout.rect.x, knockout.rect.y, knockout.rect.w, knockout.rect.h], 188)
          })
          this.release(old)
        } else if (n.blend === 'normal' && n.opacity < 1) {
          const old = targets[i],
            mask = clip?.[i]
          targets[i] = this.run(
            29,
            old.rect,
            mask ? [layers[i], old, mask] : [layers[i], old],
            (u) => {
              u.set([29, 0, n.opacity, mask ? 1 : 0], 16)
            },
          )
          this.release(old)
        } else targets[i] = this.merge(layers[i], targets[i], n.blend, n.opacity, clip?.[i])
        if (shareMerge) mergedSamples.push({ src, dst, mask, out: targets[i] })
        this.release(layers[i])
      }
      this.release(...layers, ...(coverage.owned ? coverage.value || [] : []))
      this.retireLeafMasks(n, undefined, clip, targets)
    }
    this.sampleIndex = undefined
    return targets
    } finally { this.activeNode = previousNode; this.interactionCapturing = previousCapturing }
  }
  /** The four sample colors are independent after capturing the shared backdrop.
   * Complete one leaf sample at a time so its layer/masks do not coexist with
   * three other finished samples. Within each sample the original operations
   * and rounding boundaries remain unchanged. Foreground effects use drawBundle. */
  private async drawBackdropLeaf(n: GpuNode, targets: Surface[], clip: Surface[] | undefined, fx: Effect) {
    const cropped = fx.kind === 'background-blur', box = n.backdropBox
    const capture = cropped && box ? rect(box[0], box[1], box[2], box[3]) : n.rect
    // Read all four original target planes exactly once, before replacing any.
    let background = this.run(26, capture, targets)
    this.backdropReads++
    const blurred = this.blur(background, (backdropRadius(fx) * scale(n.matrix)) / 2, cropped)
    if (blurred !== background) this.release(background)
    background = blurred
    if (cropped) {
      const expanded = this.run(27, n.rect, [background])
      this.release(background)
      background = expanded
    }
    for (let i = 0; i < 4; i++) {
      await this.reclaimScratch()
      this.sampleIndex = i
      const mask = this.nodeMask(n)
      const optical = n.glassShape && fx.glass ? this.glass(background, mask, n, fx, true, i) : undefined
      const empty = this.empty(n.rect)
      let layer = this.compose(optical || background, empty, 'normal', 1, mask)
      this.release(optical, empty)
      for (const paint of n.fills) if (paint.visible) layer = this.paintOver(n, paint, mask, layer)
      for (const stroke of n.strokes) {
        let strokeMask = this.mask(stroke.path), aligned: Surface | undefined
        if (stroke.align !== 'center') {
          aligned = this.combine(strokeMask, mask, n.rect, stroke.align === 'outside')
          strokeMask = aligned
        }
        layer = this.paintOver(n, stroke.paint, strokeMask, layer)
        this.release(aligned)
      }
      const old = targets[i], boundary = clip?.[i]
      targets[i] = this.run(25, old.rect, [layer, old, boundary || mask, mask], (u) => {
        u.set([25, blends.indexOf(n.blend), n.opacity, boundary ? 1 : 0], 16)
        u.set([mask.rect.x, mask.rect.y, mask.rect.w, mask.rect.h], 188)
      })
      this.release(old, layer)
      this.retireLeafMasks(n, undefined, clip, targets)
    }
    this.release(background)
    this.orderedEffectLayers++
    return targets
  }
  /** Resolve an isolated subtree's independent samples in bounded rows, then keep only the horizontal
   * filter output needed by the vertical pass. Sampling coordinates, exact
   * coefficients and the four-sample addition order are unchanged. */
  private filterSourceSupported(n: GpuNode, root = true): boolean {
    return !n.passthrough && !n.clip && !n.mask && !n.maskId && !n.strokes.length && !n.previewSource &&
      (!n.fill.count || !!n.fill.area) && (root || !n.effects.some(e=>e.visible)) &&
      n.fills.every(p=>p.kind==='solid'||p.kind==='image') &&
      n.children.every(id=>!this.scene.nodes[id]||this.filterSourceSupported(this.scene.nodes[id],false))
  }
  private filterSource(n: GpuNode, region: Rect, sample: number): Surface {
    if(!intersect(n.rect,region).w||!intersect(n.rect,region).h)return this.empty(region)
    const node={...n,rect:region,fills:n.fills.map(p=>({...p}))}
    this.sampleIndex=sample
    let layer=this.empty(region)
    if(node.fills.some(p=>p.visible)) {
      const mask=this.acquire(region,!!this.driver.createBinaryCoverage)
      if(n.fill.count)this.driver.maskRegion!(n.fill,mask.texture,sample,region)
      else this.driver.clear(mask.texture)
      for(const paint of node.fills)if(paint.visible)layer=this.paintOver(node,paint,mask,layer)
      this.release(mask)
    }
    for(const id of n.children){
      const child=this.scene.nodes[id];if(!child||child.opacity<=0)continue
      const source=this.filterSource(child,region,sample)
      layer=this.merge(source,layer,child.blend,child.opacity)
      this.release(source)
    }
    for(const paint of node.fills)this.imageGrids.delete(paint)
    return layer
  }
  /** Narrow leaf-only specialization. Keep the physical coverage pass and
   * original coordinate fields; remove only the two materialized intermediates
   * between image paint, over-transparent, and the exact sample resolve. */
  private resolveFilterImageSample(n: GpuNode, region: Rect, sample: number, previous?: Surface): Surface | undefined {
    if (!this.optimized || !this.driver.managed || this.driver.displayMath ||
        !this.driver.exactImageResolveStep || !this.driver.createBinaryCoverage || !this.driver.maskRegion ||
        import.meta.env.VITE_DESIGN_IMAGE_RESOLVE_FUSION === '0' || n.children.length ||
        !Number.isInteger(sample) || sample < 0 || sample > 3 || (sample > 0 && !previous) ||
        !this.filterSourceSupported(n) || !exactBlendLattice([region, ...(previous ? [previous.rect] : [])])) return
    const fills = n.fills.filter(p => p.visible)
    if (fills.length !== 1 || fills[0].kind !== 'image' || fills[0].blend !== 'normal' || fills[0].opacity !== 1) return
    const visible = intersect(n.rect, region)
    if (!visible.w || !visible.h) return
    const paint = { ...fills[0] }, node = { ...n, rect: region, fills: [paint] }
    this.sampleIndex = sample
    const level = this.imageLevel(node, paint), intoAtlas = this.imageAtlas
    const image = this.imageFor(paint.image || '', level, intoAtlas, paint.adjust)
    // Atlas partial writes deliberately carry no whole-texture finite proof.
    // Nonfinite or unknown uploads must keep integerSample's NaN-neighbour path.
    if (image.texture.finitePixels !== true || !exactBlendLattice([image.rect])) return
    const origin = intoAtlas
      ? this.imageOrigins.get(this.imageKey(paint.image || '', level, true, paint.adjust)) ?? [0, 0] as [number, number]
      : [0, 0] as [number, number]
    const mask = this.acquire(region, true)
    try {
      if (n.fill.count) this.driver.maskRegion!(n.fill, mask.texture, sample, region)
      else this.driver.clear(mask.texture)
      const field = this.imageGrid(node, paint, image, level, origin)
      return this.run(IMAGE_RESOLVE_STEP_MODE, region, [mask, image, previous || mask, field], u => {
        this.configurePaint(u, node, paint)
        u[17] = sample
        u.set([field.rect.x, field.rect.y], 204)
      })
    } finally {
      this.release(mask)
      this.imageGrids.delete(paint)
    }
  }
  private horizontalFilterSource(n: GpuNode, input: Rect, output: Rect, radius: number) {
    const lease = this.scene.filterBatchLease
    // Mip selection samples a rect-dependent f64 finite difference. Retaining
    // level zero only avoids asserting that different strip centres pick the
    // same level. Other policies keep the existing path.
    if (!lease || !this.driver.copyRegion || this.imageMips || !this.optimized || !this.driver.managed ||
        this.driver.displayMath || !this.driver.exactImageResolveStep || !this.driver.createBinaryCoverage ||
        !this.driver.maskRegion || import.meta.env.VITE_DESIGN_IMAGE_RESOLVE_FUSION === '0' ||
        import.meta.env.VITE_DESIGN_HORIZONTAL_FILTER_REUSE === '0' || n.children.length ||
        !this.filterSourceSupported(n) || !fullSampleCoverage(n.fill, this.scene.curves, input)) return
    const fills = n.fills.filter(p => p.visible), paint = fills[0]
    if (fills.length !== 1 || paint.kind !== 'image' || paint.blend !== 'normal' || paint.opacity !== 1) return
    const image = this.imageFor(paint.image || '', 0, this.imageAtlas, paint.adjust)
    if (image.texture.finitePixels !== true || !exactBlendLattice([input, output, image.rect])) return
    const origin = this.imageAtlas
      ? this.imageOrigins.get(this.imageKey(paint.image || '', 0, true, paint.adjust)) ?? [0, 0]
      : [0, 0]
    const key = exactFilterKey([n.id, n.matrix, n.inverse, n.size, paint, radius,
      input.x, input.w, output.x, output.w, image.rect, this.baseDims(paint.image || ''), 0, origin,
      this.scene.view, this.scene.colorManagement, this.scene.integratedBlur, this.scene.floatCompositing,
      this.scene.displayImageSource, this.scene.displayMaterialSource, this.scene.displayFilters, this.scene.displayFilterRadiusLimit,
      this.driver.linearLight, this.driver.hdr, this.driver.certifiedFilter])
    return key === undefined ? undefined : { lease, key, image: image.texture }
  }
  private staticImageFilterWindowEligible(output: Rect) { return largeStaticImageBlurWindow(output, this.scene.output) }
  private staticImageFilterIdentity(n: GpuNode, input: Rect, output: Rect, radius: number) {
    // This first candidate targets the measured 100% interaction blur. Cold
    // high-radius tiles keep their established H-cache working set unchanged.
    if (import.meta.env.VITE_DESIGN_STATIC_IMAGE_BLUR_CACHE !== '1' || !this.staticImageFilterWindowEligible(output) ||
      !(radius >= 32 && radius < 64) || this.imageMips || this.imageAtlas ||
      this.driver.name !== 'webgpu' || !this.driver.managed || this.driver.displayMath || !this.driver.imageTableRange ||
      this.scene.coherentSamples !== true || this.scene.compactImageFields === false ||
      import.meta.env.VITE_DESIGN_IMAGE_AXES === '0' || import.meta.env.VITE_DESIGN_STREAM_IMAGE_FIELDS === '0' ||
      import.meta.env.VITE_DESIGN_EXACT_IMAGE_X_TABLE === '0' || !this.filterSourceSupported(n) || n.children.length ||
      !completeFilterAxisSupport(input, output, 0, radius) || !completeFilterAxisSupport(input, output, 1, radius) ||
      !fullSampleCoverage(n.fill, this.scene.curves, input)) return
    const effects = n.effects.filter(effect => effect.visible), fills = n.fills.filter(paint => paint.visible), paint = fills[0]
    if (effects.length !== 1 || effects[0].kind !== 'blur' || effects[0].gradientBlur || fills.length !== 1 ||
      paint.kind !== 'image' || !paint.image || paint.blend !== 'normal' || paint.opacity !== 1) return
    const descriptor = this.staticImageSourceDescriptor(paint.image, 0, false, paint.adjust)
    const { image: _uri, ...paintPolicy } = paint
    const key = exactFilterKey([n.id, n.matrix, n.inverse, n.size, paintPolicy, effects, radius,
      this.scene.view, this.scene.colorManagement, this.scene.integratedBlur, this.scene.floatCompositing,
      this.scene.coherentSamples, this.scene.compactImageFields, this.scene.displayFilters, this.scene.displayFilterRadiusLimit,
      this.scene.displayImageSource, this.scene.displayMaterialSource, this.scene.softwareRaster,
      this.scene.resolve, this.scene.presentation, this.driver.linearLight, this.driver.hdr, this.driver.certifiedFilter,
      import.meta.env.VITE_DESIGN_IMAGE_RESOLVE_FUSION !== '0', import.meta.env.VITE_DESIGN_WHOLE_IMAGE_FILTER !== '0'])
    return descriptor && key ? { key, descriptor, imageKey: this.imageKey(paint.image, 0, false, paint.adjust) } : undefined
  }
  private async prepareFilterImageTable(n: GpuNode, input: Rect): Promise<ExactImageTable | undefined> {
    if(import.meta.env.VITE_DESIGN_EXACT_IMAGE_X_TABLE === '0' || this.imageMips || !this.driver.managed ||
        this.driver.displayMath || !this.driver.prepareImageTable || !this.driver.resolveImageTable ||
        !this.driver.imageTableRange || !this.driver.imageTableAxes || n.children.length ||
        !fullSampleCoverage(n.fill,this.scene.curves,input))return
    const fills=n.fills.filter(p=>p.visible),paint=fills[0]
    if(fills.length!==1 || paint.kind!=='image' || paint.blend!=='normal' || paint.opacity!==1)return
    const image=this.imageFor(paint.image||'',0,this.imageAtlas,paint.adjust),range=this.driver.imageTableRange(image.texture)
    // The narrow display sampler uses the original four coordinate phases.
    // Do not build the exact interpolation table only to bypass it afterwards.
    if (this.driver.usesDisplayImageSource?.(image.texture)) return
    if(!range || image.rect.x!==0 || image.rect.y!==0 ||
        image.rect.w!==image.texture.width || image.rect.h!==image.texture.height)return
    const clone={...paint},node={...n,rect:input,fills:[clone]},axes:Float32Array[]=[]
    const previous=this.sampleIndex
    try{
      for(let sample=0;sample<4;sample++){
        this.sampleIndex=sample
        const field=this.imageGrid(node,clone,image,0,[0,0])
        if(field.rect.x!==input.x || field.rect.y!==input.y || field.rect.w!==input.w || field.rect.h!==input.h)return
        const values=this.driver.imageTableAxes(field.texture);if(!values)return
        axes.push(values)
      }
    }finally{this.sampleIndex=previous;this.imageGrids.delete(clone)}
    const plan=planExactImageXTable({axes,width:input.w,height:input.h,
      imageWidth:image.rect.w,imageHeight:image.rect.h,range,
      maxTableBytes:import.meta.env.VITE_DESIGN_EXACT_IMAGE_X_TABLE_LARGE !== '0'?32*1024*1024:16*1024*1024})
    if(!plan)return
    const required=256+plan.tableBytes+plan.x.byteLength+plan.y.byteLength
    // Pinning the source until table retirement must leave room for the next
    // resolved strip, its H result and the bounded prefix scratch. Otherwise
    // keep the original strip sampler instead of failing a later allocation.
    const headroom=input.w*Math.min(input.h,64)*16*2+PREFIX_SCRATCH_BYTES
    this.pendingImageTableSources.add(image.texture)
    try {
    await this.reclaimScratch(required+headroom)
    if(this.workingBytes+required+headroom>this.frameBudget)return
    const before=this.driver.scratchBytes||0
    try{
      const table=await this.driver.prepareImageTable(image.texture,plan,this.frameBudget-this.workingBytes-headroom)
      if(table){
        this.imageXTableBuilds++;this.imageXTableBytes=Math.max(this.imageXTableBytes,table.bytes)
        const descriptor = this.staticImageSourceDescriptor(paint.image || '', 0, this.imageAtlas, paint.adjust)
        const source = descriptor && this.staticImageBlurs.source(image.texture, descriptor.uri, descriptor.policy)
        if (source) this.staticImageTableProofs.set(table, { source, input: { ...input } })
      }
      return table
    }
    finally{this.bytes+=(this.driver.scratchBytes||0)-before;this.peak=Math.max(this.peak,this.bytes)}
    } finally { this.pendingImageTableSources.delete(image.texture) }
  }
  private async streamIsolatedFilter(n: GpuNode, targets: Surface[], clip?: Surface[]): Promise<Surface[] | undefined> {
    const effects = n.effects.filter(e => e.visible)
    const radius = effects[0] ? effects[0].radius * scale(n.matrix) : 0
    if (!this.optimized || !this.driver.managed || this.driver.displayMath || !this.driver.maskRegion ||
        !this.driver.sequentialSampleResolve || !this.scene.integratedBlur || this.displayFilterActive(radius) ||
        !this.filterSourceSupported(n) ||
        effects.length !== 1 || effects[0].gradientBlur ||
        !(effects[0].kind === 'blur' || effects[0].kind === 'shadow' && effects[0].spread === 0 &&
          effects[0].x === 0 && effects[0].y === 0 && this.driver.exactShadowOver) ||
        n.fills.some(p => p.kind !== 'solid' && p.kind !== 'image')) return
    const wholeCandidate = import.meta.env.VITE_DESIGN_WHOLE_IMAGE_FILTER !== '0'
    if (!(radius > 0 && radius <= 2048)) return
    const output = intersect(n.rect, targets[0].rect)
    if (!output.w || !output.h) return targets
    const reach = Math.ceil(radius) + 1
    const input = intersect(n.rect, {x:output.x-reach,y:output.y-reach,w:output.w+reach*2,h:output.h+reach*2})
    if (!exactBlendLattice([input, output]) || input.w > 8192 || input.h > 8192) return
    const material = await this.streamDisplayMaterial(n, targets, input, output, clip)
    if (material) return material
    if (this.interactionCapturing || this.scene.interactionRetained) return
    if (radius < (wholeCandidate && effects[0].kind === 'blur' ? 32 : 64)) return
    const staticIdentity = this.staticImageFilterIdentity(n, input, output, radius)
    if (staticIdentity) {
      this.staticImageBlurEligible++
      // Peek only. A cache hit must not upload the source or allocate H/table
      // scratch before discovering the already-completed exact result.
      const image = this.images.get(staticIdentity.imageKey)
      const source = image && this.staticImageBlurs.source(image.texture, staticIdentity.descriptor.uri, staticIdentity.descriptor.policy)
      const borrowed = source && this.staticImageBlurs.borrow(source, staticIdentity.key, input, output,
        this.driver.completedResourceEpoch, this.driver.resourceEpoch)
      if (borrowed) {
        this.used.add(borrowed.plane.texture); this.touch(borrowed.plane.texture)
        try {
          for (let sample = 0; sample < 4; sample++) {
            await this.reclaimScratch()
            targets[sample] = this.merge(borrowed.plane, targets[sample], n.blend, n.opacity, clip?.[sample])
          }
          this.staticImageBlurHits++; this.staticImageBlurPixels += output.w * output.h
          this.sampleIndex = undefined; this.orderedEffectLayers++
          return targets
        } finally { borrowed.release() }
      }
      // Only a complete large-tile miss retires the single old slot. Narrow
      // edge tiles never enter this branch, so cannot evict the reusable first
      // tile. Release before cold H/table allocation rather than after it.
      this.staticImageBlurs.clear()
      this.staticImageBlurs.collect(this.driver.completedResourceEpoch)
    }
    // Reserve room for the persistent horizontal result and four RGBA strips.
    await this.reclaimScratch(output.w*input.h*16 + input.w*64*16*4)
    const alignBands = this.driver.name === 'webgpu' && this.prefixAllowed &&
      import.meta.env.VITE_DESIGN_PREFIX_ALIGNED_STRIPS !== '0' &&
      !this.filterKernel('rational-tent', radius, () => rational_tent_kernel_rgba(radius)).texture.prefixRationalUnsupported
    const stripRows = alignBands ? prefixAlignedStrip(input.w) : 64
    const stripColumns = alignBands ? prefixAlignedStrip(input.h) : 64
    const previousFields = this.filterImageFields
    this.filterImageFields = { rect: input, fields: new Map(), pinned: new Set() }
    let staticSourcePin: Texture | undefined
    try {
    const reusable = this.horizontalFilterSource(n, input, output, radius)
    const horizontal = this.acquire({x:output.x,y:input.y,w:output.w,h:input.h})
    this.driver.clear(horizontal.texture)
    // Lookup happens after allocation: admission pressure is allowed to drop
    // the old entry. No await separates this last ownership check and its copy.
    const cached = reusable && this.horizontalFilters.get(reusable.lease, reusable.key, reusable.image, horizontal.rect)
    const missing = [{ y: input.y, h: input.h }]
    if (cached) {
      const { plane, overlap } = cached
      this.used.add(plane.texture); this.touch(plane.texture)
      this.driver.copyRegion!(horizontal.texture, plane.texture,
        {x:overlap.x-plane.rect.x,y:overlap.y-plane.rect.y,w:overlap.w,h:overlap.h},
        [overlap.x-horizontal.rect.x,overlap.y-horizontal.rect.y])
      this.horizontalFilterHits++
      this.horizontalFilterPixels += overlap.w * overlap.h
      this.horizontalFilterRows += overlap.h
      missing.splice(0,1,...[
        {y:input.y,h:overlap.y-input.y},
        {y:overlap.y+overlap.h,h:input.y+input.h-overlap.y-overlap.h},
      ].filter(part=>part.h>0))
      // The copy now owns the last queued read. Return old storage to the
      // ordered pool immediately rather than keep two cache entries alive.
      this.horizontalFilters.clear()
    }
    const imageTable=missing.length?await this.prepareFilterImageTable(n,input):undefined
    const staticTable = staticIdentity && imageTable && this.staticImageTableProofs.get(imageTable)
    if (staticTable) {
      staticSourcePin = this.images.get(staticIdentity.imageKey)?.texture
      if (staticSourcePin) this.pendingImageTableSources.add(staticSourcePin)
    }
    const opaqueHorizontal = !!imageTable?.opaqueAlpha && completeFilterAxisSupport(input, horizontal.rect, 0, radius)
    const rows = alignBands && opaqueHorizontal && import.meta.env.VITE_DESIGN_PREFIX_RGB_RESOLVE !== '0'
      ? prefixAlignedRgbStrip(input.w, output.w) : stripRows
    let whole = false
    // The original strip blits canonicalize -0. Nonnegative resolved RGBA and
    // positive tent weights cannot produce -0, including underflow, so only
    // this private upload proof permits omitting those intermediate blits.
    if (wholeCandidate && radius >= 32 && radius < 64 && imageTable?.nonnegativeResolved === true && alignBands &&
        missing.length === 1 && missing[0].y === input.y && missing[0].h === input.h && input.w * input.h <= 1_500_000) {
      const required = input.w * input.h * 16 + PREFIX_SCRATCH_BYTES
      await this.reclaimScratch(required)
      this.checkFrameCurrent()
      if (this.workingBytes + required <= this.frameBudget) {
        const resolved = this.acquire(input)
        try {
          this.driver.resolveImageTable!(resolved.texture, imageTable, 0, 0)
          this.imageXTablePixels += input.w * input.h; this.passPixels += input.w * input.h
          this.sampleIndex = undefined
          this.exactTentAxis(resolved, radius, 0, horizontal.rect, horizontal)
          this.wholeFilterAxes++; whole = true
        } finally { this.release(resolved) }
      }
    }
    if (!whole) for (const part of missing) for (let y=part.y;y<part.y+part.h;y+=rows) {
      await this.reclaimScratch()
      const pause=this.yieldEncoding(); if(pause) await pause
      const region={x:input.x,y,w:input.w,h:Math.min(rows,part.y+part.h-y)}
      let resolved:Surface|undefined
      if(imageTable){
        resolved=this.acquire(region)
        this.driver.resolveImageTable!(resolved.texture,imageTable,region.x-input.x,region.y-input.y)
        this.imageXTablePixels+=region.w*region.h
        this.passPixels+=region.w*region.h
      }else for(let i=0;i<4;i++) {
        const fused = this.resolveFilterImageSample(n, region, i, resolved)
        if (fused) { this.release(resolved); resolved = fused; continue }
        const layer=this.filterSource(n,region,i)
        const next=this.run(48,region,resolved?[layer,resolved]:[layer],u=>{u[17]=i})
        this.release(layer,resolved);resolved=next
      }
      this.sampleIndex=undefined
      const filtered=this.exactTentAxis(resolved!,radius,0,{x:output.x,y,w:output.w,h:region.h})
      this.release(resolved)
      const u=parameters(horizontal.rect,filtered.rect);u[16]=0
      this.driver.pass(horizontal.texture,u,[filtered.texture],{x:0,y:y-input.y,w:output.w,h:region.h})
      this.release(filtered)
    }
    if(opaqueHorizontal)
      horizontal.texture.opaqueAlpha=true
    if(imageTable && this.driver.retireImageTable){
      const before=this.driver.scratchBytes||0,at=performance.now()
      try{await this.driver.retireImageTable(imageTable)}
      finally{this.bytes+=(this.driver.scratchBytes||0)-before;this.checkpointMs+=performance.now()-at}
    }
    await this.reclaimScratch(output.w*output.h*16 + (whole ? 0 : output.h*64*16))
    const blurred=this.acquire(output)
    if (!whole) this.driver.clear(blurred.texture)
    // Bound vertical encoding too: one whole-width prefix pass can otherwise
    // delay camera-presentation messages behind hundreds of dispatches.
    const columns = alignBands && horizontal.texture.opaqueAlpha && completeFilterAxisSupport(horizontal.rect, output, 1, radius) &&
      import.meta.env.VITE_DESIGN_PREFIX_RGB_RESOLVE !== '0' ? prefixAlignedRgbStrip(input.h, output.h) : stripColumns
    if (whole) {
      const pause = this.yieldEncoding(); if (pause) await pause
      this.exactTentAxis(horizontal, radius, 1, output, blurred)
      this.wholeFilterAxes++
    } else for(let x=output.x;x<output.x+output.w;x+=columns){
      const pause=this.yieldEncoding();if(pause)await pause
      await this.reclaimScratch()
      const region={x,y:output.y,w:Math.min(columns,output.x+output.w-x),h:output.h}
      const filtered=this.exactTentAxis(horizontal,radius,1,region)
      const u=parameters(output,filtered.rect);u[16]=0
      this.driver.pass(blurred.texture,u,[filtered.texture],{x:x-output.x,y:0,w:region.w,h:region.h})
      this.release(filtered)
    }
    // Ownership transfers only after the original Y filter has consumed the
    // complete plane. Pending entries cannot satisfy another tile yet.
    if (!reusable || !this.horizontalFilters.stage(reusable.lease, reusable.key, reusable.image, horizontal))
      this.release(horizontal)
    const shadow=effects[0].kind==='shadow'
    const sharpNode=shadow?{...n,rect:output,fills:n.fills.map(p=>({...p}))}:undefined
    for(let i=0;i<4;i++) {
      await this.reclaimScratch()
      let source=blurred
      if(sharpNode){
        const sharp=this.filterSource(n,output,i)
        source=this.shadow(sharp,blurred,sharpNode,effects[0],true)
        this.release(sharp)
      }
      targets[i]=this.merge(source,targets[i],n.blend,n.opacity,clip?.[i])
      if(shadow)this.release(source)
    }
    this.sampleIndex=undefined
    const nativeSameInput = staticTable && Object.keys(input).every(key =>
      Object.is(input[key as keyof Rect], staticTable.input[key as keyof Rect]))
    if (!staticIdentity || !nativeSameInput ||
      !this.staticImageBlurs.stage(staticTable.source, staticIdentity.key, input, blurred, this.driver.resourceEpoch))
      this.release(blurred)
    this.orderedEffectLayers++
    return targets
    } finally {
      if (staticSourcePin) this.pendingImageTableSources.delete(staticSourcePin)
      this.filterImageFields = previousFields
    }
  }
  /** Screen-only material approximation. Keep native geometry, the original
   * four coordinate phases and painter order. Only an interior opaque image's
   * single blur is evaluated once in its source lattice, independently of
   * camera zoom. No exact/finite certificate is attached to the cached result.
   */
  private async resolveDisplayMaterial(n: GpuNode, input: Rect, output: Rect) {
    if (!this.scene.displayMaterialSource || import.meta.env.VITE_DESIGN_DISPLAY_MATERIAL_SOURCE !== '1' ||
        !this.driver.imageTableRange || this.imageMips || this.imageAtlas || this.scene.displayFilters ||
        this.driver.name !== 'webgpu' || this.driver.hdr || this.driver.displayMath) {
      this.sequentialRejected(603, input, { state: Number(!this.scene.displayMaterialSource) |
        Number(import.meta.env.VITE_DESIGN_DISPLAY_MATERIAL_SOURCE !== '1') << 1 |
        Number(!this.driver.imageTableRange) << 2 | Number(this.imageMips) << 3 | Number(this.imageAtlas) << 4 |
        Number(!!this.scene.displayFilters) << 5 | Number(this.driver.name !== 'webgpu') << 6 |
        Number(!!this.driver.hdr) << 7 | Number(!!this.driver.displayMath) << 8 })
      return
    }
    const paint = n.fills.filter(p => p.visible)[0]
    if (!paint?.image) { this.sequentialRejected(611, input); return }
    if (!fullSampleCoverage(n.fill, this.scene.curves, input)) { this.sequentialRejected(604, input); return }
    const image = this.imageFor(paint.image, 0, false, paint.adjust)
    const range = this.driver.imageTableRange(image.texture)
    const plan = planDisplayMaterialSource(this.scene, n, input, image.rect.w, image.rect.h, range)
    if (!plan) {
      this.sequentialRejected(605, input, { state: Number(!!range) | Number(range?.opaqueAlpha === true) << 1 |
        Number(range?.nonnegativeRgb === true) << 2 |
        Number(!!range?.maximum.every(value => Number.isInteger(value) && value >= 1 && value <= 127)) << 3,
        expectedWidthComparison: image.rect.w, expectedHeightComparison: image.rect.h,
        radius: (n.effects.find(effect => effect.visible)?.radius ?? 0) * (image.rect.w / n.size[0]) })
      return
    }
    // Keep the complete screen-space halo away from image-edge clamping.
    // The original full affine transform remains in the sampling program.
    const ratio = image.rect.w / n.size[0], m = n.inverse, margin = plan.radius + 2
    for (const x of [input.x - 1, input.x + input.w + 1]) for (const y of [input.y - 1, input.y + input.h + 1]) {
      const sx = (m[0] * x + m[2] * y + m[4]) * ratio
      const sy = (m[1] * x + m[3] * y + m[5]) * ratio
      if (sx < margin || sy < margin || sx > image.rect.w - margin || sy > image.rect.h - margin) {
        this.sequentialRejected(606, input, { radius: plan.radius }); return
      }
    }
    const key = exactFilterKey([plan.radius, image.rect, this.scene.colorManagement,
      this.driver.linearLight, this.driver.hdr, this.driver.certifiedFilter])
    if (!key) { this.sequentialRejected(612, input); return }
    let cached = this.displayMaterial
    if (!cached || cached.source !== image.texture || cached.key !== key) {
      this.retireDisplayMaterial()
      const required = image.rect.w * image.rect.h * 16 * 2
      this.pendingImageTableSources.add(image.texture)
      try {
        await this.reclaimScratch(required)
        this.checkFrameCurrent()
        if (this.workingBytes + required > this.frameBudget) {
          this.sequentialRejected(607, input, { admissionRequiredBytes: required, admissionWorkingBytes: this.workingBytes,
            admissionBudgetBytes: this.frameBudget }); return
        }
        // The cache lives in source pixels, outside the current pose window.
        // Never apply a screen-space interaction scissor to its H/V passes.
        const capturing = this.interactionCapturing
        let surface: Surface
        try { this.interactionCapturing = true; surface = this.blur(image, plan.radius / 2, true) }
        finally { this.interactionCapturing = capturing }
        if (surface === image) { this.sequentialRejected(613, input); return }
        cached = this.displayMaterial = { source: image.texture, key, surface, published: false }
        this.displayMaterialBuilds++
      } finally { this.pendingImageTableSources.delete(image.texture) }
    } else this.displayMaterialHits++
    this.used.add(cached.surface.texture); this.touch(cached.surface.texture)
    this.displayMaterialBorrowed = true
    let resolved: Surface | undefined, retained = false
    try {
      const node = { ...n, rect: output }, samplePaint = { ...paint }
      for (let sample = 0; sample < 4; sample++) {
        await this.reclaimScratch()
        const pause = this.yieldEncoding(); if (pause) await pause
        this.sampleIndex = sample
        const mask = this.acquire(output, !!this.driver.createBinaryCoverage)
        let layer: Surface | undefined
        try {
          this.driver.maskRegion!(n.fill, mask.texture, sample, output)
          layer = this.paint(node, samplePaint, mask, cached.surface)
          const next = this.run(48, output, resolved ? [layer, resolved] : [layer], u => { u[17] = sample })
          this.release(resolved); resolved = next
        } finally { this.release(mask, layer); this.imageGrids.delete(samplePaint) }
      }
      this.sampleIndex = undefined
      retained = true
      return resolved
    } finally {
      this.sampleIndex = undefined
      if (!retained) this.release(resolved)
      this.displayMaterialBorrowed = false
    }
  }
  private async streamDisplayMaterial(n: GpuNode, targets: Surface[], input: Rect, output: Rect, clip?: Surface[]) {
    const resolved = await this.resolveDisplayMaterial(n, input, output)
    if (!resolved) return
    try {
      for (let sample = 0; sample < 4; sample++) {
        await this.reclaimScratch()
        targets[sample] = this.merge(resolved, targets[sample], n.blend, n.opacity, clip?.[sample])
      }
      this.orderedEffectLayers++
      return targets
    } finally {
      this.release(resolved)
    }
  }
  private sequentialMask(path: PathMesh, region: Rect) {
    if (this.sampleIndex === undefined) { this.sequentialRejected(608, region); throw Error('SEQUENTIAL_DISPLAY_UNSUPPORTED') }
    const mask = this.acquire(region, true)
    if (path.count) this.driver.maskRegion!(path, mask.texture, this.sampleIndex, region)
    else this.driver.clear(mask.texture)
    return { ...mask, opaqueInterior: path.opaqueRect }
  }
  private async drawSequentialNodes(ids: readonly string[], target: Surface, plan: SequentialDisplayPlan,
    materials: ReadonlyMap<string, Surface>): Promise<Surface> {
    for (const id of ids) {
      const n = this.scene.nodes[id], admitted = plan.regions.get(id)
      if (!n || !admitted) continue // Compiler-owned culling sentinels paint nothing.
      const region = intersect(admitted, target.rect)
      if (!region.w || !region.h) continue
      const pause = this.yieldEncoding(); if (pause) await pause
      await this.reclaimScratch()
      const material = materials.get(id)
      if (material) { target = this.merge(material, target, n.blend, n.opacity); continue }
      // Preserve every isolation and painter-order boundary. Only color
      // scratch is cropped; original coverage-program bounds stay intact.
      const node = { ...n, rect: region }
      let layer = this.empty(region), mask: Surface | undefined
      try {
        if (n.fills.some(p => p.visible)) {
          mask = this.sequentialMask(n.fill, region)
          for (const paint of n.fills) if (paint.visible) {
            // Address fields are scoped to this immutable band and phase.
            // Sharing a paint object's field cache across different cropped
            // color bounds would reuse the first band's image coordinates.
            const samplePaint = paint.kind === 'image' ? { ...paint } : paint
            try { layer = this.paintOver(node, samplePaint, mask, layer) }
            finally { if (samplePaint !== paint) this.imageGrids.delete(samplePaint) }
          }
        }
        layer = await this.drawSequentialNodes(n.children, layer, plan, materials)
        target = this.merge(layer, target, n.blend, n.opacity)
      } finally { this.release(mask, layer) }
    }
    return target
  }
  private async sequentialViewport(scene: GpuScene, output: Rect, readback: boolean, present: boolean): Promise<Surface> {
    if (!this.driver.maskRegion || !this.driver.copyRegion || !this.driver.createBinaryCoverage ||
        !this.driver.abortFrameAndReleaseFilterScratch) {
      this.sequentialRejected(601, output); throw Error('SEQUENTIAL_DISPLAY_UNSUPPORTED')
    }
    let frame: Surface | undefined
    try {
    const candidates = new Set(Object.values(scene.nodes).filter(n => intersect(n.rect, output).w &&
      intersect(n.rect, output).h && n.effects.some(effect => effect.visible)).map(n => n.id))
    const preparedImages = new Set<string>()
    // A node ID is not a range proof. Bind admission to this driver's actual
    // immutable level-zero uploads, just as the material source path does.
    // Mip/atlas policies keep their original sampling-dependent fallback.
    if (!this.imageMips && !this.imageAtlas && this.driver.imageTableRange) {
      for (const n of Object.values(scene.nodes)) {
        const paints = n.fills.filter(paint => paint.visible && paint.kind === 'image')
        const region = intersect(n.rect, output)
        if (!paints.length || n.effects.length || !region.w || !region.h) continue
        const admitted = paints.every(paint => {
          if (!paint.image) return false
          const image = this.imageFor(paint.image, 0, false, paint.adjust)
          const range = this.driver.imageTableRange!(image.texture)
          const proven = !!range && range.pixels === image.rect.w * image.rect.h && range.opaqueAlpha === true &&
            range.nonnegativeRgb === true && range.maximum.length === 4 &&
            range.maximum.every(value => Number.isInteger(value) && value >= 1 && value <= 127)
          // Preserve that exact upload while later nodes are admitted. A
          // second large source must not evict an already-proved first one.
          if (proven) this.sequentialImagePins.add(image.texture)
          return proven
        })
        if (admitted) preparedImages.add(n.id)
      }
    }
    let planRejection = 0
    const plan = planSequentialDisplay(scene, output, { managed: !!this.driver.managed, hdr: !!this.driver.hdr,
      present, readback, preparedMaterialIds: candidates, preparedImageIds: preparedImages, allowCulledNodes: true,
      onReject: code => { planRejection = code } })
    if (!plan) { this.sequentialRejected(602, output, { count: candidates.size, state: planRejection }); throw Error('SEQUENTIAL_DISPLAY_UNSUPPORTED') }
      for (const id of candidates)
        for (const paint of scene.nodes[id].fills) if (paint.visible && paint.kind === 'image' && paint.image)
          this.sequentialImagePins.add(this.imageFor(paint.image, 0, false, paint.adjust).texture)
      frame = this.acquire(output)
      this.driver.clear(frame.texture)
      // The frame stays resident. Bounded bands avoid four full-frame planes
      // plus arbitrary nested isolation stacks exceeding the shared ledger.
      const rows = Math.max(1, Math.min(512, Math.floor(524_288 / output.w)))
      for (let y = output.y; y < output.y + output.h; y += rows) {
        const band = { x: output.x, y, w: output.w, h: Math.min(rows, output.y + output.h - y) }
        const materials = new Map<string, Surface>()
        let accumulated: Surface | undefined
        try {
          // A shorter last band needs different scratch dimensions. Admit
          // that real allocation demand before encoding, preserving source
          // pins and the unchanged shared working-memory ceiling.
          await this.reclaimForSurface(band, plan.maxDepth + 4)
          for (const id of candidates) {
            const node = scene.nodes[id], region = intersect(plan.regions.get(id)!, band)
            if (!region.w || !region.h) continue
            const radius = node.effects.find(effect => effect.visible)!.radius * scale(node.matrix), reach = Math.ceil(radius) + 1
            const input = intersect(node.rect, { x: region.x - reach, y: region.y - reach,
              w: region.w + reach * 2, h: region.h + reach * 2 })
            const resolved = await this.resolveDisplayMaterial(node, input, region)
            if (!resolved) { this.sequentialRejected(609, input); throw Error('SEQUENTIAL_DISPLAY_UNSUPPORTED') }
            materials.set(id, resolved)
          }
          for (let sample = 0; sample < 4; sample++) {
            this.sampleIndex = sample
            let plane: Surface | undefined
            try {
              const uniform = !!this.driver.constantTextureSampling
              plane = this.run(12, uniform ? rect(0, 0, 1, 1) : band, [], u => {
                u.set([...this.color(scene.background), scene.transparent ? 0 : this.alpha(scene.background)], 48)
                u.set([scene.view.x, scene.view.y, scene.view.zoom, 0], 44)
              })
              if (uniform) { plane.texture.uniformColor = true; plane = { ...plane, rect: band } }
              plane = await this.drawSequentialNodes(plan.roots, plane, plan, materials)
              const next = this.run(48, band, accumulated ? [plane, accumulated] : [plane], u => { u[17] = sample })
              this.release(accumulated); accumulated = next
            } finally { this.release(plane) }
          }
          this.driver.copyRegion(frame.texture, accumulated!.texture, { x: 0, y: 0, w: band.w, h: band.h },
            [0, band.y - output.y])
        } finally {
          this.sampleIndex = undefined
          this.release(accumulated, ...materials.values())
          // Constants are sample/band scratch here, not whole-frame cache pins.
          for (const surface of this.constantTargets.values()) this.release(surface)
          this.constantTargets.clear()
        }
      }
      return frame
    } catch (error) {
      if (!(error instanceof Error && error.message === 'SEQUENTIAL_DISPLAY_UNSUPPORTED'))
        this.sequentialRejected(610, output, { state: Number(isRecoverablePreviewBudget(error, this.driver.lost)),
          admissionWorkingBytes: this.workingBytes, admissionBudgetBytes: this.frameBudget })
      this.release(frame); throw error
    }
    finally { this.sequentialImagePins.clear() }
  }
  private async applySampleEffects(
    n: GpuNode,
    planes: Surface[],
    coverage: { value?: Surface[]; owned?: boolean },
    resolvedFirstBlur?: Surface,
  ): Promise<Surface[]> {
    const sc = scale(n.matrix)
    for (const fx of n.effects) {
      await this.reclaimScratch()
      if (!fx.visible || fx.kind === 'background-blur' || fx.kind === 'glass') continue
      if (fx.kind === 'blur' && fx.radius === 0) continue
      if (
        fx.kind === 'texture' &&
        (fx.texture ? fx.radius === 0 : fx.amount === 0 || fx.opacity === 0)
      )
        continue
      if (fx.kind === 'blur') {
        const resolved = resolvedFirstBlur || this.run(23, n.rect, planes)
        resolvedFirstBlur = undefined
        // The resolve has encoded the last read of these sample planes.
        // Keeping them throughout both separable passes unnecessarily pins
        // four full effect-halo surfaces at high zoom.
        this.release(...planes)
        const radius=fx.radius*Math.max(1,fx.gradientBlur?.startCount??1,fx.gradientBlur?.endCount??1)*sc
        const full=this.blur(resolved,radius/2)
        const blurred=await this.gradientBlur(resolved,full,n,fx)
        if(blurred!==full && full!==resolved)this.release(full)
        if (blurred !== resolved) this.release(resolved)
        planes = [blurred, this.retain(blurred), this.retain(blurred), this.retain(blurred)]
        if (coverage.value) {
          const mask = this.run(23, n.rect, coverage.value)
          if (coverage.owned) this.release(...coverage.value)
          const fullMask = this.blur(mask, radius / 2),
            filtered = await this.gradientBlur(mask,fullMask,n,fx)
          if(filtered!==fullMask && fullMask!==mask)this.release(fullMask)
          if (filtered !== mask) this.release(mask)
          coverage.value = [filtered, this.retain(filtered), this.retain(filtered), this.retain(filtered)]
          coverage.owned = true
        }
      } else if (fx.kind === 'shadow' || fx.kind === 'inner-shadow') {
        const scalarAlpha = !!(this.optimized && this.driver.managed && this.driver.scalarAlphaFilter &&
          this.scene.integratedBlur && !this.displayFilterActive(fx.radius * scale(n.matrix)) && fx.spread === 0)
        const resolved = resolvedFirstBlur || this.run(scalarAlpha ? 49 : 23, n.rect, planes, undefined, 15, undefined, scalarAlpha)
        resolvedFirstBlur = undefined
        const inner = fx.kind === 'inner-shadow'
        const pointwise =
          fx.radius === 0 &&
          fx.spread === 0 &&
          Number.isInteger(n.matrix[0] * fx.x + n.matrix[2] * fx.y) &&
          Number.isInteger(n.matrix[1] * fx.x + n.matrix[3] * fx.y)
        const alpha =
          Math.abs(fx.spread * sc) >= 0.5
            ? this.morphology(
                resolved,
                Math.round(Math.abs(fx.spread * sc)),
                inner ? fx.spread < 0 : fx.spread > 0,
              )
            : resolved
        const blurred = this.blur(alpha, (fx.radius * sc) / 2, false, true)
        // Filtering has encoded the last read of its input. Shadow assembly
        // only needs the individual planes and blurred alpha, not the resolved
        // source/morphology intermediates. Keep aliases when blur is identity.
        if (resolved !== blurred) this.release(resolved)
        if (alpha !== blurred) this.release(alpha)
        const outputs: Surface[] = [],
          shared = new Map<Texture, Surface>()
        for (const plane of planes) {
          let next = shared.get(plane.texture)
          if (!next) {
            await this.reclaimScratch()
            const alphaSource = pointwise ? plane : blurred
            if (this.optimized && this.driver.managed && !this.driver.displayMath && this.driver.exactShadowOver &&
                exactBlendLattice([n.rect, plane.rect, alphaSource.rect])) {
              next = this.shadow(plane, alphaSource, n, fx, true)
            } else {
              const shadow = this.shadow(plane, alphaSource, n, fx)
              next = inner ? this.compose(shadow, plane) : this.compose(plane, shadow)
              this.release(shadow)
            }
            // A later aliased sample reuses this output without reading the
            // consumed input. Queue ordering protects its earlier reads.
            shared.set(plane.texture, next)
          } else next = this.retain(next)
          this.release(plane)
          outputs.push(next)
        }
        this.release(resolved, alpha, blurred)
        planes = outputs
      } else if (fx.kind === 'noise' || fx.kind === 'texture') {
        const shared = new Map<Texture, Surface>()
        const addresses = this.textureGrid(n, fx)
        const outputs: Surface[] = []
        for (const plane of planes) {
          let next = shared.get(plane.texture)
          if (!next) {
            next = this.run(
              fx.kind === 'noise' ? 7 : 8,
              n.rect,
              addresses ? [plane, addresses] : [plane],
              (u) => {
                this.transform(u, n)
                u.set(
                  [
                    fx.kind === 'noise' ? fx.amount : fx.amount * fx.opacity * 2,
                    fx.opacity,
                    fx.texture ? 1 : 0,
                    fx.texture?.clipToShape ? 1 : 0,
                  ],
                  40,
                )
              },
            )
            shared.set(plane.texture, next)
          } else next = this.retain(next)
          // No four-sample resolve is read by noise/texture. Once this pass is
          // encoded, its input can return to the queue-ordered pool. Retained
          // aliases stay pinned; later shared samples reuse the saved output.
          this.release(plane)
          outputs.push(next)
        }
        planes = outputs
      } else throw new Error(`不支持的采样效果 ${fx.kind}`)
    }
    return planes
  }
  private reapRetiredKernels() {
    const completed = this.driver.completedResourceEpoch ?? -1
    this.retiredKernels = this.retiredKernels.filter(({ texture, epoch }) => {
      if (epoch > completed) return true
      this.forgetUpload(texture)
      return false
    })
  }
  private beginKernelFrame() {
    for (const { texture } of [...this.blurKernels.values(), ...this.certifiedKernels.values()]) {
      if (this.kernelCache.has(texture)) continue
      if (this.retainKernels) this.retiredKernels.push({ texture, epoch: this.driver.resourceEpoch! })
      else this.forgetUpload(texture)
    }
    this.blurKernels.clear()
    this.certifiedKernels.clear()
    this.reapRetiredKernels()
    this.kernelBuilds = this.kernelResidentHits = this.kernelUploadBytes = 0
  }
  private filterKernel(operator: string, radius: number, build: () => Uint8Array | Float32Array,
    shape?: (values: Uint8Array | Float32Array) => [number, number]): Surface {
    const domain = [this.driver.managed ? 'float' : 'byte', !!this.driver.linearLight,
      !!this.driver.hdr, !!this.driver.certifiedFilter].join(':')
    const key = immutableKernelKey(operator, radius, domain)
    const frame = operator.startsWith('certified-') ? this.certifiedKernels : this.blurKernels
    const existing = frame.get(key)
    if (existing) return existing
    let texture = this.retainKernels ? this.kernelCache.get(key, this.driver.resourceEpoch!) : undefined
    if (texture) this.kernelResidentHits++
    else {
      const cpuKey = operator === 'certified-tent' ? `cpu-u8-v1/${key}` : undefined
      let values: Uint8Array | Float32Array | undefined = cpuKey ? this.coefficientBytes.get(cpuKey) : undefined
      if (!values) {
        values = build()
        // Only this audited Uint8Array constructor is eligible. Other kernel
        // families retain the exact existing construction path.
        if (cpuKey && values instanceof Uint8Array)
          values = this.coefficientBytes.put(cpuKey, values) || values
      }
      const [width, height] = shape ? shape(values) : [values.length / 4, 1]
      const bytes = values.byteLength * (values instanceof Uint8Array && this.driver.managed ? 4 : 1)
      if (this.overBudget(bytes, width, height)) throw this.budgetError('GPU 表面内存预算超限')
      if (values instanceof Float32Array) {
        if (!this.driver.uploadLinear) throw new Error('Backend cannot upload linear coefficients')
        texture = this.driver.uploadLinear(values, width, height)
      } else {
        if (!this.driver.uploadRgba8) throw new Error('Backend cannot upload exact coefficients')
        texture = this.driver.uploadRgba8(values, width, height)
      }
      if (operator === 'rational-tent' && values instanceof Uint8Array)
        texture.prefixRationalUnsupported = prefixRationalUnsupported(values)
      this.kernelBuilds++
      this.kernelUploadBytes += bytes
      this.bytes += texture.bytes
      this.peak = Math.max(this.peak, this.bytes)
      if (this.retainKernels) this.kernelCache.put(key, texture, this.driver.resourceEpoch!, this.driver.completedResourceEpoch!)
    }
    const surface = { texture, rect: rect(0, 0, texture.width, texture.height) }
    frame.set(key, surface)
    return surface
  }
  private certifiedKernel(radius: number, box = false) {
    if (!this.driver.certifiedFilter) return undefined
    return this.filterKernel(box ? 'certified-box' : 'certified-tent', radius,
      () => box ? certified_box_kernel_rgba(radius) : certified_tent_kernel_rgba(radius))
  }
  private exactTentAxis(input: Surface, radius: number, axis: number, output: Rect, destination?: Surface) {
    if (!(radius > 0 && radius <= 2048)) throw Error('GPU exact blur radius exceeds 2048 pixels')
    const kernel = this.filterKernel('rational-tent', radius, () => rational_tent_kernel_rgba(radius))
    const certified=this.certifiedKernel(radius)
    return this.run(22,output,[input,kernel,...(certified?[certified]:[])],u=>u.set([radius,axis,0,1],36),15,{kind:'tent',radius},false,destination)
  }
  private displayFilterActive(radius: number, channels = 15) {
    if (!this.scene.displayFilters || !this.driver.managed || !this.driver.supportsDisplayFilters) return false
    return this.driver.usesDisplayFilter ? this.driver.usesDisplayFilter(radius, channels) :
      this.scene.displayFilterRadiusLimit === undefined
  }
  private blur(input: Surface, sigma: number, clampEdges = false, alphaOnly = false): Surface {
    // Every finite normalized kernel maps the all-+0 field to itself, with
    // either transparent or clamped edges. Filter pipelines can keep using
    // physical inputs without allocating a transparent expansion first.
    if (input.texture.transparentZero) return input
    const channels = this.optimized && this.driver.managed && alphaOnly ? 8 : 15
    const displayFilter = this.displayFilterActive(sigma * 2, channels)
    const scalarAlpha = this.optimized && alphaOnly && this.driver.managed &&
      this.driver.scalarAlphaFilter && this.scene.integratedBlur && !displayFilter
    if ((input.texture.uniformColor || input.texture.scalarCoverage && !scalarAlpha) && sigma > 0) {
      // Filter kernels have independent layouts. Expand losslessly before
      // entering them rather than letting R32F's default alpha become one.
      const expanded=this.copy(input), result=this.blur(expanded,sigma,clampEdges,alphaOnly)
      if(result!==expanded)this.release(expanded)
      return result
    }
    if (displayFilter && this.scene.integratedBlur) {
      const radius = sigma * 2
      if (radius <= 0) return input
      const kernel = this.filterKernel('display-tent', radius, () => {
        const weights = displayFilterWeights(radius), height = Math.ceil(weights.length / 256)
        const data = new Float32Array(256 * height * 4)
        weights.forEach((weight, i) => { data[i * 4] = weight })
        return data
      }, values => [256, values.length / (256 * 4)])
      const horizontal = this.run(22, input.rect, [input, kernel], u => u.set([radius, 0, clampEdges ? 1 : 0, 1], 36), channels, { kind: 'tent', radius })
      const vertical = this.run(22, input.rect, [horizontal, kernel], u => u.set([radius, 1, clampEdges ? 1 : 0, 1], 36), channels, { kind: 'tent', radius })
      this.release(horizontal)
      return vertical
    }
    if (this.scene.integratedBlur) {
      const radius = this.driver.managed ? sigma * 2 : Math.fround(sigma * 2)
      if (radius <= 0) return input
      if (radius > 512) throw new Error('GPU 积分模糊半径超过 512 像素')
      let kernel: Surface | undefined
      if (this.driver.managed || !Number.isInteger(radius)) {
        kernel = this.filterKernel(this.driver.managed ? 'rational-tent' : 'quantized-tent', radius,
          () => this.driver.managed ? rational_tent_kernel_rgba(radius) : quantized_tent_kernel_rgba(radius))
      }
      const certified = this.certifiedKernel(radius)
      const horizontal = this.run(22, input.rect, kernel ? [input, kernel, ...(certified ? [certified] : [])] : [input], (u) =>
        u.set([radius, 0, clampEdges ? 1 : 0, kernel ? 1 : 0], 36), channels, this.optimized ? {kind: 'tent', radius} : undefined, scalarAlpha,
      )
      const vertical = this.run(22, input.rect, kernel ? [horizontal, kernel, ...(certified ? [certified] : [])] : [horizontal], (u) =>
        u.set([radius, 1, clampEdges ? 1 : 0, kernel ? 1 : 0], 36), channels, this.optimized ? {kind: 'tent', radius} : undefined, scalarAlpha,
      )
      this.release(horizontal)
      return vertical
    }
    let current = input
    for (const r of gaussianRadii(sigma)) {
      if (r <= 0) continue
      const kernel = this.filterKernel('rational-box', r, () => rational_box_kernel_rgba(r))
      const certified = this.certifiedKernel(r, true)
      for (const axis of [0, 1]) {
        const next = this.run(22, input.rect, [current, kernel, ...(certified ? [certified] : [])], (u) => u.set([r, axis, 0, 1], 36), channels)
        if (current !== input) this.release(current)
        current = next
      }
    }
    return current
  }
  private textureGrid(n: GpuNode, fx: Effect): Surface | undefined {
    if (fx.kind !== 'texture' || (!this.driver.managed && !fx.texture)) return undefined
    const upload = fx.texture ? this.driver.uploadParameters : this.driver.uploadLinear
    if (!upload) throw new Error('后端不支持精确纹理坐标字段')
    return this.materialField(['texture', n.rect, n.matrix, n.size, fx.texture ? [fx.radius, fx.texture] : [fx.amount, fx.opacity]], n.rect, () => fx.texture
      ? texture_material_field(JSON.stringify((n.previewSource || n).rect), new Float64Array((n.previewSource || n).matrix), JSON.stringify(fx), n.size[0] / 2, n.size[1] / 2)
      : texture_sampling_grid(JSON.stringify((n.previewSource || n).rect), new Float64Array((n.previewSource || n).matrix), fx.amount * fx.opacity * 2), upload)
  }
  private morphology(input: Surface, r: number, dilate: boolean) {
    if (!Number.isInteger(r) || r < 0 || r > 2048) throw new Error('GPU 扩展半径超过 2048 像素')
    // Every tap is an integer texel centre. Alpha is finite/nonnegative, so
    // exact bilinear sampling with zero fractional weights equals textureLoad.
    // The coordinate guard keeps half-pixel centres exactly representable.
    const integerTaps = this.optimized && this.driver.managed &&
      Object.values(input.rect).every(v => Number.isInteger(v) && Math.abs(v) < 1048576)
    let current = input
    for (const axis of [0, 1]) {
      const next = this.run(5, input.rect, [current], (u) =>
        u.set([r, axis, dilate ? 1 : 0, integerTaps ? 1 : 0], 36),
      )
      if (current !== input) this.release(current)
      current = next
    }
    return current
  }
  private async gradientBlur(sharp:Surface, blurred:Surface, n:GpuNode, fx:Effect):Promise<Surface> {
    if(!fx.gradientBlur)return blurred
    const values = gradient_blur_composite_uniforms(
      JSON.stringify(sharp.rect), new Float64Array(n.matrix), JSON.stringify(fx.gradientBlur),
    )
    return this.run(46, sharp.rect, [sharp, blurred], u => {
      u.set(values.subarray(0, 4), 36)
      u.set(values.subarray(4, 6), 40)
    })
  }
  private glass(
    backdrop: Surface,
    mask: Surface,
    n: GpuNode,
    fx: Effect,
    unmasked = false,
    sample = -1,
  ) {
    if (n.glassShape && fx.glass) {
      const region = n.rect
      const upload = this.driver.uploadParameters
      if (!upload) throw new Error('后端不支持玻璃几何参数')
      const fieldRegion=import.meta.env.VITE_DESIGN_EFFECT_REGIONS!=='0'&&!this.interactionCapturing
        ?interactionEffectRegion(this.scene,region,2):region
      if(!this.scene.disableSparseGlass&&this.driver.managed&&(this.scene.nativeInteraction&&!this.scene.coherentSamples||
          import.meta.env.VITE_DESIGN_COHERENT_SPARSE_GLASS==='1')&&!this.scene.softwareRaster&&
          !n.captureReplay&&import.meta.env.VITE_DESIGN_SPARSE_GLASS!=='0') {
        const started=performance.now()
        const plan=JSON.parse(glass_geometry_interior(JSON.stringify(region),JSON.stringify(fieldRegion),new Float64Array(n.matrix),
          JSON.stringify(n.glassShape),JSON.stringify(fx),sample)) as {interior:Rect;value:number[]}|null
        this.fieldBuildMs+=performance.now()-started
        if(plan&&plan.interior.w*plan.interior.h>fieldRegion.w*fieldRegion.h*.5)
          return this.sparseGlass(backdrop,mask,n,fx,fieldRegion,plan,unmasked,sample)
      }
      const field = this.materialField(['glass', region, fieldRegion, n.matrix, n.glassShape, fx.glass, sample,
        !!this.scene.softwareRaster], fieldRegion, () => glass_geometry_field(
          JSON.stringify(fieldRegion), new Float64Array(n.matrix), JSON.stringify(n.glassShape),
          JSON.stringify(fx), sample, !!this.scene.softwareRaster, JSON.stringify(region),
        ), upload)
      const texture = field.texture
      if (!this.driver.managed && n.captureReplay && sample >= 0) {
        const captured = this.capturedGlass(field, mask, n, fx, unmasked, sample)
        this.retireUpload(texture)
        return captured
      }
      const offset =
        sample < 0
          ? [0, 0]
          : [
              [-0.125, -0.375],
              [0.375, -0.125],
              [-0.375, 0.125],
              [0.125, 0.375],
            ][sample]
      const out = this.run(34, region, [backdrop, field, mask], (u) => {
        u[39] = unmasked ? 1 : 0
        // The sampled, unmasked callers immediately compose with this same
        // mask (mode 3) before any filtering. At zero coverage over() returns
        // the destination without reading source RGB. Restrict the shortcut
        // to integer regions whose half-pixel centers are exact in f32;
        // fractional/large coordinates can make smp() read adjacent texels.
        const samePixel = [region, mask.rect].every(r =>
          [r.x, r.y, r.w, r.h].every(Number.isInteger) &&
          Math.max(Math.abs(r.x), Math.abs(r.y), Math.abs(r.x + r.w), Math.abs(r.y + r.h)) < 2 ** 22)
        u[41] = this.driver.managed && unmasked && sample >= 0 && samePixel ? 1 : 0
        u[40] = glass_material_uniforms(JSON.stringify(fx), scale(n.matrix))[4]
        u.set(offset, 44)
        u[46] = 3
        u[47] = 8
      })
      // The geometry field is consumed by the pass above (or by capturedGlass
      // before this point) and every leaf sample uploads its own: retire it
      // immediately so it cannot accumulate in coordinateMaps until frame
      // end. It stays alive until a completed checkpoint destroys it; it must
      // never re-enter the colour pool, whose reuse discipline only covers
      // encoder writes, not queue writeTexture uploads.
      this.retireUpload(texture)
      return out
    }
    const s = scale(n.matrix)
    let field = this.run(9, n.rect, [mask])
    let step = 2 ** Math.ceil(Math.log2(Math.max(n.rect.w, n.rect.h))) / 2
    while (step >= 1) {
      const next = this.run(10, n.rect, [field], (u) => {
        u[36] = step
      })
      this.release(field)
      field = next
      step /= 2
    }
    const out = this.run(11, n.rect, [backdrop, field, mask], (u) => {
      u.set([Math.max(4, fx.radius * s * 2), fx.amount * s, fx.opacity, unmasked ? 1 : 0], 36)
      if (fx.glass) {
        const values = glass_material_uniforms(JSON.stringify(fx), s)
        u.set(values.subarray(0, 3), 36)
        u.set(values.subarray(4, 9), 40)
      }
    })
    this.release(field)
    return out
  }
  private sparseGlass(backdrop:Surface,mask:Surface,n:GpuNode,fx:Effect,fieldRegion:Rect,
    plan:{interior:Rect;value:number[]},unmasked:boolean,sample:number):Surface {
    const region=n.rect,out=this.acquire(region),scissor=this.drawRegion(region)
    this.driver.clear(out.texture)
    const draw=scissor?{x:region.x+scissor.x,y:region.y+scissor.y,w:scissor.w,h:scissor.h}:region
    const interior=intersect(draw,plan.interior)
    const pieces=[...rectangleBorder(draw,interior),interior].filter(r=>r.w>0&&r.h>0)
    const offset=sample<0?[0,0]:[[-.125,-.375],[.375,-.125],[-.375,.125],[.125,.375]][sample]
    for(const piece of pieces) {
      const constant=piece===interior,fieldBounds=intersect(piece,fieldRegion)
      let field:Surface|undefined
      if(!constant&&fieldBounds.w&&fieldBounds.h)field=this.materialField(['glass-border',region,fieldBounds,n.matrix,n.glassShape,fx.glass,sample],fieldBounds,
        ()=>glass_geometry_field(JSON.stringify(fieldBounds),new Float64Array(n.matrix),JSON.stringify(n.glassShape),JSON.stringify(fx),sample,false,JSON.stringify(region)),this.driver.uploadParameters!)
      const u=parameters(region,backdrop.rect,field?.rect||fieldRegion,mask.rect)
      u[16]=34;u[39]=unmasked?1:0;u[40]=glass_material_uniforms(JSON.stringify(fx),scale(n.matrix))[4]
      u.set(offset,44);u[46]=3;u[47]=8
      if(!field){u[48]=2;u.set(constant?plan.value:[0,0,0,0],52)}
      this.driver.pass(out.texture,u,[backdrop.texture,field?.texture||mask.texture,mask.texture],
        {x:piece.x-region.x,y:piece.y-region.y,w:piece.w,h:piece.h})
      this.passPixels+=piece.w*piece.h
      if(field)this.retireUpload(field.texture)
    }
    return out
  }
  private retainTextureData(texture: Texture, r: Rect): Surface {
    this.bytes += texture.bytes
    this.peak = Math.max(this.peak, this.bytes)
    this.busy.add(texture)
    this.used.add(texture)
    this.touch(texture)
    this.coordinateMaps.add(texture)
    return { texture, rect: r }
  }
  private textureFieldRect(r: Rect, side?: number): Rect {
    if (
      !r ||
      ![r.x, r.y, r.w, r.h].every(Number.isSafeInteger) ||
      r.w < 1 ||
      r.h < 1 ||
      r.w > 1024 ||
      r.h > 1024 ||
      Math.abs(r.x) > 16_777_216 ||
      Math.abs(r.y) > 16_777_216 ||
      (side !== undefined && (r.x < 0 || r.y < 0 || r.x + r.w > side || r.y + r.h > side))
    )
      throw new Error('无效的纹理重放参数范围')
    return r
  }
  private replayField(
    n: GpuNode,
    viewport: Rect,
    origin: [number, number],
    sample: number,
    kind: number,
    r: Rect,
  ): Surface {
    this.textureFieldRect(r)
    const reusable = this.driver.uploadReplayParameters
    if (!reusable && !this.driver.uploadParameters) throw new Error('后端不支持纹理重放参数')
    const bytes = reusable ? (this.replayParameters ? 0 : 1024 * 1024 * 16) : r.w * r.h * 16
    if (this.overBudget(bytes)) throw this.budgetError('GPU 表面内存预算超限')
    const values = texture_replay_field(
      JSON.stringify(n.textureReplay),
      JSON.stringify(viewport),
      new Int32Array(origin),
      sample,
      kind,
    )
    if (values.length !== r.w * r.h * 4) throw new Error('纹理重放参数长度不一致')
    if (reusable) {
      const texture = reusable.call(this.driver, values, r.w, r.h, this.replayParameters)
      if (this.replayParameters && texture !== this.replayParameters)
        throw new Error('纹理重放参数缓冲区未复用')
      if (!this.replayParameters) {
        this.replayParameters = texture
        this.retainTextureData(texture, rect(0, 0, 1024, 1024))
      } else this.touch(texture)
      return { texture, rect: r }
    }
    return this.retainTextureData(this.driver.uploadParameters!(values, r.w, r.h), r)
  }
  private textureClipMath(): Surface {
    if (this.textureMath) {
      this.touch(this.textureMath.texture)
      return this.textureMath
    }
    if (!this.driver.uploadRgba8) throw new Error('后端不支持纹理裁剪数学表')
    const bytes = 1024 * 1024 * 4
    if (this.overBudget(bytes)) throw this.budgetError('GPU 表面内存预算超限')
    const values = texture_clip_math_atlas()
    if (values.length !== bytes) throw new Error('纹理裁剪数学表长度不一致')
    this.textureMath = this.retainTextureData(
      this.driver.uploadRgba8(values, 1024, 1024),
      rect(0, 0, 1024, 1024),
    )
    return this.textureMath
  }
  private replaySource(
    n: GpuNode,
    plan: TextureSourcePlan,
    viewport: Rect,
    origin: [number, number],
    sample: number,
    kind: number,
  ): Surface {
    if (plan.side !== (kind === 0 ? 1024 : 512)) throw new Error('纹理源尺寸不一致')
    this.textureFieldRect(plan.coverage, plan.side)
    const sourceRect = rect(0, 0, plan.side, plan.side)
    const source = this.empty(sourceRect)
    if (plan.paint.kind === 'solid') {
      const u = parameters(sourceRect)
      u[16] = 12
      u.set([...this.color(plan.paint.color), 1], 48)
      this.driver.pass(source.texture, u, [], plan.coverage)
    } else {
      if (plan.paint.kind !== 'linear') throw new Error('不支持的纹理源画笔')
      const key = JSON.stringify(plan.paint)
      let lookup = this.textureLookups.get(key)
      if (!lookup) {
        if (!this.driver.uploadRgba8) throw new Error('后端不支持纹理渐变查找表')
        if (this.overBudget(8192, 1024, 2)) throw this.budgetError('GPU 表面内存预算超限')
        const values = figma_gradient_lookup(key)
        if (values.length !== 8192) throw new Error('纹理渐变查找表长度不一致')
        lookup = this.retainTextureData(
          this.driver.uploadRgba8(values, 1024, 2),
          rect(0, 0, 1024, 2),
        )
        this.textureLookups.set(key, lookup)
      } else this.touch(lookup.texture)
      const field = this.replayField(n, viewport, origin, sample, kind, plan.coverage)
      const u = parameters(sourceRect, lookup.rect, field.rect)
      u[16] = 45
      u[32] = plan.paint.opacity
      this.driver.pass(source.texture, u, [lookup.texture, field.texture], plan.coverage)
    }
    this.passPixels += plan.coverage.w * plan.coverage.h
    return source
  }
  private replayTextureTile(
    n: GpuNode,
    plan: TextureReplayPlan,
    target: Surface,
    sample: number,
    parentClip?: Surface,
  ) {
    const capture = plan.capture
    if (
      capture.capturePixels !== 1024 ||
      !Number.isFinite(capture.scale) ||
      capture.scale <= 0 ||
      capture.scale > 1 ||
      capture.nodeToTile.length !== 6 ||
      !capture.nodeToTile.every(Number.isFinite) ||
      (plan.original ? capture.originalPixels !== 512 : capture.originalPixels !== null)
    )
      throw new Error('无效的纹理捕获计划')
    const expanded = this.replaySource(n, plan.expanded, target.rect, plan.origin, sample, 0)
    const original = plan.original
      ? this.replaySource(n, plan.original, target.rect, plan.origin, sample, 1)
      : undefined
    const effectRect = rect(0, 0, capture.capturePixels, capture.capturePixels)
    const r = capture.effectRect
    const fieldRect = this.textureFieldRect(intersect(rect(r[0], r[1], r[2], r[3]), effectRect))
    const field = this.replayField(n, target.rect, plan.origin, sample, 2, fieldRect)
    const math = this.textureClipMath()
    const effect = this.empty(effectRect)
    const u = parameters(effectRect, expanded.rect, (original || expanded).rect, field.rect)
    u[16] = 43
    u.set([capture.scale, capture.clipped ? 1 : 0, original ? 1 : 0, capture.capturePixels], 36)
    u.set(capture.nodeToTile, 40)
    this.driver.pass(
      effect.texture,
      u,
      [expanded.texture, (original || expanded).texture, field.texture, math.texture],
      fieldRect,
    )
    this.passPixels += fieldRect.w * fieldRect.h
    this.release(expanded, original)
    const coordinates = this.replayField(
      n,
      target.rect,
      plan.origin,
      sample,
      3,
      plan.copybackRegion,
    )
    let region = intersect(plan.copybackRegion, target.rect)
    if (parentClip) region = intersect(region, parentClip.rect)
    if (region.w && region.h) {
      const copy = parameters(target.rect, effect.rect, coordinates.rect, parentClip?.rect)
      copy[16] = 44
      copy[19] = parentClip ? 1 : 0
      const textures = [effect.texture, coordinates.texture]
      if (parentClip) textures.push(parentClip.texture)
      // The effect sample remains float through fixed-function parent blending.
      // Only the root frame clip applies; never reuse the leaf's shape mask.
      this.driver.over(
        target.texture,
        copy,
        textures,
        rect(region.x - target.rect.x, region.y - target.rect.y, region.w, region.h),
      )
      this.passPixels += region.w * region.h
    }
    this.release(effect)
  }
  private replayTexture(n: GpuNode, targets: Surface[], clip?: Surface[]): boolean {
    if (!n.textureReplay) return false
    if (this.driver.managed || targets.length !== 4) throw new Error('纹理重放要求四个 SDR 采样面')
    const getTiles = (sample: number): TextureReplayTile[] => {
      const value = JSON.parse(
        texture_replay_tiles(
          JSON.stringify(n.textureReplay),
          JSON.stringify(targets[sample].rect),
          sample,
        ),
      ) as TextureReplayTile[]
      if (!Array.isArray(value)) throw new Error('无效的纹理重放瓦片列表')
      for (const tile of value) {
        if (
          !tile.origin ||
          tile.origin.length !== 2 ||
          !tile.origin.every(Number.isSafeInteger) ||
          !tile.outcome ||
          !['empty', 'passthrough', 'unsupported', 'capture'].includes(tile.outcome.kind)
        )
          throw new Error('无效的纹理重放瓦片')
      }
      return value
    }
    let capture = false
    let passthrough = false
    let unsupported = false
    for (let sample = 0; sample < 4; sample++) {
      for (const tile of getTiles(sample)) {
        capture ||= tile.outcome.kind === 'capture'
        passthrough ||= tile.outcome.kind === 'passthrough'
        unsupported ||= tile.outcome.kind === 'unsupported'
      }
    }
    if (unsupported) return false
    if (capture && passthrough) throw new Error('纹理捕获与直绘瓦片不能混用')
    if (passthrough) {
      for (let sample = 0; sample < 4; sample++) {
        this.sampleIndex = sample
        const mask = this.mask(n.fill)
        const combined = clip ? this.combine(mask, clip[sample], n.rect) : undefined
        for (const paint of n.fills) {
          if (paint.visible)
            targets[sample] = this.paintOver(n, paint, combined || mask, targets[sample])
        }
        this.release(combined)
      }
      return true
    }
    for (let sample = 0; sample < 4; sample++) {
      this.sampleIndex = sample
      for (const tile of getTiles(sample)) {
        if (tile.outcome.kind === 'capture')
          this.replayTextureTile(n, tile.outcome.plan, targets[sample], sample, clip?.[sample])
        else if (tile.outcome.kind !== 'empty') throw new Error('纹理重放计划在绘制前后不一致')
      }
    }
    this.orderedEffectLayers++
    return true
  }
  private capturedGlass(
    field: Surface,
    mask: Surface,
    n: GpuNode,
    fx: Effect,
    unmasked: boolean,
    sample: number,
  ) {
    const tiles: GlassCaptureTile[] = JSON.parse(
      glass_capture_tiles(JSON.stringify(n.captureReplay), JSON.stringify(n.rect), sample),
    )
    const out = this.empty(n.rect)
    const dispersion = glass_material_uniforms(JSON.stringify(fx), scale(n.matrix))[4]
    for (const { region, plan, filter } of tiles) {
      const captureRect = rect(0, 0, plan.side, plan.side)
      const source = this.empty(captureRect)
      for (const primitive of plan.primitives) {
        const u = parameters(captureRect)
        u[16] = 12
        u.set(primitive.color, 48)
        this.driver.pass(source.texture, u, [], primitive.rect)
        this.passPixels += primitive.rect.w * primitive.rect.h
      }
      const down = this.empty(captureRect)
      if (filter.downRect.w && filter.downRect.h) {
        const u = parameters(captureRect, source.rect)
        u[16] = 40
        u.set([...filter.origin, ...filter.gradient, ...filter.sourceOrigin], 36)
        this.driver.pass(down.texture, u, [source.texture], filter.downRect)
        this.passPixels += filter.downRect.w * filter.downRect.h
      }
      this.release(source)
      const horizontal = this.empty(captureRect)
      if (filter.blurRect.w && filter.blurRect.h) {
        const u = parameters(captureRect, down.rect)
        u[16] = 41
        u.set([plan.kernelCount, 0, 64], 36)
        this.driver.pass(horizontal.texture, u, [down.texture], filter.blurRect)
        this.passPixels += filter.blurRect.w * filter.blurRect.h
      }
      this.release(down)
      const captured = this.empty(captureRect)
      if (filter.blurRect.w && filter.blurRect.h) {
        const u = parameters(captureRect, horizontal.rect)
        u[16] = 41
        u.set([plan.kernelCount, 1, 64], 36)
        this.driver.pass(captured.texture, u, [horizontal.texture], filter.blurRect)
        this.passPixels += filter.blurRect.w * filter.blurRect.h
      }
      this.release(horizontal)
      const u = parameters(n.rect, captureRect, field.rect, mask.rect)
      u[16] = 34
      u[39] = unmasked ? 1 : 0
      u[40] = dispersion
      u[46] = 3
      u[47] = 8
      u.set([1, ...plan.origin, plan.density], 48)
      // Driver regions address the destination texture, whereas tile regions
      // and the optical geometry field use global device coordinates.
      this.driver.pass(
        out.texture,
        u,
        [captured.texture, field.texture, mask.texture],
        rect(region.x - n.rect.x, region.y - n.rect.y, region.w, region.h),
      )
      this.passPixels += region.w * region.h
      this.release(captured)
    }
    return out
  }
  private async node(id: string, backdrop: Surface, skipEffects = false): Promise<Surface | undefined> {
    const n = this.scene.nodes[id]
    if (!n) return
    let fill: Surface | undefined
    const background = skipEffects ? undefined : backdropEffect(n.effects)
    const directBackdrop = !!background && background.kind === 'background-blur' && !n.passthrough &&
      this.optimized && this.driver.managed && this.scene.interactionRetained &&
      import.meta.env.VITE_DESIGN_DIRECT_BACKDROP !== '0'
    let layer: Surface
    if(directBackdrop){
      // Background blur over a transparent isolated source is exactly its
      // masked contribution. Avoid allocating a blank full-size destination
      // and release the capture after the blur's final read is encoded, so
      // the output can reuse that storage in queue order.
      fill=this.mask(n.fill)
      const blurred=this.interactionBackdrop(n,backdrop,(backdropRadius(background!) * scale(n.matrix))/2)
      layer=this.run(15,n.rect,[blurred,blurred,fill],u=>u.set([15,0,1,1],16))
      this.release(blurred)
    }else layer=n.passthrough ? this.copy(backdrop,n.rect) : this.empty(n.rect)
    if (n.fills.length || n.clip || background) fill = this.mask(n.fill)
    if (background && fill && !directBackdrop) {
      const blur = this.interactionBackdrop(n,backdrop,(backdropRadius(background) * scale(n.matrix)) / 2)
      const next =
        background.kind === 'glass'
          ? this.glass(blur, fill, n, background)
          : this.compose(blur, layer, 'normal', 1, fill)
      this.release(blur, layer)
      layer = next
    }
    for (const p of n.fills) {
      if (!p.visible) continue
      const painted = this.paint(n, p, fill || this.mask(n.fill))
      if(this.driver.managed&&this.scene.interactionRetained)
        await this.reclaimForSurface(layer.rect)
      const next = this.merge(painted, layer, p.blend)
      this.release(painted)
      layer = next
    }
    const clip = n.clip ? fill : undefined
    const maskId = n.maskId || n.children.find((id) => this.scene.nodes[id]?.mask)
    let maskSurface: Surface | undefined
    if (maskId) {
      const empty = this.empty(n.rect),
        raw = await this.nodeSource(maskId, empty)
      if (raw) {
        maskSurface = this.compose(raw, empty, 'normal', this.scene.nodes[maskId].opacity)
        if (this.scene.nodes[maskId].maskType === 'luminance') {
          const next = this.run(30, maskSurface.rect, [maskSurface])
          this.release(maskSurface)
          maskSurface = next
        }
        this.release(raw)
        this.release(empty)
      } else maskSurface = empty
    }
    if (maskSurface) {
      const content = await this.drawList(
        n.children,
        n.passthrough ? this.copy(layer) : this.empty(n.rect),
        clip,
        maskId,
      )
      const combined = n.passthrough
        ? this.interpolate(content, layer, 1, maskSurface)
        : this.compose(content, layer, 'normal', 1, maskSurface)
      this.release(layer, content)
      layer = combined
    } else layer = await this.drawList(n.children, layer, clip, maskId)
    if (clip && clip !== fill && clip !== maskSurface) this.release(clip)
    this.release(maskSurface)
    for (const s of n.strokes) {
      let strokeMask = this.mask(s.path)
      let clipped: Surface | undefined
      if (s.align !== 'center') {
        clipped = this.combine(strokeMask, fill || this.mask(n.fill), n.rect, s.align === 'outside')
        strokeMask = clipped
      }
      const painted = this.paint(n, s.paint, strokeMask)
      if(this.driver.managed&&this.scene.interactionRetained)
        await this.reclaimForSurface(layer.rect)
      const next = this.merge(painted, layer, s.paint.blend)
      this.release(painted, clipped)
      layer = next
    }
    const sc = scale(n.matrix)
    for (const fx of n.effects) {
      if (
        !fx.visible ||
        skipEffects ||
        (fx.kind === 'texture' &&
          (fx.texture ? fx.radius === 0 : fx.amount === 0 || fx.opacity === 0))
      )
        continue
      if (fx.kind === 'blur') {
        const full=this.blur(layer,(fx.radius*Math.max(1,fx.gradientBlur?.startCount??1,fx.gradientBlur?.endCount??1)*sc)/2)
        const next=await this.gradientBlur(layer,full,n,fx)
        if(next!==full && full!==layer)this.release(full)
        if(next!==layer)this.release(layer)
        layer=next
      } else if (fx.kind === 'shadow' || fx.kind === 'inner-shadow') {
        let alpha = layer
        const inner = fx.kind === 'inner-shadow'
        if (Math.abs(fx.spread * sc) >= 0.5)
          alpha = this.morphology(
            layer,
            Math.round(Math.abs(fx.spread * sc)),
            inner ? fx.spread < 0 : fx.spread > 0,
          )
        const blur = this.blur(alpha, (fx.radius * sc) / 2, false, true)
        const shadow = this.run(6, n.rect, [layer, blur], (u) => {
          u.set([0, ...this.color(fx.color)], 28)
          u[32] = fx.opacity * this.alpha(fx.color)
          u.set(
            [
              this.scene.integratedBlur ? 1 : 0,
              n.matrix[0] * fx.x + n.matrix[2] * fx.y,
              n.matrix[1] * fx.x + n.matrix[3] * fx.y,
              inner ? 1 : 0,
            ],
            36,
          )
        })
        const next = inner ? this.compose(shadow, layer) : this.compose(layer, shadow)
        this.release(layer, alpha, blur, shadow)
        layer = next
      } else if (fx.kind === 'noise' || fx.kind === 'texture') {
        const addresses = this.textureGrid(n, fx)
        const next = this.run(
          fx.kind === 'noise' ? 7 : 8,
          n.rect,
          addresses ? [layer, addresses] : [layer],
          (u) => {
            this.transform(u, n)
            u.set(
              [
                fx.kind === 'noise' ? fx.amount : fx.amount * fx.opacity * 2,
                fx.opacity,
                fx.texture ? 1 : 0,
                fx.texture?.clipToShape ? 1 : 0,
              ],
              40,
            )
          },
        )
        this.release(layer)
        layer = next
      }
    }
    return layer
  }
  async abortFrameAndReleaseFilterScratch(reason: 'admission' | 'cancel' = 'admission') {
    const abort = this.driver.abortFrameAndReleaseFilterScratch
    if (!abort) throw new Error('GPU frame abort is unavailable')
    const reserved = this.driver.scratchBytes || 0
    try { await abort.call(this.driver, reason) }
    finally { this.bytes += (this.driver.scratchBytes || 0) - reserved }
  }
  async render(scene: GpuScene, readback = false, present = true, isCurrent?: () => boolean) {
    // Cancellation requires an explicit encoder-abandon/completion boundary.
    // WebGL and older drivers retain their existing completed-frame checks.
    this.frameCurrent = this.driver.abortFrameAndReleaseFilterScratch ? isCurrent : undefined
    this.nestedPrefixPressure = false
    try { this.checkFrameCurrent(); return await this.renderAttempt(scene, readback, present) }
    catch (error) {
      this.horizontalFilters.clear()
      const reserved = this.driver.scratchBytes || 0
      if (!(error instanceof Error) || error.message !== 'GPU 表面内存预算超限' ||
          (!reserved && !this.nestedPrefixPressure) || !this.driver.abortFrameAndReleaseFilterScratch) throw error
      // Drop unsubmitted commands, wait for submitted references, then retire
      // scratch. The original exact graph gets one attempt at its old capacity.
      await this.abortFrameAndReleaseFilterScratch()
      if (this.driver.scratchBytes) throw new Error('Prefix scratch was not retired after frame abort')
      this.prefixAllowed = !reserved
      this.nestedPrefixAllowed = false
      console.debug('DESIGN_GPU_PREFIX_BUDGET_FALLBACK ' + JSON.stringify({ reserved, extent: scene.extent }))
      try { return await this.renderAttempt(scene, readback, present) }
      finally { this.prefixAllowed = true; this.nestedPrefixAllowed = true }
    } finally { this.frameCurrent = undefined }
  }
  private async renderAttempt(scene: GpuScene, readback = false, present = true) {
    // A display sampler never changes exact readback/export/reference output,
    // even when a caller reuses a previously displayed compiled scene object.
    if (scene.displayImageSource && (readback || !present || this.driver.hdr))
      scene = { ...scene, displayImageSource: false }
    if (scene.displayMaterialSource && (readback || !present || this.driver.hdr))
      scene = { ...scene, displayMaterialSource: false }
    if (scene.sequentialDisplay && (readback || !present || this.driver.hdr))
      scene = { ...scene, sequentialDisplay: false }
    if (!scene.displayMaterialSource) this.retireDisplayMaterial()
    if (scene.displayFilterRadiusLimit !== undefined && (readback || !present || this.driver.hdr))
      scene = { ...scene, displayFilters: false, displayFilterRadiusLimit: undefined }
    const arithmetic = JSON.stringify([!!scene.displayFilters, scene.displayFilterRadiusLimit ?? null,
      !!scene.displayImageSource, !!scene.displayMaterialSource, !!scene.sequentialDisplay])
    if (this.interactionArithmetic && this.interactionArithmetic !== arithmetic) this.interactionInvalid = true
    this.interactionArithmetic = arithmetic
    this.horizontalFilters.begin(scene.filterBatchLease)
    // A tile origin/crop is part of each entry, not a reason to discard other
    // completed tiles. Zoom and arithmetic-policy changes retire the batch.
    this.staticImageBlurs.begin(import.meta.env.VITE_DESIGN_STATIC_IMAGE_BLUR_CACHE === '1' ? exactFilterKey([
      scene.view.zoom, scene.colorManagement, scene.floatCompositing, scene.coherentSamples, scene.integratedBlur,
      scene.compactImageFields, scene.displayFilters, scene.displayFilterRadiusLimit,
      scene.displayImageSource, scene.displayMaterialSource, scene.softwareRaster, scene.resolve?.scale, scene.presentation?.scale,
      this.driver.name, this.driver.linearLight, this.driver.hdr, this.driver.certifiedFilter,
      import.meta.env.VITE_DESIGN_IMAGE_AXES !== '0', import.meta.env.VITE_DESIGN_STREAM_IMAGE_FIELDS !== '0',
      import.meta.env.VITE_DESIGN_EXACT_IMAGE_X_TABLE !== '0', import.meta.env.VITE_DESIGN_WHOLE_IMAGE_FILTER !== '0',
    ]) : undefined, this.driver.completedResourceEpoch)
    this.staticImageBlurEligible = this.staticImageBlurHits = this.staticImageBlurPixels = 0
    this.imageXTableBuilds = this.imageXTablePixels = this.imageXTableBytes = 0
    this.wholeFilterAxes = 0
    this.horizontalFilterHits = this.horizontalFilterPixels = this.horizontalFilterRows = 0
    this.encodeYield.begin()
    this.lastBudgetFailure = undefined
    // Surface storage is RGBA32F in both arithmetic modes. Exact desktop
    // shaders must not silently lose the resident viewport's dynamic budget
    // merely because native f32 display arithmetic is disabled.
    const nativeDisplay = !!(this.driver.captureDisplay && !scene.coherentSamples)
    const workingTarget = scene.interactionWindow || scene.output || scene.extent
    const opticalPixels = nativeDisplay && scene.nativeInteraction && import.meta.env.VITE_DESIGN_OPTICAL_HEADROOM==='1'
      ?Object.values(scene.nodes).reduce((largest,n)=>n.effects.some(e=>e.visible&&(e.kind==='glass'||e.kind==='background-blur'))
        ?Math.max(largest,intersect(n.rect,scene.extent).w*intersect(n.rect,scene.extent).h):largest,0):0
    this.frameBudget = workingSetBudget(workingTarget.w, workingTarget.h, nativeDisplay, opticalPixels, this.gpuWorkingBudgetMiB)

    if (!!(scene.floatCompositing || scene.colorManagement) !== !!this.driver.managed)
      throw new Error('GPU 纹理精度与文档色彩空间不一致')
    if (scene.version !== 7 && scene.version !== 8) throw new Error('不支持的 GPU 命令版本')
    if (scene.version === 8 && !scene.output) throw new Error('GPU 区域命令缺少输出矩形')
    const index = sceneIndex(scene)
    if (
      index.hasReplay &&
      (this.driver.managed || !scene.coherentSamples)
    )
      throw new Error('纹理重放要求四个 SDR 采样面')
    if (this.driver.lost) throw new Error('GPU 设备已丢失')
    this.nativeChanging.clear()
    if (scene.nativeInteraction && import.meta.env.VITE_DESIGN_NATIVE_TRANSIENT_CACHE !== '0') {
      // Exact coverage changes with every fractional native pose. Capturing
      // these sources only to discard them next pose adds copies and memory
      // pressure, unlike the unchanged siblings which remain worth retaining.
      const stack=[...(scene.interactionSelection || [])]
      while(stack.length){const id=stack.pop()!;if(this.nativeChanging.has(id))continue
        this.nativeChanging.add(id);stack.push(...(scene.nodes[id]?.children || []))}
      for(const id of scene.interactionSelection || []){let parent=index.parents.get(id)
        while(parent){this.nativeChanging.add(parent);parent=index.parents.get(parent)}}
    }
    const retainRoots = this.optimized && this.driver.managed && scene.interactionRetained === true
    if (this.interactionInvalid || !retainRoots || this.nestedPrefix?.plan.lease !== scene.interactionLease)
      this.retireNestedPrefix()
    // Canvas tiles and transient movement share this renderer/device. A
    // settled tile must not evict the selection's warmed subtree textures.
    // The next interaction scene validates identity and retires stale roots.
    if (retainRoots || this.interactionInvalid)
      this.retireInteractionRoots(retainRoots && !this.interactionInvalid
        ? index.sources : undefined)
    if(this.interactionInvalid)this.retireInteractionPrefix()
    if(this.interactionInvalid||retainRoots&&this.movingBackdrop?.lease!==scene.interactionLease)this.releaseMovingBackdrop()
    if(this.interactionInvalid||retainRoots&&this.stationaryBackdrop?.lease!==(scene.interactionLease||index))this.retireStationaryBackdrop()
    this.interactionInvalid = false; this.interactionHits = 0; this.prefixHits = 0
    this.interactionWarm = !!retainRoots && this.interactionRoots.size > 0
    this.imageAxisFields = this.imageFieldBytes = 0
    this.beginKernelFrame()
    const trimLarge=nativeDisplay&&scene.nativeInteraction&&import.meta.env.VITE_DESIGN_TRIM_LARGE_POOL==='1'
    const upcomingLargeSizes=trimLarge?new Set([scene.extent,scene.output,workingTarget,...Object.values(scene.nodes).map(n=>n.rect)]
      .filter((r):r is Rect=>!!r).map(r=>`${r.w}:${r.h}`)):undefined
    // Reclaim sizes no longer used after a resize/zoom. The previous frame has
    // completed; destroying textures while its command buffer is pending is unsafe.
    for (const [key, list] of this.free) {
      let largeKept=0
      const retained = list.filter((t) => {
        if (this.used.has(t)&&(!trimLarge||t.bytes<=8*1024*1024||
          upcomingLargeSizes!.has(`${t.width}:${t.height}`)&&largeKept++<2)) return true
        this.driver.destroy(t)
        this.bytes -= t.bytes
        this.lastUsed.delete(t)
        return false
      })
      if (retained.length) this.free.set(key, retained)
      else this.free.delete(key)
    }
    this.used.clear()
    this.coverage.begin()
    this.materialFields.begin()
    this.fieldHits = this.fieldBuilds = this.fieldBuildMs = this.fieldUploadBytes = 0
    this.scene = scene
    this.passPixels = 0
    this.checkpointMs = 0
    this.maskHits = 0
    this.maskRasterizations = 0
    this.backdropReads = 0
    this.orderedEffectLayers = 0
    const started = performance.now()
    // Scene policy is installed synchronously before its async pipeline work.
    // Filter programs and image uploads can then prepare independently.
    const preparation = [this.driver.prepareScene?.(scene)]
    if (index.hasFilters)
      preparation.push(this.driver.prepareFilters?.(Boolean(this.prefixAllowed && this.optimized && this.driver.managed && scene.integratedBlur && index.hasPrefixFilter)))
    preparation.push(this.loadImages(scene))
    const prepared = await Promise.allSettled(preparation)
    const prepareFailure = prepared.find(result => result.status === 'rejected')
    if (prepareFailure?.status === 'rejected') throw prepareFailure.reason
    const vertices = scene.vertices instanceof Float32Array ? scene.vertices : new Float32Array(scene.vertices)
    this.meshBits = new Uint32Array(vertices.buffer, vertices.byteOffset, vertices.length)
    const curves = scene.curves instanceof Float32Array ? scene.curves : new Float32Array(scene.curves || [])
    this.curveBits = new Uint32Array(curves.buffer, curves.byteOffset, curves.length)
    this.hybridEffects = 0
    this.checkFrameCurrent()
    this.driver.begin(vertices, curves)
    this.masks.clear()
    this.independentSampleNodes.clear()
    this.maskOwners.clear()
    let target: Surface | undefined
    let completed = false
    try {
      if (scene.sequentialDisplay) {
        target = await this.sequentialViewport(scene, scene.output || rect(0, 0, scene.width, scene.height), readback, present)
      } else {
      let planes: Surface[] = []
      // Managed composition always writes a fresh target (hardware blending is
      // disabled). The initial grid/background has no sample-dependent inputs,
      // so all four planes may borrow one immutable source until composition.
      // This removes three whole halo-expanded RGBA32F allocations, without
      // resolving or quantizing any sample colors.
      const sharedBackground = this.optimized && this.driver.managed &&
        scene.coherentSamples && !this.allowSolidBatch
      const uniformBackground = this.optimized && this.driver.managed && !this.allowSolidBatch &&
        this.driver.constantTextureSampling && ((!scene.grid && !scene.checkerboard) || scene.transparent)
      for (let sample = 0; sample < (scene.coherentSamples && !sharedBackground ? 4 : 1); sample++) {
        this.sampleIndex = scene.coherentSamples ? sample : undefined
        let plane = this.run(12, uniformBackground ? rect(0,0,1,1) : scene.extent, [], (u) => {
          if (scene.checkerboard && !scene.transparent)
            u.set([...this.color('#eeeeee'), scene.checkerboardSize || 16], 52)
          u.set(
            [...this.color(scene.background), scene.transparent ? 0 : this.alpha(scene.background)],
            48,
          )
          u.set(
            [scene.view.x, scene.view.y, scene.view.zoom, scene.grid && !scene.transparent ? 1 : 0],
            44,
          )
        })
        if(uniformBackground){
          // This immutable ancestor otherwise pins a full effect-halo-sized
          // RGBA32F surface while its isolated document root is being drawn.
          plane.texture.uniformColor=true
          this.constantTargets.set('page-background',plane)
          plane={...this.retain(plane),rect:scene.extent}
        }
        if (!scene.coherentSamples) plane = retainRoots ? (await this.drawInteractionRoots([plane]))[0] : await this.drawList(scene.roots, plane)
        planes.push(plane)
      }
      if (sharedBackground) {
        const background = planes[0]
        planes = [background, this.retain(background), this.retain(background), this.retain(background)]
      }
      if (scene.coherentSamples) planes = retainRoots ? await this.drawInteractionRoots(planes) : await this.drawBundle(scene.roots, planes)
      this.sampleIndex = undefined
      if (planes.length === 4) {
        const p = scene.resolve
        target = p
          ? this.run(24, scene.output || rect(0, 0, p.width, p.height), planes, (u) =>
              u.set([p.offsetX, p.offsetY, p.scale, 0], 36),
            )
          : this.run(this.driver.managed ? 23 : 36, scene.extent, planes)
        this.release(...planes)
      } else target = planes[0]
      if (scene.resolve && !scene.coherentSamples) {
        const source = target,
          p = scene.resolve
        target = this.run(21, rect(0, 0, p.width, p.height), [source], (u) => {
          u.set([p.offsetX, p.offsetY, p.scale, 0], 36)
        })
        this.release(source)
      }
      if (scene.presentation) {
        const crop = rect(
          0,
          0,
          scene.resolve?.width ?? scene.width,
          scene.resolve?.height ?? scene.height,
        )
        if (
          target.rect.x !== 0 ||
          target.rect.y !== 0 ||
          target.rect.w !== crop.w ||
          target.rect.h !== crop.h
        ) {
          const clipped = this.copy(target, crop)
          this.release(target)
          target = clipped
        }
      }
      }
      const pause = this.yieldEncoding()
      if (pause) await pause
      const graphMs = performance.now() - started,
        finishStart = performance.now()
      const finishingScratch = this.driver.scratchBytes || 0
      let result: Awaited<ReturnType<Driver['finish']>>
      try { result = await this.driver.finish(
        target.texture,
        target.rect,
        scene.presentation?.width ?? scene.resolve?.width ?? scene.width,
        scene.presentation?.height ?? scene.resolve?.height ?? scene.height,
        readback,
        scene.presentation,
        present,
        scene.output,
      ) } catch (error) { throw markRenderFailure(error, { failureStage: 7 }) } finally {
        // Driver finish may retire scratch before a later readback fails.
        this.bytes += (this.driver.scratchBytes || 0) - finishingScratch
      }
      completed = true
      if (scene.sequentialDisplay) this.sequentialDisplayFrames++
      if (this.displayMaterial) this.displayMaterial.published = true
      this.horizontalFilters.finish(!this.frameCurrent || this.frameCurrent())
      this.staticImageBlurs.finish(!this.frameCurrent || this.frameCurrent(), this.driver.completedResourceEpoch)
      return {
        ...result,
        staticImageBlurEligible: this.staticImageBlurEligible, staticImageBlurHits: this.staticImageBlurHits,
        staticImageBlurPixels: this.staticImageBlurPixels, staticImageBlurBytes: this.staticImageBlurs.bytes,
        staticImageBlurEntries: this.staticImageBlurs.count,
        opaqueTentPasses: this.driver.opaqueTentPasses || 0, imageXTableBuilds: this.imageXTableBuilds, imageXTablePixels: this.imageXTablePixels, imageXTableBytes: this.imageXTableBytes,
        wholeFilterAxes: this.wholeFilterAxes,
        horizontalFilterHits: this.horizontalFilterHits,
        horizontalFilterPixels: this.horizontalFilterPixels,
        horizontalFilterRows: this.horizontalFilterRows,
        horizontalFilterBytes: this.horizontalFilters.bytes,
        retainedGroupHits: this.interactionHits,
        retainedPrefixHits: this.prefixHits,
        pairedFilterPasses: this.driver.pairedFilterPasses || 0,
        imageAxisFields: this.imageAxisFields,
        imageFieldBytes: this.imageFieldBytes,
        retainedGroupBytes: this.interactionBytes,
        graphMs,
        checkpointMs: this.checkpointMs,
        finishMs: performance.now() - finishStart,
        passPixels: this.passPixels,
        maskHits: this.maskHits,
        maskRasterizations: this.maskRasterizations,
        effectLayers: this.orderedEffectLayers,
        hybridEffects: this.hybridEffects,
        materialFieldHits: this.fieldHits,
        materialFieldBuilds: this.fieldBuilds,
        materialFieldBuildMs: this.fieldBuildMs,
        materialFieldUploadBytes: this.fieldUploadBytes,
        materialFieldCacheBytes: this.materialFields.bytes,
        kernelBuilds: this.kernelBuilds,
        kernelResidentHits: this.kernelResidentHits,
        kernelUploadBytes: this.kernelUploadBytes,
        kernelCacheBytes: this.kernelCache.bytes,
        kernelCacheEntries: this.kernelCache.size,
        kernelRetiredBytes: this.retiredKernels.reduce((sum, entry) => sum + entry.texture.bytes, 0),
        backdropReads: this.backdropReads,
        drawCalls: this.driver.drawCalls,
        commandSubmissions: this.driver.commandSubmissions,
        triangles: this.driver.triangles,
        textureBytes: this.bytes,
        workingBudgetBytes: this.frameBudget,
        interactionBudgetBytes: this.interactionBudget,
        peakTextureBytes: this.peak,
        // Driver-side finish transients (output copy, readback target,
        // MAP_READ staging) live outside this.bytes; report the observed
        // peak so gates can reason about the true device footprint.
        finishTransientBytes: this.driver.stats?.().finishTransientBytes ?? 0,
        workingTextureBytes: [
          ...new Set([...this.used, ...[...this.blurKernels.values(), ...this.certifiedKernels.values()].map((s) => s.texture)]),
        ].reduce((total, texture) => total + texture.bytes, this.driver.frameScratchBytes || 0),
        backend: this.driver.name,
        description: this.driver.description,
      }
    } catch (error) {
      markRenderFailure(error, { failureStage: 12 })
      if (scene.sequentialDisplay || error instanceof Error && error.message === 'PREVIEW_CANCELLED') {
        // Never pool/destroy frame resources while submitted commands still
        // reference them. This leaves the separately owned presented frame alive.
        await this.abortFrameAndReleaseFilterScratch('cancel')
      }
      if (scene.sequentialDisplay && isRecoverablePreviewBudget(error, this.driver.lost))
        throw Error('SEQUENTIAL_DISPLAY_UNSUPPORTED', { cause: error })
      throw error
    } finally {
      for (const surface of this.constantTargets.values()) this.release(surface)
      this.constantTargets.clear()
      this.aliases.clear()
      this.releasedAliases = new WeakSet()
      if (!completed) {
        // An abort may advance the resource-retirement epoch even after
        // discarding an unsubmitted encoder. That never publishes its pixels.
        if (this.displayMaterial && !this.displayMaterial.published) this.retireDisplayMaterial()
        this.retireNestedPrefix(); this.horizontalFilters.clear(); this.staticImageBlurs.finish(false, this.driver.completedResourceEpoch); this.coverage.clear(); this.materialFields.clear(); this.interactionInvalid = true
      }
      for (const texture of this.coordinateMaps) {
        this.busy.delete(texture)
        this.used.delete(texture)
        this.lastUsed.delete(texture)
        this.driver.destroy(texture)
        this.bytes -= texture.bytes
      }
      this.coordinateMaps.clear()
      // Retired geometry fields already left coordinateMaps; finish releases
      // them after the same completion boundary, before the busy sweep below
      // could ever pool a parameter upload.
      for (const texture of this.retiredUploads) this.forgetUpload(texture)
      this.retiredUploads.length = 0
      this.imageGrids.clear()
      this.gradientLookups.clear()
      this.textureLookups.clear()
      this.textureMath = undefined
      this.replayParameters = undefined
      for (const texture of [...this.busy])
        if (!this.coverage.has(texture) && !this.materialFields.has(texture) && !this.interactionTextures.has(texture) &&
            !this.horizontalFilters.has(texture) && !this.staticImageBlurs.has(texture) && this.displayMaterial?.surface.texture !== texture)
          this.release({ texture, rect: rect(0, 0, texture.width, texture.height) })
      this.sampleIndex = undefined
      this.masks.clear()
      this.maskOwners.clear()
      this.sharedMasks.clear()
      this.meshBits = new Uint32Array(0)
    }
  }
  dispose() {
    this.displayMaterial = undefined
    this.sequentialImagePins.clear()
    this.horizontalFilters.clear()
    this.staticImageBlurs.dispose()
    this.coefficientBytes.clear()
    this.encodeYield.dispose()
    this.interactionPrefix = undefined
    this.nestedPrefix = undefined; this.nestedPrefixBytes = 0
    this.stationaryBackdrop = undefined
    this.interactionRoots.clear(); this.interactionTextures.clear(); this.interactionBytes = 0
    this.movingBackdrop=undefined
    this.materialFields.clear()
    this.coverage.clear()
    this.kernelCache.abandon()
    this.retiredKernels.length = 0
    this.driver.dispose()
    this.images.clear()
    this.blurKernels.clear()
    this.certifiedKernels.clear()
    this.free.clear()
    this.coordinateMaps.clear()
    this.retiredUploads.length = 0
    this.lastUsed.clear()
    this.imageGrids.clear()
    this.gradientLookups.clear()
    this.textureLookups.clear()
    this.textureMath = undefined
    this.replayParameters = undefined
    this.busy.clear()
    this.aliases.clear()
    this.constantTargets.clear()
    this.releasedAliases = new WeakSet()
    this.maskOwners.clear()
    this.bytes = 0
  }
}
