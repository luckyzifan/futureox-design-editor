import {gaussianRegionRects} from './gaussian-region'
import { canvasBlurSceneEligible } from './canvas-blur-filter'
import { MAX_GRADIENT_STOPS } from '../../model'
import { FastPathWork } from '../../../../design-desktop/src/render-pass-work.mjs'
import { GRADIENT_PAINT_OVER_MODE, gradientFieldMaximumStop, gradientFusionWorthwhile } from './gradient-paint-over'
import { gradientPhaseFieldLayout } from './gradient-phase-field'
import { shadowFilterRegion } from './shadow-filter-region'
import { annotateTextureFailure } from '../../../../design-desktop/src/render-texture-failure.mjs'
import { MaintenanceResidency } from './maintenance-residency'
import { SurfacePool } from './surface-pool'
import { CoordinateRetirementSet } from './coordinate-retirement-set'
import { prefixAlignedStrip, prefixAlignedRgbStrip } from './prefix-band'
import { PREFIX_SCRATCH_BYTES } from './texture-prefix'
import { BOX_PREFIX_BYTES } from './box-prefix'
import { backdropFilterRegion } from './backdrop-filter-region'
import { painterStageBox } from './painter-stage'
import { identicalSampleCoverage } from './sample-equivalent-coverage'
import { byteShadowRegion } from './byte-shadow-region'
import { allowsDisplayTentRadius, selectDisplayTentRadius } from './display-tent-radius'
import { planDisplayBackdropBands } from './display-backdrop-bands'
import { prefixSamplingGeometry } from './prefix-sampling-geometry'
import { imageLoaderResidencyOwner, imageResidencyOwnerCurrent, type ImageResidencyOwner } from '../scene-image-hydration'
import type { ByteTentPlan } from './byte-tent-prefix-plan'
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
import { gpuDiagnosticsEnabled, gpuDiagnosticEpoch, recordGpuDiagnostic } from '../../../../design-desktop/src/render-terminal-diagnostics.mjs'
import { markRuntimeConfiguration } from '../../../../design-desktop/src/render-runtime-configuration.mjs'
import { markFailureAllocation } from '../../../../design-desktop/src/render-failure-allocation.mjs'
import { snapshotSurfaceLedger, surfaceAllocationTag, SurfaceAllocationSite, type SurfaceAllocationTag } from '../../../../design-desktop/src/render-surface-ledger.mjs'
import { markRenderFailure, renderFailureFields, renderFailureThrownKind } from '../render-failure-telemetry'
import { backdropEffect, backdropRadius, classifyCompiledSourceReuse } from '../render-dependency'
import { prefixRationalUnsupported } from './prefix-preflight'
import { renderErrorWithBudget, sanitizeRenderBudget, type RenderBudgetDiagnostic } from '../render-diagnostics'
import { textureByteLength } from './texture-byte-length'
import { movingBackdropKey, staticBackdropKey } from './static-backdrop'
import { DEFAULT_GPU_WORKING_BUDGET_BYTES, workingSetBudget, usesNativeNavigationWorkingBudget } from './working-set-budget'
import {rectangleBorder} from './rect-partition'
import {disjointNeutralGroup} from './neutral-group'
import { backdropOverlap, exactBlendLattice, normalMergeRegion, interactionEffectRegion, interactionHalo } from './effect-region'
import { gradient_blur_composite_uniforms } from '../../generated/design-kernel/design_kernel'
import { inverse } from '../../geometry'
import { EncodeYield } from './encode-yield'
import { RASTER_SLICE_COMMANDS } from './raster-queue-pacer'
import { sceneIndex, opaqueSolidGroup, opaqueSolidRuns, boundedPaintGroup, hasOpaqueSolidGroups, sceneScale as scale, type SceneIndex } from './scene-index'
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
import {opaquePainterStart} from './opaque-painter-prefix'
import type { Paint, Effect, ImageAdjust } from '../../model'
import { CoverageCache } from './coverage-cache'
import { ImmutableKernelCache, immutableKernelKey } from './immutable-kernel-cache'
import { exactFilterPacketLayout, exactFilterPacketTexels } from './exact-filter-packet-layout'
import { CoefficientByteCache } from './coefficient-byte-cache'
import { ReverseIndexMap } from './reverse-index-map'
import { solidRgba8 } from './rgba8'
import { batchableSolid, solidInstances, MAX_SOLID_INSTANCES } from './solid-batch'
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
  rational_large_tent_kernel_rgba,
  certified_tent_kernel_rgba,
  certified_box_kernel_rgba,
  image_sampling_grid_placed,
  image_sampling_axes_placed,
  image_mip_level,
  image_byte_sampling_field,
  image_byte_sampling_field_placed,
  gradient_sampling_grid,
  gradient_sampling_axes,
  gradient_sampling_grid_region,
  GradientPhaseFieldBuilder,
  rational_box_kernel_rgba,
  gaussian_box_radii,
  gaussian_region_box_radii,
  rational_region_box_kernel_rgba,
  motion_blur_kernel,
  zoom_blur_coordinates,
  color_controls_uniforms,
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
const SURFACE_BUDGET_BYTES = DEFAULT_GPU_WORKING_BUDGET_BYTES
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
export type Surface = { texture: Texture; rect: Rect; opaqueInterior?:Rect; logicalBounds?: Rect; compactMaxAbs?: readonly number[]; imageZeroOverIdentity?: true; linearParameterCorners?:true }
const containsRect = (outer: Rect | undefined, inner: Rect) => !!outer &&
  outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.w >= inner.x + inner.w && outer.y + outer.h >= inner.y + inner.h
const sameSurface = (a: Surface | undefined, b: Surface | undefined) => a === b || !!a && !!b &&
  a.texture === b.texture && a.rect.x === b.rect.x && a.rect.y === b.rect.y && a.rect.w === b.rect.w && a.rect.h === b.rect.h &&
  (a.logicalBounds === b.logicalBounds || !!a.logicalBounds && !!b.logicalBounds &&
    a.logicalBounds.x === b.logicalBounds.x && a.logicalBounds.y === b.logicalBounds.y &&
    a.logicalBounds.w === b.logicalBounds.w && a.logicalBounds.h === b.logicalBounds.h)
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
  linearRows?: () => import('../image-row-source').LinearImageRows
  linearRowReason?:1|2
  dispose?: () => void
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
const MATERIAL_FIELD_KINDS = new Map<unknown, number>(['image-axes-support','image-grid','gradient-grid','gradient-lookup',
  'figma-gradient-field','texture','glass','glass-border'].map((kind,index) => [kind,index+1]))
MATERIAL_FIELD_KINDS.set('gradient-phase-grid',MATERIAL_FIELD_KINDS.get('gradient-grid')!)
MATERIAL_FIELD_KINDS.set('gradient-phase-axis',MATERIAL_FIELD_KINDS.get('gradient-grid')!)
/** Kernel sampling-field guards (sampling.rs/paint.rs): dense coordinate
 * grids reject over 16,777,216 f32 values (4,194,304 pixels); separable axis
 * proofs reject spans over 2,097,152 entries. Rects past either limit must
 * take the chunked regional path rather than fail the render request. */
const SAMPLING_DENSE_PIXEL_LIMIT = 4_194_304
const SAMPLING_AXES_SPAN_LIMIT = 2_097_152
export const samplingFieldOverGuard = (rect: { w: number; h: number }) =>
  rect.w * rect.h > SAMPLING_DENSE_PIXEL_LIMIT || Math.max(rect.w, rect.h) > SAMPLING_AXES_SPAN_LIMIT
