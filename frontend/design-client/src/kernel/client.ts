import { documentCapacity } from '../document-capacity'
import { markRenderFailure, renderFailureFields } from './render-failure-telemetry'
import { HandledTileDeliveryError } from './tile-admission'
import { FrameMeasurements } from './frame-measurements'
import { bindCanvasGrid, GridMeasurements } from './grid-measurements'
import { documentPatch } from '../document-patch'
import { boundedPatchWire, prepareAuthoredPatchTransition } from './authored-patch-transition'
import { operationCorrelation } from '../canvas-operation-terminal'
import { AuthoredPreparationBinding } from './authored-preparation-binding'
import type { PreparationStateReceiptV1 } from './preparation-state'
import { bindNavigationInput, NavigationInputTrace } from './navigation-input'
import { createRenderDiagnostics, sanitizeRecord, sanitizeBatch, renderRequestCategories, renderResultReason, sanitizeFields as sanitizeRecordFields, PREFIX } from '../../../design-desktop/src/render-terminal-diagnostics.mjs'
import { NavigationJournal, validateNavigationJournalOptions } from './navigation-journal'
import { recordRenderDiagnostic, renderBudgetDiagnostic, renderErrorWithBudget } from './render-diagnostics'
import type { RasterTile } from './tile-cache'
import type { DesignDocument } from '../model'
import type { BackendPreference } from './gpu/types'
import { hostRenderPolicy, effectiveBackend, allowsResidentSdr } from './render-policy'
import {residentFrameMessage} from './gpu/resident-frame'
import { recordRenderProfile } from './render-profile'
import { connectNativePreparation } from './native-preparation'
import { currentPreparedDocumentJson } from '../prepared-document'
import { interactionDocumentSource } from './interaction-document-source'
import { sourceRenderSnapshot, type SourceRenderSnapshot } from './source-render-snapshot'

// The immutable preload bridge is installed before this module evaluates.
// Neither localStorage nor a render request can relax this launch policy.
const desktopHost = typeof window !== 'undefined' ? window.coreDesktop : undefined

/** HDR presentation is opt-in configuration, default off. Managed documents
 * retain linear computation for color correctness; this bit controls float
 * display payloads/presenters and optional unmanaged float composition. SDR
 * byte display payloads are the production default. Precedence: the build-time env forces
 * the bit for gated checks (check-hdr-memory spawns VITE_DESIGN_HDR=1); an
 * explicit localStorage key lets a host toggle without rebuilding. The value
 * is pinned once per page load into the frozen render policy. */
function hdrCompositingSetting(): boolean {
  if (import.meta.env.VITE_DESIGN_HDR === '1') return true
  if (import.meta.env.VITE_DESIGN_HDR === '0') return false
  try {
    return localStorage.getItem('forma.render.hdr') === '1'
  } catch {
    /* Storage is optional; SDR stays the default. */
  }
  return false
}
/** Image mip-chain sampling is opt-in configuration, default off. Level
 * selection changes minified image bytes, so it ships behind the same
 * precedence chain as HDR: build-time env for gated checks, localStorage
 * for host toggles, pinned once per page load. */
function imageMipsSetting(): boolean {
  if (import.meta.env.VITE_DESIGN_MIPS === '1') return true
  if (import.meta.env.VITE_DESIGN_MIPS === '0') return false
  try {
    return localStorage.getItem('forma.render.mips') === '1'
  } catch {
    /* Storage is optional; single-tap sampling stays the default. */
  }
  return false
}
/** Atlas packing of grid-sampled images is opt-in configuration, default
 * off. Packing is byte-exact by construction (zero-padded slots, placed
 * grids), so the bit only changes texture residency. */
function imageAtlasSetting(): boolean {
  if (import.meta.env.VITE_DESIGN_IMAGE_ATLAS === '1') return true
  if (import.meta.env.VITE_DESIGN_IMAGE_ATLAS === '0') return false
  try {
    return localStorage.getItem('forma.render.atlas') === '1'
  } catch {
    /* Storage is optional; standalone textures stay the default. */
  }
  return false
}
export const renderExecutionPolicy = hostRenderPolicy(
  !!desktopHost,
  desktopHost?.renderPolicy?.cpuOnly,
  hdrCompositingSetting(),
  imageMipsSetting(),
  imageAtlasSetting(),
  // Screen sampling is pinned at launch. It does not relax the
  // desktop effect/coverage contract or enable native display arithmetic.
  import.meta.env.VITE_DESIGN_DESKTOP_DISPLAY !== '0',
  desktopHost?.renderPolicy?.gpuWorkingBudgetMiB,
)
export function backendPreference(): BackendPreference {
  // One product renderer. Legacy per-browser choices must not silently put a
  // returning document on another backend. Trusted CPU-only hosts and explicit
  // internal reference/export requests keep their execution-policy contract.
  return effectiveBackend(renderExecutionPolicy, 'webgpu')
}

/** Page-wide GPU holder limit. Every KernelClient owns one render worker, and
 * that worker holds at most one GPU device (plus its pool budget) for its
 * lifetime, so at most MAX_ACTIVE_GPU_CLIENTS clients may actively drive the
 * GPU at once. A GPU-capable request from a client beyond the limit queues
 * (FIFO) until a holder disposes or its worker is reset by timeout/error;
 * CPU-only requests never queue. Every queue transition is traced at
 * console.debug level so starvation is observable. */
const MAX_ACTIVE_GPU_CLIENTS = 2
type GpuPermitWaiter = { resolve: () => void; reject: (error: Error) => void }
let activeGpuClients = 0
const gpuClientQueue: GpuPermitWaiter[] = []

/** Live KernelClient registry. Debug tooling (the GPU memory panel) queries
 * the worker that already owns the GPU device instead of spawning another. */
const activeClients = new Set<KernelClient>()
export function activeKernelClients(): readonly KernelClient[] {
  return [...activeClients]
}

/** Byte-level renderer memory fields observed on the most recent successful
 * render result. GPU frame fields are max-aggregates over the request's tiles
 * (the worker already aggregates them); CPU results carry none. */
export type RendererMemorySample = {
  at: number
  backend?: 'webgpu' | 'webgl2' | 'cpu'
  workingTextureBytes?: number
  peakTextureBytes?: number
  finishTransientBytes?: number
  tileCacheBytes?: number
}
let latestMemory: RendererMemorySample | undefined
const memoryListeners = new Set<() => void>()
function publishRendererMemory(sample: Omit<RendererMemorySample, 'at'>) {
  latestMemory = { ...sample, at: Date.now() }
  for (const listener of memoryListeners) listener()
}
export function latestRendererMemory(): RendererMemorySample | undefined {
  return latestMemory
}
export function subscribeRendererMemory(listener: () => void): () => void {
  memoryListeners.add(listener)
  return () => {
    memoryListeners.delete(listener)
  }
}

/** WebGPU driver ledger (Driver.stats in gpu/types.ts). The WebGL2 driver
 * implements no stats(); the field stays null there. */
