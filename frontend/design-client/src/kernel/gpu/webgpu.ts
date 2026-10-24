import { captureDeviceDiagnosticRequest, deviceDiagnosticFields, registerDeviceDiagnosticOwner, recordDeviceLifecycle, recordDeviceDiagnostic, recordDeviceCallback, deviceLifecyclePhase, deviceLostReason } from './device-lifecycle-diagnostics'
import { markRenderFailure, renderFailureFields, withRenderFailureStage } from '../render-failure-telemetry'
import { recordGpuDiagnostic, gpuDiagnosticsEnabled } from '../../../../design-desktop/src/render-terminal-diagnostics.mjs'
import { QueueWaitStats, type QueueWaitReason } from './queue-wait-stats'
import { textureByteLength } from './texture-byte-length'
/// <reference types="@webgpu/types" />
import vectorShader from '../../../../../design-studio/crates/design-kernel/shaders/vector.wgsl?raw'
import { minifiedPreviewRgba8 } from './rgba8'
import samplingShader from '../../../../../design-studio/crates/design-kernel/shaders/sampling.wgsl?raw'
import { exactFilterWgsl, rationalStubWgsl } from './exact-filter'
import { exactFilterPacketLayout, exactFilterPacketTexels } from './exact-filter-packet-layout'
import { managedBackgroundEntryPoint, managedBackgroundWgsl } from './managed-background'
import { compositorModes } from './compositor-modes'
import { emptyManagedComposeScene } from './empty-scene-compose'
import { TexturePrefix, PREFIX_SCRATCH_BYTES } from './texture-prefix'
import { ByteTentPrefix, type ByteTentPrefixLease, planByteTentPrefix, type ByteTentOptions } from './byte-tent-prefix'
import { prefixModule } from './prefix-module'
import { PREFIX_MIN_RADIUS } from './prefix-band'
import { certifyPrefixRationalBound, prefixRationalBoundBits, type PrefixRationalBoundCertificate } from './prefix-preflight'
import { completeFilterAxisSupport } from './opaque-filter'
import { filterSourceWindowUniforms, snapshotFilterSourceWindow, type FilterSourceWindow } from './filter-source-window'
import { displayFilterWgsl, pairedDisplayFilterWgsl } from './display-filter'
import { displayArithmeticSource } from './display-arithmetic'
import { displayImageSource } from './display-image-source'
import { imageCoordinateSource } from './image-coordinate-source'
import { IMAGE_RESOLVE_STEP_MODE, imageResolveStepWgsl } from './image-resolve-step'
import { certifyExactImageRange, imageXTablePlanRange, type ExactImageRange, type ExactImageXTablePlan } from './exact-image-x-table'
import { ImageXTablePipeline, ImageXTableStorage } from './image-x-table-gpu'
import type { ExactImageTable } from './types'
import { scalarCoverageSource, SCALAR_COVERAGE_UNIFORM } from './scalar-coverage'
import { ResidentPresenter, type ResidentFrame } from './resident-presenter'
import { isDisplayBudgetError } from './display-budget'
import byteSamplingShader from '../../../../../design-studio/crates/design-kernel/shaders/byte-sampling.wgsl?raw'
import { areaShaderWgsl } from './area-shader'
import { sampleOnlyAreaShaderWgsl } from './sample-only-area-shader'
import { SampleOnlyAreaPrograms } from './sample-only-area-programs'
import type { Driver, Texture, PathMesh, Rect, GpuScene, GpuAdmissionDiagnostic } from './types'
import { parameters, previewUniforms, type PreviewPresentation } from './types'
import { MAX_SOLID_INSTANCES, SOLID_INSTANCE_FLOATS } from './solid-batch'
import { GpuBindingCache } from './binding-cache'
import { ResidentGeometry } from './resident-geometry'
import { ResidentPrograms, type ProgramPlan } from './resident-programs'
import { PipelineRegistry } from './pipeline-registry'
const maskShader = `struct Params{values:array<vec4<f32>,64>} @group(0) @binding(0) var<uniform> p:Params;
@vertex fn mesh(@location(0) point:vec2<f32>)->@builtin(position) vec4<f32>{return vec4<f32>((point.x-p.values[1].x)/p.values[0].z*2.-1.,1.-(point.y-p.values[1].y)/p.values[0].w*2.-1.,0.,1.);}
@vertex fn quad(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32>{return vec4<f32>(f32((i<<1u)&2u)*2.-1.,1.-f32(i&2u)*2.,0.,1.);}
@fragment fn white()->@location(0) vec4<f32>{return vec4<f32>(1);}`

/** Consecutive frames of ≥4× overprovision before a geometry buffer shrinks. */
const CAPACITY_SHRINK_FRAMES = 60
// A second bound in addition to the renderer's unchanged working-set budget.
// Count unique pinned sources conservatively even though their bytes already
// belong to the renderer ledger. Never accumulate an unlimited GPU backlog.
const IMAGE_RETIREMENT_BATCHES = 3
const IMAGE_RETIREMENT_BYTES = 64 * 1024 * 1024
type ImageTableRetirement = {
  tables: readonly ExactImageTable[]
  epoch: number
  complete: boolean
  error?: unknown
}
/** How long a parked driver keeps its (non-lost) device and compiled pipelines
 * between a dispose and the next matching create. Preview-tile budget recovery
 * disposes and immediately re-creates the whole GPU stack; parking lets that
 * re-entry reuse the device and pipelines instead of paying a full
 * adapter/device/pipeline rebuild. Idle entries are reaped so the memory
 * returns when no recovery follows (freeGPUMemoryForWorker semantics). */
