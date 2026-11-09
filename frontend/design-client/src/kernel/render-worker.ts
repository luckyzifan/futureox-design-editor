import { choosePreparedTile } from './zoom-refinement-policy'
import { equalValue } from '../document-patch'
import {regionalGaussianDisplay,regionalGaussianAllocationFailure} from './regional-gaussian-display'
import {MATERIAL_BAND} from './source-display-band'
import { ResidentPoseReuse, terminalPoseDisposition } from './resident-pose-reuse'
import { MAX_CANVAS_RASTER_SCALE } from '../canvas-camera'
import { pinDocumentCapacity } from '../document-capacity'
import { initializeKernelModule } from './module'
import { createTileCostDiagnostics } from './tile-cost-diagnostics'
import { setDeviceDiagnosticRequestContext, beginDeviceRecovery, deviceDiagnosticFields, deviceLifecyclePhase, type DeviceDiagnosticFields } from './gpu/device-lifecycle-diagnostics'
import { GridMeasurements } from './grid-measurements'
import { RenderFailureAttempts, renderFailureFields, withRenderFailureStage } from './render-failure-telemetry'
import { boundedPatchWire, supportsAcknowledgedPropertyPatch } from './authored-patch-transition'
import type { PreparationStateReceiptV1 } from './preparation-state'
import { displayRasterBackpressure } from './display-raster-scheduling'
import { cpuTileFrameOptions, sampleCpuTile } from './cpu-tile-frame'
import { samePreparationReceipt } from './authored-preparation-binding'
import { renderQualityContract } from './render-quality'
import { usesPainterCaptureReads, usesPainterSupport } from './painter-support-policy'
import { stampDisplayTentRadius, usesDisplayTentRadiusIntent } from './display-tent-radius-intent'
import { usesNativePreviewTiles } from './native-preview-tiles-policy'
import { createRenderDiagnostics, snapshotResourceFields, setGpuDiagnosticSink, setGpuDiagnosticsDetail } from '../../../design-desktop/src/render-terminal-diagnostics.mjs'
import { NavigationJournal, validateNavigationJournalOptions } from './navigation-journal'
import { renderFailureEnvelope, renderErrorWithBudget } from './render-diagnostics'
import { readAuthoredSnapshot } from './authored-snapshot'
import {
  transcode_export_png as raw_transcode_export_png,
  VectorEngine,
  encode_png_rgba as raw_encode_png_rgba,
  encode_float_rgba8 as raw_encode_float_rgba8,
  color_encode_rgba8 as raw_color_encode_rgba8,
  color_encode_png as raw_color_encode_png,
} from '../generated/design-kernel/design_kernel'
import {
  allowsColorPresentation,
  allowsResidentSdr,
  allowsInteractionWindow,
  effectiveBackend,
  pinRenderPolicy,
  rasterCandidates,
  requiresFloatCompositing,
  usesCanvasDisplayFilters,
  usesTransientDisplayFilters,
  usesDisplayArithmetic,
  usesDesktopDisplay,
  type RenderPolicy,
} from './render-policy'
import type { GpuRenderer } from './gpu/renderer'
import { decodeScenePacket, scenePacketWitness, CompiledScenePacket, type ScenePacket } from './gpu/scene-packet'
import type {CompilationWitness} from './compilation-witness'
import type { ColorSettings } from '../color'
import { intersect, type BackendPreference, type Driver, type GpuScene, type Rect } from './gpu/types'
import { guardedPixelWindow } from './gpu/effect-region'
import type { KernelOptions } from './client'
import { TILE_SIDE, type RasterTile } from './tile-cache'
import { imageCacheKey, readCachedImage, writeCachedImage } from './image-mip-cache'
import { DecodedImageCache, createDecodedImageOwner, decodedImageScope } from './decoded-image-cache'
import { managedSceneImageLoader, SceneImageHydration, type ImageContext } from './scene-image-hydration'
import { coordinateSlot } from './exact-tile-cache'
import { exactTilePayloadBytes, OwnerTileCache, ownsExactTileBytes } from './owner-tile-cache'
import { tileComputationDependsOnCamera } from './tile-computation-key'
import { recoverFailedTileRenderer } from './tile-failure'
import { recoverPreviewBudget, isRecoverablePreviewBudget } from './preview-budget-recovery'
import { PreviewAdmission, isAnalyticProgramBudget, isScenePathBudget } from './preview-tiles'
import { isDisplayBudgetError } from './gpu/display-budget'
import { applyDocumentPatch, documentPatch, type DocumentPatch } from '../document-patch'
import type { DesignDocument, Matrix } from '../model'
import { preparePreviewSelection, previewTranslationDelta, translatePreviewScene } from './gpu/translated-scene'
import { FrozenResidentOverlayPoses, resolveResidentOverlayFrame, stickyPresentedAffines } from './gpu/resident-affine-pose'
import { interactionPatchTransforms, isInnerShadowFill, isInnerShadowPosePatch } from './interaction-patch-transforms'
import { capturePoseOrigins, residentPoseShift } from './gpu/resident-pose-origin'
import { tilePrepareViewport, localDisplayPrepareScope, tileLocalPrepareViewport } from './tile-prepare-viewport'
import { compiledFilterColumnSupport, FilterTileOrder, validTileFillPriorities } from './filter-tile-order'
import { GPU_PRIORITY_BURST, RenderWorkQueue } from './render-work-queue'
import { paintDamageIntersects, viewportDamage, type PaintDamage } from './paint-damage'
import {residentFrameSignature} from './gpu/resident-frame'
import { canCommitResidentFrame, matchesResidentFrame } from './gpu/retained-commit'
import { pageTranslationCommit } from './gpu/page-translation-commit'
import { pixelSourceContract } from './gpu/page-background'
import { PreparationChannel } from './preparation-channel'
import { RenderKernel } from './render-kernel'
import { sourceRenderSnapshot } from './source-render-snapshot'
import { RenderLaneStates, type RenderLaneName } from './render-lane-state'
import { loadKernelResources } from './kernel-resources'
import { preparedTileCanFill, preparedTileContinuation } from './prepared-tile-fallback'
import { reuseExactSceneSources } from './gpu/exact-scene-reuse'
import { PrepareAhead } from './prepare-ahead'
import { withResidentPose } from './gpu/resident-pose-frame'
import { TranslationPatchSession } from './gpu/translation-patch-session'
import { DisplayCommandOrder } from './display-command-order'
let terminalDiagnostics = createRenderDiagnostics()
let diagnosticRequestId = 0
setDeviceDiagnosticRequestContext(() => diagnosticRequestId)
let diagnosticFailureAttempts: RenderFailureAttempts | undefined
function failureAttempt<T>(stage: number, work: () => T): T {
  const scope = diagnosticFailureAttempts
  return scope ? scope.run(stage, work) : withRenderFailureStage(stage, work)
}
const transcode_export_png = (...args: Parameters<typeof raw_transcode_export_png>) => failureAttempt(7, () => raw_transcode_export_png(...args))
const encode_png_rgba = (...args: Parameters<typeof raw_encode_png_rgba>) => failureAttempt(7, () => raw_encode_png_rgba(...args))
const encode_float_rgba8 = (...args: Parameters<typeof raw_encode_float_rgba8>) => failureAttempt(7, () => raw_encode_float_rgba8(...args))
const color_encode_rgba8 = (...args: Parameters<typeof raw_color_encode_rgba8>) => failureAttempt(7, () => raw_color_encode_rgba8(...args))
const color_encode_png = (...args: Parameters<typeof raw_color_encode_png>) => failureAttempt(7, () => raw_color_encode_png(...args))
let diagnosticQueueDepth=0
let executionPolicy: RenderPolicy | undefined
let preparation: PreparationChannel | undefined
// Actual acknowledged preparation state paired with the corresponding worker
// authored object. Unlike authoredSnapshot, this does not require/full-encode
// a JSON string after edits. Revisions and deferred poses cannot mint it.
type SynchronizedAuthoredProof = { document: DesignDocument; receipt: PreparationStateReceiptV1 }
const synchronizedAuthored = new Map<RenderLaneName, SynchronizedAuthoredProof>()
// A fallback is a continuation of the accepted ordered synchronization, not a
// replay. Bound its lifetime and keep it independent of preview cancellation.
const documentFallbacks = new Map<number, { resolve: (document: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
function capturedDocumentFallback(id: number): Promise<string> {
  if (documentFallbacks.size >= 8) return Promise.reject(Error('DERIVATION_FALLBACK_BUDGET'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { documentFallbacks.delete(id); reject(Error('DERIVATION_FALLBACK_TIMEOUT')) }, 15000)
    documentFallbacks.set(id, { resolve, reject, timer })
    self.postMessage({ id, documentFallback: true })
  })
}
const gridMeasurements = new GridMeasurements((event,fields)=>terminalDiagnostics.record(event,fields))
let colorKey = ''
let floatingKey: string | undefined
let referenceGpu = false
let solidBatchGpu = true
let gpu: GpuRenderer | undefined
let previousDeviceDiagnostic: DeviceDiagnosticFields = {}
function noteRetiredDevice(renderer: GpuRenderer | undefined) {
  const identity = deviceDiagnosticFields(renderer?.driver)
  if (identity.deviceIncarnation) previousDeviceDiagnostic = { devicePreviousIncarnation: identity.deviceIncarnation }
}
let displayCanvas: OffscreenCanvas | undefined
let atomicDisplay = false
let displayFrame: import('./gpu/resident-presenter').ResidentFrame | undefined
// Private version for coverage-relevant frame replacement. Overlay-only
// updates do not change the gap proof used by an already prepared tile.
let displayCoverageVersion = {}
let displayFramePending = false
let displayOrderSequence = 0
const displayOrder = new DisplayCommandOrder()
const displayTasks = new MessageChannel()
displayTasks.port1.onmessage=()=>{
  displayFramePending=false
  try{if(displayFrame)gpu?.driver.presentFrame?.(displayFrame)}catch(error){reportDisplay({error:String(error)})}
}
const navigationJournal = new NavigationJournal()
let navigationCompileSequence = 0, navigationCaptureGeneration = 0
let navigationTextureSet: number[] = [], navigationTextureSequence = 0
// Numeric stages are documented in the diagnostic collector. The callback is
// immediately after queue.submit, not GPU completion or physical scanout.
const reportDisplay = (presentation: Record<string, unknown>) => {
  if(terminalDiagnostics.enabled && presentation.gridVisible !== undefined)gridMeasurements.record({gridKind:5,gridVisible:Number(presentation.gridVisible),gridSpacingClass:Number(presentation.gridVisible)?2:1,gridRedrawReason:0,dpr:Number(presentation.dpr)})
  const presented = presentation.presented as {view?:{x:number;y:number;zoom:number};width?:number;height?:number;dpr?:number} | undefined
  terminalDiagnostics.record(presentation.error ? 'error' : presentation.pageCommitStage ? 'cache' : presentation.alphaFrame ? 'frame-alpha' : presentation.coverageDeferred ? 'skip' : 'camera-submit',{...(presentation.error ? { ...renderFailureFields(presentation.error), failureStage:10 } : {}),...presentation,...presented?.view,width:presented?.width,height:presented?.height,dpr:presented?.dpr,sequence:displayOrderSequence,reasonCode:presentation.error?4:0})
  // Preserve the one forced terminal sample before another burst fills the bounded journal.
  if (presentation.qualityTerminal === true) terminalDiagnostics.flush()
  if (navigationJournal.recording) {
    if (typeof presentation.compositorFrames === 'number') {
      const ids = (presentation.presented as {ids?:unknown} | undefined)?.ids
      // Keep only a bounded numeric identity list. Its change marks a new
      // submitted texture set, not proof of new pixels or physical scanout.
      const valid = Array.isArray(ids) && ids.length <= 4096 && ids.every(id => Number.isSafeInteger(id) && id >= 0)
      if (valid && (ids.length !== navigationTextureSet.length || ids.some((id, i) => id !== navigationTextureSet[i]))) {
        navigationTextureSet = ids.slice(); navigationTextureSequence++
      }
      navigationJournal.record(7, { frames: presentation.compositorFrames,
        ...(valid ? {sequence:navigationTextureSequence,tiles:ids.length} : {}) })
    }
    if (presentation.error && gpu?.driver.lost) navigationJournal.stop(5)
  }
  self.postMessage({ presentation }, {transfer:presentation.bitmap ? [presentation.bitmap as ImageBitmap] : []})
}
function journalCompile<T>(work: () => Promise<T>): Promise<T> {
  const compile = work; work = () => failureAttempt(5, compile)
  if (terminalDiagnostics.enabled) {
    const original=work, started=performance.now(), requestId=diagnosticRequestId
    terminalDiagnostics.record('compile-start',{requestId})
    work=async()=>{
      let packet: Record<string, number> | undefined
      try {
        const result = await original()
        if (result instanceof CompiledScenePacket) {
          const scene=result.scene
          packet={...result.transport,width:scene.extent.w,height:scene.extent.h,count:Object.keys(scene.nodes).length}
        } else if (result instanceof Uint8Array && result.byteLength >= 24) {
          const header = new DataView(result.buffer, result.byteOffset, result.byteLength)
          if (header.getUint32(0, true) === 0x43534746 && header.getUint32(4, true)===1)
            packet = { scenePacketProtocol: 2, scenePacketVersion: header.getUint32(4, true), scenePacketBytes: result.byteLength,
              scenePacketMetadataBytes: header.getUint32(8, true), scenePacketResourceBytes: header.getUint32(20, true) }
          const scene=decodeScenePacket(result)
          packet={...packet,width:scene.extent.w,height:scene.extent.h,count:Object.keys(scene.nodes).length}
        }
        return result
      } finally { terminalDiagnostics.record('compile',{requestId,durationMs:performance.now()-started,...packet}) }
    }
  }
  if (!navigationJournal.recording) return work()
  const generation = navigationCaptureGeneration, sequence = ++navigationCompileSequence
  navigationJournal.record(4, { sequence })
  return work().finally(() => { if (generation === navigationCaptureGeneration) navigationJournal.record(5, { sequence }) })
}
function compilePacket(kernel: RenderKernel, options: string, signal?: AbortSignal) {
  return journalCompile(async () => (await kernel.prepare_gpu_scene(options, signal)).consume())
}
let reportedResidentAttachment = ''
function prepareDisplay(capture = true) {
  if (!gpu) return
  if (displayCanvas) {
    gpu.driver.attachPresenter?.(displayCanvas, reportDisplay, atomicDisplay)
    const reason = gpu.driver.attachPresenter ? 'attached' : 'driver-unavailable'
    if (reportedResidentAttachment !== reason) {
      reportedResidentAttachment = reason
      reportDisplay({residentAttached:reason === 'attached',residentAttachmentReason:reason})
    }
  }
  gpu.driver.captureDisplay = !!displayCanvas && capture
}
async function recoverTileFailure(error:unknown) {
  const owner = gpu?.driver, observation = beginDeviceRecovery(owner, 2, diagnosticRequestId)
  try {
    if(!await recoverFailedTileRenderer(error,gpu,invalidateTileCache,!!displayCanvas)) {
      previousDeviceDiagnostic = { devicePreviousIncarnation: deviceDiagnosticFields(owner).deviceIncarnation || 0 }
      gpu=undefined
      observation.end(deviceLifecyclePhase.recoveryRetired)
    } else observation.end(deviceLifecyclePhase.recoveryReady, gpu?.driver)
  } catch(failure){noteRetiredDevice(gpu);gpu=undefined;observation.end(deviceLifecyclePhase.recoveryFailed);throw failure}
}
let preference: BackendPreference | undefined
const unavailable = new Map<string, string>()
let tiledPreviewMode = false
const previewGenerations = {canvas:0,interaction:0}
let tileFillGeneration = 0
// Cancellation is restricted to CPU-only packet waits before any encoder owns
// resources. Ordered document synchronization and exact outputs always finish.
const packetWaits = new Set<{ requestId: number; channel: string; tiled: boolean; controller: AbortController }>()
const regionAdmissions = new Map<string, PreviewAdmission>()
let fullDensityGaussianWindow = ''
type TileRender = Awaited<ReturnType<typeof renderTiledPreview>>
function backgroundTileResult(gpuTile:number,color:ColorSettings|undefined):TileRender {
  return {gpuTile,tileCost:undefined,bitmap:undefined,buffer:new ArrayBuffer(0),backend:'webgpu',description:'WebGPU',reason:'',colorManagement:color,
    intermediateFormat:'rgba8unorm',hybridEffects:0,materialFieldHits:0,materialFieldBuilds:0,materialFieldBuildMs:0,materialFieldUploadBytes:0,
    wholeFilterAxes:0,opaqueTentPasses:0,imageXTableBuilds:0,imageXTablePixels:0,imageXTableBytes:0,
    displayTentRadiusPasses:0,displayTentRadiusPixels:0,staticImageBlurEligible:0,staticImageBlurHits:0,staticImageBlurPixels:0,staticImageBlurBytes:0,staticImageBlurEntries:0,
    horizontalFilterHits:0,horizontalFilterPixels:0,horizontalFilterRows:0,
    compileMs:0,renderMs:0,milliseconds:0,graphMs:0,finishMs:0,checkpointMs:0,previewTiles:0,bitmapLeaves:0,injectedBudgetFailures:0,
    workingTextureBytes:0,peakTextureBytes:0,finishTransientBytes:0,drawCalls:0,triangles:0,
    stats:{nodes:0,culled:0,effectLayers:0,backdropReads:0,pathSegments:0,shadedPixels:0,peakLayerPixels:0,allocatedLayerPixels:0}}
}
const tileCaches = new OwnerTileCache<TileRender & {worldBounds: [number,number,number,number]}>(undefined,(reasonCode,tileCacheBytes)=>{if(terminalDiagnostics.detail)terminalDiagnostics.record('cache',{requestId:diagnosticRequestId,reasonCode,tileCacheBytes})})
let tileCache = tileCaches.owner('canvas')
let cacheGeneration = 0
function invalidateTileCache() {
  terminalDiagnostics.record('cache-invalidate',{requestId:diagnosticRequestId,generation:cacheGeneration,reasonCode:0,tileCacheBytes:tileCaches.bytes})
  tileCaches.clear()
  regionAdmissions.clear()
  fullDensityGaussianWindow = ''
  cacheGeneration++
}

function invalidateOwnerTileCache() {
  terminalDiagnostics.record('cache-invalidate',{requestId:diagnosticRequestId,generation:cacheGeneration,reasonCode:1,tileCacheBytes:tileCaches.bytes})
  tileCache.clear()
  fullDensityGaussianWindow = ''
  // Admission heuristics are bounded separately and carry explicit owner keys.
  for (const key of regionAdmissions.keys()) if (key.startsWith(JSON.stringify(activeLane) + '/')) regionAdmissions.delete(key)
  cacheGeneration++
}

// Stable lane objects replace swapping mutable document fields. GPU state
// remains on the single render queue; receipts certify CPU packet admission.
const lanes = new RenderLaneStates()
let laneState = lanes.get('canvas')
let activeLane: RenderLaneName = 'canvas'
function selectLane(name: RenderLaneName) {
  if (name === activeLane) return
  laneState = lanes.get(name)
  activeLane = name
  tileCache = tileCaches.owner(name)
}


async function engine(state = laneState) {
  if (!state.enginePromise)
    state.enginePromise = (async () => {
      const boot = () => initializeKernelModule()
      // Warm only after a real request owns the render queue/GPU permit. Merely
      // constructing idle clients must not boot unlimited WASM/font workers.
      const font = preparation ? (await Promise.all([boot(), preparation.request(state.name, 'warm_resources')]), undefined) : await loadKernelResources(boot)
      const engine = new RenderKernel(new VectorEngine(), state.name, preparation)
      // The execution policy is pinned by the first envelope before any task
      // reaches this point and can never change afterwards.
      await engine.initialize(executionPolicy?.imageMips === true, font)
      return engine
    })()
  return state.enginePromise
}
/** Deterministic asset access through the wasm engine: base decode for level
 * 0, the shared mip chain above it. Level surfaces come from the same cached
 * // decode, so reloads reproduce identical bytes. Level-0 decodes first
 * consult the persistent image cache (frozen kernel outputs; Electron keeps
 * the store on disk, browsers in IndexedDB) and write back on miss, so a
 * reopened document skips re-decoding its imported bitmaps. */
const diskImageCache = new DecodedImageCache()
const imagePersistence = { key: imageCacheKey, read: readCachedImage, write: writeCachedImage }
let renderingImages: ImageContext | undefined
const managedImageLoader = managedSceneImageLoader(diskImageCache, () => {
  if (!renderingImages) throw Error('Image decoder has no render owner')
  return renderingImages
}, imagePersistence)
/** Capture after ordered synchronization. Only a proven same-document fork
 * shares residency; request/lane ownership and async cancellation stay separate. */
function sceneImageHydration(kernel: RenderKernel, current: () => boolean) {
  const lane = activeLane, state = laneState, generation = state.documentGeneration, resources = state.resourceGeneration, promise = state.enginePromise
  const owner = laneState.decodedImageOwner
  const context: ImageContext = { kernel, resourceOwner: owner, settings: kernel.color_settings(),
    scope: decodedImageScope(owner, kernel.color_settings()) }
  const ownerCurrent = () => lanes.get(lane) === state && state.documentGeneration === generation &&
    state.resourceGeneration === resources && state.enginePromise === promise && state.decodedImageOwner === owner &&
    kernel.color_settings() === context.settings
  context.ownerCurrent = ownerCurrent
  const hydration = new SceneImageHydration(diskImageCache, context, imagePersistence, ownerCurrent, current)
  return async (scene: GpuScene, isCurrent = current) => {
    const requestCurrent=()=>activeLane===lane&&laneState===state&&ownerCurrent()&&isCurrent()
    if(!requestCurrent())throw Error('PREVIEW_CANCELLED')
    const hydrationStarted=terminalDiagnostics.enabled?performance.now():0
    terminalDiagnostics.record('hydrate-start',{requestId:diagnosticRequestId})
    // This render owns the GPU queue across hydration. Bind its exact source
    // before consulting the optional upload hint; a previous lane's owner must
    // never suppress this lane's resource preparation.
    renderingImages = { ...context, current: requestCurrent }
    await failureAttempt(6, () => hydration.hydrate(scene, requestCurrent, uri => gpu?.hasUploadedImageSource(scene, uri) === true))
    terminalDiagnostics.record('hydrate',{requestId:diagnosticRequestId,durationMs:performance.now()-hydrationStarted})
    // RenderWorkQueue owns the entire gpu.render promise. Its only priority
    // yield is after completed tile delivery, so another lane cannot rebind
    // this decoder while a GPU render is awaiting driver work.
    if(!requestCurrent())throw Error('PREVIEW_CANCELLED')
    renderingImages = { ...context, current: requestCurrent }
  }
}
type HydrateSceneImages = ReturnType<typeof sceneImageHydration>
// A message task yields to control messages without clamped per-tile timers.
// The worker queue has one active render, so there is only one pending waiter.
const previewTaskChannel = new MessageChannel()
let previewTaskWaiter: (() => void) | undefined
previewTaskChannel.port1.onmessage = () => {
  const resolve = previewTaskWaiter
  previewTaskWaiter = undefined
  resolve?.()
}
function yieldPreviewTask() {
  return new Promise<void>((resolve) => {
    previewTaskWaiter = resolve
    previewTaskChannel.port2.postMessage(0)
  })
}
const queue = new RenderWorkQueue()
type ResidentPose={terminal?:boolean;slot:number;transforms:Record<string,Matrix>;input:import('./interaction-layers').InteractionInput & {owner?:string}}
type PoseSession={canvasOwner?:object;baseFill?:{x:number;y:number;width:number;height:number};softEffectPreview?: boolean;reuse?:ResidentPoseReuse;controller:AbortController;slot:number;document:DesignDocument;baseDocument:DesignDocument;scene:GpuScene;
  origins:ReadonlyMap<string,readonly[number,number]>;
  patch?:TranslationPatchSession;native?:boolean;affine?:boolean;fixedWindow?:boolean;window:import('./gpu/types').Rect;options:string;stopped:boolean;input?:ResidentPose['input'] & {owner?:string};bounds?:{x:number;y:number;width:number;height:number}}
let poseSession:PoseSession|undefined,pendingPose:ResidentPose|undefined,poseQueued=false
/** Message handlers can replace this queue while native preparation awaits. */
function latestPendingPose():ResidentPose|undefined{return pendingPose}
const frozenOverlayPoses=new FrozenResidentOverlayPoses()
/** Borrow only a completed full-quality native pose on the canonical
 * pixel lattice. Its retained texture is authoritative inside the declared
 * window only. The canvas kernel independently supplies the damage. */
function localRepairSource(session: PoseSession | undefined, next:DesignDocument | undefined, driver:Driver,
  view:KernelOptions['view'], contract:string, damage:Rect, canvasOwner:object) {
  if (!session?.native || session.canvasOwner!==canvasOwner || !session.input || !session.reuse || !next) return
  const scene=session.scene, window=scene.interactionWindow, output=scene.output, ids=scene.interactionSelection
  const content=scene.interactionContentWindow??window
  if (!scene.interactionLocalFootprint || scene.gestureSoftEffects || scene.displayFilters || scene.displayMaterialSource ||
      scene.displayImageSource || scene.displayTentRadius || scene.linearRetainedCapture || scene.resolve || scene.presentation ||
      scene.softwareRaster || !window || !output || ids?.length!==1 || !isInnerShadowFill(next.nodes[ids[0]]) ||
      scene.view.x!==view.x || scene.view.y!==view.y || scene.view.zoom!==view.zoom ||
      !content || content.x>damage.x || content.y>damage.y || content.x+content.w<damage.x+damage.w || content.y+content.h<damage.y+damage.h) return
  // gpuPageBackground only asks the compiler for support metadata.
  if (pixelSourceContract({...JSON.parse(session.options),gpuPageBackground:true})!==contract) return
  const doc=session.patch?.snapshot()??session.document, texture=driver.presentedContentToken?.(session.slot)
  if (!texture || !equalValue(doc,next) ||
      !session.reuse.matches({scene,driver,texture,window,transforms:{[ids[0]]:next.nodes[ids[0]].transform}})) return
  return {id:session.slot,texture,rect:output}
}

/** A finished pose is visible only inside the union of its initial and current
 * fill. Keep this pixel-space contract on the scene for both display and repair. */
function innerShadowContentWindow(session:PoseSession, scene:GpuScene, window:Rect, ids:string[]):Rect|undefined {
  const original=session.baseFill, fill=ids.length===1 && scene.nodes[ids[0]]?.fill.rect
  if(!original || !fill || !scene.nativeInteraction || !scene.interactionLocalFootprint ||
      scene.gestureSoftEffects || session.softEffectPreview || !isInnerShadowFill(session.baseDocument.nodes[ids[0]]) ||
      ![original.x,original.y,original.width,original.height].every(Number.isFinite) || original.width<=0 || original.height<=0)return
  const {x,y,zoom}=scene.view
  const left=Math.max(window.x,Math.min(original.x*zoom+x,fill.x)-2)
  const top=Math.max(window.y,Math.min(original.y*zoom+y,fill.y)-2)
  const right=Math.min(window.x+window.w,Math.max((original.x+original.width)*zoom+x,fill.x+fill.w)+2)
  const bottom=Math.min(window.y+window.h,Math.max((original.y+original.height)*zoom+y,fill.y+fill.h)+2)
  if(right>left && bottom>top)return {x:left,y:top,w:right-left,h:bottom-top}
}

function displayedOverlayAffines(frame:import('./gpu/resident-presenter').ResidentFrame) {
  const affines=gpu?resolveResidentOverlayFrame(frame,gpu.driver,poseSession,frozenOverlayPoses):undefined
  if(!gpu&&frame.overlayPoseSlot!==undefined)frame.overlay=undefined
  // A stopped session is the affine rebase gap: the texture is still the
  // previous pose, so chrome must not take the new rotation alone.
  return stickyPresentedAffines(affines,poseSession?.stopped===true)
}
function rebasePose(pose:ResidentPose,expandCapture=false){
  if(poseSession?.slot===pose.slot){
    poseSession.stopped=true;poseSession.controller.abort()
    if(gpu)frozenOverlayPoses.freeze(gpu.driver,poseSession.slot,poseSession.scene)
  }
  if(pendingPose?.slot===pose.slot)pendingPose=undefined
  reportDisplay({residentSample:{slot:pose.slot,...pose.input,needsRebase:true,expandCapture}})
}
function presentSampledPose(session:PoseSession,pose:ResidentPose,bounds:{x:number;y:number;width:number;height:number}) {
  session.input=pose.input;session.bounds=bounds
  if(displayFrame&&displayFrame.items.some(item=>item.active&&item.tile.gpuTile===session.slot)){
    const view=displayFrame.view
    displayFrame={...displayFrame,interaction:true,input:pose.input,items:displayFrame.items.map(item=>item.tile.gpuTile===session.slot
      ?{...item,clip:{left:bounds.x*view.zoom+view.x,top:bounds.y*view.zoom+view.y,width:bounds.width*view.zoom,height:bounds.height*view.zoom}}:item)}
    displayCoverageVersion={};displayFrame.overlayAffines=displayedOverlayAffines(displayFrame)
    gpu!.driver.presentFrame?.(displayFrame)
  }
}
// Set only during the physical finish of the preceding native pose. The
// actual terminal input can use the idle CPU lane; it owns one one-use packet.
let beginTerminalPreparation: ((next:ResidentPose)=>void) | undefined
function schedulePose(){
  if(poseQueued||!pendingPose)return
  poseQueued=true
  void queue.run(async()=>{
    let runningPose: ResidentPose | undefined
    type Advance={pose:ResidentPose; sequence:number; session:PoseSession; kernel:RenderKernel; previous:Record<string,Matrix>; mutated:boolean}
    let advance:Advance|undefined
    const ahead=new PrepareAhead<{packet:Awaited<ReturnType<RenderKernel['prepare_gpu_scene']>>|undefined; compileMs:number}>()
    const discardAdvance=async()=>{
      if (!advance) return
      const old=advance;advance=undefined
      await ahead.drain()
      if (!old.mutated) return
      // No other CPU mutation can enter this queue until the abandoned move
      // is drained. Restore the pre-advance state, including on stop/rebase.
      try { if (await old.kernel.apply_interaction_transforms(JSON.stringify(old.previous))) return } catch { /* reload the last published state */ }
      const lane=lanes.get('interaction')
      const last=old.session.patch?.snapshot()??old.session.document
      lane.interactionDocument=lane.deferredInteractionDocument=last
      lane.synchronizedInteractionDocument=undefined; lane.compiledScene=undefined
      synchronizedAuthored.delete('interaction')
      if (poseSession===old.session) rebasePose(old.pose)
    }
    try{
      while(pendingPose){
        const pose=pendingPose;pendingPose=undefined;runningPose=pose
        const session=poseSession
        if (advance && (advance.pose!==pose || advance.session!==session || session?.stopped)) await discardAdvance()
        if(!session||session!==poseSession||session.stopped||session.slot!==pose.slot||!gpu?.driver.replacePresented)continue
        const current=()=>poseSession===session&&!session.stopped&&!session.controller.signal.aborted &&
          !(session.native && session.scene.interactionLocalFootprint && latestPendingPose()?.terminal &&
            terminalPoseDisposition(pose,latestPendingPose())==='changed')
        const started=performance.now()
        selectLane('interaction')
        const ids=Object.keys(pose.transforms)
        if(!ids.length||ids.length>16||ids.some(id=>!session.scene.nodes[id]||!session.document.nodes[id]||!Array.isArray(pose.transforms[id])||
          pose.transforms[id].length!==6||!Array.from(pose.transforms[id]).every(Number.isFinite))){rebasePose(pose);break}
        const documentStarted=performance.now()
        const document=session.patch||session.native&&!pose.terminal?undefined:{...session.document,nodes:{...session.document.nodes,...Object.fromEntries(ids.map(id=>
          [id,{...session.document.nodes[id],transform:pose.transforms[id]}]))}}
        const documentMs=performance.now()-documentStarted
        const scale=session.scene.view.zoom,base=session.window
        const affine = ids.some(id => pose.transforms[id].slice(0, 4).some((value, i) => value !== session.baseDocument.nodes[id]?.transform[i]))
        // Translation-localized captures cannot prove rotated paint/support.
        // Rebase once into a full-viewport, compiler-owned affine capture.
        if (affine && (!session.native || !session.affine)) { rebasePose(pose); break }
        const deltas = ids.map(id => previewTranslationDelta(session.scene, id, pose.transforms[id]))
        if (deltas.some(delta => !delta)) { rebasePose(pose); break }
        // session.window belongs to the initial capture. Native recompilation
        // replaces moved nodes, so their current previewSource cannot anchor a
        // cumulative displacement (a same-pose pointerup has delta zero).
        const shifts=session.affine||session.fixedWindow?[{x:0,y:0}]:ids.map((id,index)=>{
          const origin=session.origins.get(id)
          return origin && residentPoseShift(origin,session.scene.nodes[id].matrix,deltas[index]!)
        })
        if(shifts.some(shift=>!shift)){rebasePose(pose);break}
        let x=base.x+Math.min(0,...shifts.map(p=>p!.x)),y=base.y+Math.min(0,...shifts.map(p=>p!.y))
        let right=base.x+base.w+Math.max(0,...shifts.map(p=>p!.x)),bottom=base.y+base.h+Math.max(0,...shifts.map(p=>p!.y))
        if(displayFrame){
          const view=displayFrame.view,camera=session.scene.view
          const left=-view.x/view.zoom*scale+camera.x,top=-view.y/view.zoom*scale+camera.y
          x=Math.max(x,left);y=Math.max(y,top)
          right=Math.min(right,left+displayFrame.width/view.zoom*scale);bottom=Math.min(bottom,top+displayFrame.height/view.zoom*scale)
        }
        if(right<=x||bottom<=y){rebasePose(pose);break}
        const window={x,y,w:right-x,h:bottom-y}
        const displayGeometry=displayFrame?[displayFrame.view.x,displayFrame.view.y,displayFrame.view.zoom,
          displayFrame.width,displayFrame.height,displayFrame.dpr]:undefined
        const texture=gpu.driver.presentedContentToken?.(session.slot)
        // A terminal receipt can reuse a full-quality frame. A soft preview
        // of that same transform still owes the canvas its full filter.
        if((!pose.terminal || !session.scene.gestureSoftEffects) && session.native&&session.bounds&&session.reuse?.matches({scene:session.scene,driver:gpu.driver,texture,window,transforms:pose.transforms})){
          // This newer input requests the exact already-rendered pixels. Only
          // advance its presentation cohort; no new native mutation, packet,
          // upload or raster is necessary. Resource completion fences remain.
          if(advance?.pose===pose){
            const prepared=await ahead.take(advance.sequence)
            if(!prepared?.packet){rebasePose(pose);break}
            prepared.packet.discard()
            if(!current())continue
            advance=undefined
          }
          const bounds=session.bounds
          presentSampledPose(session,pose,bounds)
          reportDisplay({residentSample:{slot:session.slot,...pose.input,bounds,total:performance.now()-started,
            nativePose:true,samePoseReuse:true,compileMs:0,graphMs:0,finishMs:0,posePrepareMs:0,translationMs:0,
            sceneUpdateBytes:0,geometryUploadBytes:0,fieldUploadBytes:0,
            signature:displayFrame?residentFrameSignature(displayFrame):undefined}})
          continue
        }
        const translationStarted=performance.now()
        let poseCompileMs=0, sceneUpdateBytes=0
        let compileStats:Record<string,unknown>|undefined
        let next: GpuScene | null, poseKernel: RenderKernel | undefined
        if(session.native){
          const capture=session.scene.output||{x:0,y:0,w:session.scene.width,h:session.scene.height}
          if(x<capture.x||y<capture.y||right>capture.x+capture.w||bottom>capture.y+capture.h){rebasePose(pose,true);break}
          const kernel=poseKernel=await engine()
          let packet:CompiledScenePacket
          if (advance?.pose===pose && advance.session===session) {
            const prepared=await ahead.take(advance.sequence)
            if(!prepared?.packet){rebasePose(pose);break}
            if(!current())continue
            packet=prepared.packet.consume()
            poseCompileMs=prepared.compileMs
            advance=undefined
          } else {
            // A real in-flight motion can become the terminal input before its native reply.
            const direct=preparation && session.affine && session.canvasOwner && session.scene.interactionLocalFootprint &&
              !session.softEffectPreview && ids.length===1 && isInnerShadowFill(session.baseDocument.nodes[ids[0]]) ? preparation : undefined
            const apply=()=>kernel.apply_interaction_transforms(JSON.stringify(pose.transforms))
            if(!await (direct?direct.withPoseTransport(apply):apply())){rebasePose(pose);break}
            if(!current())continue
            const compileStarted=performance.now()
            const compile=()=>compilePacket(kernel,session.options,session.controller.signal)
            packet=await (direct?direct.withPoseTransport(compile):compile())
            if(!current())continue
            poseCompileMs=performance.now()-compileStarted
          }
          sceneUpdateBytes=packet.transport.scenePacketBytes
          const compiled=decodeScenePacket(packet)
          compileStats=kernel.compileStats
          next={...preparePreviewSelection(compiled,session.scene.interactionSelection||[]),
            interactionLocalFootprint:session.scene.interactionLocalFootprint,
            gestureSoftEffects:session.softEffectPreview === true && !pose.terminal,
            interactionSelection:session.scene.interactionSelection,interactionRetained:true,nativeInteraction:true,interactionLease:session.scene.interactionLease,interactionWindow:window,
            floatCompositing:session.scene.floatCompositing,pairedDisplayFilters:session.scene.pairedDisplayFilters,
            compactImageFields:session.scene.compactImageFields,displayFilters:session.scene.displayFilters,
            displayFilterRadiusLimit:session.scene.displayFilterRadiusLimit,
            displayImageSource:session.scene.displayImageSource,displayMaterialSource:session.scene.displayMaterialSource,
            displayTentRadius:session.scene.displayTentRadius}
          next=reuseExactSceneSources(session.scene,next,session.patch?.changedNodes)
        }else next=session.patch?session.patch.prepare(session.scene,pose.transforms,window):
          translatePreviewScene({...session.scene,interactionWindow:window},session.document,document!)
        const sameDisplay=displayGeometry?!!displayFrame&&[displayFrame.view.x,displayFrame.view.y,displayFrame.view.zoom,
          displayFrame.width,displayFrame.height,displayFrame.dpr].every((value,i)=>Object.is(value,displayGeometry[i])):!displayFrame
        if(session.native&&(!session.affine||session.scene.interactionLocalFootprint)&&current()&&sameDisplay){
          const ending=latestPendingPose(),disposition=terminalPoseDisposition(pose,ending)
          // Only a release hint can discard an obsolete preparation; moving
          // pointers keep normal sampling progress and cannot starve rendering.
          if(disposition==='changed')continue
          if(disposition==='same'&&ending){pose.input=ending.input;pose.terminal=true;pendingPose=undefined}
        }
        const translationMs=performance.now()-translationStarted,posePrepareMs=performance.now()-started
        if(!next){rebasePose(pose);break}
        next.gestureSoftEffects = session.softEffectPreview === true && !pose.terminal
        const visible=innerShadowContentWindow(session,next,window,ids)
        // Canvas repair rounds damage outwards and samples integer neighbours.
        next.interactionContentWindow=visible && intersect(window,guardedPixelWindow(visible))
        try{
          const hydrateImages = sceneImageHydration(await engine(), current)
          await hydrateImages(next)
          if(!current())continue
          prepareDisplay()
          const onFinishStarted = poseKernel && session.affine && session.canvasOwner && !pose.terminal &&
            next.interactionLocalFootprint && !next.gestureSoftEffects && ids.length===1 && isInnerShadowFill(session.baseDocument.nodes[ids[0]])
            ? () => {
              const kernel=poseKernel!
              beginTerminalPreparation=terminal=>{
                if(advance || session!==poseSession || session.stopped || session.controller.signal.aborted ||
                    terminalPoseDisposition(pose,terminal)!=='changed' || Object.keys(terminal.transforms).length!==1 ||
                    !Object.hasOwn(terminal.transforms,ids[0]) || !Array.isArray(terminal.transforms[ids[0]]) ||
                    terminal.transforms[ids[0]].length!==6 || !terminal.transforms[ids[0]].every(Number.isFinite))return
                const work:Advance={pose:terminal,sequence:terminal.input.sequence,session,kernel,previous:pose.transforms,mutated:false}
                advance=work
                const prepare=async()=>{
                  if(session!==poseSession || session.stopped || session.controller.signal.aborted)return {packet:undefined,compileMs:0}
                  work.mutated=true
                  if(!await kernel.apply_interaction_transforms(JSON.stringify(terminal.transforms))){work.mutated=false;return {packet:undefined,compileMs:0}}
                  const at=performance.now()
                  const packet=await journalCompile(()=>kernel.prepare_gpu_scene(session.options,session.controller.signal))
                  return {packet,compileMs:performance.now()-at}
                }
                ahead.start(terminal.input.sequence,()=>preparation?preparation.withPoseTransport(prepare):prepare())
              }
              const last=latestPendingPose()
              if(last?.terminal)beginTerminalPreparation(last)
            } : undefined
          const result=await failureAttempt(12, () => gpu!.render(next,false,true,current,undefined,false,onFinishStarted))
            .finally(()=>{beginTerminalPreparation=undefined})
          if(!result.gpuTile)throw Error('Resident movement did not produce a GPU texture')
          if(!current()){gpu.driver.releasePresented?.([result.gpuTile]);continue}
          gpu.driver.replacePresented(session.slot,result.gpuTile)
          // This scene describes the actual texture which just replaced the
          // slot. Small/unsupported effects can be admitted as exact pixels.
          next.gestureSoftEffects = result.gestureBlurPixels > 0
          session.scene=next
          if(session.patch)session.patch.accept(next,pose.transforms)
          else if(!session.native||pose.terminal){session.document=document!;laneState.interactionDocument=document;laneState.deferredInteractionDocument=document}
          laneState.compiledScene={revision:laneState.loadedRevision,options:session.options,scene:next}
          const content=visible??window
          const bounds={x:(content.x-next.view.x)/scale,y:(content.y-next.view.y)/scale,width:content.w/scale,height:content.h/scale}
          if(session.native){session.reuse??=new ResidentPoseReuse();session.reuse.record({scene:next,driver:gpu.driver,
            texture:gpu.driver.presentedContentToken?.(session.slot),window,transforms:pose.transforms})}
          presentSampledPose(session,pose,bounds)
          const poseStats=gpu.driver.stats?.()
          reportDisplay({residentSample:{slot:session.slot,...pose.input,bounds,total:performance.now()-started,
            nativePose:session.native===true,compileMs:poseCompileMs,
            compileStats,fieldUploadBytes:result.materialFieldUploadBytes,gestureBlurPixels:result.gestureBlurPixels,
            sceneUpdateBytes:session.native?sceneUpdateBytes:undefined,
            geometryUploadBytes:poseStats?.geometryUploadBytes,
            residentProgramHits:poseStats?.residentProgramHits,residentProgramHitBytes:poseStats?.residentProgramHitBytes,
            graphMs:result.graphMs,finishMs:result.finishMs,groupHits:result.retainedGroupHits,
            displayTentRadiusPasses:result.displayTentRadiusPasses,displayTentRadiusPixels:result.displayTentRadiusPixels,
            posePrepareMs,documentMs,translationMs,patchSession:!!session.patch,affectedNodes:session.patch?.affectedNodes,
            passTimings:poseStats?.passTimings,
            groupBytes:result.retainedGroupBytes,prefixHits:result.retainedPrefixHits,fieldHits:result.materialFieldHits,checkpointMs:result.checkpointMs,fieldMs:result.materialFieldBuildMs,
            drawCalls:result.drawCalls,passPixels:result.passPixels,textureBytes:result.textureBytes,
            signature:displayFrame?residentFrameSignature(displayFrame):undefined}})
        }catch(error){
          if(advance && latestPendingPose()===advance.pose && poseSession===session && !session.stopped &&
              String(error).includes('PREVIEW_CANCELLED'))continue
          if(current()){console.warn('[resident-interaction] rebuilding capture',String(error));rebasePose(pose)}break}
      }
    }catch(error){
      // Preparation/compilation can fail before GPU.render. Retire the lease
      // just like a raster failure so input never waits for an impossible ACK.
      if(runningPose && poseSession?.slot === runningPose.slot && !poseSession.stopped)rebasePose(runningPose)
      if(import.meta.env.DEV)console.warn('DESIGN_POSE',error)
    }finally{beginTerminalPreparation=undefined;await discardAdvance();poseQueued=false;if(pendingPose)schedulePose()}
  },1)
}
self.onmessage = (e) => {
  const request = e.data
  if (request.documentMemoryBytes !== undefined) {
    try { pinDocumentCapacity(request.documentMemoryBytes, 'trusted-worker-bootstrap') }
    catch (error) { self.postMessage({ id: request.id, error: String(error) }); return }
  }
  if (request.command === 'document-fallback') {
    const pending = documentFallbacks.get(request.id)
    if (pending) {
      documentFallbacks.delete(request.id); clearTimeout(pending.timer)
      if (typeof request.document === 'string') pending.resolve(request.document)
      else pending.reject(Error(request.error || 'DERIVATION_FALLBACK_INVALID'))
    }
    return
  }
  if(request.command==='terminal-diagnostics') {
    if(Number.isSafeInteger(request.session)&&request.session>=0&&request.session<1e12) {
      terminalDiagnostics.close()
      terminalDiagnostics=createRenderDiagnostics({enabled:true,detail:request.detail===true,batchSink:batch=>self.postMessage({renderDiagnostics:batch}),session:request.session,source:'worker',sink:record=>self.postMessage({renderDiagnostic:record})})
      setGpuDiagnosticsDetail(request.detail===true)
      setGpuDiagnosticSink((event,fields)=>terminalDiagnostics.record(event,{requestId:diagnosticRequestId,...fields as object}))
      terminalDiagnostics.record('start')
    }
    return
  }
  if (request.command === 'navigation-diagnostic') {
    try {
      if (request.action === 'start') {
        const options = validateNavigationJournalOptions(request.options === undefined ? {} : request.options)
        navigationJournal.start(options); navigationCompileSequence = 0; navigationCaptureGeneration++
        navigationTextureSet = []; navigationTextureSequence = 0
      } else if (request.action === 'stop') navigationJournal.stop(1)
      else if (request.action !== 'snapshot') throw Error('Invalid navigation diagnostic action')
      self.postMessage({ id: request.id, navigationDiagnostic: navigationJournal.report() })
    } catch { self.postMessage({ id: request.id, error: 'Invalid navigation diagnostic command' }) }
    return
  }
  if (request.command === 'prepare-port') {
    if (!preparation && !laneState.enginePromise && request.port instanceof MessagePort) preparation = new PreparationChannel(request.port, { enabled: () => terminalDiagnostics.enabled, owner: () => diagnosticRequestId, record: (event, fields) => terminalDiagnostics.record(event, fields) })
    return
  }
  const channel = request.channel === 'interaction' ? 'interaction' : 'canvas'
  if(request.command==='source-hit'){
    const canvas=lanes.get('canvas'),token=request.token
    void (async()=>{
      let sourceHit:unknown
      try{
        if(token&&canvas.sourceSnapshotToken===token&&preparation?.idle){
          const reply=await preparation.request('canvas','source_hit',[request.query])
          if(canvas.sourceSnapshotToken===token)sourceHit=reply.value
        }
      }catch{ /* An unavailable pick never changes the raster owner. */ }
      self.postMessage({id:request.id,sourceHit})
    })()
    return
  }
  if (request.command === 'display-attach') {
    try {
      executionPolicy=pinRenderPolicy(executionPolicy,request.executionPolicy)
      if(!allowsResidentSdr(executionPolicy))throw Error('Resident SDR display is not allowed by this host policy')
      displayCanvas=request.canvas;atomicDisplay=request.atomic===true;reportedResidentAttachment='';prepareDisplay()
      if(!gpu)reportDisplay({residentAttached:false,residentAttachmentReason:'pending-gpu'})
    }catch(error){reportDisplay({residentAttached:false,residentAttachmentReason:String(error),error:String(error)})}
    return
  }
  if(request.command==='display-accept'){
    try{if(Number.isSafeInteger(request.token)&&request.token>0)gpu?.driver.acceptPresentation?.(request.token,request.accepted===true)}catch(error){reportDisplay({error:String(error)})}
    return
  }
  if (request.command === 'display-frame') {
    if (navigationJournal.recording) navigationJournal.record(6, { sequence: request.sequence })
    if(!displayOrder.accept(request.sequence)){
      terminalDiagnostics.record('stale-drop',{sequence:request.sequence,reasonCode:2})
      reportDisplay({displayCommandsDropped:displayOrder.dropped});return
    }
    displayOrderSequence=request.sequence
    displayFrame=request.frame
    displayCoverageVersion = {}
    if(displayFrame&&poseSession?.input&&poseSession.bounds)
      displayFrame=withResidentPose(displayFrame,{slot:poseSession.slot,input:poseSession.input,bounds:poseSession.bounds})
    if(displayFrame)displayFrame.overlayAffines=displayedOverlayAffines(displayFrame)
    if (!displayFramePending) {
      displayFramePending=true
      // Input is already coalesced on the window's animation clock. A second
      // worker rAF can be throttled independently; use a task boundary here.
      displayTasks.port2.postMessage(0)
    }
    return
  }
  if (request.command === 'display-navigation-release') {
    gpu?.driver.releaseNavigationTransfer?.(request.token)
    return
  }
  if(request.command==='display-read-pixel'||request.command==='display-capture-content'||request.command==='display-navigation-tile'){
    void (async()=>{
      try{
        const result=request.command==='display-navigation-tile'?await gpu?.driver.captureNavigationTile?.(request.tile,request.id):
          request.command==='display-read-pixel'?await gpu?.driver.readContentPixel?.(request.u,request.v,request.expected):await gpu?.driver.captureContentBitmap?.()
        if(!result)throw Error('No displayed document content')
        try { self.postMessage({id:request.id,...result},{transfer:'bitmap' in result?[result.bitmap]:[]}) }
        catch (error) { if ('bitmap' in result) result.bitmap.close(); if ('navigationToken' in result) gpu?.driver.releaseNavigationTransfer?.(result.navigationToken); throw error }
      }catch(error){self.postMessage({id:request.id,error:String(error)})}
    })()
    return
  }
  if(request.command==='interaction-settle'){
    if(Number.isSafeInteger(request.sequence)&&poseSession&&!poseSession.stopped&&poseSession.slot===request.slot&&
      pendingPose&&pendingPose.slot===request.slot&&pendingPose.input.sequence===request.sequence&&pendingPose.input.owner===request.owner){
      pendingPose.terminal=true;beginTerminalPreparation?.(pendingPose)
    }
    return
  }
  if(request.command==='interaction-pose'){
    if(!request.input||!Number.isSafeInteger(request.input.sequence)||!Number.isFinite(request.input.at)||
        !request.transforms||typeof request.transforms!=='object')return
    if(poseSession&&poseSession.slot===request.slot&&!poseSession.stopped){
      if(pendingPose?.terminal && terminalPoseDisposition(pendingPose,request)==='same') pendingPose.input=request.input
      else pendingPose=request
      if(pendingPose!.terminal)beginTerminalPreparation?.(pendingPose!)
      schedulePose()
    }
    else rebasePose(request)
    return
  }
  if(request.command==='interaction-pose-stop'){
    if(poseSession&&poseSession.slot===request.slot){
      poseSession.stopped=true;poseSession.controller.abort()
      if(gpu)frozenOverlayPoses.freeze(gpu.driver,poseSession.slot,poseSession.scene)
    }
    if(pendingPose?.slot===request.slot)pendingPose=undefined
    return
  }
  if (request.command === 'display-release') {
    frozenOverlayPoses.release(request.ids)
    if(poseSession&&request.ids.includes(poseSession.slot)){poseSession?.controller.abort();poseSession=undefined;pendingPose=undefined}
    gpu?.driver.releasePresented?.(request.ids); return
  }
  if (request.command === 'cancel-request') {
    if (!Number.isSafeInteger(request.requestId)) return
    try {
      executionPolicy = pinRenderPolicy(executionPolicy, request.executionPolicy)
      for (const wait of packetWaits) if (wait.requestId === request.requestId) wait.controller.abort()
    } catch { /* malformed control envelope has no effect */ }
    return
  }
  if (request.command === 'cancel-preview') {
    terminalDiagnostics.record('cancel',{channel:channel==='interaction'?1:0,reasonCode:1,generation:previewGenerations[channel],fillGeneration:tileFillGeneration,activeRequestId:diagnosticRequestId,queueDepth:diagnosticQueueDepth})
    if (navigationJournal.recording) navigationJournal.record(10, { channel: channel === 'interaction' ? 1 : 0 })
    try {
      executionPolicy = pinRenderPolicy(executionPolicy, request.executionPolicy)
      previewGenerations[channel]++
      for (const wait of packetWaits) if (wait.channel === channel) wait.controller.abort()
    } catch {
      /* malformed control envelope has no effect */
    }
    return
  }
  if (request.command === 'cancel-tile-fill') {
    tileFillGeneration++
    for (const wait of packetWaits) if (wait.channel === 'canvas' && wait.tiled) wait.controller.abort()
    return
  }
  const generation = previewGenerations[channel]
  const fillGeneration = tileFillGeneration
  const cancellablePacket = request.options?.renderIntent === 'preview' &&
    (request.options?.livePreview === true || !!request.options?.tileViewport) &&
    !request.png && !request.readback && !request.options?.exportFormat && !request.options?.exportRegion && !request.options?.pixelPreview
  const packetWait = cancellablePacket ? { requestId: request.id, channel, tiled: !!request.options.tileViewport, controller: new AbortController() } : undefined
  if (packetWait) packetWaits.add(packetWait)
  let completedRegions=0
  const reportRasterProgress=()=>self.postMessage({id:request.id,rasterProgress:++completedRegions})
  let workProgress=0
  const reportWorkProgress=(stage:1|2,drawCalls=0)=>self.postMessage({id:request.id,workProgress:++workProgress,workStage:stage,drawCalls})
  diagnosticQueueDepth++
  terminalDiagnostics.record('queue-enqueue',{requestId:request.id,queueDepth:diagnosticQueueDepth,activeRequestId:diagnosticRequestId,generation,fillGeneration})
  const diagnosticQueuedAt=terminalDiagnostics.enabled?performance.now():0
  void queue.run(async () => {
    diagnosticQueueDepth--
    const previousDiagnosticRequestId=diagnosticRequestId
    const previousFailureAttempts=diagnosticFailureAttempts
    const failureAttempts=terminalDiagnostics.enabled ? new RenderFailureAttempts() : undefined
    diagnosticFailureAttempts=failureAttempts
    let diagnosticFailed=false, rendererCode=0
    diagnosticRequestId=request.id
    const diagnosticStarted=terminalDiagnostics.enabled?performance.now():0
    terminalDiagnostics.record('queue-start',{requestId:request.id,waitMs:diagnosticStarted-diagnosticQueuedAt,queueDepth:diagnosticQueueDepth,generation,fillGeneration,superseded:generation!==previewGenerations[channel]})
    if (navigationJournal.recording && request.options?.view) navigationJournal.record(3, { requestId: request.id, channel: channel === 'interaction' ? 1 : 0 })
    try {
      executionPolicy = pinRenderPolicy(executionPolicy, request.executionPolicy)
      const backend = effectiveBackend(executionPolicy, request.backend, request.png)
      if (executionPolicy.cpuOnly && request.command === 'lose-device')
        throw new Error('CPU-only execution forbids device tests')
      if (import.meta.env.DEV && request.command === 'lose-device') {
        if (!gpu) throw new Error('No active GPU to test')
        invalidateTileCache()
        navigationJournal.stop(5)
        await gpu.driver.loseDeviceForTesting()
        self.postMessage({ id: request.id })
        return
      }
      if(request.command==='prepare-source-display'){
        if(!gpu&&preparation&&backend==='webgpu'&&!executionPolicy.cpuOnly&&!executionPolicy.hdrCompositing){
          const {createGpu}=await import('./gpu/factory')
          const [renderer,kernelReady]=await Promise.allSettled([createGpu('webgpu',true,false,{documentSpace:'srgb',referenceWhiteNits:203,peakLuminanceNits:1000},
            managedImageLoader,false,true,!!executionPolicy.imageMips,!!executionPolicy.imageAtlas,false,executionPolicy.gpuWorkingBudgetMiB),engine()])
          if(renderer.status==='rejected')throw renderer.reason
          if(kernelReady.status==='rejected'){renderer.value.dispose();throw kernelReady.reason}
          gpu=renderer.value
          await gpu.driver.prepareSourceDisplay?.()
        }
        self.postMessage({id:request.id});return
      }
      if (request.command === 'park-gpu') {
        // The serialized queue is idle at this boundary. Retain the document,
        // fonts, decoded assets and CPU cache, but relinquish the device lease.
        noteRetiredDevice(gpu); gpu?.dispose(); gpu = undefined
        self.postMessage({ id: request.id })
        return
      }
      if (request.command === 'gpu-memory') {
        // Debug snapshot: the kernel ledger plus live driver accounting. A
        // worker whose engine never finished loading reports a null breakdown
        // rather than triggering the wasm/font load for a poll.
        const kernel = laneState.enginePromise ? await engine() : undefined
        const driverStats = gpu?.driver.stats?.() ?? null
        self.postMessage({
          id: request.id,
          gpuMemory: {
            kernelBreakdown: kernel ? await kernel.gpu_memory_breakdown() : null,
            rendererPolicy: gpu?.memoryPolicy() ?? null,
            backend: gpu?.driver.name ?? null,
          displayMath: gpu?.driver.displayMath === true,
            driverStats,
            deviceLost: driverStats?.deviceLost ?? gpu?.driver.lost ?? false,
          },
        })
        return
      }
      if (request.command === 'display-import') {
        let handedOff = false
        try {
          prepareDisplay(false)
          if(!gpu?.driver.importPresented) throw Error('No WebGPU device for display handoff')
          handedOff = true // importPresented owns closure, including failures.
          const gpuTile=gpu.driver.importPresented(request.bitmap)
          self.postMessage({id:request.id,gpuTile})
        } finally {
          if (!handedOff) request.bitmap?.close()
        }
        return
      }
      // A camera-only request carries no revision transition for its successor.
      // Reject it before lane initialization/deferred synchronization. Envelopes
      // must still be applied in order even when their requested pixels are old.
      if (packetWait?.controller.signal.aborted && request.document === undefined && request.documentPatch === undefined && request.deriveFrom === undefined && request.sourceSnapshot===undefined) {
        terminalDiagnostics.record('skip', { requestId: request.id, reasonCode: 1, skipped: 1, generation, fillGeneration })
        throw Error('PREVIEW_CANCELLED')
      }
      selectLane(request.channel === 'interaction' ? 'interaction' : 'canvas')
      if(channel==='interaction'){
        if(poseSession?.patch && request.document===undefined && request.deriveFrom===undefined){
          laneState.interactionDocument=poseSession.document=poseSession.patch.snapshot()
          laneState.deferredInteractionDocument=laneState.interactionDocument
        }
        poseSession?.controller.abort();poseSession=undefined;pendingPose=undefined
      }
      const kernel = await engine(),
        start = performance.now()
      const retainInteraction = request.options?.retainInteractionGraph === true && request.options?.renderIntent === 'preview' && request.options?.livePreview === true &&
        !request.options?.tileViewport && allowsResidentSdr(executionPolicy) && !request.png &&
        !request.options?.exportFormat && !request.options?.exportRegion && !request.options?.pixelPreview
      const { interactionOwner: _interactionOwner, interactionGeneration: _interactionGeneration, interactionBranch: _interactionBranch, interactionChannel: _interactionChannel, livePreview, sequentialViewport, retainInteractionGraph: _retainInteractionGraph, interactionNative, interactionAffine, interactionLocalFootprint, interactionBaseFill, interactionSelection, interactionWindow, interactionWindowFixed, previewTileFallback, tileViewport,
        tilePrepareViewport: requestedPrepareViewport, sourceMaterialOverview, tileFillPriorities, coverageTiles, tileOwner, exportFormat, renderIntent, ...renderOptions } = request.options
      const displayBackpressure=displayRasterBackpressure(request.options,{channel,png:request.png,readback:request.readback,hdr:executionPolicy.hdrCompositing})
      // Never accept display arithmetic authority from caller or document fields.
      delete (renderOptions as { displayTentRadius?: unknown }).displayTentRadius
      renderOptions.gpuDensePaint=import.meta.env.VITE_DESIGN_DENSE_PAINT!=='0' && sourceMaterialOverview===true && !!request.sourceSnapshot && channel==='canvas' &&
        renderIntent==='preview' && !!tileOwner && renderOptions.view.zoom<=1 && backend==='webgpu' &&
        renderOptions.rasterProfile==='figmaSubpixel'&&!executionPolicy.hdrCompositing&&!request.referenceGpu&&!request.png&&!request.readback&&
        !exportFormat&&!renderOptions.exportRegion&&!renderOptions.pixelPreview&&!renderOptions.animation || undefined
      const sourceFilterFields=import.meta.env.VITE_DESIGN_SOURCE_FILTER_LOD!=='0' && import.meta.env.VITE_DESIGN_GAUSSIAN_REGIONS!=='0' &&
        import.meta.env.VITE_DESIGN_GAUSSIAN_PREFIX!=='0' && !!request.sourceSnapshot &&
        channel==='canvas' && renderIntent==='preview' && !!tileOwner && renderOptions.view.zoom>=2 && !request.referenceGpu && !renderOptions.animation
      renderOptions.gpuGaussianRegions = (sourceFilterFields||
        import.meta.env.VITE_DESIGN_GAUSSIAN_REGIONS==='1'&&import.meta.env.VITE_DESIGN_GAUSSIAN_PREFIX==='1')&&
        !executionPolicy.hdrCompositing&&backend==='webgpu'&&!request.png&&!request.readback&&!exportFormat&&
        !renderOptions.exportRegion&&!renderOptions.pixelPreview&&renderOptions.rasterProfile==='figmaSubpixel'
      const gaussianReduction=Number(import.meta.env.VITE_DESIGN_GAUSSIAN_REDUCTION)
      renderOptions.gpuSourceFilterFields=!!renderOptions.gpuGaussianRegions&&sourceFilterFields
      renderOptions.gpuGaussianReduction=renderOptions.gpuGaussianRegions&&[2,4,8].includes(gaussianReduction)?gaussianReduction:0
      renderOptions.gpuNeutralPageGroup=import.meta.env.VITE_DESIGN_NEUTRAL_PAGE_GROUP==='1'&&!!renderOptions.gpuRoots&&
        renderOptions.rasterProfile==='figmaSubpixel'&&backend==='webgpu'&&!executionPolicy.hdrCompositing&&!request.png&&!request.readback&&
        !exportFormat&&!renderOptions.exportRegion&&!renderOptions.pixelPreview
      renderOptions.gpuPageBackground = channel === 'canvas' && !request.png && !request.readback
      renderOptions.gpuPainterSupport = usesPainterSupport(import.meta.env.VITE_DESIGN_EXACT_CLAMP_PREFIX,
        { backend, renderIntent, livePreview, tileViewport, png: request.png, exportFormat,
          exportRegion: renderOptions.exportRegion, pixelPreview: renderOptions.pixelPreview,
          rasterProfile: renderOptions.rasterProfile, interaction: channel === 'interaction' || retainInteraction,
          grid: renderOptions.grid, checkerboard: renderOptions.checkerboard })
      renderOptions.gpuPainterCaptureReads = usesPainterCaptureReads(import.meta.env.VITE_DESIGN_PAINTER_CAPTURE_READS,
        renderOptions.gpuPainterSupport)
      if(terminalDiagnostics.enabled && renderIntent==='canvas')gridMeasurements.record({gridKind:1,gridVisible:Number(!!renderOptions.grid&&!renderOptions.transparent&&renderOptions.view.zoom>0.13),gridSpacingClass:3,gridRedrawReason:2})
      const previewCurrent = () => !packetWait?.controller.signal.aborted && generation === previewGenerations[channel] &&
        (!tileViewport || channel !== 'canvas' || fillGeneration === tileFillGeneration)
      const retainCoverage = channel === 'canvas' && coverageTiles === true && !!tileViewport && renderIntent === 'preview'
      if(renderOptions.captureViewport&&(request.png||request.readback||tileViewport||renderOptions.pixelPreview||exportFormat||renderOptions.exportRegion))
        throw Error('Native viewport capture is only available for canvas presentation')
      // Readback is transport, not quality. Only an explicitly transient
      // preview may simplify effects; settled frames and exports never do.
      renderOptions.interactiveEffects = renderQualityContract({ renderIntent, png: request.png, exportFormat,
        exportRegion: renderOptions.exportRegion, desktopFullMath: executionPolicy.desktopFullMath }).existingInteractiveEffectsPolicy
      const boundedDisplayLimit = import.meta.env.VITE_DESIGN_BOUNDED_DISPLAY_FILTER === '1' && backend === 'webgpu' &&
        usesDesktopDisplay(executionPolicy, { renderIntent, rasterProfile: renderOptions.rasterProfile,
          png: request.png, readback: request.readback, exportFormat, exportRegion: renderOptions.exportRegion,
          pixelPreview: renderOptions.pixelPreview }) ? 32 : undefined
      const canvasDisplayFilters = boundedDisplayLimit !== undefined || usesCanvasDisplayFilters(executionPolicy, {
        renderIntent, png: request.png, readback: request.readback, exportFormat,
        exportRegion: renderOptions.exportRegion, pixelPreview: renderOptions.pixelPreview,
      })
      // Regional recovery preserves the caller's arithmetic contract; only
      // transport changes when a whole preview exceeds its allocation budget.
      const previewDisplayFilters = canvasDisplayFilters || usesTransientDisplayFilters(executionPolicy, {
        renderIntent, png: request.png, readback: request.readback, exportFormat,
        exportRegion: renderOptions.exportRegion, pixelPreview: renderOptions.pixelPreview,
      })
      const previewPresentOnly = !request.png && !request.readback && !exportFormat && !renderOptions.exportRegion
      const canvasMath = import.meta.env.VITE_DESIGN_DISPLAY_MATH !== '0' && request.debug?.displayMath !== false &&
        (!executionPolicy.desktopFullMath || import.meta.env.VITE_DESIGN_DESKTOP_NATIVE_MATH === '1') &&
        usesDisplayArithmetic(executionPolicy, { renderIntent, rasterProfile: renderOptions.rasterProfile,
          png: request.png, readback: request.readback, exportFormat, exportRegion: renderOptions.exportRegion,
          pixelPreview: renderOptions.pixelPreview })
      const canvasImageSource = import.meta.env.VITE_DESIGN_DESKTOP_IMAGE_SOURCE === '1' &&
        usesDesktopDisplay(executionPolicy, { renderIntent, rasterProfile: renderOptions.rasterProfile,
          png: request.png, readback: request.readback, exportFormat, exportRegion: renderOptions.exportRegion,
          pixelPreview: renderOptions.pixelPreview })
      const canvasTentRadius = usesDisplayTentRadiusIntent(import.meta.env.VITE_DESIGN_DISPLAY_TENT_RADIUS,
        import.meta.env.VITE_DESIGN_EXACT_CLAMP_PREFIX, executionPolicy, { renderIntent, rasterProfile: renderOptions.rasterProfile,
          png: request.png, readback: request.readback, exportFormat, exportRegion: renderOptions.exportRegion,
          pixelPreview: renderOptions.pixelPreview })
      const canvasMaterialSource = import.meta.env.VITE_DESIGN_DISPLAY_MATERIAL_SOURCE === '1' &&
        usesDesktopDisplay(executionPolicy, { renderIntent, rasterProfile: renderOptions.rasterProfile,
          png: request.png, readback: request.readback, exportFormat, exportRegion: renderOptions.exportRegion,
          pixelPreview: renderOptions.pixelPreview })
      const canvasViewportCapture = sequentialViewport === true &&
        (import.meta.env.VITE_DESIGN_SEQUENTIAL_DISPLAY === '1' || import.meta.env.VITE_DESIGN_ORIGINAL_VIEWPORT_CAPTURE === '1') &&
        backend !== 'cpu' && !tileViewport && !retainInteraction &&
        usesDesktopDisplay(executionPolicy, { renderIntent, rasterProfile: renderOptions.rasterProfile,
          png: request.png, readback: request.readback, exportFormat, exportRegion: renderOptions.exportRegion,
          pixelPreview: renderOptions.pixelPreview })
      // The original graph supports analytic sampling and every admitted
      // effect. This separate experiment keeps that graph instead of repeatedly
      // compiling captures which the narrower sequential graph cannot render.
      const canvasSequentialDisplay = canvasViewportCapture && import.meta.env.VITE_DESIGN_ORIGINAL_VIEWPORT_CAPTURE !== '1'
      if (sequentialViewport) {
        if (!canvasViewportCapture) throw Error('SEQUENTIAL_DISPLAY_UNSUPPORTED')
        // Reuse the existing bounded capture compiler. A whole nonregional
        // compile admits irrelevant offscreen effect halos at high zoom.
        renderOptions.captureViewport = { x: 0, y: 0, w: renderOptions.width, h: renderOptions.height }
      }
      // Canvas chrome is never authored/exported content.
      if (request.png || exportFormat || renderOptions.exportRegion) renderOptions.checkerboard = false
      const disableExactCache = request.debug?.disableExactTileCache === true
      const options = JSON.stringify({...renderOptions,...(renderOptions.captureViewport&&requestedPrepareViewport?{prepareViewport:requestedPrepareViewport}:{})})
      const synchronizeDeferred = async () => {
        if (!laneState.deferredInteractionDocument) return
        if(laneState.synchronizedInteractionDocument?.id===laneState.deferredInteractionDocument.id)
          await kernel.apply_document_patch_with_damage(JSON.stringify(documentPatch(laneState.synchronizedInteractionDocument,laneState.deferredInteractionDocument)))
        else await kernel.load_document(JSON.stringify(laneState.deferredInteractionDocument))
        laneState.synchronizedInteractionDocument=laneState.deferredInteractionDocument
        laneState.deferredInteractionDocument = undefined
      }
      const loadStage = (phase: number, at: number, fields = {}) => terminalDiagnostics.record('load-stage', { requestId: request.id, phase, durationMs: performance.now() - at, ...fields })
      if (!retainInteraction && !request.deriveFrom) { const at = performance.now(); await synchronizeDeferred(); loadStage(1, at) }
      let translated: { options: string; scene: GpuScene } | undefined
      // Keep the immutable authored snapshot in both lanes. It also proves
      // whether the last displayed pose is exactly the patch being committed.
      let paintDamage: PaintDamage | undefined
      let priorRepairOwner: object | undefined
      let translatedPageCommit:{sourceOwner:object;targetOwner:object;offset:{x:number;y:number}}|undefined
      let derived = false
      let derivedSource: { document: DesignDocument; json?: string } | undefined
      let derivedImageOwner:ReturnType<typeof createDecodedImageOwner>|undefined
      let acknowledgedSource = false
      if(request.sourceSnapshot!==undefined&&(request.document!==undefined||request.documentPatch!==undefined||request.deriveFrom!==undefined||channel!=='canvas'))throw Error('Invalid source canvas synchronization envelope')
      if (request.deriveFrom !== undefined) {
        const deriveAt = performance.now()
        try {
          if (channel !== 'interaction' || request.document !== undefined || request.documentPatch !== undefined) throw Error('DERIVATION_INVALID_ENVELOPE')
          const source = lanes.get('canvas'), sourceKernel = await source.enginePromise
          const proof = synchronizedAuthored.get('canvas')
          if (!proof || source.deferredInteractionDocument || source.synchronizedInteractionDocument !== proof.document ||
            !samePreparationReceipt(request.deriveFrom, proof.receipt) ||
            !samePreparationReceipt(request.deriveFrom, sourceKernel?.preparationStateReceipt)) throw Error('DERIVATION_STALE_SOURCE')
          let pose:Record<string,import('../model').Matrix>|undefined
          if(request.derivedTransforms!==undefined){
            const rows=Object.entries(request.derivedTransforms)
            if(!request.derivedTransforms||Array.isArray(request.derivedTransforms)||rows.length===0||rows.length>16||
              rows.some(([id,m])=>!Object.hasOwn(proof.document.nodes,id)||!Array.isArray(m)||m.length!==6||!m.every(Number.isFinite)))
              throw Error('DERIVATION_INVALID_POSE')
            pose=request.derivedTransforms
          }
          await kernel.derive_document_v1(request.deriveFrom)
          // Reuse the acknowledged authored object directly. A postpatch source
          // deliberately has no freshly serialized full JSON envelope.
          derivedSource = { document: proof.document, json: source.authoredSnapshot?.document === proof.document ? source.authoredSnapshot.json : undefined }
          if(pose){
            const patch:DocumentPatch={fields:{},nodes:Object.fromEntries(Object.entries(pose).map(([id,transform])=>[id,{...proof.document.nodes[id],transform}]))}
            const next=applyDocumentPatch(proof.document,patch)
            if(!await kernel.apply_interaction_transforms(JSON.stringify(pose)))
              await kernel.apply_document_patch_with_damage(JSON.stringify(patch))
            derivedSource={document:next}
          }
          derived = true
          derivedImageOwner=source.decodedImageOwner
          loadStage(5, deriveAt, { derivationAdmitted: true, fullPayloadBytes: 0 })
        } catch (error) {
          derivedSource=undefined;derivedImageOwner=undefined;derived=false
          failureAttempts?.observe(error,3)
          loadStage(6, deriveAt, { derivationAdmitted: false, derivationFallback: true, derivationReasonCode: /STALE_SOURCE|STALE_BASE/.test(String(error)) ? 1 : /STALE_TARGET/.test(String(error)) ? 2 : /UNSUPPORTED/.test(String(error)) ? 3 : 4 })
          request.document = await failureAttempt(11, () => capturedDocumentFallback(request.id))
        }
      }
      if(request.sourceSnapshot!==undefined){
        const source=sourceRenderSnapshot(request.sourceSnapshot)
        if(source.pageId!==renderOptions.pageId)throw Error('Source canvas page changed')
        if(laneState.sourceSnapshotToken!==source.token||!kernel.preparationStateReceipt){
          synchronizedAuthored.delete(channel)
          laneState.sourceSnapshotToken=undefined;laneState.authoredSnapshot=undefined
          laneState.interactionDocument=undefined;laneState.synchronizedInteractionDocument=undefined;laneState.deferredInteractionDocument=undefined
          const at=performance.now(),actual=await kernel.load_source_snapshot(source.token)
          if(actual.documentId!==source.owner.documentId||actual.pageId!==source.pageId||actual.stageId!==source.stageId||actual.nodes!==source.nodes)throw Error('Native source canvas identity mismatch')
          laneState.sourceSnapshotToken=source.token;laneState.loadedDocument=''
          laneState.loadedDocumentId=actual.documentId;laneState.loadedNodeCount=actual.nodes
          laneState.documentGeneration++;laneState.decodedImageOwner=createDecodedImageOwner()
          invalidateOwnerTileCache();laneState.compiledScene=undefined;paintDamage=undefined
          loadStage(3,at,{fullPayloadBytes:0,count:actual.nodes})
        }
        laneState.loadedRevision=request.documentRevision;acknowledgedSource=true
      } else if (derivedSource || request.document !== undefined) {
        let nativeImageDecoderFork = false
        laneState.sourceSnapshotToken=undefined
        synchronizedAuthored.delete(channel)
        // A full resynchronization is a new owner even if its authored id repeats.
        laneState.deferredInteractionDocument = undefined
        laneState.documentGeneration++
        laneState.decodedImageOwner = createDecodedImageOwner()
        invalidateOwnerTileCache()
        laneState.authoredSnapshot = undefined
        const snapshotAt = performance.now()
        laneState.interactionDocument = derivedSource?.document ?? failureAttempt(2, () => readAuthoredSnapshot(request.document,
          channel === 'interaction' ? lanes.get('canvas')?.authoredSnapshot : undefined))
        loadStage(2, snapshotAt, terminalDiagnostics.detail
          ? snapshotResourceFields(derivedSource ? 0 : request.document.length, laneState.interactionDocument.fonts) : {})
        laneState.loadedDocumentId = laneState.interactionDocument.id
        laneState.loadedNodeCount = Object.keys(laneState.interactionDocument.nodes).length
        laneState.synchronizedInteractionDocument=laneState.interactionDocument

        if (derived || request.document !== laneState.loadedDocument || request.documentRevision !== laneState.loadedRevision) {
          const loadAt = performance.now(), forks = kernel.documentForks
          if (!derived) {
            await kernel.load_document(request.document)
            nativeImageDecoderFork = kernel.lastDocumentLoadWasForked
          }
          loadStage(3, loadAt, { documentFork: kernel.documentForks > forks })
          laneState.loadedDocument = derivedSource?.json ?? request.document ?? ''
          laneState.compiledScene = undefined
          paintDamage = undefined
        }
        laneState.loadedRevision = request.documentRevision
        const canvasSource = channel === 'interaction' ? lanes.get('canvas') : undefined
        // Identity comes from complete JSON equality, acknowledged derivation,
        // or this load's native canvas-to-interaction full-snapshot fork. IDs/revisions alone never
        // authorize this reuse, including a same-ID reopen. Pure pose patches
        // keep the token: changed assets have different full URI entry keys and
        // changed working settings have a different residency scope.
        if (canvasSource && !canvasSource.deferredInteractionDocument &&
            (nativeImageDecoderFork || canvasSource.interactionDocument === laneState.interactionDocument &&
            canvasSource.synchronizedInteractionDocument === laneState.interactionDocument))
          laneState.decodedImageOwner = canvasSource.decodedImageOwner
        else if(derivedImageOwner)laneState.decodedImageOwner=derivedImageOwner
        // Native full-byte snapshot matching can prove the fork even when
        // the UI no longer retains the old serialized snapshot after edits.
        // The receipt is emitted only for native lane 0 -> lane 1 equality.
        // Image assets may share their immutable owner; document/pose and
        // geometry/resource receipts remain separate.
        if (canvasSource?.enginePromise && (canvasSource.decodedImageOwner === laneState.decodedImageOwner ||
            nativeImageDecoderFork))
          kernel.shareImageDecoder(await canvasSource.enginePromise)
        // Publish only after successful kernel synchronization. A failed load
        // or any later patch must never leave a reusable source certificate.
        const sourceJson = derivedSource?.json ?? request.document
        laneState.authoredSnapshot = sourceJson === undefined ? undefined : { json: sourceJson, document: laneState.interactionDocument }
        acknowledgedSource = true
      } else if (request.documentPatch !== undefined) {
        if(laneState.sourceSnapshotToken)throw Error('Native source edits require their source scope')
        const patchAt = performance.now()
        const predecessor = synchronizedAuthored.get(channel)
        synchronizedAuthored.delete(channel)
        const actualBefore = laneState.synchronizedInteractionDocument
        const priorAuthoredDocument = laneState.interactionDocument
        const wasDeferred = !!laneState.deferredInteractionDocument
        laneState.authoredSnapshot = undefined
        if (request.baseDocumentRevision !== laneState.loadedRevision)
          throw new Error('文档补丁版本未同步，请重试当前画布')
        const patch = failureAttempt(4, () => JSON.parse(request.documentPatch)) as DocumentPatch
        if (laneState.interactionDocument) {
          const next = failureAttempt(4, () => applyDocumentPatch(laneState.interactionDocument!, patch))
          if (retainInteraction && !interactionNative && laneState.compiledScene?.revision === laneState.loadedRevision) {
            const moved = translatePreviewScene(laneState.compiledScene.scene, laneState.interactionDocument, next)
            if (moved) translated = { options: laneState.compiledScene.options, scene: moved }
          }
          laneState.interactionDocument = next
          laneState.loadedNodeCount = Object.keys(next.nodes).length
        }
        // Translation already passed geometry/clipping/resource validation and
        // uses the identical compile options. Avoid re-running Rust document
        // layout/damage on every pointer event. Any other request synchronizes
        // the latest authored snapshot before touching the CPU kernel again.
        const defer = translated?.options === options && request.debug?.disableSceneCache !== true
        if (!defer) await synchronizeDeferred()
        // Old preparation backends may ignore extra arguments. Only the
        // explicit guarded-patch capability certifies authoritative native CAS.
        const guardedPatchSupported = request.patchBaseReceipt !== undefined && await kernel.supportsAcknowledgedPatches()
        // Check the acknowledged source immediately before synchronous enqueue;
        // the backend repeats this CAS against its actual state before mutation.
        // Deferred translation and an incomplete proof chain are ordinary
        // optimization misses, not rejected edits. Keep legacy synchronization
        // semantics and never renew authored authority in those cases.
        const guardCandidate = guardedPatchSupported && channel === 'canvas' && !defer && !wasDeferred &&
          !!predecessor && !!actualBefore && predecessor.document === actualBefore
        const canGuard = guardCandidate &&
          samePreparationReceipt(request.patchBaseReceipt, predecessor.receipt) &&
          samePreparationReceipt(request.patchBaseReceipt, kernel.preparationStateReceipt)
        if (guardCandidate && !canGuard) { laneState.interactionDocument = priorAuthoredDocument; throw Error('STALE_AUTHORED_PATCH_BASE') }
        // The worker's rendering projection can omit authored optional nulls.
        // A conservative subset mismatch must not reject an otherwise valid
        // edit: keep backend CAS but withhold renewal of authored authority.
        const canAcknowledge = canGuard && boundedPatchWire(request.documentPatch) && supportsAcknowledgedPropertyPatch(actualBefore!, patch)
        const transforms = channel === 'interaction' && retainInteraction && interactionNative &&
          laneState.synchronizedInteractionDocument && interactionPatchTransforms(laneState.synchronizedInteractionDocument, patch, interactionSelection || [])
        const priorPixelOwner=kernel.contentIdentity
        const nativePose = !!transforms && await kernel.apply_interaction_transforms(JSON.stringify(transforms))
        const damage = nativePose ? { full: true, bounds: null, reason: 'native-interaction-pose' } : defer ? { full: true, bounds: null, reason: 'transient-translation' } :
          JSON.parse(await kernel.apply_document_patch_with_damage(request.documentPatch, canGuard ? request.patchBaseReceipt : undefined).catch(error => {
            if (canGuard) laneState.interactionDocument = priorAuthoredDocument
            throw error
          })) as {full:boolean;translationOnly?:boolean;bounds:[number,number,number,number]|null;rects?:[number,number,number,number][];reason?:string}
        if(!defer)laneState.synchronizedInteractionDocument=laneState.interactionDocument
        acknowledgedSource = canAcknowledge
        if (defer) laneState.deferredInteractionDocument = laneState.interactionDocument
        // Kernel-tiled frames consume the same damage: full repaint, bounded
        // world rects, or no paint change.
        paintDamage = {full:damage.full,translationOnly:damage.translationOnly,bounds:damage.bounds??undefined,rects:damage.rects,reason:damage.reason}
        if(channel==='canvas'){
          const offset=actualBefore&&laneState.interactionDocument&&pageTranslationCommit(actualBefore,laneState.interactionDocument,renderOptions.pageId,patch,paintDamage)
          // This is private display reuse after an accepted native mutation,
          // not renewal of an authored-document derivation receipt. Optional
          // wire projection differences may withhold that public receipt even
          // though these exact synchronized pixels and native translation proof
          // remain valid. A deferred/unsynchronized source cannot qualify.
          const synchronizedPixels=!wasDeferred&&!!actualBefore&&actualBefore===priorAuthoredDocument
          if (synchronizedPixels && !damage.full && laneState.interactionDocument &&
              isInnerShadowPosePatch(actualBefore,laneState.interactionDocument,patch)) {
            priorRepairOwner = priorPixelOwner
            // This accepted one-layer transform (including Undo) advances the
            // same native pose lease. A reload or a different layer breaks it.
            const session = poseSession, ids = session?.scene.interactionSelection
            if (session?.native && session.canvasOwner === priorPixelOwner && ids?.length === 1 &&
                Object.hasOwn(patch.nodes, ids[0])) session.canvasOwner = kernel.contentIdentity
          }
          if(synchronizedPixels&&priorPixelOwner&&offset)translatedPageCommit={sourceOwner:priorPixelOwner,targetOwner:kernel.contentIdentity,offset}
          if(terminalDiagnostics.detail)terminalDiagnostics.record('cache',{requestId:request.id,pageCommitStage:1,
            pageCommitChecks:Number(synchronizedPixels)|Number(damage.translationOnly===true)<<1|Number(!!actualBefore)<<2|
              Number(!!laneState.interactionDocument)<<3|Number(!!priorPixelOwner)<<4|Number(!!offset)<<5|Number(canAcknowledge)<<6})
        }
        // Report paint damage before any tile of this request so the surface
        // can evict stale residents before replacements arrive.
        self.postMessage({
          id: request.id,
          channel: request.channel,
          damage: paintDamage,
        })
        tileCache.revoke(entry => paintDamageIntersects(paintDamage!,entry.worldBounds))
        // Default font/runtime bytes are fixed for this worker's lifetime.
        // Any embedded-font update conservatively changes the resource envelope.
        if (Object.hasOwn(patch.fields || {}, 'fonts')) {
          laneState.resourceGeneration++
          invalidateOwnerTileCache()
        }
        laneState.loadedDocument = ''
        laneState.loadedRevision = request.documentRevision
        laneState.compiledScene = undefined
        loadStage(4, patchAt)
      }
      if (request.documentRevision !== laneState.loadedRevision) throw new Error('渲染文档版本未同步')
      const synchronizedReceipt = acknowledgedSource && !laneState.deferredInteractionDocument ? kernel.preparationStateReceipt : undefined
      if (synchronizedReceipt && laneState.synchronizedInteractionDocument)
        synchronizedAuthored.set(channel, { document: laneState.synchronizedInteractionDocument, receipt: synchronizedReceipt })
      if (request.document !== undefined || request.documentPatch !== undefined || request.deriveFrom !== undefined || request.sourceSnapshot!==undefined) {
        const receipt = channel === 'canvas' && acknowledgedSource && !laneState.deferredInteractionDocument &&
          await kernel.supportsDocumentDerivation() ? kernel.preparationStateReceipt : undefined
        self.postMessage({ id: request.id, documentSynchronized: true, stateReceipt: receipt ?? null })
      }
      // Apply the versioned document envelope even when its pixels were
      // superseded; the following request may legitimately patch this revision.
      if ((livePreview || tileViewport) && (packetWait?.controller.signal.aborted || generation !== previewGenerations[channel])) throw Error('PREVIEW_CANCELLED')
      // Camera-only cancellation must still apply the ordered document above,
      // but need not initialize GPU pipelines or hydrate a stale raster batch.
      // Page coverage is useful across cameras and keeps its explicit exemption.
      if (tileViewport && channel === 'canvas' && fillGeneration !== tileFillGeneration)
        throw Error('PREVIEW_CANCELLED')
      if (laneState.deferredInteractionDocument && translated?.options !== options && laneState.compiledScene?.options !== options) await synchronizeDeferred()
      const hydrateImages = sceneImageHydration(kernel, () => !(livePreview || tileViewport) || previewCurrent())
      const settingsJson = kernel.color_settings()
      const color: ColorSettings | undefined = JSON.parse(settingsJson) || undefined
      if (tileOwner !== undefined && (!tileOwner || typeof tileOwner !== 'object' ||
          tileOwner.documentId !== laneState.loadedDocumentId || !Number.isSafeInteger(tileOwner.sessionEpoch) ||
          tileOwner.sessionEpoch < 0)) throw new Error('Invalid tile session owner')
      // Explicit UI session ownership is required for cross-revision reuse.
      const tileOwnerKey = tileOwner === undefined ? ['revision', laneState.loadedRevision] :
        ['session', tileOwner.documentId, tileOwner.sessionEpoch]
      const loadMs = performance.now() - start
      const wantsReference = import.meta.env.DEV && request.referenceGpu === true
      const wantsBatch = !(import.meta.env.DEV && request.debug?.disableSolidBatch)
      const cacheScene = !(import.meta.env.DEV && request.debug?.disableSceneCache)
      if (cacheScene && translated?.options === options)
        laneState.compiledScene = { revision: laneState.loadedRevision, options, scene: translated.scene }
      if (
        settingsJson !== colorKey ||
        preference !== backend ||
        wantsReference !== referenceGpu ||
        wantsBatch !== solidBatchGpu
      ) {
        noteRetiredDevice(gpu)
        invalidateTileCache()
        gpu?.dispose()
        gpu = undefined
        unavailable.clear()
        colorKey = settingsJson
        preference = backend
        referenceGpu = wantsReference
        solidBatchGpu = wantsBatch
        tiledPreviewMode = false
      }
      if (gpu?.driver.lost) {
        const observation = beginDeviceRecovery(gpu.driver, 4, diagnosticRequestId)
        previousDeviceDiagnostic = { devicePreviousIncarnation: deviceDiagnosticFields(gpu.driver).deviceIncarnation || 0 }
        navigationJournal.stop(5)
        noteRetiredDevice(gpu)
        invalidateTileCache()
        gpu.dispose()
        gpu = undefined
        observation.end(deviceLifecyclePhase.recoveryRetired)
      }
      const candidates = rasterCandidates(executionPolicy, preference, request.png)
      let scene: GpuScene | undefined
      let compileMs = 0
      let compileCacheHit = false
      const failures = new Map(unavailable)
      for (const backend of candidates) {
        rendererCode = backend === 'webgpu' ? 2 : backend === 'webgl2' ? 3 : 0
        try {
          if (tileViewport) {
            const sourceBand=channel==='canvas'&&!!request.sourceSnapshot&&!!tileOwner&&renderOptions.view.zoom>=8&&renderIntent==='preview'&&renderOptions.rasterProfile==='figmaSubpixel'&&backend==='webgpu'&&!executionPolicy.hdrCompositing&&!request.referenceGpu&&!renderOptions.exportRegion&&!renderOptions.pixelPreview&&!renderOptions.animation&&!request.png&&!request.readback&&!exportFormat
            const tileSide=(sourceBand?MATERIAL_BAND:TILE_SIDE)+2
            if (
              !Array.isArray(tileViewport) ||
              tileViewport.length > 256 ||
              tileViewport.some(
                (t) =>
                  ![t.x, t.y, t.width, t.height].every(Number.isSafeInteger) ||
                  t.width < 1 ||
                  t.height < 1 ||
                  t.width > tileSide ||
                  t.height > tileSide ||
                  !Number.isFinite(t.zoom) ||
                  t.zoom < 0.001 ||
                  t.zoom > MAX_CANVAS_RASTER_SCALE ||
                  ![t.phaseX ?? 0, t.phaseY ?? 0].every((p) => Number.isFinite(p) && p >= 0 && p < 1) ||
                  typeof t.key !== 'string' ||
                  t.key.length > 256,
              )
            )
              throw new Error('Invalid tile request')
            if (tileFillPriorities !== undefined && !validTileFillPriorities(tileFillPriorities, tileViewport.length))
              throw new Error('Invalid tile priority hints')
            if(channel==='canvas'&&translatedPageCommit&&!tileViewport.length&&renderIntent==='canvas'&&
              !request.readback&&!request.png&&!exportFormat&&!renderOptions.exportRegion&&
              !renderOptions.grid&&!renderOptions.checkerboard&&!renderOptions.pixelPreview&&allowsResidentSdr(executionPolicy)&&
              executionPolicy.desktopFullMath&&!canvasDisplayFilters&&!previewDisplayFilters&&!canvasMath&&!canvasTentRadius&&
              !canvasImageSource&&!canvasMaterialSource&&gpu?.driver.snapshotPageTranslation){
              // Give the already queued final display command its ordinary
              // task boundary. Only the presenter's actual accepted backing,
              // never that requested frame, may certify the following copy.
              await yieldPreviewTask()
              if(generation!==previewGenerations.canvas)throw Error('PREVIEW_CANCELLED')
              let snapshot:ReturnType<NonNullable<typeof gpu.driver.snapshotPageTranslation>>
              try{snapshot=gpu.driver.snapshotPageTranslation(translatedPageCommit.sourceOwner,translatedPageCommit.targetOwner,
                translatedPageCommit.offset,renderOptions.width,renderOptions.height,renderOptions.view.zoom,pixelSourceContract(renderOptions))}
              catch(error){if(!isDisplayBudgetError(error))throw error}
              if(snapshot){
                const {view,dpr,width,height}=snapshot.frame
                self.postMessage({id:request.id,tile:{key:`commit:${laneState.loadedRevision}:${snapshot.gpuTile}`,
                  x:-view.x*dpr,y:-view.y*dpr,width:Math.ceil(width*dpr),height:Math.ceil(height*dpr),zoom:view.zoom*dpr,
                  gutter:0,committedViewport:true,viewportPreview:true,gpuTile:snapshot.gpuTile,backend,description:'retained native page translation',cached:false}})
                self.postMessage({id:request.id,backend,milliseconds:performance.now()-start,compileMs:0,loadMs,retainedCommit:true})
                return
              }
            }
            if (channel === 'canvas' && request.documentPatch && !tileViewport.length && poseQueued) {
              // The final pointer pose may arrive while the CPU worker applies
              // this patch. Complete that higher-priority GPU job before proving
              // whether the already-rendered native frame can be committed.
              // Otherwise a harmless scheduling race triggers a full tile refill.
              await queue.yieldToHigherPriority(0)
              selectLane('canvas')
              if (generation !== previewGenerations.canvas) throw Error('PREVIEW_CANCELLED')
            }
            const settledPose = poseSession
            if (channel === 'canvas' && request.documentPatch && !tileViewport.length &&
                renderIntent === 'canvas' && !request.readback && !renderOptions.grid && !renderOptions.checkerboard &&
                !renderOptions.pixelPreview && allowsResidentSdr(executionPolicy) &&
                laneState.interactionDocument && settledPose?.input && displayFrame && gpu?.driver.snapshotPresented &&
                renderOptions.view.zoom === settledPose.scene.view.zoom &&
                renderOptions.width === Math.ceil(displayFrame.width * displayFrame.dpr) &&
                renderOptions.height === Math.ceil(displayFrame.height * displayFrame.dpr) &&
                JSON.parse(settledPose.options).pageId === renderOptions.pageId &&
                JSON.parse(settledPose.options).rasterProfile === renderOptions.rasterProfile &&
                canCommitResidentFrame(settledPose.scene, () => settledPose.patch?.snapshot() ?? settledPose.document,
                  laneState.interactionDocument, displayFrame, settledPose.input)) {
              let snapshot: ReturnType<NonNullable<typeof gpu.driver.snapshotPresented>>
              try { snapshot = gpu.driver.snapshotPresented() }
              catch (error) { if (!isDisplayBudgetError(error)) throw error }
              if (snapshot && matchesResidentFrame(settledPose.scene, snapshot.frame, settledPose.input)) {
                const { view, dpr, width, height } = snapshot.frame
                self.postMessage({ id: request.id, tile: { key: `commit:${laneState.loadedRevision}:${snapshot.gpuTile}`,
                  x: -view.x * dpr, y: -view.y * dpr, width: Math.ceil(width * dpr), height: Math.ceil(height * dpr),
                  zoom: view.zoom * dpr, gutter: 0, committedViewport: true, viewportPreview: true,
                  gpuTile: snapshot.gpuTile, backend, description: 'retained native viewport', cached: false } })
                self.postMessage({ id: request.id, backend, milliseconds: performance.now() - start,
                  compileMs: 0, loadMs, retainedCommit: true })
                return
              }
              if (snapshot) gpu.driver.releasePresented?.([snapshot.gpuTile])
            }
            if (priorRepairOwner && paintDamage && !tileViewport.length && displayFrame && renderIntent==='canvas' &&
                renderOptions.rasterProfile==='figmaSubpixel' && backend==='webgpu' && allowsResidentSdr(executionPolicy) &&
                !request.png && !request.readback && !exportFormat && !request.sourceSnapshot && !renderOptions.animation &&
                !renderOptions.grid && !renderOptions.checkerboard && !renderOptions.exportRegion && !renderOptions.pixelPreview &&
                !canvasDisplayFilters && !previewDisplayFilters && !canvasMath && !canvasTentRadius &&
                !canvasImageSource && !canvasMaterialSource && gpu?.driver.beginViewportRepair) {
              const {width,height,view}=renderOptions, frame=displayFrame, driver=gpu.driver
              const contract=pixelSourceContract(renderOptions), owner=kernel.contentIdentity
              const sameView=()=>displayFrame?.view.x===frame.view.x && displayFrame?.view.y===frame.view.y &&
                displayFrame?.view.zoom===frame.view.zoom && displayFrame?.width===frame.width &&
                displayFrame?.height===frame.height && displayFrame?.dpr===frame.dpr
              const region=viewportDamage(paintDamage,view,width,height)
              if (region && view.zoom===frame.view.zoom*frame.dpr && view.x===frame.view.x*frame.dpr && view.y===frame.view.y*frame.dpr &&
                  width===frame.width*frame.dpr && height===frame.height*frame.dpr) {
                let repair:ReturnType<NonNullable<Driver['beginViewportRepair']>>, captured:TileRender|undefined, output:number|undefined
                let compileMs=0
                try {
                  repair=driver.beginViewportRepair!(priorRepairOwner,owner,contract,view,width,height,region)
                  if(repair){
                    const pose=localRepairSource(settledPose,laneState.interactionDocument,driver,view,contract,region,owner)
                    if (pose) output=repair.finish(pose.id,pose)
                    if (!output) {
                      const at=performance.now()
                      const packet=await compilePacket(kernel,JSON.stringify({...renderOptions,captureViewport:region}),packetWait?.controller.signal)
                      compileMs=performance.now()-at
                      if(!previewCurrent())throw Error('PREVIEW_CANCELLED')
                      captured=await renderTiledPreview(kernel,renderOptions,backend,color,settingsJson,Math.max(region.w,region.h),
                        {x:region.x,y:region.y,width:region.w,height:region.h},{...decodeScenePacket(packet),repairOutput:true},false,undefined,true,
                        false,false,reportRasterProgress,previewCurrent,hydrateImages,undefined,false,undefined,false,false,undefined,displayBackpressure)
                      if(!previewCurrent())throw Error('PREVIEW_CANCELLED')
                      if(captured.gpuTile && gpu?.driver===driver && owner===kernel.contentIdentity && sameView()){
                        driver.tagExactTile?.(captured.gpuTile,owner,contract,0)
                        output=repair.finish(captured.gpuTile)
                      }
                    }
                    if(output){
                      self.postMessage({id:request.id,tile:{key:`repair:${laneState.loadedRevision}:${output}`,x:-view.x,y:-view.y,width,height,
                        zoom:view.zoom,gutter:0,committedViewport:true,viewportPreview:true,gpuTile:output,backend,description:'exact local repair',cached:false}})
                      output=undefined // ownership transferred to the surface
                      self.postMessage({id:request.id,backend,milliseconds:performance.now()-start,compileMs:compileMs+(captured?.compileMs??0),
                        graphMs:captured?.graphMs??0,finishMs:captured?.finishMs??0,drawCalls:captured?.drawCalls??0,retainedCommit:true})
                      return
                    }
                  }
                } catch(error) {
                  if(!isDisplayBudgetError(error)&&!isAnalyticProgramBudget(error)&&!isScenePathBudget(error)&&
                    !/GPU surface budget exceeded|GPU 表面内存预算超限/.test(String(error)))throw error
                } finally {
                  repair?.cancel()
                  if(output)driver.releasePresented?.([output])
                  if(captured?.gpuTile)driver.releasePresented?.([captured.gpuTile])
                  captured?.bitmap?.close()
                }
              }
            }
            // A small exact viewport capture can replace dozens of repeated
            // tile graphs after a page translation. It uses the same native
            // camera/phase and full filter support; failure keeps tiled repair.
            if(import.meta.env.VITE_DESIGN_COMMIT_CAPTURE==='1'&&channel==='canvas'&&translatedPageCommit&&!tileViewport.length&&
                renderIntent==='canvas'&&backend==='webgpu'&&displayFrame&&!request.readback&&!request.png&&!exportFormat&&
                !renderOptions.exportRegion&&!renderOptions.grid&&!renderOptions.checkerboard&&!renderOptions.pixelPreview&&
                allowsResidentSdr(executionPolicy)&&!canvasDisplayFilters&&!previewDisplayFilters&&!canvasMath&&!canvasTentRadius&&
                !canvasImageSource&&!canvasMaterialSource&&renderOptions.width*renderOptions.height<=4_194_304){
              const frame=displayFrame,physical={x:frame.view.x*frame.dpr,y:frame.view.y*frame.dpr,zoom:frame.view.zoom*frame.dpr}
              const crop={x:renderOptions.view.x-physical.x,y:renderOptions.view.y-physical.y,width:renderOptions.width,height:renderOptions.height}
              if(renderOptions.view.zoom===physical.zoom&&Number.isSafeInteger(crop.x)&&Number.isSafeInteger(crop.y)&&
                  crop.width===Math.ceil(frame.width*frame.dpr)&&crop.height===Math.ceil(frame.height*frame.dpr)){
                let captured:TileRender|undefined
                try{
                  const at=performance.now(),captureViewport={x:crop.x,y:crop.y,w:crop.width,h:crop.height}
                  const packet=await compilePacket(kernel,JSON.stringify({...renderOptions,captureViewport}),packetWait?.controller.signal)
                  const compileMs=performance.now()-at
                  if(!previewCurrent())throw Error('PREVIEW_CANCELLED')
                  captured=await renderTiledPreview(kernel,renderOptions,backend,color,settingsJson,
                    Math.max(crop.width,crop.height),crop,decodeScenePacket(packet),false,undefined,true,false,false,
                    reportRasterProgress,previewCurrent,hydrateImages,undefined,false,undefined,false,false,undefined,displayBackpressure)
                  if(!previewCurrent())throw Error('PREVIEW_CANCELLED')
                  if(!captured.gpuTile)throw Error('Exact commit capture unavailable')
                  self.postMessage({id:request.id,tile:{key:`commit-capture:${laneState.loadedRevision}:${captured.gpuTile}`,
                    x:-physical.x,y:-physical.y,width:crop.width,height:crop.height,zoom:physical.zoom,gutter:0,
                    committedViewport:true,viewportPreview:true,gpuTile:captured.gpuTile,backend,description:'native commit viewport',cached:false}})
                  self.postMessage({id:request.id,backend,milliseconds:performance.now()-start,compileMs,loadMs,retainedCommit:true,
                    graphMs:captured.graphMs,finishMs:captured.finishMs,checkpointMs:captured.checkpointMs,drawCalls:captured.drawCalls,peakTextureBytes:captured.peakTextureBytes})
                  captured=undefined
                  return
                }catch(error){
                  if(!previewCurrent()||String(error).includes('PREVIEW_CANCELLED'))throw error
                  if(!isDisplayBudgetError(error)&&!isAnalyticProgramBudget(error)&&!isScenePathBudget(error)&&
                      !/GPU surface budget exceeded|Exact commit capture unavailable|Invalid native capture/.test(String(error)))throw error
                }finally{captured?.bitmap?.close();if(captured?.gpuTile)gpu?.driver.releasePresented?.([captured.gpuTile])}
              }
            }
            // Native source tiles use preview intent through the last tile
            // at the requested density. Keep their display pixels in their own cache namespace.
            const sourcePreviewTile = renderIntent === 'preview' && !!request.sourceSnapshot && !!tileOwner
            const sourceDetailDisplay = sourcePreviewTile && channel==='canvas' && renderOptions.rasterProfile==='figmaSubpixel' &&
              !request.referenceGpu && !request.png && !request.readback && !exportFormat &&
              !renderOptions.exportRegion && !renderOptions.pixelPreview && !renderOptions.animation
            const namespace = JSON.stringify([
              laneState.documentGeneration, laneState.resourceGeneration, tileOwnerKey,
              renderOptions.pageId,
              renderOptions.rasterProfile,
              renderOptions.interactiveEffects,
              renderOptions.gpuGaussianRegions,renderOptions.gpuGaussianReduction,renderOptions.gpuSourceFilterFields,renderOptions.gpuDensePaint,sourceDetailDisplay,
              canvasDisplayFilters,
              boundedDisplayLimit,
              canvasMath,
              canvasImageSource, canvasMaterialSource, canvasTentRadius,
              renderOptions.grid,
              renderOptions.checkerboard,
              renderOptions.pixelPreview,
              renderOptions.animation,
              renderOptions.transparent,
              renderOptions.exportRegion,
              renderOptions.colorOutput,
              settingsJson,
              backend,
              wantsReference,
              wantsBatch,
            ])
            // One prepare guard shared by every tile of this request: the
            // kernel caches the flattened-geometry phase per camera, so the
            // whole-document walk happens once instead of once per tile.
            let prepareViewport = tilePrepareViewport(tileViewport, renderOptions.view, requestedPrepareViewport)
            const sharedSourcePrepare=renderOptions.gpuDensePaint===true&&laneState.loadedNodeCount<=32768&&
              !!requestedPrepareViewport&&requestedPrepareViewport.w*requestedPrepareViewport.h<=8_388_608
            const localPrepare=!sharedSourcePrepare&&localDisplayPrepareScope(laneState.loadedNodeCount,renderOptions.view.zoom,displayBackpressure)
            const prepareForTile=(tile:RasterTile)=>tileLocalPrepareViewport(tile,renderOptions.view,prepareViewport,localPrepare)
            let hits = 0, certifiedHits = 0,
              rendered = 0,
              milliseconds = 0, tileCompileMs = 0, tileGraphMs = 0, tileFinishMs = 0, tileCheckpointMs = 0,
              tileFieldMs = 0, tileFieldBytes = 0, tileFieldBuilds = 0,
              tilePeakTextureBytes = 0, tileFinishTransientBytes = 0, tileWorkingTextureBytes = 0, tileDrawCalls = 0, tileTriangles = 0,
              tileLeaves = 0, tileBitmapLeaves = 0, tileBudgetInjections = 0,
              tileDisplayTentRadiusPasses = 0, tileDisplayTentRadiusPixels = 0
            const cameraDependent = tileComputationDependsOnCamera(renderOptions, !!color)
            const requestPreference: BackendPreference | undefined = preference
            const batchStarted = performance.now(), resourceHitsBefore = kernel.frameResourceHits
            // Private identity covers only this synchronized lane/document/
            // resource/camera/prepare batch. Never taken from the request or
            // serialized native packet, and never shared with another job.
            const filterBatchLease = {}
            const order = new FilterTileOrder(tileViewport, tileFillPriorities, {
              x: -renderOptions.view.x / renderOptions.view.zoom, y: -renderOptions.view.y / renderOptions.view.zoom,
              width: renderOptions.width / renderOptions.view.zoom, height: renderOptions.height / renderOptions.view.zoom,
            })
            const allowFilterOrder = channel === 'canvas' && renderIntent === 'canvas' && !coverageTiles &&
              !request.png && !request.readback && !exportFormat && !renderOptions.exportRegion && !renderOptions.pixelPreview &&
              backend === 'webgpu' && !wantsReference && !executionPolicy.imageMips &&
              (!canvasDisplayFilters || boundedDisplayLimit !== undefined) && !canvasMath &&
              import.meta.env.VITE_DESIGN_FILTER_COLUMN_ORDER !== '0' &&
              import.meta.env.VITE_DESIGN_HORIZONTAL_FILTER_REUSE !== '0' &&
              import.meta.env.VITE_DESIGN_IMAGE_RESOLVE_FUSION !== '0'
            let filterColumnPlans = 0, filterColumnReorders = 0
            const ahead = new PrepareAhead<{ bytes: ScenePacket; ms: number; tile: RasterTile }>()
            let preparationWaitMs = 0, overlappedPreparations = 0
            const current = () => !packetWait?.controller.signal.aborted && generation === previewGenerations[channel] &&
              (channel !== 'canvas' || fillGeneration === tileFillGeneration)
            const tileFence = (enforceFill: boolean, allowGapFill = false, canFillGap = false) => choosePreparedTile({
              aborted: !!packetWait?.controller.signal.aborted,
              generationCurrent: generation === previewGenerations[channel],
              fillCurrent: fillGeneration === tileFillGeneration,
              enforceFill, channelIsCanvas: channel === 'canvas', allowGapFill, canFillGap,
            })
            const canStreamGaussian = regionalGaussianDisplay({backend,channel,profile:renderOptions.rasterProfile,colorSpace:color?.documentSpace,
              displayOnly:!request.readback&&!request.png&&!request.referenceGpu&&!exportFormat&&(renderIntent==='preview'||renderIntent==='canvas'),
              regional:renderOptions.gpuGaussianRegions,hdr:executionPolicy.hdrCompositing,pixelPreview:renderOptions.pixelPreview,
              animation:renderOptions.animation,exportRegion:renderOptions.exportRegion},
              {auto:import.meta.env.VITE_DESIGN_GAUSSIAN_AUTO,prefix:import.meta.env.VITE_DESIGN_GAUSSIAN_PREFIX,regions:import.meta.env.VITE_DESIGN_GAUSSIAN_REGIONS})
            const slot = (tile: RasterTile) => namespace + '/' + coordinateSlot([
              tile.x, tile.y, tile.width, tile.height, tile.zoom, tile.phaseX ?? 0, tile.phaseY ?? 0,
              ...(cameraDependent ? [renderOptions.view.x, renderOptions.view.y, tile.zoom] : [])])
            const compileTile = async (tile: RasterTile) => {
              if (!current()) throw Error('PREVIEW_CANCELLED')
              const at = performance.now()
              const compile = async () => {
                const options = {...renderOptions,view:{...renderOptions.view,zoom:tile.zoom},width:tile.width,height:tile.height,
                  [sourceBand&&Math.max(tile.width,tile.height)>TILE_SIDE+2?'captureViewport':'gpuViewport']:{x:tile.x+Math.floor(renderOptions.view.x),y:tile.y+Math.floor(renderOptions.view.y),w:tile.width,h:tile.height},
                  ...(prepareViewport ? {prepareViewport:prepareForTile(tile)} : {})}
                const signal=packetWait?.controller.signal
                const ordinary=()=>compilePacket(kernel,JSON.stringify(options),signal)
                const inBands=()=>compilePacket(kernel,JSON.stringify({...options,gpuGaussianRegions:true,gpuGaussianReduction:0}),signal)
                // One admission hint for this owner, revision, scale and visible
                // window. Every tile is still compiled and validated independently.
                const windowKey=canStreamGaussian && sourcePreviewTile && prepareViewport
                  ? JSON.stringify([namespace,tile.zoom,prepareViewport]) : ''
                if(windowKey && fullDensityGaussianWindow===windowKey){
                  try { return await inBands() }
                  catch(error){
                    if(!current() || !regionalGaussianAllocationFailure(error))throw error
                    fullDensityGaussianWindow=''
                    return ordinary()
                  }
                }
                try { return await ordinary() }
                catch (error) {
                  if(!current() || !canStreamGaussian || !regionalGaussianAllocationFailure(error))throw error
                  const packet=await inBands()
                  if(windowKey && current())fullDensityGaussianWindow=windowKey
                  return packet
                }
              }
              let bytes: ScenePacket
              try { bytes = await compile() }
              catch (error) {
                if (!prepareViewport || !isScenePathBudget(error)) throw error
                // A camera-wide preparation window is optional reuse, not
                // admission for a bounded tile. Retry this exact crop once.
                prepareViewport = undefined
                if (!current()) throw Error('PREVIEW_CANCELLED')
                bytes = await compile()
              }
              return { bytes, ms: performance.now() - at, tile }
            }
            try { for (let tileOrderIndex = 0; tileOrderIndex < tileViewport.length; tileOrderIndex++) {
              const tileIndex = order.indexAt(tileOrderIndex)
              const tile = tileViewport[tileIndex] as RasterTile
              let undelivered: { bitmap?: ImageBitmap; gpuTile?: number } | undefined
              let nextColumnPlan: { index: number | undefined; changed: boolean; deltaY: number } | undefined
              try {
              if (tileFence(true).action === 'cancel') throw new Error('PREVIEW_CANCELLED')
              // World slots retain the computation camera for measured byte
              // dithering, grids and pixel preview. Those established paths
              // cannot certify a translated hit from world address alone.
              // Preview and settled work alternate during zoom. Both contracts
              // keep their own bounded entries instead of clearing each other's
              // cache whenever the quality tier changes.
              const cacheKey = slot(tile)
              const cacheOwner = tileCache, cacheTicket = cacheOwner.capture(), tileOptions = {
                ...renderOptions, view: { ...renderOptions.view, zoom: tile.zoom },
              }, crop = { x: tile.x + Math.floor(renderOptions.view.x),
                y: tile.y + Math.floor(renderOptions.view.y), width: tile.width, height: tile.height }
              const compileStarted = performance.now()
              let speculativeSavedMs = 0
              let result: TileRender | undefined = disableExactCache || request.debug?.disableCertifiedTileReuse ? undefined : tileCache.certified(cacheKey)
              let witness:(()=>CompilationWitness)|undefined, preparedScene: GpuScene | undefined
              // Blank space is not a giant scene. A private complete-page
              // proof plus an actual resident texel can answer this tile with
              // a one-pixel GPU copy before compilation or resource hydration.
              if(!result&&current()&&import.meta.env.VITE_DESIGN_SPARSE_BACKGROUND!=='0'&&channel==='canvas'&&backend==='webgpu'&&
                  !request.readback&&!request.png&&!exportFormat&&!renderOptions.transparent&&!renderOptions.grid&&!renderOptions.checkerboard&&
                  !renderOptions.pixelPreview&&!canvasImageSource&&!canvasMaterialSource&&!disableExactCache&&!request.debug?.disableCertifiedTileReuse&&
                  !request.debug?.forceFirstTileBudgetFailure&&!executionPolicy.hdrCompositing){
                const id=gpu?.driver.backgroundTile?.(kernel.contentIdentity,pixelSourceContract(tileOptions),tileOptions.view,
                  {x:crop.x,y:crop.y,w:crop.width,h:crop.height})
                if(id){result=backgroundTileResult(id,color);undelivered=result;reportRasterProgress()}
              }
              let cameraFallback = false
              if (result) { await ahead.drain(); certifiedHits++ }
              else try {
                const waiting = performance.now()
                const prepared = await ahead.take(tileIndex) ?? await compileTile(tile)
                reportWorkProgress(1)
                if (prepared.tile !== tile) throw Error('Prepared tile owner mismatch')
                const waited = performance.now() - waiting
                preparationWaitMs += waited
                terminalDiagnostics.record('prepare-wait',{requestId:request.id,tileIndex,waitMs:waited,compileMs:prepared.ms,generation,fillGeneration})
                // Compilation work can overlap the previous tile's GPU work.
                // Keep both CPU work time and exposed wait time in telemetry.
                speculativeSavedMs = Math.max(0, prepared.ms - waited)
                const rawScene = prepared.bytes
                const preparedChoice = tileFence(true, !retainCoverage && !cameraDependent, preparedTileCanFill(tile, displayFrame))
                if (preparedChoice.action === 'cancel') throw Error('PREVIEW_CANCELLED')
                // Optional page backing yields to a new viewport. Only an
                // already prepared visible tile may supply useful pixels.
                cameraFallback = preparedChoice.action === 'cover-gap'
                witness = () => scenePacketWitness(rawScene)
                result = disableExactCache ? undefined : tileCache.get(cacheKey, witness)
                preparedScene = result ? undefined : decodeScenePacket(rawScene)
                if(preparedScene){preparedScene.sourceImageDisplay=sourceDetailDisplay;preparedScene.sourceDetailTile=sourceDetailDisplay && tile.zoom>=2}
              } catch (error) {
                // A whole tile may exceed the working-surface budget. Let the
                // regional renderer subdivide it; a compiler admission error
                // must not bypass the same recovery as a GPU allocation error.
                if (!/GPU surface budget exceeded|GPU 表面内存预算超限|Invalid GPU viewport/.test(String(error)) &&
                    !isAnalyticProgramBudget(error) && !isScenePathBudget(error)) throw error
              }
              const verifyMs = performance.now() - compileStarted + speculativeSavedMs, cached = !!result
              terminalDiagnostics.record('cache',{requestId:request.id,tileIndex,cached,reasonCode:cached?0:disableExactCache?3:request.debug?.disableCertifiedTileReuse?4:5,generation,fillGeneration})
              tileCompileMs += verifyMs
              milliseconds += verifyMs
              if (result) {
                hits++
                // Current-request verification cost replaces historical render timings.
                result = { ...result, milliseconds: verifyMs, compileMs: verifyMs,
                  renderMs: 0, graphMs: 0, finishMs: 0, checkpointMs: 0, drawCalls: 0, triangles: 0 }
              } else {
                const support = allowFilterOrder && current() && preparedScene && gpu?.driver.copyRegion &&
                  tileFillPriorities ? compiledFilterColumnSupport(preparedScene, tile) : undefined
                if (support) filterColumnPlans++
                // Freeze the next original index before speculation starts.
                // No packet is ever consumed using a mutable order position.
                nextColumnPlan = order.chooseNext(tileOrderIndex, support || undefined)
                if (nextColumnPlan.changed) filterColumnReorders++
                const nextIndex = order.indexAt(tileOrderIndex + 1)
                const next = nextIndex === undefined ? undefined : tileViewport[nextIndex] as RasterTile
                if (next && current() && !next.prefetch && kernel.canPrepareConcurrently &&
                    import.meta.env.VITE_DESIGN_PREPARE_PIPELINE !== '0' &&
                    (disableExactCache || request.debug?.disableCertifiedTileReuse || !tileCache.certified(slot(next)))) {
                  ahead.start(nextIndex, () => compileTile(next))
                  overlappedPreparations++
                }
                const preparedCameraFallback=cameraFallback
                // A pan may arrive AFTER the first draw, not just during
                // compilation. Finish this one native-density world tile if
                // it still fills a real current gap; never continue its batch.
                // Content/request cancellation remains the outer hard fence.
                const panContinuation=import.meta.env.VITE_DESIGN_PAN_TILE_CONTINUATION==='1'&&
                  channel==='canvas'&&!retainCoverage&&!cameraDependent&&!request.readback&&!request.png&&!exportFormat
                const tileCurrent = preparedTileContinuation(tile, current, ()=>preparedCameraFallback||
                  panContinuation&&!!displayFrame&&tile.zoom===displayFrame.view.zoom*displayFrame.dpr,
                  () => displayFrame, () => displayCoverageVersion,()=>{cameraFallback=true})
                result = await renderTiledPreview(kernel, tileOptions, backend, color,
                  settingsJson, tileSide, crop, preparedScene,
                  import.meta.env.DEV && request.debug?.forceFirstTileBudgetFailure === true,
                  prepareForTile(tile), !request.readback, canvasDisplayFilters, canvasMath, reportRasterProgress,
                  () => !packetWait?.controller.signal.aborted && generation === previewGenerations[channel] &&
                    tileCurrent(), hydrateImages, filterBatchLease, canvasImageSource, boundedDisplayLimit, canvasMaterialSource, canvasTentRadius,
                    draws=>reportWorkProgress(2,draws),displayBackpressure,sourceDetailDisplay && tile.zoom>=2,sourceDetailDisplay)
                if (result.gpuTile && preparedScene && renderIntent==='canvas' && channel==='canvas' && !request.sourceSnapshot &&
                    !request.png && !request.readback && !exportFormat && !canvasDisplayFilters && !canvasMath && !canvasTentRadius &&
                    !canvasImageSource && !canvasMaterialSource && !renderOptions.animation && !renderOptions.grid && !renderOptions.checkerboard && !renderOptions.pixelPreview)
                  gpu?.driver.tagExactTile?.(result.gpuTile,kernel.contentIdentity,pixelSourceContract(tileOptions),tile.gutter??1)
                undelivered = result
                if (tileFence(false).action === 'cancel') throw new Error('PREVIEW_CANCELLED')
                // Only the exact scene actually rendered once certifies these pixels.
                // Budget-subdivided assemblies have no accepted single-scene witness.
                if (!disableExactCache && witness && result.previewTiles === 1 && ownsExactTileBytes(result) && cacheOwner.current(cacheTicket))
                  cacheOwner.set(cacheKey, witness(), {...result,tileCost:undefined,worldBounds:[
                    (crop.x-renderOptions.view.x-2)/tile.zoom,(crop.y-renderOptions.view.y-2)/tile.zoom,
                    (tile.width+4)/tile.zoom,(tile.height+4)/tile.zoom,
                  ]}, exactTilePayloadBytes(result), cacheTicket)
                rendered++
                tileLeaves += result.previewTiles
                tileBitmapLeaves += result.bitmapLeaves
                tileBudgetInjections += result.injectedBudgetFailures
                milliseconds += result.milliseconds
                tileCompileMs += result.compileMs
                tileGraphMs += result.graphMs
                tileFinishMs += result.finishMs
                tileCheckpointMs += result.checkpointMs
                tileFieldMs += result.materialFieldBuildMs
                tileFieldBytes += result.materialFieldUploadBytes
                tileFieldBuilds += result.materialFieldBuilds
                tilePeakTextureBytes = Math.max(tilePeakTextureBytes, result.peakTextureBytes)
                tileFinishTransientBytes = Math.max(tileFinishTransientBytes, result.finishTransientBytes ?? 0)
                tileWorkingTextureBytes = Math.max(tileWorkingTextureBytes, result.workingTextureBytes)
                tileDisplayTentRadiusPasses += 'displayTentRadiusPasses' in result ? result.displayTentRadiusPasses : 0
                tileDisplayTentRadiusPixels += 'displayTentRadiusPixels' in result ? result.displayTentRadiusPixels : 0
                tileDrawCalls += result.drawCalls
                tileTriangles += result.triangles
              }
              if (tileFence(false).action === 'cancel') throw new Error('PREVIEW_CANCELLED')
              // Cached or fresh, the tile posts back: the surface rebuilds its
              // resident map from deliveries, so a cached hit must still arrive
              // (the historical resident-skip here was unreachable dead code —
              // no caller ever sent residentTiles, and a future caller that
              // evicted on damage would hang its plan on skipped keys).
              // Worker-side decode keeps the main thread to a drawImage; the
              // byte fallback only fires when ImageBitmap decoding is absent.
              const linearBuffer = result.linearBuffer?.slice(0)
              const transfer: Transferable[] = []
              // GPU-present tiles arrive as a transferred bitmap with no CPU
              // payload: nothing to decode and nothing to copy.
              let bitmap: ImageBitmap | undefined = result.bitmap,
                buffer: ArrayBuffer | undefined
              if (linearBuffer) transfer.push(linearBuffer)
              else if (!bitmap && typeof createImageBitmap === 'function' && result.buffer.byteLength) {
                try {
                  bitmap = await createImageBitmap(
                    new ImageData(
                      new Uint8ClampedArray(result.buffer as ArrayBuffer),
                      tile.width,
                      tile.height,
                    ),
                  )
                } catch {
                  bitmap = undefined
                }
                if (tileFence(false).action === 'cancel') {
                  bitmap?.close()
                  throw new Error('PREVIEW_CANCELLED')
                }
              }
              if (bitmap && displayCanvas && gpu?.driver.importPresented && !linearBuffer) {
                prepareDisplay()
                result.gpuTile = gpu.driver.importPresented(bitmap)
                bitmap = undefined
              }
              undelivered = { ...result, bitmap }
              if (bitmap) transfer.push(bitmap)
              else if (!linearBuffer && result.buffer.byteLength) {
                buffer = (result.buffer as ArrayBuffer).slice(0)
                transfer.push(buffer)
              }
              self.postMessage(
                {
                  id: request.id,
                  tile: {
                    ...tile,
                    tileSourceIndex: tileIndex, tileOrderIndex,
                    ...(nextColumnPlan ? { tileColumnNextIndex: nextColumnPlan.index ?? -1,
                      tileColumnReordered: Number(nextColumnPlan.changed), tileColumnDeltaY: nextColumnPlan.deltaY } : {}),
                    ...(terminalDiagnostics.enabled ? { tileCacheDecision: cached ? 0 : disableExactCache ? 3 : request.debug?.disableCertifiedTileReuse ? 4 : 5 } : undefined),
                    ...(terminalDiagnostics.enabled ? (cached ? { tileCostUnavailable: 63 } : ('tileCost' in result ? result.tileCost : undefined)) : undefined),
                    cameraFallback: cameraFallback || undefined,
                    gpuTile: result.gpuTile,
                    backend,
                    description: result.description,
                    reason: result.reason,
                    hybridEffects: result.hybridEffects,
                    materialFieldHits: result.materialFieldHits,
                    materialFieldBuilds: result.materialFieldBuilds,
                    materialFieldBuildMs: result.materialFieldBuildMs,
                    materialFieldUploadBytes: result.materialFieldUploadBytes,
                    displayTentRadiusPasses: 'displayTentRadiusPasses' in result ? result.displayTentRadiusPasses : 0,
                    displayTentRadiusPixels: 'displayTentRadiusPixels' in result ? result.displayTentRadiusPixels : 0,
                    ...('imageXTableBuilds' in result ? {wholeFilterAxes:result.wholeFilterAxes,opaqueTentPasses:result.opaqueTentPasses,imageXTableBuilds:result.imageXTableBuilds,imageXTablePixels:result.imageXTablePixels,imageXTableBytes:result.imageXTableBytes} : {}),
                    ...('staticImageBlurHits' in result ? {staticImageBlurEligible:result.staticImageBlurEligible,staticImageBlurHits:result.staticImageBlurHits,
                      staticImageBlurPixels:result.staticImageBlurPixels,staticImageBlurBytes:result.staticImageBlurBytes,staticImageBlurEntries:result.staticImageBlurEntries} : {}),
                    ...('horizontalFilterHits' in result ? {
                      horizontalFilterHits: result.horizontalFilterHits,
                      horizontalFilterPixels: result.horizontalFilterPixels,
                      horizontalFilterRows: result.horizontalFilterRows,
                    } : {}),
                    milliseconds: result.milliseconds + (cached ? 0 : verifyMs),
                    compileMs: result.compileMs + (cached ? 0 : verifyMs),
                    graphMs: result.graphMs,
                    finishMs: result.finishMs,
                    checkpointMs: result.checkpointMs,
                    passTimings: gpu?.driver.stats?.().passTimings,
                    peakTextureBytes: result.peakTextureBytes,
                    workingTextureBytes: result.workingTextureBytes,
                    cached,
                  },
                  ...(buffer ? { buffer } : {}),
                  tileBitmap: bitmap,
                  linearBuffer,
                },
                { transfer },
              )
              undelivered = undefined // Ownership transfers only after successful delivery.
              // One protocol request, but one interruptible GPU job per tile.
              // Allow input/control messages and higher-priority interaction
              // work through without interleaving command encoders.
              await yieldPreviewTask()
              await queue.yieldToHigherPriority(channel === 'interaction' ? 1 : 0, GPU_PRIORITY_BURST)
              // A canceled returning lane must not retire the interaction's
              // current resources merely to restore an obsolete canvas owner.
              if (tileFence(true).action === 'cancel') throw new Error('PREVIEW_CANCELLED')
              selectLane(channel)
              if (settingsJson !== colorKey || preference !== requestPreference || referenceGpu !== wantsReference || solidBatchGpu !== wantsBatch) {
                noteRetiredDevice(gpu); gpu?.dispose(); gpu = undefined; invalidateTileCache(); unavailable.clear()
                colorKey = settingsJson
                preference = requestPreference; referenceGpu = wantsReference; solidBatchGpu = wantsBatch
              }
              } finally {
                undelivered?.bitmap?.close()
                if (undelivered?.gpuTile) gpu?.driver.releasePresented?.([undelivered.gpuTile])
              }
            } } finally {
              try { await ahead.drain() }
              finally { gpu?.releaseFilterBatch(filterBatchLease) }
            }
            self.postMessage({
              id: request.id,
              backend,
              milliseconds,
              pipelineWallMs: performance.now() - batchStarted,
              preparationWaitMs, overlappedPreparations,
              filterColumnPlans, filterColumnReorders,
              frameResourceHits: kernel.frameResourceHits - resourceHitsBefore,
              frameResourceBytes: kernel.frameResourceBytes,
              renderMs: milliseconds,
              compileMs: tileCompileMs,
              graphMs: tileGraphMs,
              materialFieldBuildMs: tileFieldMs, materialFieldUploadBytes: tileFieldBytes, materialFieldBuilds: tileFieldBuilds,
              finishMs: tileFinishMs,
              checkpointMs: tileCheckpointMs,
              loadMs,
              previewTiles: rendered,
              previewLeaves: tileLeaves,
              bitmapLeaves: tileBitmapLeaves,
              injectedBudgetFailures: tileBudgetInjections,
              tileCacheHits: hits,
              certifiedTileHits: certifiedHits,
              tileCacheBytes: tileCaches.bytes,
              tileCacheEvictions: tileCaches.evictions,
              drawCalls: tileDrawCalls,
              displayTentRadiusPasses: tileDisplayTentRadiusPasses,
              displayTentRadiusPixels: tileDisplayTentRadiusPixels,
              triangles: tileTriangles,
              peakTextureBytes: tilePeakTextureBytes,
              finishTransientBytes: tileFinishTransientBytes,
              workingTextureBytes: tileWorkingTextureBytes,
              // Counting diagnostics must not reparse a multi-megabyte source
              // after every tile. This also stays correct after patches clear
              // the lane's full-sync string.
              stats: { nodes: laneState.loadedNodeCount },
            })
            return
          }
          if (
            livePreview && !canvasViewportCapture &&
            (tiledPreviewMode || (import.meta.env.DEV && request.debug?.forcePreviewTiles) ||
              usesNativePreviewTiles({ tiles: import.meta.env.VITE_DESIGN_NATIVE_PREVIEW_TILES,
                navigation: import.meta.env.VITE_DESIGN_NATIVE_NAVIGATION,
                exactClamp: import.meta.env.VITE_DESIGN_EXACT_CLAMP_PREFIX }, executionPolicy, {
                ...renderOptions, backend, renderIntent, livePreview, previewTileFallback, tileViewport,
                interaction: channel === 'interaction' || retainInteraction || !!_retainInteractionGraph || !!_interactionChannel,
                png: request.png, readback: request.readback, exportFormat,
              }))
          ) {
            await synchronizeDeferred()
            const result = await renderTiledPreview(
              kernel,
              renderOptions,
              backend,
              color,
              settingsJson,
              256, undefined, undefined, false, undefined, previewPresentOnly, previewDisplayFilters, canvasMath, undefined, previewCurrent, hydrateImages, undefined, canvasImageSource, boundedDisplayLimit, canvasMaterialSource, canvasTentRadius, undefined, displayBackpressure,
            )
            self.postMessage(
              { id: request.id, ...result, loadMs, previewLane: 'regional-fallback', previewReadback: !result.bitmap && !result.gpuTile, residentAttached: !!displayCanvas },
              { transfer: [result.buffer, ...(result.linearBuffer ? [result.linearBuffer] : []), ...(result.bitmap ? [result.bitmap] : [])] },
            )
            return
          }
          // CPU-only runs never even load the graphics drivers.
          const { createGpu, straightAlpha } = await import('./gpu/factory')
          if (!scene) {
            if (
              cacheScene &&
              laneState.compiledScene?.revision === laneState.loadedRevision &&
              laneState.compiledScene.options === options
            ) {
              scene = laneState.compiledScene.scene
              compileCacheHit = true
            } else {
              const t = performance.now()
              await synchronizeDeferred()
              scene = decodeScenePacket(await compilePacket(kernel, options, packetWait?.controller.signal))
              compileMs = performance.now() - t
              if (cacheScene) laneState.compiledScene = { revision: laneState.loadedRevision, options, scene: scene! }
            }
          }
          // A compile can outlive the camera request while the preparation
          // worker is busy. Do not initialize/encode its superseded graph.
          if ((livePreview || tileViewport) && !previewCurrent()) throw Error('PREVIEW_CANCELLED')
          if (retainInteraction && interactionSelection !== undefined) {
            if (!Array.isArray(interactionSelection) || interactionSelection.length > 16 ||
                interactionSelection.some(id => typeof id !== 'string')) throw Error('Invalid interaction selection')
            scene = { ...preparePreviewSelection(scene!, interactionSelection), interactionSelection: [...interactionSelection] }
            if (cacheScene) laneState.compiledScene = { revision: laneState.loadedRevision, options, scene }
          }
          // Color-managed inputs retain linear computation even for SDR output.
          // The HDR preference controls presentation, never the document model.
          scene!.floatCompositing = requiresFloatCompositing(executionPolicy, scene!)
          // HQ resolve/pixel-preview coordinates differ from the input window.
          // They keep the exact ordinary graph until that mapping is supported.
          const retainedScene = allowsInteractionWindow(retainInteraction,scene!)
          scene!.interactionRetained = retainedScene
          scene!.nativeInteraction = retainedScene && interactionNative === true
          scene!.gestureSoftEffects = import.meta.env.VITE_DESIGN_GESTURE_SOFT_EFFECTS !== '0' &&
            scene!.nativeInteraction && !(interactionLocalFootprint && interactionSelection?.length===1 &&
              isInnerShadowFill(laneState.interactionDocument?.nodes[interactionSelection[0]])) &&
            channel === 'interaction' && _interactionBranch === 3 &&
            livePreview === true && renderIntent === 'preview' && backend === 'webgpu' &&
            !executionPolicy.hdrCompositing && !request.readback && !request.png && !exportFormat &&
            !renderOptions.exportRegion && !renderOptions.pixelPreview && !scene!.softwareRaster &&
            !!scene!.interactionSelection?.some(id => scene!.nodes[id]?.effects.some(fx =>
              fx.visible && !fx.gradientBlur && ['inner-shadow', 'shadow', 'blur', 'gaussian-blur'].includes(fx.kind)))
          scene!.interactionLocalFootprint = retainedScene && interactionLocalFootprint === true
          scene!.interactionLease = retainedScene ? {} : undefined
          scene!.interactionWindow = retainedScene ? interactionWindow : undefined
          scene!.pairedDisplayFilters = request.debug?.pairedDisplayFilters
          scene!.compactImageFields = request.debug?.denseImageFields !== true
          scene!.disableSparseGlass = request.debug?.disableSparseGlass === true
          scene!.displayFilters = previewDisplayFilters
          scene!.displayFilterRadiusLimit = boundedDisplayLimit
          scene!.displayImageSource = canvasImageSource
          scene!.displayMaterialSource = canvasMaterialSource
          scene!.linearRetainedCapture=import.meta.env.VITE_DESIGN_LINEAR_RETAINED_CAPTURE==='1'&&channel==='interaction'&&
            _interactionBranch===1&&!!renderOptions.gpuRoots&&!request.png&&!request.readback&&!exportFormat&&!renderOptions.exportRegion&&!renderOptions.pixelPreview
          stampDisplayTentRadius(scene!, canvasTentRadius, backend)
          scene!.sequentialDisplay = canvasSequentialDisplay && backend === 'webgpu'
          if (canvasViewportCapture && backend !== 'webgpu') throw Error('SEQUENTIAL_DISPLAY_UNSUPPORTED')
          const floating = scene!.floatCompositing
          const displayMath = canvasMath && backend === 'webgpu' && floating && !scene!.softwareRaster
          const arithmeticKey = JSON.stringify([floating, displayMath])
          if (arithmeticKey !== floatingKey) {
            unavailable.clear()
            failures.clear()
            floatingKey = arithmeticKey
          }
          if (failures.has(backend)) continue
          if (
            gpu &&
            (gpu.driver.name !== backend || !!gpu.driver.managed !== floating || !!gpu.driver.displayMath !== displayMath)
          ) {
            noteRetiredDevice(gpu)
            invalidateTileCache()
            gpu.dispose()
            gpu = undefined
          }
          if (!gpu) {
            const observation = beginDeviceRecovery(undefined, 1, diagnosticRequestId, previousDeviceDiagnostic)
            try {
              gpu = await createGpu(
                backend,
                !referenceGpu,
                solidBatchGpu,
                color,
                managedImageLoader,
                executionPolicy.hdrCompositing && !!color,
                floating,
                !!executionPolicy?.imageMips,
                !!executionPolicy?.imageAtlas,
                displayMath,
                executionPolicy.gpuWorkingBudgetMiB,
              )
              observation.end(deviceLifecyclePhase.recoveryReady, gpu.driver)
            previousDeviceDiagnostic = {}
            } catch (error) {
              observation.end(deviceLifecyclePhase.recoveryFailed)
              unavailable.set(
                backend,
                `${backend}: ${error instanceof Error ? error.message : String(error)}`,
              )
              throw error
            }
          }
          if ((livePreview || tileViewport) && !previewCurrent()) throw Error('PREVIEW_CANCELLED')
          await hydrateImages(scene!)
          prepareDisplay(!request.png && !request.readback)
          const previewReadback = !!(request.png || request.readback || (!!color && !gpu.driver.hdr && !((retainInteraction || displayCanvas) && backend === 'webgpu')))
          // Bind the canonical source before allocating or submitting the gesture texture.
          const canvasOwner=retainInteraction && scene!.interactionLocalFootprint
            ? (await lanes.get('canvas').enginePromise)?.contentIdentity : undefined
          if (retainInteraction && !previewCurrent()) throw Error('PREVIEW_CANCELLED')
          const t = performance.now(),
            result = await failureAttempt(12, () => gpu!.render(scene!, previewReadback, true, (livePreview || tileViewport) ? previewCurrent : undefined,
              (livePreview||tileViewport)?draws=>reportWorkProgress(2,draws):undefined,displayBackpressure))
          const renderMs = performance.now() - t
          if ((livePreview || tileViewport) && !previewCurrent()) {
            result.bitmap?.close()
            if (result.gpuTile) gpu.driver.releasePresented?.([result.gpuTile])
            throw Error('PREVIEW_CANCELLED')
          }
          const rgba =
            result.straightRgba ??
            (result.linear
              ? color
                ? color_encode_rgba8(result.linear, settingsJson)
                : encode_float_rgba8(result.linear)
              : result.rgba
                ? straightAlpha(result.rgba, !!scene?.softwareRaster)
                : undefined)
          const bytes = request.png
            ? result.linear && color
              ? color_encode_png(
                  request.options.width,
                  request.options.height,
                  result.linear,
                  settingsJson,
                  JSON.stringify(request.options.colorOutput || { space: 'srgb', toneMap: 'clip' }),
                )
              : encode_png_rgba(request.options.width, request.options.height, rgba!)
            : rgba
          if (import.meta.env.DEV && import.meta.env.VITE_DESIGN_TRACE_PASSES === 'final')
            console.debug(
              'DESIGN_PASS',
              JSON.stringify({
                backend,
                encoded: true,
                float: result.linear ? Array.from(result.linear.slice(0, 8)) : undefined,
                rgba: rgba ? Array.from(rgba.slice(0, 8)) : undefined,
              }),
            )
          if (request.png) result.bitmap?.close()
          if(channel==='interaction'&&retainInteraction&&laneState.interactionDocument&&result.gpuTile&&interactionWindow&&
              !scene!.resolve&&!scene!.presentation&&import.meta.env.VITE_DESIGN_WORKER_POSES!=='0'){
            // Cached coverage is reused only for integer device-pixel moves.
            // Fractional poses request a fresh capture through the normal rebase
            // path; warming their former bilinear approximation is unnecessary.
            const origins=capturePoseOrigins(scene!,interactionSelection||[])
            if(origins){
              if(poseSession){poseSession.controller.abort();frozenOverlayPoses.freeze(gpu.driver,poseSession.slot,poseSession.scene)}
              const softEffectPreview = scene!.gestureSoftEffects
              scene!.gestureSoftEffects = result.gestureBlurPixels > 0
              poseSession={canvasOwner,controller:new AbortController(),slot:result.gpuTile,document:laneState.interactionDocument,baseDocument:laneState.interactionDocument,origins,
              baseFill:interactionBaseFill,softEffectPreview,scene:scene!,native:interactionNative===true,affine:interactionAffine===true,window:interactionWindow,fixedWindow:interactionWindowFixed===true,options,stopped:false,
              patch:interactionNative||import.meta.env.VITE_DESIGN_POSE_PATCHES!=='0'?TranslationPatchSession.create(scene!,laneState.interactionDocument,interactionSelection||[],interactionNative===true)||undefined:undefined}
            }
          }
          const bitmap = request.png ? undefined : result.bitmap
          const transfer: Transferable[] = []
          if (bytes) transfer.push(bytes.buffer)
          if (result.linear && color) transfer.push(result.linear.buffer)
          if (bitmap) transfer.push(bitmap)
          self.postMessage(
            {
              id: request.id,
              gpuTile: result.gpuTile,
              previewLane: livePreview ? 'whole-scene' : undefined,
              previewReadback: livePreview ? previewReadback : undefined,
              residentAttached: !!displayCanvas,
              residentInteraction:poseSession?.slot===result.gpuTile&&!!result.gpuTile,
              documentForks:kernel.documentForks,
              backgroundLinear:scene!.colors?.[scene!.background],
              bitmap,
              bitmapExtended: !!color && !!gpu.driver.hdr,
              buffer: bytes?.buffer,
              linearBuffer: color ? result.linear?.buffer : undefined,
              colorManagement: color,
              intermediateFormat: gpu.driver.managed ? 'rgba32float' : 'rgba8unorm',
              backend,
              drawCalls: result.drawCalls,
              commandSubmissions: result.commandSubmissions,
              triangles: result.triangles,
              description: result.description,
              compileMs,
              compileCacheHit,
              retainedGroupHits: result.retainedGroupHits,
              pairedFilterPasses: result.pairedFilterPasses,
              displayTentRadiusPasses: result.displayTentRadiusPasses,
              displayTentRadiusPixels: result.displayTentRadiusPixels,
              displayMath: gpu.driver.displayMath === true,
              imageAxisFields: result.imageAxisFields,
              imageFieldBytes: result.imageFieldBytes,
              retainedGroupBytes: result.retainedGroupBytes,
              loadMs,
              graphMs: result.graphMs,
              finishMs: result.finishMs,
              passPixels: result.passPixels,
              workingTextureBytes: result.workingTextureBytes,
              maskHits: result.maskHits,
              maskRasterizations: result.maskRasterizations,
              effectLayers: result.effectLayers,
              hybridEffects: result.hybridEffects,
              materialFieldHits: result.materialFieldHits,
              materialFieldBuilds: result.materialFieldBuilds,
              materialFieldBuildMs: result.materialFieldBuildMs,
              materialFieldUploadBytes: result.materialFieldUploadBytes,
              backdropReads: result.backdropReads,
              renderMs,
              milliseconds: performance.now() - start,
              reason: [...failures.values()].join('; '),
              stats: {
                effectLayers: result.effectLayers,
              hybridEffects: result.hybridEffects,
              materialFieldHits: result.materialFieldHits,
              materialFieldBuilds: result.materialFieldBuilds,
              materialFieldBuildMs: result.materialFieldBuildMs,
              materialFieldUploadBytes: result.materialFieldUploadBytes,
                backdropReads: result.backdropReads,
                nodes: Object.keys(scene!.nodes).length,
                culled: 0,
                pathSegments: result.triangles,
                shadedPixels: 0,
                peakLayerPixels: result.peakTextureBytes / (gpu.driver.managed ? 16 : 4),
                allocatedLayerPixels: result.textureBytes / (gpu.driver.managed ? 16 : 4),
              },
            },
            { transfer },
          )
          return
        } catch (error) {
          if (String(error).includes('PREVIEW_CANCELLED')) throw error
          if (canvasSequentialDisplay) {
            if (error instanceof Error && error.message === 'SEQUENTIAL_DISPLAY_UNSUPPORTED') throw error
            if (isRecoverablePreviewBudget(error, gpu?.driver.lost)) {
              if (gpu) await recoverPreviewBudget(error, gpu, invalidateTileCache)
              throw Error('SEQUENTIAL_DISPLAY_UNSUPPORTED', { cause: error })
            }
            throw error
          }
          if (import.meta.env.DEV && import.meta.env.VITE_DESIGN_TRACE_PASSES === 'tile')
            console.debug('DESIGN_RENDER_FAILURE ' + JSON.stringify({backend,error:String(error),tile:tileViewport}))
          // Display-cache pressure belongs to the surface owner. Destroying
          // this device would also destroy the last visible frame's textures.
          if (isDisplayBudgetError(error)) throw error
          // Optional navigation/interaction captures share the displayed
          // device. Allocation rejection must retire only their failed encoder
          // and scratch, rather than erasing the last complete viewport.
          const previewBudget = isRecoverablePreviewBudget(error, gpu?.driver.lost)
          let preservedPreview = false
          if (!tileViewport && (livePreview || renderOptions.captureViewport)) {
            const observation = beginDeviceRecovery(gpu?.driver, 3, diagnosticRequestId)
            try {
              preservedPreview = await failureAttempt(11, () => recoverPreviewBudget(error, gpu, invalidateTileCache))
              observation.end(preservedPreview ? deviceLifecyclePhase.recoveryReady : deviceLifecyclePhase.recoveryNotHandled, preservedPreview ? gpu?.driver : undefined)
            } catch (recoveryError) { noteRetiredDevice(gpu); gpu = undefined; observation.end(deviceLifecyclePhase.recoveryFailed); throw recoveryError }
          }
          if (preservedPreview && (renderOptions.captureViewport || _retainInteractionGraph ||
              !previewTileFallback || tiledPreviewMode)) {
            throw renderErrorWithBudget(error, `PREVIEW_BUDGET: ${String(error)}`)
          }
          if (tileViewport) {
            const sourceBand=channel==='canvas'&&!!request.sourceSnapshot&&!!tileOwner&&renderOptions.view.zoom>=8&&renderIntent==='preview'&&renderOptions.rasterProfile==='figmaSubpixel'&&backend==='webgpu'&&!executionPolicy.hdrCompositing&&!request.referenceGpu&&!renderOptions.exportRegion&&!renderOptions.pixelPreview&&!renderOptions.animation&&!request.png&&!request.readback&&!exportFormat
            const tileSide=(sourceBand?MATERIAL_BAND:TILE_SIDE)+2
            if (
              backend === 'webgpu' &&
              preference === 'auto' &&
              !String(error).includes('Invalid tile request')
            ) {
              noteRetiredDevice(gpu)
              invalidateTileCache()
              gpu?.dispose()
              gpu = undefined
              failures.set(backend, String(error))
              continue
            }
            if (preference === 'auto' && !String(error).includes('Invalid tile request'))
              throw renderErrorWithBudget(error, `PREVIEW_CPU_FALLBACK: ${String(error)}`)
            throw error
          }
          if (!preservedPreview) {
            noteRetiredDevice(gpu)
            invalidateTileCache()
            gpu?.dispose()
            gpu = undefined
          }
          const message = `${backend}: ${error instanceof Error ? error.message : String(error)}`
          if (livePreview && previewBudget) {
            if (!previewTileFallback || tiledPreviewMode)
              throw renderErrorWithBudget(error, `PREVIEW_BUDGET: ${message}`)
            tiledPreviewMode = true
            try {
              await synchronizeDeferred()
              const result = await renderTiledPreview(
                kernel,
                renderOptions,
                backend,
                color,
                settingsJson,
                256, undefined, undefined, false, undefined, previewPresentOnly, previewDisplayFilters, canvasMath, undefined, previewCurrent, hydrateImages, undefined, canvasImageSource, boundedDisplayLimit, canvasMaterialSource, canvasTentRadius, undefined, displayBackpressure,
              )
              self.postMessage(
                { id: request.id, ...result, loadMs, previewLane: 'regional-fallback', previewReadback: !result.bitmap && !result.gpuTile, residentAttached: !!displayCanvas },
                {
                  transfer: [result.buffer, ...(result.linearBuffer ? [result.linearBuffer] : []), ...(result.bitmap ? [result.bitmap] : [])],
                },
              )
              return
            } catch (tileError) {
              if (String(tileError).includes('PREVIEW_CANCELLED')) throw tileError
              throw renderErrorWithBudget(tileError, `PREVIEW_BUDGET: ${String(tileError)}`)
            }
          }
          if (displayCanvas || preference !== 'auto') throw renderErrorWithBudget(error, message)
          failures.set(backend, message)
        }
      }
      // CPU has no GPU candidate. A source overview must paint screen tiles,
      // not one viewport-sized composite, and an empty tile list is only the
      // snapshot admission that precedes those tiles.
      if (executionPolicy.cpuOnly && Array.isArray(tileViewport) && !request.png && !request.readback) {
        if (tileViewport.length > 256) throw new Error('Invalid tile request')
        if (tileViewport.length === 0 && request.sourceSnapshot !== undefined) {
          self.postMessage({
            id: request.id,
            backend: 'cpu',
            buffer: new ArrayBuffer(0),
            milliseconds: performance.now() - start,
            drawCalls: 0,
            triangles: 0,
            compileMs: 0,
            renderMs: 0,
            reason: 'cpu-source-admission',
          })
          return
        }
        if (tileViewport.length > 0) {
          await synchronizeDeferred()
          const tileStarted = performance.now()
          for (let index = 0; index < tileViewport.length; index++) {
            if (packetWait?.controller.signal.aborted || generation !== previewGenerations[channel]) throw new Error('PREVIEW_CANCELLED')
            const tile = tileViewport[index]
            if (!tile || typeof tile.key !== 'string' || tile.key.length > 256 ||
                ![tile.x, tile.y, tile.width, tile.height].every(Number.isSafeInteger) ||
                tile.width < 1 || tile.height < 1 || tile.width > 8192 || tile.height > 8192 ||
                !Number.isFinite(tile.zoom) || tile.zoom <= 0 || tile.zoom > MAX_CANVAS_RASTER_SCALE)
              throw new Error('Invalid tile request')
            const {bytes,width,height,divisor,reason} = await sampleCpuTile(cpuTileFrameOptions(renderOptions,tile),
              options=>kernel.render_cpu_frame(JSON.stringify(options)),
              ()=>!packetWait?.controller.signal.aborted && generation===previewGenerations[channel],
              !!request.sourceSnapshot && renderIntent==='preview' && !exportFormat && !renderOptions.exportRegion &&
                !renderOptions.pixelPreview && !executionPolicy.hdrCompositing)
            let bitmap: ImageBitmap | undefined
            if (divisor && typeof createImageBitmap === 'function') {
              try {
                bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray(bytes), width, height))
              } catch { bitmap = undefined }
            }
            if (packetWait?.controller.signal.aborted || generation !== previewGenerations[channel]) {
              bitmap?.close()
              throw new Error('PREVIEW_CANCELLED')
            }
            const transfer: Transferable[] = []
            let buffer: ArrayBuffer | undefined
            if (bitmap) transfer.push(bitmap)
            else {
              const copy = bytes.slice()
              buffer = copy.buffer
              transfer.push(buffer)
            }
            self.postMessage({
              id: request.id,
              tile: {
                ...tile,
                backend: 'cpu',
                description: divisor===1 ? 'cpu tile' : 'cpu navigation preview',
                cpuDivisor:divisor,
                reason,
                cached: false,
                milliseconds: 0,
                compileMs: 0,
                graphMs: 0,
                finishMs: 0,
                checkpointMs: 0,
              },
              ...(buffer ? { buffer } : {}),
              tileBitmap: bitmap,
            }, { transfer })
            await yieldPreviewTask()
          }
          self.postMessage({
            id: request.id,
            backend: 'cpu',
            buffer: new ArrayBuffer(0),
            milliseconds: performance.now() - start,
            renderMs: performance.now() - tileStarted,
            drawCalls: 0,
            triangles: 0,
            compileMs: 0,
            previewTiles: tileViewport.length,
            reason: 'cpu-tiles',
          })
          return
        }
      }
      rendererCode=1
      const t = performance.now()
      await synchronizeDeferred()
      // PNG uses the standalone CPU API, including tagged 16-bit color output.
      // Do not materialize and transfer an unused full linear framebuffer.
      const linear = color && !request.png && (request.readback || executionPolicy.hdrCompositing)
        ? await kernel.render_linear(options) : undefined
      let bytes = request.png
        ? request.options.exportRegion
          ? await kernel.render_region_png(
              JSON.stringify({
                pageId: request.options.pageId,
                ...request.options.exportRegion,
                rasterProfile: request.options.rasterProfile,
                colorOutput: request.options.colorOutput,
              }),
            )
          : color
            ? await kernel.render_color_png(
                options,
                JSON.stringify(request.options.colorOutput || { space: 'srgb', toneMap: 'clip' }),
              )
            : await kernel.render_png(options)
        : linear
          ? color_encode_rgba8(linear, settingsJson)
          : await kernel.render_cpu_frame(options, paintDamage)
      if (request.png && exportFormat) bytes = transcode_export_png(bytes, exportFormat, request.options.exportRegion?.scale ?? request.options.view.zoom)
      // Color encoding above is CPU sRGB SDR (clip). Explicit readback keeps
      // the original float buffer even when GPU presentation is disabled.
      const displayLinear =
        request.readback || (executionPolicy.hdrCompositing && allowsColorPresentation(executionPolicy, preference!))
          ? linear
          : undefined
      const transfer: Transferable[] = [bytes.buffer]
      if (displayLinear) transfer.push(displayLinear.buffer)
      self.postMessage(
        {
          id: request.id,
          buffer: bytes.buffer,
          linearBuffer: displayLinear?.buffer,
          colorManagement: color,
          intermediateFormat: color ? 'rgba32float' : 'rgba8unorm',
          stats: JSON.parse(await kernel.stats()),
          milliseconds: performance.now() - start,
          backend: 'cpu',
          drawCalls: 0,
          triangles: 0,
          compileMs,
          renderMs: performance.now() - t,
          reason: [...failures.values()].join('; '),
        },
        { transfer },
      )
    } catch (error) {
      diagnosticFailed=true
      const fields={...renderFailureFields(error),...failureAttempts?.fields(),backendCode:preparation?.diagnosticBackendCode ?? 0,
        rendererCode,channel:channel==='interaction'?1:0,documentRevision:request.documentRevision ?? laneState.loadedRevision ?? 0,generation,fillGeneration}
      terminalDiagnostics.record('error',{...fields,requestId:request.id,reasonCode:fields.failureCategory===1?5:1,superseded:generation!==previewGenerations[channel]})
      terminalDiagnostics.flush()
      self.postMessage({id:request.id,...renderFailureEnvelope(error),...fields})
    } finally {
      if (packetWait) packetWaits.delete(packetWait)
      terminalDiagnostics.record('queue-end',{requestId:request.id,durationMs:performance.now()-diagnosticStarted,resourceEpoch:gpu?.driver.resourceEpoch,completedResourceEpoch:gpu?.driver.completedResourceEpoch})
      if(terminalDiagnostics.enabled) for(const pass of gpu?.driver.stats?.().passTimings?.slice(0,16)||[]) terminalDiagnostics.record('filter',pass)
      const recovered=failureAttempts?.fields()
      if (!diagnosticFailed && recovered?.failureAttempts) {
        terminalDiagnostics.record('failure-summary',{...recovered,requestId:request.id,recovered:true,rendererCode,
          backendCode:preparation?.diagnosticBackendCode ?? 0,channel:channel==='interaction'?1:0,generation,fillGeneration})
        terminalDiagnostics.flush()
      }
      diagnosticFailureAttempts=previousFailureAttempts
      diagnosticRequestId=previousDiagnosticRequestId
    }
  }, channel === 'interaction' ? 1 : 0)
}