export type GpuDriverMemoryStats = {
  textureBytes: number
  displayTextureBytes?:number
  transientBytes: number
  finishTransientBytes: number
  frameScratchBytes: number
  scratchBytes: number
  vertexBufferBytes: number
  curveBufferBytes: number
  solidBufferBytes: number
  uniformBufferBytes: number
  textureViewCreates?: number
  bindGroupCreates?: number
  bindGroupHits?: number
  bindGroupCacheSize?: number
  deviceLost: boolean
  adapter?: string
  rasterReadbackBytes?: number
  crossDeviceBitmaps?: number
  residentCaptures?: number
}
/** Debug snapshot from the worker that owns the live engine and GPU device. */
export type GpuMemorySnapshot = {
  rendererPolicy?: { workingBudgetBytes: number; interactionBudgetBytes: number } | null
  displayMath?: boolean
  /** VectorEngine.gpu_memory_breakdown() JSON; null until the worker engine
   * finished its one-time wasm/font load. Zeros on web — the kernel itself
   * allocates no GPU memory in the browser. */
  kernelBreakdown: string | null
  /** Active GPU backend; null when only CPU rendering has run. */
  backend: 'webgpu' | 'webgl2' | null
  driverStats: GpuDriverMemoryStats | null
  deviceLost: boolean
}
export type KernelOptions = {
  gpuPageBackground?: boolean;
  /** Native render-only root visibility; authored document/receipts stay intact. */
  gpuRoots?: string[];
  gpuNeutralPageGroup?: boolean;
  /** Overwritten by the worker's strict host experiment policy. */
  gpuGaussianRegions?: boolean
  gpuPainterSupport?: boolean
  /** Separately gated captured-source optimization; never document state. */
  gpuPainterCaptureReads?: boolean
  /** A separate document/geometry lane on the same display GPU worker. */
  interactionChannel?: boolean
  /** Numeric capture identity for diagnostics only, never a document certificate. */
  interactionOwner?: number
  interactionGeneration?: number
  interactionBranch?: number
  /** Presentation intent is independent of readback. Only transient previews
   * may reduce effects; settled frames and exports retain full computation. */
  renderIntent?: 'preview' | 'settled' | 'canvas'
  /** Worker-derived quality bit; overwritten from renderIntent on receipt. */
  interactiveEffects?: boolean
  checkerboard?: boolean
  exportFormat?: 'jpeg' | 'webp' | 'pdf'
  /** Exact interactive presentation may tile an oversized target without reducing density. */
  livePreview?: boolean
  /** Optional bounded four-sample viewport; unsupported scenes retain tiles. */
  sequentialViewport?: boolean
  /** Transient Web interaction graph reuse; never an exact/export option. */
  retainInteractionGraph?: boolean
  /** Recompile changed coverage at the real sample phase; retain exact sources only. */
  interactionNative?: boolean
  /** Full-viewport native affine capture; never a cached-pixel warp. */
  interactionAffine?: boolean
  /** Ancestors of a moving nested object must remain live compositions. */
  interactionSelection?: string[]
  /** Visible interior of a guarded transient capture, in capture pixels. */
  /** A proven stationary clipped root bounds every changed output pixel. */
  interactionWindowFixed?: boolean
  interactionWindow?: import('./gpu/types').Rect
  previewTileFallback?: boolean
  tileViewport?: RasterTile[]
  /** Parallel original-index hints: holes, coarse coverage, sharp coverage. */
  tileFillPriorities?: import('./tile-cache').TileFillPriority[]
  /** Bounded native viewport capture on the same world sample lattice as tiles. */
  captureViewport?: import('./gpu/types').Rect
  /** Shared geometry preparation guard for a complete camera plan. */
  tilePrepareViewport?: import('./gpu/types').Rect
  /** Page coverage survives camera-plan cancellation; content cancellation still fences it. */
  coverageTiles?: boolean
  /** Explicit displayed-document session owner for exact tile reuse. */
  tileOwner?: { documentId: string; sessionEpoch: number }
  exportRegion?: { bounds: import('../model').Bounds; scale: number; nodeIds?: string[] }
  colorOutput?: import('../color').ColorOutput
  animation?: import('../animation').AnimationSample
  rasterProfile?: 'analytic' | 'figma' | 'figmaSubpixel' | 'figmaSoftware'
  pixelPreview?: 1 | 2
  pageId: string
  width: number
  height: number
  view: { x: number; y: number; zoom: number }
  transparent: boolean
  grid: boolean
}
export type KernelStats = {
  backdropReads: number
  effectLayers: number
  nodes: number
  culled: number
  pathSegments: number
  shadedPixels: number
  peakLayerPixels: number
  allocatedLayerPixels: number
}
export type KernelResult = {
  contentPixel?:number[]
  contentFrame?:import('./resident-presentation').ResidentAcknowledgement
  gpuTile?: number
  residentInteraction?: boolean
  documentForks?: number
  retainedCommit?: boolean
  backgroundLinear?:[number,number,number,number]
  imageAxisFields?: number
  imageFieldBytes?: number
  displayMath?: boolean
  pairedFilterPasses?: number
  bitmapExtended?: boolean
  linear?: Float32Array
  colorManagement?: import('../color').ColorSettings
  intermediateFormat?: string
  backdropReads?: number
  hybridEffects?: number
  materialFieldHits?: number
  materialFieldBuilds?: number
  materialFieldBuildMs?: number
  materialFieldUploadBytes?: number
  effectLayers?: number
  bytes: Uint8Array
  stats: KernelStats
  milliseconds: number
  bitmap?: ImageBitmap
  backend: 'webgpu' | 'webgl2' | 'cpu'
  drawCalls: number
  commandSubmissions?: number
  triangles: number
  reason?: string
  compileMs: number
  compileCacheHit?: boolean
  pipelineWallMs?: number
  preparationWaitMs?: number
  overlappedPreparations?: number
  frameResourceHits?: number
  frameResourceBytes?: number
  retainedPrefixHits?: number
  retainedGroupHits?: number
  retainedGroupBytes?: number
  renderMs: number
  description?: string
  serializeMs: number
  roundTripMs: number
  loadMs: number
  graphMs?: number
  checkpointMs?: number
  finishMs?: number
  passPixels?: number
  workingTextureBytes?: number
  peakTextureBytes?: number
  finishTransientBytes?: number
  previewTiles?: number
  previewLeaves?: number
  bitmapLeaves?: number
  injectedBudgetFailures?: number
  tileCacheHits?: number
  certifiedTileHits?: number
  tileCacheBytes?: number
  maskHits?: number
  maskRasterizations?: number
}
export type TileResult = RasterTile & {
  cameraFallback?: boolean
  gpuTile?: number
  reason?: string
  passTimings?: import('./gpu/types').GpuPassTiming[]
  compileMs?: number
  graphMs?: number
  finishMs?: number
  checkpointMs?: number
  hybridEffects?: number
  materialFieldHits?: number
  materialFieldBuilds?: number
  materialFieldBuildMs?: number
  materialFieldUploadBytes?: number
  bytes: Uint8Array
  /** Worker-decoded display payload; drawn with drawImage instead of a
   * main-thread putImageData copy. Absent when decoding is unavailable. */
  bitmap?: ImageBitmap
  linear?: Float32Array
  backend: KernelResult['backend']
  description: string
  milliseconds: number
  workingTextureBytes?: number
  peakTextureBytes?: number
  finishTransientBytes?: number
  cached: boolean
}
/** World-space paint damage reported by the worker after it applies a
 * document patch. `full` demands complete invalidation; `bounds` is
 * [x, y, width, height] in page/world coordinates; `reason` names the
 * conservative kernel gate that rejected a bounded proof. */