export const isSamplingFieldOverGuardError = (error: unknown) => {
  // WASM kernel errors surface as plain strings, not Error instances.
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return message.includes('exceeds 64 MiB')
}
export class GpuRenderer {
  private canvasBlurEnabled = import.meta.env.VITE_DESIGN_CANVAS_BLUR_FLOAT !== '0'
  private encodeYield = new EncodeYield()
  private frameCurrent?: () => boolean
  private displayBackpressure = false
  private sliceDraws = 0
  private encodingProgress?: (drawCalls:number)=>void
  private progressDraws=0
  private progressAt=0
  private checkFrameCurrent() {
    if (this.frameCurrent && !this.frameCurrent()) throw new Error('PREVIEW_CANCELLED')
  }
  private yieldEncoding() {
    this.checkFrameCurrent()
    const force = this.driver.rasterPacing === true && this.driver.drawCalls - this.sliceDraws >= RASTER_SLICE_COMMANDS
    const pause = this.encodeYield.checkpoint(this.driver.captureDisplay === true || !!this.frameCurrent, force)
    return pause?.then(async () => {
      // Let control messages invalidate this frame before its next GPU submit.
      // Cancellation abandons this unsubmitted encoder through the existing
      // abort/fence path; already submitted resources keep that same lifetime.
      this.checkFrameCurrent()
      this.sliceDraws = this.driver.drawCalls
      if (import.meta.env.VITE_DESIGN_ENCODE_SUBMIT !== '0') {
        if (this.displayBackpressure &&
            this.driver.captureDisplay === true && this.driver.yieldRasterQueue) {
          const started = performance.now()
          try { await this.driver.yieldRasterQueue() }
          finally { this.checkpointMs += performance.now() - started }
          this.checkFrameCurrent()
          this.encodeYield.begin()
        } else this.driver.submitPending?.()
        const draws=this.driver.drawCalls,now=performance.now()
        if(draws<this.progressDraws)this.progressDraws=0
        if(this.encodingProgress&&draws>this.progressDraws&&now-this.progressAt>=250){
          this.progressDraws=draws;this.progressAt=now
          try{this.encodingProgress(draws)}catch{/* Progress observers do not alter pixels or resource ownership. */}
        }
      }
    })
  }
  // Only numeric runtime branch facts. The snapshot belongs to the current
  // local renderAttempt; an Error keeps that immutable version across retries.
  private activeRuntimeConfiguration?: Readonly<Record<string, number>>
  private runtimeConfiguration?: Readonly<Record<string, number>>
  private runtimeConfigurationKey = ''
  private runtimeConfigurationEpoch = -1
  private reportedRuntimeConfigurations = new Set<string>()
  private recordRuntimeConfiguration(scene: GpuScene, readback: boolean, present: boolean) {
    if (!gpuDiagnosticsEnabled()) {
      this.runtimeConfiguration = undefined; this.runtimeConfigurationKey = ''; return
    }
    const epoch = gpuDiagnosticEpoch()
    if (epoch !== this.runtimeConfigurationEpoch) {
      this.runtimeConfigurationEpoch = epoch; this.reportedRuntimeConfigurations.clear()
    }
    const driverCode = this.driver.name === 'webgpu' ? 2 : this.driver.name === 'webgl2' ? 1 : 0
    const bits = Number(!!this.imageAtlas) | Number(!!this.imageMips) << 1 |
      Number(!!this.driver.managed) << 2 | Number(!!this.driver.linearLight) << 3 |
      Number(!!this.driver.hdr) << 4 | Number(!!this.driver.displayMath) << 5 |
      Number(!!this.driver.captureDisplay) << 6 | Number(typeof this.driver.uploadLinear === 'function') << 7 |
      Number(typeof this.driver.uploadAtlasLinear === 'function') << 8 | Number(!!scene.floatCompositing) << 9 |
      Number(!!scene.colorManagement) << 10 | Number(!!scene.coherentSamples) << 11 |
      Number(readback) << 12 | Number(present) << 13 | Number(!!scene.softwareRaster) << 14 |
      Number(scene.compactImageFields !== false) << 15 | Number(import.meta.env.VITE_DESIGN_IMAGE_AXES !== '0') << 16 |
      Number(!!this.driver.managed && this.driver.name === 'webgpu' && scene.compactImageFields !== false &&
        import.meta.env.VITE_DESIGN_IMAGE_AXES !== '0') << 17 | Number(import.meta.env.VITE_DESIGN_STREAM_IMAGE_FIELDS !== '0') << 18
    const configured = this.gpuWorkingBudgetMiB ?? 0
    // Constant-size scalar comparison, not content hashing or a scene walk.
    const key = `${bits}:${driverCode}:${this.frameBudget}:${configured}`
    if (key !== this.runtimeConfigurationKey) {
      const fields: Record<string, number> = { runtimeConfigVersion: 1, runtimeDriverCode: driverCode,
        runtimeWorkingBudgetBytes: this.frameBudget, runtimeBudgetSource: this.gpuWorkingBudgetMiB === undefined ? 1 : 2,
        runtimeConfiguredBudgetMiB: configured }
      const names = ['runtimeImageAtlas','runtimeImageMips','runtimeDriverManaged','runtimeLinearLight',
        'runtimeHdr','runtimeDisplayMath','runtimeCaptureDisplay','runtimeFloatUpload','runtimeFloatAtlasUpload',
        'runtimeFloatCompositing','runtimeColorManaged','runtimeCoherentSamples','runtimeReadback','runtimePresent','runtimeSoftwareRaster',
        'runtimeCompactImageFields','runtimeImageAxesEnabled','runtimeImageAxesEligible','runtimeStreamImageFields']
      names.forEach((name, index) => { fields[name] = bits >>> index & 1 })
      this.runtimeConfiguration = Object.freeze(fields); this.runtimeConfigurationKey = key
    }
    this.activeRuntimeConfiguration = this.runtimeConfiguration
    if (this.reportedRuntimeConfigurations.size < 16 && !this.reportedRuntimeConfigurations.has(key)) {
      this.reportedRuntimeConfigurations.add(key)
      // Logging failure must never change allocation/throw/recovery behavior.
      try { recordGpuDiagnostic('runtime-config', this.runtimeConfiguration) } catch { /* diagnostics only */ }
    }
  }
  lastBudgetFailure?: RenderBudgetDiagnostic
  private maintenanceResidency = new MaintenanceResidency()
  // Upcoming pass inputs are not dead merely because all earlier reads were
  // submitted. Keep them and reusable output slots owned across admission.
  private admissionPins = new Map<Texture, number>()
  private frameBudget = SURFACE_BUDGET_BYTES
  private imageResidencyOwner?: ImageResidencyOwner
  private imageResidencyPolicy?: string
  private retiredImageAssets = new Map<Texture, { epoch: number; covered: boolean }>()
  // Private cumulative proof counters; no source URI, words or public protocol.
  private imageAssetCounters = { hits: 0, uploads: 0, scopeRetiredTextures: 0, legacyPrunes: 0, pressureEvictions: 0 }
  private residentImageRequest = false
  private frameImageReuse = false
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
  private imageXTablePrograms = 0
  private imageXTableDuplicateBytesSaved = 0
  private backdropRegionOutputs = new WeakMap<Surface, Rect>()
  private backdropRegionBuilds = 0
  private backdropRegionSourcePixels = 0
  private backdropRegionResultPixels = 0
  private painterStageCopies = 0
  private painterStageCopyBytes = 0
  private wholeFilterAxes = 0
  private displayTentRadiusPasses = 0
  private gestureBlurPixels = 0
  private gestureFilterPadding = 0
  private displayTentRadiusPixels = 0
  private displayBackdropDestinations = new WeakMap<Surface, { source: Surface; radius: number; axis: number; clamp: boolean; epoch: number;
    sourceResource: unknown; targetResource: unknown; sourceRect: Rect; targetRect: Rect; sourceShape: number[]; sourceFlags: unknown[] }>()
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
    fieldRetirementIndexSkips:this.fieldRetirementIndexSkips,fieldRetirementAvoidedVisits:this.fieldRetirementAvoidedVisits,
    backdropRegionBuilds:this.backdropRegionBuilds,backdropRegionSourcePixels:this.backdropRegionSourcePixels,
    backdropRegionResultPixels:this.backdropRegionResultPixels,
    painterStageCopies:this.painterStageCopies,painterStageCopyBytes:this.painterStageCopyBytes,
    staticImageBlurEligible:this.staticImageBlurEligible,staticImageBlurHits:this.staticImageBlurHits,
    staticImageBlurPixels:this.staticImageBlurPixels,staticImageBlurBytes:this.staticImageBlurs.bytes,
    staticImageBlurEntries:this.staticImageBlurs.count,
    displayMaterialBuilds:this.displayMaterialBuilds,displayMaterialHits:this.displayMaterialHits,
    displayMaterialBytes:this.displayMaterial?.surface.texture.bytes || 0,
    sequentialDisplayFrames:this.sequentialDisplayFrames,
    backdropReuseFrames:this.backdropReuseFrames,backdropReusePixels:this.backdropReusePixels,
    backdropEligibleFrames:this.backdropEligibleFrames,backdropAdmittedFrames:this.backdropAdmittedFrames,
    coherentSubtreeBytes:this.coherentSubtreeBytes,coherentSubtreeEntries:this.coherentSubtrees.size } }
  /** Retained subtree pixels have their own cap; they are not scratch. */
  private get workingBytes() { return this.bytes - (this.driver.captureDisplay ? this.interactionBytes - this.nestedPrefixBytes - (this.coherentSubtreeBytes||0) : 0) }
  private get interactionBudget() {
    return this.driver.captureDisplay ? 512 * 1024 * 1024 : 64 * 1024 * 1024
  }
  private coherentSubtreeEnabled=true
  private coherentSubtreePressure=false
  private coherentSubtrees=new Map<GpuNode,{lease:object;policy:string;planes:Surface[];sources:{id:string;node:GpuNode|undefined}[]}>()
  private coherentSubtreeBytes=0
  private coherentProofNodes=0
  private retireCoherentSubtrees(keep?:ReadonlySet<GpuNode>,lease?:object){
    if(!this.coherentSubtrees?.size)return
    for(const [key,entry]of this.coherentSubtrees){
      if(keep?.has(key)&&entry.lease===lease)continue
      this.coherentSubtrees.delete(key);this.coherentProofNodes-=entry.sources.length
      for(const plane of entry.planes){
        this.interactionTextures.delete(plane.texture);this.interactionBytes-=plane.texture.bytes;this.coherentSubtreeBytes-=plane.texture.bytes
      }
      this.release(...entry.planes)
    }
  }
  /** Retain the four original sample planes of an unchanged isolated subtree.
   * Parent clipping/opacity and painter order remain live at composition time.
   * The entire 64 MiB allowance is charged to the common working budget. */
  private async drawCoherentSubtree(n:GpuNode,targets:Surface[],clip?:Surface[]):Promise<Surface[]|undefined>{
    if(!this.coherentSubtreeEnabled||import.meta.env.VITE_DESIGN_COHERENT_SUBTREES!=='1'||!this.optimized||!this.driver.managed||this.interactionCapturing||
        !this.scene.coherentSamples||!this.scene.nativeInteraction||!this.scene.interactionRetained||!this.scene.interactionLease||
        this.scene.resolve||this.scene.presentation||this.nativeChanging.has(n.id)||n.previewDynamic||n.opacity!==1||n.blend!=='normal'||
        n.captureReplay||n.textureReplay||targets.length!==4)return
    const index=sceneIndex(this.scene)
    if(index.roots.has(n.id)||!classifyCompiledSourceReuse(n,index.unknownEffectSubtrees.has(n.id)).reusable||
        !(n.children.length>1||n.fills.some(p=>p.kind==='image')||n.effects.some(e=>e.visible)))return
    const sources:{id:string;node:GpuNode|undefined}[]=[],pending=[n.id],seen=new Set<string>()
    while(pending.length){
      const id=pending.pop()!
      if(seen.has(id)||seen.size>=4096||this.nativeChanging.has(id))return
      seen.add(id);const node=this.scene.nodes[id]
      if(node?.previewDynamic)return
      sources.push({id,node:node?.previewSource||node})
      if(node){pending.push(...node.children);if(node.maskId&&!node.children.includes(node.maskId))pending.push(node.maskId)}
    }
    const key=n.previewSource||n,policy=this.nestedPrefixPolicy(n.id,[{rect:n.rect} as Surface]),lease=this.scene.interactionLease
    let cached=this.coherentSubtrees.get(key),contribution:Surface[]|undefined
    if(cached&&(cached.policy!==policy||cached.lease!==lease||cached.sources.length!==sources.length||
        cached.sources.some((row,i)=>row.id!==sources[i].id||row.node!==sources[i].node))){
      this.coherentSubtrees.delete(key);this.coherentProofNodes-=cached.sources.length
      for(const p of cached.planes){this.interactionTextures.delete(p.texture);this.interactionBytes-=p.texture.bytes;this.coherentSubtreeBytes-=p.texture.bytes}
      this.release(...cached.planes);cached=undefined
    }
    if(cached){
      contribution=cached.planes.map(p=>{this.used.add(p.texture);return this.retain(p)})
      this.interactionHits++
    }else{
      if(this.coherentSubtreePressure)return
      const needed=n.rect.w*n.rect.h*64
      if(!policy||this.coherentSubtrees.size>=128||this.coherentProofNodes+sources.length>8192||needed>64*1024*1024-this.coherentSubtreeBytes||
          this.interactionBytes+needed>this.interactionBudget||this.overBudget(needed*2)||this.coherentSubtreePressure)return
      const previous=this.interactionCapturing;this.interactionCapturing=true
      try{contribution=await this.drawBundle([n.id],this.emptyBundle(n.rect))}
      finally{this.interactionCapturing=previous}
      const bytes=contribution.reduce((total,p)=>total+p.rect.w*p.rect.h*16,0)
      if(bytes<=64*1024*1024-this.coherentSubtreeBytes&&this.interactionBytes+bytes<=this.interactionBudget&&!this.overBudget(bytes)&&!this.coherentSubtreePressure){
        const planes:Surface[]=[]
        try{for(const p of contribution)planes.push(this.copyInteractionSource(p))}
        catch(error){this.release(...planes,...contribution);throw error}
        this.coherentSubtrees.set(key,{lease,policy,planes,sources});this.coherentProofNodes+=sources.length
        for(const p of planes){this.interactionTextures.add(p.texture);this.interactionBytes+=p.texture.bytes;this.coherentSubtreeBytes+=p.texture.bytes}
      }
    }
    try{
      for(let sample=0;sample<4;sample++){
        this.sampleIndex=sample;const output=this.suffixRect(targets[sample],n)
        await this.reclaimForSurface(output||targets[sample].rect)
        targets[sample]=this.merge(contribution![sample],targets[sample],'normal',1,clip?.[sample],output)
        this.release(contribution![sample])
      }
      return targets
    }finally{this.release(...contribution!)}
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
  private nestedSuffixEnabled = true
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
      this.scene.displayFilters, this.scene.displayFilterRadiusLimit, this.scene.canvasBlurApproximation, this.scene.softwareRaster, this.driver.name,
      this.scene.displayImageSource, this.scene.displayMaterialSource, !!this.scene.displayTentRadius, this.driver.displayMath, this.driver.linearLight, this.driver.hdr])
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
  /** Large normal background display work is asynchronous only at its two
   * existing async node call sites. Other effects and <=512 filters keep the
   * original synchronous cache/filter path and its unchanged radius guard. */
  private async interactionBackdropDisplay(n: GpuNode, backdrop: Surface, sigma: number): Promise<Surface> {
    let pendingSurfaceAdmission: Surface | Promise<Surface>
    if (!this.wideDisplayBackdropEligible(n, sigma * 2)) return this.interactionBackdrop(n, backdrop, sigma)
    const support = Math.ceil(sigma * 2) + 2
    const capture = import.meta.env.VITE_DESIGN_EFFECT_REGIONS !== '0' && !this.interactionCapturing
      ? interactionEffectRegion(this.scene, n.rect, support) : n.rect
    // Reject an unsupported lattice before creating the original capture.
    const radius = selectDisplayTentRadius(sigma * 2, true)
    if (!planDisplayBackdropBands(capture, radius, false)) return this.interactionBackdrop(n, backdrop, sigma)
    await this.reclaimForSurface(capture)
    this.checkFrameCurrent()
    const captured = this.copy(backdrop, capture)
    try {
      const filtered = await this.blurDisplayBackdropBands(captured, sigma, n, false)
      if (!filtered) return (pendingSurfaceAdmission = this.blur(captured, sigma,false,false,false,true), pendingSurfaceAdmission instanceof Promise ? await pendingSurfaceAdmission : pendingSurfaceAdmission)
      return filtered
    } finally { this.release(captured) }
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
        // Drawing may have grown the working set since the speculative check
        // above. Optional cache copies cannot turn a completed contribution
        // into a failed frame. Admit against the actual completed planes.
        const copyBytes = contribution.reduce((bytes, plane) => bytes + plane.rect.w*plane.rect.h*16, 0)
        if (this.interactionBytes + copyBytes <= this.interactionBudget && !this.overBudget(copyBytes)) {
          const planes: Surface[] = []
          try {
            for (const plane of contribution) planes.push(this.copyInteractionSource(plane))
          } catch (error) { this.release(...planes, ...contribution); throw error }
          this.interactionRoots.set(key, { anchor: { ...n.rect }, planes })
          for (const { texture } of planes) { this.interactionTextures.add(texture); this.interactionBytes += texture.bytes }
        }
      }
      for (let i = 0; i < targets.length; i++) {
        this.sampleIndex = this.scene.coherentSamples ? i : undefined
        if (this.surfaceNeedsAdmission(targets[i].rect)) await this.reclaimForSurface(targets[i].rect)
        const regional = import.meta.env.VITE_DESIGN_RETAINED_ROOT_BLEND !== '0'
        const next = regional ? this.merge(contribution[i], targets[i], n.blend) : this.compose(contribution[i],targets[i],n.blend)
        if(!regional)this.release(targets[i])
        this.release(contribution[i]); targets[i] = next
      }
    }
    return targets
  }
  private free: Map<string,Texture[]> = new SurfacePool<Texture>()
  private busy = new Set<Texture>()
  private aliases = new Map<Texture, number>()
  private releasedAliases = new WeakSet<Surface>()
  private constantTargets = new Map<string, Surface>()
  private prefixAllowed = true
  private bytes = 0
  private peak = 0
  private passPixels = 0
  private readonly fastWork = new FastPathWork()
  private readonly fieldRetirementIndexEnabled = import.meta.env.VITE_DESIGN_FIELD_RETIREMENT_INDEX!=='0'
  private fieldRetirementIndexSkips = 0
  private fieldRetirementAvoidedVisits = 0
  private readonly constantCoverageEnabled = import.meta.env.VITE_DESIGN_CONSTANT_COVERAGE==='1'
  private readonly mixedSolidRunsEnabled = import.meta.env.VITE_DESIGN_MIXED_SOLID_RUNS!=='0'
  private constantCoverageActive=true
  private opaquePrefixActive=false
  private sourceTileOcclusion=false
  private opaquePrefixEnabled=import.meta.env.VITE_DESIGN_OPAQUE_PAINTER_PREFIX==='1'
  private uniformColorSurfaces=import.meta.env.VITE_DESIGN_UNIFORM_COLOR_SURFACES==='1'
  private sequentialGaussian=import.meta.env.VITE_DESIGN_SEQUENTIAL_GAUSSIAN==='1'
  private skippedPainterVisits=0
  get occludedPainterVisits(){return this.skippedPainterVisits}
  private identityClip(clip:Surface,bounds:Rect):boolean{
    return this.uniformColorSurfaces&&!!this.driver.managed&&this.busy.has(clip.texture)&&!this.releasedAliases.has(clip)&&
      containsRect(clip.rect,bounds)&&containsRect(clip.opaqueInterior,bounds)&&
      exactBlendLattice([clip.rect,clip.opaqueInterior!,bounds])
  }
  private equivalentClips(a:Surface|undefined,b:Surface|undefined,bounds:Rect):boolean{
    return sameSurface(a,b)||!!a&&!!b&&this.identityClip(a,bounds)&&this.identityClip(b,bounds)
  }
  private opaqueBegin(ids:string[],targets:Surface[],clip?:Surface[]):number{
    if(!this.opaquePrefixActive||!targets.length||targets.some(p=>!p.texture.transparentZero)||
      targets.some(p=>p.rect.x!==targets[0].rect.x||p.rect.y!==targets[0].rect.y||p.rect.w!==targets[0].rect.w||p.rect.h!==targets[0].rect.h))return 0
    if(clip&&(clip.length!==targets.length||clip.some((mask,i)=>!this.identityClip(mask,targets[i].rect))))return 0
    const proofs={
      imageFilters:import.meta.env.VITE_DESIGN_OPAQUE_IMAGE_FILTER_PREFIX==='1',
      color:(value:string)=>[...this.color(value),this.alpha(value)],
      image:(node:GpuNode,paint:GpuPaint)=>{
        if(!paint.image||this.imageMips&&!this.imageDims.has(paint.image))return false
        try{
          const image=this.images.get(this.imageKey(paint.image,this.imageLevel(node,paint),false,paint.adjust))
          const range=image&&this.driver.immutableImageRange?.(image.texture)
          // Range extrema are biased IEEE exponents, not channel values.
          // Alpha has a separate word-level [0,1] certificate; RGB exponent
          // <=127 bounds either sign below2 without clamping wide-gamut data.
          return !!range&&range.unitAlpha===true&&range.maximum.length===4&&
            range.maximum.every(v=>Number.isInteger(v)&&v>=1&&v<=127)
        }catch{return false}
      },
    }
    let begin=opaquePainterStart(this.scene,ids,targets[0].rect,proofs)
    if(!begin&&(proofs.imageFilters||this.sourceTileOcclusion)){
      // Find an otherwise proven full overwrite before doing optional work.
      // Only two actual source uploads may be prepared, under the same image
      // ledger. A decoder hint alone never authorizes omitting a painter.
      const potential=opaquePainterStart(this.scene,ids,targets[0].rect,{...proofs,image:()=>true})
      if(potential){
        const pending=ids.slice(0,potential+1),images:{node:GpuNode;paint:GpuPaint}[]=[],seen=new Set<string>()
        while(pending.length){
          const node=this.scene.nodes[pending.pop()!];if(!node||seen.has(node.id))continue;seen.add(node.id)
          for(const paint of [...node.fills,...node.strokes.map(stroke=>stroke.paint)])
            if(paint.visible&&paint.kind==='image'&&!proofs.image(node,paint))images.push({node,paint})
          pending.push(...node.children)
        }
        if(images.length<=2){
          try{
            for(const {node,paint} of images){this.checkFrameCurrent();this.imageFor(paint.image!,this.imageLevel(node,paint),false,paint.adjust)}
            begin=opaquePainterStart(this.scene,ids,targets[0].rect,proofs)
          }catch(error){
            // An optional preflight cannot buy more residency. Ordinary
            // rendering still owns budget failure and invalid-source errors.
            if(!(error instanceof Error)||!/^GPU (?:表面内存预算超限|浮点图片内存预算超限)/.test(error.message))throw error
          }
        }
      }
    }
    for(let i=0;i<begin;i++)if(this.scene.nodes[ids[i]])this.skippedPainterVisits++
    return begin
  }
  private gradientFusionActive=true
  private solidRunsActive=true
  private opaqueBatchEnabled(){return import.meta.env.VITE_DESIGN_OPAQUE_SOLID_BATCH==='1'||this.mixedSolidRunsEnabled&&this.solidRunsActive}
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
  private coordinateMaps = new CoordinateRetirementSet<Texture>()
  // Row strips share one immutable, certified support field per sample.
  // Samples that cannot separate keep their original dense strip fallback.
  private filterImageFields?: { rect: Rect; fields: Map<string, Surface | null>; pinned: Set<Texture> }
  private imageGrids = new Map<GpuPaint, Map<number, Surface>>()
  private readonly gradientFieldProofs = new WeakMap<Texture,{resource:Texture['resource'];maximumStop:number}>()
  private gradientPhaseRequest=false
  private readonly gradientPhaseResources=new WeakMap<Texture,{resource:Texture['resource'];width:number;height:number;axis?:[number,number]}>()
  private readonly gradientPhaseDeclined=new Set<string>()
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
    this.gradientPhaseResources.delete(texture)
    this.busy.delete(texture)
    this.used.delete(texture)
    this.lastUsed.delete(texture)
    this.driver.destroy(texture)
    this.bytes -= texture.bytes
  })
  // Synchronous dynamic scope only; restored even when a primitive is thrown.
  private activeImageFieldFailure?: () => Record<string, number>
  private failureOrigin<T>(error: T, origin: number, buildKind = 0, imageFields?: Record<string, number>): T {
    markRenderFailure(error, { failureOriginCode: origin, failureBuildKind: buildKind })
    if (gpuDiagnosticsEnabled()) try {
      recordGpuDiagnostic('failure-origin', { ...this.activeRuntimeConfiguration, ...renderFailureFields(error),
        ...(imageFields ?? this.activeImageFieldFailure?.()),
        failureOriginCode: origin, failureBuildKind: buildKind, failureBoundaryStage: origin === 5 ? 7 : 12,
        failureThrownKind: renderFailureThrownKind(error),
        failureMaterialFieldBuilds:this.fieldBuilds,failureMaterialFieldUploadBytes:this.fieldUploadBytes,
        failureImageAxisFields:this.imageAxisFields,failureImageFieldBytes:this.imageFieldBytes })
    } catch { /* diagnostic transport must not change the thrown value */ }
    return error
  }
  private prepareWithFailureOrigin<T>(origin: number, work: () => T, buildKind = 0): T {
    try { return work() } catch (error) { throw this.failureOrigin(error, origin, buildKind) }
  }
  private materialField<T extends Float32Array | Uint8Array>(inputs: unknown[], r: Rect, build: () => T,
    upload: (values: T, width: number, height: number) => Texture,
    layout?: (values: T) => [number, number], admissionBytes = r.w * r.h * 16, allowCache = true): Surface {
    // Only the private, code-controlled discriminator is inspected; no inputs are logged.
    const fieldKind = gpuDiagnosticsEnabled() ? MATERIAL_FIELD_KINDS.get(inputs[0]) || 0 : 0
    const key = JSON.stringify(inputs, (_key, value) => Object.is(value, -0) ? '-0' : value)
    const bits = new Uint32Array(0)
    let texture = this.optimized && allowCache ? this.materialFields.get(key, bits) : undefined
    if (texture) this.fieldHits++
    else {
      if (this.overBudget(admissionBytes, layout ? undefined : r.w, layout ? undefined : r.h)) throw this.budgetError('GPU 表面内存预算超限', 2, fieldKind)
      const start = performance.now()
      let values: T
      try { values = build() } catch (error) { throw this.failureOrigin(error, 6, fieldKind) }
      this.fieldBuildMs += performance.now() - start
      this.fieldBuilds++
      const [width,height] = layout?.(values) || [r.w,r.h]
      if (values.length !== width * height * 4) throw Error('无效的参数字段布局')
      if (this.overBudget(values.byteLength, width, height)) throw this.budgetError('GPU 表面内存预算超限', 3, fieldKind)
      try { texture = upload.call(this.driver, values, width, height) }
      catch (error) { throw this.failureOrigin(error, 7, fieldKind) }
      if(this.driver.exactGradientPaintOver&&(inputs[0]==='gradient-grid'||inputs[0]==='gradient-axis-grid'||inputs[0]==='gradient-phase-axis'||inputs[0]==='gradient-corners')&&values instanceof Float32Array){
        const maximumStop=gradientFieldMaximumStop(values)
        if(maximumStop!==undefined)this.gradientFieldProofs.set(texture,{resource:texture.resource,maximumStop})
      }
      this.fieldUploadBytes += values.byteLength
      this.bytes += texture.bytes
      this.peak = Math.max(this.peak, this.bytes)
      if (!this.optimized || !allowCache || !this.materialFields.put(key, bits, texture)) this.coordinateMaps.addOwned(texture)
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
  // Diagnostic-only latest pool hand-out; never used for allocation/reclaim decisions.
  private surfaceAllocationTags = new WeakMap<Texture, SurfaceAllocationTag>()
  private surfaceFailureSnapshot() {
    return snapshotSurfaceLedger<Texture>({ ledgerBytes: this.bytes, completedEpoch: this.driver.completedResourceEpoch,
      sources: [{mask:1,items:this.busy},{mask:2,items:this.free.values(),nested:true},
        {mask:4,items:this.used},{mask:8,items:this.coordinateMaps},{mask:16,items:this.retiredUploads},
        {mask:32,items:this.interactionTextures},{mask:64,items:this.images.values(),surface:true},
        {mask:64,items:this.atlasPages,surface:true},{mask:16|64,items:this.retiredImageAssets.keys()},
        {mask:0,items:this.lastUsed.keys()}],
      aliases:texture=>this.aliases.get(texture)||1,
      pinned:texture=>!!this.filterImageFields?.pinned.has(texture)||this.sequentialImagePins.has(texture)||this.pendingImageTableSources.has(texture)||this.admissionPins.has(texture),
      material:texture=>this.materialFields.has(texture),coverage:texture=>this.coverage.has(texture),
      tag:texture=>this.surfaceAllocationTags.get(texture),poolEpoch:texture=>this.poolReleaseEpoch.get(texture) })
  }
  private acquire(r: Rect, binaryCoverage = false, scalarCoverage = false, allocationSite = 0, passMode = -1): Surface {
    if (r.w < 1 || r.h < 1) throw new Error('空 GPU 表面')
    const required = textureByteLength(r.w, r.h, this.driver.managed && !binaryCoverage && !scalarCoverage ? 16 : 4)
    if (![r.x, r.y, r.x + r.w, r.y + r.h].every(value => Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER))
      throw new Error('无效的 GPU 表面边界')
    const key = `${scalarCoverage ? 'scalar:' : binaryCoverage ? 'binary:' : ''}${r.w}:${r.h}`,
      list = this.free.get(key)
    let texture = list?.pop()
    if(texture)(this.free as SurfacePool<Texture>).removed?.(texture)
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
        throw this.budgetError('GPU 表面内存预算超限', 1, 0, allocationSite, passMode)
      }
      try { texture = scalarCoverage ? this.driver.createScalarCoverage!(r.w,r.h) : binaryCoverage ? this.driver.createBinaryCoverage!(r.w, r.h) : this.driver.create(r.w, r.h) }
      catch(error){throw annotateTextureFailure(error,{textureAllocationSite:allocationSite,texturePass:passMode+1})}
      this.bytes += texture.bytes
      this.peak = Math.max(this.peak, this.bytes)
    }
    if (gpuDiagnosticsEnabled()) try { this.surfaceAllocationTags.set(texture, surfaceAllocationTag(allocationSite, passMode)) }
    catch { /* diagnostic-only tag cannot alter allocation */ }
    this.poolReleaseEpoch.delete(texture)
    delete texture.transparentZero
    delete texture.uniformColor
    delete texture.finitePixels
    delete texture.opaqueAlpha
    this.gradientFieldProofs.delete(texture)
    this.gradientPhaseResources.delete(texture)
    this.touch(texture)
    this.busy.add(texture)
    this.used.add(texture)
    return { texture, rect: r }
  }
  private touch(texture: Texture) {
    const age=++this.generation
    this.lastUsed.set(texture,age)
    ;(this.free as SurfacePool<Texture>).touched?.(texture,age)
  }
  /** Remove one texture from its free list and destroy it. Only call this for
   * textures whose GPU commands provably completed. */
  private destroyFree(texture: Texture) {
    if (this.admissionPins.has(texture)) return
    const key = `${texture.scalarCoverage ? 'scalar:' : texture.binaryCoverage ? 'binary:' : ''}${texture.width}:${texture.height}`,
      list = this.free.get(key)
    if (!list) return
    const at = list.indexOf(texture)
    if (at < 0) return
    list.splice(at, 1)
    ;(this.free as SurfacePool<Texture>).removed?.(texture)
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
      .filter(([, surface]) => !this.sequentialImagePins.has(surface.texture) && !this.admissionPins.has(surface.texture))
      .filter(([, surface]) => !this.staticImageBlurs.pinsSource(surface.texture))
      .filter(([, surface]) => forced || !this.used.has(surface.texture))
      .sort((a, b) => (this.lastUsed.get(a[1].texture) || 0) - (this.lastUsed.get(b[1].texture) || 0))
    for (const [uri, surface] of candidates) {
      if (required <= 0) break
      this.images.delete(uri)
      this.imageAssetCounters.pressureEvictions++
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
      if (this.sequentialImagePins.has(page.texture) || this.admissionPins.has(page.texture)) continue
      if (this.staticImageBlurs.pinsSource(page.texture)) continue
      if (!forced && this.used.has(page.texture)) continue
      this.destroyAtlasPage(page)
      this.imageAssetCounters.pressureEvictions++
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
    this.collectRetiredImageAssets()
    if (!Number.isSafeInteger(required) || required < 0) throw new Error('无效的 GPU 分配字节数')
    if (this.workingBytes + required <= this.frameBudget) return false
    if (this.nestedPrefix) this.nestedPrefixPressure = true
    if(this.coherentSubtrees?.size)this.coherentSubtreePressure=true
    this.retireCoherentSubtrees()
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
  private budgetError(message: string, allocationKind = 0, buildKind = 0, allocationSite = 0, passMode = -1): Error {
    const diagnostic = this.lastBudgetFailure
    this.lastBudgetFailure = undefined
    if(import.meta.env.VITE_DESIGN_ALLOCATION_STACK==='1'&&gpuDiagnosticsEnabled())
      console.debug('DESIGN_ALLOCATION_SITE '+JSON.stringify({allocationKind,allocationSite,passMode,node:this.activeNode,
        nodeOpacity:this.scene.nodes[this.activeNode]?.opacity,
        stack:new Error().stack?.split('\n').slice(0,12).join('\n')}))
    const error = markRenderFailure(markRuntimeConfiguration(renderErrorWithBudget(message, undefined, diagnostic), this.activeRuntimeConfiguration),
      { failureStage: 13, failureCategory: 3, failureCode: 200 })
    if (gpuDiagnosticsEnabled()) try {
      const requested = surfaceAllocationTag(allocationSite, passMode)
      markFailureAllocation(error, { ...this.surfaceFailureSnapshot(),
        failureAllocationCallsite:requested.site,failureAllocationRole:requested.role,failureAllocationPassMode:requested.mode,
        failureAllocationSnapshotVersion: 1, failureAllocationKind: allocationKind,
        failureBuildKind: buildKind, failureLedgerTotalBytes: this.bytes,
        failureMaterialFieldBuilds:this.fieldBuilds,failureMaterialFieldUploadBytes:this.fieldUploadBytes,
        failureImageAxisFields:this.imageAxisFields,failureImageFieldBytes:this.imageFieldBytes,
        failureLedgerInteractionBytes: this.interactionBytes, failureLedgerNestedPrefixBytes: this.nestedPrefixBytes,
        failureLedgerDriverScratchBytes: this.driver.scratchBytes || 0, failureLedgerMaterialFieldBytes: this.materialFields.bytes,
        failureLedgerCoverageBytes: this.coverage.bytes, failureLedgerKernelBytes: this.kernelCache.bytes,
        failureLedgerBusyCount: this.busy.size, failureLedgerImageCount: this.images.size,
        failureLedgerAtlasPageCount: this.atlasPages.length, failureLedgerRetiredUploadCount: this.retiredUploads.length,
        failureLedgerCoordinateCount: this.coordinateMaps.size })
    } catch { /* existing allocation failure remains authoritative */ }
    return error
  }
  private release(...surfaces: (Surface | undefined)[]) {
    for (const s of new Set(surfaces)) {
      if (!s || this.materialFields.has(s.texture) || this.gradientPhaseResources.has(s.texture) || this.releasedAliases.has(s)) continue
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
      ;(this.free as SurfacePool<Texture>).added?.(s.texture)
      const epoch = this.driver.resourceEpoch
      if (Number.isSafeInteger(epoch) && epoch! > 0) this.poolReleaseEpoch.set(s.texture, epoch!)
      else this.poolReleaseEpoch.delete(s.texture)
      if((this.free as SurfacePool<Texture>).setOwned)(this.free as SurfacePool<Texture>).setOwned(key,list)
      else this.free.set(key,list)
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
        zero = this.acquire(rect(0, 0, 1, 1), false, false, SurfaceAllocationSite.transparentZero)
        this.driver.clear(zero.texture)
        zero.texture.transparentZero = true
        this.constantTargets.set('transparent-zero', zero)
      }
      return { ...this.retain(zero), rect: r }
    }
    const s = this.acquire(r, false, false, SurfaceAllocationSite.empty)
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
  private painterStagesEnabled(scene = this.scene) {
    return import.meta.env.VITE_DESIGN_EXACT_CLAMP_PREFIX === '1' && !!scene.rootInputBox &&
      scene.coherentSamples === true && !scene.interactionRetained && !this.interactionCapturing
  }
  private painterBox(value: readonly number[] | undefined): Rect | undefined {
    return this.painterStagesEnabled() && value ? painterStageBox(value, this.scene.extent) : undefined
  }
  /** Compact solid accumulation never changes the parent's writable domain.
   * Unsupported consumers receive its exact zero-padded physical texture. */
  private async materializePainterTargets(targets: Surface[]): Promise<Surface[]> {
    if (!targets.some(target => target.logicalBounds)) return targets
    if (!this.driver.copyColorRegion) throw Error('Compact painter targets require exact color copies')
    const out: Surface[] = [], shared: { source: Surface; out: Surface }[] = []
    try {
      for (const source of targets) {
        const bounds = source.logicalBounds
        if (!bounds) { out.push(source); continue }
        const known = shared.find(entry => sameSurface(entry.source, source) && containsRect(entry.source.logicalBounds, bounds) &&
          containsRect(bounds, entry.source.logicalBounds!))
        if (known) { out.push(this.retain(known.out)); continue }
        if (!exactBlendLattice([bounds, source.rect]) || !containsRect(bounds, source.rect))
          throw Error('Invalid compact painter bounds')
        await this.reclaimForSurface(bounds)
        this.checkFrameCurrent()
        const expanded = this.acquire(bounds, false, false, SurfaceAllocationSite.painterExpand)
        out.push(expanded)
        this.driver.clear(expanded.texture)
        this.driver.copyColorRegion(expanded.texture, source.texture,
          { x: 0, y: 0, w: source.rect.w, h: source.rect.h }, [source.rect.x - bounds.x, source.rect.y - bounds.y])
        this.painterStageCopies++; this.painterStageCopyBytes += source.texture.bytes
        shared.push({ source, out: expanded })
      }
    } catch (error) {
      this.release(...out.filter((surface, index) => surface !== targets[index]))
      throw error
    }
    for (let i = 0; i < targets.length; i++) if (targets[i] !== out[i]) this.release(targets[i])
    return out
  }
  /** Once a child has finished reading its old wide backdrop, retain the
   * complete certified parent suffix. Shape bounds cannot replace this box.
   * Copies preserve raw color bits and identical sample aliases. */
  private async cropPainterTargets(targets: Surface[], box: readonly number[] | undefined): Promise<Surface[]> {
    return this.cropTargets(targets, this.painterBox(box))
  }
  private suffixRect(target: Surface, node: GpuNode): Rect | undefined {
    if (import.meta.env.VITE_DESIGN_PARENT_SUFFIX !== '1' || !node.suffixBox || !this.optimized || !this.driver.managed ||
        !this.scene.coherentSamples || this.scene.interactionRetained || this.interactionCapturing ||
        this.painterStagesEnabled() || target.logicalBounds) return
    const box = node.suffixBox, output = { x: box[0], y: box[1], w: box[2], h: box[3] }
    // A different established in-place lane may already own a narrower domain.
    // This optimization never expands it or manufactures missing prefix pixels.
    if (!exactBlendLattice([output, target.rect]) || output.w <= 0 || output.h <= 0 ||
        !containsRect(target.rect, output) || containsRect(output, target.rect)) return
    return output
  }
  private async cropTargets(targets: Surface[], output: Rect | undefined): Promise<Surface[]> {
    if (!output || targets.every(target => Object.keys(output).every(key =>
      Object.is((target.logicalBounds || target.rect)[key as keyof Rect], output[key as keyof Rect])))) return targets
    if (!this.driver.copyColorRegion) throw Error('Native painter stages require exact color copies')
    for (const target of targets) if (!exactBlendLattice([target.rect, output, target.logicalBounds || target.rect]) ||
        !containsRect(target.logicalBounds || target.rect, output)) throw Error('Native painter suffix exceeds its prefix')
    const unique = targets.filter((target, index) => !targets.slice(0, index).some(previous => sameSurface(previous, target)))
    const physical = unique.filter(target => !(target.texture.uniformColor && this.driver.constantTextureSampling ||
      target.texture.transparentZero && this.driver.zeroTextureSampling))
    await this.reclaimScratch(physical.length * output.w * output.h * (this.driver.managed ? 16 : 4))
    this.checkFrameCurrent()
    const entries: { source: Surface; cropped: Surface }[] = [], cropped: Surface[] = []
    try {
      for (const source of targets) {
        const shared = entries.find(entry => sameSurface(entry.source, source))
        if (shared) { cropped.push(this.retain(shared.cropped)); continue }
        let next: Surface
        if (source.texture.uniformColor && this.driver.constantTextureSampling ||
            source.texture.transparentZero && this.driver.zeroTextureSampling) {
          next = this.retain(source); next.rect = { ...output }
        } else {
          next = this.acquire(output, false, false, SurfaceAllocationSite.painterCrop)
          cropped.push(next)
          const copied = source.logicalBounds ? intersect(output, source.rect) : output
          if (source.logicalBounds) this.driver.clear(next.texture)
          if (copied.w && copied.h) {
            this.driver.copyColorRegion(next.texture, source.texture,
              { x: copied.x - source.rect.x, y: copied.y - source.rect.y, w: copied.w, h: copied.h },
              [copied.x - output.x, copied.y - output.y])
            this.painterStageCopies++
            this.painterStageCopyBytes += copied.w * copied.h * (this.driver.managed ? 16 : 4)
          }
          entries.push({ source, cropped: next })
          continue
        }
        cropped.push(next); entries.push({ source, cropped: next })
      }
    } catch (error) { this.release(...cropped); throw error }
    this.release(...targets)
    return cropped
  }
  private drawRegion(r:Rect):Rect|undefined {
    let region:Rect|undefined
    const window=this.scene.interactionWindow
    if(window&&this.scene.interactionRetained&&!this.interactionCapturing&&this.driver.name==='webgpu'&&
        import.meta.env.VITE_DESIGN_INTERACTION_SCISSOR!=='0'){
      // Geometry keeps a generous movement guard; per-sample shading only
      // needs the visible interior plus the compiler's complete effect halo.
      // Cached subtree captures stay full-size for subsequent translations.
      const halo=interactionHalo(this.scene) + (this.driver.gestureSoftEffects ? this.gestureFilterPadding : 0)
      const clip=intersect(r,{x:Math.floor(window.x-halo),y:Math.floor(window.y-halo),w:Math.ceil(window.w+halo*2+2),h:Math.ceil(window.h+halo*2+2)})
      const x=Math.max(0,Math.floor(clip.x-r.x)),y=Math.max(0,Math.floor(clip.y-r.y))
      region={x,y,w:Math.max(0,Math.min(r.w-x,Math.ceil(clip.x+clip.w-r.x)-x)),h:Math.max(0,Math.min(r.h-y,Math.ceil(clip.y+clip.h-r.y)-y))}
    }
    return region
  }
  private run(mode: number, r: Rect, inputs: Surface[], configure?: (u: Float32Array) => void, channels = 15, filter?: {kind: 'tent'; radius: number}, scalarOutput = false, destination?: Surface, fullPhysicalTarget = false) {
    const bandDestination = destination && this.displayBackdropDestinations.get(destination)
    if (destination && bandDestination) { this.displayBackdropDestinations.delete(destination); this.checkFrameCurrent() }
    const unchangedRect = (a: Rect, b: Rect) => Object.keys(a).every(key => Object.is(a[key as keyof Rect], b[key as keyof Rect]))
    const certifiedBand = !!bandDestination && allowsDisplayTentRadius(this.scene, this.driver, false, true) &&
      bandDestination.epoch === this.driver.resourceEpoch && bandDestination.source === inputs[0] && bandDestination.radius === filter?.radius &&
      this.privateBandDestination(destination!) && this.busy.has(inputs[0].texture) && !this.releasedAliases.has(inputs[0]) &&
      bandDestination.sourceResource === inputs[0].texture.resource && bandDestination.targetResource === destination!.texture.resource &&
      unchangedRect(bandDestination.sourceRect, inputs[0].rect) && unchangedRect(bandDestination.targetRect, destination!.rect) &&
      bandDestination.sourceShape.every((value, index) => value === [inputs[0].texture.width, inputs[0].texture.height, inputs[0].texture.bytes][index]) &&
      bandDestination.sourceFlags.every((value, index) => value === [inputs[0].texture.binaryCoverage, inputs[0].texture.scalarCoverage,
        inputs[0].texture.uniformColor, inputs[0].texture.transparentZero, inputs[0].texture.opaqueAlpha, inputs[0].texture.finitePixels][index])
    if (destination && (mode !== 22 || !filter || channels !== 15 || scalarOutput || !this.driver.managed ||
        r.w <= 0 || r.h <= 0 || !exactBlendLattice([r, destination.rect]) && !certifiedBand || !Object.keys(r).every(key => Object.is(r[key as keyof Rect], destination.rect[key as keyof Rect])) ||
        destination.texture.width !== r.w || destination.texture.height !== r.h || destination.texture.bytes !== r.w * r.h * 16 ||
        destination.texture.binaryCoverage || destination.texture.scalarCoverage || !this.busy.has(destination.texture) ||
        this.releasedAliases.has(destination) || (this.aliases.get(destination.texture) || 1) > 1 ||
        this.coverage.has(destination.texture) || this.materialFields.has(destination.texture) || this.interactionTextures.has(destination.texture) ||
        this.horizontalFilters.has(destination.texture) || this.staticImageBlurs.has(destination.texture) ||
        inputs.some(input => input.texture === destination.texture || input.texture.resource === destination.texture.resource)))
      throw Error('Invalid private exact filter destination')
    const out = destination || this.acquire(r, false, scalarOutput, SurfaceAllocationSite.passOutput, mode),
      u = parameters(r, inputs[0]?.rect, inputs[1]?.rect, inputs[2]?.rect)
    if (import.meta.env.DEV && import.meta.env.VITE_DESIGN_TRACE_PASSES === 'tile')
      this.traceSurfaces.set(out.texture,{node:this.activeNode,mode,sample:this.sampleIndex})
    u[16] = mode
    configure?.(u)
    if (bandDestination && (!certifiedBand || u[37] !== bandDestination.axis || u[36] !== bandDestination.radius || u[38] !== Number(bandDestination.clamp)))
      throw Error('Invalid certified display filter destination')
    // A constant's physical texel represents an entire logical domain. Its
    // initialization cannot be clipped by a world-space interaction window.
    const region=fullPhysicalTarget ? undefined : this.drawRegion(r)
    if (destination && region) throw Error('Private exact filter destination cannot be scissored')
    if(region&&(!region.w||!region.h)){this.driver.clear(out.texture);return out}
    if (filter && this.prefixAllowed) {
      const before = this.driver.scratchBytes || 0
      this.driver.prepareFilterPass?.(out.texture, u, inputs.map((s) => s.texture), channels, filter, this.frameBudget - this.workingBytes)
      this.bytes += (this.driver.scratchBytes || 0) - before
      this.peak = Math.max(this.peak, this.bytes)
    }
    if(mode===22&&!filter&&!region&&u[39]===2&&this.driver.prepareCanvasBoxPass){
      const before=this.driver.scratchBytes||0
      this.driver.prepareCanvasBoxPass(out.texture,u,inputs.map(s=>s.texture),channels,this.frameBudget-this.workingBytes)
      this.bytes+=(this.driver.scratchBytes||0)-before;this.peak=Math.max(this.peak,this.bytes)
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
  private interpolate(src: Surface, dst: Surface, opacity = 1, mask?: Surface, output = dst.rect) {
    return this.run(28, output, mask ? [src, dst, mask] : [src, dst], (u) => {
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
      if(texture===this.constantTargets.get('coverage-one')?.texture)continue
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
  private mask(path: PathMesh): Surface
  private mask(path: PathMesh, admit: true, defer?: boolean): Surface | Promise<Surface>
  private mask(path: PathMesh, admit: false, defer: boolean): Surface
  private mask(path: PathMesh, admit = false, defer = false): Surface | Promise<Surface> {
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
    if (admit) {
      const pending = this.admitSurface(path.rect, 1, binary, scalar, [], () => this.mask(path, false, defer))
      if (pending) return pending
    }
    s = this.acquire(path.rect, binary, scalar, SurfaceAllocationSite.pathCoverage)
    if (path.count && !defer) this.driver.mask(path, s.texture, this.sampleIndex)
    else if (!path.count) this.driver.clear(s.texture)
    this.masks.set(key, s)
    this.maskRasterizations++
    if (this.optimized) this.coverage.put(shapeKey, bits, s.texture)
    candidates.push({ bits, texture: s.texture })
    this.sharedMasks.set(shapeKey, candidates)
    return this.trackMask({...s,opaqueInterior:path.opaqueRect})
  }
  private nodeMask(n: GpuNode): Surface
  private nodeMask(n: GpuNode, admit: true, defer?: boolean): Surface | Promise<Surface>
  private nodeMask(n: GpuNode, admit: false, defer: boolean): Surface
  private nodeMask(n: GpuNode, admit = false, defer = false): Surface | Promise<Surface> {
    const independent=this.constantCoverageEnabled&&this.constantCoverageActive&&this.driver.name==='webgpu'&&!!this.driver.createConstantCoverage&&this.scene.coherentSamples===true&&
      this.sampleIndex!==undefined&&this.sampleIndex>=0&&this.sampleIndex<4&&exactBlendLattice([n.rect,n.fill.rect])
    const compact = (this.painterStagesEnabled()||independent) && this.driver.managed && this.driver.constantTextureSampling
    const certifiedInterior = !n.opaqueCoverage && compact && n.fill.sampleCount === 4 && this.sampleIndex !== undefined &&
      Number.isInteger(this.sampleIndex) && this.sampleIndex >= 0 && this.sampleIndex < 4 &&
      containsRect(n.fill.opaqueRect, n.rect) && containsRect(n.fill.rect, n.rect) &&
      exactBlendLattice([n.fill.rect, n.fill.opaqueRect!, n.rect])
    const opaque = n.opaqueCoverage || certifiedInterior || this.painterStagesEnabled() && compact && fullSampleCoverage(n.fill, this.scene.curves, n.rect)
    if (!opaque || !this.optimized){if(independent)this.fastWork.add('fastCoverageRejected');return admit ? this.mask(n.fill, true, defer) : this.mask(n.fill, false, defer)}
    const key = `opaque:${n.rect.x}:${n.rect.y}:${n.rect.w}:${n.rect.h}`
    const known = this.masks.get(key)
    if (known) return this.trackMask({ ...known, opaqueInterior: n.fill?.opaqueRect })
    if(compact&&independent){
      const shared=this.constantTargets.get('coverage-one')
      if(shared){
        const value={texture:shared.texture,rect:n.rect,opaqueInterior:n.fill?.opaqueRect}
        this.masks.set(key,value);this.used.add(shared.texture)
        this.fastWork.add('fastCoverageShared');this.fastWork.add('fastCoverageSavedPixels',n.rect.w*n.rect.h)
        return this.trackMask(value)
      }
    }
    if (admit) {
      const pending = this.admitSurface(compact ? rect(0, 0, 1, 1) : n.rect, 1,
        !!(this.driver.managed && this.driver.createBinaryCoverage), false, [], () => this.nodeMask(n, false, defer))
      if (pending) return pending
    }
    if(compact&&independent&&this.driver.createConstantCoverage){
      const value:Surface=this.materialField(['constant-coverage-one'],rect(0,0,1,1),()=>new Uint8Array([255,255,255,255]),
        ()=>this.driver.createConstantCoverage!(),undefined,4)
      value.rect=n.rect;value.opaqueInterior=n.fill?.opaqueRect
      this.constantTargets.set('coverage-one',value);this.masks.set(key,value)
      this.fastWork.add('fastCoverageConstant');this.fastWork.add('fastCoverageSavedPixels',Math.max(0,n.rect.w*n.rect.h-1))
      return this.trackMask(value)
    }
    const mask = this.acquire(compact ? rect(0, 0, 1, 1) : n.rect, !!(this.driver.managed && this.driver.createBinaryCoverage), false, SurfaceAllocationSite.nodeMask)
    const u = parameters(mask.rect)
    u[16] = 12
    u.set([1, 1, 1, 1], 48)
    this.driver.pass(mask.texture, u, [])
    this.passPixels += mask.rect.w * mask.rect.h
    if (compact) { mask.texture.uniformColor = true; mask.rect = n.rect }
    if(compact&&independent){this.constantTargets.set('coverage-one',mask);this.fastWork.add('fastCoverageConstant');this.fastWork.add('fastCoverageSavedPixels',Math.max(0,n.rect.w*n.rect.h-1))}
    mask.opaqueInterior = n.fill?.opaqueRect
    this.masks.set(key, mask)
    return this.trackMask(mask)
  }
  private fillMask(n:GpuNode):Surface|Promise<Surface>{
    return this.constantCoverageEnabled&&this.constantCoverageActive&&this.driver.name==='webgpu'&&this.scene.coherentSamples&&this.sampleIndex!==undefined
      ?this.nodeMask(n,true):this.mask(n.fill,true)
  }
  private async maskFour(n: GpuNode): Promise<Surface[] | undefined> {
    if (!this.driver.maskAll || !n.fill.count) return
    const masks: Surface[] = [], deferred: number[] = []
    for (let phase = 0; phase < 4; phase++) {
      await this.reclaimScratch()
      this.sampleIndex = phase
      const before = this.maskRasterizations
      const pending = this.nodeMask(n, true, true)
      masks.push(pending instanceof Promise ? await pending : pending)
      if (this.maskRasterizations > before) deferred.push(phase)
    }
    if (deferred.length === 4 && this.driver.maskAll(n.fill, masks.map(mask => mask.texture))) return masks
    for (const phase of deferred) {
      this.sampleIndex = phase
      this.driver.mask(n.fill, masks[phase].texture, phase)
    }
    return masks
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
  private regionalOverPlan(bounds: Rect, dst: Surface, sources: Surface[]) {
    if (!this.optimized || !this.driver.managed) return
    if((this.aliases.get(dst.texture)||1)>1){this.fastWork.add('fastRegionalSharedReject');return}
    if(sources.some(s=>s.texture===dst.texture)){this.fastWork.add('fastRegionalFeedbackReject');return}
    if([bounds,dst.rect,...sources.map(s=>s.rect)].some(r=>Object.values(r).some(v=>!Number.isInteger(v)||Math.abs(v)>1048576))){this.fastWork.add('fastRegionalLatticeReject');return}
    const region = intersect(bounds, dst.rect)
    if (!region.w || !region.h) return { region, before: undefined }
    // A full-surface update gains nothing from the extra copy.
    if (region.w * region.h * 2 >= dst.rect.w * dst.rect.h){this.fastWork.add('fastRegionalLargeReject');return}
    return { region, before: intersect({ ...region, w: region.w + 1, h: region.h + 1 }, dst.rect) }
  }
  private regionalOver(
    mode: number, bounds: Rect, dst: Surface, sources: Surface[],
    configure: (u: Float32Array) => void,
  ): Surface | undefined {
    const plan = this.regionalOverPlan(bounds, dst, sources)
    if (!plan) return
    const { region } = plan
    if (!plan.before) return dst
    const before = this.run(0, plan.before, [dst])
    this.fastWork.add('fastRegionalUsed');this.fastWork.add('fastRegionalPixels',region.w*region.h+plan.before.w*plan.before.h)
    this.fastWork.add('fastRegionalFullPixels',dst.rect.w*dst.rect.h)
    const u = parameters(dst.rect, before.rect, sources[0]?.rect, sources[1]?.rect)
    u[16] = mode
    configure(u)
    this.driver.pass(dst.texture, u, [before.texture, ...sources.map(s => s.texture)],
      rect(region.x - dst.rect.x, region.y - dst.rect.y, region.w, region.h))
    this.passPixels += region.w * region.h
    this.release(before)
    return dst
  }
  private constantPaintOver(n: GpuNode, paint: GpuPaint, mask: Surface, dst: Surface, clip?: Surface) {
    const constantColor = paint.constantColor ?? (paint.kind === 'solid' ? paint.color : undefined)
    const bounds = dst.logicalBounds || dst.rect
    return (
      this.optimized &&
      (!clip||this.identityClip(clip,bounds)) &&
      (n.opaqueCoverage && containsRect(n.rect, bounds) || (containsRect(mask.opaqueInterior, bounds) && containsRect(n.rect, bounds) &&
        exactBlendLattice([mask.rect, bounds, n.rect]))) &&
      constantColor &&
      paint.blend === 'normal' &&
      paint.opacity === 1 &&
      this.alpha(constantColor) === 1
    ) ? constantColor : undefined
  }
  private constantTargetKey(bounds: Rect, color: string) {
    const rgba = new Float32Array([...this.color(color), 1])
    return JSON.stringify([bounds, [...new Uint32Array(rgba.buffer)]], (_key, value) => Object.is(value, -0) ? '-0' : value)
  }
  private opaqueConstantTarget(dst: Surface, color: string): Surface {
    const bounds = dst.logicalBounds || dst.rect
    if (this.driver.managed && !this.allowSolidBatch) {
      // Preserve the existing constant lane before considering compact color
      // surfaces. The cache owns one reference, each sample another; its key
      // compares the actual RGBA32F uniform words, including signed zero.
      const key = this.constantTargetKey(bounds, color)
      let constant = this.constantTargets.get(key)
      if (!constant) {
        const compact = (this.painterStagesEnabled()||this.uniformColorSurfaces) && this.driver.constantTextureSampling
        constant = this.run(12, compact ? rect(0, 0, 1, 1) : bounds, [], u => u.set([...this.color(color), 1], 48),
          15, undefined, false, undefined, !!compact)
        if (compact) { constant.texture.uniformColor = true; constant.rect = bounds }
        this.constantTargets.set(key, constant)
      }
      const out = this.retain(constant)
      this.release(dst)
      return out
    }
    const out = this.run(12, bounds, [], u => u.set([...this.color(color), 1], 48))
    this.release(dst)
    return out
  }
  private exactSolidPaintRegion(n: GpuNode, paint: GpuPaint, mask: Surface, dst: Surface, clip?: Surface): Rect | undefined {
    if (this.optimized && this.driver.managed && this.driver.exactSolidPaintOver &&
        paint.kind === 'solid' && paint.blend === 'normal' &&
        [...this.color(paint.color), this.alpha(paint.color), paint.opacity].every((v) => Number.isFinite(Math.fround(v))) &&
        [n.rect, mask.rect, dst.rect, ...(clip ? [clip.rect] : [])].every((r) => Object.values(r).every((v) => Number.isInteger(v) && Math.abs(v) <= 1048576)))
      return clip ? intersect(intersect(n.rect, mask.rect), clip.rect) : intersect(n.rect, mask.rect)
  }
  private compactSolidNode(n: GpuNode, paint = n.fills[0]) {
    if (!this.painterStagesEnabled() || !this.optimized || this.allowSolidBatch || !this.driver.managed || !this.driver.zeroTextureSampling ||
        !this.driver.exactSolidPaintOver || this.driver.displayMath || !paint?.visible || paint.kind !== 'solid' ||
        paint.blend !== 'normal' || n.opacity !== 1 || n.blend !== 'normal' || n.passthrough || n.mask || n.maskId ||
        n.children.length || n.effects.length || n.strokes.length || n.fills.length !== 1) return false
    const alpha = Math.fround(this.alpha(paint.color)), opacity = Math.fround(paint.opacity)
    // Finite authored factors alone do not prove finite products (HDR may
    // overflow). Infinity times an outside-zero mask would be observable NaN.
    return alpha >= 0 && alpha <= 1 && opacity >= 0 && opacity <= 1 &&
      [alpha, opacity, ...this.color(paint.color).map(value => Math.fround(value)),
      ...[...this.color(paint.color), 1].map(value => Math.fround(Math.fround(Math.fround(value) * alpha) * opacity))]
      .every(Number.isFinite)
  }
  private compactSolidPlan(n: GpuNode, paint: GpuPaint, mask: Surface, dst: Surface, clip?: Surface) {
    if (!this.compactSolidNode(n, paint) || !(dst.logicalBounds || dst.texture.transparentZero) ||
        !mask.texture.binaryCoverage || clip && !clip.texture.binaryCoverage) return
    const logical = dst.logicalBounds || dst.rect
    const certified = this.painterBox(n.postCompositeBox)
    if (!certified || !containsRect(certified, logical) || !containsRect(logical, certified)) return
    const oldBound = dst.logicalBounds ? dst.compactMaxAbs : [0, 0, 0, 0]
    if (!oldBound || oldBound.length !== 4 || oldBound.some(value => !Number.isFinite(value) || value < 0)) return
    const alpha = Math.fround(this.alpha(paint.color)), opacity = Math.fround(paint.opacity)
    const addedBound = [...this.color(paint.color), 1].map(value =>
      Math.abs(Math.fround(Math.fround(Math.fround(value) * alpha) * opacity)))
    // Binary coverage/clip and admitted alpha/opacity keep every blend factor
    // in [0,1]. RN(oldAbs + newAbs) bounds all four accumulated channels,
    // including unchanged pixels. Reject before a possible over overflow;
    // finite inputs alone do not prevent Inf and its zero-weight neighbours.
    const maximum = oldBound.map((value, i) => Math.fround(value + addedBound[i]))
    if (maximum.some(value => !Number.isFinite(value))) return
    const support = this.exactSolidPaintRegion(n, paint, mask, { ...dst, rect: logical }, clip)
    if (!support || !exactBlendLattice([logical, support, dst.rect])) return
    const added = intersect(support, logical)
    if (!added.w || !added.h) return { logical, maximum: oldBound, unchanged: true, output: dst.rect }
    const old = dst.logicalBounds ? dst.rect : added
    const x = Math.min(old.x, added.x), y = Math.min(old.y, added.y)
    return { logical, maximum, unchanged: false, output: rect(x, y,
      Math.max(old.x + old.w, added.x + added.w) - x, Math.max(old.y + old.h, added.y + added.h) - y) }
  }
  /** Plan the very same allocation branch consumed by paintOver. A tiny
   * regional save or an existing constant cannot justify a whole-target fence. */
  private reclaimForPaintOver(n: GpuNode, paint: GpuPaint, mask: Surface, dst: Surface, clip?: Surface, compactTarget = false): Promise<void> | undefined {
    this.checkFrameCurrent()
    const bpp = this.driver.managed ? 16 : 4
    const constant = this.constantPaintOver(n, paint, mask, dst, clip)
    const compact = !constant && compactTarget && this.compactSolidPlan(n, paint, mask, dst, clip)
    if (compact) {
      const required = compact.unchanged || this.free.get(`${compact.output.w}:${compact.output.h}`)?.length ? 0 :
        compact.output.w * compact.output.h * bpp
      if (required && this.workingBytes + required > this.frameBudget)
        return this.reclaimScratch(required).then(() => this.checkFrameCurrent())
      return
    }
    // A rare unsupported clip/product must first recover the full logical
    // target below; admitting against its physical window would be incorrect.
    if (dst.logicalBounds && !constant) return
    if (this.workingBytes + (n.rect.w * n.rect.h + dst.rect.w * dst.rect.h) * bpp <= this.frameBudget) return
    const allocations: Rect[] = []
    if (constant) {
      const bounds = dst.logicalBounds || dst.rect
      const cached = this.driver.managed && !this.allowSolidBatch &&
        this.constantTargets.has(this.constantTargetKey(bounds, constant))
      if (!cached) allocations.push(this.driver.managed && !this.allowSolidBatch &&
        (this.painterStagesEnabled()||this.uniformColorSurfaces) && this.driver.constantTextureSampling ? rect(0, 0, 1, 1) : bounds)
    } else {
      const region = this.exactSolidPaintRegion(n, paint, mask, dst, clip)
      const regional = region && this.regionalOverPlan(region, dst, clip ? [mask, clip] : [mask])
      if (regional) {
        if (regional.before) allocations.push(regional.before)
      } else if (region || !this.driver.managed && (paint.constantColor || paint.kind === 'solid' || paint.figmaGradient)) {
        allocations.push(dst.rect)
      } else {
        allocations.push(n.rect, dst.rect)
      }
    }
    // General paint and its following merge coexist. Count actual missing
    // sizes once, including two simultaneous planes of equal dimensions.
    const sizes = new Map<string, { rect: Rect; count: number }>()
    for (const r of allocations) {
      const key = `${r.w}:${r.h}`, entry = sizes.get(key)
      if (entry) entry.count++
      else sizes.set(key, { rect: r, count: 1 })
    }
    let required = 0
    for (const [key, entry] of sizes) required += Math.max(0, entry.count - (this.free.get(key)?.length || 0)) *
      entry.rect.w * entry.rect.h * bpp
    if (!required || this.workingBytes + required <= this.frameBudget) return
    return this.reclaimScratch(required).then(() => this.checkFrameCurrent())
  }
  private paintOver(n: GpuNode, paint: GpuPaint, mask: Surface, dst: Surface, clip?: Surface): Surface
  private paintOver(n: GpuNode, paint: GpuPaint, mask: Surface, dst: Surface, clip: Surface | undefined, admitMerge: true, compactTarget?: boolean, skipGradientFusion?:boolean): Surface | Promise<Surface>
  private paintOver(n: GpuNode, paint: GpuPaint, mask: Surface, dst: Surface, clip?: Surface, admitMerge = false, compactTarget = false, skipGradientFusion=false): Surface | Promise<Surface> {
    const opaqueConstant = this.constantPaintOver(n, paint, mask, dst, clip)
    if (opaqueConstant) return this.opaqueConstantTarget(dst, opaqueConstant)
    if(admitMerge&&!skipGradientFusion&&this.gradientFusionEligible(n,paint,mask,dst,clip))return this.gradientPaintOver(n,paint,mask,dst,clip)
    const compact = compactTarget && this.compactSolidPlan(n, paint, mask, dst, clip)
    if (compact) {
      if (compact.unchanged) return dst
      const out = this.run(47, compact.output, clip ? [dst, mask, clip] : [dst, mask], u => {
        this.configurePaint(u, n, paint)
        u.set([n.rect.x, n.rect.y, n.rect.w, n.rect.h], 52)
        u[19] = clip ? 1 : 0
      })
      if (!containsRect(compact.output, compact.logical)) {
        out.logicalBounds = { ...compact.logical }
        out.compactMaxAbs = compact.maximum
      }
      this.release(dst)
      return out
    }
    if (dst.logicalBounds) {
      if (!admitMerge) throw Error('Compact painter target requires asynchronous materialization')
      return this.materializePainterTargets([dst]).then(async ([expanded]) => {
        const admission = this.reclaimForPaintOver(n, paint, mask, expanded, clip)
        if (admission) await admission
        return this.paintOver(n, paint, mask, expanded, clip, true)
      })
    }
    const constantColor = paint.constantColor ?? (paint.kind === 'solid' ? paint.color : undefined)
    const region = this.exactSolidPaintRegion(n, paint, mask, dst, clip)
    if (region) {
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
    const compose = (source: Surface): Surface | Promise<Surface> => {
      try { this.checkFrameCurrent() }
      catch (error) { this.release(source); throw error }
      if (admitMerge && source.imageZeroOverIdentity && !clip && paint.blend === 'normal' &&
          dst.texture.transparentZero && this.driver.zeroTextureSampling &&
          containsRect(source.rect, dst.rect) && containsRect(dst.rect, source.rect)) {
        // This particular source is finite/canonical, has alpha 0 or 1 and is
        // all +0 whenever alpha is 0. Integer sampling, opacity 1 and the old
        // zero destination therefore reproduce its stored bits exactly.
        this.release(dst)
        return source
      }
      const merge = () => {
        try {
          this.checkFrameCurrent()
          return this.merge(source, dst, paint.blend, 1, clip)
        } finally { this.release(source) }
      }
      // Image and gradient fields are uploaded lazily inside paint. Their real
      // bytes can cross the earlier two-plane admission after the source has
      // been allocated. Coherent managed composition always writes a full fresh
      // destination, so recheck its actual missing allocation here. The source
      // stays busy across a real checkpoint; its sampled uploads can now retire
      // safely. Synchronous bounded-strip consumers keep their existing path.
      if (admitMerge && this.driver.managed && this.scene.coherentSamples &&
          !this.free.get(`${dst.rect.w}:${dst.rect.h}`)?.length) {
        const required = dst.rect.w * dst.rect.h * 16
        if (this.workingBytes + required > this.frameBudget)
          return this.reclaimScratch(required).then(merge, error => {
            this.release(source)
            throw error
          })
      }
      return merge()
    }
    const source = admitMerge ? this.paintWithBoundedImageFields(n, paint, mask) : this.paint(n, paint, mask)
    return source instanceof Promise ? source.then(compose) : compose(source)
  }
  private gradientFusionEligible(n:GpuNode,paint:GpuPaint,mask:Surface,dst:Surface,clip?:Surface){
    if(!this.optimized||!this.gradientFusionActive||!this.driver.exactGradientPaintOver||!['linear','radial','angular','diamond'].includes(paint.kind))return false
    if(paint.blend!=='normal'||!paint.visible||dst.logicalBounds||n.rect.w*n.rect.h>262144||clip&&paint.stops.length>32){this.fastWork.add('fastGradientPaintReject');return false}
    if(!exactBlendLattice([n.rect,mask.rect,dst.rect,...(clip?[clip.rect]:[])])){this.fastWork.add('fastGradientLatticeReject');return false}
    if(!mask.texture.binaryCoverage||clip&&!clip.texture.binaryCoverage){this.fastWork.add('fastGradientCoverageReject');return false}
    const colors=[paint.color,...paint.stops.map(s=>s.color)]
    if(!Number.isFinite(paint.opacity)||paint.opacity<0||paint.opacity>1||paint.stops.length>MAX_GRADIENT_STOPS||
      colors.some(color=>[...this.color(color).map(Math.fround),Math.fround(this.alpha(color))].some(v=>!Number.isFinite(v)||v<0||v>1))){
      this.fastWork.add('fastGradientColorReject');return false
    }
    return true
  }
  private gradientPaintOver(n:GpuNode,paint:GpuPaint,mask:Surface,dst:Surface,clip?:Surface):Surface|Promise<Surface>{
    const phase=this.prepareGradientPhase(n,paint)
    if(phase)return phase.then(()=>this.gradientPaintOver(n,paint,mask,dst,clip))
    const field=this.gradientGrid(n,paint),second=clip||(paint.stops.length>32?this.gradientStopTable(paint):mask)
    const proof=this.gradientFieldProofs.get(field.texture)
    if(!proof||proof.resource!==field.texture.resource||proof.maximumStop>=paint.stops.length){
      this.fastWork.add('fastGradientColorReject')
      return this.paintOver(n,paint,mask,dst,clip,true,false,true)
    }
    const privateTarget=(this.aliases.get(dst.texture)||1)===1&&[mask,second,field].every(s=>s.texture!==dst.texture)
    const plan=privateTarget&&import.meta.env.VITE_DESIGN_REGIONAL_BLEND!=='0'?normalMergeRegion(n.rect,dst.rect):undefined
    if(plan&&!plan.before)return dst
    const allocation=plan?.before||dst.rect
    const draw=()=>{
      this.checkFrameCurrent()
      const before=plan?.before?this.copy(dst,plan.before):undefined,old=before||dst
      try{
        const u=parameters(dst.rect,mask.rect,second.rect,old.rect)
        u[16]=GRADIENT_PAINT_OVER_MODE;this.configurePaint(u,n,paint)
        u.set([n.rect.x,n.rect.y,n.rect.w,n.rect.h],36);u[19]=clip?1:0
        this.configureGradientPhase(u,field)
        const output=before?dst:this.acquire(dst.rect,false,false,SurfaceAllocationSite.passOutput,GRADIENT_PAINT_OVER_MODE)
        try{
          this.driver.pass(output.texture,u,[mask.texture,second.texture,old.texture,field.texture],plan?.region)
        }catch(error){if(output!==dst)this.release(output);throw error}
        const pixels=plan?plan.region.w*plan.region.h:dst.rect.w*dst.rect.h
        this.passPixels+=pixels;this.fastWork.add('fastGradientFused');this.fastWork.add('fastGradientSavedPixels',n.rect.w*n.rect.h)
        if(plan){this.fastWork.add('fastRegionalUsed');this.fastWork.add('fastRegionalPixels',pixels+allocation.w*allocation.h);this.fastWork.add('fastRegionalFullPixels',dst.rect.w*dst.rect.h)}
        else this.release(dst)
        return output
      }finally{this.release(before)}
    }
    const pending=this.admitSurface(allocation,1,false,false,[mask,second,dst,field],draw)
    return pending||draw()
  }
  /** Consumes dst; retains src/mask. Source-over writes only the affected area. */
  private merge(src: Surface, dst: Surface, mode = 'normal', opacity = 1, mask?: Surface, output?: Rect) {
    if (output) {
      this.checkFrameCurrent()
      // The native suffix only narrows this pass's writes. Both source inputs
      // retain their original bounds/addresses; no preliminary copy or new
      // rounding boundary is introduced, including zero-weight neighbours.
      const result = this.run(this.scene.integratedBlur && mode === 'normal' && opacity < 1 ? 29 : 3,
        output, mask ? [src, dst, mask] : [src, dst], u => {
          u.set([u[16], blends.indexOf(mode), opacity, mask ? 1 : 0], 16)
        })
      this.release(dst)
      return result
    }
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
      const plan=normalMergeRegion(src.rect,dst.rect)
      if(plan&&!plan.before)return dst
      if(plan?.before){
        const {x,y,w,h}=plan.region,before=this.copy(dst,plan.before)
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
    if (!/^data:image\/(png|jpeg|webp);base64,/.test(uri))
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
      try {
      // Images share the one surface ledger; pressure evicts older images
      // first instead of failing the frame.
      if (this.overBudget(image.width * image.height * 16, image.width, image.height)) throw this.budgetError('GPU 浮点图片内存预算超限', 4)
      if (!image.linearRows && intoAtlas && image.width <= ATLAS_MAX_IMAGE && image.height <= ATLAS_MAX_IMAGE)
        return this.writeAtlasSlot(uri, level, image.width, image.height, { floats: bakeFloats(image.pixels) }, adjust)
      const rows=image.linearRows
      const texture = rows ? (()=>{
        if(!this.driver.uploadLinearRows)throw Error('后端不支持完整分行图片上传')
        let chunks=0,pixels=0,maximum=0,complete=false
        const started=gpuDiagnosticsEnabled()?performance.now():0
        const adjusted=function*(){for(const row of rows()){
          const values=bakeFloats(row.pixels)
          yield {...row,pixels:values}
          chunks++;pixels+=values.length/4;maximum=Math.max(maximum,values.byteLength)
        }}
        try {const texture=this.driver.uploadLinearRows(image.width,image.height,adjusted());complete=true;return texture}
        finally {if(gpuDiagnosticsEnabled())try{recordGpuDiagnostic('cache',{width:image.width,height:image.height,
          imageRowChunks:chunks,imageRowPixels:pixels,imageRowMaxBytes:maximum,imageRowReason:image.linearRowReason??0,
          imageRowOutcome:complete?1:2,durationMs:performance.now()-started})}catch{/* diagnostics never change upload ownership */}}
      })() : this.driver.uploadLinear(bakeFloats(image.pixels), image.width, image.height)
      const descriptor = this.staticImageSourceDescriptor(uri, level, intoAtlas, adjust), proof = this.driver.imageTableRange?.(texture)
      if (descriptor && proof) this.staticImageBlurs.registerUpload(texture, proof, descriptor.uri, descriptor.policy)
      this.bytes += texture.bytes
      this.peak = Math.max(this.peak, this.bytes)
      this.used.add(texture)
      this.touch(texture)
      return { texture, rect: rect(0, 0, image.width, image.height) }
      } finally { image.dispose?.() }
    }
    if (!this.managedImageLoader || !this.driver.uploadRgba8)
      throw new Error('后端缺少统一的图片解码器')
    // Source assets share Rust's ICC/orientation/premultiplication boundary.
    // The GPU still samples and composites every scene pixel itself.
    const image = this.managedImageLoader(uri, true, level)
    try {
    if (!image.bytes || image.bytes.length !== image.width * image.height * 4)
      throw new Error('无效的预乘 RGBA8 图片资源')

    // Do not silently substitute a coarser source when this admission fails.
    // The caller must retain the error/retry contract rather than cache lower
    // fidelity pixels as a successfully rendered native-density tile.
    if (level === 0 && image.width * image.height > 16_777_216)
      throw new Error('GPU 图片像素预算超限')
    if (this.overBudget(image.bytes.length, image.width, image.height)) throw this.budgetError('GPU 图片总内存预算超限', 5)
    if (intoAtlas && image.width <= ATLAS_MAX_IMAGE && image.height <= ATLAS_MAX_IMAGE)
      return this.writeAtlasSlot(uri, level, image.width, image.height, { bytes: bake(image.bytes) }, adjust)
    const texture = this.driver.uploadRgba8(bake(image.bytes), image.width, image.height)
    this.bytes += texture.bytes
    this.peak = Math.max(this.peak, this.bytes)
    this.used.add(texture)
    this.touch(texture)
    return { texture, rect: rect(0, 0, image.width, image.height) }
    } finally { image.dispose?.() }
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
        throw this.budgetError('GPU 图集页内存预算超限', 6, 0, SurfaceAllocationSite.atlasPage)
      }
      this.bytes += texture.bytes
      this.peak = Math.max(this.peak, this.bytes)
      if (gpuDiagnosticsEnabled()) try { this.surfaceAllocationTags.set(texture, surfaceAllocationTag(SurfaceAllocationSite.atlasPage)) } catch { /* diagnostic only */ }
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
  /** Cache base dimensions without retaining a transient row decoder. */
  private baseDims(uri: string): [number, number] {
    this.requireImageResidencyCurrent()
    let dims = this.imageDims.get(uri)
    if (!dims) {
      if (!this.managedImageLoader) throw new Error('后端缺少统一的图片解码器')
      const info = this.managedImageLoader(uri, !(this.scene.floatCompositing || this.scene.colorManagement), 0)
      try { dims = [info.width, info.height]; this.imageDims.set(uri, dims) }
      finally { info.dispose?.() }
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
    this.requireImageResidencyCurrent()
    const key = this.imageKey(uri, level, intoAtlas, adjust)
    let surface = this.images.get(key)
    if (!surface) {
      surface = this.uploadImage(uri, level, intoAtlas, adjust)
      this.images.set(key, surface)
      this.imageAssetCounters.uploads++
    } else this.imageAssetCounters.hits++
    // Stamp the use: this frame's commands pin the image against synchronous
    // eviction until a completed checkpoint proves them finished.
    this.used.add(surface.texture)
    this.touch(surface.texture)
    return surface
  }
  private currentImageResidency(scene: GpuScene) {
    // Image ownership is independent of the filter implementation. A regional
    // packet can omit an immutable document image and need it again on the next
    // tile. Keep its existing upload only under the same private owner, policy,
    // completion and working-budget rules used by the clamped-filter candidate.
    if ((!this.residentImageRequest && !this.frameImageReuse && import.meta.env.VITE_DESIGN_EXACT_CLAMP_PREFIX !== '1' &&
        import.meta.env.VITE_DESIGN_IMAGE_ASSET_RESIDENCY !== '1') ||
        this.driver.name !== 'webgpu' || !this.driver.waitForSubmittedWork) return
    let owner: ImageResidencyOwner | undefined
    try { owner = imageLoaderResidencyOwner(this.managedImageLoader) }
    catch (error) {
      if (this.imageResidencyOwner && !imageResidencyOwnerCurrent(this.imageResidencyOwner)) this.retireImageResidency()
      throw error
    }
    if (!owner) return
    const policy = JSON.stringify([!!scene.floatCompositing, scene.colorManagement || null,
      this.driver.name, this.driver.managed, this.driver.linearLight, this.driver.hdr])
    return { owner, policy }
  }
  /** Remove lookup authority immediately on owner change. Submitted old reads
   * and optional filter borrows keep their storage charged until covered. */
  private retireImageResidency() {
    const textures = new Set([...this.images.values()].map(surface => surface.texture))
    for (const page of this.atlasPages) textures.add(page.texture)
    this.images.clear(); this.imageOrigins.clear(); this.imageDims.clear(); this.atlasPages = []
    this.horizontalFilters.clear(); this.retireDisplayMaterial()
    const epoch = this.driver.resourceEpoch
    for (const texture of textures) {
      this.staticImageBlurs.retireSource(texture)
      this.retiredImageAssets.set(texture, { epoch: Number.isSafeInteger(epoch) && epoch! >= 0 ? epoch! : Infinity, covered: false })
      this.imageAssetCounters.scopeRetiredTextures++
    }
    this.imageResidencyOwner = undefined; this.imageResidencyPolicy = undefined
    this.collectRetiredImageAssets()
  }
  private collectRetiredImageAssets() {
    for (const [texture, entry] of this.retiredImageAssets) {
      // The detached, unpinned cohort was covered by its own later real
      // boundary. The driver's coarse per-frame completed epoch can remain
      // e-1 after checkpoint(e), since that frame may encode more commands;
      // it must neither grant this proof nor block the stronger cohort proof.
      if (!entry.covered || !this.unpinnedImageAsset(texture)) continue
      this.retiredImageAssets.delete(texture)
      this.forgetUpload(texture)
    }
  }
  private unpinnedImageAsset(texture: Texture) {
    return !this.pendingImageTableSources.has(texture) && !this.sequentialImagePins.has(texture) && !this.admissionPins.has(texture) &&
      !this.driver.hasActiveImageTableSource?.(texture) && !this.staticImageBlurs.pinsSource(texture)
  }
  private retiredImageAssetCohort() {
    // A live borrower could encode another read after this boundary. Such a
    // source needs a later boundary after its final pin has been returned.
    return new Map([...this.retiredImageAssets].filter(([texture, entry]) => !entry.covered && this.unpinnedImageAsset(texture)))
  }
  private coverRetiredImageAssets(cohort: ReturnType<GpuRenderer['retiredImageAssetCohort']>) {
    for (const [texture, entry] of cohort) if (this.retiredImageAssets.get(texture) === entry && this.unpinnedImageAsset(texture))
      entry.covered = true
    this.collectRetiredImageAssets()
  }
  private requireImageResidencyCurrent() {
    if (!this.imageResidencyOwner) return
    const next = this.currentImageResidency(this.scene)
    if (next?.owner === this.imageResidencyOwner && next.policy === this.imageResidencyPolicy) return
    this.retireImageResidency()
    throw Error('PREVIEW_CANCELLED')
  }
  /** Scheduling hint only: avoid an optional disk read for a likely GPU hit.
   * loadImages/imageFor still validate the real owner and policy, and decode
   * normally after eviction or invalidation. This never authorizes sampling. */
  private imageHydrationHint?: { owner: ImageResidencyOwner; policy: string }
  hasUploadedImageSource(scene: GpuScene, uri: string): boolean {
    const previous=this.imageHydrationHint
    if (!previous || previous.policy!==JSON.stringify([!!scene.floatCompositing,scene.colorManagement||null])) return false
    const owner=imageLoaderResidencyOwner(this.managedImageLoader)
    return owner===previous.owner && imageResidencyOwnerCurrent(owner) && [...this.images.keys()].some(key => isLevelKey(key, uri))
  }
  private async loadImages(scene: GpuScene) {
    const needed = sceneIndex(scene).images
    const next = this.currentImageResidency(scene)
    // Required images may survive native pose samples under their private owner.
    // This does not retain unused assets from other regions.
    if (!next) this.frameImageReuse = false
    const retainUnused = !!next && (this.residentImageRequest || import.meta.env.VITE_DESIGN_EXACT_CLAMP_PREFIX === '1' ||
      import.meta.env.VITE_DESIGN_IMAGE_ASSET_RESIDENCY === '1')
    const changed = this.imageResidencyOwner !== next?.owner || this.imageResidencyPolicy !== next?.policy
    if (changed && (this.imageResidencyOwner || next)) this.retireImageResidency()
    this.imageResidencyOwner = next?.owner; this.imageResidencyPolicy = next?.policy
    this.collectRetiredImageAssets()
    const retiring = this.retiredImageAssetCohort()
    if (this.retiredImageAssets.size && this.driver.waitForSubmittedWork) {
      this.checkFrameCurrent()
      const scratch = this.driver.scratchBytes || 0
      try { await this.driver.waitForSubmittedWork() }
      finally { this.bytes += (this.driver.scratchBytes || 0) - scratch }
      this.staticImageBlurs.collect(this.driver.completedResourceEpoch)
      this.coverRetiredImageAssets(retiring)
      this.checkFrameCurrent()
      if (next) this.requireImageResidencyCurrent()
    }

    const pageTextures = new Set(this.atlasPages.map(page => page.texture))
    for (const [key, surface] of this.images) {
      // An atlas page has one physical lifetime and ledger entry, even when
      // some of its image slots are no longer needed by this scene.
      if (pageTextures.has(surface.texture)) continue
      if ([...needed].some(uri => isLevelKey(key, uri))) continue
      // A regional scene's image subset is not the document's asset lifetime.
      // Only this private current owner may retain unused immutable uploads;
      // ordinary LRU/working pressure still owns their complete byte ledger.
      if (retainUnused) continue
      this.staticImageBlurs.retireSource(surface.texture)
      // A canceled prior frame can still own GPU reads. Such an optional
      // source leaves on a later completed frame, never before those reads.
      if (this.staticImageBlurs.pinsSource(surface.texture)) continue
      this.images.delete(key)
      this.imageAssetCounters.legacyPrunes++
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
      if (retainUnused) continue
      this.destroyAtlasPage(page)
      this.imageAssetCounters.legacyPrunes++
    }
    for (const uri of this.imageDims.keys())
      if (!retainUnused && !needed.has(uri)) this.imageDims.delete(uri)
    // Validate every referenced source eagerly (same failure point as before),
    // but upload lazily at first sampling: an eagerly uploaded but not yet
    // sampled image would pin its bytes against eviction for the whole frame,
    // defeating the shared-budget working set this ledger provides.
    for (const uri of needed) {
      if ([...this.images.keys()].some((key) => isLevelKey(key, uri))) continue
      if (!/^data:image\/(png|jpeg|webp);base64,/.test(uri))
        throw new Error('无效的 GPU 图片资源')
      if ((scene.floatCompositing || scene.colorManagement) &&
        (!this.managedImageLoader || !this.driver.uploadLinear))
        throw new Error('后端缺少受管理的浮点图片解码器')
      if (!(scene.floatCompositing || scene.colorManagement) &&
        (!this.managedImageLoader || !this.driver.uploadRgba8))
        throw new Error('后端缺少统一的图片解码器')
    }
    const hintOwner=imageLoaderResidencyOwner(this.managedImageLoader)
    this.imageHydrationHint=hintOwner ? {owner:hintOwner,policy:JSON.stringify([!!scene.floatCompositing,scene.colorManagement||null])} : undefined
  }
  /** Numeric callsites: 1 ordinary compact probe, 2 ordinary region, 3 sync
   * paint, 4 streamed leaf region, 5 filter resolve, 6 table, 7 table probe. */
  private imageFieldDiagnostic(n: GpuNode, callsite: number, stage: number, outcome: number, axes: number, level: number) {
    if (!gpuDiagnosticsEnabled()) return
    try { recordGpuDiagnostic('filter', this.imageFieldSnapshot(n, callsite, stage, outcome, axes, level)) }
    catch { /* diagnostics cannot replace the original error */ }
  }
  private imageFieldSnapshot(n: GpuNode, callsite: number, stage: number, outcome: number, axes: number, level: number): Record<string, number> {
    const source = n.previewSource || n
    return { imageFieldCallsite: callsite, imageFieldStage: stage,
      imageFieldOutcome: outcome, imageFieldAxes: axes, imageFieldSample: this.sampleIndex ?? 4,
      imageFieldLevel: level, imageFieldWidth: n.rect.w, imageFieldHeight: n.rect.h,
      imageFieldSourceWidth: source.rect.w, imageFieldSourceHeight: source.rect.h,
      imageFieldDenseBytes: n.rect.w * n.rect.h * 16 }
  }
  private imageGrid(n: GpuNode, p: GpuPaint, image: Surface, level = 0, origin: [number, number] = [0, 0], preparedAxes?: Float32Array, callsite = 0, retainField = true): Surface {
    const trace = { stage: 1, axes: preparedAxes?.length ? 1 : 0 }
    const previous = this.activeImageFieldFailure
    if (gpuDiagnosticsEnabled()) this.activeImageFieldFailure = () => this.imageFieldSnapshot(n, callsite, trace.stage, 2, trace.axes, level)
    try { return this.imageGridExact(n, p, image, level, origin, preparedAxes, trace, retainField) }
    catch (error) { this.imageFieldDiagnostic(n, callsite, trace.stage, 2, trace.axes, level); throw error }
    finally { this.activeImageFieldFailure = previous }
  }
  private imageGridExact(n: GpuNode, p: GpuPaint, image: Surface, level: number, origin: [number, number], preparedAxes: Float32Array | undefined, trace: {stage: number; axes: number}, retainField: boolean): Surface {
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
      trace.stage = 2
      let values = preparedAxes ?? new Float32Array()
      if (!values.length && compact) {
        // A span-only oversize proof may still admit the dense grid; keep the
        // kernel guard from failing the request before that cheaper check.
        try { values = image_sampling_axes_placed(...arguments_) }
        catch (error) { if (!isSamplingFieldOverGuardError(error)) throw error }
      }
      trace.axes = values.length ? 1 : 2
      if (!values.length) {
        trace.stage = 3
        if (this.driver.managed && this.overBudget(n.rect.w * n.rect.h * 16, n.rect.w, n.rect.h)) throw this.budgetError('GPU 表面内存预算超限', 7)
        trace.stage = 4
        values = this.driver.managed ? image_sampling_grid_placed(...arguments_) : image_byte_sampling_field_placed(...arguments_)
      }
      trace.stage = 5
      separated = this.driver.managed ? values[3] === -1 : values[3] === 1
      this.imageFieldBytes += values.byteLength
      return values
    }, this.driver.uploadParameters, () => [separated ? Math.max(n.rect.w,n.rect.h) : n.rect.w, separated ? 2 : n.rect.h], 0,
      retainField && import.meta.env.VITE_DESIGN_RETAIN_PARAMETER_FIELDS !== '0')
    if (separated !== undefined) this.imageAxes.set(surface.texture,separated)
    if (this.driver.managed && this.imageAxes.get(surface.texture)) this.imageAxisFields++
    if (!grids) {
      grids = new Map()
      this.imageGrids.set(p, grids)
    }
    grids.set(sample, surface)
    return surface
  }
  private gradientAxisGrid(n:GpuNode,p:GpuPaint):Surface|undefined {
    if(p.kind!=='linear'||import.meta.env.VITE_DESIGN_GRADIENT_AXES==='0'||!this.driver.uploadLinear)return
    const source=n.previewSource||n,sample=this.sampleIndex??4
    if(source.rect.w!==n.rect.w||source.rect.h!==n.rect.h)return
    if(this.sourceTileOcclusion && this.skippedPainterVisits && this.driver.gradientPhaseFields &&
        sample<4 && p.stops.length===2 && p.stops[0].offset===0 && p.stops[1].offset===1 &&
        p.blend==='normal' && p.opacity>=0 && p.opacity<=1 &&
        p.stops.every(stop=>/^#[\da-f]{6}([\da-f]{2})?$/i.test(stop.color))){
      const corners=this.linearGradientCorners(n,p,sample)
      if(corners){
        let grids=this.imageGrids.get(p)
        if(!grids){grids=new Map();this.imageGrids.set(p,grids)}
        grids.set(sample,corners)
        return corners
      }
    }
    if(this.gradientPhaseRequest&&this.driver.gradientPhaseFields&&sample<4){
      const grouped=this.gradientAxisPhases(n,p,sample)
      if(grouped!==false)return grouped
    }
    const parameters={kind:p.kind,color:'#000000',angle:p.angle,transform:p.transform,stops:p.stops.map(s=>({offset:s.offset,color:'#000000'}))}
    const inputs=['gradient-axis-grid',source.rect,source.matrix,n.size,parameters,sample]
    const cached=this.optimized&&import.meta.env.VITE_DESIGN_RETAIN_PARAMETER_FIELDS!=='0'
      ?this.materialFields.get(JSON.stringify(inputs,(_key,value)=>Object.is(value,-0)?'-0':value),new Uint32Array(0)):undefined
    if(cached){
      this.fieldHits++;this.busy.add(cached);this.used.add(cached);this.touch(cached)
      const surface={texture:cached,rect:rect(n.rect.x,n.rect.y,cached.width,cached.height)}
      let grids=this.imageGrids.get(p);if(!grids){grids=new Map();this.imageGrids.set(p,grids)}grids.set(sample,surface)
      return surface
    }
    const started=performance.now()
    const packed=gradient_sampling_axes(JSON.stringify(source.rect),new Float64Array(source.matrix),new Float64Array(n.size),JSON.stringify(parameters),sample)
    this.fieldBuildMs+=performance.now()-started
    if(!packed.length)return
    const w=packed[0],h=packed[1],values=packed.subarray(4)
    if(!Number.isSafeInteger(w)||!Number.isSafeInteger(h)||w<1||h<1||values.length!==w*h*4)throw Error('Invalid compact gradient field')
    const surface=this.materialField(inputs,rect(n.rect.x,n.rect.y,w,h),()=>values,
      (this.driver.uploadParameters||this.driver.uploadLinear),undefined,values.byteLength,import.meta.env.VITE_DESIGN_RETAIN_PARAMETER_FIELDS!=='0')
    let grids=this.imageGrids.get(p);if(!grids){grids=new Map();this.imageGrids.set(p,grids)}grids.set(sample,surface)
    return surface
  }
  private gradientAxisPhases(n:GpuNode,p:GpuPaint,sample:number):Surface|undefined|false{
    const source=n.previewSource||n,parameters={kind:p.kind,color:'#000000',angle:p.angle,transform:p.transform,stops:p.stops.map(s=>({offset:s.offset,color:'#000000'}))}
    const inputs=['gradient-phase-axis',source.rect,source.matrix,n.size,parameters]
    const key=JSON.stringify(inputs,(_key,value)=>Object.is(value,-0)?'-0':value)
    let texture=this.optimized?this.materialFields.get(key,new Uint32Array(0)):undefined
    if(texture)this.fieldHits++
    else{
      const started=performance.now(),bounds=JSON.stringify(source.rect),matrix=new Float64Array(source.matrix),size=new Float64Array(n.size),paint=JSON.stringify(parameters)
      const first=gradient_sampling_axes(bounds,matrix,size,paint,sample)
      if(!first.length){this.fieldBuildMs+=performance.now()-started;return}
      const aw=first[0],ah=first[1],count=aw*ah
      if(!Number.isSafeInteger(count)||aw<1||ah<1||first.length!==4+count*4)throw Error('Invalid gradient axis field')
      if(count*64>32*1024*1024){this.fieldBuildMs+=performance.now()-started;return false}
      const width=Math.min(2048,count*4),height=Math.ceil(count*4/width),values=new Float32Array(width*height*4)
      for(let phase=0;phase<4;phase++){
        const current=phase===sample?first:gradient_sampling_axes(bounds,matrix,size,paint,phase)
        if(current[0]!==aw||current[1]!==ah||current.length!==first.length)throw Error('Gradient phase axis proof changed')
        values.set(current.subarray(4),phase*count*4)
      }
      this.fieldBuildMs+=performance.now()-started
      texture=this.materialField(inputs,n.rect,()=>values,(data,w,h)=>{
        const texture=(this.driver.uploadParameters||this.driver.uploadLinear)!.call(this.driver,data,w,h)
        this.gradientPhaseResources.set(texture,{resource:texture.resource,width:n.rect.w,height:n.rect.h,axis:[aw,ah]})
        return texture
      },()=>[width,height],values.byteLength).texture
    }
    const proof=this.gradientPhaseResources.get(texture)
    if(!proof?.axis||proof.resource!==texture.resource)throw Error('Gradient phase axis resource changed')
    this.busy.add(texture);this.used.add(texture);this.touch(texture)
    const surface={texture,rect:n.rect};let grids=this.imageGrids.get(p)
    if(!grids){grids=new Map();this.imageGrids.set(p,grids)}
    for(let phase=0;phase<4;phase++)grids.set(phase,surface)
    return surface
  }
  private configureGradientPhase(u:Float32Array,field:Surface){
    if(field.linearParameterCorners){
      u.set([field.rect.w,field.rect.h,8],189)
      return
    }
    const texture=field.texture
    const phase=this.gradientPhaseResources.get(texture)
    if(!phase)return
    if(phase.resource!==texture.resource||this.sampleIndex===undefined||this.sampleIndex>3)throw Error('Invalid gradient phase binding')
    u[191]=(phase.axis?-1:1)*(this.sampleIndex+1)
    if(phase.axis)u.set(phase.axis,189)
  }
  private gradientPhaseEligible(n:GpuNode,p:GpuPaint){
    const source=n.previewSource||n
    return this.gradientPhaseRequest&&!!this.driver.gradientPhaseFields&&!!this.driver.uploadGradientPhaseField&&
      this.sampleIndex!==undefined&&this.sampleIndex<4&&p.stops.length<=3&&
      ['linear','radial','angular','diamond'].includes(p.kind)&&n.rect.w*n.rect.h>4096&&n.rect.w*n.rect.h<=4_194_304&&
      source.rect.w===n.rect.w&&source.rect.h===n.rect.h
  }
  private prepareGradientPhase(n:GpuNode,p:GpuPaint,build=true):Promise<void>|undefined{
    if(!this.gradientPhaseEligible(n,p)||this.imageGrids.get(p)?.has(this.sampleIndex!))return
    const source=n.previewSource||n
    const parameters={kind:p.kind,color:'#000000',angle:p.angle,transform:p.transform,stops:p.stops.map(s=>({offset:s.offset,color:'#000000'}))}
    const inputs=['gradient-phase-grid',[n.rect.w,n.rect.h],source.rect,source.matrix,n.size,parameters]
    const key=JSON.stringify(inputs,(_key,value)=>Object.is(value,-0)?'-0':value)
    const bind=(texture:Texture)=>{
      const proof=this.gradientPhaseResources.get(texture)
      if(!proof||proof.resource!==texture.resource||proof.width!==n.rect.w||proof.height!==n.rect.h)throw Error('Gradient phase resource changed')
      this.busy.add(texture);this.used.add(texture);this.touch(texture)
      let grids=this.imageGrids.get(p);if(!grids){grids=new Map();this.imageGrids.set(p,grids)}
      for(let sample=0;sample<4;sample++)grids.set(sample,{texture,rect:n.rect})
    }
    const cached=this.optimized&&this.materialFields.get(key,new Uint32Array(0))
    if(cached){this.fieldHits++;bind(cached);return}
    if(!build||this.gradientPhaseDeclined.has(key)||this.gradientAxisGrid(n,p))return
    // One attempt per exact source in this frame. If pressure discards an
    // uncached program, later samples use the existing dense path instead of
    // repeatedly building all phases. No new metadata cache survives frames.
    this.gradientPhaseDeclined.add(key)
    return (async()=>{
      const builder=new GradientPhaseFieldBuilder(JSON.stringify(source.rect),new Float64Array(source.matrix),new Float64Array(n.size),JSON.stringify(parameters))
      let values:Uint32Array
      try{
        for(;;){
          this.checkFrameCurrent();const started=performance.now(),done=builder.advance()
          this.fieldBuildMs+=performance.now()-started
          if(done)break
          const pause=this.yieldEncoding();if(pause)await pause
        }
        values=builder.finish()
      }finally{builder.free()}
      if(!values.length)return
      this.checkFrameCurrent()
      const layout=gradientPhaseFieldLayout(values)
      if(layout.sourceWidth!==n.rect.w||layout.sourceHeight!==n.rect.h)throw Error('Gradient phase dimensions changed')
      const bytes=new Uint8Array(values.buffer,values.byteOffset,values.byteLength)
      const surface=this.materialField(inputs,n.rect,()=>bytes,()=>{
        const texture=this.driver.uploadGradientPhaseField!(values)
        this.gradientPhaseResources.set(texture,{resource:texture.resource,width:n.rect.w,height:n.rect.h})
        // The native codec encodes only the original finite tuples. Stop
        // indices come from partitioning this exact bounded source list;
        // decoded f32 weights retain their bits, including subnormals/+0.
        this.gradientFieldProofs.set(texture,{resource:texture.resource,maximumStop:p.stops.length-1})
        return texture
      },()=>[layout.width,layout.height],bytes.byteLength)
      bind(surface.texture)
    })()
  }
  private linearGradientCorners(n:GpuNode,p:GpuPaint,sample:number):Surface|undefined {
    const source=n.previewSource||n, bounds=source.rect, matrix=source.matrix, transform=p.transform
    if(bounds.w<2 || bounds.h<2 || bounds.w>1024 || bounds.h>1024 || bounds.w*bounds.h<4096)return
    // Bound coordinate cancellation in very distant or near-singular paints.
    const axes=matrix.slice(0,4), norm=Math.hypot(...axes)
    if(!norm || !axes.every(v=>Math.abs(v)<=4096) || Math.abs(matrix[0]*matrix[3]-matrix[1]*matrix[2])<norm ||
        ![bounds.x,bounds.y,matrix[4],matrix[5]].every(v=>Math.abs(v)<=2**22) || !n.size.every(v=>v>=1&&v<=65536) ||
        transform && (!transform.every(v=>Math.abs(v)<=4)||Math.abs(transform[0]*transform[3]-transform[1]*transform[2])<1/16))return
    const original=JSON.stringify(bounds), placement=new Float64Array(matrix), size=new Float64Array(n.size)
    const paint=JSON.stringify({kind:p.kind,color:'#000000',angle:p.angle,transform,stops:p.stops.map(s=>({offset:s.offset,color:'#000000'}))})
    const values=new Float32Array(16)
    for(let i=0;i<4;i++){
      const point=rect(bounds.x+(i%2)*(bounds.w-1),bounds.y+Math.floor(i/2)*(bounds.h-1),1,1)
      const tuple=gradient_sampling_grid_region(original,JSON.stringify(point),placement,size,paint,sample)
      // All four corners must be strictly inside the same stop interval.
      // A linear coordinate is affine there. A tile crossing a stop keeps
      // its full field, including hard stops and clamped portions.
      if(tuple.length!==4||tuple[0]!==0||tuple[1]!==1||!(tuple[2]>0&&tuple[2]<1))return
      values.set(tuple,i*4)
    }
    const field=this.materialField(['gradient-corners',Array.from(values)],rect(0,0,2,2),()=>values,
      this.driver.uploadParameters||this.driver.uploadLinear!)
    return {texture:field.texture,rect:n.rect,linearParameterCorners:true}
  }
  private gradientGrid(n: GpuNode, p: GpuPaint): Surface {
    this.prepareGradientPhase(n,p,false)
    const sample = this.sampleIndex ?? 4
    let grids = this.imageGrids.get(p)
    const known = grids?.get(sample)
    if (known) {
      this.touch(known.texture)
      return known
    }
    const axis=this.gradientAxisGrid(n,p);if(axis)return axis
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
      (this.driver.uploadParameters||this.driver.uploadLinear),undefined,n.rect.w*n.rect.h*16,import.meta.env.VITE_DESIGN_RETAIN_PARAMETER_FIELDS !== '0')
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

  /** Keep the Rust field bound intact. Oversized nonseparable fields are
   * generated in exact global-coordinate regions, never resampled/downscaled. */
  private paintWithBoundedImageFields(n: GpuNode, p: GpuPaint, mask: Surface): Surface | Promise<Surface> {
    const phase=this.prepareGradientPhase(n,p)
    if(phase)return phase.then(()=>this.paintWithBoundedImageFields(n,p,mask))
    const source = n.previewSource || n
    if(import.meta.env.VITE_DESIGN_GRADIENT_WINDOW_FIELDS==='1'&&this.driver.windowedGradientFields&&this.driver.captureDisplay&&
        this.scene.nativeInteraction&&this.scene.interactionRetained&&!this.interactionCapturing&&!this.scene.softwareRaster&&
        ['linear','radial','angular','diamond'].includes(p.kind)&&n.rect.w*n.rect.h<=4_194_304&&
        source.rect.w===n.rect.w&&source.rect.h===n.rect.h&&
        exactBlendLattice([n.rect,source.rect])){
      const draw=this.drawRegion(n.rect)
      if(draw&&(!draw.w||!draw.h)){
        // Validate the same original domain/paint before avoiding an unread
        // field. run() still creates and clears the original full color target,
        // so its later composition (including zero/NaN neighbours) is unchanged.
        const parameters={kind:p.kind,color:'#000000',angle:p.angle,transform:p.transform,stops:p.stops.map(s=>({offset:s.offset,color:'#000000'}))}
        gradient_sampling_grid_region(JSON.stringify(source.rect),JSON.stringify(rect(source.rect.x,source.rect.y,0,0)),
          new Float64Array(source.matrix),new Float64Array(n.size),JSON.stringify(parameters),this.sampleIndex??4)
        return this.paint(n,p,mask,undefined,true,mask)
      }
    }
    if (this.driver.managed && this.driver.name === 'webgpu' && this.driver.captureDisplay &&
        ['linear','radial','angular','diamond'].includes(p.kind) && n.rect.w*n.rect.h>262_144 &&
        n.rect.w*n.rect.h<=4_194_304 && source.rect.w===n.rect.w && source.rect.h===n.rect.h)
      return this.paintWithCooperativeGradient(n,p,mask)
    if (p.kind !== 'image' || !this.driver.managed || this.driver.name !== 'webgpu' || this.imageAtlas ||
        !samplingFieldOverGuard(n.rect) ||
        source.rect.w !== n.rect.w || source.rect.h !== n.rect.h || !exactBlendLattice([n.rect, source.rect]))
      return this.paint(n, p, mask, undefined, true)
    const sample = this.sampleIndex ?? 4
    if (this.imageGrids.get(p)?.has(sample)) return this.paint(n, p, mask, undefined, true)
    const level = this.imageLevel(n, p), image = this.imageFor(p.image || '', level, false, p.adjust)
    if (this.prepareLargeImageAxes(n, p, image, level)) return this.paint(n, p, mask, undefined, true)
    return this.paintImageFieldRegions(n, p, mask, image, level)
  }
  private async paintWithCooperativeGradient(n:GpuNode,p:GpuPaint,mask:Surface):Promise<Surface> {
    const sample=this.sampleIndex??4,source=n.previewSource||n
    if(this.imageGrids.get(p)?.has(sample)||this.gradientAxisGrid(n,p))return this.paint(n,p,mask,undefined,true)
    const parameters={kind:p.kind,color:'#000000',angle:p.angle,transform:p.transform,stops:p.stops.map(s=>({offset:s.offset,color:'#000000'}))}
    const inputs=['gradient-grid',[n.rect.w,n.rect.h],source.rect,source.matrix,n.size,parameters,sample]
    const key=JSON.stringify(inputs,(_key,value)=>Object.is(value,-0)?'-0':value)
    if(this.optimized&&import.meta.env.VITE_DESIGN_RETAIN_PARAMETER_FIELDS!=='0'&&this.materialFields.get(key,new Uint32Array(0)))
      return this.paint(n,p,mask,undefined,true)
    const visible=this.drawRegion(n.rect)
    if(import.meta.env.VITE_DESIGN_GRADIENT_WINDOW_FIELDS==='1'&&this.driver.windowedGradientFields&&
        this.scene.nativeInteraction&&!this.scene.softwareRaster&&!this.driver.hdr&&visible&&visible.w>0&&visible.h>0&&
        visible.w*visible.h<n.rect.w*n.rect.h*.9&&exactBlendLattice([n.rect,source.rect,visible])){
      return this.paintWithGradientWindow(n,p,mask,visible,parameters,inputs)
    }
    const bytes=n.rect.w*n.rect.h*16
    if(this.overBudget(bytes,n.rect.w,n.rect.h))throw this.budgetError('GPU 表面内存预算超限',2,3)
    const values=new Float32Array(n.rect.w*n.rect.h*4),rows=Math.max(1,Math.min(32,Math.floor(65_536/n.rect.w)))
    const original=JSON.stringify(source.rect),matrix=new Float64Array(source.matrix),size=new Float64Array(n.size),paint=JSON.stringify(parameters)
    for(let y=0;y<n.rect.h;y+=rows){
      this.checkFrameCurrent()
      const started=performance.now(),height=Math.min(rows,n.rect.h-y)
      const band=gradient_sampling_grid_region(original,JSON.stringify(rect(source.rect.x,source.rect.y+y,n.rect.w,height)),matrix,size,paint,sample)
      values.set(band,y*n.rect.w*4);this.fieldBuildMs+=performance.now()-started
      const pause=this.yieldEncoding();if(pause)await pause
    }
    this.checkFrameCurrent()
    if(!this.driver.uploadLinear)throw Error('后端不支持精确渐变参数字段')
    const surface=this.materialField(inputs,n.rect,()=>values,(this.driver.uploadParameters||this.driver.uploadLinear),undefined,bytes,import.meta.env.VITE_DESIGN_RETAIN_PARAMETER_FIELDS!=='0')
    let grids=this.imageGrids.get(p);if(!grids){grids=new Map();this.imageGrids.set(p,grids)}grids.set(sample,surface)
    return this.paint(n,p,mask,undefined,true)
  }
  private async paintWithGradientWindow(n:GpuNode,p:GpuPaint,mask:Surface,local:Rect,parameters:unknown,inputs:unknown[]):Promise<Surface>{
    const source=n.previewSource||n,sample=this.sampleIndex??4
    const region=rect(n.rect.x+local.x,n.rect.y+local.y,local.w,local.h)
    const sourceRegion=rect(source.rect.x+local.x,source.rect.y+local.y,local.w,local.h)
    const windowInputs=['gradient-window',...inputs,local]
    const key=JSON.stringify(windowInputs,(_key,value)=>Object.is(value,-0)?'-0':value)
    const original=JSON.stringify(source.rect),matrix=new Float64Array(source.matrix),size=new Float64Array(n.size),paint=JSON.stringify(parameters)
    let values:Float32Array|undefined
    const cached=this.optimized&&import.meta.env.VITE_DESIGN_RETAIN_PARAMETER_FIELDS!=='0'&&this.materialFields.get(key,new Uint32Array(0))
    if(!cached){
      const bytes=local.w*local.h*16
      if(this.overBudget(bytes,local.w,local.h))await this.reclaimScratch(bytes)
      this.checkFrameCurrent()
      values=new Float32Array(local.w*local.h*4)
      const rows=Math.max(1,Math.min(32,Math.floor(65_536/local.w)))
      for(let y=0;y<local.h;y+=rows){
        this.checkFrameCurrent();const started=performance.now(),height=Math.min(rows,local.h-y)
        const band=gradient_sampling_grid_region(original,JSON.stringify(rect(sourceRegion.x,sourceRegion.y+y,local.w,height)),matrix,size,paint,sample)
        values.set(band,y*local.w*4);this.fieldBuildMs+=performance.now()-started
        const pause=this.yieldEncoding();if(pause)await pause
      }
    }
    this.checkFrameCurrent()
    const surface=this.materialField(windowInputs,region,()=>values||gradient_sampling_grid_region(original,JSON.stringify(sourceRegion),matrix,size,paint,sample),
      this.driver.uploadParameters||this.driver.uploadLinear!,undefined,local.w*local.h*16,import.meta.env.VITE_DESIGN_RETAIN_PARAMETER_FIELDS!=='0')
    // Keep n.rect and the original scissor/halo. Only unused coordinate texels
    // disappear; the color surface and all later zero/NaN neighbours stay intact.
    return this.paint(n,p,mask,undefined,true,surface)
  }
  /** Probe one original phase only. A certified full compact field stays
   * reusable across bands; only its dense fallback needs regional generation. */
  private prepareLargeImageAxes(n: GpuNode, p: GpuPaint, image: Surface, level: number, callsite = 1): boolean {
    if (this.imageGrids.get(p)?.has(this.sampleIndex ?? 4)) return true
    if (this.scene.compactImageFields === false || import.meta.env.VITE_DESIGN_IMAGE_AXES === '0') return false
    const source = n.previewSource || n
    let values: Float32Array
    try { values = image_sampling_axes_placed(JSON.stringify(source.rect), new Float64Array(source.matrix),
      new Float64Array(n.size), new Uint32Array(this.baseDims(p.image || '')),
      JSON.stringify({ kind: 'image', color: p.color, fit: p.fit, transform: p.transform, tile: p.tile }),
      this.sampleIndex ?? 4, level, new Int32Array([0, 0]))
    } catch (error) {
      // The kernel rejects a whole-support proof over its sampling-field
      // guards instead of shrinking it. The regional path below stays exact
      // for any extent, so an oversize proof falls through to it rather than
      // failing the whole render request (observed at 3200% zoom).
      if (isSamplingFieldOverGuardError(error)) {
        this.imageFieldDiagnostic(n, callsite, 2, 4, 2, level)
        return false
      }
      throw this.failureOrigin(error, 6, 2, this.imageFieldSnapshot(n, callsite, 2, 2, 0, level))
    }
    if (!values.length) { this.imageFieldDiagnostic(n, callsite, 2, 3, 2, level); return false }
    this.imageGrid(n, p, image, level, [0, 0], values, callsite)
    return true
  }
  private async paintImageFieldRegions(n: GpuNode, p: GpuPaint, mask: Surface, image: Surface, level: number): Promise<Surface> {
    const source = n.previewSource || n, alreadyPinned = this.sequentialImagePins.has(image.texture)
    if (!alreadyPinned) this.sequentialImagePins.add(image.texture)
    let out: Surface | undefined, regions = 0, fieldBytes = 0, maxFieldBytes = 0, maxWidth = 0, maxHeight = 0, succeeded = false
    try {
      const outputBytes = n.rect.w * n.rect.h * 16
      if (!this.free.get(`${n.rect.w}:${n.rect.h}`)?.length && this.workingBytes + outputBytes > this.frameBudget)
        await this.reclaimScratch(outputBytes)
      this.checkFrameCurrent(); this.requireImageResidencyCurrent()
      out = this.acquire(n.rect, false, false, SurfaceAllocationSite.boundedImageOutput)
      const visible = this.drawRegion(n.rect)
      if (visible) this.driver.clear(out.texture)
      const columns = Math.min(n.rect.w, 4096), rows = Math.max(1, Math.min(256, Math.floor(8 * 1024 * 1024 / (columns * 16))))
      for (let y = 0; y < n.rect.h; y += rows) for (let x = 0; x < n.rect.w; x += columns) {
        const w = Math.min(columns, n.rect.w - x), h = Math.min(rows, n.rect.h - y)
        const local = rect(x, y, w, h), draw = visible ? intersect(local, visible) : local
        if (!draw.w || !draw.h) continue
        const bytes = w * h * 16
        if (this.workingBytes + bytes > this.frameBudget) await this.reclaimScratch(bytes)
        this.checkFrameCurrent(); this.requireImageResidencyCurrent()
        const region = rect(n.rect.x + x, n.rect.y + y, w, h)
        const regionPaint = { ...p }, regionNode = { ...n, rect: region,
          previewSource: { ...source, rect: rect(source.rect.x + x, source.rect.y + y, w, h) } }
        let field: Surface | undefined
        try {
          // This regional paint has one consumer and its private grid key is
          // discarded below. Keep its upload out of the current-frame cache
          // pins so retireUpload can reclaim it only after a real checkpoint.
          // Whole-image compact fields and shared filter support remain cached.
          field = this.imageGrid(regionNode, regionPaint, image, level, [0, 0], undefined, 2, false)
          regions++; fieldBytes += field.texture.bytes; maxFieldBytes = Math.max(maxFieldBytes, field.texture.bytes)
          maxWidth = Math.max(maxWidth, w); maxHeight = Math.max(maxHeight, h)
          const u = parameters(n.rect, mask.rect, image.rect, mask.rect)
          u[16] = 2; this.configurePaint(u, n, p); u.set([field.rect.x, field.rect.y], 204)
          this.driver.pass(out.texture, u, [mask.texture, image.texture, mask.texture, field.texture], draw)
          this.passPixels += draw.w * draw.h
        } finally {
          this.imageGrids.delete(regionPaint)
          if (field) this.retireUpload(field.texture)
        }
      }
      if (this.imageZeroOverSource(n, p, mask, image)) out.imageZeroOverIdentity = true
      const painted = out; out = undefined; succeeded = true; return painted
    } finally {
      this.release(out)
      if (!alreadyPinned) this.sequentialImagePins.delete(image.texture)
      if (gpuDiagnosticsEnabled()) try { recordGpuDiagnostic('filter', {
        imageFieldRegionPath: 1, imageFieldRegionOutcome: succeeded ? 1 : 2,
        imageFieldRegionCount: regions, imageFieldRegionBytes: fieldBytes,
        imageFieldRegionMaxBytes: maxFieldBytes, imageFieldRegionMaxWidth: maxWidth, imageFieldRegionMaxHeight: maxHeight,
        imageFieldRegionSample: this.sampleIndex ?? 4,
      }) } catch { /* telemetry cannot change rendering */ }
    }
  }
  private paint(n: GpuNode, p: GpuPaint, mask: Surface, material?: Surface): Surface
  private paint(n: GpuNode, p: GpuPaint, mask: Surface, material: Surface | undefined, admit: true, gradientField?:Surface): Surface | Promise<Surface>
  private paint(n: GpuNode, p: GpuPaint, mask: Surface, material?: Surface, admit = false, gradientField?:Surface): Surface | Promise<Surface> {
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
        ? [mask, image, mask, this.imageGrid(n, p, image, imageLevel, imageOrigin, undefined, 3)]
        : [mask, image]
      : this.driver.managed &&
          ['linear', 'radial', 'angular', 'diamond'].includes(p.kind)
        ? [mask, mask, mask, gradientField||this.gradientGrid(n, p)]
        : [mask]
    if (p.stops.length > 32 && ['linear', 'radial', 'angular', 'diamond'].includes(p.kind)) {
      inputs[1] = this.gradientStopTable(p)
    }
    const render = () => {
      const out = this.run(2, n.rect, inputs, (u) => {
        this.configurePaint(u, n, p)
        if (p.kind === 'image' && inputs[3])
          u.set([inputs[3].rect.x, inputs[3].rect.y], 204)
        if(gradientField)u.set([1,gradientField.rect.x-n.rect.x,gradientField.rect.y-n.rect.y,0],188)
        if(inputs[3])this.configureGradientPhase(u,inputs[3])
      })
      if (!material && image && this.imageZeroOverSource(n, p, mask, image))
        // Native managed coordinates clamp valid addresses to texel centres;
        // invalid addresses produce +0. Private range/binary coverage proofs
        // keep this source-over identity exact, including after admission.
        out.imageZeroOverIdentity = true
      return out
    }
    if (admit) {
      // Capture the actual prepared inputs. Re-entering paint after a fence
      // could rebuild an uncached coordinate field or replace its source.
      const pending = this.admitSurface(n.rect, 1, false, false, inputs, render)
      if (pending) return pending
    }
    return render()
  }
  private imageZeroOverSource(n: GpuNode, p: GpuPaint, mask: Surface, image: Surface) {
    const range = this.driver.imageTableRange?.(image.texture)
    return this.painterStagesEnabled() && this.driver.managed && !this.driver.displayMath &&
      this.sampleIndex !== undefined && p.kind === 'image' && p.opacity === 1 && !!mask.texture.binaryCoverage &&
      !!range?.opaqueAlpha && range.nonnegativeRgb && range.maximum.every(value => value <= 127) &&
      image.rect.x === 0 && image.rect.y === 0 && image.rect.w === image.texture.width && image.rect.h === image.texture.height &&
      exactBlendLattice([n.rect, mask.rect, image.rect])
  }
  /** Large stop lists use a bounded exact parameter texture. Source B is unused
   * by gradient paint; small lists retain their original uniform encoding. */
  private gradientStopTable(p: GpuPaint): Surface {
    if (!this.driver.uploadParameters || p.stops.length > MAX_GRADIENT_STOPS) throw Error('无效的渐变色标表')
    const stops = [...p.stops].sort((a, b) => a.offset - b.offset)
    const values = new Float32Array(stops.length * 8)
    stops.forEach((s, i) => {
      values.set([s.offset, ...this.color(s.color)], i * 4)
      values[stops.length * 4 + i * 4] = this.alpha(s.color)
    })
    // Include resolved color bits: the same authored token can change profile.
    return this.materialField(['gradient-stops', Array.from(values)], rect(0, 0, stops.length, 2),
      () => values, this.driver.uploadParameters, undefined, values.byteLength)
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
    if (stops.length > MAX_GRADIENT_STOPS) throw new Error('渐变色标超过 64 个')
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
    if (stops.length <= 32) stops.forEach((s, i) => {
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
      n.blend !== 'normal' || n.fills.some(p => p.stops.length > 32) || n.strokes.some(s => s.paint.stops.length > 32)
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
  private async drawOpaqueGroup(ids:string[],targets:Surface[],samples:number[]):Promise<Surface[]|undefined>{
    if(ids.length<8)return
    this.fastWork.add('fastSolidAttempts')
    // Retained captures need the complete source for subsequent poses. They
    // can use the same exact opaque union as an ordinary transparent group.
    // A moving suffix keeps the very same integer drawRegion, applied to each
    // instance without rebasing its original path/sample coordinates.
    if(!this.optimized||!this.driver.prepareOpaqueSolids||!this.driver.drawOpaqueSolids||
      targets.some(t=>!t.texture.transparentZero||t.logicalBounds)||
      samples.some(s=>!Number.isInteger(s)||s<0||s>3)){this.fastWork.add('fastSolidTargetReject');return}
    const color=opaqueSolidGroup(this.scene,ids)
    const runs=opaqueSolidRuns(this.scene,ids)||(color?[{start:0,end:ids.length,color}]:undefined)
    if(!runs?.length||runs.some(run=>this.alpha(run.color)!==1)){this.fastWork.add('fastSolidProofReject');return}
    if(runs.reduce((n,run)=>n+run.end-run.start,0)>(this.driver.solidBatchRemaining?.()??Infinity)){this.fastWork.add('fastSolidCapacityReject');return}
    const mixed=runs[0].start!==0||runs.at(-1)!.end!==ids.length||runs.some((run,i)=>i>0&&run.start!==runs[i-1].end)
    // Opaque replacement is only idempotent over finite canonical colours.
    // Rust proves every intervening leaf's bounded normal paint semantics;
    // uploads still certify each batch's actual four binary coverage programs.
    if(mixed&&(!this.mixedSolidRunsEnabled||this.painterStagesEnabled()||
      !boundedPaintGroup(this.scene,ids))){this.fastWork.add('fastSolidProofReject');return}
    const r=targets[0].rect
    if(targets.some(t=>t.rect.x!==r.x||t.rect.y!==r.y||t.rect.w!==r.w||t.rect.h!==r.h))return
    const batches=[]
    for(const run of runs){
      const nodes=ids.slice(run.start,run.end).flatMap(id=>{const n=this.scene.nodes[id];return n?[{path:n.fill,bounds:n.rect}]:[]})
      const batch=this.driver.prepareOpaqueSolids(nodes,r,[...this.color(run.color),1],this.drawRegion(r))
      if(!batch)return
      batches.push(batch)
    }
    const outputs:Surface[]=[]
    try{
      for(const sample of samples){
        await this.reclaimForSurface(r)
        let out=this.acquire(r,false,false,SurfaceAllocationSite.empty);outputs.push(out)
        this.driver.clear(out.texture)
        let cursor=0
        for(let index=0;index<batches.length;index++){
          const run=runs[index],batch=batches[index]
          if(cursor<run.start){
            const oldSample=this.sampleIndex;this.sampleIndex=sample
            try{out=await this.drawList(ids.slice(cursor,run.start),out)}finally{this.sampleIndex=oldSample}
            outputs[outputs.length-1]=out
          }
          // A constant/aliased result of the ordinary span is immutable. Give
          // this batch its own full-size writable destination before replacing.
          if((this.aliases.get(out.texture)||1)>1||out.texture.uniformColor||out.texture.transparentZero){
            await this.reclaimForSurface(r)
            const copy=this.copy(out,r);this.release(out);out=copy;outputs[outputs.length-1]=out
          }
          this.checkFrameCurrent()
          if(!this.driver.drawOpaqueSolids(batch,out.texture,sample))throw Error('Opaque batch ownership changed during rendering')
          this.passPixels+=batch.pixels
          this.fastWork.add('fastSolidBatches');this.fastWork.add('fastSolidNodes',batch.count)
          cursor=run.end
        }
        if(cursor<ids.length){
          const oldSample=this.sampleIndex;this.sampleIndex=sample
          try{out=await this.drawList(ids.slice(cursor),out)}finally{this.sampleIndex=oldSample}
          outputs[outputs.length-1]=out
        }
      }
    }catch(error){this.release(...outputs);throw error}
    this.release(...targets)
    return outputs
  }
  private async drawList(ids: string[], target: Surface, clip?: Surface, skip?: string): Promise<Surface> {
    if(this.opaqueBatchEnabled()&&!clip&&!skip&&this.sampleIndex!==undefined){
      const batched=await this.drawOpaqueGroup(ids,[target],[this.sampleIndex]);if(batched)return batched[0]
    }
    let pendingSurfaceAdmission: Surface | Promise<Surface>
    const children = skip ? ids.filter((id) => id !== skip) : ids
    for (let i = !skip&&this.sampleIndex!==undefined?this.opaqueBegin(children,[target],clip?[clip]:undefined):0; i < children.length; ) {
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
        if (region.w && region.h && n.opacity > 0) ((pendingSurfaceAdmission = this.mask(this.direct(n)!.path, true), pendingSurfaceAdmission instanceof Promise ? await pendingSurfaceAdmission : pendingSurfaceAdmission))
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
    let pendingSurfaceAdmission: Surface | Promise<Surface>
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
      return this.drawList(n.children,target,n.clip?((pendingSurfaceAdmission = this.mask(n.fill, true), pendingSurfaceAdmission instanceof Promise ? await pendingSurfaceAdmission : pendingSurfaceAdmission)):clip)
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
      const mask = ((pendingSurfaceAdmission = this.nodeMask(n, true), pendingSurfaceAdmission instanceof Promise ? await pendingSurfaceAdmission : pendingSurfaceAdmission)), admission = this.reclaimForPaintOver(n, n.fills[0], mask, target, clip)
      if (admission) await admission
      return this.paintOver(n,n.fills[0],mask,target,clip,true)
    }
    if (direct) {
      const p = direct.paint
      let region = intersect(n.rect, target.rect)
      if (clip) region = intersect(region, clip.rect)
      if (!region.w || !region.h || n.opacity <= 0) return target
      const mask = ((pendingSurfaceAdmission = this.mask(direct.path, true), pendingSurfaceAdmission instanceof Promise ? await pendingSurfaceAdmission : pendingSurfaceAdmission)),
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
    if(this.driver.managed&&(this.scene.interactionRetained||this.surfaceNeedsAdmission(target.rect)))
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
    if (source && this.interactionBytes + source.rect.w*source.rect.h*16 <= this.interactionBudget &&
        !this.overBudget(source.rect.w*source.rect.h*16)) {
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
    if (this.materialFields.has(texture)||this.gradientPhaseResources.has(texture)) return
    this.coordinateMaps.delete(texture)
    this.retiredUploads.push(texture)
  }
  private forgetUpload(texture: Texture) {
    this.gradientPhaseResources.delete(texture)
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
  private admitSurface<T>(r: Rect, copies: number, binary: boolean, scalar: boolean,
    inputs: Surface[], operation: () => T): Promise<T> | undefined {
    const key = `${scalar ? 'scalar:' : binary ? 'binary:' : ''}${r.w}:${r.h}`
    const reusable = (this.free.get(key) || []).slice(-copies)
    const required = textureByteLength(r.w, r.h, this.driver.managed && !binary && !scalar ? 16 : 4) *
      Math.max(0, copies - reusable.length)
    // A hit has no wait and no fresh allocation. Do not discard a matching
    // ordered pool slot merely to admit that identical allocation again.
    if (!required || this.workingBytes + required <= this.frameBudget) return
    const retained = inputs.filter((input, index) => this.busy.has(input.texture) && !this.materialFields.has(input.texture) &&
      inputs.findIndex(candidate => candidate.texture === input.texture) === index).map(input => this.retain(input))
    const pinned = new Set([...inputs.map(input => input.texture), ...reusable])
    for (const texture of pinned) this.admissionPins.set(texture, (this.admissionPins.get(texture) || 0) + 1)
    return (async () => {
      try {
        await this.reclaimScratch(required)
        this.checkFrameCurrent()
        // Exactly one admission attempt. The original allocation gate still
        // rejects a genuinely too-large live set, with no replay or downgrade.
        return operation()
      } finally {
        this.release(...retained)
        for (const texture of pinned) {
          const count = (this.admissionPins.get(texture) || 1) - 1
          if (count) this.admissionPins.set(texture, count); else this.admissionPins.delete(texture)
        }
      }
    })()
  }
  private surfaceNeedsAdmission(r:Rect,copies=1){
    const available=this.free.get(`${r.w}:${r.h}`)?.length||0
    const missing=Math.max(0,copies-available)
    return missing>0&&this.workingBytes+r.w*r.h*(this.driver.managed?16:4)*missing>this.frameBudget
  }
  private async reclaimForSurface(r:Rect,copies=1) {
    this.checkFrameCurrent()
    // A free surface is already reusable in queue order. Do not wait for the
    // GPU and destroy it merely to "make room" for the same dimensions.
    const reusable=(this.free.get(`${r.w}:${r.h}`)||[]).slice(-copies)
    const missing=Math.max(0,copies-reusable.length)
    if(!missing)return
    // The allocation estimate already counts these slots. Reclaiming one of
    // them would invalidate that estimate and make the following pair fail.
    for(const texture of reusable)this.admissionPins.set(texture,(this.admissionPins.get(texture)||0)+1)
    try {
      await this.reclaimScratch(r.w*r.h*(this.driver.managed?16:4)*missing)
      this.checkFrameCurrent()
    } finally {
      for(const texture of reusable){const count=(this.admissionPins.get(texture)||1)-1
        if(count)this.admissionPins.set(texture,count);else this.admissionPins.delete(texture)}
    }
  }
  /** Forced image retirement still excludes an exact-table source. Atlas
   * slots share that ownership with their entire page, including empty pages. */
  private hasEvictableImage() {
    const eligible = (texture: Texture) => !this.pendingImageTableSources.has(texture) &&
      !this.sequentialImagePins.has(texture) && !this.admissionPins.has(texture) &&
      !this.driver.hasActiveImageTableSource?.(texture) && !this.staticImageBlurs.pinsSource(texture)
    for (const surface of this.images.values()) if (eligible(surface.texture)) return true
    for (const page of this.atlasPages) if (eligible(page.texture)) return true
    return false
  }
  private async reclaimScratch(required = 0) {
    this.checkFrameCurrent()
    // Background GPU completion only certifies storage. Reclaim under one
    // synchronous scratch delta before pressure tests or warm-path early exits.
    const completedScratch = this.driver.scratchBytes || 0
    try { this.driver.collectCompletedImageTables?.() }
    finally { this.bytes += (this.driver.scratchBytes || 0) - completedScratch }
    this.staticImageBlurs.collect(this.driver.completedResourceEpoch)
    this.collectRetiredImageAssets()
    const preserveImmutableImages = this.residentImageRequest || this.frameImageReuse || import.meta.env.VITE_DESIGN_EXACT_CLAMP_PREFIX === '1' ||
      import.meta.env.VITE_DESIGN_IMAGE_ASSET_RESIDENCY === '1'
    const pressure = (required > 0 || preserveImmutableImages) && this.workingBytes + required > this.frameBudget
    // A warm graph can reuse all uploads yet still need a new intermediate
    // size inside a synchronous pass. Bound the idle surface pool before it
    // fills the hard limit; this retires only a completed oldest-first batch,
    // never current images, material fields, busy targets or pinned borrows.
    const poolTrim=required===0&&preserveImmutableImages&&this.driver.captureDisplay===true&&
      this.workingBytes>this.frameBudget*.875&&
      ((this.free as SurfacePool<Texture>).summary?.(this.admissionPins)?.bytes??0)>=RECLAIM_BATCH_BYTES
    if (pressure) {
      this.retireDisplayMaterial()
      if (this.nestedPrefix) this.nestedPrefixPressure = true
      this.retireNestedPrefix()
      if(this.coherentSubtrees?.size)this.coherentSubtreePressure=true
      this.retireCoherentSubtrees()
      this.horizontalFilters.clear(); this.staticImageBlurs.discardPending(this.driver.resourceEpoch)
    }
    // The shared worker replaces two former 256 MiB raster owners. Keep the
    // active interaction working set warm below its bounded pressure line.
    if (!pressure && !poolTrim && this.driver.captureDisplay && this.scene.interactionRetained &&
      (this.interactionWarm || this.workingBytes < this.frameBudget * .875)) return
    const retiredImageTableBytes = this.driver.retiredImageTableBytes || 0
    const imageTablePressure = pressure && retiredImageTableBytes > 0
    const retiredImageAssetBytes = [...this.retiredImageAssets.keys()].reduce((sum, texture) => sum + texture.bytes, 0)
    const imageAssetPressure = pressure && retiredImageAssetBytes > 0
    if ((!imageTablePressure && !imageAssetPressure && this.bytes < this.frameBudget * .25) || !this.driver.checkpoint) return
    for (const [key, surface] of this.constantTargets) if ((this.aliases.get(surface.texture) || 1) === 1) {
      this.constantTargets.delete(key)
      this.release(surface)
    }
    const imagesUnderPressure = (preserveImmutableImages ? pressure : this.workingBytes > this.frameBudget * .75) && this.hasEvictableImage()
    if(this.fieldRetirementIndexEnabled&&!pressure&&!imagesUnderPressure){
      const coordinates=this.coordinateMaps.summary?.(this.admissionPins,this.filterImageFields?.pinned)
      const pool=(this.free as SurfacePool<Texture>).summary?.(this.admissionPins)
      if(coordinates&&pool){
        const reclaimable=pool.bytes+coordinates.bytes+this.retiredUploads.reduce((sum,t)=>sum+t.bytes,retiredImageTableBytes+retiredImageAssetBytes)
        // Exactly the existing below-batch early return, before allocating or
        // scanning the complete transient/pool lists. No completion credit,
        // resource retirement or budget change is implied by this summary.
        if(Number.isSafeInteger(reclaimable)&&reclaimable<RECLAIM_BATCH_BYTES){
          this.fieldRetirementIndexSkips=Math.min(1e15,this.fieldRetirementIndexSkips+1)
          this.fieldRetirementAvoidedVisits=Math.min(1e15,this.fieldRetirementAvoidedVisits+coordinates.count)
          return
        }
      }
    }
    const coordinates = [...this.coordinateMaps].filter(texture => !this.filterImageFields?.pinned.has(texture) && !this.admissionPins.has(texture))
    // Dead uploads leave first, then the oldest pool generations and the
    // oldest cached coordinates. One bounded batch per checkpoint cycle keeps
    // each GPU wait short and lets younger reusable entries survive.
    const staticCachePressure = pressure && this.staticImageBlurs.bytes > 0
    // A free surface can be reused in this command queue before completion.
    // Keep pooled storage when the requested allocation still fits, instead of
    // fencing to destroy surfaces the next node may reuse. Logically retired
    // tables stay charged and pinned until periodic finish or real pressure.
    // Allocation/image pressure and upload/coordinate retirement retain their
    // real completion fences; this return grants no completion proof.
    if (this.workingBytes <= this.frameBudget && !pressure && !poolTrim && !imagesUnderPressure &&
        !this.retiredUploads.length && !coordinates.length && !retiredImageAssetBytes) return
    // Most node completions need no maintenance. Enumerate reusable pool
    // storage only when a retirement/admission decision actually consumes it.
    // The pool remains fully charged and queue-ordered on the early return.
    const indexedPool=(this.free as SurfacePool<Texture>).capture?.(this.admissionPins, pressure ? undefined : {bytes:RECLAIM_BATCH_BYTES,resources:RECLAIM_BATCH_RESOURCES})
    const pooled: Texture[] = indexedPool?.textures || []
    if(!indexedPool)for (const list of this.free.values()) for (const texture of list)
      if (!this.admissionPins.has(texture)) pooled.push(texture)
    const pooledBytes=indexedPool?.bytes??pooled.reduce((sum,texture)=>sum+texture.bytes,0)
    if (!this.retiredUploads.length && !pooled.length && !coordinates.length && !imagesUnderPressure && !staticCachePressure && !imageTablePressure && !retiredImageAssetBytes)
      return
    // A large managed source image or ancestor surface can keep the ledger
    // above 64 MiB throughout a frame. Waiting on the GPU for every tiny dead
    // leaf then destroys reusable targets and serializes hundreds of nodes.
    // Reclaim one meaningful batch, or synchronize immediately at the pressure
    // line; the allocation gate still enforces the selected working-budget ceiling.
    const reclaimableBytes = pooledBytes + [...this.retiredUploads, ...coordinates]
      .reduce((sum, texture) => sum + texture.bytes, retiredImageTableBytes + retiredImageAssetBytes)
    if (!pressure && !imagesUnderPressure && reclaimableBytes < RECLAIM_BATCH_BYTES) return
    // Pool surfaces are already reusable in queue order and stay fully charged.
    // Do not confuse their residency with dead upload/coordinate retirement.
    // No resource is released, destroyed, or marked complete by this decision.
    if (coordinates.length || this.retiredUploads.length) {
      const poolSet = indexedPool || new Set(pooled)
      const transientSet = new Set([...coordinates, ...this.retiredUploads])
      const poolBytes = indexedPool?.bytes ?? [...poolSet as Set<Texture>].reduce((sum, t) => sum + t.bytes, 0)
      const transientBytes = [...transientSet].reduce((sum, t) => sum + t.bytes, 0)
      const overlaps = [...transientSet].some(t => poolSet.has(t)) ||
        this.retiredUploads.some(t => this.coordinateMaps.has(t))
      // Conflicting ownership must not fall through to either retirement path:
      // forgetUpload cannot detach coordinate aliases or free-list references.
      if (overlaps) throw new Error('GPU maintenance resource ownership overlaps')
      // captureDisplay selects output presentation; it does not prove that
      // this no-release maintenance decision needs synchronization. Deferring
      // preserves every charge/handle and grants no resource completion.
      const epochKnown = Number.isSafeInteger(this.driver.resourceEpoch) && this.driver.resourceEpoch! >= 0 &&
        Number.isSafeInteger(this.driver.completedResourceEpoch) && this.driver.completedResourceEpoch! >= 0 &&
        this.driver.completedResourceEpoch! <= this.driver.resourceEpoch!
      const mandatoryReasonBits = Number(required !== 0) | Number(pressure) << 1 |
        Number(imagesUnderPressure) << 2 | Number(!!retiredImageTableBytes) << 3 |
        Number(!!retiredImageAssetBytes) << 4 | Number(!epochKnown) << 5
      const reason = this.maintenanceResidency.decide(required,
        pressure || imagesUnderPressure ||
          !!retiredImageTableBytes || !!retiredImageAssetBytes,
        this.workingBytes, this.frameBudget, poolBytes, transientBytes,
        this.driver.resourceEpoch, this.driver.completedResourceEpoch)
      if (gpuDiagnosticsEnabled()) {
        try { recordGpuDiagnostic('cache', { maintenanceDecision: reason,
          maintenanceDeferredCount: this.maintenanceResidency.count, mandatoryReasonBits,
          maintenancePoolBytes: poolBytes, maintenanceTransientBytes: transientBytes,
          maintenanceWorkingBytes: this.workingBytes, maintenanceBudgetBytes: this.frameBudget,
          maintenanceRequiredBytes: required, resourceEpoch: this.driver.resourceEpoch,
          completedResourceEpoch: this.driver.completedResourceEpoch }) } catch { /* diagnostics only */ }
      }
      if (reason === 0) return
    }
    const batchLimit = pressure ? Math.max(RECLAIM_BATCH_BYTES, this.workingBytes + required - this.frameBudget) : RECLAIM_BATCH_BYTES
    const resourceLimit = pressure ? 4096 : RECLAIM_BATCH_RESOURCES
    // Preserve the exact oldest-first batch. Only a pool-only maintenance
    // batch below image pressure can use prior-frame completion evidence.
    if(!indexedPool)pooled.sort((a, b) => (this.lastUsed.get(a) || 0) - (this.lastUsed.get(b) || 0))
    let completedPoolEpoch: number | undefined
    if (required === 0 && !retiredImageAssetBytes && !this.retiredUploads.length && !coordinates.length &&
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
      admissionPoolBytes: pooledBytes,
      admissionPoolCount: indexedPool?.count ?? pooled.length,
      admissionUploadCount: this.retiredUploads.length + coordinates.length,
      admissionRetiredKinds: (pooled.length ? 1 : 0) | (this.retiredUploads.length ? 2 : 0) | (coordinates.length ? 4 : 0) | (imagesUnderPressure ? 8 : 0) | (retiredImageTableBytes ? 16 : 0),
      admissionRetiredUploadCount: this.retiredUploads.length,
      admissionCoordinateCount: coordinates.length,
      admissionImageCount: this.images.size,
    } : undefined
    // Submission is still mandatory. Only the completion wait may be omitted,
    // and the driver independently validates the already-completed epoch.
    const checkpointScratch = this.driver.scratchBytes || 0
    const transientCohort = [...new Set([...this.retiredUploads, ...coordinates])]
    const retiringImageAssets = this.retiredImageAssetCohort()
    try {
      if (completedPoolEpoch === undefined) await this.driver.checkpoint('admission', diagnostic)
      else await this.driver.checkpoint('admission', diagnostic, completedPoolEpoch)
    } finally {
      // A real checkpoint can now collect logically retired image tables.
      // Preserve actual scratch accounting even when a later step rejects.
      this.bytes += (this.driver.scratchBytes || 0) - checkpointScratch
    }
    this.maintenanceResidency.completed()
    this.checkpointMs += performance.now() - checkpointStart
    this.staticImageBlurs.collect(this.driver.completedResourceEpoch)
    this.coverRetiredImageAssets(retiringImageAssets)
    // This no-pressure checkpoint already proves completion for the whole
    // selected transient cohort. Spend the bounded disposal work on that
    // cohort, rather than destroying reusable pool storage first and leaving
    // coordinate uploads to force the next identical maintenance wait.
    if (required === 0 && !pressure && !imagesUnderPressure &&
        !retiredImageTableBytes && !retiredImageAssetBytes &&
        this.workingBytes <= this.frameBudget * .75 &&
        (coordinates.length || this.retiredUploads.length)) {
      let count = 0, bytes = 0
      // Snapshot ownership before awaiting above: later insertions are not
      // allowed to borrow this completion boundary.
      for (const texture of transientCohort) {
        if (count >= RECLAIM_BATCH_RESOURCES) break
        if (this.admissionPins.has(texture)) continue
        const retiredIndex = this.retiredUploads.indexOf(texture)
        if (retiredIndex >= 0) {
          this.retiredUploads.splice(retiredIndex, 1)
          this.forgetUpload(texture)
        } else if (this.coordinateMaps.has(texture) && !this.filterImageFields?.pinned.has(texture)) {
          this.forgetCoordinateTexture(texture)
        } else continue
        count++; bytes += texture.bytes
      }
      if (gpuDiagnosticsEnabled()) {
        try { recordGpuDiagnostic('cache', { maintenanceDecision: 6,
          maintenanceRetiredBytes: bytes, maintenanceRetiredCount: count,
          maintenanceWorkingBytes: this.workingBytes, maintenanceBudgetBytes: this.frameBudget,
          resourceEpoch: this.driver.resourceEpoch, completedResourceEpoch: this.driver.completedResourceEpoch }) } catch { /* diagnostics only */ }
      }
      return
    }
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
      const index = this.retiredUploads.findIndex(texture => !this.admissionPins.has(texture))
      if (index < 0) break
      const [texture] = this.retiredUploads.splice(index, 1)
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
    // The just-completed boundary covers the whole preselected pool, including
    // current-epoch releases. If a bounded upload batch used the disposal
    // allowance first, prefer this already-proven storage to decoding/uploading
    // immutable images again. No later pool insertion borrows this boundary.
    if (preserveImmutableImages && pressure)
      for (const texture of pooled) {
        if (this.workingBytes + required <= this.frameBudget) break
        this.destroyFree(texture)
      }
    // Legacy maintenance policy remains the control. The candidate keeps
    // immutable assets whenever the actual allocation already fits; real
    // pressure can still evict them after covered pools and optional caches.
    if (!preserveImmutableImages && this.workingBytes > this.frameBudget * .75)
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
  /** A transparent normal isolation around one finite image paint is an
   * identity. Missing/zero-opacity compiled children draw no pixels, but a
   * mask child still changes the isolation contract and cannot be elided. */
  private bandImageNode(n: GpuNode, bounds: Rect): GpuNode | undefined {
    const ordinary = (node: GpuNode) => node.opacity === 1 && node.blend === 'normal' && !node.passthrough &&
      !node.clip && !node.mask && !node.maskId && !node.effects.length && !node.strokes.length
    if (!ordinary(n)) return
    let image = n
    if (n.children.length) {
      if (n.fills.some(paint => paint.visible) || n.children.some(id => {
        const child = this.scene.nodes[id]
        return child && (child.mask || !Number.isFinite(child.opacity))
      })) return
      const children = n.children.map(id => this.scene.nodes[id]).filter(node => node && node.opacity > 0)
      const input = this.painterBox(n.childrenInputBox)
      if (children.length !== 1 || !input || !containsRect(input, bounds) || !containsRect(bounds, input)) return
      image = children[0]
      if (!ordinary(image)) return
      const suffix = this.painterBox(image.postCompositeBox)
      if (!suffix || !containsRect(suffix, bounds) || !containsRect(bounds, suffix)) return
    }
    const paint = image.fills[0]
    if (image.children.length || image.fills.length !== 1 || !paint?.visible || paint.kind !== 'image' ||
        paint.blend !== 'normal' || paint.opacity !== 1 || !paint.image ||
        !containsRect(image.rect, bounds) || !containsRect(bounds, image.rect) ||
        image.fill.sampleCount !== 4 || !containsRect(image.fill.opaqueRect, image.rect) ||
        !containsRect(image.fill.rect, image.rect) || !exactBlendLattice([bounds, image.rect, image.fill.rect, image.fill.opaqueRect!])) return
    return image
  }
  /** Only a real, uniquely owned full color target can be overwritten after
   * saving the current band. A missing alias counter is not ownership proof. */
  private privateBandDestination(surface: Surface) {
    const texture = surface.texture
    return this.aliases.get(texture) === 1 && this.busy.has(texture) && !this.releasedAliases.has(surface) &&
      !surface.logicalBounds && !texture.uniformColor && !texture.transparentZero &&
      !texture.binaryCoverage && !texture.scalarCoverage && texture.width === surface.rect.w && texture.height === surface.rect.h &&
      !this.coverage.has(texture) && !this.materialFields.has(texture) && !this.interactionTextures.has(texture) &&
      !this.horizontalFilters.has(texture) && !this.staticImageBlurs.has(texture) &&
      this.displayMaterial?.surface.texture !== texture &&
      ![...this.constantTargets.values(), ...this.images.values()].some(owned => owned.texture === texture) &&
      !this.nestedPrefix?.planes.some(owned => owned.texture === texture)
  }
  /** Preserve the original mode2 stored-paint and mode3 source-over rounding
   * boundaries while bounding their simultaneous storage to 64-row bands.
   * Integer-centre sampling also reads its positive, zero-weight neighbours:
   * paint is proved finite, and destination neighbours are copied verbatim.
   * The last alias of the old destination can then be updated without a fifth
   * full plane. This is intentionally limited to one exact, full-domain image.
   */
  private async streamImageLeaf(n: GpuNode, targets: Surface[], clip?: Surface[]): Promise<Surface[] | undefined> {
    let pendingSurfaceAdmission: Surface | Promise<Surface>
    if (!this.painterStagesEnabled() || !this.optimized || !this.driver.managed || this.driver.displayMath || this.allowSolidBatch ||
        this.driver.name !== 'webgpu' || !this.driver.copyColorRegion || !this.driver.constantTextureSampling ||
        !this.driver.zeroTextureSampling || this.imageAtlas || this.imageMips ||
        this.scene.displayMaterialSource || this.scene.displayFilters || clip || targets.length !== 4 || targets.some(target => target.logicalBounds)) return
    const bounds = targets[0].rect
    if (!exactBlendLattice([bounds]) || targets.some(target => !containsRect(bounds, target.rect) || !containsRect(target.rect, bounds))) return
    const node = this.bandImageNode(n, bounds)
    if (!node || (node.previewSource && (node.previewSource.rect.w !== node.rect.w || node.previewSource.rect.h !== node.rect.h))) return
    const paint = node.fills[0], previousSample = this.sampleIndex, previousNode = this.activeNode
    let pinned: Texture | undefined
    let fieldRegions = 0, fieldBytes = 0, maxFieldBytes = 0, maxFieldWidth = 0, maxFieldHeight = 0, fieldStarted = false, fieldSucceeded = false
    try {
      this.activeNode = node.id; this.sampleIndex = 0
      const mask = ((pendingSurfaceAdmission = this.nodeMask(node, true), pendingSurfaceAdmission instanceof Promise ? await pendingSurfaceAdmission : pendingSurfaceAdmission)), level = this.imageLevel(node, paint), image = this.imageFor(paint.image!, level, false, paint.adjust)
      if (!this.imageZeroOverSource(node, paint, mask, image)) return
      // A completed admission may evict ordinary image assets; this source is
      // still needed by later bands and all four original sampling phases.
      const alreadyPinned = this.sequentialImagePins.has(image.texture)
      if (!alreadyPinned) { this.sequentialImagePins.add(image.texture); pinned = image.texture }
      fieldStarted = true
      for (let sample = 0; sample < 4; sample++) {
        this.sampleIndex = sample
        const regionalFields = node.rect.w * node.rect.h * 16 > 64 * 1024 * 1024 &&
          !this.prepareLargeImageAxes(node, paint, image, level)
        const dst = targets[sample]
        const inplace = this.privateBandDestination(dst)
        let out: Surface | undefined
        try {
          if (inplace) out = dst
          else {
            await this.reclaimForSurface(bounds); this.checkFrameCurrent()
            out = this.acquire(bounds, false, false, SurfaceAllocationSite.streamImageOutput)
          }
          for (let row = 0; row < bounds.h; row += 64) {
            const height = Math.min(64, bounds.h - row)
            const band = rect(bounds.x, bounds.y + row, bounds.w, Math.min(height + 1, bounds.h - row))
            // The two exact passes coexist only with this bounded save/source.
            // Reacquire the original field after each possible checkpoint: an
            // uncached coordinate upload may have retired at that boundary.
            const missing = (this.free.get(`${band.w}:${band.h}`)?.length || 0)
            await this.reclaimScratch(Math.max(0, (inplace ? 2 : 1) - missing) * band.w * band.h * 16)
            this.checkFrameCurrent()
            let before: Surface | undefined, source: Surface | undefined, field: Surface | undefined
            const regionPaint = regionalFields ? { ...paint } : paint, original = node.previewSource || node
            const regionNode = regionalFields ? { ...node, rect: band, previewSource: { ...original,
              rect: rect(original.rect.x + band.x - node.rect.x, original.rect.y + band.y - node.rect.y, band.w, band.h) } } : node
            try {
              if (inplace) {
                before = this.acquire(band, false, false, SurfaceAllocationSite.streamImageBefore)
                this.driver.copyColorRegion(before.texture, dst.texture, { x: 0, y: row, w: band.w, h: band.h }, [0, 0])
                this.painterStageCopies++; this.painterStageCopyBytes += band.w * band.h * 16
              }
              field = this.imageGrid(regionNode, regionPaint, image, level, [0, 0], undefined, 4)
              fieldRegions++; fieldBytes += field.texture.bytes; maxFieldBytes = Math.max(maxFieldBytes, field.texture.bytes)
              maxFieldWidth = Math.max(maxFieldWidth, band.w); maxFieldHeight = Math.max(maxFieldHeight, band.h)
              source = this.acquire(band, false, false, SurfaceAllocationSite.streamImageSource)
              const paintParameters = parameters(band, mask.rect, image.rect, mask.rect)
              paintParameters[16] = 2
              this.configurePaint(paintParameters, node, paint)
              paintParameters.set([field.rect.x, field.rect.y], 204)
              this.driver.pass(source.texture, paintParameters, [mask.texture, image.texture, mask.texture, field.texture])
              this.passPixels += band.w * band.h
              const old = before || dst, u = parameters(bounds, source.rect, old.rect)
              u.set([3, 0, 1, 0], 16)
              this.driver.pass(out.texture, u, [source.texture, old.texture], rect(0, row, bounds.w, height))
              this.passPixels += bounds.w * height
            } finally {
              this.release(source, before)
              if (regionalFields) {
                this.imageGrids.delete(regionPaint)
                if (field) this.retireUpload(field.texture)
              }
            }
          }
          targets[sample] = out
          if (!inplace) this.release(dst)
          out = undefined
        } finally { if (out && out !== dst) this.release(out) }
      }
      this.retireLeafMasks(node, undefined, undefined, targets, true)
      fieldSucceeded = true
      return targets
    } finally {
      if (pinned) this.sequentialImagePins.delete(pinned)
      this.sampleIndex = previousSample; this.activeNode = previousNode
      if (fieldStarted && gpuDiagnosticsEnabled()) try { recordGpuDiagnostic('filter', {
        imageFieldRegionPath: 2, imageFieldRegionOutcome: fieldSucceeded ? 1 : 2,
        imageFieldRegionCount: fieldRegions, imageFieldRegionBytes: fieldBytes, imageFieldRegionMaxBytes: maxFieldBytes,
        imageFieldRegionMaxWidth: maxFieldWidth, imageFieldRegionMaxHeight: maxFieldHeight,
      }) } catch { /* telemetry cannot change rendering */ }
    }
  }
  private async drawBundle(
    ids: string[],
    targets: Surface[],
    clip?: Surface[],
    prefix?: { plan: NestedPrefixPlan; policy: string },
    compactSource = false,
  ): Promise<Surface[]> {
    if(this.opaqueBatchEnabled()&&!clip&&!prefix&&!compactSource&&targets.length===4){
      const batched=await this.drawOpaqueGroup(ids,targets,[0,1,2,3]);if(batched)return batched
    }
    let pendingSurfaceAdmission: Surface | Promise<Surface>
    const previousNode = this.activeNode
    const previousCapturing = this.interactionCapturing
    try {
    let begin = !prefix&&!compactSource?this.opaqueBegin(ids,targets,clip):0
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
      // Only this finite-solid leaf lane understands compact writable bounds.
      // Backdrop capture, cached copies, child isolation and all other paints
      // retain their established full-domain inputs.
      if (targets.some(target => target.logicalBounds) && !this.compactSolidNode(n))
        targets = await this.materializePainterTargets(targets)
      if(n.gaussianRegion){
        const filtered=await this.streamedGaussian(n)
        try{for(let sample=0;sample<4;sample++){
          await this.reclaimForSurface(targets[sample].rect);this.sampleIndex=sample
          const next=this.compose(filtered,targets[sample],n.blend,n.opacity,clip?.[sample])
          this.release(targets[sample]);targets[sample]=next
        }}finally{this.release(filtered)}
        this.orderedEffectLayers++;continue
      }
      // Independent isolated source computation does not read the old parent.
      // A backdrop must first capture the original wide prefix below.
      if (!backdropEffect(n.effects)) targets = await this.cropPainterTargets(targets, n.postCompositeBox)
      if(import.meta.env.VITE_DESIGN_COHERENT_SUBTREES==='1'&&this.scene.nativeInteraction&&this.scene.interactionRetained&&!this.interactionCapturing){
        const retainedSubtree=await this.drawCoherentSubtree(n,targets,clip)
        if(retainedSubtree){targets=retainedSubtree;continue}
      }
      const imageBands = await this.streamImageLeaf(n, targets, clip)
      if (imageBands) { targets = imageBands; continue }
      if (import.meta.env.VITE_DESIGN_BYTE_TENT_PREFIX === '1' && !this.driver.managed && n.shadowOutputBox) {
        const byteShadow = await this.streamByteShadow(n, targets, clip)
        if (byteShadow) { targets = byteShadow; continue }
      }
      const streamed = await this.streamIsolatedFilter(n, targets, clip)
      if (streamed) { targets = streamed; continue }
      if (this.optimized && this.driver.managed && !this.driver.displayMath &&
          n.children.length && !this.painterBox(n.childrenInputBox) && sceneIndex(this.scene).sampleIndependentNodes.has(id)) {
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
      // Instance upload storage is bounded independently of document capacity.
      // Ask the actual driver, including all earlier runs in this frame. A
      // missing/malformed capacity cannot authorize an optimization. Exhaustion
      // retains the established exact ordinary-draw lane and painter order.
      const solidRemaining = this.driver.solidBatchRemaining?.()
      const solidLimit = Number.isSafeInteger(solidRemaining) && solidRemaining! >= 0
        ? Math.min(MAX_SOLID_INSTANCES, solidRemaining!) : 0
      if (this.optimized && this.allowSolidBatch && this.driver.solidBatch && solidLimit >= 8 && batchableSolid(n)) {
        const start = at
        const run: GpuNode[] = [n]
        while (run.length < solidLimit && at + 1 < ids.length && batchableSolid(this.scene.nodes[ids[at + 1]]))
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
            mask = ((pendingSurfaceAdmission = this.nodeMask(n, true), pendingSurfaceAdmission instanceof Promise ? await pendingSurfaceAdmission : pendingSurfaceAdmission)),
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
        const invariantCoverage = this.compactSolidNode(n) && identicalSampleCoverage(n.fill, this.scene.curves)
        const sharedPaints: { dst: Surface; mask: Surface; clip?: Surface; out: Surface }[] = []
        for (let i = 0; i < 4; i++) {
          await this.reclaimScratch()
          // Only the certified binary-solid lane is sample-invariant. Image
          // coordinates, effects and all unproved coverage keep phase i.
          this.sampleIndex = invariantCoverage ? 0 : i
          const mask = ((pendingSurfaceAdmission = this.nodeMask(n, true), pendingSurfaceAdmission instanceof Promise ? await pendingSurfaceAdmission : pendingSurfaceAdmission))
          this.sampleIndex = i
          const dst = targets[i], boundary = clip?.[i]
          const shared = invariantCoverage && this.compactSolidPlan(n, n.fills[0], mask, dst, boundary) &&
            sharedPaints.find(saved => sameSurface(saved.dst, dst) && sameSurface(saved.mask, mask) && sameSurface(saved.clip, boundary))
          if (shared) {
            targets[i] = this.retain(shared.out)
            this.release(dst)
            continue
          }
          // The existing exact fused solid pass also applies the ancestor's
          // clip after paint coverage. Avoid a paint texture and a second pass
          // for each of four samples, preserving every rounding operation.
          const admission = this.reclaimForPaintOver(n, n.fills[0], mask, targets[i], clip?.[i], true)
          if (admission) await admission
          const painted = this.paintOver(n, n.fills[0], mask, targets[i], clip?.[i], true, true)
          targets[i] = painted instanceof Promise ? await painted : painted
          if (invariantCoverage) sharedPaints.push({ dst, mask, clip: boundary, out: targets[i] })
          else this.retireLeafMasks(n, undefined, clip, targets)
        }
        if (invariantCoverage) this.retireLeafMasks(n, undefined, clip, targets)
        continue
      }
      const masks: Surface[] = []
      const firstEffect = n.effects.find(fx => fx.visible)
      const streamBlur = this.optimized && this.driver.managed && !this.driver.displayMath &&
        this.driver.sequentialSampleResolve && !n.passthrough && !n.children.length &&
        !maskId && !leafBackdrop && !n.strokes.length &&
        (firstEffect?.kind === 'blur' || this.sequentialGaussian && firstEffect?.kind === 'gaussian-blur') && firstEffect.radius > 0
      // An isolation-only container consumes its children's colors, never
      // its own path coverage. Do not pin four full-halo masks on every
      // such ancestor while drawing the descendants.
      const needsFillCoverage = !this.optimized || n.clip || !!leafBackdrop || n.fills.some(p => p.visible) ||
        n.strokes.some(stroke => stroke.align !== 'center')
      const packed = !streamBlur && needsFillCoverage ? await this.maskFour(n) : undefined
      if (packed) masks.push(...packed)
      else for (let i = 0; !streamBlur && needsFillCoverage && i < 4; i++) {
        await this.reclaimScratch()
        this.sampleIndex = i
        masks.push(((pendingSurfaceAdmission = this.nodeMask(n, true), pendingSurfaceAdmission instanceof Promise ? await pendingSurfaceAdmission : pendingSurfaceAdmission)))
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
        // All four clipped masks coexist while the children are rendered.
        // Reclaim only after a real completion fence, before allocating any
        // member; a synchronous map cannot recover halfway through the group.
        if (n.clip && clip && this.surfaceNeedsAdmission(n.rect, masks.length))
          await this.reclaimForSurface(n.rect, masks.length)
        const combined =
          n.clip && clip ? masks.map((mask, i) => this.combine(mask, clip[i], n.rect)) : undefined
        targets = await this.drawBundle(n.children, targets, combined || (n.clip ? masks : clip))
        if (combined) this.release(...combined)
        this.retireLeafMasks(n, undefined, clip, targets, true)
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
        first.kind !== 'image' && !this.painterBox(n.childrenInputBox)
      if (inPlace) {
        for (let i = 0; i < 4; i++) {
          await this.reclaimScratch()
          this.sampleIndex = i
          for (const paint of n.fills) {
            if (!paint.visible) continue
            const admission = this.reclaimForPaintOver(n, paint, masks[i], targets[i])
            if (admission) await admission
            const painted = this.paintOver(n, paint, masks[i], targets[i], undefined, true)
            targets[i] = painted instanceof Promise ? await painted : painted
          }
        }
        targets = await this.drawBundle(n.children, targets, n.clip ? masks : undefined)
        this.retireLeafMasks(n, undefined, clip, targets, true)
        continue
      }
      let layers: Surface[] = []
      let resolvedFirstBlur: Surface | undefined
      let sharedEmpty:Surface|undefined
      const childInput = this.painterBox(n.childrenInputBox) || n.rect
      const layer = (i: number) => layers[i] ??= n.passthrough
        ? this.copy(targets[i], childInput)
        : this.optimized&&this.driver.managed&&!this.allowSolidBatch
          ? this.retain(sharedEmpty??=this.empty(childInput)) : this.empty(childInput)
      const coverage: { value?: Surface[]; owned?: boolean } = {}
      const selectedBackdrop = backdropEffect(n.effects)
      const backgrounds = selectedBackdrop ? [selectedBackdrop] : []
      if (backgrounds.length) {
        const replay =
          !this.driver.managed && n.captureReplay && n.glassShape && backgrounds[0].glass
        const cropped = backgrounds.every((e) => e.kind === 'background-blur')
        const box = n.backdropBox
        const capture = cropped && box ? rect(box[0], box[1], box[2], box[3]) : n.rect
        if (!replay) { await this.reclaimForSurface(capture); this.checkFrameCurrent() }
        let background = replay ? undefined : this.run(26, capture, targets)
        this.backdropReads++
        for (const fx of backgrounds) {
          if (!background) break
          const blurred = cropped ? await this.blurBackdropRegion(background, (backdropRadius(fx) * scale(n.matrix)) / 2, n)
            : this.blur(background, (backdropRadius(fx) * scale(n.matrix)) / 2, false)
          if (blurred !== background) this.release(background)
          background = this.colorControls(blurred, fx.colorControls)
          if (background !== blurred) this.release(blurred)
          if (fx.kind === 'glass' && !(n.glassShape && fx.glass)) {
            const geometry = this.run(23, n.rect, masks)
            const refracted = this.glass(background, geometry, n, fx, true)
            this.release(background, geometry)
            background = refracted
          }
        }
        if (cropped && background) {
          const consumption=this.backdropConsumptionRect(n,background)
          if(this.surfaceNeedsAdmission(consumption))await this.reclaimForSurface(consumption)
          const expanded = this.run(27, consumption, [background])
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
          const copies=n.passthrough&&!layers[i]?2:1
          if(this.surfaceNeedsAdmission(childInput,copies))await this.reclaimForSurface(childInput,copies)
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
        if(coverage.owned){
          coverage.value=[]
          for(const mask of masks){
            if(this.surfaceNeedsAdmission(n.rect))await this.reclaimForSurface(n.rect)
            coverage.value.push(this.copy(mask,n.rect))
          }
        }else coverage.value=masks
      }
      for (let i = 0; i < 4; i++) {
        await this.reclaimScratch()
        this.sampleIndex = i
        if (streamBlur && needsFillCoverage) masks[i] = ((pendingSurfaceAdmission = this.nodeMask(n, true), pendingSurfaceAdmission instanceof Promise ? await pendingSurfaceAdmission : pendingSurfaceAdmission))
        if(n.passthrough&&!layers[i]&&this.surfaceNeedsAdmission(childInput))await this.reclaimForSurface(childInput)
        layer(i)
        for (const paint of n.fills) {
          if (!paint.visible) continue
          const admission = this.reclaimForPaintOver(n, paint, masks[i], layers[i])
          if (admission) await admission
          const painted = this.paintOver(n, paint, masks[i], layers[i], undefined, true)
          layers[i] = painted instanceof Promise ? await painted : painted
        }
        if (streamBlur) {
          // Foreground blur first resolves its four independent leaf samples.
          // Preserve meanFourRN's scale-each then left-to-right additions, but
          // consume each plane immediately instead of pinning all four.
          if(this.surfaceNeedsAdmission(n.rect))await this.reclaimForSurface(n.rect)
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
            maskTargets.push(((pendingSurfaceAdmission = this.nodeMask(maskNode, true), pendingSurfaceAdmission instanceof Promise ? await pendingSurfaceAdmission : pendingSurfaceAdmission)))
          }
        } else {
          maskTargets = this.emptyBundle(n.rect)
          maskTargets = await this.drawBundle([maskId], maskTargets)
        }
        if (this.scene.nodes[maskId]?.maskType === 'luminance')
          for(let i=0;i<maskTargets.length;i++){
            const s=maskTargets[i]
            if(this.surfaceNeedsAdmission(s.rect))await this.reclaimForSurface(s.rect)
            const out = this.run(30, s.rect, [s])
            this.release(s)
            maskTargets[i]=out
          }
        let content:Surface[]=[]
        if(n.passthrough){
          for(const layer of layers){
            if(this.surfaceNeedsAdmission(layer.rect))await this.reclaimForSurface(layer.rect)
            content.push(this.copy(layer))
          }
        }else content=this.emptyBundle(n.rect)
        content = await this.drawBundle(
          n.children.filter((id) => id !== maskId),
          content,
          n.clip ? masks : undefined,
        )
        for (let i = 0; i < 4; i++) {
          // Account for the upcoming destination, not merely bytes already
          // allocated. Pool storage pending on this queue needs a real fence
          // before it may be destroyed to fit a differently sized surface.
          await this.reclaimForSurface(layers[i].rect)
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
          ? planNestedPrefix(this.scene, n.id, this.nativeChanging, this.nestedSuffixEnabled && import.meta.env.VITE_DESIGN_PREFIX_SUFFIX==='1') : undefined
        const policy = plan && !n.clip ? this.nestedPrefixPolicy(n.id, layers) : undefined
        if (this.nestedPrefix && (this.nestedPrefix.plan.scopeId === n.id || plan) &&
            (!plan || !policy || !this.nestedPrefixMatches(plan, policy))) this.retireNestedPrefix()
        const needed = plan ? layers.reduce((bytes, p) => bytes + p.rect.w * p.rect.h * 16, 0) : 0
        const admitted = !!(plan && policy && (this.nestedPrefixMatches(plan, policy) ||
          needed <= 64 * 1024 * 1024 && this.interactionBytes + needed <= this.interactionBudget && !this.overBudget(needed)))
        // This isolated, effect-free parent next consumes its children only
        // as source pixels. Keep finite zero-outside compact sources through
        // its normal merge; neither copy/filter nor writable-target contracts
        // receive this opt-in return representation.
        const compactChildrenSource = this.painterStagesEnabled() && !admitted && !n.passthrough && !n.clip &&
          !maskId && n.blend === 'normal' && Number.isFinite(n.opacity) && n.opacity >= 0 && n.opacity <= 1 &&
          !n.fills.some(paint => paint.visible) && !n.effects.length && !n.strokes.length &&
          !!this.painterBox(n.childrenInputBox) && !!this.painterBox(n.postCompositeBox)
        layers = await this.drawBundle(n.children, layers, n.clip ? masks : undefined,
          admitted && plan && policy ? { plan, policy } : undefined, compactChildrenSource)
      }
      for (let i = 0; i < 4; i++) {
        await this.reclaimScratch()
        this.sampleIndex = i
        for (const stroke of n.strokes) {
          let mask = ((pendingSurfaceAdmission = this.mask(stroke.path, true), pendingSurfaceAdmission instanceof Promise ? await pendingSurfaceAdmission : pendingSurfaceAdmission)),
            aligned: Surface | undefined
          if (stroke.align !== 'center') {
            if (this.surfaceNeedsAdmission(n.rect)) await this.reclaimForSurface(n.rect)
            aligned = this.combine(mask, masks[i], n.rect, stroke.align === 'outside')
            mask = aligned
          }
          const admission = this.reclaimForPaintOver(n, stroke.paint, mask, layers[i])
          if (admission) await admission
          const painted = this.paintOver(n, stroke.paint, mask, layers[i], undefined, true)
          layers[i] = painted instanceof Promise ? await painted : painted
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
      targets = await this.cropPainterTargets(targets, n.postCompositeBox)
      const mergedSamples: { src: Surface; dst: Surface; mask?: Surface; out: Surface }[] = []
      const shareMerge = this.optimized && this.driver.managed && !this.allowSolidBatch &&
        !n.passthrough && !coverage.value
      for (let i = 0; i < 4; i++) {
        await this.reclaimScratch()
        this.checkFrameCurrent()
        const src = layers[i], dst = targets[i], mask = clip?.[i]
        const shared = shareMerge && mergedSamples.find(s =>
          sameSurface(s.src, src) && sameSurface(s.dst, dst) && this.equivalentClips(s.mask,mask,dst.rect))
        if (shared) {
          targets[i] = this.retain(shared.out)
          this.release(dst, src)
          continue
        }
        // A just-consumed effect plane may be in this frame's ordered pool.
        // A synchronous allocation cannot destroy it from an older completed
        // epoch; obtain actual headroom before asking for another full target.
        const output = this.suffixRect(dst, n)
        await this.reclaimForSurface(output || dst.rect)
        this.checkFrameCurrent()
        if (n.passthrough) {
          const old = targets[i]
          targets[i] = this.interpolate(layers[i], old, n.opacity, clip?.[i], output || old.rect)
          this.release(old)
        } else if (coverage.value) {
          const old = targets[i],
            mask = clip?.[i],
            knockout = coverage.value[i]
          targets[i] = this.run(25, output || old.rect, [layers[i], old, mask || knockout, knockout], (u) => {
            u.set([25, blends.indexOf(n.blend), n.opacity, mask ? 1 : 0], 16)
            u.set([knockout.rect.x, knockout.rect.y, knockout.rect.w, knockout.rect.h], 188)
          })
          this.release(old)
        } else if (n.blend === 'normal' && n.opacity < 1) {
          const old = targets[i],
            mask = clip?.[i]
          targets[i] = this.run(
            29,
            output || old.rect,
            mask ? [layers[i], old, mask] : [layers[i], old],
            (u) => {
              u.set([29, 0, n.opacity, mask ? 1 : 0], 16)
            },
          )
          this.release(old)
        } else targets[i] = this.merge(layers[i], targets[i], n.blend, n.opacity, clip?.[i], output)
        if (shareMerge) mergedSamples.push({ src, dst, mask, out: targets[i] })
        this.release(layers[i])
      }
      this.release(...layers, ...(coverage.owned ? coverage.value || [] : []))
      // All children, masks and effects of this group have now been encoded.
      // Match the single-plane path's completed-owner retirement; ancestor
      // clips, output aliases and shared mask owners remain protected.
      this.retireLeafMasks(n, undefined, clip, targets, true)
    }
    this.sampleIndex = undefined
    // Only the explicit isolated source consumer above receives compact
    // planes. Final four-sample resolve and copy/filter callers keep their
    // existing full physical-coordinate contracts.
    return !compactSource && targets.some(target => target.logicalBounds) ? await this.materializePainterTargets(targets) : targets
    } finally { this.activeNode = previousNode; this.interactionCapturing = previousCapturing }
  }
  /** The four sample colors are independent after capturing the shared backdrop.
   * Complete one leaf sample at a time so its layer/masks do not coexist with
   * three other finished samples. Within each sample the original operations
   * and rounding boundaries remain unchanged. Foreground effects use drawBundle. */
  private async drawBackdropLeaf(n: GpuNode, targets: Surface[], clip: Surface[] | undefined, fx: Effect) {
    let pendingSurfaceAdmission: Surface | Promise<Surface>
    const cropped = fx.kind === 'background-blur', box = n.backdropBox
    const capture = cropped && box ? rect(box[0], box[1], box[2], box[3]) : n.rect
    // Read all four original target planes exactly once, before replacing any.
    await this.reclaimForSurface(capture)
    this.checkFrameCurrent()
    let background = this.run(26, capture, targets)
    this.backdropReads++
    const blurred = cropped ? await this.blurBackdropRegion(background, (backdropRadius(fx) * scale(n.matrix)) / 2, n)
      : this.blur(background, (backdropRadius(fx) * scale(n.matrix)) / 2, false)
    if (blurred !== background) this.release(background)
    background = this.colorControls(blurred, fx.colorControls)
    if (background !== blurred) this.release(blurred)
    if (cropped) {
      const consumption=this.backdropConsumptionRect(n,background)
      if(this.surfaceNeedsAdmission(consumption))await this.reclaimForSurface(consumption)
      const expanded = this.run(27, consumption, [background])
      this.release(background)
      background = expanded
    }
    // All wide target reads were encoded by capture before any target is
    // narrowed/released. The filtered background now owns those pixels.
    targets = await this.cropPainterTargets(targets, n.postCompositeBox)
    for (let i = 0; i < 4; i++) {
      await this.reclaimScratch()
      this.sampleIndex = i
      const mask = ((pendingSurfaceAdmission = this.nodeMask(n, true), pendingSurfaceAdmission instanceof Promise ? await pendingSurfaceAdmission : pendingSurfaceAdmission))
      const optical = n.glassShape && fx.glass ? this.glass(background, mask, n, fx, true, i) : undefined
      const empty = this.empty(n.rect)
      let layer = this.compose(optical || background, empty, 'normal', 1, mask)
      this.release(optical, empty)
      for (const paint of n.fills) if (paint.visible) {
        const admission = this.reclaimForPaintOver(n, paint, mask, layer)
        if (admission) await admission
        const painted = this.paintOver(n, paint, mask, layer, undefined, true)
        layer = painted instanceof Promise ? await painted : painted
      }
      for (const stroke of n.strokes) {
        let strokeMask = ((pendingSurfaceAdmission = this.mask(stroke.path, true), pendingSurfaceAdmission instanceof Promise ? await pendingSurfaceAdmission : pendingSurfaceAdmission)), aligned: Surface | undefined
        if (stroke.align !== 'center') {
          if (this.surfaceNeedsAdmission(n.rect)) await this.reclaimForSurface(n.rect)
          aligned = this.combine(strokeMask, mask, n.rect, stroke.align === 'outside')
          strokeMask = aligned
        }
        const admission = this.reclaimForPaintOver(n, stroke.paint, strokeMask, layer)
        if (admission) await admission
        const painted = this.paintOver(n, stroke.paint, strokeMask, layer, undefined, true)
        layer = painted instanceof Promise ? await painted : painted
        this.release(aligned)
      }
      const old = targets[i], boundary = clip?.[i]
      const output = this.suffixRect(old, n) || old.rect
      await this.reclaimForSurface(output)
      this.checkFrameCurrent()
      targets[i] = this.run(25, output, [layer, old, boundary || mask, mask], (u) => {
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
  private filterSourceSupported(n: GpuNode, root = true, allowStrokes = false): boolean {
    const strokes = !n.strokes.length || allowStrokes && n.strokes.every(s =>
      (!s.path.count || !!s.path.area) && (s.paint.kind === 'solid' || s.paint.kind === 'image')) &&
      exactBlendLattice([n.rect,n.fill.rect,...n.strokes.map(s=>s.path.rect)])
    return !n.passthrough && !n.clip && !n.mask && !n.maskId && strokes && !n.previewSource &&
      (!n.fill.count || !!n.fill.area) && (root || !n.effects.some(e=>e.visible)) &&
      n.fills.every(p=>p.kind==='solid'||p.kind==='image') &&
      n.children.every(id=>!this.scene.nodes[id]||this.filterSourceSupported(this.scene.nodes[id],false,allowStrokes))
  }
  private filterSource(n: GpuNode, region: Rect, sample: number): Surface {
    if(!intersect(n.rect,region).w||!intersect(n.rect,region).h)return this.empty(region)
    const node={...n,rect:region,fills:n.fills.map(p=>({...p})),strokes:n.strokes.map(s=>({...s,paint:{...s.paint}}))}
    this.sampleIndex=sample
    let layer=this.empty(region), fillMask:Surface|undefined
    const aligned=node.strokes.some(s=>s.align!=='center')
    if(node.fills.some(p=>p.visible)||aligned) {
      fillMask=this.acquire(region,!!(this.driver.managed&&this.driver.createBinaryCoverage),false,SurfaceAllocationSite.filterSourceMask)
      if(n.fill.count)this.driver.maskRegion!(n.fill,fillMask.texture,sample,region)
      else this.driver.clear(fillMask.texture)
      for(const paint of node.fills)if(paint.visible)layer=this.paintOver(node,paint,fillMask,layer)
      if(!aligned){this.release(fillMask);fillMask=undefined}
    }
    for(const id of n.children){
      const child=this.scene.nodes[id];if(!child||child.opacity<=0)continue
      const source=this.filterSource(child,region,sample)
      layer=this.merge(source,layer,child.blend,child.opacity)
      this.release(source)
    }
    // Same painter order and per-sample alignment as drawBundle: children
    // precede strokes; inside/outside multiply the original fill coverage.
    for(const stroke of node.strokes){
      const mask=this.acquire(region,!!(this.driver.managed&&this.driver.createBinaryCoverage),false,SurfaceAllocationSite.filterSourceMask)
      if(stroke.path.count)this.driver.maskRegion!(stroke.path,mask.texture,sample,region)
      else this.driver.clear(mask.texture)
      const coverage=stroke.align==='center'?mask:this.combine(mask,fillMask!,region,stroke.align==='outside')
      layer=this.paintOver(node,stroke.paint,coverage,layer)
      this.release(mask,coverage)
    }
    this.release(fillMask)
    for(const paint of [...node.fills,...node.strokes.map(s=>s.paint)])this.imageGrids.delete(paint)
    return layer
  }
  private async byteShadowAxis(source: Surface, plan: ByteTentPlan): Promise<Surface> {
    const output = plan.output
    let target: Surface | undefined
    try {
      // Borrow a matching ordered pool entry before scratch pressure can
      // destroy it. It needs no new bytes and stays busy across the boundary.
      if (!this.free.get(`${output.w}:${output.h}`)?.length) {
        await this.reclaimScratch(output.w * output.h * 4 + plan.bytes)
        this.checkFrameCurrent()
      }
      target = this.acquire(output, false, false, SurfaceAllocationSite.byteShadowOutput)
      await this.reclaimScratch(plan.bytes)
      this.checkFrameCurrent()
      const before = this.driver.scratchBytes || 0
      try {
        if (this.overBudget(plan.bytes)) throw this.budgetError('GPU 表面内存预算超限', 8)
        if (!this.driver.encodeByteTentAlpha!(target.texture, source.texture,
          { radius: plan.radius, axis: plan.axis, source: plan.source, output: plan.output, scratchBudgetBytes: plan.bytes },
          this.frameBudget - this.workingBytes))
          throw Error('Certified byte shadow filter unavailable')
        this.passPixels += output.w * output.h
        return target
      } finally {
        this.bytes += (this.driver.scratchBytes || 0) - before
        this.peak = Math.max(this.peak, this.bytes)
      }
    } catch (error) {
      this.release(target)
      throw error
    }
  }
  /** Native-certified single outer shadow. Keep all four original source
   * samples and the old mode23 byte resolve; only alpha enters the u64 tent.
   * The sharp foreground and the two old shadow/composition byte boundaries
   * are rendered again at the complete certified consumption rectangle. */
  private async streamByteShadow(n: GpuNode, targets: Surface[], clip?: Surface[]): Promise<Surface[] | undefined> {
    if (import.meta.env.VITE_DESIGN_BYTE_TENT_PREFIX !== '1' || !this.painterStagesEnabled() ||
        !this.optimized || this.driver.name !== 'webgpu' || this.driver.managed || this.imageMips || this.imageAtlas ||
        !this.driver.maskRegion || !this.driver.copyColorRegion || !this.driver.prepareByteTent || !this.driver.encodeByteTentAlpha ||
        !this.scene.integratedBlur || n.children.length || !this.filterSourceSupported(n) || n.blend !== 'normal' ||
        !Number.isFinite(n.opacity) || n.opacity < 0 || n.opacity > 1 || targets.length !== 4 || !n.shadowOutputBox) return
    // Ancestor clipping belongs to the original final merge, never to this
    // isolated leaf's source or blur. Retain all four distinct masks with
    // their original domains. Only current-frame, read-only RGBA8 resources
    // can cross the streaming awaits; target/clip feedback remains forbidden.
    if (clip && (!Array.isArray(clip) || clip.length !== 4 || Array.from(clip).some(surface => {
      const texture = surface?.texture, references = texture && this.aliases.get(texture)
      return !texture || !surface.rect || !texture.resource || this.releasedAliases.has(surface) || !this.used.has(texture) ||
        !(this.busy.has(texture) || this.coverage.has(texture)) ||
        references !== undefined && (!Number.isSafeInteger(references) || references < 1) ||
        !!surface.logicalBounds || !!texture.binaryCoverage || !!texture.scalarCoverage || !!texture.uniformColor || !!texture.transparentZero ||
        !exactBlendLattice([surface.rect]) || surface.rect.w < 1 || surface.rect.h < 1 ||
        texture.width !== surface.rect.w || texture.height !== surface.rect.h || texture.bytes !== texture.width * texture.height * 4 ||
        targets.some(target => texture === target.texture || texture.resource === target.texture.resource)
    }))) return
    const effects = n.effects.filter(effect => effect.visible), fx = effects[0]
    if (effects.length !== 1 || fx.kind !== 'shadow' || fx.spread !== 0 || fx.gradientBlur) return
    const radius = fx.radius * scale(n.matrix)
    if (!Number.isInteger(radius) || Math.fround(radius) !== radius) return
    const dx = n.matrix[0] * fx.x + n.matrix[2] * fx.y, dy = n.matrix[1] * fx.x + n.matrix[3] * fx.y
    const consumption = this.painterBox(n.shadowOutputBox)
    if (!consumption) return
    const output = intersect(consumption, targets[0].rect)
    if (!output.w || !output.h) return targets
    if (targets.some(target => !containsRect(target.rect, output) || target.logicalBounds)) return
    const plan = byteShadowRegion(n.rect, output, radius, dx, dy)
    if (!plan || !await this.driver.prepareByteTent()) return
    this.checkFrameCurrent()
    const previousSample = this.sampleIndex
    let source: Surface | undefined, horizontal: Surface | undefined, blurred: Surface | undefined
    try {
      if (plan.filtered && plan.horizontalPlan && plan.verticalPlan) {
        const missing = this.free.get(`${plan.source.w}:${plan.source.h}`)?.length ? 0 : plan.source.w * plan.source.h * 4
        await this.reclaimScratch(missing)
        this.checkFrameCurrent()
        source = this.acquire(plan.source, false, false, SurfaceAllocationSite.byteShadowSource)
        for (let y = plan.source.y; y < plan.source.y + plan.source.h; y += 64) {
          const pause = this.yieldEncoding(); if (pause) await pause
          const region = { x: plan.source.x, y, w: plan.source.w, h: Math.min(64, plan.source.y + plan.source.h - y) }
          // Four retained byte planes, one binary mask, the temporary paint
          // and the normal-over save coexist at the last source sample.
          await this.reclaimScratch(region.w * region.h * 4 * 7)
          this.checkFrameCurrent()
          const samples: Surface[] = []
          let resolved: Surface | undefined
          try {
            for (let sample = 0; sample < 4; sample++) samples.push(this.filterSource(n, region, sample))
            this.sampleIndex = undefined
            resolved = this.run(23, region, samples)
            this.driver.copyColorRegion(source.texture, resolved.texture, { x: 0, y: 0, w: region.w, h: region.h }, [0, y - plan.source.y])
          } finally { this.release(...samples, resolved) }
        }
        horizontal = await this.byteShadowAxis(source, plan.horizontalPlan)
        blurred = await this.byteShadowAxis(horizontal, plan.verticalPlan)
        this.release(source, horizontal); source = horizontal = undefined
      } else blurred = this.empty(plan.shifted)
      const shadowNode = { ...n, rect: plan.output }
      for (let sample = 0; sample < 4; sample++) {
        const pause = this.yieldEncoding(); if (pause) await pause
        await this.reclaimScratch(plan.output.w * plan.output.h * 4 * 7)
        this.checkFrameCurrent()
        let sharp: Surface | undefined, shadow: Surface | undefined, combined: Surface | undefined
        try {
          sharp = this.filterSource(n, plan.output, sample)
          shadow = this.shadow(sharp, blurred, shadowNode, fx)
          combined = this.compose(sharp, shadow)
          targets[sample] = this.merge(combined, targets[sample], n.blend, n.opacity, clip?.[sample])
        } finally { this.release(sharp, shadow, combined) }
      }
      this.orderedEffectLayers++
      return targets
    } catch (error) {
      // Driver encode exceptions abandon/poison their partial encoder. A real
      // abort boundary is mandatory before any caller can recover/restart.
      await this.abortFrameAndReleaseFilterScratch(error instanceof Error && error.message === 'PREVIEW_CANCELLED' ? 'cancel' : 'admission')
      throw error
    } finally {
      this.sampleIndex = previousSample
      this.release(source, horizontal, blurred)
    }
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
    const mask = this.acquire(region, true, false, SurfaceAllocationSite.filterImageMask)
    try {
      if (n.fill.count) this.driver.maskRegion!(n.fill, mask.texture, sample, region)
      else this.driver.clear(mask.texture)
      const field = this.imageGrid(node, paint, image, level, origin, undefined, 5)
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
      this.scene.displayImageSource, this.scene.displayMaterialSource, !!this.scene.displayTentRadius, this.scene.displayFilters, this.scene.displayFilterRadiusLimit, this.scene.canvasBlurApproximation,
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
      this.scene.coherentSamples, this.scene.compactImageFields, this.scene.displayFilters, this.scene.displayFilterRadiusLimit, this.scene.canvasBlurApproximation,
      this.scene.displayImageSource, this.scene.displayMaterialSource, !!this.scene.displayTentRadius, this.scene.softwareRaster,
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
        // The table consumes separable axes only. Prove that representation
        // before imageGrid can fall back to a full-support dense allocation.
        // A nonseparable transform keeps the existing exact strip sampler.
        if (!this.prepareLargeImageAxes(node, clone, image, 0, 7)) return
        const field=this.imageGrid(node,clone,image,0,[0,0],undefined,6)
        if(field.rect.x!==input.x || field.rect.y!==input.y || field.rect.w!==input.w || field.rect.h!==input.h)return
        const values=this.driver.imageTableAxes(field.texture);if(!values)return
        axes.push(values)
      }
    }finally{this.sampleIndex=previous;this.imageGrids.delete(clone)}
    const plan=planExactImageXTable({axes,width:input.w,height:input.h,
      imageWidth:image.rect.w,imageHeight:image.rect.h,range,
      reuseIdenticalX:import.meta.env.VITE_DESIGN_IMAGE_X_PHASE_REUSE !== '0',
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
        this.imageXTablePrograms += plan.xSampleCount
        this.imageXTableDuplicateBytesSaved += (4 - plan.xSampleCount) *
          (plan.tableBytes / plan.xSampleCount + input.w * 16)
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
        !this.filterSourceSupported(n,true,true) ||
        effects.length !== 1 || effects[0].gradientBlur ||
        !(effects[0].kind === 'blur' || effects[0].kind === 'shadow' && effects[0].spread === 0 &&
          this.driver.exactShadowOver) ||
        n.fills.some(p => p.kind !== 'solid' && p.kind !== 'image')) return
    const wholeCandidate = import.meta.env.VITE_DESIGN_WHOLE_IMAGE_FILTER !== '0'
    const displayRadiusEligible = n.blend === 'normal' && effects[0].kind === 'blur' && !effects[0].gradientBlur
    const boundedShadow = effects[0].kind === 'shadow' && radius > 512 && radius <= 4096 &&
      this.driver.captureDisplay === true && !this.driver.hdr &&
      !!this.driver.uploadBoundedShadowKernel && Number.isSafeInteger(this.driver.boundedShadowPacketMaxDimension) &&
      this.driver.boundedShadowPacketMaxDimension! > 0
    const largeShadow = effects[0].kind === 'shadow' && radius > 2048 && radius <= 4096 && (boundedShadow ||
      import.meta.env.VITE_DESIGN_LARGE_SHADOW_TENT === '1' && import.meta.env.VITE_DESIGN_WIDE_RATIONAL_PREFIX_LARGE === '1' &&
      import.meta.env.VITE_DESIGN_WIDE_RATIONAL_PREFIX === '1')
    if (!(radius > 0 && (radius <= 2048 || largeShadow))) return
    const kernelOperator = boundedShadow ? 'rational-shadow-tent' : largeShadow ? 'rational-large-tent' : 'rational-tent'
    const kernelBytes = () => largeShadow ? rational_large_tent_kernel_rgba(radius) : rational_tent_kernel_rgba(radius)
    const output = intersect(n.rect, targets[0].rect)
    if (!output.w || !output.h) return targets
    const shadow = effects[0].kind === 'shadow'
    const filterOutput = shadow ? shadowFilterRegion(n.rect, output,
      n.matrix[0] * effects[0].x + n.matrix[2] * effects[0].y,
      n.matrix[1] * effects[0].x + n.matrix[3] * effects[0].y) : output
    if (!filterOutput) return
    const reach = Math.ceil(radius) + 1
    let input = intersect(n.rect, {x:filterOutput.x-reach,y:filterOutput.y-reach,w:filterOutput.w+reach*2,h:filterOutput.h+reach*2})
    // A finite solid leaf is exactly transparent outside its compiled coverage
    // rectangle. Do not raster/filter thousands of known-zero halo rows. Keep
    // the original output and tent denominator: absent source texels are +0,
    // not edge-clamped samples or a renormalized smaller filter.
    const sourceBounds=[...(n.fill.count?[n.fill.rect]:[]),...n.strokes.filter(s=>s.path.count).map(s=>s.path.rect)]
    if (!n.children.length && sourceBounds.length && [...n.fills,...n.strokes.map(s=>s.paint)].every(p => !p.visible || p.kind === 'solid' &&
        this.color(p.color).every(Number.isFinite) && Number.isFinite(this.alpha(p.color)) && Number.isFinite(p.opacity)) &&
        exactBlendLattice(sourceBounds)) {
      const left=Math.min(...sourceBounds.map(r=>r.x)),top=Math.min(...sourceBounds.map(r=>r.y))
      const right=Math.max(...sourceBounds.map(r=>r.x+r.w)),bottom=Math.max(...sourceBounds.map(r=>r.y+r.h))
      const supported = intersect(input, {x:left,y:top,w:right-left,h:bottom-top})
      if (supported.w && supported.h) {
        // The prefix operator retains its original in-source output contract;
        // keep transparent padding between coverage and the requested result.
        const x = Math.min(supported.x, filterOutput.x), y = Math.min(supported.y, filterOutput.y)
        input = intersect(input, { x, y, w: Math.max(supported.x + supported.w, filterOutput.x + filterOutput.w) - x,
          h: Math.max(supported.y + supported.h, filterOutput.y + filterOutput.h) - y })
      }
    }
    if (!exactBlendLattice([input, output]) || input.w > 8192 || input.h > 8192) return
    const material = this.filterSourceSupported(n) ? await this.streamDisplayMaterial(n, targets, input, output, clip) : undefined
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
    // A scene containing only >2048 shadows lacks the legacy prefix feature
    // bit. Prepare only after source/window admission; no scratch is allocated
    // until the ordinary byte check at the first encoded filter pass.
    if (largeShadow && this.driver.name === 'webgpu') {
      await this.driver.prepareFilters?.(true)
      this.checkFrameCurrent()
    }
    // Reserve room for the persistent horizontal result and four RGBA strips.
    await this.reclaimScratch(filterOutput.w*input.h*16 + input.w*64*16*4)
    const alignBands = this.driver.name === 'webgpu' && this.prefixAllowed &&
      import.meta.env.VITE_DESIGN_PREFIX_ALIGNED_STRIPS !== '0' &&
      !this.filterKernel(kernelOperator, radius, kernelBytes).texture.prefixRationalUnsupported
    // Shadow assembly consumes alpha only. If the existing rational prefix
    // cannot accelerate this fractional kernel, avoid three unused exact RGB
    // reducers. Retain RGBA storage/copies and the same H->V rounding boundary.
    const filterChannels = shadow && radius > 512 &&
      (boundedShadow || import.meta.env.VITE_DESIGN_WIDE_RATIONAL_PREFIX === '1' && import.meta.env.VITE_DESIGN_WIDE_RATIONAL_PREFIX_LARGE === '1' ||
        !Number.isInteger(radius) && import.meta.env.VITE_DESIGN_WIDE_RATIONAL_PREFIX !== '1' &&
        this.filterKernel(kernelOperator, radius, kernelBytes).texture.prefixRationalUnsupported)
      ? 8 : 15
    const stripRows = alignBands ? prefixAlignedStrip(input.w) : 64
    const stripColumns = alignBands ? prefixAlignedStrip(input.h) : 64
    const previousFields = this.filterImageFields
    this.filterImageFields = { rect: input, fields: new Map(), pinned: new Set() }
    let staticSourcePin: Texture | undefined
    try {
    const reusable = this.horizontalFilterSource(n, input, filterOutput, radius)
    const horizontal = this.acquire({x:filterOutput.x,y:input.y,w:filterOutput.w,h:input.h}, false, false, SurfaceAllocationSite.isolatedHorizontal)
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
      ? prefixAlignedRgbStrip(input.w, filterOutput.w) : stripRows
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
        const resolved = this.acquire(input, false, false, SurfaceAllocationSite.filterTableResolve)
        try {
          this.driver.resolveImageTable!(resolved.texture, imageTable, 0, 0)
          this.imageXTablePixels += input.w * input.h; this.passPixels += input.w * input.h
          this.sampleIndex = undefined
          this.exactTentAxis(resolved, radius, 0, horizontal.rect, horizontal, false, displayRadiusEligible, false, filterChannels, largeShadow, boundedShadow)
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
        resolved=this.acquire(region, false, false, SurfaceAllocationSite.filterRegionResolve)
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
      const filtered=this.exactTentAxis(resolved!,radius,0,{x:filterOutput.x,y,w:filterOutput.w,h:region.h},undefined,false,displayRadiusEligible,false,filterChannels,largeShadow,boundedShadow)
      this.release(resolved)
      const u=parameters(horizontal.rect,filtered.rect);u[16]=0
      this.driver.pass(horizontal.texture,u,[filtered.texture],{x:0,y:y-input.y,w:filterOutput.w,h:region.h})
      this.release(filtered)
    }
    if(opaqueHorizontal)
      horizontal.texture.opaqueAlpha=true
    if(imageTable && this.driver.retireImageTable){
      const before=this.driver.scratchBytes||0,at=performance.now()
      try{await this.driver.retireImageTable(imageTable)}
      finally{this.bytes+=(this.driver.scratchBytes||0)-before;this.checkpointMs+=performance.now()-at}
    }
    await this.reclaimScratch(filterOutput.w*filterOutput.h*16 + (whole ? 0 : filterOutput.h*64*16))
    const blurred=this.acquire(filterOutput, false, false, SurfaceAllocationSite.isolatedBlurOutput)
    if (!whole) this.driver.clear(blurred.texture)
    // Bound vertical encoding too: one whole-width prefix pass can otherwise
    // delay camera-presentation messages behind hundreds of dispatches.
    const columns = alignBands && horizontal.texture.opaqueAlpha && completeFilterAxisSupport(horizontal.rect, filterOutput, 1, radius) &&
      import.meta.env.VITE_DESIGN_PREFIX_RGB_RESOLVE !== '0' ? prefixAlignedRgbStrip(input.h, filterOutput.h) : stripColumns
    if (whole) {
      const pause = this.yieldEncoding(); if (pause) await pause
      this.exactTentAxis(horizontal, radius, 1, filterOutput, blurred, false, displayRadiusEligible, false, filterChannels, largeShadow, boundedShadow)
      this.wholeFilterAxes++
    } else for(let x=filterOutput.x;x<filterOutput.x+filterOutput.w;x+=columns){
      const pause=this.yieldEncoding();if(pause)await pause
      await this.reclaimScratch()
      const region={x,y:filterOutput.y,w:Math.min(columns,filterOutput.x+filterOutput.w-x),h:filterOutput.h}
      const filtered=this.exactTentAxis(horizontal,radius,1,region,undefined,false,displayRadiusEligible,false,filterChannels,largeShadow,boundedShadow)
      const u=parameters(filterOutput,filtered.rect);u[16]=0
      this.driver.pass(blurred.texture,u,[filtered.texture],{x:x-filterOutput.x,y:0,w:region.w,h:region.h})
      this.release(filtered)
    }
    // Ownership transfers only after the original Y filter has consumed the
    // complete plane. Pending entries cannot satisfy another tile yet.
    if (!reusable || !this.horizontalFilters.stage(reusable.lease, reusable.key, reusable.image, horizontal))
      this.release(horizontal)
    const sharpNode=shadow?{...n,rect:output,fills:n.fills.map(p=>({...p}))}:undefined
    const sharedMerges: { destination: Surface; mask?: Surface; result: Surface }[] = []
    const shareResolvedMerge = !shadow && this.scene.coherentSamples &&
      fullSampleCoverage(n.fill, this.scene.curves, targets[0].rect)
    for(let i=0;i<4;i++) {
      await this.reclaimScratch()
      this.checkFrameCurrent()
      const destination = targets[i], mask = clip?.[i]
      const shared = shareResolvedMerge && sharedMerges.find(entry =>
        sameSurface(entry.destination, destination) && this.equivalentClips(entry.mask,mask,destination.rect))
      if (shared) {
        targets[i] = this.retain(shared.result)
        this.release(destination)
        continue
      }
      let source=blurred
      if(sharpNode){
        await this.reclaimForSurface(output)
        this.checkFrameCurrent()
        const sharp=this.filterSource(n,output,i)
        source=this.shadow(sharp,blurred,sharpNode,effects[0],true)
        this.release(sharp)
      }
      await this.reclaimForSurface(destination.rect)
      this.checkFrameCurrent()
      targets[i]=this.merge(source,targets[i],n.blend,n.opacity,clip?.[i])
      if (shareResolvedMerge) sharedMerges.push({ destination, mask, result: targets[i] })
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
    let pendingSurfaceAdmission: Surface | Promise<Surface>
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
        try { this.interactionCapturing = true; surface = (pendingSurfaceAdmission = this.blur(image, plan.radius / 2, true,false,false,true), pendingSurfaceAdmission instanceof Promise ? await pendingSurfaceAdmission : pendingSurfaceAdmission) }
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
        const mask = this.acquire(output, !!this.driver.createBinaryCoverage, false, SurfaceAllocationSite.displayMaterialMask)
        let layer: Surface | undefined
        try {
          this.driver.maskRegion!(n.fill, mask.texture, sample, output)
          layer = (pendingSurfaceAdmission = this.paint(node, samplePaint, mask, cached.surface,true), pendingSurfaceAdmission instanceof Promise ? await pendingSurfaceAdmission : pendingSurfaceAdmission)
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
    const mask = this.acquire(region, true, false, SurfaceAllocationSite.displayImageMask)
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
            try {
              const admission = this.reclaimForPaintOver(node, samplePaint, mask, layer)
              if (admission) await admission
              const painted = this.paintOver(node, samplePaint, mask, layer, undefined, true)
              layer = painted instanceof Promise ? await painted : painted
            }
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
      frame = this.acquire(output, false, false, SurfaceAllocationSite.sequentialFrame)
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
  private colorControls(input: Surface, controls: Effect['colorControls']): Surface {
    if (!controls || (controls.brightness === 0 && controls.contrast === 1 && controls.saturation === 1 && controls.hue === 0)) return input
    const matrix = color_controls_uniforms(JSON.stringify(controls), !!this.scene.colorManagement)
    return this.run(60, input.rect, [input], u => u.set(matrix, 36))
  }
  private async streamedGaussian(n:GpuNode):Promise<Surface>{
    const plan=n.gaussianRegion,regions=plan&&gaussianRegionRects(plan)
    const header=n.fill.area&&new Float32Array(this.curveBits.buffer,this.curveBits.byteOffset+n.fill.area.first*16,1)[0]
    if(!plan||!regions||plan.factor!==undefined&&!this.driver.supportsGaussianReduction?.()||!this.driver.supportsGaussianRegions?.()||!this.driver.copyRegion||!n.fill.area||!this.scene.coherentSamples||![3,4].includes(header!)||
        n.children.length||n.strokes.length||n.mask||n.clip||n.passthrough||n.fills.length!==1||n.fills[0].kind!=='solid'||
        n.effects.filter(e=>e.visible).length!==1||!n.effects.some(e=>e.visible&&e.kind==='gaussian-blur'))
      throw Error('GPU surface budget exceeded (unsupported regional Gaussian source)')
    const kernels=plan.radii.map(r=>this.filterKernel('rational-region-box',r,()=>rational_region_box_kernel_rgba(r)))
    const savedSample=this.sampleIndex,savedCapture=this.interactionCapturing;this.interactionCapturing=true;let current:Surface|undefined
    try{
      await this.reclaimForSurface(regions[1]);this.checkFrameCurrent();current=this.acquire(regions[1])
      const source=regions[0]
      for(let y=source.y;y<source.y+source.h;y+=64){
        await this.yieldEncoding();this.checkFrameCurrent()
        const band={x:source.x,y,w:source.w,h:Math.min(64,source.y+source.h-y)},output={x:regions[1].x,y,w:regions[1].w,h:band.h}
        let resolved:Surface|undefined,mask:Surface|undefined,layer:Surface|undefined,filtered:Surface|undefined
        try{
          for(let sample=0;sample<4;sample++){
            await this.reclaimForSurface(band,3);this.checkFrameCurrent();this.sampleIndex=sample
            mask=this.acquire(band,true);this.driver.mask(n.fill,mask.texture,sample,band)
            layer=this.empty(band)
            const paintNode={...n,rect:band,gaussianRegion:undefined,effects:[]}
            const painted=await this.paintOver(paintNode,n.fills[0],mask,layer,undefined,true)
            layer=painted
            const next=this.run(48,band,resolved?[layer,resolved]:[layer],u=>{u[17]=sample})
            this.release(mask,layer,resolved);mask=layer=undefined;resolved=next
          }
          await this.reclaimForSurface(output)
          filtered=this.run(22,output,[resolved!,kernels[0]],u=>u.set([plan.radii[0],0,0,2],36))
          this.driver.copyRegion(current.texture,filtered.texture,{x:0,y:0,w:output.w,h:output.h},[0,y-regions[1].y])
        }finally{this.release(mask,layer,resolved,filtered)}
      }
      for(let pass=1;pass<6;pass++){
        await this.yieldEncoding();await this.reclaimForSurface(regions[pass+1]);this.checkFrameCurrent()
        const radius=plan.radii[Math.floor(pass/2)],kernel=kernels[Math.floor(pass/2)]
        const next=this.run(22,regions[pass+1],[current,kernel],u=>u.set([radius,pass%2,0,2],36))
        this.release(current);current=next
      }
      if(plan.factor!==undefined){
        await this.reclaimForSurface(plan.fullOutput!);this.checkFrameCurrent()
        const full=this.run(74,plan.fullOutput!,[current],u=>{u[36]=plan.factor!})
        this.release(current);current=full
      }
      const result=current;current=undefined;return result
    }finally{this.sampleIndex=savedSample;this.interactionCapturing=savedCapture;this.release(current)}
  }
  private async wideImageGaussian(input:Surface,n:GpuNode,sigma:number):Promise<Surface|undefined>{
    const paint=n.fills[0],source=input.rect,texture=input.texture
    if(import.meta.env.VITE_DESIGN_WIDE_IMAGE_GAUSSIAN!=='1'||!this.sequentialGaussian||
      !this.optimized||this.driver.name!=='webgpu'||!this.driver.managed||this.driver.hdr||this.driver.displayMath||
      !this.driver.supportsGaussianRegions?.()||!this.driver.copyRegion||!this.driver.immutableImageRange||
      this.scene.softwareRaster||this.scene.interactionRetained||this.interactionCapturing||
      !this.scene.coherentSamples||!(sigma>512&&sigma<=1024)||
      n.children.length||n.strokes.length||n.clip||n.mask||n.maskId||n.passthrough||n.blend!=='normal'||
      n.fills.length!==1||paint?.kind!=='image'||!paint.visible||!paint.image||paint.blend!=='normal'||
      !Number.isFinite(paint.opacity)||paint.opacity<0||paint.opacity>1||
      n.effects.filter(e=>e.visible).length!==1||!n.effects.some(e=>e.visible&&e.kind==='gaussian-blur'&&!e.gradientBlur)||
      !this.busy.has(texture)||this.releasedAliases.has(input)||input.logicalBounds||
      texture.uniformColor||texture.transparentZero||texture.scalarCoverage||texture.binaryCoverage||
      texture.width!==source.w||texture.height!==source.h||texture.bytes!==source.w*source.h*16||
      !exactBlendLattice([source])||source.w>16384||source.h>16384||source.w*source.h>16_777_216)return
    // The sampled image owns a complete upload certificate. Four positive
    // coverage/opacity samples remain bounded; HDR and unknown uploads keep
    // the original operator rather than borrow this SDR prefix arithmetic.
    const image=this.imageFor(paint.image,this.imageLevel(n,paint),false,paint.adjust)
    const range=this.driver.immutableImageRange(image.texture)
    if(!range?.unitAlpha||range.maximum.length!==4||
      !range.maximum.every(v=>Number.isInteger(v)&&v>=0&&v<=127))return
    const radii=Array.from(gaussian_region_box_radii(sigma))
    let current=input,next:Surface|undefined
    const previousCapture=this.interactionCapturing;this.interactionCapturing=true
    try{
      for(const radius of radii){
        const kernel=this.filterKernel('rational-region-box',radius,()=>rational_region_box_kernel_rgba(radius))
        for(const axis of [0,1]){
          await this.reclaimForSurface(source);this.checkFrameCurrent();next=this.acquire(source)
          const length=axis===0?source.h:source.w
          for(let offset=0;offset<length;offset+=64){
            const pause=this.yieldEncoding();if(pause)await pause
            const strip=axis===0?{x:source.x,y:source.y+offset,w:source.w,h:Math.min(64,length-offset)}:
              {x:source.x+offset,y:source.y,w:Math.min(64,length-offset),h:source.h}
            await this.reclaimScratch(strip.w*strip.h*16+BOX_PREFIX_BYTES);this.checkFrameCurrent()
            const filtered=this.run(22,strip,[current,kernel],u=>u.set([radius,axis,0,2],36))
            try{this.driver.copyRegion(next.texture,filtered.texture,{x:0,y:0,w:strip.w,h:strip.h},
              [strip.x-source.x,strip.y-source.y])}finally{this.release(filtered)}
          }
          if(current!==input)this.release(current)
          current=next;next=undefined
        }
      }
      const result=current;current=input;return result
    }finally{this.release(next,current!==input?current:undefined);this.interactionCapturing=previousCapture}
  }
  /** Only the selected soft effect is filtered on a coarser device lattice.
   * Coverage, source paint, shadow offsets and final composition stay at full
   * device resolution. All ordinary frame and export requests use blur(). */
  private foregroundBlur(input: Surface, n: GpuNode, fx: Effect, sigma: number, alphaOnly = false): Surface | Promise<Surface> {
    const forceGaussian = fx.kind === 'gaussian-blur'
    if (this.driver.gestureSoftEffects && this.scene.gestureSoftEffects && !this.interactionCapturing &&
        this.scene.interactionSelection?.includes(n.id) && !fx.gradientBlur && !fx.zoomBlur &&
        sigma >= 8 && sigma <= 128 && input.rect.w * input.rect.h >= 65536 &&
        !input.logicalBounds && !input.texture.uniformColor && !input.texture.transparentZero &&
        input.texture.width === input.rect.w && input.texture.height === input.rect.h && exactBlendLattice([input.rect])) {
      const region = this.drawRegion(input.rect)
      if (!region || this.scene.interactionLocalFootprint && region.w > 0 && region.h > 0 ||
          region.x === 0 && region.y === 0 && region.w === input.rect.w && region.h === input.rect.h)
        return this.halfResolutionBlur(input, sigma, alphaOnly, forceGaussian)
    }
    return this.blur(input, sigma, false, alphaOnly, false, true, true, forceGaussian)
  }
  private async halfResolutionBlur(input: Surface, sigma: number, alphaOnly: boolean, forceGaussian: boolean): Promise<Surface> {
    const r = input.rect
    const left = Math.floor(r.x / 2), top = Math.floor(r.y / 2)
    const half = rect(left, top, Math.ceil((r.x + r.w) / 2) - left, Math.ceil((r.y + r.h) / 2) - top)
    let small: Surface | undefined, filtered: Surface | undefined
    // Render the reduced grid in its own coordinates, then reconstruct with
    // the original screen scissor. The native extent retains the read halo.
    const previous = this.interactionCapturing
    this.interactionCapturing = true
    try {
      await this.reclaimForSurface(half)
      this.checkFrameCurrent()
      small = this.run(75, half, [input], u => { u[37] = Number(!!input.texture.scalarCoverage) })
      filtered = await this.blur(small, sigma / 2, false, alphaOnly, false, true, true, forceGaussian)
      await this.reclaimForSurface(r)
      this.checkFrameCurrent()
      this.gestureBlurPixels += half.w * half.h
      this.interactionCapturing = previous
      return this.run(74, r, [filtered], u => {
        u[36] = 2
        u[37] = Number(!!filtered!.texture.scalarCoverage)
      })
    } finally {
      this.release(filtered !== small ? filtered : undefined, small)
      this.interactionCapturing = previous
    }
  }
  private async spatialBlur(input: Surface, n: GpuNode, fx: Effect): Promise<Surface> {
    if(fx.zoomBlur){
      if(fx.zoomBlur.amount===0)return input
      const kernel=this.filterKernel(`zoom:${JSON.stringify([input.rect,n.matrix,n.size,fx.zoomBlur.center])}`,fx.zoomBlur.amount,
        ()=>zoom_blur_coordinates(JSON.stringify(fx.zoomBlur),new Float64Array(n.matrix),new Float64Array(n.size),JSON.stringify(input.rect)),values=>[256,values.length/1024])
      const pending=this.admitSurface(input.rect,1,false,false,[input,kernel],()=>this.run(62,input.rect,[input,kernel]))
      return pending?await pending:this.run(62,input.rect,[input,kernel])
    }
    if (fx.radius === 0) return input
    if (fx.kind === 'gaussian-blur') {
      const sigma=fx.radius*scale(n.matrix),wide=await this.wideImageGaussian(input,n,sigma)
      return wide || await this.foregroundBlur(input, n, fx, sigma)
    }
    const direction = [n.matrix[0],n.matrix[1],n.matrix[2],n.matrix[3],0,0]
    const kernel = this.filterKernel(`motion:${JSON.stringify([direction,fx.motionAngle??0])}`,fx.radius,
      () => motion_blur_kernel(fx.radius,fx.motionAngle??0,new Float64Array(direction)), values => [256,values.length/1024])
    const pending = this.admitSurface(input.rect,1,false,false,[input,kernel],()=>this.run(61,input.rect,[input,kernel]))
    return pending ? await pending : this.run(61,input.rect,[input,kernel])
  }
  private async applySampleEffects(
    n: GpuNode,
    planes: Surface[],
    coverage: { value?: Surface[]; owned?: boolean },
    resolvedFirstBlur?: Surface,
  ): Promise<Surface[]> {
    let pendingSurfaceAdmission: Surface | Promise<Surface>
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
      if (fx.kind === 'color-controls') {
        const shared = new Map<Texture, Surface>()
        planes = planes.map(plane => {
          let next = shared.get(plane.texture)
          if (next) { this.release(plane); return this.retain(next) }
          next = this.colorControls(plane, fx.colorControls)
          shared.set(plane.texture, next)
          if (next !== plane) this.release(plane)
          return next
        })
      } else if (fx.kind === 'gaussian-blur' || fx.kind === 'motion-blur' || fx.kind === 'zoom-blur') {
        const resolved = resolvedFirstBlur || this.run(23,n.rect,planes)
        resolvedFirstBlur = undefined; this.release(...planes)
        const filtered = await this.spatialBlur(resolved,n,fx)
        if (filtered !== resolved) this.release(resolved)
        planes = [filtered,this.retain(filtered),this.retain(filtered),this.retain(filtered)]
        if (coverage.value) {
          const mask=this.run(23,n.rect,coverage.value)
          if(coverage.owned)this.release(...coverage.value)
          const value=await this.spatialBlur(mask,n,fx)
          if(value!==mask)this.release(mask)
          coverage.value=[value,this.retain(value),this.retain(value),this.retain(value)];coverage.owned=true
        }
      } else if (fx.kind === 'blur') {
        const resolved = resolvedFirstBlur || this.run(23, n.rect, planes)
        resolvedFirstBlur = undefined
        // The resolve has encoded the last read of these sample planes.
        // Keeping them throughout both separable passes unnecessarily pins
        // four full effect-halo surfaces at high zoom.
        this.release(...planes)
        const radius=fx.radius*Math.max(1,fx.gradientBlur?.startCount??1,fx.gradientBlur?.endCount??1)*sc
        const full=(pendingSurfaceAdmission = this.foregroundBlur(resolved, n, fx, radius / 2), pendingSurfaceAdmission instanceof Promise ? await pendingSurfaceAdmission : pendingSurfaceAdmission)
        const blurred=await this.gradientBlur(resolved,full,n,fx)
        if(blurred!==full && full!==resolved)this.release(full)
        if (blurred !== resolved) this.release(resolved)
        planes = [blurred, this.retain(blurred), this.retain(blurred), this.retain(blurred)]
        if (coverage.value) {
          const mask = this.run(23, n.rect, coverage.value)
          if (coverage.owned) this.release(...coverage.value)
          const fullMask = (pendingSurfaceAdmission = this.foregroundBlur(mask, n, fx, radius / 2), pendingSurfaceAdmission instanceof Promise ? await pendingSurfaceAdmission : pendingSurfaceAdmission),
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
        const blurred = (pendingSurfaceAdmission = this.foregroundBlur(alpha, n, fx, fx.radius * sc / 2, true), pendingSurfaceAdmission instanceof Promise ? await pendingSurfaceAdmission : pendingSurfaceAdmission)
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
    shape?: (values: Uint8Array | Float32Array) => [number, number], allowPacketRows = false): Surface {
    const domain = [this.driver.managed ? 'float' : 'byte', !!this.driver.linearLight,
      !!this.driver.hdr, !!this.driver.certifiedFilter].join(':')
    const boundedShadow = operator === 'rational-shadow-tent' && radius > 512 && radius <= 4096 &&
      !!this.driver.uploadBoundedShadowKernel && Number.isSafeInteger(this.driver.boundedShadowPacketMaxDimension) &&
      this.driver.boundedShadowPacketMaxDimension! > 0
    const largeWide = (operator === 'rational-tent' || operator === 'rational-large-tent' && import.meta.env.VITE_DESIGN_LARGE_SHADOW_TENT === '1') && import.meta.env.VITE_DESIGN_WIDE_RATIONAL_PREFIX === '1' &&
      import.meta.env.VITE_DESIGN_WIDE_RATIONAL_PREFIX_LARGE === '1'
    const candidateLimit = boundedShadow ? this.driver.boundedShadowPacketMaxDimension : (allowPacketRows || largeWide) && !shape && radius > 512 && radius <= (operator === 'rational-large-tent' || operator === 'rational-shadow-tent' ? 4096 : 2048) &&
      (operator === 'rational-tent' || operator === 'certified-tent' || operator === 'rational-large-tent') &&
      (import.meta.env.VITE_DESIGN_EXACT_WHOLE_TENT_2048 === '1' || largeWide) && this.driver.name === 'webgpu' && this.driver.managed &&
      this.driver.uploadExactFilterPacket ? this.driver.exactFilterPacketMaxDimension : undefined
    const packetLimit = Number.isSafeInteger(candidateLimit) && candidateLimit! > 0 ? candidateLimit : undefined
    const mathematicalKey = immutableKernelKey(operator, radius, domain)
    // Old callers cannot pick up a folded texture from a prior new-lane call.
    // Even small new-lane packets remain 1D but use this isolated GPU policy.
    const key = packetLimit === undefined ? mathematicalKey :
      immutableKernelKey(operator, radius, `${domain}:packet-rows-v1:${packetLimit}`)
    const frame = operator.startsWith('certified-') ? this.certifiedKernels : this.blurKernels
    const existing = frame.get(key)
    if (existing) return existing
    let texture = this.retainKernels ? this.kernelCache.get(key, this.driver.resourceEpoch!) : undefined
    if (texture) this.kernelResidentHits++
    else {
      const cpuKey = operator === 'certified-tent' ? `cpu-u8-v1/${mathematicalKey}` : undefined
      let values: Uint8Array | Float32Array | undefined = cpuKey ? this.coefficientBytes.get(cpuKey) : undefined
      if (!values) {
        values = build()
        // Only this audited Uint8Array constructor is eligible. Other kernel
        // families retain the exact existing construction path.
        if (cpuKey && values instanceof Uint8Array)
          values = this.coefficientBytes.put(cpuKey, values) || values
      }
      let [width, height] = shape ? shape(values) : [values.length / 4, 1]
      let bytes = values.byteLength * (values instanceof Uint8Array && this.driver.managed ? 4 : 1)
      let folded = false
      if (packetLimit !== undefined && values instanceof Uint8Array && width > packetLimit) {
        const logicalTexels = exactFilterPacketTexels(values, operator === 'rational-large-tent' || operator === 'rational-shadow-tent' ? 4096 : 2048)
        const layout = logicalTexels !== undefined ? exactFilterPacketLayout(logicalTexels, packetLimit) : undefined
        if (!layout) throw new Error('WebGPU 纹理尺寸超限')
        width = layout.width; height = layout.height; bytes = layout.bytes; folded = height > 1
      }
      // Includes padded physical texels, before padding/f32 expansion/upload.
      if (this.overBudget(bytes, width, height)) throw this.budgetError('GPU 表面内存预算超限', 9)
      try { if (boundedShadow) {
        if (!(values instanceof Uint8Array)) throw Error('Invalid bounded shadow coefficient packet')
        texture = this.driver.uploadBoundedShadowKernel!(values,width,height,radius)
      } else if (folded) {
        texture = this.driver.uploadExactFilterPacket!(values as Uint8Array, width, height)
      } else if (values instanceof Float32Array) {
        if (!this.driver.uploadLinear) throw new Error('Backend cannot upload linear coefficients')
        texture = (this.driver.uploadParameters||this.driver.uploadLinear).call(this.driver,values,width,height)
      } else {
        if (!this.driver.uploadRgba8) throw new Error('Backend cannot upload exact coefficients')
        texture = import.meta.env.VITE_DESIGN_CERTIFIED_TENT_PREFIX==='1' && this.driver.uploadExactTentKernel &&
          (operator==='rational-tent'||operator==='certified-tent') && radius>=32 && radius<=512
          ? this.driver.uploadExactTentKernel(values,width,height,operator,radius)
          : this.driver.uploadRgba8(values, width, height)
      } } catch(error){throw annotateTextureFailure(error,{textureAllocationKind:4,textureKernelRadius:radius,textureLogicalTexels:values.length/4})}
      if ((operator === 'rational-tent' || operator === 'rational-large-tent' || operator === 'rational-shadow-tent') && values instanceof Uint8Array)
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
  private certifiedKernel(radius: number, box = false, allowPacketRows = false) {
    if (!this.driver.certifiedFilter) return undefined
    return this.filterKernel(box ? 'certified-box' : 'certified-tent', radius,
      () => box ? certified_box_kernel_rgba(radius) : certified_tent_kernel_rgba(radius), undefined, allowPacketRows)
  }
  private wideDisplayBackdropEligible(node: GpuNode, radius: number) {
    if (!this.optimized || !this.driver.copyColorRegion || !allowsDisplayTentRadius(this.scene, this.driver, false, true) ||
        !(radius > 512 && radius <= 2048) || node.blend !== 'normal' || node.passthrough) return false
    const effects = (node.effects || []).filter(effect => effect.visible)
    return effects.length === 1 && effects[0].kind === 'background-blur' && !effects[0].gradientBlur
  }
  private certifyDisplayBackdropDestination(target: Surface, source: Surface, radius: number, axis: number, clamp: boolean) {
    this.checkFrameCurrent()
    const u = parameters(target.rect, source.rect); u[37] = axis; u[38] = Number(clamp)
    const epoch = this.driver.resourceEpoch
    if (!Number.isFinite(radius) || Math.fround(radius) !== radius || typeof clamp !== 'boolean' ||
        !Number.isSafeInteger(epoch) || epoch! < 1 || !this.privateBandDestination(target) || !this.busy.has(source.texture) ||
        this.releasedAliases.has(source) || target.texture === source.texture || target.texture.resource === source.texture.resource ||
        source.logicalBounds || source.texture.scalarCoverage || source.texture.binaryCoverage || source.texture.uniformColor || source.texture.transparentZero ||
        source.texture.width !== source.rect.w || source.texture.height !== source.rect.h || source.texture.bytes !== source.rect.w * source.rect.h * 16 ||
        !prefixSamplingGeometry(u, radius, true)) throw Error('Invalid display backdrop strip proof')
    this.displayBackdropDestinations.set(target, { source, radius, axis, clamp, epoch: epoch!, sourceResource: source.texture.resource,
      targetResource: target.texture.resource, sourceRect: { ...source.rect }, targetRect: { ...target.rect },
      sourceShape: [source.texture.width, source.texture.height, source.texture.bytes], sourceFlags: [source.texture.binaryCoverage,
        source.texture.scalarCoverage, source.texture.uniformColor, source.texture.transparentZero, source.texture.opaqueAlpha, source.texture.finitePixels] })
  }
  /** Hold reusable strips busy before an awaited admission can dispose of
   * their pool slots. This operator alone owns both returned allocations. */
  private async acquireDisplayBackdropStrips(region: Rect, count: number): Promise<Surface[]> {
    const surfaces: Surface[] = [], key = `${region.w}:${region.h}`
    try {
      while (surfaces.length < count && this.free.get(key)?.length) {
        const surface = this.acquire(region, false, false, SurfaceAllocationSite.displayBackdropStripReuse); this.aliases.set(surface.texture, 1); surfaces.push(surface)
      }
      await this.reclaimScratch((count - surfaces.length) * region.w * region.h * 16 + PREFIX_SCRATCH_BYTES)
      this.checkFrameCurrent()
      while (surfaces.length < count) { const surface = this.acquire(region, false, false, SurfaceAllocationSite.displayBackdropStripNew); this.aliases.set(surface.texture, 1); surfaces.push(surface) }
      return surfaces
    } catch (error) { this.release(...surfaces); throw error }
  }
  /** Independent large normal-background display operator. Input is borrowed.
   * H is private until return; save/filter each full-height column before
   * replacing that column, so no third full V plane or texture feedback exists.
   * The complete scalar/prefix addressing plan must pass before any encoding.
   */
  private async blurDisplayBackdropBands(input: Surface, sigma: number, node: GpuNode, clampEdges: boolean): Promise<Surface | undefined> {
    const radius = sigma * 2, texture = input.texture
    if (!this.wideDisplayBackdropEligible(node, radius) || !this.busy.has(texture) || this.releasedAliases.has(input) ||
        input.logicalBounds || texture.uniformColor || texture.transparentZero || texture.scalarCoverage || texture.binaryCoverage ||
        texture.width !== input.rect.w || texture.height !== input.rect.h || texture.bytes !== texture.width * texture.height * 16) return
    const selected = selectDisplayTentRadius(radius, true), plan = planDisplayBackdropBands(input.rect, selected, clampEdges)
    if (!plan) return
    // Hydrate the actual shared packets before admitting the result/strips;
    // later exactTentAxis calls reuse these same frame/cache entries.
    this.filterKernel('rational-tent', selected, () => rational_tent_kernel_rgba(selected))
    this.certifiedKernel(selected)
    await this.reclaimForSurface(plan.source)
    this.checkFrameCurrent()
    const previousCapture = this.interactionCapturing
    this.interactionCapturing = true
    let result: Surface | undefined
    try {
      result = this.acquire(plan.source, false, false, SurfaceAllocationSite.displayBackdropSource)
      for (const [index, row] of plan.rows.entries()) {
        const pause = this.yieldEncoding(); if (pause) await pause
        const [horizontal] = await this.acquireDisplayBackdropStrips(row, 1)
        try {
          this.certifyDisplayBackdropDestination(horizontal, input, selected, 0, clampEdges)
          this.exactTentAxis(input, radius, 0, row, horizontal, clampEdges, true)
          this.driver.copyColorRegion!(result.texture, horizontal.texture, { x: 0, y: 0, w: row.w, h: row.h }, [0, index * 64])
        } finally { this.displayBackdropDestinations.delete(horizontal); this.release(horizontal) }
      }
      for (const [index, column] of plan.columns.entries()) {
        const pause = this.yieldEncoding(); if (pause) await pause
        const [saved, vertical] = await this.acquireDisplayBackdropStrips(column, 2)
        try {
          const local = index * 64
          this.driver.copyColorRegion!(saved.texture, result.texture, { x: local, y: 0, w: column.w, h: column.h }, [0, 0])
          this.certifyDisplayBackdropDestination(vertical, saved, selected, 1, clampEdges)
          this.exactTentAxis(saved, radius, 1, column, vertical, clampEdges, true)
          this.driver.copyColorRegion!(result.texture, vertical.texture, { x: 0, y: 0, w: column.w, h: column.h }, [local, 0])
        } finally { this.displayBackdropDestinations.delete(vertical); this.release(vertical, saved) }
      }
      const complete = result; result = undefined; return complete
    } finally { this.release(result); this.interactionCapturing = previousCapture }
  }
  private exactTentAxis(input: Surface, radius: number, axis: number, output: Rect, destination?: Surface, clampEdges = false, displayEligible = false, allowPacketRows = false, channels = 15, largeShadow = false, boundedShadow = false) {
    boundedShadow = boundedShadow && !!this.driver.uploadBoundedShadowKernel &&
      Number.isSafeInteger(this.driver.boundedShadowPacketMaxDimension) && this.driver.boundedShadowPacketMaxDimension! > 0
    largeShadow = largeShadow && (import.meta.env.VITE_DESIGN_LARGE_SHADOW_TENT === '1' || boundedShadow)
    if (!(radius > 0 && radius <= (largeShadow ? 4096 : 2048))) throw Error('GPU exact blur radius exceeds 2048 pixels')
    const selected = selectDisplayTentRadius(radius, displayEligible && allowsDisplayTentRadius(this.scene, this.driver, false, true))
    const kernel = this.filterKernel(boundedShadow ? 'rational-shadow-tent' : largeShadow ? 'rational-large-tent' : 'rational-tent', selected, () => largeShadow ? rational_large_tent_kernel_rgba(selected) : rational_tent_kernel_rgba(selected), undefined, allowPacketRows)
    const certified=largeShadow || boundedShadow ? undefined : this.certifiedKernel(selected, false, allowPacketRows)
    const result = this.run(22,output,[input,kernel,...(certified?[certified]:[])],u=>u.set([selected,axis,clampEdges?1:0,1],36),channels,{kind:'tent',radius:selected},false,destination)
    if (selected !== radius) { this.displayTentRadiusPasses++; this.displayTentRadiusPixels += output.w * output.h }
    return result
  }
  /** Only the native painter certificate may narrow a backdrop's consumed
   * result. Keep its original capture lattice and real shape-edge clamp.
   * Bit-preserving strip copies retain signed underflow zeros between axes. */
  private async blurBackdropRegion(input: Surface, sigma: number, node: GpuNode): Promise<Surface> {
    const radius = sigma * 2
    const output = backdropFilterRegion(input.rect, node.backdropOutputBox)
    const backdrop = node.blend === 'normal' ? backdropEffect(node.effects || []) : undefined
    const displayEligible = backdrop?.kind === 'background-blur' && !backdrop.gradientBlur &&
      !node.effects.some(effect => effect.visible && effect.gradientBlur)
    if (import.meta.env.VITE_DESIGN_EXACT_CLAMP_PREFIX !== '1' || !output || !this.optimized ||
        this.driver.name !== 'webgpu' || !this.driver.managed || !this.driver.copyRegion ||
        !this.scene.integratedBlur || this.displayFilterActive(radius) || !(radius > 0 && radius <= 2048) ||
        this.scene.interactionRetained || this.interactionCapturing)
      {
        const wide = await this.blurDisplayBackdropBands(input, sigma, node, true)
        return wide || this.blur(input, sigma, true, false, displayEligible,true)
      }
    if (input.texture.transparentZero) return input
    // Do not reinterpret constant/scalar physical resources as a full capture.
    // Their ordinary lossless expansion remains authoritative.
    if (input.texture.uniformColor || input.texture.scalarCoverage) return this.blur(input, sigma, true, false, displayEligible,true)
    const horizontalRect = { x: output.x, y: input.rect.y, w: output.w, h: input.rect.h }
    const strip = 64
    await this.reclaimScratch(horizontalRect.w * horizontalRect.h * 16 +
      Math.max(output.w, output.h) * strip * 16 + PREFIX_SCRATCH_BYTES)
    this.checkFrameCurrent()
    const horizontal = this.acquire(horizontalRect, false, false, SurfaceAllocationSite.displayBackdropHorizontal)
    let result: Surface | undefined
    try {
      for (let row = 0; row < horizontalRect.h; row += strip) {
        this.checkFrameCurrent()
        const pause = this.yieldEncoding(); if (pause) await pause
        await this.reclaimScratch(output.w * Math.min(strip, horizontalRect.h - row) * 16 + PREFIX_SCRATCH_BYTES)
        this.checkFrameCurrent()
        const region = { x: output.x, y: input.rect.y + row, w: output.w, h: Math.min(strip, horizontalRect.h - row) }
        const filtered = this.exactTentAxis(input, radius, 0, region, undefined, true, displayEligible)
        try { this.driver.copyRegion(horizontal.texture, filtered.texture, { x: 0, y: 0, w: region.w, h: region.h }, [0, row]) }
        finally { this.release(filtered) }
      }
      await this.reclaimScratch(output.w * output.h * 16 + Math.min(strip, output.w) * output.h * 16 + PREFIX_SCRATCH_BYTES)
      this.checkFrameCurrent()
      result = this.acquire(output, false, false, SurfaceAllocationSite.displayBackdropOutput)
      for (let column = 0; column < output.w; column += strip) {
        this.checkFrameCurrent()
        const pause = this.yieldEncoding(); if (pause) await pause
        await this.reclaimScratch(Math.min(strip, output.w - column) * output.h * 16 + PREFIX_SCRATCH_BYTES)
        this.checkFrameCurrent()
        const region = { x: output.x + column, y: output.y, w: Math.min(strip, output.w - column), h: output.h }
        const filtered = this.exactTentAxis(horizontal, radius, 1, region, undefined, true, displayEligible)
        try { this.driver.copyRegion(result.texture, filtered.texture, { x: 0, y: 0, w: region.w, h: region.h }, [column, 0]) }
        finally { this.release(filtered) }
      }
      const complete = result; result = undefined
      this.backdropRegionOutputs.set(complete, { x: node.backdropOutputBox![0], y: node.backdropOutputBox![1],
        w: node.backdropOutputBox![2], h: node.backdropOutputBox![3] })
      this.backdropRegionBuilds++
      this.backdropRegionSourcePixels += input.rect.w * input.rect.h
      this.backdropRegionResultPixels += output.w * output.h
      return complete
    } finally { this.release(horizontal, result) }
  }
  private backdropConsumptionRect(node: GpuNode, filtered: Surface): Rect {
    // Only the region method returns the smaller capture-lattice rectangle.
    // Uncertified/old paths keep their original full-node mode27 operation.
    return this.backdropRegionOutputs.get(filtered) || node.rect
  }
  private displayFilterActive(radius: number, channels = 15) {
    if (!this.scene.displayFilters || !this.driver.managed || !this.driver.supportsDisplayFilters) return false
    return this.driver.usesDisplayFilter ? this.driver.usesDisplayFilter(radius, channels) :
      this.scene.displayFilterRadiusLimit === undefined
  }
  /** Independent opt-in whole-source operator, not an extension of the old
   * <=512 lane. The complete original domain must already exist physically.
   * No crop, rescale, display radius selection, scalar conversion or in-place
   * update is used; the H texture is the existing f32 RNE boundary before V. */
  private blurLargeExact(input: Surface, radius: number, clampEdges: boolean, alphaOnly: boolean, admit: boolean): Surface | Promise<Surface> | undefined {
    const texture = input.texture, source = input.rect
    if (import.meta.env.VITE_DESIGN_EXACT_WHOLE_TENT_2048 !== '1' ||
        this.driver.name !== 'webgpu' || !this.driver.managed || this.driver.displayMath ||
        this.scene.integratedBlur !== true || this.scene.displayFilters || this.scene.displayMaterialSource || this.scene.displayImageSource ||
        this.scene.softwareRaster || alphaOnly ||
        !(radius > 512 && radius <= 2048) || !Number.isFinite(radius) || typeof clampEdges !== 'boolean' ||
        input.logicalBounds || input.compactMaxAbs || input.imageZeroOverIdentity ||
        !this.busy.has(texture) || this.releasedAliases.has(input) || !exactBlendLattice([source]) ||
        source.w < 1 || source.h < 1 || source.w > 8192 || source.h > 8192 || source.w * source.h > 16777216 ||
        texture.width !== source.w || texture.height !== source.h || texture.bytes !== source.w * source.h * 16 ||
        !this.driver.supportsExactWholeTentSource?.(texture)) return
    // Prove the unchanged full-domain address lane for both axes, including
    // real clamp edges and worst-case original-radius taps. This is geometry
    // only: arbitrary HDR/signed/nonfinite values retain exact shader fallback.
    for (const axis of [0, 1]) {
      const u = parameters(source, source); u[37] = axis; u[38] = Number(clampEdges)
      const geometry = prefixSamplingGeometry(u, radius, true)
      if (!geometry || geometry.offset !== geometry.padding || geometry.crossOffset !== 0) return
    }
    this.checkFrameCurrent()
    const kernel = this.filterKernel('rational-tent', radius, () => rational_tent_kernel_rgba(radius), undefined, true)
    const certified = this.certifiedKernel(radius, false, true)
    const bands = admit && this.driver.copyRegion && planDisplayBackdropBands(source, radius, clampEdges)
    if (bands) return this.blurLargeExactBands(input, radius, clampEdges, bands)
    if (admit) {
      const pending = this.admitSurface(source, 2, false, false, [input, kernel, ...(certified ? [certified] : [])],
        // Existing admission pins the source and coefficients across the wait.
        // Re-enter all qualification and cancellation checks, without retrying
        // admission or selecting a display radius after the wait.
        () => this.blur(input, radius / 2, clampEdges, false, false))
      if (pending) return pending
    }
    let horizontal: Surface | undefined, vertical: Surface | undefined
    try {
      // Reserve both complete destinations before encoding H. Existing pool,
      // per-resource and working-set limits remain authoritative. Prefix may
      // use only its remaining admitted scratch or fall back to exact op22.
      horizontal = this.acquire({ ...source }, false, false, SurfaceAllocationSite.passOutput, 22)
      vertical = this.acquire({ ...source }, false, false, SurfaceAllocationSite.passOutput, 22)
      if (!this.driver.supportsExactWholeTentSource!(horizontal.texture) || !this.driver.supportsExactWholeTentSource!(vertical.texture))
        throw Error('Invalid exact whole-filter destination')
      this.checkFrameCurrent()
      this.exactTentAxis(input, radius, 0, horizontal.rect, horizontal, clampEdges, false, true)
      this.checkFrameCurrent()
      this.exactTentAxis(horizontal, radius, 1, vertical.rect, vertical, clampEdges, false, true)
      const result = vertical; vertical = undefined; return result
    } finally { this.release(horizontal, vertical) }
  }
  /** Same complete source and H rounding boundary as the whole operator.
   * Band outputs never become a cropped input: V reads the full original H,
   * including zero-weight neighbours, signed zeros and nonfinite values. */
  private async blurLargeExactBands(input: Surface, radius: number, clampEdges: boolean,
    plan: NonNullable<ReturnType<typeof planDisplayBackdropBands>>): Promise<Surface> {
    const scene = this.scene, source = input.texture, original = { ...input.rect }
    const valid = () => this.scene === scene && this.busy.has(source) && !this.releasedAliases.has(input) &&
      !input.logicalBounds && !input.compactMaxAbs && !input.imageZeroOverIdentity &&
      input.rect.x === original.x && input.rect.y === original.y && input.rect.w === original.w && input.rect.h === original.h &&
      source.width === original.w && source.height === original.h && source.bytes === original.w * original.h * 16 &&
      this.driver.supportsExactWholeTentSource?.(source)
    let horizontal: Surface | undefined, vertical: Surface | undefined
    try {
      await this.reclaimForSurface(original, 2)
      this.checkFrameCurrent()
      if (!valid()) throw Error('Exact filter source changed during admission')
      horizontal = this.acquire(original, false, false, SurfaceAllocationSite.passOutput, 22)
      vertical = this.acquire(original, false, false, SurfaceAllocationSite.passOutput, 22)
      for (const [axis, regions] of [plan.rows, plan.columns].entries()) {
        const from = axis === 0 ? input : horizontal, to = axis === 0 ? horizontal : vertical
        for (const region of regions) {
          const pause = this.yieldEncoding(); if (pause) await pause
          await this.reclaimForSurface(region)
          this.checkFrameCurrent()
          if (!valid()) throw Error('Exact filter source changed during encoding')
          const strip = this.exactTentAxis(from, radius, axis, region, undefined, clampEdges, false, true)
          try { this.driver.copyRegion!(to.texture, strip.texture, { x: 0, y: 0, w: region.w, h: region.h },
            [region.x - original.x, region.y - original.y]) }
          finally { this.release(strip) }
        }
      }
      const result = vertical; vertical = undefined; return result
    } finally { this.release(horizontal, vertical) }
  }
  private blur(input: Surface, sigma: number, clampEdges?: boolean, alphaOnly?: boolean, displayEligible?: boolean): Surface
  private blur(input: Surface, sigma: number, clampEdges: boolean, alphaOnly: boolean, displayEligible: boolean, admit: true, largeExactSourceAllowed?: boolean, forceGaussian?: boolean): Surface | Promise<Surface>
  private blur(input: Surface, sigma: number, clampEdges: boolean, alphaOnly: boolean, displayEligible: boolean, admit: false, largeExactSourceAllowed: boolean, forceGaussian?: boolean): Surface
  private blur(input: Surface, sigma: number, clampEdges = false, alphaOnly = false, displayEligible = false, admit = false, largeExactSourceAllowed = true, forceGaussian = false): Surface | Promise<Surface> {
    // Every finite normalized kernel maps the all-+0 field to itself, with
    // either transparent or clamped edges. Filter pipelines can keep using
    // physical inputs without allocating a transparent expansion first.
    if (input.texture.transparentZero) return input
    const integrated = this.scene.integratedBlur && !forceGaussian
    const channels = this.optimized && this.driver.managed && alphaOnly ? 8 : 15
    const displayFilter = !forceGaussian && this.displayFilterActive(sigma * 2, channels)
    const scalarAlpha = this.optimized && alphaOnly && this.driver.managed &&
      this.driver.scalarAlphaFilter && integrated && !displayFilter
    if ((input.texture.uniformColor || input.texture.scalarCoverage && !scalarAlpha) && sigma > 0) {
      // Filter kernels have independent layouts. Expand losslessly before
      // entering them rather than letting R32F's default alpha become one.
      if (admit) {
        const pending = this.admitSurface(input.rect, 3, false, false, [input],
          () => this.blur(input, sigma, clampEdges, alphaOnly, displayEligible, false, false, forceGaussian))
        if (pending) return pending
      }
      // Expansion preserves the established small-radius behavior, but cannot
      // turn an originally scalar/constant source into new-lane authority.
      // Carry this exclusion through recursion/admission, never shared state.
      const expanded=this.copy(input), result=this.blur(expanded,sigma,clampEdges,alphaOnly,displayEligible,false,false,forceGaussian)
      if(result!==expanded)this.release(expanded)
      return result
    }
    if (displayFilter && integrated) {
      const radius = sigma * 2
      if (radius <= 0) return input
      const kernel = this.filterKernel('display-tent', radius, () => {
        const weights = displayFilterWeights(radius), height = Math.ceil(weights.length / 256)
        const data = new Float32Array(256 * height * 4)
        weights.forEach((weight, i) => { data[i * 4] = weight })
        return data
      }, values => [256, values.length / (256 * 4)])
      if (admit) {
        const pending = this.admitSurface(input.rect, 2, false, false, [input, kernel],
          () => this.blur(input, sigma, clampEdges, alphaOnly, displayEligible, false, largeExactSourceAllowed, forceGaussian))
        if (pending) return pending
      }
      const horizontal = this.run(22, input.rect, [input, kernel], u => u.set([radius, 0, clampEdges ? 1 : 0, 1], 36), channels, { kind: 'tent', radius })
      const vertical = this.run(22, input.rect, [horizontal, kernel], u => u.set([radius, 1, clampEdges ? 1 : 0, 1], 36), channels, { kind: 'tent', radius })
      this.release(horizontal)
      return vertical
    }
    if (integrated) {
      const authoredRadius = this.driver.managed ? sigma * 2 : Math.fround(sigma * 2)
      if (authoredRadius <= 0) return input
      if (authoredRadius > 512) {
        const exact = largeExactSourceAllowed && this.blurLargeExact(input, authoredRadius, clampEdges, alphaOnly, admit)
        if (exact) return exact
        throw new Error('GPU 积分模糊半径超过 512 像素')
      }
      // The original whole-filter guard must inspect the original radius:
      // display rounding cannot admit an unsupported nested >512 filter.
      const radius = selectDisplayTentRadius(authoredRadius, displayEligible && !alphaOnly &&
        allowsDisplayTentRadius(this.scene, this.driver, false, true))
      let kernel: Surface | undefined
      if (this.driver.managed || !Number.isInteger(radius)) {
        kernel = this.filterKernel(this.driver.managed ? 'rational-tent' : 'quantized-tent', radius,
          () => this.driver.managed ? rational_tent_kernel_rgba(radius) : quantized_tent_kernel_rgba(radius))
      }
      const certified = this.certifiedKernel(radius)
      if (admit) {
        const pending = this.admitSurface(input.rect, 2, false, !!scalarAlpha, [input, ...(kernel ? [kernel] : []), ...(certified ? [certified] : [])],
          () => this.blur(input, sigma, clampEdges, alphaOnly, displayEligible, false, largeExactSourceAllowed, forceGaussian))
        if (pending) return pending
      }
      const horizontal = this.run(22, input.rect, kernel ? [input, kernel, ...(certified ? [certified] : [])] : [input], (u) =>
        u.set([radius, 0, clampEdges ? 1 : 0, kernel ? 1 : 0], 36), channels, this.optimized ? {kind: 'tent', radius} : undefined, scalarAlpha,
      )
      if (radius !== authoredRadius) { this.displayTentRadiusPasses++; this.displayTentRadiusPixels += input.rect.w * input.rect.h }
      const vertical = this.run(22, input.rect, kernel ? [horizontal, kernel, ...(certified ? [certified] : [])] : [horizontal], (u) =>
        u.set([radius, 1, clampEdges ? 1 : 0, kernel ? 1 : 0], 36), channels, this.optimized ? {kind: 'tent', radius} : undefined, scalarAlpha,
      )
      if (radius !== authoredRadius) { this.displayTentRadiusPasses++; this.displayTentRadiusPixels += input.rect.w * input.rect.h }
      this.release(horizontal)
      return vertical
    }
    if (admit) {
      const kernels: Surface[] = []
      for (const r of gaussianRadii(sigma)) if (r > 0) {
        kernels.push(this.filterKernel('rational-box', r, () => rational_box_kernel_rgba(r)))
        const certified = this.certifiedKernel(r, true); if (certified) kernels.push(certified)
      }
      if (kernels.length) {
        const pending = this.admitSurface(input.rect, 2, false, false, [input, ...kernels],
          () => this.blur(input, sigma, clampEdges, alphaOnly, displayEligible, false, largeExactSourceAllowed, forceGaussian))
        if (pending) return pending
      }
    }
    let current = input
    for (const r of gaussianRadii(sigma)) {
      if (r <= 0) continue
      const kernel = this.filterKernel('rational-box', r, () => rational_box_kernel_rgba(r))
      const certified = this.certifiedKernel(r, true)
      for (const axis of [0, 1]) {
        const next = this.run(22, input.rect, [current, kernel, ...(certified ? [certified] : [])], (u) => u.set([r, axis, 0, forceGaussian ? 2 : 1], 36), channels)
        if (current !== input) this.release(current)
        current = next
      }
    }
    return current
  }
  private textureGrid(n: GpuNode, fx: Effect): Surface | undefined {
    if (fx.kind !== 'texture' || (!this.driver.managed && !fx.texture)) return undefined
    const upload = this.driver.uploadParameters || this.driver.uploadLinear
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
        const plan=JSON.parse(this.prepareWithFailureOrigin(6, () => glass_geometry_interior(JSON.stringify(region),JSON.stringify(fieldRegion),new Float64Array(n.matrix),
          JSON.stringify(n.glassShape),JSON.stringify(fx),sample), 9)) as {interior:Rect;value:number[]}|null
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
    const region=n.rect,out=this.acquire(region, false, false, SurfaceAllocationSite.textureReplayOutput),scissor=this.drawRegion(region)
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
    this.coordinateMaps.addOwned(texture)
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
    if (this.overBudget(bytes)) throw this.budgetError('GPU 表面内存预算超限', 10)
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
    if (this.overBudget(bytes)) throw this.budgetError('GPU 表面内存预算超限', 11)
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
        if (this.overBudget(8192, 1024, 2)) throw this.budgetError('GPU 表面内存预算超限', 12)
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
    let pendingSurfaceAdmission: Surface | Promise<Surface>
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
      fill=((pendingSurfaceAdmission = this.fillMask(n), pendingSurfaceAdmission instanceof Promise ? await pendingSurfaceAdmission : pendingSurfaceAdmission))
      const raw=await this.interactionBackdropDisplay(n,backdrop,(backdropRadius(background!) * scale(n.matrix))/2)
      const blurred=this.colorControls(raw, background!.colorControls)
      if (blurred !== raw) this.release(raw)
      layer=this.run(15,n.rect,[blurred,blurred,fill],u=>u.set([15,0,1,1],16))
      this.release(blurred)
    }else{
      if(n.passthrough&&this.surfaceNeedsAdmission(n.rect))await this.reclaimForSurface(n.rect)
      layer=n.passthrough?this.copy(backdrop,n.rect):this.empty(n.rect)
    }
    if (n.fills.length || n.clip || background) fill = ((pendingSurfaceAdmission = this.fillMask(n), pendingSurfaceAdmission instanceof Promise ? await pendingSurfaceAdmission : pendingSurfaceAdmission))
    if (background && fill && !directBackdrop) {
      const raw = await this.interactionBackdropDisplay(n,backdrop,(backdropRadius(background) * scale(n.matrix)) / 2)
      const blur = this.colorControls(raw, background.colorControls)
      if (blur !== raw) this.release(raw)
      const next =
        background.kind === 'glass'
          ? this.glass(blur, fill, n, background)
          : this.compose(blur, layer, 'normal', 1, fill)
      this.release(blur, layer)
      layer = next
    }
    for (const p of n.fills) {
      if (!p.visible) continue
      const mask=fill||((pendingSurfaceAdmission=this.fillMask(n),pendingSurfaceAdmission instanceof Promise?await pendingSurfaceAdmission:pendingSurfaceAdmission))
      if(this.gradientFusionEligible(n,p,mask,layer)){
        layer=await this.gradientPaintOver(n,p,mask,layer);continue
      }
      const painted = ((pendingSurfaceAdmission = this.paint(n, p, mask, undefined, true), pendingSurfaceAdmission instanceof Promise ? await pendingSurfaceAdmission : pendingSurfaceAdmission))
      if(this.driver.managed&&(this.scene.interactionRetained||this.surfaceNeedsAdmission(layer.rect)))
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
        if(this.surfaceNeedsAdmission(empty.rect))await this.reclaimForSurface(empty.rect)
        maskSurface = this.compose(raw, empty, 'normal', this.scene.nodes[maskId].opacity)
        if (this.scene.nodes[maskId].maskType === 'luminance') {
          if(this.surfaceNeedsAdmission(maskSurface.rect))await this.reclaimForSurface(maskSurface.rect)
          const next = this.run(30, maskSurface.rect, [maskSurface])
          this.release(maskSurface)
          maskSurface = next
        }
        this.release(raw)
        this.release(empty)
      } else maskSurface = empty
    }
    if (maskSurface) {
      if(n.passthrough&&this.surfaceNeedsAdmission(layer.rect))await this.reclaimForSurface(layer.rect)
      const content = await this.drawList(
        n.children,
        n.passthrough ? this.copy(layer) : this.empty(n.rect),
        clip,
        maskId,
      )
      if(this.surfaceNeedsAdmission(layer.rect))await this.reclaimForSurface(layer.rect)
      const combined = n.passthrough
        ? this.interpolate(content, layer, 1, maskSurface)
        : this.compose(content, layer, 'normal', 1, maskSurface)
      this.release(layer, content)
      layer = combined
    } else layer = await this.drawList(n.children, layer, clip, maskId)
    if (clip && clip !== fill && clip !== maskSurface) this.release(clip)
    this.release(maskSurface)
    for (const s of n.strokes) {
      let strokeMask = ((pendingSurfaceAdmission = this.mask(s.path, true), pendingSurfaceAdmission instanceof Promise ? await pendingSurfaceAdmission : pendingSurfaceAdmission))
      let clipped: Surface | undefined
      if (s.align !== 'center') {
        const fillMask = fill || ((pendingSurfaceAdmission = this.mask(n.fill, true), pendingSurfaceAdmission instanceof Promise ? await pendingSurfaceAdmission : pendingSurfaceAdmission))
        if (this.surfaceNeedsAdmission(n.rect)) await this.reclaimForSurface(n.rect)
        clipped = this.combine(strokeMask, fillMask, n.rect, s.align === 'outside')
        strokeMask = clipped
      }
      const painted = ((pendingSurfaceAdmission = this.paint(n, s.paint, strokeMask, undefined, true), pendingSurfaceAdmission instanceof Promise ? await pendingSurfaceAdmission : pendingSurfaceAdmission))
      if(this.driver.managed&&(this.scene.interactionRetained||this.surfaceNeedsAdmission(layer.rect)))
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
      if (fx.kind === 'color-controls') {
        const next = this.colorControls(layer, fx.colorControls)
        if (next !== layer) this.release(layer)
        layer = next
      } else if (fx.kind === 'gaussian-blur' || fx.kind === 'motion-blur' || fx.kind === 'zoom-blur') {
        const next=await this.spatialBlur(layer,n,fx)
        if(next!==layer)this.release(layer)
        layer=next
      } else if (fx.kind === 'blur') {
        const full=(pendingSurfaceAdmission = this.foregroundBlur(layer, n, fx, (fx.radius*Math.max(1,fx.gradientBlur?.startCount??1,fx.gradientBlur?.endCount??1)*sc)/2), pendingSurfaceAdmission instanceof Promise ? await pendingSurfaceAdmission : pendingSurfaceAdmission)
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
        const blur = (pendingSurfaceAdmission = this.foregroundBlur(alpha, n, fx, fx.radius * sc / 2, true), pendingSurfaceAdmission instanceof Promise ? await pendingSurfaceAdmission : pendingSurfaceAdmission)
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
    const retiring = this.retiredImageAssetCohort()
    try {
      await abort.call(this.driver, reason)
      this.staticImageBlurs.collect(this.driver.completedResourceEpoch)
      this.coverRetiredImageAssets(retiring)
    }
    finally { this.bytes += (this.driver.scratchBytes || 0) - reserved }
  }
  async render(scene: GpuScene, readback = false, present = true, isCurrent?: () => boolean, onEncodingProgress?: (drawCalls:number)=>void, displayBackpressure=false) {
    // Cancellation requires an explicit encoder-abandon/completion boundary.
    // WebGL and older drivers retain their existing completed-frame checks.
    this.frameCurrent = this.driver.abortFrameAndReleaseFilterScratch ? isCurrent : undefined
    this.displayBackpressure=displayBackpressure&&!readback&&present&&this.driver.name==='webgpu'&&!this.driver.hdr&&!scene.softwareRaster
    this.driver.rasterPacing=this.displayBackpressure&&import.meta.env.VITE_DESIGN_RASTER_QUEUE_PACING!=='0'
    this.sliceDraws=0
    this.encodingProgress=onEncodingProgress;this.progressDraws=0;this.progressAt=performance.now()
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
    } finally { this.frameCurrent = undefined; this.displayBackpressure=false; this.driver.rasterPacing=false; this.residentImageRequest=false; this.frameImageReuse=false; this.gradientPhaseRequest=false; this.encodingProgress=undefined; this.activeRuntimeConfiguration = undefined }
  }
  private async renderAttempt(scene: GpuScene, readback = false, present = true) {
    // Display-only automatic residency. The existing private source owner,
    // color/mip policy, completion and pressure gates still decide every hit.
    // Explicit outputs and unowned loaders keep their established paths.
    const displayImages = present && !readback && !!this.driver.captureDisplay &&
      this.driver.name === 'webgpu' && !!this.driver.managed && !this.driver.hdr &&
      import.meta.env.VITE_DESIGN_RESIDENT_IMAGE_REUSE !== '0'
    this.residentImageRequest = displayImages &&
      (import.meta.env.VITE_DESIGN_RESIDENT_IMAGE_REUSE === '1' || !scene.interactionRetained)
    this.frameImageReuse = displayImages && scene.nativeInteraction === true && scene.interactionRetained === true
    this.gradientPhaseRequest=present&&!readback&&!!this.driver.captureDisplay&&this.driver.name==='webgpu'&&
      !!this.driver.managed&&!this.driver.hdr&&!scene.softwareRaster&&scene.nativeInteraction===true&&scene.interactionRetained===true&&
      import.meta.env.VITE_DESIGN_RETAIN_PARAMETER_FIELDS!=='0'
    this.activeRuntimeConfiguration = undefined
    this.skippedPainterVisits=0
    const managedDisplay=present&&!readback&&this.driver.name==='webgpu'&&!!this.driver.managed&&!this.driver.hdr&&!this.driver.displayMath
    this.sourceTileOcclusion=managedDisplay && scene.sourceDetailTile===true && import.meta.env.VITE_DESIGN_OPAQUE_PAINTER_PREFIX!=='0' &&
      !!scene.output && scene.coherentSamples===true && scene.colorManagement?.documentSpace==='srgb' &&
      !scene.resolve && !scene.presentation && !scene.interactionRetained && !scene.softwareRaster
    this.opaquePrefixActive=managedDisplay&&(this.opaquePrefixEnabled||this.sourceTileOcclusion)
    if (this.painterStagesEnabled(scene)) {
      // Bind candidate coverage proofs and driver uploads to one private
      // snapshot before any pipeline preparation yields. Native JSON already
      // needed this conversion; typed inputs copy only in the opt-in lane.
      if (scene.curves instanceof Float32Array && !(scene.curves.buffer instanceof ArrayBuffer))
        throw Error('Certified painter programs require an unshared snapshot')
      scene = { ...scene, curves: new Float32Array(scene.curves || []) }
    }
    // A display sampler never changes exact readback/export/reference output,
    // even when a caller reuses a previously displayed compiled scene object.
    if (scene.displayImageSource && (readback || !present || this.driver.hdr))
      scene = { ...scene, displayImageSource: false }
    if (scene.displayMaterialSource && (readback || !present || this.driver.hdr))
      scene = { ...scene, displayMaterialSource: false }
    if (scene.displayTentRadius && !allowsDisplayTentRadius(scene, this.driver, readback, present))
      scene = { ...scene, displayTentRadius: false }
    if (scene.sequentialDisplay && (readback || !present || this.driver.hdr))
      scene = { ...scene, sequentialDisplay: false }
    if (!scene.displayMaterialSource) this.retireDisplayMaterial()
    if (scene.displayFilterRadiusLimit !== undefined && (readback || !present || this.driver.hdr))
      scene = { ...scene, displayFilters: false, displayFilterRadiusLimit: undefined }
    const canvasBlurApproximation = Array.isArray(scene.roots) && scene.roots.length > 0 &&
      canvasBlurSceneEligible(this.canvasBlurEnabled, scene, this.driver, readback, present)
    if (canvasBlurApproximation || scene.canvasBlurApproximation) scene = { ...scene, canvasBlurApproximation }
    const arithmetic = JSON.stringify([!!scene.canvasBlurApproximation, !!scene.displayFilters, scene.displayFilterRadiusLimit ?? null,
      !!scene.displayImageSource, !!scene.displayMaterialSource, !!scene.sequentialDisplay, !!scene.displayTentRadius])
    if (this.interactionArithmetic && this.interactionArithmetic !== arithmetic) this.interactionInvalid = true
    this.interactionArithmetic = arithmetic
    this.horizontalFilters.begin(scene.filterBatchLease)
    // A tile origin/crop is part of each entry, not a reason to discard other
    // completed tiles. Zoom and arithmetic-policy changes retire the batch.
    this.staticImageBlurs.begin(import.meta.env.VITE_DESIGN_STATIC_IMAGE_BLUR_CACHE === '1' ? exactFilterKey([
      scene.view.zoom, scene.colorManagement, scene.floatCompositing, scene.coherentSamples, scene.integratedBlur,
      scene.compactImageFields, scene.displayFilters, scene.displayFilterRadiusLimit, scene.canvasBlurApproximation,
      scene.displayImageSource, scene.displayMaterialSource, !!scene.displayTentRadius, scene.softwareRaster, scene.resolve?.scale, scene.presentation?.scale,
      this.driver.name, this.driver.linearLight, this.driver.hdr, this.driver.certifiedFilter,
      import.meta.env.VITE_DESIGN_IMAGE_AXES !== '0', import.meta.env.VITE_DESIGN_STREAM_IMAGE_FIELDS !== '0',
      import.meta.env.VITE_DESIGN_EXACT_IMAGE_X_TABLE !== '0', import.meta.env.VITE_DESIGN_WHOLE_IMAGE_FILTER !== '0',
    ]) : undefined, this.driver.completedResourceEpoch)
    this.staticImageBlurEligible = this.staticImageBlurHits = this.staticImageBlurPixels = 0
    this.imageXTableBuilds = this.imageXTablePixels = this.imageXTableBytes = 0
    this.imageXTablePrograms = this.imageXTableDuplicateBytesSaved = 0
    this.backdropRegionBuilds = this.backdropRegionSourcePixels = this.backdropRegionResultPixels = 0
    this.painterStageCopies = this.painterStageCopyBytes = 0
    this.wholeFilterAxes = 0
    this.gestureBlurPixels = 0
    // Cover the half-grid box footprint, bilinear reconstruction and the
    // rounding of the three Gaussian box radii at each selected filter.
    this.gestureFilterPadding = scene.gestureSoftEffects
      ? (scene.interactionSelection || []).reduce((pad, id) => pad + 8 * (scene.nodes[id]?.effects.filter(fx =>
        fx.visible && ['shadow','inner-shadow','blur','gaussian-blur'].includes(fx.kind)).length || 0), 0) : 0
    this.displayTentRadiusPasses = this.displayTentRadiusPixels = 0
    this.horizontalFilterHits = this.horizontalFilterPixels = this.horizontalFilterRows = 0
    this.encodeYield.begin()
    this.lastBudgetFailure = undefined
    // Surface storage is RGBA32F in both arithmetic modes. Exact desktop
    // shaders must not silently lose the resident viewport's dynamic budget
    // merely because native f32 display arithmetic is disabled.
    const nativeDisplay = !!(this.driver.captureDisplay && !scene.coherentSamples) ||
      usesNativeNavigationWorkingBudget(import.meta.env.VITE_DESIGN_NATIVE_NAVIGATION, {
        driverName: this.driver.name, managed: this.driver.managed, hdr: this.driver.hdr,
        readback, present, softwareRaster: scene.softwareRaster,
      })
    const workingTarget = scene.interactionWindow || scene.output || scene.extent
    const opticalPixels = nativeDisplay && scene.nativeInteraction && import.meta.env.VITE_DESIGN_OPTICAL_HEADROOM==='1'
      ?Object.values(scene.nodes).reduce((largest,n)=>n.effects.some(e=>e.visible&&(e.kind==='glass'||e.kind==='background-blur'))
        ?Math.max(largest,intersect(n.rect,scene.extent).w*intersect(n.rect,scene.extent).h):largest,0):0
    this.frameBudget = workingSetBudget(workingTarget.w, workingTarget.h, nativeDisplay, opticalPixels, this.gpuWorkingBudgetMiB)
    try { this.recordRuntimeConfiguration(scene, readback, present) }
    catch { this.activeRuntimeConfiguration = undefined /* diagnostics must not change rendering */ }

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
    this.coherentSubtreePressure=false
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
    if(retainRoots||this.interactionInvalid)this.retireCoherentSubtrees(retainRoots&&!this.interactionInvalid?index.sources:undefined,scene.interactionLease)
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
        ;(this.free as SurfacePool<Texture>).removed?.(t)
        this.bytes -= t.bytes
        this.lastUsed.delete(t)
        return false
      })
      if (retained.length) {
        if((this.free as SurfacePool<Texture>).setOwned)(this.free as SurfacePool<Texture>).setOwned(key,retained)
        else this.free.set(key,retained)
      }
      else this.free.delete(key)
    }
    this.used.clear()
    this.coverage.begin(gpuDiagnosticsEnabled())
    this.materialFields.begin()
    this.gradientPhaseDeclined.clear()
    this.fieldHits = this.fieldBuilds = this.fieldBuildMs = this.fieldUploadBytes = 0
    this.scene = scene
    this.solidRunsActive=hasOpaqueSolidGroups(scene)
    this.gradientFusionActive=!!this.driver.exactGradientPaintOver&&gradientFusionWorthwhile(scene)
    this.constantCoverageActive=this.constantCoverageEnabled&&scene.coherentSamples===true&&Object.values(scene.nodes).some(n=>
      (n.clip||n.fills.some(p=>p.visible)||n.strokes.some(s=>s.align!=='center')||!!backdropEffect(n.effects))&&
      (n.opaqueCoverage||n.fill.sampleCount===4&&containsRect(n.fill.opaqueRect,n.rect)&&containsRect(n.fill.rect,n.rect)))
    this.passPixels = 0
    this.fastWork.reset(gpuDiagnosticsEnabled())
    this.checkpointMs = 0
    this.maskHits = 0
    this.maskRasterizations = 0
    this.backdropReads = 0
    this.orderedEffectLayers = 0
    const started = performance.now()
    // Scene policy is installed synchronously before its async pipeline work.
    // Filter programs and image uploads can then prepare independently.
    const preparation = [this.prepareWithFailureOrigin(1, () => this.driver.prepareScene?.(scene, !readback && present))]
    if (index.hasFilters)
      preparation.push(this.prepareWithFailureOrigin(2, () => this.driver.prepareFilters?.(Boolean(this.prefixAllowed && this.optimized && this.driver.managed && scene.integratedBlur && index.hasPrefixFilter))))
    preparation.push(this.loadImages(scene))
    const prepared = await Promise.allSettled(preparation)
    const prepareFailureIndex = prepared.findIndex(result => result.status === 'rejected')
    const prepareFailure = prepared[prepareFailureIndex]
    if (prepareFailure?.status === 'rejected') throw this.failureOrigin(prepareFailure.reason,
      prepareFailureIndex === 0 ? 1 : prepareFailureIndex === prepared.length - 1 ? 3 : 2)
    const vertices = scene.vertices instanceof Float32Array ? scene.vertices : new Float32Array(scene.vertices)
    this.meshBits = new Uint32Array(vertices.buffer, vertices.byteOffset, vertices.length)
    const curves = scene.curves instanceof Float32Array ? scene.curves : new Float32Array(scene.curves || [])
    this.curveBits = new Uint32Array(curves.buffer, curves.byteOffset, curves.length)
    this.hybridEffects = 0
    this.checkFrameCurrent()
    const preparingScratch = this.driver.scratchBytes || 0
    try { await this.prepareWithFailureOrigin(4, () => this.driver.prepareFrameResources?.(vertices, curves)) }
    finally { this.bytes += (this.driver.scratchBytes || 0) - preparingScratch }
    this.checkFrameCurrent()
    this.prepareWithFailureOrigin(4, () => this.driver.begin(vertices, curves))
    this.masks.clear()
    this.maskOwners.clear()
    let target: Surface | undefined
    let retainedSamples:Surface[]|undefined
    let completed = false, cancelledUploadsComplete=false
    try {
      if (scene.sequentialDisplay) {
        target = await this.sequentialViewport(scene, scene.output || rect(0, 0, scene.width, scene.height), readback, present)
      } else {
      let planes: Surface[] = []
      const rootInput = this.painterStagesEnabled(scene) ? painterStageBox(scene.rootInputBox!, scene.extent) : scene.extent
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
        let plane = this.run(12, uniformBackground ? rect(0,0,1,1) : rootInput, [], (u) => {
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
        }, 15, undefined, false, undefined, uniformBackground)
        if(uniformBackground){
          // This immutable ancestor otherwise pins a full effect-halo-sized
          // RGBA32F surface while its isolated document root is being drawn.
          plane.texture.uniformColor=true
          this.constantTargets.set('page-background',plane)
          plane={...this.retain(plane),rect:rootInput}
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
      if (planes.length === 4&&this.driver.retainedSampleCapture?.()&&!readback&&present&&!scene.resolve&&!scene.presentation) {
        // Keep the correlated sample planes through layer capture. Resolving
        // each layer before source-over loses edge/background covariance.
        retainedSamples=planes;target=planes[0]
      } else if (planes.length === 4) {
        const p = scene.resolve
        const output = p ? scene.output || rect(0, 0, p.width, p.height) : this.painterStagesEnabled(scene)
          ? scene.output || rect(0, 0, scene.width, scene.height) : scene.extent
        // The four completed planes stay live through resolve. Their render
        // can leave a large pool pending on the queue; admit the final target
        // before allocating it instead of failing an otherwise finished frame.
        if (this.surfaceNeedsAdmission(output)) await this.reclaimForSurface(output)
        target = p
          ? this.run(24, output, planes, (u) =>
              u.set([p.offsetX, p.offsetY, p.scale, 0], 36),
            )
          : this.run(this.driver.managed ? 23 : 36, output, planes)
        this.release(...planes)
      } else target = planes[0]
      if (scene.resolve && !scene.coherentSamples) {
        const source = target,
          p = scene.resolve
        if (this.surfaceNeedsAdmission(rect(0, 0, p.width, p.height))) await this.reclaimForSurface(rect(0, 0, p.width, p.height))
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
          if (this.surfaceNeedsAdmission(crop)) await this.reclaimForSurface(crop)
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
        retainedSamples,
      ) } catch (error) { throw this.failureOrigin(markRenderFailure(error, { failureStage: 7 }), 5) } finally {
        // Driver finish may retire scratch before a later readback fails.
        this.bytes += (this.driver.scratchBytes || 0) - finishingScratch
      }
      completed = true
      if (scene.sequentialDisplay) this.sequentialDisplayFrames++
      if (this.displayMaterial) this.displayMaterial.published = true
      this.horizontalFilters.finish(!this.frameCurrent || this.frameCurrent())
      this.staticImageBlurs.finish(!this.frameCurrent || this.frameCurrent(), this.driver.completedResourceEpoch)
      this.collectRetiredImageAssets()
      return {
        ...result,
        staticImageBlurEligible: this.staticImageBlurEligible, staticImageBlurHits: this.staticImageBlurHits,
        staticImageBlurPixels: this.staticImageBlurPixels, staticImageBlurBytes: this.staticImageBlurs.bytes,
        staticImageBlurEntries: this.staticImageBlurs.count,
        opaqueTentPasses: this.driver.opaqueTentPasses || 0, imageXTableBuilds: this.imageXTableBuilds, imageXTablePixels: this.imageXTablePixels, imageXTableBytes: this.imageXTableBytes,
        imageXTablePrograms: this.imageXTablePrograms, imageXTableDuplicateBytesSaved: this.imageXTableDuplicateBytesSaved,
        wholeFilterAxes: this.wholeFilterAxes,
        gestureBlurPixels: this.gestureBlurPixels,
        displayTentRadiusPasses: this.displayTentRadiusPasses, displayTentRadiusPixels: this.displayTentRadiusPixels,
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
        materialFieldRejectedOversize: this.materialFields.rejectedOversize,
        materialFieldRejectedPinned: this.materialFields.rejectedPinned,
        materialFieldRejectedBytes: this.materialFields.rejectedBytes,
        materialFieldCacheBytes: this.materialFields.bytes,
        kernelBuilds: this.kernelBuilds,
        kernelResidentHits: this.kernelResidentHits,
        kernelUploadBytes: this.kernelUploadBytes,
        kernelCacheBytes: this.kernelCache.bytes,
        kernelCacheEntries: this.kernelCache.size,
        kernelRetiredBytes: this.retiredKernels.reduce((sum, entry) => sum + entry.texture.bytes, 0),
        backdropReads: this.backdropReads,
        drawCalls: this.driver.drawCalls,
        drawWork: {...this.driver.drawWorkSnapshot?.(),...this.fastWork.snapshot(),...(gpuDiagnosticsEnabled()?{
          fastCoverageCacheHits:this.coverage.hits,fastCoverageCacheMissKeys:this.coverage.missKeys,fastCoverageCacheMissWords:this.coverage.missWords,
          fastCoverageCacheOversize:this.coverage.rejectedOversize,fastCoverageCachePinned:this.coverage.rejectedPinned}: {})},
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
      this.failureOrigin(markRenderFailure(error, { failureStage: 12 }), 4)
      if (scene.sequentialDisplay || error instanceof Error && error.message === 'PREVIEW_CANCELLED') {
        // Never pool/destroy frame resources while submitted commands still
        // reference them. This leaves the separately owned presented frame alive.
        await this.abortFrameAndReleaseFilterScratch('cancel')
        // These fields were uploaded directly by the queue, not rasterized by
        // the abandoned encoder. Successful WebGPU completion covers those
        // immutable uploads; complete source keys still decide every reuse.
        cancelledUploadsComplete=this.driver.name==='webgpu'&&error instanceof Error&&error.message==='PREVIEW_CANCELLED'
      }
      if (scene.sequentialDisplay && isRecoverablePreviewBudget(error, this.driver.lost))
        throw Error('SEQUENTIAL_DISPLAY_UNSUPPORTED', { cause: error })
      throw error
    } finally {
      if(retainedSamples){this.release(...retainedSamples);retainedSamples=undefined}
      for (const surface of this.constantTargets.values()) this.release(surface)
      this.constantTargets.clear()
      this.aliases.clear()
      this.releasedAliases = new WeakSet()
      if (!completed) {
        // An abort may advance the resource-retirement epoch even after
        // discarding an unsubmitted encoder. That never publishes its pixels.
        if (this.displayMaterial && !this.displayMaterial.published) this.retireDisplayMaterial()
        this.retireNestedPrefix(); this.retireCoherentSubtrees(); this.horizontalFilters.clear(); this.staticImageBlurs.finish(false, this.driver.completedResourceEpoch); this.coverage.clear(); if(!cancelledUploadsComplete)this.materialFields.clear(); this.interactionInvalid = true
      }
      for (const texture of this.coordinateMaps) {
        this.gradientPhaseResources.delete(texture)
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
    this.imageResidencyOwner = undefined; this.imageResidencyPolicy = undefined
    this.retiredImageAssets.clear()
    this.displayMaterial = undefined
    this.sequentialImagePins.clear()
    this.horizontalFilters.clear()
    this.staticImageBlurs.dispose()
    this.coefficientBytes.clear()
    this.encodeYield.dispose()
    this.interactionPrefix = undefined
    this.nestedPrefix = undefined; this.nestedPrefixBytes = 0
    this.coherentSubtrees.clear();this.coherentSubtreeBytes=0;this.coherentProofNodes=0
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