/** Render a bounded GPU region. Display-only WebGPU tiles transfer a bitmap;
 * readback and budget-split paths assemble the same requested region. */
async function renderTiledPreview(
  kernel: RenderKernel,
  options: KernelOptions,
  backend: 'webgpu' | 'webgl2',
  color: ColorSettings | undefined,
  settingsJson: string,
  tileSide = 256,
  crop?: { x: number; y: number; width: number; height: number },
  preparedScene?: GpuScene,
  forceFirstTileBudgetFailure = false,
  prepareViewport?: { x: number; y: number; w: number; h: number },
  presentOnly = false,
  canvasDisplayFilters = false,
  canvasMath = false,
  onRegionComplete?: () => void,
  isCurrent?: () => boolean,
  hydrateImages: HydrateSceneImages = sceneImageHydration(kernel, isCurrent ?? (() => true)),
  filterBatchLease?: object,
  canvasImageSource = false,
  boundedDisplayLimit?: number,
  canvasMaterialSource = false,
  canvasTentRadius = false,
  onEncodingProgress?: (drawCalls:number)=>void,
  displayBackpressure=false,
  sourceDetailTile=false,
  sourceImageDisplay=false,
) {
  const regionChannel=activeLane
  const tileCost = createTileCostDiagnostics(terminalDiagnostics.enabled)
  const checkCurrent = () => {
    if (isCurrent && !isCurrent()) throw new Error('PREVIEW_CANCELLED')
  }
  const checkpoint = isCurrent ? async () => {
    checkCurrent()
    // Let cancel-preview/cancel-tile-fill messages reach this worker between
    // completed subdivision attempts, without yielding renderer ownership.
    await yieldPreviewTask()
    checkCurrent()
  } : undefined
  checkCurrent()
  const { createGpu, straightAlpha } = await import('./gpu/factory')
  const { renderPreviewTiles, renderBitmapPreviewTiles } = await import('./preview-tiles')
  let hybridEffects = 0, materialFieldHits = 0, materialFieldBuilds = 0, materialFieldBuildMs = 0, materialFieldUploadBytes = 0
  let displayTentRadiusPasses = 0, displayTentRadiusPixels = 0
  let wholeFilterAxes = 0, opaqueTentPasses = 0, imageXTableBuilds = 0, imageXTablePixels = 0, imageXTableBytes = 0
  let staticImageBlurEligible = 0, staticImageBlurHits = 0, staticImageBlurPixels = 0, staticImageBlurBytes = 0, staticImageBlurEntries = 0
  let horizontalFilterHits = 0, horizontalFilterPixels = 0, horizontalFilterRows = 0
  const managedOutput = !!(executionPolicy?.hdrCompositing && color)
  const admissionKey=JSON.stringify(activeLane) + "/" + JSON.stringify([laneState.documentGeneration,laneState.resourceGeneration,options.pageId,options.view.zoom,
    options.rasterProfile,options.interactiveEffects,backend,managedOutput,canvasDisplayFilters,boundedDisplayLimit,canvasMaterialSource,canvasMath,canvasTentRadius,referenceGpu])
  let admission=regionAdmissions.get(admissionKey)
  if(!admission){
    admission=new PreviewAdmission();regionAdmissions.set(admissionKey,admission)
    if(regionAdmissions.size>16)regionAdmissions.delete(regionAdmissions.keys().next().value!)
  }
  const start = performance.now(),
    nodes = new Set<string>()
  let compileMs = 0,
    graphMs = 0,
    finishMs = 0,
    checkpointMs = 0,
    drawCalls = 0,
    triangles = 0,
    workingTextureBytes = 0,
    peakTextureBytes = 0,
    finishTransientBytes = 0,
    floatingFrame = false,
    description = backend as string,
    injectedBudgetFailures = 0
  // GPU-present fast path (no readback): a whole-tile SDR WebGPU render can
  // go straight from the driver's presentation canvas to a transferred
  // bitmap — copyTextureToBuffer/mapAsync never run for the display path.
  // HDR payloads, pixel-preview and dev fault-injection cases keep
  // the byte path below. SDR managed scenes encode display color on GPU. ExactTileCache certification requires bytes, so
  // presented tiles are not stored: the surface's resident map is the display
  // cache and bucket keys make re-render misses rare. Budget or capability
  // failures fall back to the byte path, whose recursive split handles them.
  let presented: ImageBitmap | undefined, residentTile: number | undefined
  let presentationFailure = ''
  if (
    presentOnly && preparedScene && backend === 'webgpu' && !managedOutput && crop &&
    !options.pixelPreview && tileSide >= Math.max(crop.width, crop.height) &&
    !(import.meta.env.DEV && forceFirstTileBudgetFailure) && !admission.shouldSplit(crop)
  ) {
    await checkpoint?.()
    const scene = preparedScene
    preparedScene = undefined
    scene.filterBatchLease = filterBatchLease
    scene.floatCompositing = requiresFloatCompositing(executionPolicy!, scene)
    const displayMath = canvasMath && backend === 'webgpu' && scene.floatCompositing && !scene.softwareRaster
    scene.displayFilters = canvasDisplayFilters || (options.interactiveEffects === true && !executionPolicy?.desktopFullMath)
    scene.displayFilterRadiusLimit = boundedDisplayLimit
    scene.displayImageSource = canvasImageSource
    scene.displayMaterialSource = canvasMaterialSource
    stampDisplayTentRadius(scene, canvasTentRadius, backend)
    {
      try {
        if (gpu && (gpu.driver.lost || gpu.driver.name !== backend || !!gpu.driver.managed !== scene.floatCompositing || !!gpu.driver.displayMath !== displayMath)) {
          noteRetiredDevice(gpu)
          invalidateTileCache()
          gpu.dispose()
          gpu = undefined
        }
        if (!gpu) {
          const observation = beginDeviceRecovery(undefined, 1, diagnosticRequestId, previousDeviceDiagnostic)
          try {
            gpu = await createGpu(
              backend,
              !referenceGpu,
              solidBatchGpu,
              color,
              managedImageLoader,
              managedOutput,
              scene.floatCompositing,
              !!executionPolicy?.imageMips,
              !!executionPolicy?.imageAtlas,
              displayMath,
              executionPolicy?.gpuWorkingBudgetMiB,
            )
            observation.end(deviceLifecyclePhase.recoveryReady, gpu.driver)
            previousDeviceDiagnostic = {}
          } catch (error) { observation.end(deviceLifecyclePhase.recoveryFailed); throw error }
        }
        if (gpu.driver.name !== 'webgpu') throw new Error('present fast path unavailable')
        checkCurrent()
        await hydrateImages(scene, isCurrent)
        prepareDisplay()
        const result = await failureAttempt(12, () => gpu!.render(scene, false, true, isCurrent,onEncodingProgress,displayBackpressure))
        tileCost?.observe(scene, result)
        presented = result.bitmap
        residentTile = result.gpuTile
        checkCurrent()
        onRegionComplete?.()
        if (!result.bitmap && !result.gpuTile) throw new Error('present fast path unavailable')
        Object.keys(scene.nodes).forEach((id) => nodes.add(id))
        description = result.description
        hybridEffects += result.hybridEffects
        materialFieldHits += result.materialFieldHits
        materialFieldBuilds += result.materialFieldBuilds
        materialFieldBuildMs += result.materialFieldBuildMs
        materialFieldUploadBytes += result.materialFieldUploadBytes
        horizontalFilterHits += result.horizontalFilterHits
        horizontalFilterPixels += result.horizontalFilterPixels
        horizontalFilterRows += result.horizontalFilterRows
        displayTentRadiusPasses += result.displayTentRadiusPasses ?? 0
        displayTentRadiusPixels += result.displayTentRadiusPixels ?? 0
        wholeFilterAxes += result.wholeFilterAxes
        opaqueTentPasses += result.opaqueTentPasses
        imageXTableBuilds += result.imageXTableBuilds
        imageXTablePixels += result.imageXTablePixels
        imageXTableBytes = Math.max(imageXTableBytes, result.imageXTableBytes)
        staticImageBlurEligible += result.staticImageBlurEligible
        staticImageBlurHits += result.staticImageBlurHits
        staticImageBlurPixels += result.staticImageBlurPixels
        staticImageBlurBytes = Math.max(staticImageBlurBytes, result.staticImageBlurBytes)
        staticImageBlurEntries = Math.max(staticImageBlurEntries, result.staticImageBlurEntries)
        drawCalls += result.drawCalls
        triangles += result.triangles
        graphMs += result.graphMs
        finishMs += result.finishMs
        checkpointMs += result.checkpointMs
        workingTextureBytes = Math.max(workingTextureBytes, result.workingTextureBytes)
        peakTextureBytes = Math.max(peakTextureBytes, result.peakTextureBytes)
        finishTransientBytes = Math.max(finishTransientBytes, result.finishTransientBytes ?? 0)
      } catch (error) {
        presented?.close()
        presented = undefined
        if (residentTile) gpu?.driver.releasePresented?.([residentTile])
        residentTile = undefined
        if (String(error).includes('PREVIEW_CANCELLED') || isDisplayBudgetError(error)) throw error
        presentationFailure = `GPU bitmap presentation fallback: ${String(error)}`
        admission.observe(error,crop)
        const deviceLost = gpu?.driver.lost || /device lost|GPU device|has been lost|设备已丢失/i.test(String(error))
        await recoverTileFailure(error)
        if (deviceLost) throw error
      }
    }
  }
  const bitmapAssembly = presentOnly && backend === 'webgpu' && !managedOutput && !options.pixelPreview && !options.transparent
  // A material band is admitted as a capture, but its recovery compiler
  // takes ordinary GPU tile viewports. Bound both axes before subdivision.
  const recoverySide = sourceImageDisplay ? Math.min(tileSide, TILE_SIDE + 2) : tileSide
  const width = crop?.width ?? options.width, height = crop?.height ?? options.height
  let skipFailedRegion = (recoverySide === tileSide || width <= recoverySide && height <= recoverySide) &&
    /GPU surface budget exceeded|GPU 表面内存预算超限|Invalid GPU viewport/.test(presentationFailure)
  const rasterize = async (tile: import('./preview-tiles').PreviewTile) => {
      let bitmap: ImageBitmap | undefined
      try {
        checkCurrent()
        if (skipFailedRegion) {
          skipFailedRegion = false
          // The identical whole region has already exceeded the budget above.
          // Split it without compiling and executing the failed work twice.
          if(tile.width===crop?.width&&tile.height===crop?.height)
            throw new Error('GPU 表面内存预算超限 (previous whole-region attempt)')
        }
        // Explicit development fault injection exercises real sub-tile compilation,
        // GPU rendering and assembly; no replacement pixels are ever supplied.
        if (forceFirstTileBudgetFailure) {
          forceFirstTileBudgetFailure = false
          injectedBudgetFailures++
          preparedScene = undefined
          throw new Error('GPU 表面内存预算超限 (explicit first-attempt test injection)')
        }
        const t = performance.now()
        const prepared = tile.x === 0 && tile.y === 0 &&
          tile.width === crop?.width && tile.height === crop?.height ? preparedScene : undefined
        preparedScene = undefined
        const compileRegion = async () => {
          const regionOptions = { ...options, width: tile.width, height: tile.height,
          view: options.view, gpuViewport: { x: (crop?.x || 0) + tile.x,
            y: (crop?.y || 0) + tile.y, w: tile.width, h: tile.height },
          ...(prepareViewport ? { prepareViewport } : {}) }
          try { return await compilePacket(kernel,JSON.stringify(regionOptions)) }
          catch(error){
            const allowed=regionalGaussianDisplay({backend,channel:regionChannel,profile:options.rasterProfile,colorSpace:color?.documentSpace,
              displayOnly:presentOnly&&!managedOutput,regional:options.gpuGaussianRegions,hdr:executionPolicy?.hdrCompositing,
              pixelPreview:options.pixelPreview,animation:options.animation,exportRegion:options.exportRegion},
              {auto:import.meta.env.VITE_DESIGN_GAUSSIAN_AUTO,prefix:import.meta.env.VITE_DESIGN_GAUSSIAN_PREFIX,regions:import.meta.env.VITE_DESIGN_GAUSSIAN_REGIONS})
            if(!allowed||!regionalGaussianAllocationFailure(error))throw error
            checkCurrent()
            return compilePacket(kernel,JSON.stringify({...regionOptions,gpuGaussianRegions:true,gpuGaussianReduction:0}))
          }
        }
        let scene = prepared
        if (!scene) {
          let packet: ScenePacket
          try { packet = await compileRegion() }
          catch (error) {
            if (!prepareViewport || !isScenePathBudget(error)) throw error
            prepareViewport = undefined
            checkCurrent()
            packet = await compileRegion()
          }
          scene = decodeScenePacket(packet) as GpuScene
        }
        scene.sourceDetailTile=sourceDetailTile
        scene.sourceImageDisplay=sourceImageDisplay
        scene.filterBatchLease = filterBatchLease
        checkCurrent()
        compileMs += performance.now() - t
        Object.keys(scene.nodes).forEach((id) => nodes.add(id))
        scene.floatCompositing = requiresFloatCompositing(executionPolicy!, scene)
        // Budget splitting changes transport, not the caller's canvas intent.
        // Keep the same filter contract on every child region.
        scene.displayFilters = canvasDisplayFilters
        scene.displayFilterRadiusLimit = boundedDisplayLimit
        scene.displayImageSource = canvasImageSource
        scene.displayMaterialSource = canvasMaterialSource
        stampDisplayTentRadius(scene, canvasTentRadius, backend)
        const floating = scene.floatCompositing
        const displayMath = canvasMath && backend === 'webgpu' && floating && !scene.softwareRaster
        floatingFrame ||= floating
        if (
          gpu &&
          (gpu.driver.lost ||
            gpu.driver.name !== backend ||
            !!gpu.driver.managed !== floating || !!gpu.driver.displayMath !== displayMath)
        ) {
          noteRetiredDevice(gpu)
          invalidateTileCache()
          gpu.dispose()
          gpu = undefined
        }
        if (!gpu) {
          const observation = beginDeviceRecovery(undefined, 1, diagnosticRequestId, previousDeviceDiagnostic)
          try {
            gpu = await createGpu(
              backend,
              !referenceGpu,
              solidBatchGpu,
              color,
              managedImageLoader,
              managedOutput,
              floating,
              !!executionPolicy?.imageMips,
              !!executionPolicy?.imageAtlas,
              displayMath,
              executionPolicy?.gpuWorkingBudgetMiB,
            )
            observation.end(deviceLifecyclePhase.recoveryReady, gpu.driver)
            previousDeviceDiagnostic = {}
          } catch (error) { observation.end(deviceLifecyclePhase.recoveryFailed); throw error }
        }
        // Assembly needs a bitmap per leaf, but the attached presenter and its
        // previous textures remain alive on this same device during the retry.
        checkCurrent()
        await hydrateImages(scene, isCurrent)
        prepareDisplay(false)
        const result = await failureAttempt(12, () => gpu!.render(scene, !bitmapAssembly, bitmapAssembly, isCurrent,onEncodingProgress))
        tileCost?.observe(scene, result)
        bitmap = result.bitmap
        checkCurrent()
        onRegionComplete?.()
        description = result.description
        hybridEffects += result.hybridEffects
        materialFieldHits += result.materialFieldHits
        materialFieldBuilds += result.materialFieldBuilds
        materialFieldBuildMs += result.materialFieldBuildMs
        materialFieldUploadBytes += result.materialFieldUploadBytes
        horizontalFilterHits += result.horizontalFilterHits
        horizontalFilterPixels += result.horizontalFilterPixels
        horizontalFilterRows += result.horizontalFilterRows
        displayTentRadiusPasses += result.displayTentRadiusPasses ?? 0
        displayTentRadiusPixels += result.displayTentRadiusPixels ?? 0
        wholeFilterAxes += result.wholeFilterAxes
        opaqueTentPasses += result.opaqueTentPasses
        imageXTableBuilds += result.imageXTableBuilds
        imageXTablePixels += result.imageXTablePixels
        imageXTableBytes = Math.max(imageXTableBytes, result.imageXTableBytes)
        staticImageBlurEligible += result.staticImageBlurEligible
        staticImageBlurHits += result.staticImageBlurHits
        staticImageBlurPixels += result.staticImageBlurPixels
        staticImageBlurBytes = Math.max(staticImageBlurBytes, result.staticImageBlurBytes)
        staticImageBlurEntries = Math.max(staticImageBlurEntries, result.staticImageBlurEntries)
        drawCalls += result.drawCalls
        triangles += result.triangles
        graphMs += result.graphMs
        finishMs += result.finishMs
        checkpointMs += result.checkpointMs
        workingTextureBytes = Math.max(workingTextureBytes, result.workingTextureBytes)
        peakTextureBytes = Math.max(peakTextureBytes, result.peakTextureBytes)
        finishTransientBytes = Math.max(finishTransientBytes, result.finishTransientBytes ?? 0)
        if (bitmapAssembly) {
          if (!bitmap) throw new Error('Missing display tile bitmap')
          const transferred = bitmap
          bitmap = undefined // The assembler owns and closes every leaf.
          return transferred
        }
        if (managedOutput) {
          if (!result.linear) throw new Error('Missing float preview tile readback')
          return result.linear
        }
        const rgba =
          result.straightRgba ??
          (result.linear
            ? color ? color_encode_rgba8(result.linear, settingsJson) : encode_float_rgba8(result.linear)
            : result.rgba
              ? straightAlpha(result.rgba, !!scene?.softwareRaster)
              : undefined)
        if (!rgba) throw new Error('Missing preview tile readback')
        return rgba
      } catch (error) {
        // Cancellation is not an allocation failure. A finished stale frame
        // can be discarded without destroying the displayed GPU resources.
        if (String(error).includes('PREVIEW_CANCELLED')) throw error
        if (import.meta.env.DEV && import.meta.env.VITE_DESIGN_TRACE_PASSES === 'tile')
          console.debug(
            'DESIGN_TILE_BUDGET',
            JSON.stringify({
              options,
              tile,
              error: error instanceof Error ? error.stack : String(error),
            }),
          )
        await recoverTileFailure(error)
        throw error
      } finally {
        bitmap?.close()
      }
    }
  let assembled: Awaited<ReturnType<typeof renderPreviewTiles>> | undefined
  let bitmapLeaves = 0
  if (!presented && !residentTile) {
    if (bitmapAssembly) {
      const result = await renderBitmapPreviewTiles(width, height, async tile => {
        const pixels = await rasterize(tile)
        if (ArrayBuffer.isView(pixels)) throw new Error('Expected GPU display tile')
        return pixels
      }, recoverySide, admission, checkpoint)
      presented = result.bitmap
      bitmapLeaves = result.tiles
    } else assembled = await renderPreviewTiles(width, height, async tile => {
      const pixels = await rasterize(tile)
      if (!ArrayBuffer.isView(pixels)) { pixels.close(); throw new Error('Expected exact tile readback') }
      return pixels
    }, recoverySide, admission, checkpoint)
  }
  if (presented || residentTile)
    return {
      tileCost: tileCost?.snapshot(),
      bitmap: presented,
      gpuTile: residentTile,
      buffer: new ArrayBuffer(0),
      backend,
      description,
      hybridEffects, materialFieldHits, materialFieldBuilds, materialFieldBuildMs, materialFieldUploadBytes,
      wholeFilterAxes, opaqueTentPasses, imageXTableBuilds, imageXTablePixels, imageXTableBytes,
      displayTentRadiusPasses, displayTentRadiusPixels,
      staticImageBlurEligible, staticImageBlurHits, staticImageBlurPixels, staticImageBlurBytes, staticImageBlurEntries,
      horizontalFilterHits, horizontalFilterPixels, horizontalFilterRows,
      compileMs,
      renderMs: performance.now() - start - compileMs,
      milliseconds: performance.now() - start,
      graphMs,
      finishMs,
      checkpointMs,
      // Zero byte-assembled subtiles: presented pixels cannot certify an
      // exact-cache witness (and need none — nothing was read back).
      previewTiles: 0,
      bitmapLeaves,
      injectedBudgetFailures,
      workingTextureBytes,
      peakTextureBytes,
      finishTransientBytes,
      drawCalls,
      triangles,
      reason: '',
      colorManagement: color,
      intermediateFormat: 'rgba8unorm',
      stats: {
        nodes: nodes.size,
        culled: 0,
        effectLayers: 0,
        backdropReads: 0,
        pathSegments: triangles,
        shadedPixels: 0,
        peakLayerPixels: 0,
        allocatedLayerPixels: 0,
      },
    }
  const linear = managedOutput ? (assembled!.pixels as Float32Array) : undefined
  const bytes = linear ? color_encode_rgba8(linear, settingsJson) : (assembled!.pixels as Uint8Array)
  return {
    tileCost: tileCost?.snapshot(),
    buffer: bytes.buffer,
    bitmapLeaves: 0,
    linearBuffer: linear?.buffer,
    backend,
    description,
    hybridEffects, materialFieldHits, materialFieldBuilds, materialFieldBuildMs, materialFieldUploadBytes,
    wholeFilterAxes, opaqueTentPasses, imageXTableBuilds, imageXTablePixels, imageXTableBytes,
    displayTentRadiusPasses, displayTentRadiusPixels,
    staticImageBlurEligible, staticImageBlurHits, staticImageBlurPixels, staticImageBlurBytes, staticImageBlurEntries,
    horizontalFilterHits, horizontalFilterPixels, horizontalFilterRows,
    compileMs,
    renderMs: performance.now() - start - compileMs,
    milliseconds: performance.now() - start,
    graphMs,
    finishMs,
    checkpointMs,
    previewTiles: assembled!.tiles,
    injectedBudgetFailures,
    workingTextureBytes,
    peakTextureBytes,
    finishTransientBytes,
    drawCalls,
    triangles,
    reason: presentationFailure,
    colorManagement: color,
    intermediateFormat: floatingFrame ? 'rgba32float' : 'rgba8unorm',
    stats: {
      nodes: nodes.size,
      culled: 0,
      effectLayers: 0,
      backdropReads: 0,
      pathSegments: triangles,
      shadedPixels: 0,
      peakLayerPixels: 0,
      allocatedLayerPixels: 0,
    },
  }
}