export type TileDamage = import('./paint-damage').PaintDamage

type DamageLogEntry = TileDamage
declare global {
  interface Window {
    /** Ring buffer (max 50) of the most recent patch-damage reports, for
     * diagnosing which full-repaint gate an edit hit. Dev builds also print
     * each entry to the console. */
    __damageLog?: DamageLogEntry[]
  }
}
function recordDamage(damage: TileDamage) {
  const log = (window.__damageLog ??= [])
  log.push({ full: damage.full, reason: damage.reason, bounds: damage.bounds, rects: damage.rects })
  if (log.length > 50) log.splice(0, log.length - 50)
  if (import.meta.env.DEV)
    console.debug(`[damage] full=${damage.full} reason=${damage.reason ?? '-'} bounds=${JSON.stringify(damage.bounds ?? null)}`)
}
export class KernelClient {
  private sourceCanvas = false
  private sourceSnapshotToken?: string
  private diagnosticSession = Math.floor(Math.random() * 1e12)
  private terminalDiagnostics = createRenderDiagnostics({
    enabled: typeof window !== 'undefined' && (window as unknown as {coreDesktop?:{renderDiagnostics?:boolean}}).coreDesktop?.renderDiagnostics === true,
    detail: typeof window !== 'undefined' && (window as unknown as {coreDesktop?:{renderDiagnosticsDetail?:boolean}}).coreDesktop?.renderDiagnosticsDetail === true,
    batchSink: batch=>console.log(PREFIX+JSON.stringify({batch})),
    session: this.diagnosticSession, source: 'main', sink: record => console.log(PREFIX + JSON.stringify(record)),
  })
  private gridMeasurements = new GridMeasurements((event,fields)=>this.terminalDiagnostics.record(event,fields))
  private frameMeasurements = new FrameMeasurements((event,fields)=>this.terminalDiagnostics.record(event,fields))
  private frameObservers = 0
  private stopFrameObservers?: () => void
  private observeFrames() {
    if (!this.terminalDiagnostics.enabled || typeof document === 'undefined' || typeof requestAnimationFrame !== 'function') return () => {}
    this.frameObservers++
    if (!this.stopFrameObservers) {
      let handle=0
      const frame=(at:number)=>{this.frameMeasurements.raf(at);handle=requestAnimationFrame(frame)}
      const visibility=()=>this.frameMeasurements.visibility(document.visibilityState!=='hidden')
      visibility();handle=requestAnimationFrame(frame)
      const timer=setInterval(()=>this.frameMeasurements.tick(),1000)
      document.addEventListener('visibilitychange',visibility)
      this.stopFrameObservers=()=>{cancelAnimationFrame(handle);clearInterval(timer);document.removeEventListener('visibilitychange',visibility);this.frameMeasurements.reset();this.stopFrameObservers=undefined}
    }
    return ()=>{if(--this.frameObservers===0)this.stopFrameObservers?.()}
  }
  private navigationJournal = new NavigationJournal()
  private inputTrace = new NavigationInputTrace(this.navigationJournal, this.terminalDiagnostics, undefined, undefined, (sequence,epoch)=>{if(this.terminalDiagnostics.enabled)this.frameMeasurements.input(sequence,epoch)})
  bindNavigationInput(owner: object) {
    const unbind = bindNavigationInput(owner, this.inputTrace)
    const stopFrames=this.observeFrames()
    const stopGrid=bindCanvasGrid(owner,fields=>{if(this.terminalDiagnostics.enabled)this.gridMeasurements.record(fields)})
    return () => { unbind(); stopGrid(); stopFrames(); this.inputTrace.reset() }
  }
  /** Explicit diagnostic control only. No per-frame IPC, readback or GPU
   * fence. Worker and main clocks must be aligned by their timeOrigin. */
  async navigationCapture(action: 'start' | 'stop' | 'snapshot', options?: { capacity?: number; durationMs?: number }) {
    if (action !== 'start' && action !== 'stop' && action !== 'snapshot') throw Error('Invalid navigation diagnostic action')
    const validated = action === 'start' ? validateNavigationJournalOptions(options === undefined ? {} : options) : undefined
    if (this.disposed) throw Error('Renderer disposed')
    this.startWorker()
    if (action === 'start') this.navigationJournal.start(validated)
    if (action === 'stop') this.navigationJournal.stop(1)
    try {
      const response = await this.request({ command: 'navigation-diagnostic', action, options: validated }) as KernelResult & { navigationDiagnostic?: ReturnType<NavigationJournal['report']> }
      return { main: this.navigationJournal.report(), worker: response.navigationDiagnostic,
        semantics: 'CPU events only; align timeOrigin + at. Stage 7 is immediately post-submit, not GPU completion/scanout. Compile sequence is independent of request IDs.' }
    } catch (error) { this.navigationJournal.stop(4); throw error }
  }