const PARKED_REAP_MS = 30_000
function boundedDisplayRadius(radius: number, limit: number, channels = 15) {
  return Number.isFinite(limit) && limit > 0 && limit <= 32 && Number.isFinite(radius) &&
    radius > 0 && radius <= limit && channels === 15 && Math.ceil(Math.fround(radius)) === Math.ceil(radius)
}
function displayFilterPass(enabled: boolean, limit: number | undefined, prepared: boolean,
  u: Float32Array, channels: number, filter?: {kind: 'tent'; radius: number}) {
  if (!enabled || u[16] !== 22) return false
  if (limit === undefined) return true // Existing unbounded web display contract.
  // The rational and display coefficient textures have different layouts.
  // Keep the original radius, not just its rounded uniform, in the decision.
  return prepared && filter?.kind === 'tent' && Math.fround(filter.radius) === u[36] &&
    boundedDisplayRadius(filter.radius, limit, channels)
}
type ParkedDriver = {
  driver: WebGpuDriver
  key: string
  settled: Promise<void>
  reaper: ReturnType<typeof setTimeout>
}
export class WebGpuDriver implements Driver {
  private queueWaitStats = new QueueWaitStats(import.meta.env.VITE_DESIGN_QUEUE_WAIT_TIMING === '1')
  private submissionSequence = 0
  private completedSubmissionSequence = 0
  private fenceSequence = 0
  private submitTraceSkipped = 0
  private fenceTraceSkipped = 0
  private retirementTraceSequence = 0
  private retirementTraceSkipped = 0
  private submitQueue(command: GPUCommandBuffer) {
    this.queueWaitStats.submit(() => this.device.queue.submit([command]))
    this.submissionSequence = (this.submissionSequence || 0) + 1
    if (!gpuDiagnosticsEnabled()) return
    // Routine submissions are sampled; every slow/rejected completion below
    // still carries the frozen submission range and workload counters.
    if (this.submissionSequence % 32 !== 1) { this.submitTraceSkipped++; return }
    recordDeviceDiagnostic('gpu-submit', {
      ...captureDeviceDiagnosticRequest(), ...deviceDiagnosticFields(this),
      deviceSubmitSequence: this.submissionSequence, deviceSubmitTraceSkipped: this.submitTraceSkipped, resourceEpoch: this.resourceEpoch,
      drawCalls: this.drawCalls, opaqueTentPasses: this.opaqueTentPasses,
      deviceSubmitTableCount: this.imageTables?.size || 0,
      deviceSubmitTableWidthMax: [...(this.imageTables?.keys() || [])].reduce((max, table) => Math.max(max, table.width), 0),
      deviceSubmitTableHeightMax: [...(this.imageTables?.keys() || [])].reduce((max, table) => Math.max(max, table.height), 0),
      ...this.imageRetirementFields(),
    })
  }
  private waitForQueue(reason: QueueWaitReason, admission?: GpuAdmissionDiagnostic, asynchronous = false, geometryReason = 0) {
    const device = this.device, last = this.submissionSequence || 0
    const diagnosticIdentity = { ...captureDeviceDiagnosticRequest(), ...deviceDiagnosticFields(this),
      deviceFenceResourceEpoch: this.resourceEpoch, deviceFenceCompletedResourceEpoch: this.completedResourceEpoch,
      deviceFenceId: this.fenceSequence = (this.fenceSequence || 0) + 1,
      deviceFenceSubmitFirst: Math.min(last, (this.completedSubmissionSequence || 0) + 1), deviceFenceSubmitLast: last,
      deviceFenceAsync: Number(asynchronous), deviceFenceGeometryReason: geometryReason, deviceGpuTimingEnabled: Number(!!this.timingQueries),
      ...this.imageRetirementFields(),
      drawCalls: this.drawCalls, opaqueTentPasses: this.opaqueTentPasses,
      deviceSubmitTraceSkipped: this.submitTraceSkipped || 0,
      deviceSubmitTableCount: this.imageTables?.size || 0,
      deviceSubmitTableWidthMax: [...(this.imageTables?.keys() || [])].reduce((max, table) => Math.max(max, table.width), 0),
      deviceSubmitTableHeightMax: [...(this.imageTables?.keys() || [])].reduce((max, table) => Math.max(max, table.height), 0),
    }
    const sampled = diagnosticIdentity.deviceFenceId % 32 === 1
    const enabled = gpuDiagnosticsEnabled(), started = enabled ? performance.now() : 0
    const reasonCode = ['readback','timing','prefix-scratch','interaction','periodic','admission','checkpoint','cancel','initialization','park','image-table-scratch'].indexOf(reason)+1
    if (enabled && sampled) recordDeviceDiagnostic('fence', { ...admission, ...diagnosticIdentity, reasonCode, deviceFencePhase: 1, deviceFenceTraceSkipped: this.fenceTraceSkipped || 0 })
    // A background completion observation is not a blocking finish wait. Keep
    // it out of QueueWaitStats' cpu-queue-completion-wait totals/histogram.
    const pending = asynchronous ? (() => { try { return device.queue.onSubmittedWorkDone() } catch (error) { return Promise.reject(error) } })() :
      this.queueWaitStats.wait(reason, () => device.queue.onSubmittedWorkDone(), () => this.lost)
    const ended = (outcome: number) => {
      if (!enabled) return
      const elapsed = performance.now()-started
      if (!sampled && outcome === 1 && elapsed < 32) { this.fenceTraceSkipped++; return }
      recordDeviceDiagnostic('fence', { ...admission, ...diagnosticIdentity, reasonCode,
        deviceFenceTraceSkipped: this.fenceTraceSkipped || 0,
        deviceFencePhase: 2, deviceFenceOutcome: outcome, queueWaitMs: elapsed,
        deviceCompletedSubmitSequence: this.completedSubmissionSequence || 0,
        resourceEpoch: this.resourceEpoch, completedResourceEpoch: this.completedResourceEpoch })
    }
    return pending.then(() => {
      if (!this.lost && this.device === device) this.completedSubmissionSequence = Math.max(this.completedSubmissionSequence || 0, last)
      ended(this.lost ? 3 : 1)
    }, error => { ended(this.lost ? 3 : 2); throw markRenderFailure(error, { failureStage: 9 }) })
  }
  private bindingCache = new GpuBindingCache()
  // Rollout gate until real-device validation and timings are available. The
  // static-offset route remains an exact negative control for bisection.
  private dynamicUniformBindings = import.meta.env.VITE_DESIGN_DYNAMIC_UNIFORMS === '1'
  resourceEpoch = 0
  completedResourceEpoch = 0
  private rationalKernelBounds = new WeakMap<Texture, { packet: PrefixRationalBoundCertificate; resource: unknown; width: number; height: number }>()
  private pipelines = new PipelineRegistry()
  private readonly emptySceneComposeEnabled = import.meta.env.VITE_DESIGN_EMPTY_SCENE_COMPOSE === '1'
  private curveMirror = new ResidentGeometry()
  private vertexMirror = new ResidentGeometry()
  private geometryUploadBytes = 0
  private rasterReadbackBytes = 0
  private crossDeviceBitmaps = 0
  private residentCaptures = 0
  private programArena = new ResidentPrograms()
  private scenePrograms?: NonNullable<PathMesh['area']>[]
  private programOffsets?: Map<number,number>
  private programGpuValid = false
  private programArenaActive = false
  private preparedGeometryOwner?: {
    device: GPUDevice; generation: number; vertices?: GPUBuffer; curves?: GPUBuffer
  }
  private programHits = 0
  private programHitBytes = 0
  private readonly sampleOnlyCoverageEnabled = import.meta.env.VITE_DESIGN_SAMPLE_ONLY_COVERAGE === '1'
  private sampleOnlyRequested = false
  private sampleOnlyPrograms = new SampleOnlyAreaPrograms()
  private sampleOnlyPreparing?: Promise<void>
  private sampleOnlyUnavailable = false
  private sampleOnlyColorPipeline?: GPURenderPipeline
  private sampleOnlyBytePipeline?: GPURenderPipeline
  private sampleOnlyScalarPipeline?: GPURenderPipeline
  private sampleOnlyDispatch?: { target: Texture; uniform: Float32Array; buffer: GPUBuffer; epoch: number }
  private sampleOnlyCoveragePasses = 0
  private sampleOnlyCoveragePixels = 0
  private sampleOnlyCoverageLifetimePasses = 0
  private sampleOnlyCoverageLifetimePixels = 0
  private sampleOnlyCoverageEligibleScenes = 0
  captureDisplay = false
  private presenter?: ResidentPresenter
  private lifecycleFields() {
    const counters = this.presenter?.diagnosticFields()
    return { ...counters, ...deviceDiagnosticFields(this), deviceCounterMask: counters?.deviceCounterMask ?? 0 }
  }
  attachPresenter(canvas: OffscreenCanvas, report: (stats: Record<string, unknown>) => void) {
    if(this.presenter)this.presenter.attachCanvas(canvas)
    else this.presenter=new ResidentPresenter(this.device, canvas, this.format, report)
  }
  presentFrame(frame: ResidentFrame) { this.presenter?.draw(frame) }
  releasePresented(ids: number[]) { this.presenter?.release(ids) }
  replacePresented(slot:number,next:number){this.presenter?.replace(slot,next)}
  snapshotPresented(){return this.presenter?.snapshot()}
  async readContentPixel(u:number,v:number,expected?:import('../resident-presentation').ResidentAcknowledgement){if(!this.presenter)throw Error('No resident display');return this.presenter.readContentPixel(u,v,expected)}
  async captureContentBitmap(){if(!this.presenter)throw Error('No resident display');return this.presenter.captureContentBitmap()}
  importPresented(bitmap: ImageBitmap) {
    if (!this.presenter) { bitmap.close(); throw Error('No resident display') }
    return this.presenter.import(bitmap)
  }
  readonly supportsDisplayFilters = true
  readonly zeroTextureSampling = true
  readonly constantTextureSampling = true
  readonly sequentialSampleResolve = true
  readonly exactImageResolveStep = true
  // Scene intent is mutable; both arithmetic domains retain their own pipeline
  // on this device. A late compilation may populate the cache, never intent.
  private displayImageRequested = false
  private displayImageUnavailable = false
  private displayImageBaseSource?: string
  private displayImagePipeline?: GPURenderPipeline
  private displayImagePreparing?: Promise<void>
  displayImageSourcePasses = 0
  readonly scalarAlphaFilter = true
  readonly exactShadowOver = true
  private displayFilters = false
  private displayFilterRadiusLimit?: number
  private boundedDisplayFilterFailed = false
  boundedDisplayFilterPasses = 0
  private displayFilterPipeline?: GPURenderPipeline
  private pairedDisplay?: { pipeline: GPURenderPipeline; layout: GPUBindGroupLayout; sampler: GPUSampler }
  private pairDisplayTaps = true
  pairedFilterPasses = 0
  private pairedDisplayFailed = false
  private softwareRaster = false
  readonly name = 'webgpu' as const
  readonly exactSolidPaintOver = true
  readonly canvas = new OffscreenCanvas(1, 1)
  description = 'WebGPU'
  lost = false
  drawCalls = 0
  opaqueTentPasses = 0
  private mergedExactFilterPasses = 0
  triangles = 0
  commandSubmissions = 0
  private presentationSubmissions = 0
  // Queue-ordered resident display can reuse its bounded exact-filter scratch.
  // Explicit readback, timing, nonresident output and the negative control
  // retain their original per-frame completion boundary.
  private residentFilterScratch = import.meta.env.VITE_DESIGN_RESIDENT_FILTER_SCRATCH === '1'
  private prefixCounterSamples = 0
  private prefixCounterDeferredFrames = 0
  private interactionPresentation = false
  private nativeInteractionPresentation = false
  private prefix?: TexturePrefix
  private byteTent?: ByteTentPrefix
  private byteTentPreparing?: Promise<boolean>
  private byteTentLeases = new Map<ByteTentPrefixLease, { encoder: GPUCommandEncoder; submitted: boolean }>()
  private byteTentTextures = new WeakMap<Texture, { resource: GPUTexture; width: number; height: number; format: GPUTextureFormat }>()
  private byteTentRecordingFailed = false
  byteTentAlphaPasses = 0
  private prefixEnabled = false
  private frameScopeOpen = false
  private submittedBoundaryReady = false
  private submittedBoundaryGeneration = 0
  frameScratchBytes = 0
  /** Peak transient bytes the finish path itself allocated (presentation copy,
   * readback target and MAP_READ staging coexist at this peak). Frame-scoped:
   * begin() resets it. */
  finishTransientBytes = 0
  private imageRanges = new WeakMap<Texture, ExactImageRange>()
  private displayImageUploads = new WeakMap<Texture, { resource: GPUTexture; width: number; height: number; range: ExactImageRange }>()
  private imageAxisPrograms = new WeakMap<Texture, Float32Array>()
  private imageTablePipeline?: Promise<ImageXTablePipeline>
  private imageTables = new Map<ExactImageTable, {storage: ImageXTableStorage; pipeline: ImageXTablePipeline; image: Texture; opaqueAlpha: boolean; retired: boolean; retirement?: ImageTableRetirement}>()
  private imageTableRetirements: ImageTableRetirement[] = []
  private preparingImageTables = new Map<Texture, number>()
  usesDisplayFilter(radius: number, channels = 15): boolean {
    if (!this.managed || this.hdr || this.disposed || this.lost || !this.displayFilters || !this.displayFilterPipeline) return false
    return this.displayFilterRadiusLimit === undefined ? Number.isFinite(radius) && radius > 0 && radius <= 16384 :
      !this.displayMath && boundedDisplayRadius(radius, this.displayFilterRadiusLimit, channels)
  }
  usesDisplayImageSource(image: Texture): boolean {
    if (!this.displayImageRequested || this.displayImageUnavailable || !this.displayImagePipeline ||
        !this.managed || this.displayMath || this.hdr || this.disposed || this.lost) return false
    const range = this.imageTableRange(image)
    const upload = this.displayImageUploads.get(image), resource = image.resource as GPUTexture
    return !!range && !!upload && upload.range === range && upload.resource === resource &&
      upload.width === image.width && upload.height === image.height && resource.width === upload.width &&
      resource.height === upload.height && resource.format === 'rgba32float' && range.nonnegativeRgb &&
      range.opaqueAlpha && range.maximum.every(value => value <= 127)
  }
  get scratchBytes(){ return (this.prefix?.scratchBytes || 0) + [...(this.imageTables?.keys() || [])].reduce((sum,table)=>sum+table.bytes,0) +
    [...(this.byteTentLeases?.keys() || [])].reduce((sum,lease)=>sum+lease.bytes,0) }
  get retiredImageTableBytes() {
    let bytes = 0
    for (const [table, entry] of this.imageTables) if (entry.retired) bytes += table.bytes
    return bytes
  }
  imageTableRange(image: Texture) { return image.finitePixels === true && this.textures.has(image) ? this.imageRanges.get(image) : undefined }
  imageTableAxes(field: Texture) { return field.finitePixels === true && this.textures.has(field) ? this.imageAxisPrograms.get(field)?.slice() : undefined }
  hasActiveImageTableSource(image: Texture) {
    return this.preparingImageTables.has(image) || [...this.imageTables.values()].some(entry => entry.image === image)
  }
  private imageRetirementFields() {
    let bytes = 0
    const sources = new Set<Texture>()
    for (const [table, entry] of this.imageTables || []) if (entry.retired) { bytes += table.bytes; sources.add(entry.image) }
    return { deviceRetirementBatchCount: this.imageTableRetirements?.length || 0,
      deviceRetiringScratchBytes: bytes,
      deviceRetiringSourceBytes: [...sources].reduce((sum, source) => sum + source.bytes, 0) }
  }
  /** The callback only certifies a frozen snapshot; collection is synchronous
   * inside the renderer's scratch-delta accounting boundary, never in a microtask. */
  collectCompletedImageTables() {
    const batches = this.imageTableRetirements || []
    const failed = batches.find(batch => batch.error !== undefined)
    if (failed) throw failed.error
    for (const batch of [...batches]) if (batch.complete) this.collectRetiredImageTables(batch.tables, 1)
  }
  private canDeferImageTables() {
    const fields = this.imageRetirementFields()
    return fields.deviceRetirementBatchCount < IMAGE_RETIREMENT_BATCHES &&
      fields.deviceRetiringScratchBytes + fields.deviceRetiringSourceBytes <= IMAGE_RETIREMENT_BYTES
  }
  private deferImageTables(tables: readonly ExactImageTable[]) {
    const snapshot = tables.filter(table => !this.imageTables.get(table)?.retirement)
    if (!snapshot.length) return
    const batch: ImageTableRetirement = { tables: snapshot, epoch: this.resourceEpoch, complete: false }
    this.imageTableRetirements.push(batch)
    for (const table of snapshot) this.imageTables.get(table)!.retirement = batch
    const device = this.device
    const valid = () => this.device === device && this.imageTableRetirements.includes(batch)
    // Capture the fence NOW, directly after this submission, not in a later
    // microtask after a following frame may have submitted more commands.
    void this.waitForQueue('image-table-scratch', undefined, true).then(() => {
      if (!valid()) return
      if (this.lost) { batch.error = new Error('GPU 设备已丢失'); return }
      batch.complete = true
      this.completedResourceEpoch = Math.max(this.completedResourceEpoch, batch.epoch)
    }, error => { if (valid()) batch.error = error ?? new Error('GPU queue completion rejected') })
  }
  private releaseImageTables() {
    if (this.imageTables?.size && gpuDiagnosticsEnabled()) recordDeviceDiagnostic('gpu-retirement', {
      ...captureDeviceDiagnosticRequest(), ...deviceDiagnosticFields(this), ...this.imageRetirementFields(),
      deviceRetirementPhase: 3, deviceRetirementTableCount: this.imageTables.size,
      deviceRetirementReleasedBytes: [...this.imageTables.keys()].reduce((sum, table) => sum + table.bytes, 0),
      resourceEpoch: this.resourceEpoch, completedResourceEpoch: this.completedResourceEpoch,
    })
    this.imageTableRetirements = []
    for(const entry of this.imageTables?.values() || [])entry.storage.destroy()
    this.imageTables?.clear()
  }
  /** Freeze only the logical retirements covered by the caller's next real
   * completion boundary. Finish may close every remaining table first. */
  private retiredImageTableSnapshot(includeActive = false): ExactImageTable[] {
    const snapshot: ExactImageTable[] = []
    for (const [table, entry] of this.imageTables) {
      if (includeActive) entry.retired = true
      if (entry.retired) snapshot.push(table)
    }
    return snapshot
  }
  /** Call only after submitted references in this snapshot actually completed.
   * A later retirement is not covered by an earlier queue-completion promise. */
  private collectRetiredImageTables(snapshot: readonly ExactImageTable[], phase = 2): void {
    let count = 0, bytes = 0
    for (const table of snapshot) {
      const entry = this.imageTables.get(table)
      if (!entry?.retired) continue
      entry.storage.destroy()
      count++; bytes += table.bytes
      this.imageTables.delete(table)
    }
    this.imageTableRetirements = (this.imageTableRetirements || []).filter(batch => batch.tables.some(table => this.imageTables.has(table)))
    if (!count || !gpuDiagnosticsEnabled()) return
    this.retirementTraceSequence = (this.retirementTraceSequence || 0) + 1
    if (bytes < 48 * 1024 * 1024 && this.retirementTraceSequence % 32 !== 1) { this.retirementTraceSkipped++; return }
    recordDeviceDiagnostic('gpu-retirement', {
      ...captureDeviceDiagnosticRequest(), ...deviceDiagnosticFields(this), ...this.imageRetirementFields(),
      deviceRetirementPhase: phase, deviceRetirementTraceSkipped: this.retirementTraceSkipped || 0, deviceRetirementTableCount: count, deviceRetirementReleasedBytes: bytes,
      resourceEpoch: this.resourceEpoch, completedResourceEpoch: this.completedResourceEpoch,
    })
  }
  async prepareImageTable(image: Texture, plan: ExactImageXTablePlan, availableBytes: number): Promise<ExactImageTable | undefined> {
    const range=this.imageTableRange(image)
    const bytes=256+plan.tableBytes+plan.x.byteLength+plan.y.byteLength
    if(import.meta.env.VITE_DESIGN_EXACT_IMAGE_X_TABLE === '0' || !this.managed || this.displayMath ||
        !range || imageXTablePlanRange(plan)!==range || plan.uniform.length!==20 ||
        plan.uniform[4]!==image.width || plan.uniform[5]!==image.height ||
        plan.uniform[7]!==Number(range.opaqueAlpha) ||
        range.minimum.some((value,index)=>plan.uniform[8+index]!==value) ||
        !Number.isSafeInteger(bytes) || !Number.isSafeInteger(availableBytes) || availableBytes<0 || bytes>availableBytes) return
    // Pipeline compilation can yield. Freeze the admitted inputs before that
    // boundary; later caller writes cannot change the uploaded table program.
    const captured={...plan,x:plan.x.slice(),y:plan.y.slice(),uniform:plan.uniform.slice()}
    this.preparingImageTables.set(image,(this.preparingImageTables.get(image)||0)+1)
    try {
    const pipeline=await (this.imageTablePipeline ??= ImageXTablePipeline.create(this.device))
    if(this.disposed || this.lost || this.imageTableRange(image)!==range)throw Error('Image interpolation source retired')
    const storage=new ImageXTableStorage(this.device,captured)
    const handle:ExactImageTable=Object.freeze({resource:Object.freeze({}),width:storage.width,height:storage.height,bytes:storage.bytes,
      ...(range.opaqueAlpha?{opaqueAlpha:true as const}:{}),
      ...(range.nonnegativeRgb?{nonnegativeResolved:true as const}:{})})
    this.imageTables.set(handle,{storage,pipeline,image,opaqueAlpha:range.opaqueAlpha,retired:false})
    this.frameScratchBytes=Math.max(this.frameScratchBytes,this.scratchBytes)
    this.closeOver()
    pipeline.encodeBuild(this.encoder,image.resource as GPUTexture,storage,this.timingQueries ?
      this.timestampWrites({ stage:'image-x-table-build', mode:51, radius:0, width:storage.width, height:captured.rowCount, channel:captured.xSampleCount }) : undefined)
    return handle
    } finally {
      const remaining=(this.preparingImageTables.get(image)||1)-1
      if(remaining)this.preparingImageTables.set(image,remaining)
      else this.preparingImageTables.delete(image)
    }
  }
  resolveImageTable(target: Texture, table: ExactImageTable, offsetX: number, offsetY: number) {
    const entry=this.imageTables.get(table)
    if(!entry || entry.retired || !this.imageTableRange(entry.image) || !this.textures.has(target) || target.resource===entry.image.resource ||
        (target.resource as GPUTexture).format!=='rgba32float' ||
        ![offsetX,offsetY].every(Number.isSafeInteger) || offsetX<0 || offsetY<0 ||
        offsetX+target.width>table.width || offsetY+target.height>table.height)
      throw Error('Invalid exact image table window')
    this.invalidateTextureCertificates(target);delete target.uniformColor;delete target.transparentZero
    this.closeOver()
    const words=new Uint32Array(256);words.set(entry.storage.config)
    words.set([offsetX,offsetY,target.width,target.height],12)
    const binding=this.uniformWords(words)
    entry.pipeline.encodeResolve(this.encoder,target.resource as GPUTexture,entry.storage,binding,this.timingQueries ?
      this.timestampWrites({ stage:'image-x-table-resolve', mode:51, radius:0, width:target.width, height:target.height }) : undefined)
    this.drawCalls++
    if(entry.opaqueAlpha)target.opaqueAlpha=true
  }
  async retireImageTable(table: ExactImageTable) {
    const entry=this.imageTables.get(table);if(!entry)return
    // End sampling immediately, but keep the buffers, source pin and ledger
    // until a later real completion boundary covers their queued reads.
    entry.retired = true
  }
  private device!: GPUDevice
  private context!: GPUCanvasContext
  private format!: GPUTextureFormat
  private layout!: GPUBindGroupLayout
  private maskLayout!: GPUBindGroupLayout
  private paintPipeline!: GPURenderPipeline
  private compositorModule!: GPUShaderModule
  private modePipelines = new Map<number, GPURenderPipeline>()
  private filterPipelines: GPURenderPipeline[] = []
  private normalPipeline?: GPURenderPipeline
  private solidPaintOverPipeline?: GPURenderPipeline
  private resolveStepPipeline?: GPURenderPipeline
  private imageResolveStepPipeline?: GPURenderPipeline
  private scalarFilterPipeline?: GPURenderPipeline
  private alphaResolvePipeline?: GPURenderPipeline
  private shadowOverPipeline?: GPURenderPipeline
  private normalCornerPipeline?: GPURenderPipeline
  private copyCornerPipeline?: GPURenderPipeline
  private copyPipeline?: GPURenderPipeline
  private areaPipeline?: GPURenderPipeline
  private binaryAreaPipeline?: GPURenderPipeline
  private scalarAreaPipeline?: GPURenderPipeline
  private scalarPipelines = new Map<number, GPURenderPipeline>()
  private binaryPipelines = new Map<number, GPURenderPipeline>()
  private overPipeline!: GPURenderPipeline
  private solidPipeline!: GPURenderPipeline
  private solidLayout!: GPUBindGroupLayout
  private solidBuffer?: GPUBuffer
  private solidBind?: GPUBindGroup
  private solidData = new Float32Array(MAX_SOLID_INSTANCES * SOLID_INSTANCE_FLOATS)
  private solidOffset = 0
  private solidUploaded = 0
  private solidRanges = new Map<Float32Array, number>()
  private presentPipeline!: GPURenderPipeline
  private maskPipelines = new Map<string, GPURenderPipeline>()
  private coverPipelines = new Map<string, GPURenderPipeline>()
  private uniforms!: GPUBuffer
  private vertices?: GPUBuffer
  private curves?: GPUBuffer
  private curveCapacity = 0
  private vertexCapacity = 0
  /** Consecutive low-demand frames and the window's peak demand per buffer,
   * feeding the capacity shrink in finish(). */
  private vertexShrink = { frames: 0, maxDemand: 0 }
  private curveShrink = { frames: 0, maxDemand: 0 }
  private initialized = false
  private parkedForReuse = false
  private poolKey?: string
  private static parkedDriver?: ParkedDriver
  private offset = 0
  private uploadedOffset = 0
  private uniformCommands = 0
  private uniformData = new Float32Array(1024 * 1024)
  private timingQueries?: GPUQuerySet
  private passTimings?: { mode: number; radius: number; width: number; height: number; count: number; ms: number }[]
  private timingRows: { mode: number; radius: number; width: number; height: number; blend?: number; paint?: number; integerCentres?: boolean; stage?: string; channel?: number }[] = []
  private timingSkipped = 0
  private encoder!: GPUCommandEncoder
  private activeOver?: GPURenderPassEncoder
  private activeTarget?: Texture
  private blank!: Texture
  private textures = new Set<Texture>()
  private replayParameterTextures = new Set<Texture>()
  private transient: GPUTexture[] = []
  private transientTargets: Texture[] = []
  private transientBytes = 0
  private msaa = new Map<
    string,
    { color: GPUTexture; depth: GPUTexture; high: Texture; low: Texture }
  >()
  private disposed = false
  // Irreversible device ownership, unlike disposed during reusable park.
  // This fence covers binary/scalar publication only, not all async GPU work.
  private terminal = false
  private assertPipelinePublicationOwner(device: GPUDevice) {
    if (this.terminal || this.device !== device) throw new Error('WebGPU 设备已丢失')
  }
  private errors: string[] = []
  constructor(
    readonly managed = false,
    public hdr = false,
    readonly linearLight = managed,
    readonly certifiedFilter = managed,
    readonly displayMath = false,
  ) {}
  private get layerFormat(): GPUTextureFormat {
    return this.managed ? 'rgba32float' : 'rgba8unorm'
  }
  static async create(managed = false, hdr = false, linearLight = managed, certified = true, displayMath = false) {
    displayMath = displayMath && managed && !hdr
    const poolKey = JSON.stringify([managed, hdr, linearLight, certified, displayMath])
    const revived = await WebGpuDriver.reviveParked(poolKey)
    if (revived) {
      revived.prefixEnabled = managed && certified && import.meta.env.VITE_DESIGN_EXACT_PREFIX !== '0'
      return revived
    }
    const driver = new WebGpuDriver(managed, hdr, linearLight, managed && certified && import.meta.env.VITE_DESIGN_CERTIFIED_FILTER !== '0', displayMath)
    try {
      await driver.initialize()
      if (driver.terminal) throw new Error('WebGPU 设备已丢失')
      driver.poolKey = poolKey
      driver.prefixEnabled = managed && certified && import.meta.env.VITE_DESIGN_EXACT_PREFIX !== '0'
      return driver
    } catch (e) {
      driver.dispose()
      throw e
    }
  }
  /** Serve a parked (non-lost, matching-config) driver to the next create so
   * budget-failure recovery reuses its device and compiled pipelines; anything
   * else (lost device, config mismatch, revive failure) falls through to the
   * existing full rebuild. */
  private static async reviveParked(key: string): Promise<WebGpuDriver | undefined> {
    const parked = WebGpuDriver.parkedDriver
    if (!parked) return undefined
    WebGpuDriver.parkedDriver = undefined
    clearTimeout(parked.reaper)
    try {
      await parked.settled
    } catch (error) {
      console.debug(`DESIGN_GPU_PARK ${JSON.stringify({ event: 'park-cleanup-failed', error: String(error) })}`)
      parked.driver.destroyDeviceNow()
      return undefined
    }
    const terminated = parked.driver.terminal || parked.driver.lost
    if (terminated || parked.key !== key) {
      const configBits=(value:string)=>{try{return (JSON.parse(value) as boolean[]).reduce((bits,v,i)=>bits|(v?1<<i:0),0)}catch{return -1}}
      recordGpuDiagnostic('cache',{reasonCode:terminated?2:1,oldConfig:configBits(parked.key),newConfig:configBits(key)})
      console.debug(`DESIGN_GPU_PARK ${JSON.stringify({
        event: 'discarded', reason: terminated ? 'device-lost' : 'config-mismatch',
      })}`)
      parked.driver.destroyDeviceNow()
      return undefined
    }
    try {
      recordDeviceLifecycle(parked.driver, deviceLifecyclePhase.reviveStart, parked.driver.lifecycleFields())
      await parked.driver.revive()
      // Loss may be observed while the existing revive queue fence is pending.
      // Never return a terminal pooled owner; this is not a global ready fence.
      if (parked.driver.terminal) throw new Error('WebGPU 设备已丢失')
      recordDeviceLifecycle(parked.driver, deviceLifecyclePhase.reviveReady, parked.driver.lifecycleFields())
      console.debug(`DESIGN_GPU_PARK ${JSON.stringify({ event: 'revived', key })}`)
      return parked.driver
    } catch (error) {
      recordDeviceLifecycle(parked.driver, deviceLifecyclePhase.reviveFailed, parked.driver.lifecycleFields())
      console.debug(`DESIGN_GPU_PARK ${JSON.stringify({ event: 'revive-failed', error: String(error) })}`)
      parked.driver.destroyDeviceNow()
      return undefined
    }
  }
  private async initialize() {
    if (!navigator.gpu) throw new Error('浏览器未提供 WebGPU')
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
      .catch(error => { throw new Error(`GPU_UNAVAILABLE: ${String(error)}`, { cause: error }) })
    if (!adapter) throw new Error('没有可用的 WebGPU 适配器')
    // Explicit profiling builds only; normal development/release builds do not
    // request timestamps or change their pass ordering.
    const timing = import.meta.env.VITE_DESIGN_GPU_TIMINGS === '1'
    if (timing && !adapter.features.has('timestamp-query')) throw new Error('GPU timestamp queries unavailable')
    const requiredFeatures: GPUFeatureName[] = timing ? ['timestamp-query'] : []
    if (adapter.features.has('float32-filterable')) requiredFeatures.push('float32-filterable')
    this.device = await adapter.requestDevice({ requiredFeatures })
      .catch(error => { throw new Error(`GPU_UNAVAILABLE: ${String(error)}`, { cause: error }) })
    if (this.dynamicUniformBindings) {
      const alignment = this.device.limits.minUniformBufferOffsetAlignment
      if (!Number.isInteger(alignment) || alignment < 1 || 1024 % alignment !== 0)
        throw new Error('WebGPU dynamic uniform alignment does not support the exact 1024-byte stride')
    }
    const diagnosticIdentity = registerDeviceDiagnosticOwner(this, this.device, 1)
    recordDeviceLifecycle(this, deviceLifecyclePhase.created, { deviceCounterMask: 0 })
    if (timing) this.timingQueries = this.device.createQuerySet({ type: 'timestamp', count: 4096 })
    this.description = adapter.info?.description || adapter.info?.architecture || 'WebGPU'
    this.device.lost.then((info) => {
      this.terminal = true
      // Intentional teardown (dispose/reaper) has nothing further to report.
      const fields = { ...this.lifecycleFields(), deviceLostReason: deviceLostReason(info.reason) }
      if (info.reason === 'destroyed' && this.disposed) {
        recordDeviceCallback(this, diagnosticIdentity, deviceLifecyclePhase.callbackDiscarded, { ...fields, deviceCallbackDisposition: 2 })
        return
      }
      this.lost = true
      this.submittedBoundaryReady = false; this.submittedBoundaryGeneration++
      if (this.disposed) {
        recordDeviceCallback(this, diagnosticIdentity, deviceLifecyclePhase.callbackDiscarded, { ...fields, deviceCallbackDisposition: 3 })
        return
      }
      recordDeviceCallback(this, diagnosticIdentity, deviceLifecyclePhase.lost, { ...fields, deviceCallbackDisposition: 1 })
      this.presenter?.lost(info.message || 'device lost')
      this.errors.push(info.message || 'GPU device lost')
      // freeGpuMemory semantics: reclaim every pooled texture/buffer/querySet
      // immediately instead of waiting for the next request to dispose. Every
      // destroy() on a lost device is a safe no-op, so this races nothing.
      this.releaseLostResources()
    })
    this.device.addEventListener('uncapturederror', (e) => this.errors.push(e.error.message))
    this.context = this.canvas.getContext('webgpu')!
    if (!this.context) throw new Error('WebGPU Canvas 不可用')
    this.format = this.linearLight && this.hdr ? 'rgba16float' : navigator.gpu.getPreferredCanvasFormat()
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'premultiplied',
      colorSpace: 'srgb',
      toneMapping: { mode: this.hdr ? 'extended' : 'standard' },
    })
    this.hdr = this.hdr && this.context.getConfiguration()?.toneMapping?.mode === 'extended'
    const paintEntryPoint = managedBackgroundEntryPoint(this.managed, this.displayMath, import.meta.env.VITE_DESIGN_MANAGED_MODE12_ENTRY)
    const compositorCode =
        `const BYTE_SURFACE:bool=${!this.managed};\n` +
        (this.managed
          ? samplingShader + '\n' + rationalStubWgsl
          : byteSamplingShader +
            '\nfn rationalBlur(point:vec2<f32>,axis:vec2<f32>)->vec4<f32>{return vec4<f32>(0);}' + '\nfn bsCorner4(a:vec4<f32>,b:vec4<f32>,c:vec4<f32>,d:vec4<f32>)->vec4<f32>{return a;}') +
        '\n' +
        vectorShader + (paintEntryPoint === 'managedBackgroundFragment' ? managedBackgroundWgsl : '') + `
@fragment fn exactPresent(@builtin(position) p:vec4<f32>)->@location(0) vec4<f32>{
 let value=smp(sourceA,p.xy+u(0).xy,u(1));
 if(u(60).z>0.5){return displayColor(value);}
 if(u(61).x>0.5){return analyticDisplayColor(value);}
 if(u(60).x<0.5){return round(clamp(value,vec4<f32>(0),vec4<f32>(1))*255.)/255.;}
 return value;
}
fn integerSample(tex:texture_2d<f32>,p:vec2<f32>,r:vec4<f32>)->vec4<f32>{
 return bsCorner4(at(tex,p,r),at(tex,p+vec2<f32>(1,0),r),at(tex,p+vec2<f32>(0,1),r),at(tex,p+vec2<f32>(1,1),r));
}
@fragment fn exactCopyCorner(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{return integerSample(sourceA,position.xy+u(0).xy,u(1));}
@fragment fn exactResolveStep(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{
 let p=position.xy+u(0).xy;let quarter=mulRN4(at(sourceA,p,u(1)),vec4<f32>(0.25));
 if(u(4).y==0.){return quarter;}
 return addRN4(at(sourceB,p,u(2)),quarter);
}
@fragment fn exactAlphaResolve(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{
 let p=position.xy+u(0).xy;
 return vec4<f32>(meanFourRN(at(sourceA,p,u(1)),at(sourceB,p,u(2)),at(sourceC,p,u(3)),at(sourceD,p,u(1))).a);
}
fn exactShadowValue(p:vec2<f32>)->vec4<f32>{
 if(any(p<u(0).xy)||any(p>=u(0).xy+u(0).zw)){return vec4<f32>(0);}
 let a=smp(sourceA,p,u(1));let b=smp(sourceB,p-u(9).yz,u(2)).a;
 let coverage=select(b,mulRN(a.a,addRN(1.,-b)),u(9).w>0.5);
 return mulRN4(mulRN4(vec4<f32>(u(7).yzw,1.),vec4<f32>(u(8).x)),vec4<f32>(coverage));
}
@fragment fn exactShadowOver(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{
 let p=position.xy+u(0).xy;let plane=integerSample(sourceA,p,u(1));
 // Preserve the former texture's integer-centre sampling, including neighbour
 // NaN propagation and zero canonicalization, before the same normal blend.
 let shadow=bsCorner4(exactShadowValue(p),exactShadowValue(p+vec2<f32>(1,0)),exactShadowValue(p+vec2<f32>(0,1)),exactShadowValue(p+vec2<f32>(1,1)));
 if(u(9).w>0.5){return over(plane,mulRN4(shadow,vec4<f32>(1)),0);}
 return over(shadow,mulRN4(plane,vec4<f32>(1)),0);
}
@fragment fn exactNormalCorner(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{
 let p=position.xy+u(0).xy;let a=integerSample(sourceA,p,u(1));var opacity=u(4).z;
 if(u(4).w>0.5){opacity=mulRN(opacity,at(sourceC,p,u(3)).a);}
 let src=mulRN4(a,vec4<f32>(opacity));let dst=integerSample(sourceB,p,u(2));
 if(src.a<=0.){return dst;}if(dst.a<=0.){return src;}
 return addRN4(src,mulRN4(dst,vec4<f32>(addRN(1.,-src.a))));
}
@fragment fn exactSolidPaintOver(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{
 let p=position.xy+u(0).xy;let dst=integerSample(sourceA,p,u(1));
 if(any(p<u(13).xy)||any(p>=u(13).xy+u(13).zw)){return dst;}
 let paint=mulRN4(mulRN4(vec4<f32>(u(7).yzw,1.),vec4<f32>(u(60).y)),vec4<f32>(u(8).x));
 let covered=mulRN4(paint,vec4<f32>(at(sourceB,p,u(2)).a));
 let bits=bitcast<vec4<u32>>(covered);
 let sampled=bitcast<vec4<f32>>(select(bits,vec4<u32>(0),(bits&vec4<u32>(0x7fffffffu))==vec4<u32>(0)));
 var opacity=1.;if(u(4).w>0.5){opacity=mulRN(opacity,at(sourceC,p,u(3)).a);}
 return over(dst,mulRN4(sampled,vec4<f32>(opacity)),0);
}
@fragment fn exactNormal(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{
 let p=position.xy+u(0).xy;let a=smp(sourceA,p,u(1));var opacity=u(4).z;
 if(u(4).w>0.5){opacity=mulRN(opacity,at(sourceC,p,u(3)).a);}
 let src=mulRN4(a,vec4<f32>(opacity));let dst=smp(sourceB,p,u(2));
 if(src.a<=0.){return dst;}if(dst.a<=0.){return src;}
 return addRN4(src,mulRN4(dst,vec4<f32>(addRN(1.,-src.a))));
}`
    const addressedCode = this.managed ? scalarCoverageSource(imageCoordinateSource(compositorCode + imageResolveStepWgsl)) : compositorCode
    if (this.managed && !this.displayMath && !this.hdr) this.displayImageBaseSource = addressedCode
    const module = this.device.createShaderModule({
      code: this.displayMath ? displayArithmeticSource(addressedCode, import.meta.env.VITE_DESIGN_NATIVE_DIVISION !== '0') : addressedCode,
      label: 'Self-developed vector compositor',
    })
    this.compositorModule = module
    const mask = this.device.createShaderModule({ code: maskShader, label: 'Stencil and cover' })
    for (const m of [module, mask]) {
      const info = await m.getCompilationInfo()
      const errors = info.messages.filter((m) => m.type === 'error')
      if (errors.length) throw new Error(errors.map((e) => `${e.lineNum}:${e.message}`).join('\n'))
    }
    this.layout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX,
          buffer: { type: 'uniform', minBindingSize: 1024, hasDynamicOffset: this.dynamicUniformBindings },
        },
        ...[1, 2, 3, 5].map((binding) => ({
          binding,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float' as const },
        })),
        {
          binding: 4,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage', minBindingSize: 16 },
        },
      ],
    })
    this.maskLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform', minBindingSize: 1024 },
        },
      ],
    })
    const layout = this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      maskLayout = this.device.createPipelineLayout({ bindGroupLayouts: [this.maskLayout] })
    // Compile independent programs together. Publication is fenced to the
    // same live device; failure does not claim that other jobs have drained.
    const register = (key: string, build: () => Promise<void>) => this.pipelines.register(key, build)
    register('paint', async () => {
    this.paintPipeline = await this.device.createRenderPipelineAsync({
      layout,
      vertex: { module, entryPoint: 'quad' },
      fragment: { module, entryPoint: paintEntryPoint, ...(this.managed ? { constants: { COMPOSITOR_MODE: 12 } } : {}), targets: [{ format: this.layerFormat }] },
      primitive: { topology: 'triangle-list' },
    })
    if (this.managed) this.modePipelines.set(12, this.paintPipeline)
    })
    register('area', async () => {
      const areaModule = this.device.createShaderModule({ code: areaShaderWgsl })
      const errors = (await areaModule.getCompilationInfo()).messages.filter(
        (m) => m.type === 'error',
      )
      if (errors.length) throw new Error(errors.map((m) => `${m.lineNum}:${m.message}`).join('\n'))
      this.areaPipeline = await this.device.createRenderPipelineAsync({
        layout,
        vertex: { module: areaModule, entryPoint: 'areaQuad' },
        fragment: {
          module: areaModule,
          entryPoint: 'areaFragment',
          targets: [{ format: this.layerFormat }],
        },
        primitive: { topology: 'triangle-list' },
      })
      if (this.managed) this.binaryAreaPipeline = await this.device.createRenderPipelineAsync({
        layout, vertex: { module: areaModule, entryPoint: 'areaQuad' },
        fragment: { module: areaModule, entryPoint: 'areaFragment', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' },
      })
      if (this.managed) this.scalarAreaPipeline = await this.device.createRenderPipelineAsync({
        layout, vertex:{module:areaModule,entryPoint:'areaQuad'},
        fragment:{module:areaModule,entryPoint:'areaFragment',targets:[{format:'r32float'}]},primitive:{topology:'triangle-list'},
      })
    })
    if (this.managed) register('binary', () => {
      const device = this.device
      const jobs = [12, 20].map(async (mode) => {
      this.assertPipelinePublicationOwner(device)
      const pipeline = await device.createRenderPipelineAsync({ layout,
        vertex: { module, entryPoint: 'quad' },
        fragment: { module, entryPoint: 'fragment', constants: { COMPOSITOR_MODE: mode }, targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' },
      })
      this.assertPipelinePublicationOwner(device)
      this.binaryPipelines.set(mode, pipeline)
      })
      return Promise.all(jobs).then(() => {})
    })
    if(this.managed)register('scalar', () => {
      const device = this.device
      const jobs = [12,17,20].map(async mode=>{
      this.assertPipelinePublicationOwner(device)
      const pipeline = await device.createRenderPipelineAsync({layout,
        vertex:{module,entryPoint:'quad'},fragment:{module,entryPoint:'fragment',constants:{COMPOSITOR_MODE:mode},targets:[{format:'r32float'}]},
        primitive:{topology:'triangle-list'}})
      this.assertPipelinePublicationOwner(device)
      this.scalarPipelines.set(mode, pipeline)
      })
      return Promise.all(jobs).then(() => {})
    })
    register('present', async () => {
    this.presentPipeline = await this.device.createRenderPipelineAsync({
      layout,
      vertex: { module, entryPoint: 'quad' },
      fragment: { module, entryPoint: 'exactPresent', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    })
    })
    if (this.managed && this.emptySceneComposeEnabled) this.registerManagedComposePipelines(layout, module)
    else register('compose', async () => {
    if (this.managed) {
      const make = (entryPoint: string) => this.device.createRenderPipelineAsync({ layout,
        vertex: { module, entryPoint: 'quad' }, fragment: { module, entryPoint, targets: [{ format: this.layerFormat }] },
        primitive: { topology: 'triangle-list' } })
      ;[this.normalPipeline, this.copyPipeline, this.normalCornerPipeline, this.copyCornerPipeline, this.solidPaintOverPipeline, this.resolveStepPipeline, this.shadowOverPipeline, this.imageResolveStepPipeline] = await Promise.all([make('exactNormal'), make('exactPresent'), make('exactNormalCorner'), make('exactCopyCorner'), make('exactSolidPaintOver'), make('exactResolveStep'), make('exactShadowOver'), make('exactImageResolveStep')])
      this.alphaResolvePipeline = await this.device.createRenderPipelineAsync({ layout,
        vertex: { module, entryPoint: 'quad' }, fragment: { module, entryPoint: 'exactAlphaResolve', targets: [{ format: 'r32float' }] },
        primitive: { topology: 'triangle-list' } })
    }
    if (this.managed) this.overPipeline = this.normalPipeline!
    else {
    this.overPipeline = await this.device.createRenderPipelineAsync({
      layout,
      vertex: { module, entryPoint: 'quad' },
      fragment: {
        module,
        entryPoint: 'fragment',
        ...(this.managed ? { constants: { COMPOSITOR_MODE: 3 } } : {}),
        targets: [
          {
            format: this.layerFormat,
            blend: this.managed
              ? undefined
              : {
                  color: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                  alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    })
    }
    })
    this.solidLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage', minBindingSize: 80 },
        },
      ],
    })
    register('solid', async () => {
    this.solidPipeline = await this.device.createRenderPipelineAsync({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.layout, this.solidLayout],
      }),
      vertex: { module, entryPoint: 'solidQuad' },
      fragment: { module, entryPoint: 'solidFragment', targets: [{ format: this.layerFormat }] },
      primitive: { topology: 'triangle-list' },
    })
    })
    for (const rule of this.managed ? [] : ['evenodd', 'nonzero', 'union']) register(`mask:${rule}`, async () => {
      const op: GPUStencilOperation =
        rule === 'evenodd' ? 'invert' : rule === 'union' ? 'replace' : 'increment-wrap'
      const readMask = rule === 'evenodd' ? 1 : 255
      this.maskPipelines.set(
        rule,
        await this.device.createRenderPipelineAsync({
          layout: maskLayout,
          vertex: {
            module: mask,
            entryPoint: 'mesh',
            buffers: [
              {
                arrayStride: 8,
                attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
              },
            ],
          },
          fragment: {
            module: mask,
            entryPoint: 'white',
            targets: [{ format: this.layerFormat, writeMask: 0 }],
          },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          multisample: { count: 4 },
          depthStencil: {
            format: 'depth24plus-stencil8',
            depthWriteEnabled: false,
            depthCompare: 'always',
            stencilFront: { compare: 'always', passOp: op },
            stencilBack: { compare: 'always', passOp: rule === 'nonzero' ? 'decrement-wrap' : op },
            stencilReadMask: readMask,
            stencilWriteMask: readMask,
          },
        }),
      )
      this.coverPipelines.set(
        rule,
        await this.device.createRenderPipelineAsync({
          layout: maskLayout,
          vertex: { module: mask, entryPoint: 'quad' },
          fragment: { module: mask, entryPoint: 'white', targets: [{ format: this.layerFormat }] },
          primitive: { topology: 'triangle-list' },
          multisample: { count: 4 },
          depthStencil: {
            format: 'depth24plus-stencil8',
            depthWriteEnabled: false,
            depthCompare: 'always',
            stencilFront: { compare: 'not-equal' },
            stencilBack: { compare: 'not-equal' },
            stencilReadMask: readMask,
            stencilWriteMask: 0,
          },
        }),
      )
    })
    // Only programs required even for an empty viewport block device readiness.
    // All other exact programs are admitted from the compiled scene below.
    await this.pipelines.prepare(import.meta.env.VITE_DESIGN_LAZY_PIPELINES === '0'
      ? this.pipelines.keys() : ['paint', 'present'])

    this.uniforms = this.device.createBuffer({
      size: 4 * 1024 * 1024,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.encoder = this.device.createCommandEncoder()
    this.blank = this.create(1, 1)
    this.clear(this.blank)
    this.submitEncoder()
    await this.waitForQueue('initialization')
    if (this.terminal) throw new Error('WebGPU 设备已丢失')
    this.initialized = true
    this.submittedBoundaryReady = true
  }
  /** Opt-in same-device descriptor dependencies. The registry alone owns
   * in-flight and sticky failure promises; this map only holds fulfilled objects.
   * Neither completion path reads/reinstalls a scene's mutable policy. */
  private registerManagedComposePipelines(layout: GPUPipelineLayout, module: GPUShaderModule) {
    const registry = this.pipelines, device = this.device, format = this.layerFormat
    const entries = ['exactNormal', 'exactPresent', 'exactNormalCorner', 'exactCopyCorner',
      'exactSolidPaintOver', 'exactResolveStep', 'exactShadowOver', 'exactImageResolveStep'] as const
    const key = (entry: string) => `compose:descriptor:${entry}`
    const fulfilled = new Map<string, GPURenderPipeline>()
    for (const entryPoint of [...entries, 'exactAlphaResolve']) registry.register(key(entryPoint), async () => {
      const pipeline = await device.createRenderPipelineAsync({ layout,
        vertex: { module, entryPoint: 'quad' },
        fragment: { module, entryPoint, targets: [{ format: entryPoint === 'exactAlphaResolve' ? 'r32float' : format }] },
        primitive: { topology: 'triangle-list' } })
      fulfilled.set(entryPoint, pipeline)
    }, false)
    registry.register('compose:empty-copy', async () => {
      await registry.prepare([key('exactPresent'), key('exactCopyCorner')])
      this.copyPipeline = fulfilled.get('exactPresent')!
      this.copyCornerPipeline = fulfilled.get('exactCopyCorner')!
    }, false)
    registry.register('compose', async () => {
      // First use launches the original eight in the original order. Shared
      // copy jobs may already be in flight/ready/failed from an empty scene.
      // Registry allSettled drains every started sibling before publication or
      // rejection; error selection is descriptor order, not first-reject time.
      await registry.prepare(entries.map(key))
      ;[this.normalPipeline, this.copyPipeline, this.normalCornerPipeline, this.copyCornerPipeline,
        this.solidPaintOverPipeline, this.resolveStepPipeline, this.shadowOverPipeline, this.imageResolveStepPipeline] =
        entries.map(entry => fulfilled.get(entry)!)
      await registry.prepare([key('exactAlphaResolve')])
      this.alphaResolvePipeline = fulfilled.get('exactAlphaResolve')!
      this.overPipeline = this.normalPipeline!
    })
  }
  async prepareScene(scene: GpuScene, displayOnly = false) {
    this.sampleOnlyPrograms.resetFrame()
    // Bitmap-assembly display leaves intentionally set captureDisplay=false.
    // Transport is independent of the real render(readback,present) contract;
    // callers omitting its explicit display intent retain the original area.
    this.sampleOnlyRequested = this.sampleOnlyCoverageEnabled && displayOnly === true &&
      (this.managed === true || this.managed === false) && !this.hdr &&
      scene.coherentSamples === true && !scene.softwareRaster && !scene.resolve && !scene.presentation && !scene.grid && !scene.checkerboard
    const displayImageRequested = scene.displayImageSource === true && this.managed && !this.displayMath && !this.hdr && !this.displayImageUnavailable
    this.displayImageRequested = displayImageRequested
    this.interactionPresentation = scene.interactionRetained === true
    this.nativeInteractionPresentation = scene.nativeInteraction === true
    this.pairDisplayTaps = scene.pairedDisplayFilters ?? (import.meta.env.VITE_DESIGN_PAIRED_DISPLAY === '1')
    const radiusLimit = scene.displayFilterRadiusLimit
    this.displayFilterRadiusLimit = radiusLimit
    this.displayFilters = scene.displayFilters === true && !this.hdr && (radiusLimit === undefined ||
      import.meta.env.VITE_DESIGN_BOUNDED_DISPLAY_FILTER === '1' && !this.displayMath &&
      !this.boundedDisplayFilterFailed && boundedDisplayRadius(radiusLimit, radiusLimit))
    this.softwareRaster = !!scene.softwareRaster && !this.managed

    const paths = Object.values(scene.nodes).flatMap(n => [n.fill, ...n.strokes.map(s => s.path)])
    this.scenePrograms = import.meta.env.VITE_DESIGN_PROGRAM_RESIDENCY !== '0' &&
      !paths.some(p=>p.analytic||p.area&&!p.area.fingerprint)
      ? paths.flatMap(p=>p.area?[p.area]:[]) : undefined
    const required = new Set([this.emptySceneComposeEnabled && emptyManagedComposeScene(scene, this.managed)
      ? 'compose:empty-copy' : 'compose'])
    if (paths.length) required.add('solid')
    if (paths.some(p => p.area && p.count)) required.add('area')
    if (this.managed && paths.length) { required.add('binary'); required.add('scalar') }
    if (!this.managed) for (const path of paths)
      if (path.count && !path.area && !path.analytic) required.add(`mask:${path.rule}`)
    await this.pipelines.prepare(required)
    if (this.sampleOnlyRequested && required.has('area')) {
      await this.prepareSampleOnlyCoverage()
      if (this.sampleOnlyScalarPipeline) this.sampleOnlyCoverageEligibleScenes++
    }
    if (!this.managed) return
    const modes = compositorModes(scene)
    const layout = this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] })
    const pending: string[] = []
    for (const mode of modes) {
      if (this.modePipelines.has(mode)) continue
      const key = `mode:${mode}`; pending.push(key)
      this.pipelines.register(key, async () => {
      const pipeline = await this.device.createRenderPipelineAsync({ layout,
        vertex: { module: this.compositorModule, entryPoint: 'quad' },
        fragment: { module: this.compositorModule, entryPoint: 'fragment', constants: { COMPOSITOR_MODE: mode }, targets: [{ format: this.layerFormat }] },
        primitive: { topology: 'triangle-list' } })
      this.modePipelines.set(mode, pipeline)
      })
    }
    await this.pipelines.prepare(pending)
    if (displayImageRequested) await this.prepareDisplayImagePipeline()
  }
  /** Independent exact sample-only program; the original area pipeline remains
   * prepared. Tests may force the private enable bit off after preparing both,
   * without changing scene/program/buffer/uniforms or exposing a request flag. */
  private async prepareSampleOnlyCoverage() {
    if (!this.sampleOnlyCoverageEnabled || this.sampleOnlyUnavailable || this.sampleOnlyScalarPipeline) return
    if (!this.sampleOnlyPreparing) this.sampleOnlyPreparing = (async () => {
      try {
        const validated = async <T>(create: () => T | Promise<T>): Promise<T> => {
          this.device.pushErrorScope('validation')
          let pending: Promise<T>
          try { pending = Promise.resolve(create()) }
          catch (error) { await this.device.popErrorScope().catch(() => undefined); throw error }
          // Pair push/pop synchronously before yielding, so this optional
          // candidate cannot absorb a concurrent exact/filter preparation error.
          const validation = this.device.popErrorScope()
          const [value, checked] = await Promise.allSettled([pending, validation])
          if (value.status === 'rejected') throw value.reason
          if (checked.status === 'rejected') throw checked.reason
          if (checked.value) throw Error(checked.value.message)
          return value.value
        }
        const module = await validated(() => this.device.createShaderModule({ code: sampleOnlyAreaShaderWgsl, label: 'Sample-only exact area coverage' }))
        const errors = (await module.getCompilationInfo()).messages.filter(message => message.type === 'error')
        if (errors.length) throw Error(errors.map(message => `${message.lineNum}:${message.message}`).join('\n'))
        const layout = await validated(() => this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] }))
        const results = await Promise.allSettled((['rgba32float', 'rgba8unorm', 'r32float'] as GPUTextureFormat[]).map(format =>
          validated(() => this.device.createRenderPipelineAsync({ layout, vertex: { module, entryPoint: 'areaQuad' },
            fragment: { module, entryPoint: 'areaSampleFragment', targets: [{ format }] }, primitive: { topology: 'triangle-list' } }))))
        const failure = results.find(result => result.status === 'rejected')
        if (failure?.status === 'rejected') throw failure.reason
        const pipelines = results.map(result => (result as PromiseFulfilledResult<GPURenderPipeline>).value)
        ;[this.sampleOnlyColorPipeline, this.sampleOnlyBytePipeline, this.sampleOnlyScalarPipeline] = pipelines
      } catch (error) {
        this.sampleOnlyUnavailable = true
        console.warn('Sample-only coverage unavailable; retaining the original area pipeline', error)
      }
    })()
    await this.sampleOnlyPreparing
  }
  private prepareDisplayImagePipeline(): Promise<void> {
    if (this.displayImagePipeline || this.displayImageUnavailable) return Promise.resolve()
    if (this.displayImagePreparing) return this.displayImagePreparing
    const device = this.device, layout = this.layout, source = this.displayImageBaseSource
    this.displayImagePreparing = (async () => {
      try {
        if (!source) throw new Error('Managed image source is unavailable')
        // Pop each scope before awaiting, so concurrent scene/frame work cannot
        // inherit our scope. Candidate validation must not poison exact frames.
        const validated = async <T>(create: () => T | Promise<T>): Promise<T> => {
          device.pushErrorScope('validation')
          let pending: T | Promise<T>
          try { pending = create() }
          catch (error) { await device.popErrorScope(); throw error }
          const validation = device.popErrorScope()
          const [value, error] = await Promise.all([pending, validation])
          if (error) throw new Error(error.message)
          return value
        }
        const module = await validated(() => device.createShaderModule({ code: displayImageSource(source), label: 'Screen finite image source' }))
        const errors = (await module.getCompilationInfo()).messages.filter(message => message.type === 'error')
        if (errors.length) throw new Error(errors.map(message => `${message.lineNum}:${message.message}`).join('\n'))
        const pipeline = await validated(() => device.createRenderPipelineAsync({
          layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
          vertex: { module, entryPoint: 'quad' },
          fragment: { module, entryPoint: 'exactImageResolveStep', targets: [{ format: 'rgba32float' }] },
          primitive: { topology: 'triangle-list' },
        }))
        // Compiling does not grant a scene capability. The current scene may
        // have switched to export/readback, or this driver may have parked.
        this.displayImagePipeline = pipeline
      } catch (error) {
        this.displayImageUnavailable = true
        this.displayImageRequested = false
        console.warn('Screen finite image source unavailable; using exact image arithmetic', error)
      }
    })()
    return this.displayImagePreparing
  }
  async prepareFilters(prefixUseful = false) {
    const bounded = this.displayFilterRadiusLimit !== undefined
    if (this.managed && this.displayFilters) {
      if (!bounded && this.pairDisplayTaps && !this.pairedDisplay && !this.pairedDisplayFailed && this.device.features.has('float32-filterable')) {
        try {
        const layout = this.device.createBindGroupLayout({ entries: [
          { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: 1024 } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        ] })
        const module = this.device.createShaderModule({ code: pairedDisplayFilterWgsl, label: 'Paired integrated display filter' })
        const pipeline = await this.device.createRenderPipelineAsync({ layout: this.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
          vertex: { module, entryPoint: 'quad' }, fragment: { module, entryPoint: 'fragment', targets: [{ format: this.layerFormat }] },
          primitive: { topology: 'triangle-list' } })
        const sampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' })
        this.pairedDisplay = { layout, pipeline, sampler }
        } catch (error) {
          this.pairedDisplayFailed = true
          console.warn('Paired integrated display filter unavailable; using integrated tent filter', error)
        }
      }
      if (!this.displayFilterPipeline) {
        try {
          const device = this.device
          // The candidate's validation scope never spans an await. A failed
          // optional shader must not contaminate the exact frame's scope.
          const validated = async <T>(create: () => T | Promise<T>): Promise<T> => {
            if (!bounded) return create()
            device.pushErrorScope('validation')
            let pending: T | Promise<T>
            try { pending = create() } catch (error) { await device.popErrorScope(); throw error }
            const validation = device.popErrorScope(), [value, error] = await Promise.all([pending, validation])
            if (error) throw new Error(error.message)
            return value
          }
          const module = await validated(() => device.createShaderModule({ code: displayFilterWgsl, label: 'Canvas integrated tent' }))
          if (bounded) {
            const errors = (await module.getCompilationInfo()).messages.filter(message => message.type === 'error')
            if (errors.length) throw new Error(errors.map(message => `${message.lineNum}:${message.message}`).join('\n'))
          }
          this.displayFilterPipeline = await validated(() => device.createRenderPipelineAsync({
            layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
            vertex: { module, entryPoint: 'quad' }, fragment: { module, entryPoint: 'fragment', targets: [{ format: this.layerFormat }] },
            primitive: { topology: 'triangle-list' },
          }))
        } catch (error) {
          if (!bounded) throw error
          this.boundedDisplayFilterFailed = true
          if (this.displayFilterRadiusLimit !== undefined) this.displayFilters = false
          console.warn('Bounded display filter unavailable; using exact filters', error)
        }
      }
      if (!bounded) return
    }
    if (this.managed && !this.filterPipelines.length) {
      const filterModule = this.device.createShaderModule({ code: exactFilterWgsl(this.certifiedFilter), label: 'Exact rational filter' })
      const errors = (await filterModule.getCompilationInfo()).messages.filter((m) => m.type === 'error')
      if (errors.length) throw new Error(errors.map((m) => `${m.lineNum}:${m.message}`).join('\n'))
      const layout = this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] })
      this.filterPipelines = await Promise.all([0, 1, 2, 3].map((channel) => this.device.createRenderPipelineAsync({ layout,
        vertex: { module: filterModule, entryPoint: 'quad' }, fragment: { module: filterModule, entryPoint: 'fragment',
          constants: { FILTER_CHANNEL: channel }, targets: [{ format: this.layerFormat, writeMask: 1 << channel }] },
        primitive: { topology: 'triangle-list' } })))
      this.scalarFilterPipeline = await this.device.createRenderPipelineAsync({ layout,
        vertex: { module: filterModule, entryPoint: 'quad' }, fragment: { module: filterModule, entryPoint: 'fragment',
          constants: { FILTER_CHANNEL: 3 }, targets: [{ format: 'r32float' }] },
        primitive: { topology: 'triangle-list' } })
    }
    if (this.prefixEnabled && prefixUseful && !this.prefix)
      this.prefix = await TexturePrefix.create(this.device, (u) => this.uniform(u), prefixModule(this.certifiedFilter), false,
        this.timingQueries ? (stage, width, height, radius, channel) =>
          this.timestampWrites({ stage, mode: 22, width, height, radius, channel }) : undefined)
  }
  private byteTentEnabled() {
    return import.meta.env.VITE_DESIGN_BYTE_TENT_PREFIX === '1' &&
      import.meta.env.VITE_DESIGN_EXACT_CLAMP_PREFIX === '1' && !this.managed && !this.disposed && !this.lost
  }
  /** Pipeline-only preparation. Scratch is admitted synchronously per encode. */
  async prepareByteTent(): Promise<boolean> {
    if (!this.byteTentEnabled() || !this.device) return false
    if (this.byteTent) return true
    if (!this.byteTentPreparing) {
      const device = this.device
      const pending = ByteTentPrefix.create(device).then(candidate => {
        if (!this.byteTentEnabled() || this.device !== device) return false
        this.byteTent = candidate
        return true
      })
      this.byteTentPreparing = pending
      // Keep a rejected preparation retryable without turning it into success.
      void pending.then(() => { if (this.byteTentPreparing === pending) this.byteTentPreparing = undefined },
        () => { if (this.byteTentPreparing === pending) this.byteTentPreparing = undefined })
    }
    return this.byteTentPreparing
  }
  /** Alpha-only exact byte tent: RGB is zero. False has no side effects;
   * exceptions abandon the complete encoder and must not be scalar-fallbacked. */
  encodeByteTentAlpha(target: Texture, source: Texture, options: ByteTentOptions, availableBytes: number): boolean {
    if (this.byteTentRecordingFailed) throw Error('Byte tent encoder abandoned; restart the frame')
    if (!this.byteTentEnabled() || !this.byteTent || !this.encoder) return false
    const plan = planByteTentPrefix(options)
    const owned = (texture: Texture, width: number, height: number) => {
      const proof = this.byteTentTextures?.get(texture), resource = texture.resource as GPUTexture
      return !!proof && this.textures.has(texture) && proof.resource === resource && proof.format === 'rgba8unorm' &&
        texture.width === width && texture.height === height && texture.bytes === width * height * 4 &&
        proof.width === width && proof.height === height && resource.width === width && resource.height === height &&
        resource.format === 'rgba8unorm' && resource.dimension === '2d' && resource.depthOrArrayLayers === 1 && resource.sampleCount === 1
    }
    if (!plan || !Number.isSafeInteger(availableBytes) || availableBytes < plan.bytes ||
        source === target || source.resource === target.resource ||
        !owned(source, plan.source.w, plan.source.h) || !owned(target, plan.output.w, plan.output.h) ||
        !((source.resource as GPUTexture).usage & GPUTextureUsage.TEXTURE_BINDING) ||
        !((target.resource as GPUTexture).usage & GPUTextureUsage.RENDER_ATTACHMENT)) return false
    this.closeOver()
    try {
      const lease = this.byteTent.encode(this.encoder, source.resource as GPUTexture, target.resource as GPUTexture,
        { radius: plan.radius, axis: plan.axis, source: plan.source, output: plan.output, scratchBudgetBytes: plan.bytes }, availableBytes)
      if (!lease) throw Error('Validated byte tent recording unexpectedly declined')
      this.byteTentLeases.set(lease, { encoder: this.encoder, submitted: false })
      this.invalidateTextureCertificates(target)
      delete target.uniformColor; delete target.transparentZero
      this.frameScratchBytes = Math.max(this.frameScratchBytes, this.scratchBytes)
      this.byteTentAlphaPasses++
      this.drawCalls += lease.plan.bands
      return true
    } catch (error) {
      this.byteTentRecordingFailed = true
      this.abandonByteTentEncoder()
      throw error
    }
  }
  private byteTentSnapshot() {
    return [...(this.byteTentLeases || [])].filter(([, entry]) => entry.submitted).map(([lease]) => lease)
  }
  private async retireByteTentSnapshot(snapshot: ByteTentPrefixLease[], coveredCompletion: Promise<unknown>) {
    await Promise.all(snapshot.map(async lease => {
      if (!this.byteTentLeases.has(lease)) return
      await lease.retireAfter(coveredCompletion)
      this.byteTentLeases.delete(lease)
    }))
  }
  /** Never called for submitted leases. Their real queue boundary stays owned. */
  private discardByteTentEncoder(encoder: GPUCommandEncoder) {
    for (const [lease, entry] of this.byteTentLeases || []) if (entry.encoder === encoder && !entry.submitted) {
      lease.discardUnsubmitted()
      this.byteTentLeases.delete(lease)
    }
  }
  private abandonByteTentEncoder() {
    this.discardByteTentEncoder(this.encoder)
    this.encoder = this.device.createCommandEncoder()
    this.offset = 0; this.uploadedOffset = 0
  }
  /** Every current-encoder submit, including finish(), shares lease ownership.
   * A thrown queue.submit is uncertain: retain bytes until a real boundary. */
  private submitEncoder() {
    if (this.byteTentRecordingFailed) throw Error('Byte tent encoder abandoned; restart the frame')
    const encoder = this.encoder
    const ownsByteScratch = [...(this.byteTentLeases?.values() || [])].some(entry => entry.encoder === encoder && !entry.submitted)
    let command: GPUCommandBuffer
    try { command = encoder.finish() }
    catch (error) {
      if (ownsByteScratch) { this.byteTentRecordingFailed = true; this.abandonByteTentEncoder() }
      throw error
    }
    try { this.submitQueue(command) }
    catch (error) { if (ownsByteScratch) this.byteTentRecordingFailed = true; throw error }
    finally {
      for (const [lease, entry] of this.byteTentLeases || []) if (entry.encoder === encoder && !entry.submitted) {
        lease.markSubmitted(); entry.submitted = true
      }
    }
  }
  private disposeByteTentLeases() {
    for (const lease of this.byteTentLeases?.keys() || []) lease.disposeAfterDeviceLoss()
    this.byteTentLeases?.clear()
  }
  private prefixPolicy(u: Float32Array, channels: number, filter?: {kind: 'tent'; radius: number}, kernel?: Texture) {
    // Actual operator measurements: alpha-only remains faster on the old path;
    // eligible RGBA lines can use 4 MiB bands from the measured crossover.
    return !!(!displayFilterPass(this.displayFilters, this.displayFilterRadiusLimit, !!this.displayFilterPipeline, u, channels, filter) &&
      this.prefix && filter?.kind === 'tent' && filter.radius >= PREFIX_MIN_RADIUS &&
      !((!Number.isInteger(filter.radius) || filter.radius > 512) && kernel?.prefixRationalUnsupported === true) && channels === 15 && u[16] === 22)
  }
  private rationalKernelBoundBits(kernel: Texture | undefined, radius: number) {
    const proof = kernel && this.rationalKernelBounds?.get(kernel)
    if (!proof || !this.textures.has(kernel!) || kernel!.resource !== proof.resource ||
        kernel!.width !== proof.width || kernel!.height !== proof.height) return 0
    return prefixRationalBoundBits(proof.packet, radius)
  }
  prepareFilterPass(target: Texture, u: Float32Array, inputs: Texture[], channels: number, filter: {kind: 'tent'; radius: number}, availableBytes: number) {
    this.prepareWindowFilterPass(target, u, inputs, channels, filter, availableBytes)
  }
  private prepareWindowFilterPass(target: Texture, u: Float32Array, inputs: Texture[], channels: number,
    filter: {kind: 'tent'; radius: number}, availableBytes: number, sourceWindow?: FilterSourceWindow) {
    if (!this.prefixPolicy(u, channels, filter, inputs[1]) || this.prefix!.scratchBytes) return
    recordGpuDiagnostic('prefix',{reasonCode:availableBytes<PREFIX_SCRATCH_BYTES?1:0,availableBytes,scratchBytes:PREFIX_SCRATCH_BYTES,radius:filter.radius,width:u[2],height:u[3]})
    const sources = [0, 1, 2].map((i) => (inputs[i] || this.blank).resource as GPUTexture)
    if (availableBytes < PREFIX_SCRATCH_BYTES || !this.prefix!.canEncode(target.resource as GPUTexture, sources, u, filter.radius, filter.kind, {x:u[0],y:u[1],w:u[2],h:u[3]}, channels,255,sourceWindow)) return
    this.prefix!.reserveScratch()
    this.prefix!.resetCounters(this.encoder)
    this.frameScratchBytes = Math.max(this.frameScratchBytes, this.prefix!.scratchBytes)
  }
  async abortFrameAndReleaseFilterScratch(reason: 'admission' | 'cancel' = 'admission') {
    this.submittedBoundaryReady = false; this.submittedBoundaryGeneration++
    this.sampleOnlyPrograms.resetFrame(); this.sampleOnlyDispatch = undefined
    this.closeOver()
    // Abandon recorded commands; already submitted commands retain their
    // resources until this explicit completion boundary.
    this.abandonByteTentEncoder()
    const byteTentSnapshot = this.byteTentSnapshot()
    const epoch = this.resourceEpoch
    const coveredCompletion = this.waitForQueue(reason)
    await coveredCompletion
    if (this.lost) throw new Error('GPU 设备已丢失')
    await this.retireByteTentSnapshot(byteTentSnapshot, coveredCompletion)
    if (!this.lost) this.completedResourceEpoch = Math.max(this.completedResourceEpoch, epoch)
    if (this.frameScopeOpen) {
      const error = await this.device.popErrorScope(); this.frameScopeOpen = false
      if (error || this.errors.length) throw markRenderFailure(new Error([error?.message, ...this.errors].filter(Boolean).join('\n')), { failureStage: 7, failureCategory: error ? renderFailureFields(error).failureCategory : this.lost ? 4 : 0, failureCode: 201 })
    }
    this.prefix?.releaseScratch()
    this.releaseImageTables()
    for (const target of this.transientTargets) this.destroy(target)
    this.transientTargets = []
    for (const texture of this.transient) texture.destroy()
    this.transient = []; this.msaa.clear(); this.transientBytes = 0
    this.submittedBoundaryReady = true
  }
  private residentProgramPlan(curves: Float32Array): ProgramPlan | undefined {
    if (!this.curves || !this.programArenaActive || !this.programGpuValid ||
        !this.scenePrograms?.length || this.programArena.bytes > this.curveCapacity) return
    return this.programArena.exactPlan(curves, this.scenePrograms)
  }
  private geometryPreparationReason(vertices: Float32Array, curves: Float32Array, resident?: ProgramPlan) {
    return Number(!!this.vertices && vertices.byteLength > this.vertexCapacity) |
      Number(!!this.curves && Math.max(16, curves.byteLength) > this.curveCapacity) << 1 |
      Number(!!this.curves && !!this.scenePrograms?.length && !resident) << 2
  }
  async prepareFrameResources(vertices: Float32Array, curves = new Float32Array(0)) {
    this.preparedGeometryOwner = undefined
    this.collectCompletedImageTables()
    if (!this.imageTableRetirements?.length) return
    if (this.lost) throw Error('GPU 设备已丢失')
    if (this.errors.length) throw Error(this.errors.join('\n'))
    // Only a read-only all-hit plan can prove that the resident arena and GPU
    // allocation remain unchanged. Misses, resets and growth keep the fence.
    const reason = this.geometryPreparationReason(vertices, curves, this.residentProgramPlan(curves))
    if (this.disposed || this.lost || !this.initialized || !this.submittedBoundaryReady || this.frameScopeOpen || this.activeOver)
      throw Error('Geometry preparation requires an ended GPU frame')
    if (!reason) {
      this.preparedGeometryOwner = { device: this.device, generation: this.submittedBoundaryGeneration,
        vertices: this.vertices, curves: this.curves }
      return
    }
    const epoch = this.resourceEpoch, tables = this.retiredImageTableSnapshot()
    const generation = this.submittedBoundaryGeneration, device = this.device
    await this.waitForQueue('admission', undefined, false, reason)
    if (this.lost) throw Error('GPU 设备已丢失')
    if (this.disposed || !this.initialized || !this.submittedBoundaryReady ||
        this.frameScopeOpen || this.activeOver || this.submittedBoundaryGeneration !== generation || this.device !== device)
      throw Error('Geometry preparation boundary owner changed')
    if (this.errors.length) throw Error(this.errors.join('\n'))
    this.completedResourceEpoch = Math.max(this.completedResourceEpoch, epoch)
    this.collectRetiredImageTables(tables)
  }
  begin(vertices: Float32Array, curves = new Float32Array(0)) {
    const owner = this.preparedGeometryOwner
    this.preparedGeometryOwner = undefined
    if (this.disposed || this.lost) throw new Error('WebGPU 设备已丢失')
    let residentPrograms: ProgramPlan | undefined
    if (this.imageTableRetirements?.length) {
      const failed = this.imageTableRetirements.find(batch => batch.error !== undefined)
      if (failed) throw failed.error
      if (this.errors.length) throw Error(this.errors.join('\n'))
      if (!owner || this.disposed || this.lost || !this.initialized || !this.submittedBoundaryReady ||
          this.frameScopeOpen || this.activeOver || this.device !== owner.device ||
          this.submittedBoundaryGeneration !== owner.generation || this.vertices !== owner.vertices || this.curves !== owner.curves)
        throw Error('Geometry preparation boundary owner changed')
      // Revalidate after the await in the caller, before any mutation. Consume
      // this exact plan synchronously, never invoke mutable plan() twice.
      residentPrograms = this.residentProgramPlan(curves)
      if (this.geometryPreparationReason(vertices, curves, residentPrograms))
        throw Error('Geometry preparation inputs changed')
    }
    this.submittedBoundaryReady = false; this.submittedBoundaryGeneration++
    this.sampleOnlyPrograms.resetFrame(); this.sampleOnlyDispatch = undefined
    this.sampleOnlyCoveragePasses = this.sampleOnlyCoveragePixels = 0
    this.discardByteTentEncoder(this.encoder)
    this.geometryUploadBytes = 0
    this.bindingCache.begin()
    this.pairedFilterPasses = 0
    this.boundedDisplayFilterPasses = 0
    if (this.disposed || this.lost) throw new Error('WebGPU 设备已丢失')
    this.resourceEpoch++
    this.drawCalls = 0
    this.opaqueTentPasses = 0
    this.displayImageSourcePasses = 0
    this.byteTentAlphaPasses = 0
    this.mergedExactFilterPasses = 0
    this.finishTransientBytes = 0
    this.frameScratchBytes = this.scratchBytes
    this.timingRows = []
    this.timingSkipped = 0
    this.triangles = 0
    this.offset = 0
    this.uploadedOffset = 0
    this.uniformCommands = 0
    this.commandSubmissions = 0
    this.solidOffset = 0
    this.solidUploaded = 0
    this.solidRanges.clear()
    this.errors = []
    if (!this.programArenaActive) this.programArena.reset()
    const programs=residentPrograms||(this.scenePrograms?this.programArena.plan(curves,this.scenePrograms):undefined)
    this.programOffsets=programs?.offsets
    this.programHits=programs?.hits||0;this.programHitBytes=programs?.hitBytes||0
    if(!programs&&this.programArenaActive){this.programArena.reset();this.curveMirror.reset()}
    if(programs&&!this.programArenaActive){this.programGpuValid=false;this.curveMirror.reset()}
    this.programArenaActive=!!programs
    const curveBytes=programs?this.programArena.bytes:curves.byteLength
    this.trackCapacityDemand(Math.max(16, curveBytes), this.curveCapacity, this.curveShrink, 16)
    if (!this.curves || Math.max(16, curveBytes) > this.curveCapacity) {
      const previous=this.curves,copy=!!(programs&&this.programGpuValid&&previous)
      this.curveMirror.reset()
      if(!copy)this.programGpuValid=false
      this.curveCapacity = Math.max(16, 2 ** Math.ceil(Math.log2(Math.max(16, curveBytes))))
      this.curves = this.device.createBuffer({
        size: this.curveCapacity,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      })
      if(copy){
        // Grow on the same device. The submitted copy retains its old buffer
        // until completion; subsequent queue writes append only new programs.
        const encoder=this.device.createCommandEncoder()
        encoder.copyBufferToBuffer(previous!,0,this.curves,0,Math.min(previous!.size,this.curveCapacity))
        this.submitQueue(encoder.finish());this.commandSubmissions++
      }
      previous?.destroy()
    }
    const curveUpdate=programs
      ?this.programGpuValid?programs.upload:{offset:0,data:programs.words}
      :this.curveMirror.update(curves.byteLength ? curves : new Float32Array(4))
    if(curveUpdate){this.device.queue.writeBuffer(this.curves,curveUpdate.offset,curveUpdate.data);this.geometryUploadBytes+=curveUpdate.data.byteLength}
    if(programs)this.programGpuValid=true
    if (this.sampleOnlyRequested && this.sampleOnlyCoverageEnabled && this.sampleOnlyScalarPipeline && programs && this.curves)
      this.sampleOnlyPrograms.bind(programs.words, programs.offsets, this.scenePrograms!, this.curves, this.resourceEpoch)
    else this.sampleOnlyPrograms.reset()
    this.encoder = this.device.createCommandEncoder()
    this.byteTentRecordingFailed = false
    this.prefix?.resetCounters(this.encoder)
    this.trackCapacityDemand(vertices.byteLength, this.vertexCapacity, this.vertexShrink, 256)
    if (vertices.byteLength > this.vertexCapacity) {
      this.vertices?.destroy()
      this.vertexMirror.reset()
      this.vertexCapacity = Math.max(
        256,
        2 ** Math.ceil(Math.log2(Math.max(1, vertices.byteLength))),
      )
      this.vertices = this.device.createBuffer({
        size: this.vertexCapacity,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
    }
    if (!this.vertices) {
      this.vertexCapacity = 256
      this.vertices = this.device.createBuffer({
        size: 256,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
    }
    const vertexUpdate=this.vertexMirror.update(vertices)
    if(vertexUpdate){this.device.queue.writeBuffer(this.vertices,vertexUpdate.offset,vertexUpdate.data);this.geometryUploadBytes+=vertexUpdate.data.byteLength}
    this.device.pushErrorScope('validation')
    this.frameScopeOpen = true
  }
  /** Track consecutive frames whose demand stays ≥4× below the capacity,
   * remembering the window's peak demand so a shrink targets the next
   * doubling tier the growth path would choose. */
  private trackCapacityDemand(
    demand: number,
    capacity: number,
    window: { frames: number; maxDemand: number },
    floorBytes: number,
  ) {
    const tier = Math.max(floorBytes, 2 ** Math.ceil(Math.log2(Math.max(1, demand))))
    window.maxDemand = Math.max(window.maxDemand, demand)
    if (capacity >= tier * 4) window.frames++
    else window.frames = 0
  }
  /** Shrink a ≥4× overprovisioned vertex/curve buffer after 60 consecutive
   * low-demand frames. Call only after a checkpoint: submitted commands may
   * still reference the old buffer, and the onSubmittedWorkOrdered fence in
   * finish() guarantees they are done. */
  private shrinkCapacities() {
    if (this.vertexShrink.frames >= CAPACITY_SHRINK_FRAMES && this.vertices) {
      const target = Math.max(256, 2 ** Math.ceil(Math.log2(Math.max(1, this.vertexShrink.maxDemand))))
      if (target < this.vertexCapacity) {
        console.debug(`DESIGN_GPU_SHRINK ${JSON.stringify({ buffer: 'vertices', from: this.vertexCapacity, to: target })}`)
        this.vertices.destroy()
        this.vertexMirror.reset()
        this.vertexCapacity = target
        this.vertices = this.device.createBuffer({
          size: target,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        })
      }
      this.vertexShrink = { frames: 0, maxDemand: 0 }
    }
    if (this.curveShrink.frames >= CAPACITY_SHRINK_FRAMES && this.curves) {
      const target = Math.max(16, 2 ** Math.ceil(Math.log2(Math.max(1, this.curveShrink.maxDemand))))
      if (target < this.curveCapacity) {
        console.debug(`DESIGN_GPU_SHRINK ${JSON.stringify({ buffer: 'curves', from: this.curveCapacity, to: target })}`)
        this.curves.destroy()
        this.curveMirror.reset()
        this.programGpuValid=false
        this.curveCapacity = target
        this.curves = this.device.createBuffer({
          size: target,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        })
      }
      this.curveShrink = { frames: 0, maxDemand: 0 }
    }
  }
  create(width: number, height: number): Texture {
    return this.createFormat(width, height, this.layerFormat)
  }
  createBinaryCoverage(width: number, height: number): Texture {
    const texture = this.createFormat(width, height, 'rgba8unorm')
    texture.binaryCoverage = true
    return texture
  }
  createScalarCoverage(width:number,height:number):Texture {
    const texture=this.createFormat(width,height,'r32float');texture.scalarCoverage=true;return texture
  }
  supportsExactWholeTentSource(source: Texture): boolean {
    if (!this.managed || this.displayMath || this.displayFilters || this.disposed || this.lost || !this.encoder ||
        this.filterPipelines.length !== 4 || this.filterPipelines.some(pipeline => !pipeline) ||
        !this.textures.has(source) || source.binaryCoverage || source.scalarCoverage || source.uniformColor || source.transparentZero)
      return false
    const proof = this.byteTentTextures.get(source), resource = source.resource as GPUTexture
    return !!proof && proof.resource === resource && proof.format === 'rgba32float' &&
      Number.isSafeInteger(source.width) && Number.isSafeInteger(source.height) && source.width > 0 && source.height > 0 &&
      source.width === proof.width && source.height === proof.height && source.bytes === proof.width * proof.height * 16 &&
      resource.width === proof.width && resource.height === proof.height && resource.format === 'rgba32float' &&
      resource.dimension === '2d' && resource.depthOrArrayLayers === 1 && resource.sampleCount === 1 &&
      !!(resource.usage & GPUTextureUsage.TEXTURE_BINDING) && !!(resource.usage & GPUTextureUsage.RENDER_ATTACHMENT)
  }
  private createFormat(width: number, height: number, format: GPUTextureFormat): Texture {
    if (
      width < 1 ||
      height < 1 ||
      width > this.device.limits.maxTextureDimension2D ||
      height > this.device.limits.maxTextureDimension2D
    )
      throw new Error('WebGPU 纹理尺寸超限')
    const bytes = textureByteLength(width, height, format === 'rgba32float' ? 16 : 4)
    const resource = this.device.createTexture({
      label: `Forma layer ${width}x${height} ${this.layerFormat}`,
      size: [width, height],
      format,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    })
    const t = {
      width,
      height,
      resource,
      bytes,
    }
    this.textures.add(t)
    this.byteTentTextures?.set(t, { resource, width, height, format })
    return t
  }
  private invalidateTextureCertificates(texture: Texture) {
    this.rationalKernelBounds?.delete(texture)
    this.imageRanges?.delete(texture)
    this.displayImageUploads?.delete(texture)
    this.imageAxisPrograms?.delete(texture)
    delete texture.finitePixels;delete texture.opaqueAlpha
  }
  destroy(t: Texture) {
    this.invalidateTextureCertificates(t)
    this.byteTentTextures?.delete(t)
    this.replayParameterTextures.delete(t)
    if (this.textures.delete(t)) (t.resource as GPUTexture).destroy()
  }
  upload(bitmap: ImageBitmap) {
    const t = this.create(bitmap.width, bitmap.height)
    this.device.queue.copyExternalImageToTexture(
      { source: bitmap },
      { texture: t.resource as GPUTexture, premultipliedAlpha: true },
      [bitmap.width, bitmap.height],
    )
    return t
  }
  uploadLinear(values: Float32Array, width: number, height: number) {
    if (!this.managed || values.length !== width * height * 4) throw new Error('无效的浮点纹理')
    const range=import.meta.env.VITE_DESIGN_EXACT_IMAGE_X_TABLE !== '0' && values.buffer instanceof ArrayBuffer
      ? certifyExactImageRange(values) : undefined
    // The same synchronous range proof already visited every actual f32 word
    // and rejected nonfinite values. Reuse it without repeating that full scan.
    // Shared, unknown and invalid uploads still pass through public validation.
    if(!range)return this.uploadParameters(values,width,height)
    const texture=this.createFormat(width,height,'rgba32float')
    this.device.queue.writeTexture({texture:texture.resource as GPUTexture},values,
      {bytesPerRow:width*16},[width,height])
    texture.finitePixels=true
    if(height===2 && values[3]===-1 && width<=8192)this.imageAxisPrograms.set(texture,values.slice())
    this.imageRanges.set(texture,range)
    this.displayImageUploads.set(texture,{resource:texture.resource as GPUTexture,width,height,range})
    return texture
  }
  uploadParameters(values: Float32Array, width: number, height: number) {
    if (values.length !== width * height * 4)
      throw new Error('无效的材质参数纹理')
    // Dense coordinate fields can contain millions of scalars per tile. A
    // direct loop preserves admission without one callback per scalar.
    for (let i = 0; i < values.length; i++)
      if (!Number.isFinite(values[i])) throw new Error('无效的材质参数纹理')
    const t = this.createFormat(width, height, 'rgba32float')
    this.device.queue.writeTexture(
      { texture: t.resource as GPUTexture },
      values,
      { bytesPerRow: width * 16 },
      [width, height],
    )
    // This is the exact post-adjustment/premultiplication upload, not an
    // assertion about the original file. A shared buffer could change between
    // validation and the synchronous queue copy, so it receives no certificate.
    if (values.buffer instanceof ArrayBuffer) t.finitePixels = true
    if(import.meta.env.VITE_DESIGN_EXACT_IMAGE_X_TABLE !== '0' && values.buffer instanceof ArrayBuffer &&
        height===2 && values[3]===-1 && width<=8192)this.imageAxisPrograms.set(t,values.slice())
    return t
  }
  uploadRgba8(bytes: Uint8Array, width: number, height: number) {
    if (bytes.length !== width * height * 4) throw new Error('无效的 RGBA8 数据纹理')
    // The synchronous upload captures these actual bytes. Keep only the
    // parser's small immutable coefficient proof, never an image-sized copy.
    const packet = import.meta.env.VITE_DESIGN_PREFIX_TIGHT_BOUND === '1' && bytes.buffer instanceof ArrayBuffer
      ? certifyPrefixRationalBound(bytes) : undefined
    if (this.managed) {
      const t = this.uploadLinear(
        Float32Array.from(bytes, (v) => v / 255),
        width,
        height,
      )
      if (packet) this.rationalKernelBounds.set(t, { packet, resource: t.resource, width, height })
      return t
    }
    const t = this.create(width, height)
    this.device.queue.writeTexture(
      { texture: t.resource as GPUTexture },
      new Uint8Array(bytes),
      { bytesPerRow: width * 4 },
      [width, height],
    )
    if (packet) this.rationalKernelBounds.set(t, { packet, resource: t.resource, width, height })
    return t
  }
  get exactFilterPacketMaxDimension(): number | undefined {
    if (import.meta.env.VITE_DESIGN_EXACT_WHOLE_TENT_2048 !== '1' || !this.managed || this.displayMath ||
        this.disposed || this.lost || !this.device) return
    const limit = this.device.limits.maxTextureDimension2D
    return Number.isSafeInteger(limit) && limit > 0 ? limit : undefined
  }
  uploadExactFilterPacket(bytes: Uint8Array, width: number, height: number): Texture {
    const limit = this.exactFilterPacketMaxDimension, logicalTexels = exactFilterPacketTexels(bytes)
    const layout = limit !== undefined && logicalTexels !== undefined ? exactFilterPacketLayout(logicalTexels, limit) : undefined
    if (!layout || logicalTexels! <= limit! || layout.height < 2 || layout.width !== width || layout.height !== height)
      throw new Error('Invalid exact filter packet row layout')
    // Parse the original packet only. Padding cannot grant or repair a proof.
    const packet = import.meta.env.VITE_DESIGN_PREFIX_TIGHT_BOUND === '1' ? certifyPrefixRationalBound(bytes) : undefined
    let physical = bytes
    if (layout.physicalTexels !== logicalTexels) {
      physical = new Uint8Array(layout.physicalTexels * 4)
      physical.set(bytes)
    }
    // Caller admitted layout.bytes before this first padding/f32 allocation.
    // Keep the existing managed byte/255 transport, not an RGBA8 shortcut.
    const texture = this.uploadLinear(Float32Array.from(physical, value => value / 255), width, height)
    if (packet) this.rationalKernelBounds.set(texture, { packet, resource: texture.resource, width, height })
    return texture
  }
  uploadAtlasLinear(
    texture: Texture,
    x: number,
    y: number,
    width: number,
    height: number,
    values: Float32Array,
  ) {
    this.invalidateTextureCertificates(texture)
    if (values.length !== width * height * 4) throw new Error('无效的浮点纹理写入')
    this.device.queue.writeTexture(
      { texture: texture.resource as GPUTexture, origin: { x, y } },
      values,
      { bytesPerRow: width * 16 },
      [width, height],
    )
  }
  uploadAtlasRgba8(
    texture: Texture,
    x: number,
    y: number,
    width: number,
    height: number,
    bytes: Uint8Array,
  ) {
    this.invalidateTextureCertificates(texture)
    if (this.managed) {
      this.uploadAtlasLinear(
        texture,
        x,
        y,
        width,
        height,
        Float32Array.from(bytes, (v) => v / 255),
      )
      return
    }
    if (bytes.length !== width * height * 4) throw new Error('无效的 RGBA8 数据纹理写入')
    this.device.queue.writeTexture(
      { texture: texture.resource as GPUTexture, origin: { x, y } },
      new Uint8Array(bytes),
      { bytesPerRow: width * 4 },
      [width, height],
    )
  }
  uploadReplayParameters(values: Float32Array, width: number, height: number, target?: Texture) {
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 1024 ||
      height > 1024 ||
      values.length !== width * height * 4 ||
      values.some((v) => !Number.isFinite(v))
    )
      throw new Error('无效的纹理重放参数')
    if (target) {
      if (!this.textures.has(target) || !this.replayParameterTextures.has(target))
        throw new Error('无效的纹理重放参数缓冲区')
      // Queue writes precede commands still in an encoder. Submit those reads
      // first; then overwrite the same allocation in queue order, without
      // destroying it or pretending its bytes have been released.
      this.submitCommands()
    } else {
      target = this.createFormat(1024, 1024, 'rgba32float')
      this.replayParameterTextures.add(target)
    }
    this.invalidateTextureCertificates(target)
    this.device.queue.writeTexture(
      { texture: target.resource as GPUTexture },
      values,
      { bytesPerRow: width * 16 },
      [width, height],
    )
    return target
  }
  clear(t: Texture) {
    this.invalidateTextureCertificates(t)
    this.closeOver()
    const pass = this.encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.bindingCache.view((t.resource as GPUTexture)),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 0],
        },
      ],
    })
    pass.end()
  }
  private uniform(u: Float32Array) {
    if (++this.uniformCommands > 262144) throw new Error('GPU frame command work budget exceeded')
    if (this.offset + 1024 > this.uniformData.byteLength) this.submitCommands()
    const offset = this.offset
    this.offset += 1024
    this.uniformData.set(u, offset / 4)
    return { buffer: this.uniforms, offset, size: 1024 }
  }
  private uniformWords(words: Uint32Array) {
    if(++this.uniformCommands>262144)throw Error('GPU frame command work budget exceeded')
    if(this.offset+1024>this.uniformData.byteLength)this.submitCommands()
    const offset=this.offset;this.offset+=1024
    new Uint32Array(this.uniformData.buffer,this.uniformData.byteOffset+offset,256).set(words)
    return {buffer:this.uniforms,offset,size:1024}
  }
  private submitCommands() {
    this.closeOver()
    this.uploadUniforms()
    this.submitEncoder()
    this.commandSubmissions++
    this.encoder = this.device.createCommandEncoder()
    // Queue writes and submissions execute in order. Reuse this bounded arena
    // only after submitting the commands that refer to its old contents.
    // Keep MSAA scratch alive: the caller may be about to bind one of those
    // textures in the next command (for example its downsample pass).
    this.offset = 0
    this.uploadedOffset = 0
  }
  async readSurface(source: Texture): Promise<Float32Array> {
    await this.checkpoint('readback')
    const width=source.width,height=source.height,floating=source.bytes===width*height*16,bpp=floating?16:4
    const stride=Math.ceil(width*bpp/256)*256
    const buffer=this.device.createBuffer({size:stride*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ})
    try {
      const encoder=this.device.createCommandEncoder()
      encoder.copyTextureToBuffer({texture:source.resource as GPUTexture},{buffer,bytesPerRow:stride},[width,height])
      this.submitQueue(encoder.finish());this.commandSubmissions++
      await buffer.mapAsync(GPUMapMode.READ)
      const raw=new Uint8Array(buffer.getMappedRange()),packed=new Uint8Array(width*height*bpp)
      for(let y=0;y<height;y++)packed.set(raw.subarray(y*stride,y*stride+width*bpp),y*width*bpp)
      if(source.scalarCoverage){const values=new Float32Array(packed.buffer);return Float32Array.from({length:values.length*4},(_,i)=>values[Math.floor(i/4)])}
      return floating?new Float32Array(packed.buffer):Float32Array.from(packed,v=>v/255)
    } finally { buffer.destroy() }
  }
  /** Bit-preserving copy for completed, privately owned filter intermediates.
   * It introduces no sampler, float arithmetic, readback or completion claim. */
  copyRegion(target: Texture, source: Texture, sourceRegion: Rect, targetOrigin: [number, number]) {
    const from = source.resource as GPUTexture, to = target.resource as GPUTexture
    if (!this.managed || !this.textures.has(source) || !this.textures.has(target) ||
        from === to || from.format !== 'rgba32float' || to.format !== 'rgba32float' ||
        ![sourceRegion.x, sourceRegion.y, sourceRegion.w, sourceRegion.h, ...targetOrigin].every(Number.isSafeInteger) ||
        sourceRegion.x < 0 || sourceRegion.y < 0 || sourceRegion.w <= 0 || sourceRegion.h <= 0 ||
        sourceRegion.x + sourceRegion.w > source.width || sourceRegion.y + sourceRegion.h > source.height ||
        targetOrigin.length !== 2 || targetOrigin[0] < 0 || targetOrigin[1] < 0 ||
        targetOrigin[0] + sourceRegion.w > target.width || targetOrigin[1] + sourceRegion.h > target.height)
      throw Error('Invalid exact filter texture copy')
    this.closeOver()
    this.invalidateTextureCertificates(target)
    delete target.uniformColor
    delete target.transparentZero
    this.encoder.copyTextureToTexture(
      { texture: from, origin: [sourceRegion.x, sourceRegion.y] },
      { texture: to, origin: targetOrigin },
      [sourceRegion.w, sourceRegion.h],
    )
  }
  copyColorRegion(target: Texture, source: Texture, sourceRegion: Rect, targetOrigin: [number, number]) {
    const from=source.resource as GPUTexture,to=target.resource as GPUTexture
    if(!this.textures.has(source)||!this.textures.has(target)||from===to||
        !['rgba8unorm','rgba32float'].includes(from.format)||to.format!==from.format||
        source.binaryCoverage||source.scalarCoverage||target.binaryCoverage||target.scalarCoverage||
        source.width!==from.width||source.height!==from.height||target.width!==to.width||target.height!==to.height||
        ![sourceRegion.x,sourceRegion.y,sourceRegion.w,sourceRegion.h,...targetOrigin].every(Number.isSafeInteger)||
        sourceRegion.x<0||sourceRegion.y<0||sourceRegion.w<1||sourceRegion.h<1||
        sourceRegion.x+sourceRegion.w>source.width||sourceRegion.y+sourceRegion.h>source.height||
        targetOrigin.length!==2||targetOrigin[0]<0||targetOrigin[1]<0||
        targetOrigin[0]+sourceRegion.w>target.width||targetOrigin[1]+sourceRegion.h>target.height)
      throw Error('Invalid native painter color copy')
    this.closeOver();this.invalidateTextureCertificates(target)
    delete target.uniformColor;delete target.transparentZero
    this.encoder.copyTextureToTexture({texture:from,origin:[sourceRegion.x,sourceRegion.y]},
      {texture:to,origin:targetOrigin},[sourceRegion.w,sourceRegion.h])
  }
  async checkpoint(reason: QueueWaitReason = 'checkpoint', admission?: GpuAdmissionDiagnostic, completedPoolEpoch?: number) {
    const retiredTables = this.retiredImageTableSnapshot()
    this.submitCommands()
    const byteTentSnapshot = this.byteTentSnapshot()
    // Do not advance completion here: the newly submitted commands may still
    // be running. This certificate covers only old, no-longer-used pool entries.
    if (reason === 'admission' && !this.lost && Number.isSafeInteger(completedPoolEpoch) && completedPoolEpoch! > 0 &&
        completedPoolEpoch! < this.resourceEpoch && completedPoolEpoch! <= this.completedResourceEpoch) return
    const epoch = this.resourceEpoch
    const coveredCompletion = this.waitForQueue(reason, admission)
    await coveredCompletion
    if (this.lost) throw new Error('GPU 设备已丢失')
    await this.retireByteTentSnapshot(byteTentSnapshot, coveredCompletion)
    // The current frame may encode more reads after this checkpoint. Only
    // earlier frames are eligible for immutable-resource eviction.
    this.completedResourceEpoch = Math.max(this.completedResourceEpoch, epoch - 1)
    this.collectRetiredImageTables(retiredTables)
  }
  /** A completed frame's encoder is already consumed by finish(). Asset
   * scope preparation runs before begin(), so it must never finish it again. */
  async waitForSubmittedWork() {
    const ready = () => !this.disposed && !this.lost && this.initialized && this.submittedBoundaryReady &&
      !this.frameScopeOpen && !this.activeOver
    if (!ready()) throw Error('Submitted GPU boundary requires an ended frame')
    const generation = this.submittedBoundaryGeneration, device = this.device
    const valid = () => ready() && this.submittedBoundaryGeneration === generation && this.device === device
    const retiredTables = this.retiredImageTableSnapshot(), byteTent = this.byteTentSnapshot()
    try {
      const completion = this.waitForQueue('admission')
      await completion
      if (!valid()) throw Error('Submitted GPU boundary owner changed')
      if (this.errors.length) throw Error(this.errors.join('\n'))
      await this.retireByteTentSnapshot(byteTent, completion)
      if (!valid()) throw Error('Submitted GPU boundary owner changed')
      this.collectRetiredImageTables(retiredTables)
    } catch (error) {
      if (this.submittedBoundaryGeneration === generation && this.device === device) this.submittedBoundaryReady = false
      throw error
    }
  }
  submitPending() {
    // Reuse exactly the uniform-arena overflow submission contract. No
    // transient/scratch lifetime ends here and no readback is introduced.
    if (this.offset > 0 || [...(this.byteTentLeases?.values() || [])].some(entry => entry.encoder === this.encoder && !entry.submitted)) this.submitCommands()
  }
  private flush() {
    this.submitCommands()
    for (const t of this.transientTargets) this.destroy(t)
    this.transientTargets = []
    for (const t of this.transient) t.destroy()
    this.transient = []
    this.msaa.clear()
    this.transientBytes = 0
  }
  private uploadUniforms() {
    if (this.solidBuffer && this.solidOffset > this.solidUploaded) {
      this.device.queue.writeBuffer(
        this.solidBuffer,
        this.solidUploaded * 4,
        this.solidData.buffer,
        this.solidUploaded * 4,
        (this.solidOffset - this.solidUploaded) * 4,
      )
      this.solidUploaded = this.solidOffset
    }
    if (this.offset === this.uploadedOffset) return
    this.device.queue.writeBuffer(
      this.uniforms,
      this.uploadedOffset,
      this.uniformData.buffer,
      this.uploadedOffset,
      this.offset - this.uploadedOffset,
    )
    this.uploadedOffset = this.offset
  }
  private maskBuffer(width: number, height: number, density = 2) {
    const key = `${density}:${width}:${height}`,
      existing = this.msaa.get(key)
    if (existing) return existing
    // 2x spatial resolution plus hardware 4x MSAA gives 16 coverage samples.
    // Byte accounting follows the actual layer format: the high/low resolve
    // textures and the 4x MSAA color target cost layerBpp per sample, the
    // depth24plus-stencil8 scratch 4 bytes per sample. rgba8unorm reduces to
    // the historical w·h·4·(d²·9+1); rgba32float is ~2.7× that, which the old
    // single-formula budget let through the 64 MiB gate.
    // Tiles keep all resolve/color/stencil scratch within the 64 MiB budget.
    const layerBpp = this.layerFormat === 'rgba32float' ? 16 : 4
    const required =
      width * height *
      (layerBpp * (density * density + 1) + density * density * 4 * (layerBpp + 4))
    if (this.transientBytes + required > 64 * 1024 * 1024) this.flush()
    const high = this.create(width * density, height * density),
      low = this.create(width, height)
    const color = this.device.createTexture({
        size: [width * density, height * density],
        format: this.layerFormat,
        sampleCount: 4,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      }),
      depth = this.device.createTexture({
        size: [width * density, height * density],
        format: 'depth24plus-stencil8',
        sampleCount: 4,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      })
    this.transient.push(color, depth)
    this.transientTargets.push(high, low)
    this.transientBytes += required
    const buffer = { color, depth, high, low }
    this.msaa.set(key, buffer)
    return buffer
  }
  maskRegion(path: PathMesh, target: Texture, sampleIndex: number, region: Rect) {
    if (!path.area) throw Error('Regional coverage requires an interval program')
    this.mask(path, target, sampleIndex, region)
  }
  mask(path: PathMesh, target: Texture, sampleIndex?: number, region = path.rect) {
    this.invalidateTextureCertificates(target)
    if (path.area) {
      if (!this.areaPipeline) throw new Error('Coverage program unavailable')
      const u = parameters(region)
      u[16] = 31
      const first=this.programOffsets?.get(path.area.first)
      if(this.programOffsets&&first===undefined)throw new Error('Resident coverage program is missing')
      u[36] = first??path.area.first
      u[38] = sampleIndex === undefined ? 0 : sampleIndex + 1
      u.set([region.x - path.rect.x, region.y - path.rect.y, path.rect.w, path.rect.h], 40)
      const previous = this.sampleOnlyDispatch
      this.sampleOnlyDispatch = this.sampleOnlyRequested && this.sampleOnlyCoverageEnabled && this.curves &&
        target.width === region.w && target.height === region.h &&
        this.sampleOnlyPrograms.accepts(path, sampleIndex, region, first, this.curves, this.resourceEpoch)
        ? { target, uniform: u, buffer: this.curves, epoch: this.resourceEpoch } : undefined
      try { this.pass(target, u, []) }
      finally { this.sampleOnlyDispatch = previous }
      this.triangles++
      return
    }
    if (path.analytic) {
      const u = parameters(path.rect)
      u[16] = 20
      u.set(
        [
          path.analytic.first,
          path.analytic.count,
          path.rule === 'evenodd' ? 1 : 0,
          sampleIndex === undefined ? 0 : sampleIndex + 1,
        ],
        36,
      )
      if (path.analytic.bands !== undefined)
        u.set([path.analytic.bands, Math.ceil(path.rect.h / 16), 0, 0], 40)
      this.pass(target, u, [])
      this.triangles++
      return
    }

    if (path.analyticRect) {
      const u = parameters(path.rect),
        b = path.analyticRect
      u[16] = 17
      u.set([b[0] - path.rect.x, b[1] - path.rect.y, b[2] - path.rect.x, b[3] - path.rect.y], 36)
      this.pass(target, u, [])
      this.triangles++
      return
    }
    this.closeOver()
    const density = path.sampleCount === 4 ? 1 : 2
    for (let y = 0; y < target.height; y += 512)
      for (let x = 0; x < target.width; x += 512) {
        const w = Math.min(512, target.width - x),
          h = Math.min(512, target.height - y),
          { color, depth, high, low } = this.maskBuffer(w, h, density),
          u = parameters({ x: 0, y: 0, w, h })
        u.set([x, y], 4)
        const uniform = this.uniform(u)
        const create = () => this.device.createBindGroup({
          layout: this.maskLayout,
          entries: [{ binding: 0, resource: uniform }],
        })
        // Only descriptors are reused: every tile still writes its exact
        // uniforms. Fixed offsets remain part of the key even when the main
        // compositor uses dynamic bindings; maskLayout has no dynamic offset.
        let bind: GPUBindGroup
        if (import.meta.env.VITE_DESIGN_BINDING_CACHE === '0') {
          this.bindingCache.groupCreates++
          bind = create()
        } else {
          bind = this.bindingCache.group([this.maskLayout, uniform.buffer], uniform.offset, create)
        }
        const pass = this.encoder.beginRenderPass({
          colorAttachments: [
            {
              view: this.bindingCache.view(color),
              resolveTarget: this.bindingCache.view((high.resource as GPUTexture)),
              loadOp: 'clear',
              storeOp: 'discard',
              clearValue: [0, 0, 0, 0],
            },
          ],
          depthStencilAttachment: {
            view: this.bindingCache.view(depth),
            depthClearValue: 1,
            depthLoadOp: 'clear',
            depthStoreOp: 'discard',
            stencilClearValue: 0,
            stencilLoadOp: 'clear',
            stencilStoreOp: 'discard',
          },
        })
        pass.setBindGroup(0, bind)
        pass.setPipeline(this.maskPipelines.get(path.rule)!)
        pass.setVertexBuffer(0, this.vertices!)
        pass.setStencilReference(path.rule === 'union' ? 1 : 0)
        pass.draw(path.count, 1, path.first)
        this.drawCalls++
        this.triangles += path.count / 3
        pass.setPipeline(this.coverPipelines.get(path.rule)!)
        pass.setStencilReference(0)
        pass.draw(3)
        this.drawCalls++
        pass.end()
        const down = parameters(
          { x: 0, y: 0, w, h },
          { x: 0, y: 0, w: w * density, h: h * density },
        )
        down[16] = density === 2 ? 19 : 0
        const single = target.width <= 512 && target.height <= 512
        this.pass(single ? target : low, down, [high])
        if (!single)
          this.encoder.copyTextureToTexture(
            { texture: low.resource as GPUTexture },
            { texture: target.resource as GPUTexture, origin: [x, y] },
            [w, h],
          )
      }
  }
  private bind(u: Float32Array, inputs: Texture[]) {
    u[SCALAR_COVERAGE_UNIFORM]=inputs.reduce((flags,t,i)=>flags|
      (t.scalarCoverage?1<<i:0)|(t.transparentZero?1<<(i+4):0)|(t.uniformColor?1<<(i+8):0),0)
    u[240] = this.managed ? 1 : 0
    u[253] = this.softwareRaster ? 1 : 0
    u[254] = 9
    u[255] = 19 // Exact sampler limb count; keep compiler loops bounded.
    const uniform = this.uniform(u), textures = [0, 1, 2, 3].map(i => (inputs[i] || this.blank).resource as GPUTexture)
    const offset = this.dynamicUniformBindings ? 0 : uniform.offset
    const create = () => this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: { ...uniform, offset } },
        ...[0, 1, 2, 3].map((i) => ({
          binding: i === 3 ? 5 : i + 1,
          resource: this.bindingCache.view(textures[i]),
        })),
        { binding: 4, resource: { buffer: this.curves! } },
      ],
    })
    let group: GPUBindGroup
    if (import.meta.env.VITE_DESIGN_BINDING_CACHE === '0') { this.bindingCache.groupCreates++; group = create() }
    else group = this.bindingCache.group([this.layout, uniform.buffer, this.curves!, ...textures], offset, create)
    return { group, offsets: this.dynamicUniformBindings ? [uniform.offset] : [] }
  }
  solidBatchRemaining() {
    // Four sample planes share one data object. Only unique uploads consume
    // this frame arena; submission alone must not reopen or overwrite it.
    return Math.max(0, Math.floor((this.solidData.length - this.solidOffset) / SOLID_INSTANCE_FLOATS))
  }
  solidBatch(target: Texture, u: Float32Array, data: Float32Array, clip?: Texture) {
    this.invalidateTextureCertificates(target)
    if (clip === target) throw new Error('GPU texture feedback loop')
    this.closeOver()
    if (!this.solidBuffer) {
      this.solidBuffer = this.device.createBuffer({
        size: this.solidData.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      })
      this.solidBind = this.device.createBindGroup({
        layout: this.solidLayout,
        entries: [{ binding: 0, resource: { buffer: this.solidBuffer } }],
      })
    }
    let base = this.solidRanges.get(data)
    if (base === undefined) {
      if (this.solidOffset + data.length > this.solidData.length)
        throw new Error('GPU solid instance budget exceeded')
      base = this.solidOffset / 4
      this.solidData.set(data, this.solidOffset)
      this.solidOffset += data.length
      this.solidRanges.set(data, base)
    }
    u[36] = base
    const bind = this.bind(u, clip ? [this.blank, this.blank, clip] : [])
    const pass = this.encoder.beginRenderPass({
      colorAttachments: [
        { view: this.bindingCache.view((target.resource as GPUTexture)), loadOp: 'load', storeOp: 'store' },
      ],
    })
    pass.setPipeline(this.solidPipeline)
    pass.setBindGroup(0, bind.group, bind.offsets)
    pass.setBindGroup(1, this.solidBind!)
    const count = data.length / SOLID_INSTANCE_FLOATS
    pass.draw(6, count)
    pass.end()
    this.drawCalls++
    this.triangles += count * 2
  }
  pass(target: Texture, u: Float32Array, inputs: Texture[], region?: Rect, channels = 15, filter?: {kind: 'tent'; radius: number}, clearOutside = false) {
    this.encodePass(target,u,inputs,region,channels,filter,clearOutside)
  }
  passFilterWindow(target: Texture, uniforms: Float32Array, inputs: Texture[], physicalWindow: Readonly<Rect>,
    channels: number, filter: {kind: 'tent'; radius: number}, availableBytes: number): boolean {
    if(import.meta.env.VITE_DESIGN_FILTER_SOURCE_WINDOW!=='1' || !this.managed || this.displayMath || this.displayFilters ||
        this.disposed || this.lost || !(uniforms instanceof Float32Array) || !(uniforms.buffer instanceof ArrayBuffer) || uniforms.length!==256 ||
        !Array.isArray(inputs) || !inputs.length || !filter || filter.kind!=='tent' || !Number.isFinite(filter.radius) ||
        filter.radius<=0 || filter.radius>2048 || !Number.isSafeInteger(availableBytes) || availableBytes<0 ||
        !Number.isInteger(channels) || channels<1 || channels>15 || uniforms[16]!==22 ||
        (uniforms[37]!==0 && uniforms[37]!==1) || uniforms[36]!==Math.fround(filter.radius) || uniforms[242]!==0 ||
        !uniforms.subarray(0,4).every(Number.isSafeInteger) || Math.abs(uniforms[0])>1048576 || Math.abs(uniforms[1])>1048576 ||
        uniforms[2]<1 || uniforms[3]<1 || uniforms[2]>16384 || uniforms[3]>16384 ||
        !this.textures.has(target) || inputs.some(input=>!this.textures.has(input)) ||
        target.binaryCoverage || target.scalarCoverage || inputs[0].binaryCoverage || inputs[0].scalarCoverage ||
        inputs.some(input=>input===target || input.resource===target.resource))return false
    const source=inputs[0], physical=source.resource as GPUTexture, output=target.resource as GPUTexture
    if(!physical || !output || output.format!=='rgba32float' || output.width!==uniforms[2] || output.height!==uniforms[3] ||
        target.width!==output.width || target.height!==output.height ||
        source.width!==physical.width || source.height!==physical.height || !this.filterPipelines.length)return false
    const window=snapshotFilterSourceWindow(physical,uniforms,physicalWindow)
    if(!window)return false
    // All caller-owned metadata is captured before a uniform-arena rollover
    // can submit work. Geometry grants no finite/opaque certificate.
    const captured=filterSourceWindowUniforms(uniforms,window),sources=inputs.slice(),parameters={kind:'tent' as const,radius:filter.radius}
    this.prepareWindowFilterPass(target,captured,sources,channels,parameters,availableBytes,window)
    this.encodePass(target,captured,sources,undefined,channels,parameters,false,window)
    return true
  }
  private encodePass(target: Texture, u: Float32Array, inputs: Texture[], region?: Rect, channels = 15,
    filter?: {kind: 'tent'; radius: number}, clearOutside = false, sourceWindow?: FilterSourceWindow) {
    if(u[16]===22)u=filterSourceWindowUniforms(u,sourceWindow)
    this.invalidateTextureCertificates(target)
    this.closeOver()
    if (inputs.includes(target)) throw new Error('GPU texture feedback loop')
    const rationalBoundBits = filter ? this.rationalKernelBoundBits(inputs[1], filter.radius) : 0
    if (this.prefixPolicy(u, channels, filter, inputs[1]) && filter && !region && channels===15 &&
        !this.displayMath && inputs[0]?.opaqueAlpha && import.meta.env.VITE_DESIGN_OPAQUE_TENT !== '0') {
      const complete=completeFilterAxisSupport({x:u[4],y:u[5],w:u[6],h:u[7]},
        {x:u[0],y:u[1],w:u[2],h:u[3]},u[37],filter.radius)
      if(complete && this.prefix!.encode(()=>this.encoder,target.resource as GPUTexture,
          [0,1,2].map(i=>(inputs[i]||this.blank).resource as GPUTexture),u,filter.radius,filter.kind,
          {x:u[0],y:u[1],w:u[2],h:u[3]},7,255,true,rationalBoundBits,sourceWindow)) {
        this.drawCalls+=this.prefix!.lastRenderPasses;this.opaqueTentPasses++;target.opaqueAlpha=true;return
      }
    }
    if (this.prefixPolicy(u, channels, filter, inputs[1]) && filter && !region && this.prefix!.encode(() => this.encoder, target.resource as GPUTexture,
      [0, 1, 2].map((i) => (inputs[i] || this.blank).resource as GPUTexture), u, filter.radius, filter.kind,
      {x:u[0],y:u[1],w:u[2],h:u[3]}, channels,255,false,rationalBoundBits,sourceWindow)) { this.drawCalls += this.prefix!.lastRenderPasses; return }
    const bind = this.bind(u, inputs)
    // With integer origins/sizes bounded by 2^20, pixel centres and every
    // subtraction/addition forming q/base are exactly representable binary32
    // integers or half-integers (<2^23). Thus the original sampler has k=0.
    // The corner helper also retains zero canonicalization and NaN neighbour order.
    const integerCentres = u.subarray(0, 16).every((v) => Number.isInteger(v) && Math.abs(v) <= 1048576) && u[242] === 0
    if (u[16] === IMAGE_RESOLVE_STEP_MODE && (!this.managed || this.displayMath || !integerCentres ||
        u[28] !== 3 || u[32] !== 1 || !Number.isInteger(u[17]) || u[17] < 0 || u[17] > 3 ||
        !inputs[0]?.binaryCoverage || inputs[1]?.finitePixels !== true || !inputs[3] ||
        channels !== 15 || !!region || !!target.binaryCoverage || !!target.scalarCoverage))
      throw new Error('精确图片累积缺少有效的有限输入证明')
    const displayImage = u[16] === IMAGE_RESOLVE_STEP_MODE && this.usesDisplayImageSource(inputs[1])
    if (target.binaryCoverage && ![12, 20, 31].includes(u[16]))
      throw new Error('Only binary coverage may write a binary mask texture')
    const displayFilter = this.managed && displayFilterPass(this.displayFilters, this.displayFilterRadiusLimit, !!this.displayFilterPipeline, u, channels, filter)
    if (displayFilter && this.displayFilterRadiusLimit !== undefined &&
        (target.scalarCoverage || target.binaryCoverage || sourceWindow || inputs[0]?.scalarCoverage || inputs[0]?.binaryCoverage))
      throw new Error('Bounded display filter requires ordinary RGBA source and target')
    if (displayFilter && this.displayFilterRadiusLimit === undefined && this.pairDisplayTaps && this.pairedDisplay && u[40] === 0 && channels === 15 && !region && inputs[0] && inputs[1]) {
      const bind = this.device.createBindGroup({ layout: this.pairedDisplay.layout, entries: [
        { binding: 0, resource: this.uniform(u) }, { binding: 1, resource: this.pairedDisplay.sampler },
        { binding: 2, resource: this.bindingCache.view((inputs[0].resource as GPUTexture)) },
        { binding: 3, resource: this.bindingCache.view((inputs[1].resource as GPUTexture)) },
      ] })
      const pass = this.encoder.beginRenderPass({ colorAttachments: [{
        view: this.bindingCache.view((target.resource as GPUTexture)), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0],
      }] })
      pass.setPipeline(this.pairedDisplay.pipeline); pass.setBindGroup(0, bind); pass.draw(3); pass.end()
      this.drawCalls++; this.pairedFilterPasses++; return
    }
    // Mode 6 composites a shadow from source + blurred alpha. The standalone
    // SDF/chrome shaders have different uniforms and cannot share this mode;
    // spare uniform lanes must never select them or require optional samplers.
    const sampleDispatch = this.sampleOnlyDispatch, resource = target.resource as GPUTexture
    const sampleFormat: GPUTextureFormat | undefined = this.managed === true
      ? target.scalarCoverage ? 'r32float' : target.binaryCoverage ? 'rgba8unorm' : 'rgba32float'
      : this.managed === false && !target.scalarCoverage && !target.binaryCoverage ? 'rgba8unorm' : undefined
    // Reuse createFormat's private resource/format record. Normal byte masks
    // share the RGBA8 sample shader with binary masks, never the RGBA32 one.
    const sampleCreation = this.byteTentTextures?.get(target)
    const sampleFlagsKnown = [target.scalarCoverage, target.binaryCoverage].every(value => value === undefined || value === true) &&
      !(target.scalarCoverage && target.binaryCoverage)
    const sampleOnly = this.sampleOnlyCoverageEnabled && this.sampleOnlyRequested && u[16] === 31 &&
      sampleDispatch?.target === target && sampleDispatch.uniform === u && sampleDispatch.buffer === this.curves &&
      sampleDispatch.epoch === this.resourceEpoch && this.textures.has(target) &&
      sampleFlagsKnown && sampleFormat !== undefined && !!sampleCreation && sampleCreation.resource === resource &&
      sampleCreation.format === sampleFormat && sampleCreation.width === target.width && sampleCreation.height === target.height &&
      target.bytes === target.width * target.height * (sampleFormat === 'rgba32float' ? 16 : 4) &&
      resource.format === sampleFormat && resource.width === target.width && resource.height === target.height
    const pipelines = target.scalarCoverage ? [u[16]===49?this.alphaResolvePipeline!:u[16]===22?this.scalarFilterPipeline!:u[16]===31?(sampleOnly?this.sampleOnlyScalarPipeline!:this.scalarAreaPipeline!):this.scalarPipelines.get(u[16])!] : displayFilter ? [this.displayFilterPipeline!] : target.binaryCoverage
      ? [u[16] === 31 ? (sampleOnly?this.sampleOnlyBytePipeline!:this.binaryAreaPipeline!) : this.binaryPipelines.get(u[16])!]
      : this.managed && u[16] === 22 ? this.filterPipelines : [
      u[16] === IMAGE_RESOLVE_STEP_MODE ? (displayImage ? this.displayImagePipeline! : this.imageResolveStepPipeline!) : u[16] === 50 ? this.shadowOverPipeline! : u[16] === 48 ? this.resolveStepPipeline! : u[16] === 47 ? this.solidPaintOverPipeline! : u[16] === 31 ? (sampleOnly?(this.managed===true?this.sampleOnlyColorPipeline!:this.sampleOnlyBytePipeline!):this.areaPipeline!) : this.managed && u[16] === 3 && u[17] === 0
        ? (integerCentres ? this.normalCornerPipeline! : this.normalPipeline!) :
      this.managed && u[16] === 0 ? (integerCentres ? this.copyCornerPipeline! : this.copyPipeline!) :
      this.managed ? this.modePipelines.get(u[16])! : this.paintPipeline]
    if (!pipelines.length || pipelines.some((pipeline) => !pipeline)) throw new Error(`Exact compositor pipeline ${u[16]} not prepared`)
    // The exact channel pipelines read only source textures, never this
    // attachment, and write disjoint channels without blending. Keep their
    // four reducers/draws in the original order, but clear/store the shared
    // attachment once. No arithmetic, sampler, or filter support changes.
    // Scissored/partial-channel work and per-channel timestamp probes retain
    // the established clear/load and query boundaries below.
    if (this.managed && u[16] === 22 && !displayFilter && !target.scalarCoverage &&
        !target.binaryCoverage && pipelines === this.filterPipelines && pipelines.length === 4 &&
        channels === 15 && !region && !this.timingQueries) {
      const pass = this.encoder.beginRenderPass({ colorAttachments: [{
        view: this.bindingCache.view(target.resource as GPUTexture),
        loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0],
      }] })
      for (const pipeline of pipelines) {
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, bind.group, bind.offsets)
        pass.draw(3)
        this.drawCalls++
      }
      pass.end()
      this.mergedExactFilterPasses++
      return
    }
    let drawn = false
    for (let channel = 0; channel < pipelines.length; channel++) {
    if (this.managed && u[16] === 22 && !displayFilter && !target.scalarCoverage && !(channels & (1 << channel))) continue
    const timestampWrites = this.timingQueries ? this.timestampWrites({ mode: u[16], radius: u[36], width: region?.w || target.width, height: region?.h || target.height,
      ...(u[16] === 3 ? { blend: u[17], integerCentres } : {}), ...(u[16] === 2 ? { paint: u[28] } : {}) }) : undefined
    const pass = this.encoder.beginRenderPass({
      ...(timestampWrites ? { timestampWrites } : {}),
      colorAttachments: [
        {
          view: this.bindingCache.view((target.resource as GPUTexture)),
          loadOp: region && !clearOutside || drawn ? 'load' : 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 0],
        },
      ],
    })
    pass.setPipeline(pipelines[channel])
    pass.setBindGroup(0, bind.group, bind.offsets)
    if (region) pass.setScissorRect(region.x, region.y, region.w, region.h)
    pass.draw(3)
    pass.end()
    drawn = true
    this.drawCalls++
    if (sampleOnly) {
      this.sampleOnlyCoveragePasses++; this.sampleOnlyCoveragePixels += target.width * target.height
      this.sampleOnlyCoverageLifetimePasses++; this.sampleOnlyCoverageLifetimePixels += target.width * target.height
    }
    if (displayFilter && this.displayFilterRadiusLimit !== undefined) this.boundedDisplayFilterPasses++
    if (displayImage) {
      this.displayImageSourcePasses++
      recordGpuDiagnostic('cache', { displayImageSourcePasses: 1 })
    }
    }
  }
  private timestampWrites(row: typeof this.timingRows[number]): GPUComputePassTimestampWrites | undefined {
    if (!this.timingQueries) return
    const index = this.timingRows.length * 2
    if (index >= 4096) { this.timingSkipped++; return }
    this.timingRows.push(row)
    return { querySet: this.timingQueries, beginningOfPassWriteIndex: index, endOfPassWriteIndex: index + 1 }
  }
  over(target: Texture, u: Float32Array, inputs: Texture[], region: Rect) {
    this.invalidateTextureCertificates(target)
    if (this.managed) throw new Error('RGBA32F 合成必须使用显式着色器混合')
    if (inputs.includes(target)) throw new Error('GPU texture feedback loop')
    if (this.activeTarget !== target) this.closeOver()
    const bind = this.bind(u, inputs)
    const pass =
      this.activeOver ||
      this.encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.bindingCache.view((target.resource as GPUTexture)),
            loadOp: 'load',
            storeOp: 'store',
          },
        ],
      })
    this.activeOver = pass
    this.activeTarget = target
    pass.setPipeline(this.overPipeline)
    pass.setBindGroup(0, bind.group, bind.offsets)
    pass.setScissorRect(region.x, region.y, region.w, region.h)
    pass.draw(3)
    this.drawCalls++
  }
  private closeOver() {
    this.activeOver?.end()
    this.activeOver = undefined
    this.activeTarget = undefined
  }
  async finish(
    source: Texture,
    r: Rect,
    width: number,
    height: number,
    readback: boolean,
    preview?: PreviewPresentation,
    present = true,
    outputRect?: Rect,
  ) {
    let captured: { id: number; texture: GPUTexture } | undefined
    try {
    this.collectCompletedImageTables()
    this.closeOver()
    const bytePreview = !!preview && this.managed && !this.linearLight
    // Peak transient bytes this finish call itself allocates (shown copy,
    // readback target, MAP_READ staging). Pure accounting.
    let finishTransient = 0
    if (present) {
    if (this.captureDisplay && this.presenter && !readback && !this.hdr) captured = withRenderFailureStage(10, () => this.presenter!.capture(width, height))
    if (this.canvas.width !== width) this.canvas.width = width
    if (this.canvas.height !== height) this.canvas.height = height
    const u = parameters(outputRect || { x: 0, y: 0, w: width, h: height }, r)
    u[16] = 14
    u[242] = this.linearLight ? 1 : 0
    u[243] = this.hdr ? 1 : 0
    u[244] = this.managed && !this.linearLight && !this.hdr ? 1 : 0
    previewUniforms(u, preview, true)
    if (bytePreview) u[16] = 33
    let shown = source
    if (preview) {
      shown = this.create(width, height)
      const resolve = u.slice()
      resolve[242] = 0 // Convert display color exactly once, in exactPresent.
      this.pass(shown, resolve, [source])
      this.transientTargets.push(shown)
      this.transientBytes += shown.bytes
      finishTransient += shown.bytes
      u.set([0, 0, width, height], 0)
      u.set([0, 0, width, height], 4)
      u[16] = 14
    }
    const bind = this.bind(u, [shown])
    const pass = this.encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.bindingCache.view((captured?.texture || withRenderFailureStage(10, () => this.context.getCurrentTexture()))),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 0],
        },
      ],
    })
    pass.setPipeline(this.presentPipeline)
    pass.setBindGroup(0, bind.group, bind.offsets)
    pass.draw(3)
    pass.end()
    this.drawCalls++
    }
    let buffer: GPUBuffer | undefined, output: Texture | undefined
    const bpp = this.managed ? 16 : 4
    const stride = Math.ceil((width * bpp) / 256) * 256
    if (readback) {
      output = this.create(width, height)
      const copy = parameters(outputRect || { x: 0, y: 0, w: width, h: height }, r)
      previewUniforms(copy, preview)
      if (bytePreview) copy[16] = 33
      this.pass(output, copy, [source])
      buffer = this.device.createBuffer({
        size: stride * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      })
      finishTransient += output.bytes + stride * height
      this.encoder.copyTextureToBuffer(
        { texture: output.resource as GPUTexture },
        { buffer, bytesPerRow: stride },
        [width, height],
      )
    }
    // Finish-path transient accounting: the presentation copy, the readback
    // target and the MAP_READ staging buffer coexist at this peak. Pure
    // bookkeeping — no allocation or command changes.
    this.finishTransientBytes = Math.max(this.finishTransientBytes, finishTransient)
    let timingRead: GPUBuffer | undefined, timingResolve: GPUBuffer | undefined
    if (this.timingQueries && this.timingRows.length) {
      const size = this.timingRows.length * 16
      timingResolve = this.device.createBuffer({ size, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC })
      timingRead = this.device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
      this.encoder.resolveQuerySet(this.timingQueries, 0, this.timingRows.length * 2, timingResolve, 0)
      this.encoder.copyBufferToBuffer(timingResolve, 0, timingRead, 0, size)
    }
    const retainFilterScratch = this.residentFilterScratch && !!captured && !readback && !timingRead
    const retiredTables = this.retiredImageTableSnapshot(true)
    // A captured texture is consumed on this same device/queue. Returning its
    // handle need not wait merely to destroy image-table buffers. It is NOT a
    // GPU-complete or physical-presentation acknowledgement.
    const deferImageScratch = !!captured && !readback && !timingRead &&
      !this.transientTargets.length && !this.transient.length && !this.transientBytes && this.canDeferImageTables()
    // Keep the existing interaction/periodic backpressure. Only per-tile waits
    // whose purpose was scratch destruction or diagnostic counters disappear.
    const waitReason: QueueWaitReason | undefined = readback ? 'readback' : timingRead ? 'timing' :
      this.byteTentLeases?.size ? 'prefix-scratch' :
      !retainFilterScratch && this.prefix?.scratchBytes ? 'prefix-scratch' :
      !deferImageScratch && this.imageTables.size ? 'image-table-scratch' : this.interactionPresentation &&
        (!this.nativeInteractionPresentation || import.meta.env.VITE_DESIGN_NATIVE_PIPELINE !== '1') ? 'interaction' :
        ++this.presentationSubmissions >= 4 ? 'periodic' : undefined
    // Counters do not authorize pixels: each GPU line already selects its
    // certified result or exact fallback. Read statistics only at an existing
    // completion boundary; never map the same staging buffer while in flight.
    const readPrefixCounters = !!this.prefix?.scratchBytes && !!waitReason
    if (readPrefixCounters) this.prefix!.encodeCountersReadback(this.encoder)
    this.uploadUniforms()
    this.submitEncoder()
    this.commandSubmissions++
    const byteTentSnapshot = this.byteTentSnapshot()
    // Presentation-only tiles stay on the GPU timeline. Submitted commands
    // retain their resources; subsequent uploads are ordered by the queue.
    // Readbacks/probes still fence before reading or reusing mapped storage.
    if (waitReason) {
      const epoch = this.resourceEpoch
      const coveredCompletion = this.waitForQueue(waitReason)
      await coveredCompletion
      if (!this.lost) this.completedResourceEpoch = Math.max(this.completedResourceEpoch, epoch)
      if (this.lost) throw new Error('GPU 设备已丢失')
      await this.retireByteTentSnapshot(byteTentSnapshot, coveredCompletion)
      this.collectRetiredImageTables(retiredTables)
      this.presentationSubmissions = 0
    } else if (retiredTables.length) {
      this.deferImageTables(retiredTables)
    }
    const error = await this.device.popErrorScope()
    this.frameScopeOpen = false
    if (error || this.errors.length)
      throw markRenderFailure(new Error([error?.message, ...this.errors].filter(Boolean).join('\n')), { failureStage: 7, failureCategory: error ? renderFailureFields(error).failureCategory : this.lost ? 4 : 0, failureCode: 201 })
    // Keep the existing submitted-geometry shrink policy. Filter storage above
    // is reclaimed only by the actual completed snapshot, never by this ACK.
    if (waitReason || this.completedResourceEpoch >= this.resourceEpoch) this.shrinkCapacities()
    if (readPrefixCounters) {
      const counters=await this.prefix!.readCounters()
      this.prefixCounterSamples++
      recordGpuDiagnostic('prefix',counters)
      if(!gpuDiagnosticsEnabled())console.debug('DESIGN_GPU_PREFIX ' + JSON.stringify(counters))
      if (!retainFilterScratch) this.prefix!.releaseScratch()
    } else if (this.prefix?.scratchBytes) {
      this.prefixCounterDeferredFrames++
    }
    if (timingRead) {
      await timingRead.mapAsync(GPUMapMode.READ)
      const values = new BigUint64Array(timingRead.getMappedRange())
      const totals = new Map<string, { mode: number; radius: number; width: number; height: number; count: number; ms: number }>()
      this.timingRows.forEach((row, i) => {
        const key = JSON.stringify(row), entry = totals.get(key) || { ...row, count: 0, ms: 0 }
        entry.count++; entry.ms += Number(values[i * 2 + 1] - values[i * 2]) / 1e6; totals.set(key, entry)
      })
      this.passTimings = [...totals.values()].sort((a, b) => b.ms - a.ms)
      console.debug('DESIGN_GPU_PROFILE ' + JSON.stringify(this.passTimings))
      if (this.timingSkipped) console.debug('DESIGN_GPU_PROFILE_SAMPLING ' + JSON.stringify({ recorded:this.timingRows.length,skipped:this.timingSkipped }))
      timingRead.unmap(); timingRead.destroy(); timingResolve?.destroy()
    }
    let rgba: Uint8Array | undefined,
      linear: Float32Array | undefined,
      straightRgba: Uint8Array | undefined
    if (buffer) {
      await buffer.mapAsync(GPUMapMode.READ)
      this.rasterReadbackBytes += stride * height
      const data = new Uint8Array(buffer.getMappedRange())
      rgba = new Uint8Array(width * height * bpp)
      for (let y = 0; y < height; y++)
        rgba.set(data.subarray(y * stride, y * stride + width * bpp), y * width * bpp)
      if (this.managed) {
        linear = new Float32Array(rgba.buffer)
        rgba = undefined
      }
      buffer.unmap()
      buffer.destroy()
      if (output) this.destroy(output)
    }
    for (const t of this.transientTargets) this.destroy(t)
    this.transientTargets = []
    for (const t of this.transient) t.destroy()
    this.transient = []
    this.msaa.clear()
    this.transientBytes = 0
    if (bytePreview && linear) {
      straightRgba = Uint8Array.from(linear, (v) => Math.round(Math.max(0, Math.min(1, v)) * 255))
      linear = undefined
    }
    if (rgba && preview && preview.scale < 1) {
      straightRgba = minifiedPreviewRgba8(rgba)
      rgba = undefined
    }
    const bitmap = present && !captured ? withRenderFailureStage(10, () => this.canvas.transferToImageBitmap()) : undefined
    if (bitmap) this.crossDeviceBitmaps++
    if (captured) this.residentCaptures++
    this.submittedBoundaryReady = true
    return { gpuTile: captured?.id, bitmap, rgba, linear, straightRgba }
    } catch (error) {
      if (captured) this.presenter?.release([captured.id])
      if (isDisplayBudgetError(error)) await this.abortFrameAndReleaseFilterScratch()
      throw error
    }
  }
  /** Byte-level GPU memory accounting. Frame fields refer to the most recent
   * begin/finish cycle; capacity fields are current high-water allocations. */
  stats() {
    let textureBytes = 0
    for (const texture of this.textures) textureBytes += texture.bytes
    return {
      textureBytes:textureBytes+(this.presenter?.residentBytes||0),
      displayTextureBytes:this.presenter?.residentBytes||0,
      transientBytes: this.transientBytes,
      finishTransientBytes: this.finishTransientBytes,
      frameScratchBytes: this.frameScratchBytes,
      prefixCounterSamples: this.prefixCounterSamples,
      prefixCounterDeferredFrames: this.prefixCounterDeferredFrames,
      scratchBytes: this.scratchBytes,
      vertexBufferBytes: this.vertexCapacity,
      curveBufferBytes: this.curveCapacity,
      geometryUploadBytes: this.geometryUploadBytes,
      adapter: this.description,
      // Driver-lifetime raster transport only. Explicit picking/QA captures
      // in ResidentPresenter are separate from ordinary canvas presentation.
      rasterReadbackBytes:this.rasterReadbackBytes,
      crossDeviceBitmaps:this.crossDeviceBitmaps,residentCaptures:this.residentCaptures,
      geometryMirrorBytes: this.curveMirror.bytes + this.vertexMirror.bytes,
      residentProgramBytes:this.programArena.bytes,
      residentProgramHits:this.programHits,residentProgramHitBytes:this.programHitBytes,
      solidBufferBytes: this.solidBuffer?.size ?? 0,
      uniformBufferBytes: this.uniforms?.size ?? 0,
      deviceLost: this.lost,
      queueWaits: this.queueWaitStats.snapshot(this.resourceEpoch, this.completedResourceEpoch),
      pipelineBuilds: this.pipelines.builds, pipelineBuildMs: this.pipelines.buildMs, pipelineReady: this.pipelines.ready,
      passTimings: this.passTimings,
      textureViewCreates: this.bindingCache.viewCreates,
      bindGroupCreates: this.bindingCache.groupCreates,
      bindGroupHits: this.bindingCache.groupHits,
      bindGroupCacheSize: this.bindingCache.size,
      dynamicUniformBindings: this.dynamicUniformBindings,
      mergedExactFilterPasses: this.mergedExactFilterPasses,
      displayImageSourcePasses: this.displayImageSourcePasses,
      boundedDisplayFilterPasses: this.boundedDisplayFilterPasses,
      byteTentAlphaPasses: this.byteTentAlphaPasses,
      sampleOnlyCoveragePasses: this.sampleOnlyCoveragePasses,
      sampleOnlyCoveragePixels: this.sampleOnlyCoveragePixels,
      sampleOnlyCoverageLifetimePasses: this.sampleOnlyCoverageLifetimePasses,
      sampleOnlyCoverageLifetimePixels: this.sampleOnlyCoverageLifetimePixels,
      sampleOnlyCoverageEligibleScenes: this.sampleOnlyCoverageEligibleScenes,
      byteTentScratchBytes: [...(this.byteTentLeases?.keys() || [])].reduce((sum, lease) => sum + lease.bytes, 0),
    }
  }
  async loseDeviceForTesting() {
    if (!import.meta.env.DEV) throw new Error('Development check only')
    this.terminal = true
    this.device.destroy()
    await this.device.lost
    if (!this.lost) throw new Error('WebGPU device loss was not observed')
  }
  dispose() {
    this.submittedBoundaryReady = false; this.submittedBoundaryGeneration++
    this.bindingCache.clear()
    if (this.disposed) return
    this.disposed = true
    this.closeOver()
    if (this.initialized && !this.terminal && !this.lost && this.poolKey !== undefined) {
      // Park instead of destroying: non-device-lost teardown (budget-failure
      // recovery, preview tile splits) re-creates the GPU stack within
      // milliseconds and reuses this device and its compiled pipelines; only
      // renderer-level accounting is rebuilt around it. The reaper frees the
      // device when no matching create follows.
      if (WebGpuDriver.parkedDriver) {
        const previous = WebGpuDriver.parkedDriver
        WebGpuDriver.parkedDriver = undefined
        clearTimeout(previous.reaper)
        void previous.settled.then(
          () => previous.driver.destroyDeviceNow(),
          () => previous.driver.destroyDeviceNow(),
        )
      }
      this.parkedForReuse = true
      recordDeviceLifecycle(this, deviceLifecyclePhase.parked, this.lifecycleFields())
      const settled = this.reclaimForPark()
      // Observe immediately without replacing the rejected promise: revive
      // must still reject uncertain cleanup instead of inheriting its ledger.
      void settled.catch(() => {})
      const reaper = setTimeout(() => {
        if (WebGpuDriver.parkedDriver?.driver === this) {
          WebGpuDriver.parkedDriver = undefined
          console.debug(`DESIGN_GPU_PARK ${JSON.stringify({ event: 'reaped' })}`)
          this.destroyDeviceNow()
        }
      }, PARKED_REAP_MS)
      WebGpuDriver.parkedDriver = { driver: this, key: this.poolKey, settled, reaper }
      return
    }
    this.destroyDeviceNow()
  }
  /** Full synchronous teardown: reclaim every resource and destroy the device. */
  private destroyDeviceNow() {
    this.terminal = true
    recordDeviceLifecycle(this, deviceLifecyclePhase.disposed, this.lifecycleFields())
    this.presenter?.dispose(); this.presenter = undefined
    this.parkedForReuse = false
    this.closeOver()
    // Explicit device destruction, unlike an ordinary rejected queue fence,
    // retires every submitted command and its byte-prefix lease.
    this.device?.destroy()
    this.disposeByteTentLeases()
    this.releaseFrameResources(false)
    this.prefix?.destroy()
    this.prefix = undefined
    this.timingQueries?.destroy()
    this.timingQueries = undefined
    this.uniforms?.destroy()
  }
  /** Fence submitted commands, then reclaim frame resources while keeping the
   * device, pipelines and uniform arena for a matching future create. */
  private reclaimForPark(): Promise<void> {
    return (async () => {
      this.abandonByteTentEncoder()
      const byteTentSnapshot = this.byteTentSnapshot()
      const coveredCompletion = this.waitForQueue('park')
      await coveredCompletion
      if (!this.parkedForReuse || this.lost) return
      await this.retireByteTentSnapshot(byteTentSnapshot, coveredCompletion)
      this.releaseFrameResources()
      // A failed frame can leave its validation scope open. Its error was
      // already thrown to the caller; pop the scope so a revived driver's
      // scope stack is balanced for its next frame.
      if (this.frameScopeOpen) {
        this.frameScopeOpen = false
        try {
          const stale = await this.device.popErrorScope()
          if (stale)
            console.debug(`DESIGN_GPU_PARK ${JSON.stringify({ event: 'stale-scope-dropped', message: stale.message })}`)
        } catch (error) {
          console.debug(`DESIGN_GPU_PARK ${JSON.stringify({ event: 'stale-scope-pop-failed', error: String(error) })}`)
        }
      }
      this.errors = []
    })()
  }
  /** Restore a parked driver to its post-initialize state; only valid after
   * the park cleanup settled. */
  private async revive() {
    this.submittedBoundaryReady = false; this.submittedBoundaryGeneration++
    this.disposed = false
    this.parkedForReuse = false
    this.errors = []
    this.encoder = this.device.createCommandEncoder()
    this.blank = this.create(1, 1)
    this.clear(this.blank)
    this.byteTentRecordingFailed = false
    this.submitEncoder()
    this.commandSubmissions = 1
    await this.waitForQueue('initialization')
    this.submittedBoundaryReady = true
  }
  /** Reclaim frame-scoped resources: textures, MSAA/transient scratch, geometry
   * and solid buffers, and per-frame counters. Call only after submitted
   * commands completed (park path) or after device loss (every destroy is then
   * a safe no-op). */
  private releaseFrameResources(recreateEncoder = true) {
    this.preparedGeometryOwner = undefined
    this.submittedBoundaryReady = false; this.submittedBoundaryGeneration++
    this.sampleOnlyPrograms.reset(); this.sampleOnlyDispatch = undefined; this.sampleOnlyRequested = false
    this.discardByteTentEncoder(this.encoder)
    this.displayImageRequested = false
    this.prefix?.releaseScratch()
    this.releaseImageTables()
    for (const t of [...this.textures]) this.destroy(t)
    for (const t of this.transientTargets) this.destroy(t)
    this.transientTargets = []
    for (const t of this.transient) t.destroy()
    this.transient = []
    this.msaa.clear()
    this.transientBytes = 0
    this.vertices?.destroy()
    this.vertices = undefined
    this.vertexCapacity = 0
    this.curves?.destroy()
    this.curveMirror.reset(); this.vertexMirror.reset()
    this.programArena.reset();this.programOffsets=undefined;this.programGpuValid=false;this.programArenaActive=false
    this.curves = undefined
    this.curveCapacity = 0
    this.solidBuffer?.destroy()
    this.solidBuffer = undefined
    this.solidBind = undefined
    this.solidRanges.clear()
    this.solidOffset = 0
    this.solidUploaded = 0
    this.vertexShrink = { frames: 0, maxDemand: 0 }
    this.curveShrink = { frames: 0, maxDemand: 0 }
    this.offset = 0
    this.uploadedOffset = 0
    this.uniformCommands = 0
    this.frameScratchBytes = 0
    this.finishTransientBytes = 0
    this.timingRows = []
    this.softwareRaster = false
    this.activeTarget = undefined
    if (recreateEncoder && this.device && !this.lost) this.encoder = this.device.createCommandEncoder()
  }
  /** device.lost handler body: reclaim immediately instead of waiting for the
   * next request to dispose. */
  private releaseLostResources() {
    this.bindingCache.clear()
    console.debug(
      `DESIGN_GPU_LOST ${JSON.stringify({ event: 'immediate-cleanup', textures: this.textures.size })}`,
    )
    this.disposeByteTentLeases()
    this.releaseFrameResources()
  }
}