  recordViewportDiagnostic(fields: Record<string,number|boolean>) { if(this.terminalDiagnostics.detail)this.terminalDiagnostics.record('viewport-state',fields) }
  traceMainThread<T>(stage:number,work:()=>T):T {
    if(!this.terminalDiagnostics.detail)return work()
    const started=performance.now()
    try{return work()}finally{this.terminalDiagnostics.record('cpu-stage',{cpuStageCode:stage,cpuPhase:2,cpuDurationMs:Math.min(120000,performance.now()-started)})}
  }
  onPresentation?: (stats: Record<string, unknown>) => void
  presentationInputOwner?:string
  private presentationAttached = false
  attachPresentation(canvas: OffscreenCanvas, atomic=false) {
    this.presentationAttached = true
    this.worker!.postMessage({ command: 'display-attach', canvas, atomic, executionPolicy: renderExecutionPolicy, documentMemoryBytes: documentCapacity().memoryBytes }, [canvas])
  }
  acceptPresentation(token:number|undefined,accepted=true){if(Number.isSafeInteger(token)&&token!>0)this.worker?.postMessage({command:'display-accept',token,accepted})}
  presentationDiagnosticsEnabled() { return this.terminalDiagnostics.detail }
  present(frame: import('./gpu/resident-presenter').ResidentFrame) {
    if (frame.terminalQuality && this.terminalDiagnostics.detail) frame = { ...frame, terminalQuality: { ...frame.terminalQuality,
      documentRevision: this.documentRevision, generation: this.previewEpochs.canvas, fillGeneration: this.tileFillEpoch } }
    const sequence = ++this.displaySequence
    const input = this.inputTrace.correlation(frame.view)
    this.terminalDiagnostics.record('camera-request',{...input,sequence,x:frame.view.x,y:frame.view.y,zoom:frame.view.zoom,width:frame.width,height:frame.height})
    if (this.navigationJournal.recording) this.navigationJournal.record(2, { ...input, sequence, x: frame.view.x, y: frame.view.y, zoom: frame.view.zoom })
    if(this.terminalDiagnostics.enabled)this.frameMeasurements.request(sequence,frame.view,input)
    this.worker?.postMessage({ command: 'display-frame', sequence, frame:residentFrameMessage({...frame, diagnosticSequence:this.terminalDiagnostics.enabled?sequence:undefined}) })
  }
  async readContentPixel(u:number,v:number,expected?:import('./resident-presentation').ResidentAcknowledgement){const result=await this.request({command:'display-read-pixel',u,v,expected});if(!result.contentPixel)throw Error('Missing document sample');return result.contentPixel}
  async captureContentBitmap(){const result=await this.request({command:'display-capture-content'});if(!result.bitmap||!result.contentFrame)throw Error('Missing document snapshot');return{bitmap:result.bitmap,frame:result.contentFrame}}
  releasePresented(ids: number[]) { if (ids.length) this.worker?.postMessage({ command: 'display-release', ids }) }
  moveResidentInteraction(slot:number,transforms:Record<string,import('../model').Matrix>,input:import('./interaction-layers').InteractionInput,terminal=false) {
    this.worker?.postMessage({command:'interaction-pose',slot,transforms,input:{...input,owner:this.presentationInputOwner},...(terminal?{terminal:true}:{})})
  }
  settleResidentInteraction(slot:number,sequence:number){this.worker?.postMessage({command:'interaction-settle',slot,sequence,owner:this.presentationInputOwner})}
  stopResidentInteraction(slot:number) {this.worker?.postMessage({command:'interaction-pose-stop',slot})}
  async importPresentation(tile: {bitmap?:ImageBitmap;bytes:Uint8Array;width:number;height:number}):Promise<number> {
    const bitmap=tile.bitmap || await createImageBitmap(new ImageData(new Uint8ClampedArray(tile.bytes),tile.width,tile.height))
    const result=await this.request({command:'display-import',bitmap},undefined,[bitmap])
    if(!result.gpuTile)throw Error('Missing imported display texture')
    tile.bitmap=undefined;return result.gpuTile
  }
  private worker?: Worker
  private preparationWorker?: Worker
  private closeNativePreparation?: () => void
  private serializeNative?: (value: unknown) => Promise<string>
  private nativeSubmission: Promise<void> = Promise.resolve()
  private previewEpochs = { canvas: 0, interaction: 0 }
  private tileFillEpoch = 0
  private next = 0
  private displaySequence = 0
  private disposed = false
  /** Patch-damage sink. Assigned by the surface that owns this client; fires
   * before any tile message of the same request so residents can be evicted
   * before replacements arrive. */
  onDamage?: (damage: TileDamage) => void
  private gpuPermit: 'none' | 'pending' | 'held' = 'none'
  private gpuPermitWaiter?: GpuPermitWaiter
  private gpuPermitPromise?: Promise<void>
  private parkingGpu?: Promise<void>
  private authoredPreparation = new AuthoredPreparationBinding<DesignDocument>()
  // Separate from cancellable presentation promises: accepted mutations still
  // need acknowledgments (and possibly fallback input) after preview cancellation.
  private synchronizationInputs = new Map<number, { document: DesignDocument; acknowledge?: (receipt?: PreparationStateReceiptV1 | null) => void; settled?: () => void }>()
  private documentSnapshot?: DesignDocument
  private documentRevision = 0
  private interactionSnapshot?: DesignDocument
  private interactionRevision = 0
  private pending = new Map<
    number,
    {
      resolve: (v: KernelResult) => void
      reject: (e: Error) => void
      timer?: ReturnType<typeof setTimeout>
      sourceWork?: boolean
      started: number
      progress?: (tile: TileResult) => void
      preview: boolean
      rasterProgress?: number
      workProgress?: number
      channel: 'canvas' | 'interaction'
    }
  >()
  constructor() {
    activeClients.add(this)
    this.startWorker()

  }
  private startWorker() {
    if (this.worker || this.disposed) return
    const worker = new Worker(new URL('./render-worker.ts', import.meta.url), { type: 'module' })
    this.worker = worker
    if (this.terminalDiagnostics.enabled) worker.postMessage({command:'terminal-diagnostics',session:this.diagnosticSession,detail:this.terminalDiagnostics.detail})
    if (desktopHost?.preparation) {
      const channel = new MessageChannel()
      const native = connectNativePreparation(desktopHost.preparation, channel.port1, error => {
        if (this.worker === worker) this.reset(error)
      }, fields => this.terminalDiagnostics.record('preparation', fields))
      this.closeNativePreparation = native.close
      this.serializeNative = native.serialize
      worker.postMessage({ command: 'prepare-port', port: channel.port2, documentMemoryBytes: documentCapacity().memoryBytes }, [channel.port2])
    } else if (allowsResidentSdr(renderExecutionPolicy) &&
      typeof navigator !== 'undefined' && !!navigator.gpu && import.meta.env.VITE_DESIGN_PREPARATION_WORKER !== '0') {
      const preparation = new Worker(new URL('./preparation-worker.ts', import.meta.url), { type: 'module' })
      this.preparationWorker = preparation
      const channel = new MessageChannel()
      preparation.postMessage({ port: channel.port1, memoryBytes: documentCapacity().memoryBytes }, [channel.port1])
      worker.postMessage({ command: 'prepare-port', port: channel.port2, documentMemoryBytes: documentCapacity().memoryBytes }, [channel.port2])
      preparation.onerror = event => { if (this.preparationWorker === preparation) this.reset(new Error(event.message || 'CPU 准备线程失败'), 3) }
    }
    worker.onmessage = (e) => {
      if(e.data.renderDiagnostics) {
        if(this.terminalDiagnostics.enabled && this.worker===worker) {
          const batch=sanitizeBatch(e.data.renderDiagnostics).filter(row=>row.session===this.diagnosticSession)
          if(batch.length)console.log(PREFIX+JSON.stringify({batch}))
        }
        return
      }
      if (e.data.renderDiagnostic) {
        if (this.terminalDiagnostics.enabled && this.worker === worker) {
          const record = sanitizeRecord(e.data.renderDiagnostic)
          if (record && record.session === this.diagnosticSession) console.log(PREFIX + JSON.stringify(record))
        }
        return
      }
      if (this.worker !== worker) {
        e.data.bitmap?.close()
        e.data.presentation?.bitmap?.close()
        return
      }
      if (e.data.documentFallback === true) {
        const captured = this.synchronizationInputs.get(e.data.id)
        const serializer = this.serializeNative
        void (async () => {
          try {
            if (!captured) throw Error('DERIVATION_CAPTURE_RETIRED')
            const document = currentPreparedDocumentJson(captured.document) ??
              (serializer ? await serializer(captured.document) : JSON.stringify(captured.document))
            if (this.worker === worker) worker.postMessage({ command: 'document-fallback', id: e.data.id, document })
          } catch (error) {
            if (this.worker === worker) worker.postMessage({ command: 'document-fallback', id: e.data.id, error: String(error) })
          }
        })()
        return
      }
      if (e.data.documentSynchronized === true) {
        // Actual completed native/WASM adoption is forward progress. Large
        // source parsing must not spend the subsequent raster watchdog too.
        this.renewPreviewWatchdogs()
        const captured = this.synchronizationInputs.get(e.data.id)
        captured?.acknowledge?.(e.data.stateReceipt)
        captured?.settled?.()
        this.synchronizationInputs.delete(e.data.id)
        return
      }
      if (e.data.error) {
        const captured = this.synchronizationInputs.get(e.data.id)
        // A cancelled visual promise no longer observes worker errors. A failed
        // accepted replica mutation must still invalidate its submission base.
        if (captured?.settled && this.documentSnapshot === captured.document) {
          this.documentSnapshot = undefined
          this.authoredPreparation.invalidate()
        }
        captured?.settled?.()
        this.synchronizationInputs.delete(e.data.id)
      }
      if (e.data.presentation) {
        const stats=e.data.presentation, presented=stats.presented
        if(this.terminalDiagnostics.enabled && presented?.view && Number.isSafeInteger(stats.diagnosticSequence) && typeof stats.submittedEpoch==='number')
          this.frameMeasurements.submit(stats.diagnosticSequence,presented.view,presented.dpr,stats.submittedEpoch)
        if (this.navigationJournal.recording && typeof e.data.presentation.compositorFrames === 'number')
          this.navigationJournal.record(9, { frames: e.data.presentation.compositorFrames })
        if (e.data.presentation.residentSample) recordRenderProfile('拖动中间帧', e.data.presentation.residentSample)
        if(this.onPresentation)this.onPresentation(e.data.presentation)
        else {stats.bitmap?.close();if(stats.bitmap)this.acceptPresentation(presented?.presentationToken,false)}
        return
      }
      if (e.data.damage !== undefined) {
        // Document-patch damage is posted before the request's tiles so the
        // owning surface can evict stale residents first.
        try {
          if (e.data.channel !== 'interaction') {
            recordDamage(e.data.damage as TileDamage)
            this.onDamage?.(e.data.damage as TileDamage)
          }
        } catch {
          /* A throwing sink must not take the worker down. */
        }
        return
      }
      const p = this.pending.get(e.data.id)
      if (!p) {
        this.terminalDiagnostics.record('stale-drop',{requestId:e.data.id,reasonCode:1})
        if (e.data.gpuTile || e.data.tile?.gpuTile) this.releasePresented([e.data.gpuTile || e.data.tile.gpuTile])
        e.data.bitmap?.close()
        e.data.tileBitmap?.close()
        return
      }
      if (e.data.rasterProgress !== undefined) {
        const sequence=e.data.rasterProgress
        if(p.preview && Number.isSafeInteger(sequence) && sequence>(p.rasterProgress||0) && sequence<=524288){
          p.rasterProgress=sequence
          this.renewPreviewWatchdogs()
        }
        return // Internal completed regions are not publishable viewport tiles.
      }
      if(e.data.workProgress!==undefined){
        const sequence=e.data.workProgress,stage=e.data.workStage,draws=e.data.drawCalls
        if(p.preview&&Number.isSafeInteger(sequence)&&sequence>(p.workProgress??0)&&
          (stage===1||stage===2&&Number.isSafeInteger(draws)&&draws>0)){
          p.workProgress=sequence;this.renewPreviewWatchdogs()
        }
        return // Compiler completion / submitted work is liveness, not pixels.
      }
      if (this.navigationJournal.recording && (e.data.tile || e.data.gpuTile || (e.data.backend && typeof e.data.milliseconds === 'number')))
        this.navigationJournal.record(8, { requestId: e.data.id, compileMs: e.data.tile?.compileMs ?? e.data.compileMs,
          graphMs: e.data.tile?.graphMs ?? e.data.graphMs, finishMs: e.data.tile?.finishMs ?? e.data.finishMs })
      if (e.data.tile) {
        this.terminalDiagnostics.record('tile',{...sanitizeRecordFields(e.data.tile),requestId:e.data.id})
        recordRenderProfile(e.data.tile.prefetch ? '预取瓦片' : '可见瓦片', e.data.tile)
        this.renewPreviewWatchdogs()
        try {
          p.progress?.({
            ...e.data.tile,
            bytes: e.data.buffer ? new Uint8Array(e.data.buffer) : new Uint8Array(0),
            bitmap: e.data.tileBitmap,
            linear: e.data.linearBuffer ? new Float32Array(e.data.linearBuffer) : undefined,
          })
        } catch (error) {
          if (!(error instanceof HandledTileDeliveryError)) {
            e.data.tileBitmap?.close()
            if(e.data.tile?.gpuTile)this.releasePresented([e.data.tile.gpuTile])
          }
          clearTimeout(p.timer)
          this.pending.delete(e.data.id)
          p.reject(error instanceof Error ? error : new Error(String(error)))
          this.cancelPreview()
        }
        return
      }
      this.terminalDiagnostics.record(e.data.error ? 'error' : 'result',{...sanitizeRecordFields(e.data),requestId:e.data.id,reasonCode:renderResultReason(e.data.error),milliseconds:performance.now()-p.started})
      clearTimeout(p.timer)
      this.pending.delete(e.data.id)
      if (e.data.error) {
        const error = markRenderFailure(renderErrorWithBudget(e.data.error, undefined, e.data.budgetDiagnostic), {
          failureCategory: e.data.failureCategory, failureCode: e.data.failureCode, failureStage: e.data.failureStage,
        })
        const budget = renderBudgetDiagnostic(error)
        // Capture allocation rejection even if a caller recovers from it.
        // The journal itself stays opt-in and stores only validated scalars.
        if (budget) recordRenderDiagnostic({ kind: 'error', errorCode: 'budget', ...budget })
        p.reject(error)
      } else {
        if (e.data.gpuMemory === undefined && typeof e.data.compileMs === 'number')
          recordRenderProfile(p.channel === 'interaction' ? '交互准备' : '渲染请求', e.data, performance.now() - p.started)
        // Control-command replies (gpuMemory) carry no render accounting;
        // leave the last real sample in place for subscribers.
        if (e.data.gpuMemory === undefined && e.data.contentFrame === undefined)
          publishRendererMemory({
            backend: e.data.backend,
            workingTextureBytes: e.data.workingTextureBytes,
            peakTextureBytes: e.data.peakTextureBytes,
            finishTransientBytes: e.data.finishTransientBytes,
            tileCacheBytes: e.data.tileCacheBytes,
          })
        p.resolve({
          ...e.data,
          roundTripMs: performance.now() - p.started,
          bytes: new Uint8Array(e.data.buffer),
          linear: e.data.linearBuffer ? new Float32Array(e.data.linearBuffer) : undefined,
          stats: e.data.stats,
          milliseconds: e.data.milliseconds,
        })
      }
    }
    worker.onerror = (e) => {
      if (this.worker === worker) this.reset(new Error(e.message || '渲染线程失败'), 2)
    }
  }
  private reset(error: Error, resetCode = 0) {
    this.frameMeasurements.reset();this.gridMeasurements.close()
    this.terminalDiagnostics.record('error',{reasonCode:this.disposed?3:2,renderResetCode:this.disposed?5:resetCode,...renderFailureFields(error)})
    this.navigationJournal.stop(/device lost|GPU device|设备已丢失/i.test(error.message) ? 5 : 4)
    if(this.presentationAttached&&!this.disposed){
      this.presentationAttached=false
      this.onPresentation?.({error:`GPU 显示线程已重置: ${error.message}`})
    }
    // The worker (and any device it held) is gone: release the page GPU slot
    // and hand it to the next queued client.
    this.releaseGpuPermit(error)
    this.worker?.terminate()
    this.worker = undefined
    this.preparationWorker?.terminate()
    this.preparationWorker = undefined
    this.closeNativePreparation?.()
    this.closeNativePreparation = undefined
    this.serializeNative = undefined
    this.nativeSubmission = Promise.resolve()
    this.authoredPreparation.invalidate()
    for (const captured of this.synchronizationInputs.values()) captured.settled?.()
    this.synchronizationInputs.clear()
    this.documentSnapshot = undefined
    this.interactionSnapshot = undefined
    this.sourceSnapshotToken = undefined
    this.fail(error)
  }
  private renewPreviewWatchdogs() {
    // One worker serializes viewport requests and can yield to interaction.
    // Completed GPU work proves it is alive; a newer queued preview must not
    // destroy its device merely because queue wait exceeded one idle timeout.
    // Silence still has the same 30-second bound. Duplicate/stale subregion
    // messages never renew it, and only complete tiles reach the UI callback.
    for(const pending of this.pending.values())if(pending.preview&&!pending.sourceWork){
      clearTimeout(pending.timer)
      pending.timer=setTimeout(()=>this.reset(new Error('画布瓦片预览超时，请重试'), 1),30000)
    }
  }
  /** Acquire the page GPU slot, or return a promise that resolves once a
   * holder releases. Returns undefined when the slot is already held or was
   * granted immediately, so the common path stays fully synchronous. */
  private acquireGpuPermit(): Promise<void> | undefined {
    if (this.parkingGpu) return this.parkingGpu.then(() => this.acquireGpuPermit())
    if (this.gpuPermit === 'held') return undefined
    if (this.gpuPermit === 'pending') return this.gpuPermitPromise
    if (this.disposed) return Promise.reject(new Error('渲染器已关闭'))
    if (activeGpuClients >= MAX_ACTIVE_GPU_CLIENTS) {
      this.gpuPermit = 'pending'
      this.gpuPermitPromise = new Promise<void>((resolve, reject) => {
        this.gpuPermitWaiter = {
          resolve: () => {
            this.gpuPermitWaiter = undefined
            this.gpuPermitPromise = undefined
            this.gpuPermit = 'held'
            activeGpuClients++
            resolve()
          },
          reject: (error: Error) => {
            this.gpuPermitWaiter = undefined
            this.gpuPermitPromise = undefined
            this.gpuPermit = 'none'
            reject(error)
          },
        }
        gpuClientQueue.push(this.gpuPermitWaiter)
        // A warmed interaction may keep its WASM document/fonts while idle.
        // Reclaim only its GPU device when another consumer needs the slot.
        for (const owner of activeClients) if (owner !== this) {
          const parked = owner.parkIdleGpu()
          if (parked) { void parked.catch(error => console.warn('[kernel-client] idle GPU retirement failed', error)); break }
        }
        console.debug(
          `[kernel-client] GPU holder limit ${MAX_ACTIVE_GPU_CLIENTS} reached; render queued until a holder disposes or times out`,
        )
      })
      return this.gpuPermitPromise
    }
    activeGpuClients++
    this.gpuPermit = 'held'
    return undefined
  }
  private parkIdleGpu(): Promise<void> | undefined {
    if (this.presentationAttached || this.disposed || this.parkingGpu || this.gpuPermit !== 'held' || this.pending.size || !this.worker) return
    const operation = this.request({ command: 'park-gpu' }).then(() => {
      this.releaseGpuPermit(new Error('GPU device parked'))
    }, error => {
      this.reset(error instanceof Error ? error : new Error(String(error)))
      throw error
    })
    this.parkingGpu = operation.finally(() => { this.parkingGpu = undefined })
    return this.parkingGpu
  }
  /** Release the page GPU slot on worker reset/dispose and hand it to the next
   * queued client. An acquisition still waiting in the queue is rejected with
   * the reset reason instead. */
  private releaseGpuPermit(closedWith: Error) {
    const waiter = this.gpuPermitWaiter
    if (waiter) {
      const index = gpuClientQueue.indexOf(waiter)
      if (index >= 0) gpuClientQueue.splice(index, 1)
      waiter.reject(closedWith)
      return
    }
    this.gpuPermitPromise = undefined
    if (this.gpuPermit !== 'held') {
      this.gpuPermit = 'none'
      return
    }
    this.gpuPermit = 'none'
    activeGpuClients--
    const next = gpuClientQueue.shift()
    if (next) {
      console.debug('[kernel-client] GPU slot handed to the next queued client')
      next.resolve()
    }
  }
  private fail(error: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(error)
    }
    this.pending.clear()
  }
  render(
    document: DesignDocument,
    options: KernelOptions,
    png = false,
    backend: BackendPreference = backendPreference(),
    readback = false,
    referenceGpu = false,
    debug?: {
      disableSolidBatch?: boolean
      pairedDisplayFilters?: boolean
      displayMath?: boolean
      denseImageFields?: boolean
      disableSparseGlass?: boolean
      disableSceneCache?: boolean
      disableExactTileCache?: boolean
      disableCertifiedTileReuse?: boolean
      forceFirstTileBudgetFailure?: boolean
      forcePreviewTiles?: boolean
    },
    progress?: (tile: TileResult) => void,
    signal?: AbortSignal,
  ): Promise<KernelResult> {
    if (this.disposed) return Promise.reject(new Error('渲染器已关闭'))
    if(this.sourceCanvas)return Promise.reject(Error('Source canvas requires its native snapshot renderer'))
    // Owner cancellation is only a transient presentation contract. Never
    // change exact/export/readback lifetime because an optional signal fires.
    if (options.renderIntent !== 'preview' || (!options.livePreview && !options.tileViewport) || png || readback || options.exportFormat || options.exportRegion || options.pixelPreview) signal = undefined
    // File pixels must not depend on editor/backend preference or device DPR.
    backend = effectiveBackend(renderExecutionPolicy, backend, png)
    const diagnosticOperation = operationCorrelation(document)
    const channel = options.interactionChannel ? 'interaction' : 'canvas'
    const previewEpoch = this.previewEpochs[channel], tileEpoch = this.tileFillEpoch
    const cancelled = () => signal?.aborted || ((!!options.tileViewport || options.livePreview === true) && this.previewEpochs[channel] !== previewEpoch) ||
      (channel === 'canvas' && !!options.tileViewport && this.tileFillEpoch !== tileEpoch)
    // A GPU-capable request may initialize a worker-held device; wait for a
    // page GPU slot first. CPU-only requests never queue, and the
    // immediately-granted path stays synchronous so message order (and thus
    // document revisions) is preserved exactly as before.
    const gpuSlot = backend !== 'cpu' ? this.acquireGpuPermit() : undefined
    const submit = (): Promise<KernelResult> => {
      if (this.disposed) return Promise.reject(new Error('渲染器已关闭'))
      if (cancelled()) return Promise.reject(new Error('PREVIEW_CANCELLED'))
      this.startWorker()
      const worker = this.worker, nativeSerializer = this.serializeNative
      const prepare = async () => {
        if (this.disposed || this.worker !== worker) throw new Error('渲染器已关闭')
        if (cancelled()) throw new Error('PREVIEW_CANCELLED')
        // Editor documents are immutable snapshots. Camera changes reuse the same
        // snapshot; edits/undo replace it. Revision checks prevent stale worker reads.
        const start = performance.now()
        let serialized: string | undefined
        let patch: string | undefined
        let deriveFrom: PreparationStateReceiptV1 | undefined
        let derivedTransforms:Record<string,import('../model').Matrix>|undefined
        let patchBaseReceipt: PreparationStateReceiptV1 | undefined
        let acknowledge: ((receipt?: PreparationStateReceiptV1 | null) => void) | undefined
        const interaction = options.interactionChannel === true
        const snapshot = interaction ? this.interactionSnapshot : this.documentSnapshot
        const baseDocumentRevision = interaction ? this.interactionRevision : this.documentRevision
        if (document !== snapshot) {
          // Capture predecessor authority before invalidating for this pending
          // mutation. No ACK from an older epoch may resurrect the old object.
          const beforeReceipt = !interaction && snapshot ? this.authoredPreparation.receiptFor(snapshot) : undefined
          if (!interaction) this.authoredPreparation.invalidate()
          deriveFrom = interaction ? this.authoredPreparation.receiptFor(document) : undefined
          if(interaction&&!deriveFrom){
            const source=interactionDocumentSource(document)
            if(source){deriveFrom=this.authoredPreparation.receiptFor(source.document);if(deriveFrom)derivedTransforms=source.transforms}
          }
          if (deriveFrom) { /* Empty derivation carries no authored JSON or patch. */ }
          else if (snapshot?.id === document.id) {
            const transition = beforeReceipt ? prepareAuthoredPatchTransition(snapshot, document) : { patch: documentPatch(snapshot, document), canAcknowledge: false }
            // Workset adoption/replacement already sends every node and new
            // page structure. A bulk patch cannot renew a property-patch
            // receipt, leaving later gestures to serialize this same graph.
            // Full synchronization establishes actual native source authority
            // once; any partial edit/append keeps the incremental path.
            const completeNativeWorkset = !!nativeSerializer && !interaction && Object.hasOwn(transition.patch.fields, 'pages') &&
              Object.keys(document.nodes).length > 0 &&
              Object.keys(snapshot.nodes).every(id => Object.hasOwn(transition.patch.nodes, id)) &&
              Object.keys(document.nodes).every(id => !!transition.patch.nodes[id])
            if (completeNativeWorkset) serialized = currentPreparedDocumentJson(document) ?? await nativeSerializer!(document)
            else {
              patch = nativeSerializer ? await nativeSerializer(transition.patch) : JSON.stringify(transition.patch)
              if (beforeReceipt && transition.canAcknowledge && boundedPatchWire(patch)) patchBaseReceipt = beforeReceipt
            }
          } else serialized = currentPreparedDocumentJson(document) ??
            (nativeSerializer ? await nativeSerializer(document) : JSON.stringify(document))
          if (this.disposed || this.worker !== worker) throw new Error('渲染器已关闭')
          if (cancelled()) throw new Error('PREVIEW_CANCELLED')
          if (interaction) { this.interactionSnapshot = document; this.interactionRevision++ }
          else { this.documentSnapshot = document; this.documentRevision++ }
        }
        if (!interaction && (serialized !== undefined || patchBaseReceipt)) acknowledge = this.authoredPreparation.capture(document)
        // Admission happens before dispatch, never by dropping accepted patches.
        // A cancelled queued preview can be omitted because the next immutable
        // snapshot is diffed from the last actually submitted snapshot. Hold the
        // submission fence until mutation ACK, not the cancellable pixel promise.
        // The surface first sends an empty canvas tile plan to synchronize
        // authored damage. It needs the same pre-dispatch admission fence:
        // cancelling pixels cannot drop a patch already accepted by the worker.
        const canvasSyncOnly = options.renderIntent === 'canvas' &&
          Array.isArray(options.tileViewport) && options.tileViewport.length === 0
        const fenceMutation = !!nativeSerializer && !interaction &&
          (canvasSyncOnly || options.renderIntent === 'preview' && (options.livePreview === true || !!options.tileViewport)) && !png && !readback &&
          !options.exportFormat && !options.exportRegion && !options.pixelPreview &&
          (serialized !== undefined || patch !== undefined)
        let releaseSynchronization: (() => void) | undefined
        let synchronizationTimer: ReturnType<typeof setTimeout> | undefined
        const synchronized = fenceMutation ? new Promise<void>(resolve => {
          releaseSynchronization = () => {
            if (synchronizationTimer !== undefined) { clearTimeout(synchronizationTimer); synchronizationTimer = undefined }
            resolve()
          }
          synchronizationTimer = setTimeout(() => {
            if (this.worker === worker && !this.disposed) this.reset(new Error('Document synchronization timed out'), 4)
            else releaseSynchronization?.()
          }, 30000)
        }) : undefined
        const synchronize = deriveFrom || acknowledge || fenceMutation ? { document, acknowledge, settled: releaseSynchronization } : undefined
        const serializeMs = performance.now() - start
        const revision = interaction ? this.interactionRevision : this.documentRevision
        const rejectSubmission = () => {
          // request() can refuse admission synchronously after prepare advanced
          // its optimistic snapshot. Invalidate before releasing the queue, not
          // in a later promise catch which can race the following preparation.
          if (this.worker !== worker) return
          if ((interaction ? this.interactionSnapshot : this.documentSnapshot) !== document ||
            (interaction ? this.interactionRevision : this.documentRevision) !== revision) return
          if (interaction) this.interactionSnapshot = undefined
          else { this.documentSnapshot = undefined; this.authoredPreparation.invalidate() }
        }
        return { synchronized, result: this.request(
          {
            document: serialized,
            deriveFrom,
            derivedTransforms,
            patchBaseReceipt,
            documentPatch: patch,
            baseDocumentRevision,
            documentRevision: revision,
            channel: interaction ? 'interaction' : 'canvas',
            options: {
              ...options,
              rasterProfile:
                options.rasterProfile ||
                document.rasterProfile ||
                (document.colorManagement ? 'figma' : 'analytic'),
            },
            png,
            backend,
            readback,
            referenceGpu: import.meta.env.DEV && referenceGpu,
            debug: import.meta.env.DEV ? debug : undefined,
          },
          progress, [], signal, synchronize, diagnosticOperation, rejectSubmission,
        )
          .then((result) => ({ ...result, serializeMs }))
          .catch((error) => {
            // A declined optional screen operator happens after document
            // synchronization. Preserve only a real canvas receipt for this
            // exact authored object on the same worker; an unacknowledged
            // mutation must still force full synchronization on retry.
            const optionalDisplayDeclined = options.sequentialViewport === true && !interaction &&
              error instanceof Error && error.message === 'SEQUENTIAL_DISPLAY_UNSUPPORTED' &&
              this.worker === worker && !!this.authoredPreparation.receiptFor(document)
            if (
              !optionalDisplayDeclined &&
              !/PREVIEW_CANCELLED|PREVIEW_BUDGET|GPU.*(?:budget|预算)/i.test(String(error)) &&
              (interaction ? this.interactionSnapshot : this.documentSnapshot) === document &&
              (interaction ? this.interactionRevision : this.documentRevision) === revision
            )
              if (interaction) this.interactionSnapshot = undefined
              else this.documentSnapshot = undefined
            throw error
          }) }
      }
      // Serialize/submit in revision order. Transient and empty-plan canvas
      // mutations release on the real synchronization ACK, not pixel completion.
      if (nativeSerializer) {
        const pending = this.nativeSubmission.then(prepare)
        this.nativeSubmission = pending.then(({ synchronized }) => synchronized, () => undefined)
        return pending.then(({ result }) => result)
      }
      return prepare().then(({ result }) => result)
    }
    return gpuSlot ? gpuSlot.then(submit) : submit()
  }
  /** Full source pixels use the same worker, compiler and GPU. The complete
   * source model stays native and never enters JSON.stringify/structuredClone. */
  renderSource(snapshot:SourceRenderSnapshot,options:KernelOptions,progress?:(tile:TileResult)=>void,signal?:AbortSignal):Promise<KernelResult> {
    if(this.disposed)return Promise.reject(Error('渲染器已关闭'))
    if(this.documentSnapshot||this.interactionSnapshot)return Promise.reject(Error('Use a separate native source render owner'))
    let source:SourceRenderSnapshot
    try{source=sourceRenderSnapshot(snapshot)}catch(error){return Promise.reject(error)}
    if(options.pageId!==source.pageId||options.interactionChannel)return Promise.reject(Error('Invalid source canvas render scope'))
    this.sourceCanvas=true
    const backend=effectiveBackend(renderExecutionPolicy,backendPreference(),false)
    if(options.renderIntent!=='preview'||!options.tileViewport)signal=undefined
    const submit=()=>{
      if(this.disposed)return Promise.reject(Error('渲染器已关闭'))
      if(signal?.aborted)return Promise.reject(Error('PREVIEW_CANCELLED'))
      this.startWorker()
      if(this.sourceSnapshotToken!==source.token){this.sourceSnapshotToken=source.token;this.documentRevision++}
      // Repeat the small capability envelope so cancellation before a previous
      // physical admission cannot leave a later camera request without a model.
      return this.request({sourceSnapshot:source,documentRevision:this.documentRevision,channel:'canvas',options,backend,png:false,readback:false},progress,[],signal)
    }
    const permit=backend!=='cpu'?this.acquireGpuPermit():undefined
    return permit?permit.then(submit):submit()
  }
  /** Debug snapshot from the worker that owns the live engine and GPU device:
   * the kernel four-bucket ledger plus the driver's byte accounting. Control
   * traffic only — no GPU permit is taken and no render state changes. */
  async gpuMemorySnapshot(): Promise<GpuMemorySnapshot> {
    const response = (await this.request({ command: 'gpu-memory' })) as KernelResult & {
      gpuMemory?: GpuMemorySnapshot
    }
    return (
      response.gpuMemory ?? { kernelBreakdown: null, backend: null, driverStats: null, deviceLost: false }
    )
  }
  async loseDeviceForTesting() {
    if (renderExecutionPolicy.cpuOnly) throw new Error('CPU-only execution forbids device tests')
    if (!import.meta.env.DEV) throw new Error('Development check only')
    const gpuSlot = this.acquireGpuPermit()
    if (gpuSlot) await gpuSlot
    await this.request({ command: 'lose-device' })
  }
  cancelTileFill() {
    this.tileFillEpoch++
    // Let the running tile publish; stop the obsolete batch before its next
    // tile. Unlike content cancellation, useful same-document pixels survive.
    this.worker?.postMessage({ command: 'cancel-tile-fill', executionPolicy: renderExecutionPolicy })
  }
  cancelPreview(channel: 'canvas' | 'interaction' = 'canvas') {
    this.previewEpochs[channel]++
    // The worker can already have messages in flight. Fence delivery locally at
    // the API cancellation point as well as sending the worker control message.
    for (const [id, pending] of this.pending) {
      if (!pending.preview || pending.channel !== channel) continue
      this.terminalDiagnostics.record('cancel',{requestId:id,reasonCode:2,channel:channel==='interaction'?1:0,generation:this.previewEpochs[channel],fillGeneration:this.tileFillEpoch})
      clearTimeout(pending.timer)
      this.pending.delete(id)
      pending.reject(new Error('PREVIEW_CANCELLED'))
    }
    this.worker?.postMessage({ command: 'cancel-preview', channel, executionPolicy: renderExecutionPolicy })
  }
  private request(payload: object, progress?: (tile: TileResult) => void, transfer:Transferable[]=[], signal?: AbortSignal, synchronize?: { document: DesignDocument; acknowledge?: (receipt?: PreparationStateReceiptV1 | null) => void; settled?: () => void }, diagnosticOperation?: Record<string, number>, rejectSubmission?: () => void): Promise<KernelResult> {
    if (this.disposed) { rejectSubmission?.(); synchronize?.settled?.(); return Promise.reject(new Error('渲染器已关闭')) }
    if (signal?.aborted) { rejectSubmission?.(); synchronize?.settled?.(); return Promise.reject(new Error('PREVIEW_CANCELLED')) }
    if (synchronize && this.synchronizationInputs.size >= 128) { rejectSubmission?.(); synchronize.settled?.(); return Promise.reject(new Error('Document synchronization input budget exceeded')) }
    const id = ++this.next
    if (synchronize) this.synchronizationInputs.set(id, synchronize)
    let cleanup: (() => void) | undefined
    const result = new Promise<KernelResult>((resolve, reject) => {
      const options = (payload as { options?: KernelOptions }).options
      this.terminalDiagnostics.record('request',{...renderRequestCategories(payload),...diagnosticOperation,requestId:id,x:options?.view?.x,y:options?.view?.y,zoom:options?.view?.zoom,width:options?.width,height:options?.height})
      const preview = !!options?.tileViewport || options?.livePreview === true
      // Native source scenes are intentionally independent of source size and
      // compile duration. They remain cancellable, and native/worker/device
      // errors still reject them; elapsed time alone is not a failure receipt.
      const sourceWork = this.sourceCanvas && !!(payload as {sourceSnapshot?:unknown}).sourceSnapshot
      const timer = sourceWork ? undefined : setTimeout(() => {
        // Reject this attempt. A subsequent user/render request starts a fresh
        // worker and resends the document; expensive work is not blindly retried.
        this.reset(new Error(preview
          ? '画布预览超时，请重试或切换渲染后端'
          : '导出渲染超时，请重试或检查导出内容'), 1)
      }, 30000)
      this.pending.set(id, { resolve, reject, timer, sourceWork, started: performance.now(), progress, preview,
        channel: (payload as {channel?:string}).channel === 'interaction' ? 'interaction' : 'canvas' })
      if (signal) {
        const abort = () => {
          const pending = this.pending.get(id)
          if (!pending) return
          clearTimeout(pending.timer); this.pending.delete(id)
          this.terminalDiagnostics.record('cancel', { requestId: id, reasonCode: 3 })
          this.worker?.postMessage({ command: 'cancel-request', requestId: id, executionPolicy: renderExecutionPolicy })
          reject(new Error('PREVIEW_CANCELLED'))
        }
        signal.addEventListener('abort', abort, { once: true })
        cleanup = () => signal.removeEventListener('abort', abort)
      }
      try {
        if (this.navigationJournal.recording && options?.view) this.navigationJournal.record(1, {
          requestId: id, channel: (payload as {channel?:string}).channel === 'interaction' ? 1 : 0,
          x: options.view?.x, y: options.view?.y, zoom: options.view?.zoom, width: options.width, height: options.height })
        this.worker!.postMessage({ id, ...payload, executionPolicy: renderExecutionPolicy, documentMemoryBytes: documentCapacity().memoryBytes },transfer)
      } catch (error) {
        rejectSubmission?.()
        this.reset(error instanceof Error ? error : new Error(String(error)))
      }
    })
    return result.finally(() => cleanup?.())
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.stopFrameObservers?.()
    this.gridMeasurements.flush();this.gridMeasurements.close()
    activeClients.delete(this)
    this.reset(new Error('渲染器已关闭'))
    this.terminalDiagnostics.flush(); this.terminalDiagnostics.close()
  }
}
