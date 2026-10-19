import { renderFailureEnvelope, renderErrorWithBudget } from './render-diagnostics'
import { readAuthoredSnapshot, type AuthoredSnapshot } from './authored-snapshot'
import initialize, {
  transcode_export_png,
  VectorEngine,
  encode_png_rgba,
  encode_float_rgba8,
  color_encode_rgba8,
  color_encode_png,
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
  type RenderPolicy,
} from './render-policy'
import type { GpuRenderer } from './gpu/renderer'
import { decodeScenePacket } from './gpu/scene-packet'
import type { ColorSettings } from '../color'
import type { BackendPreference, GpuScene } from './gpu/types'
import type { KernelOptions } from './client'
import { TILE_SIDE, type RasterTile } from './tile-cache'
import { imageCacheKey, readCachedImage, writeCachedImage } from './image-mip-cache'
import { DecodedImageCache } from './decoded-image-cache'
import { managedSceneImageLoader, SceneImageHydration, type ImageContext } from './scene-image-hydration'
import { ExactTileCache, coordinateSlot } from './exact-tile-cache'
import { tileComputationDependsOnCamera } from './tile-computation-key'
import { recoverFailedTileRenderer } from './tile-failure'
import { recoverPreviewBudget, isRecoverablePreviewBudget } from './preview-budget-recovery'
import { PreviewAdmission } from './preview-tiles'
import { isDisplayBudgetError } from './gpu/display-budget'
import { applyDocumentPatch, documentPatch, type DocumentPatch } from '../document-patch'
import type { DesignDocument, Matrix } from '../model'
import { preparePreviewSelection, previewTranslationDelta, translatePreviewScene } from './gpu/translated-scene'
import { tilePrepareViewport } from './tile-prepare-viewport'
import { RenderWorkQueue } from './render-work-queue'
import { paintDamageIntersects, type PaintDamage } from './paint-damage'
import {residentFrameSignature} from './gpu/resident-frame'
import { canCommitResidentFrame } from './gpu/retained-commit'
import { PreparationChannel } from './preparation-channel'
import { RenderKernel } from './render-kernel'
import { loadKernelResources } from './kernel-resources'
import { preparedTileCanFill } from './prepared-tile-fallback'
import { reuseExactSceneSources } from './gpu/exact-scene-reuse'
import { PrepareAhead } from './prepare-ahead'
import { withResidentPose } from './gpu/resident-pose-frame'
import { TranslationPatchSession } from './gpu/translation-patch-session'
import { DisplayCommandOrder } from './display-command-order'
let executionPolicy: RenderPolicy | undefined
let enginePromise: Promise<RenderKernel> | undefined
let preparation: PreparationChannel | undefined
let loadedDocument = ''
let authoredSnapshot: AuthoredSnapshot | undefined
let loadedRevision = -1
let interactionDocument: DesignDocument | undefined
let synchronizedInteractionDocument: DesignDocument | undefined
// Only accepted pure translations may leave the CPU kernel behind the transient GPU graph.
let deferredInteractionDocument: DesignDocument | undefined
let colorKey = ''
let floatingKey: string | undefined
let referenceGpu = false
let solidBatchGpu = true
// Only one compiled scene is retained. It is keyed by the immutable document
// revision and all rendering options; GPU resource caches remain separate.
let compiledScene: { revision: number; options: string; scene: GpuScene } | undefined
let gpu: GpuRenderer | undefined
let displayCanvas: OffscreenCanvas | undefined
let displayFrame: import('./gpu/resident-presenter').ResidentFrame | undefined
let displayFramePending = false
const displayOrder = new DisplayCommandOrder()
const displayTasks = new MessageChannel()
displayTasks.port1.onmessage=()=>{
  displayFramePending=false
  try{if(displayFrame)gpu?.driver.presentFrame?.(displayFrame)}catch(error){reportDisplay({error:String(error)})}
}
const reportDisplay = (presentation: Record<string, unknown>) => self.postMessage({ presentation })
function prepareDisplay(capture = true) {
  if (!gpu) return
  if (displayCanvas) gpu.driver.attachPresenter?.(displayCanvas, reportDisplay)
  gpu.driver.captureDisplay = !!displayCanvas && capture
}
async function recoverTileFailure(error:unknown) {
  try {if(!await recoverFailedTileRenderer(error,gpu,invalidateTileCache,!!displayCanvas))gpu=undefined}
  catch(failure){gpu=undefined;throw failure}
}
let preference: BackendPreference | undefined
const unavailable = new Map<string, string>()
let tiledPreviewMode = false
const previewGenerations = {canvas:0,interaction:0}
let tileFillGeneration = 0
let tileNamespace = ''
const regionAdmissions = new Map<string, PreviewAdmission>()
type TileRender = Awaited<ReturnType<typeof renderTiledPreview>>
const tileCache = new ExactTileCache<TileRender & {worldBounds: [number,number,number,number]}>()
let cacheGeneration = 0
let documentGeneration = 0
let resourceGeneration = 0
let loadedDocumentId = ''
let loadedNodeCount = 0
function invalidateTileCache() {
  tileCache.clear()
  regionAdmissions.clear()
  if (tileNamespace) tileCache.reserve(tileNamespace.length * 2 + 512)
  cacheGeneration++
}

// CPU document state is isolated; raster/display resources remain on one
// worker/device. A transient selection never patches the settled page lane.
function saveLane() { return { enginePromise, loadedDocument, authoredSnapshot, loadedRevision, interactionDocument,
  synchronizedInteractionDocument, deferredInteractionDocument, compiledScene, loadedDocumentId, loadedNodeCount, documentGeneration, resourceGeneration } }
type Lane = ReturnType<typeof saveLane>
const emptyLane = (): Lane => ({enginePromise:undefined,loadedDocument:'',authoredSnapshot:undefined,loadedRevision:-1,interactionDocument:undefined,
  synchronizedInteractionDocument:undefined,deferredInteractionDocument:undefined,compiledScene:undefined,loadedDocumentId:'',loadedNodeCount:0,documentGeneration:0,resourceGeneration:0})
const lanes = new Map<string,Lane>()
let activeLane = 'canvas'
function selectLane(name:string) {
  if (name===activeLane) return
  lanes.set(activeLane,saveLane())
  const next=lanes.get(name)||emptyLane()
  ;({enginePromise,loadedDocument,authoredSnapshot,loadedRevision,interactionDocument,synchronizedInteractionDocument,deferredInteractionDocument,
    compiledScene,loadedDocumentId,loadedNodeCount,documentGeneration,resourceGeneration}=next)
  activeLane=name
  invalidateTileCache()
}


async function engine() {
  if (!enginePromise)
    enginePromise = (async () => {
      const boot = () => initialize({ module_or_path: '/kernel/design_kernel_bg.wasm' })
      // Warm only after a real request owns the render queue/GPU permit. Merely
      // constructing idle clients must not boot unlimited WASM/font workers.
      const font = preparation ? (await Promise.all([boot(), preparation.request(activeLane, 'warm_resources')]), undefined) : await loadKernelResources(boot)
      const engine = new RenderKernel(new VectorEngine(), activeLane, preparation)
      // The execution policy is pinned by the first envelope before any task
      // reaches this point and can never change afterwards.
      await engine.initialize(executionPolicy?.imageMips === true, font)
      return engine
    })()
  return enginePromise
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
/** Capture after ordered document synchronization. Same-id reopen, resources,
 * lanes and color settings each own separate optional decode residency. */
function sceneImageHydration(kernel: RenderKernel, current: () => boolean) {
  const lane = activeLane, generation = documentGeneration, resources = resourceGeneration, promise = enginePromise
  const context = { kernel, settings: kernel.color_settings(),
    scope: JSON.stringify([lane, generation, resources, loadedDocumentId, kernel.color_settings()]) }
  const ownerCurrent = () => activeLane === lane && documentGeneration === generation &&
    resourceGeneration === resources && enginePromise === promise && kernel.color_settings() === context.settings
  const hydration = new SceneImageHydration(diskImageCache, context, imagePersistence, ownerCurrent, current)
  return async (scene: GpuScene, isCurrent = current) => {
    await hydration.hydrate(scene, isCurrent)
    // RenderWorkQueue owns the entire gpu.render promise. Its only priority
    // yield is after completed tile delivery, so another lane cannot rebind
    // this decoder while a GPU render is awaiting driver work.
    renderingImages = { ...context, current: () => ownerCurrent() && isCurrent() }
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
type ResidentPose={slot:number;transforms:Record<string,Matrix>;input:{sequence:number;at:number}}
type PoseSession={slot:number;document:DesignDocument;baseDocument:DesignDocument;scene:GpuScene;
  patch?:TranslationPatchSession;native?:boolean;delta?:boolean;fixedWindow?:boolean;window:import('./gpu/types').Rect;options:string;stopped:boolean;input?:ResidentPose['input'] & {owner?:string};bounds?:{x:number;y:number;width:number;height:number}}
let poseSession:PoseSession|undefined,pendingPose:ResidentPose|undefined,poseQueued=false
function displayedOverlayOffsets(frame:import('./gpu/resident-presenter').ResidentFrame) {
  const session=poseSession
  if(!frame.overlay?.transforms||!session||!frame.interaction||!frame.items.some(i=>i.active&&i.tile.gpuTile===session.slot))return undefined
  const offsets:Record<string,{x:number;y:number}>={}
  for(const [id,transform] of Object.entries(frame.overlay.transforms)){
    const delta=previewTranslationDelta(session.scene,id,transform)
    if(delta)offsets[id]={x:-delta[0]/session.scene.view.zoom,y:-delta[1]/session.scene.view.zoom}
  }
  return offsets
}
function rebasePose(pose:ResidentPose){
  if(poseSession?.slot===pose.slot)poseSession.stopped=true
  if(pendingPose?.slot===pose.slot)pendingPose=undefined
  reportDisplay({residentSample:{slot:pose.slot,...pose.input,needsRebase:true}})
}
function schedulePose(){
  if(poseQueued||!pendingPose)return
  poseQueued=true
  void queue.run(async()=>{
    try{
      while(pendingPose){
        const pose=pendingPose;pendingPose=undefined
        const session=poseSession
        if(!session||session.slot!==pose.slot||!gpu?.driver.replacePresented)continue
        const started=performance.now()
        selectLane('interaction')
        const ids=Object.keys(pose.transforms)
        if(!ids.length||ids.length>16||ids.some(id=>!session.scene.nodes[id]||!session.document.nodes[id]||!Array.isArray(pose.transforms[id])||
          pose.transforms[id].length!==6||!Array.from(pose.transforms[id]).every(Number.isFinite))){rebasePose(pose);break}
        const documentStarted=performance.now()
        const document=session.patch?undefined:{...session.document,nodes:{...session.document.nodes,...Object.fromEntries(ids.map(id=>
          [id,{...session.document.nodes[id],transform:pose.transforms[id]}]))}}
        const documentMs=performance.now()-documentStarted
        const scale=session.scene.view.zoom,base=session.window
        const deltas = ids.map(id => previewTranslationDelta(session.scene, id, pose.transforms[id]))
        if (deltas.some(delta => !delta)) { rebasePose(pose); break }
        const shifts=session.fixedWindow?[{x:0,y:0}]:ids.map((id,index)=>{const node=session.scene.nodes[id],source=node.previewSource||node,delta=deltas[index]!
          return {x:node.matrix[4]+delta[0]-source.matrix[4],y:node.matrix[5]+delta[1]-source.matrix[5]}})
        let x=base.x+Math.min(0,...shifts.map(p=>p.x)),y=base.y+Math.min(0,...shifts.map(p=>p.y))
        let right=base.x+base.w+Math.max(0,...shifts.map(p=>p.x)),bottom=base.y+base.h+Math.max(0,...shifts.map(p=>p.y))
        if(displayFrame){
          const view=displayFrame.view,camera=session.scene.view
          const left=-view.x/view.zoom*scale+camera.x,top=-view.y/view.zoom*scale+camera.y
          x=Math.max(x,left);y=Math.max(y,top)
          right=Math.min(right,left+displayFrame.width/view.zoom*scale);bottom=Math.min(bottom,top+displayFrame.height/view.zoom*scale)
        }
        if(right<=x||bottom<=y){rebasePose(pose);break}
        const window={x,y,w:right-x,h:bottom-y}
        const translationStarted=performance.now()
        let poseCompileMs=0, sceneUpdateBytes=0
        let compileStats:Record<string,unknown>|undefined
        let next: GpuScene | null
        if(session.native){
          const capture=session.scene.output||{x:0,y:0,w:session.scene.width,h:session.scene.height}
          if(x<capture.x||y<capture.y||right>capture.x+capture.w||bottom>capture.y+capture.h){rebasePose(pose);break}
          const kernel=await engine()
          if(!await kernel.apply_interaction_transforms(JSON.stringify(pose.transforms))){rebasePose(pose);break}
          const compileStarted=performance.now()
          let compiled:GpuScene
          if(session.delta){compiled=await kernel.compile_gpu_scene_update(session.options,false);sceneUpdateBytes=kernel.sceneUpdateBytes}
          else{const packet=await kernel.compile_gpu_packet(session.options);sceneUpdateBytes=packet.byteLength;compiled=decodeScenePacket(packet)}
          poseCompileMs=performance.now()-compileStarted
          compileStats=kernel.compileStats
          next={...preparePreviewSelection(compiled,session.scene.interactionSelection||[]),
            interactionSelection:session.scene.interactionSelection,interactionRetained:true,nativeInteraction:true,interactionLease:session.scene.interactionLease,interactionWindow:window,
            floatCompositing:session.scene.floatCompositing,pairedDisplayFilters:session.scene.pairedDisplayFilters,
            compactImageFields:session.scene.compactImageFields,displayFilters:session.scene.displayFilters}
          next=reuseExactSceneSources(session.scene,next,session.patch?.changedNodes)
        }else next=session.patch?session.patch.prepare(session.scene,pose.transforms,window):
          translatePreviewScene({...session.scene,interactionWindow:window},session.document,document!)
        const translationMs=performance.now()-translationStarted,posePrepareMs=performance.now()-started
        if(!next){rebasePose(pose);break}
        try{
          const hydrateImages = sceneImageHydration(await engine(), () => poseSession === session && !session.stopped)
          await hydrateImages(next)
          prepareDisplay()
          const result=await gpu.render(next,false,true)
          if(!result.gpuTile)throw Error('Resident movement did not produce a GPU texture')
          if(poseSession!==session){gpu.driver.releasePresented?.([result.gpuTile]);continue}
          gpu.driver.replacePresented(session.slot,result.gpuTile)
          session.scene=next
          if(session.patch)session.patch.accept(next,pose.transforms)
          else {session.document=document!;interactionDocument=document;deferredInteractionDocument=document}
          session.input=pose.input
          compiledScene={revision:loadedRevision,options:session.options,scene:next}
          const bounds={x:(window.x-next.view.x)/scale,y:(window.y-next.view.y)/scale,width:window.w/scale,height:window.h/scale}
          session.bounds=bounds
          if(displayFrame&&displayFrame.items.some(item=>item.active&&item.tile.gpuTile===session.slot)){
            const view=displayFrame.view
            displayFrame={...displayFrame,interaction:true,input:pose.input,items:displayFrame.items.map(item=>item.tile.gpuTile===session.slot
              ?{...item,clip:{left:bounds.x*view.zoom+view.x,top:bounds.y*view.zoom+view.y,width:bounds.width*view.zoom,height:bounds.height*view.zoom}}:item)}
            displayFrame.overlayPose=displayedOverlayOffsets(displayFrame)
            gpu.driver.presentFrame?.(displayFrame)
          }
          reportDisplay({residentSample:{slot:session.slot,...pose.input,bounds,total:performance.now()-started,
            nativePose:session.native===true,compileMs:poseCompileMs,
            compileStats,fieldUploadBytes:result.materialFieldUploadBytes,
            sceneUpdateBytes:session.native?sceneUpdateBytes:undefined,
            geometryUploadBytes:gpu.driver.stats?.().geometryUploadBytes,
            residentProgramHits:gpu.driver.stats?.().residentProgramHits,residentProgramHitBytes:gpu.driver.stats?.().residentProgramHitBytes,
            graphMs:result.graphMs,finishMs:result.finishMs,groupHits:result.retainedGroupHits,
            posePrepareMs,documentMs,translationMs,patchSession:!!session.patch,affectedNodes:session.patch?.affectedNodes,
            passTimings:gpu.driver.stats?.().passTimings,
            groupBytes:result.retainedGroupBytes,prefixHits:result.retainedPrefixHits,fieldHits:result.materialFieldHits,checkpointMs:result.checkpointMs,fieldMs:result.materialFieldBuildMs,
            drawCalls:result.drawCalls,passPixels:result.passPixels,textureBytes:result.textureBytes,
            signature:displayFrame?residentFrameSignature(displayFrame):undefined}})
        }catch(error){console.warn('[resident-interaction] rebuilding capture',String(error));rebasePose(pose);break}
      }
    }finally{poseQueued=false;if(pendingPose)schedulePose()}
  },1)
}
self.onmessage = (e) => {
  const request = e.data
  if (request.command === 'prepare-port') {
    if (!preparation && !enginePromise && request.port instanceof MessagePort) preparation = new PreparationChannel(request.port)
    return
  }
  const channel = request.channel === 'interaction' ? 'interaction' : 'canvas'
  if (request.command === 'display-attach') {
    try {
      executionPolicy=pinRenderPolicy(executionPolicy,request.executionPolicy)
      if(!allowsResidentSdr(executionPolicy))throw Error('Resident SDR display is not allowed by this host policy')
      displayCanvas=request.canvas;prepareDisplay()
    }catch(error){reportDisplay({error:String(error)})}
    return
  }
  if (request.command === 'display-frame') {
    if(!displayOrder.accept(request.sequence)){
      reportDisplay({displayCommandsDropped:displayOrder.dropped});return
    }
    displayFrame=request.frame
    if(displayFrame&&poseSession?.input&&poseSession.bounds)
      displayFrame=withResidentPose(displayFrame,{slot:poseSession.slot,input:poseSession.input,bounds:poseSession.bounds})
    if(displayFrame)displayFrame.overlayPose=displayedOverlayOffsets(displayFrame)
    if (!displayFramePending) {
      displayFramePending=true
      // Input is already coalesced on the window's animation clock. A second
      // worker rAF can be throttled independently; use a task boundary here.
      displayTasks.port2.postMessage(0)
    }
    return
  }
  if(request.command==='display-read-pixel'||request.command==='display-capture-content'){
    void (async()=>{
      try{
        const result=request.command==='display-read-pixel'?await gpu?.driver.readContentPixel?.(request.u,request.v,request.expected):await gpu?.driver.captureContentBitmap?.()
        if(!result)throw Error('No displayed document content')
        self.postMessage({id:request.id,...result},{transfer:'bitmap' in result?[result.bitmap]:[]})
      }catch(error){self.postMessage({id:request.id,error:String(error)})}
    })()
    return
  }
  if(request.command==='interaction-pose'){
    if(!request.input||!Number.isSafeInteger(request.input.sequence)||!Number.isFinite(request.input.at)||
        !request.transforms||typeof request.transforms!=='object')return
    if(poseSession&&poseSession.slot===request.slot&&!poseSession.stopped){pendingPose=request;schedulePose()}
    else rebasePose(request)
    return
  }
  if(request.command==='interaction-pose-stop'){
    if(poseSession&&poseSession.slot===request.slot)poseSession.stopped=true
    return
  }
  if (request.command === 'display-release') {
    if(poseSession&&request.ids.includes(poseSession.slot)){poseSession=undefined;pendingPose=undefined}
    gpu?.driver.releasePresented?.(request.ids); return
  }
  if (request.command === 'cancel-preview') {
    try {
      executionPolicy = pinRenderPolicy(executionPolicy, request.executionPolicy)
      previewGenerations[channel]++
    } catch {
      /* malformed control envelope has no effect */
    }
    return
  }
  if (request.command === 'cancel-tile-fill') {
    tileFillGeneration++
    return
  }
  const generation = previewGenerations[channel]
  const fillGeneration = tileFillGeneration
  let completedRegions=0
  const reportRasterProgress=()=>self.postMessage({id:request.id,rasterProgress:++completedRegions})
  void queue.run(async () => {
    try {
      executionPolicy = pinRenderPolicy(executionPolicy, request.executionPolicy)
      const backend = effectiveBackend(executionPolicy, request.backend, request.png)
      if (executionPolicy.cpuOnly && request.command === 'lose-device')
        throw new Error('CPU-only execution forbids device tests')
      if (import.meta.env.DEV && request.command === 'lose-device') {
        if (!gpu) throw new Error('No active GPU to test')
        invalidateTileCache()
        await gpu.driver.loseDeviceForTesting()
        self.postMessage({ id: request.id })
        return
      }
      if (request.command === 'park-gpu') {
        // The serialized queue is idle at this boundary. Retain the document,
        // fonts, decoded assets and CPU cache, but relinquish the device lease.
        gpu?.dispose(); gpu = undefined
        self.postMessage({ id: request.id })
        return
      }
      if (request.command === 'gpu-memory') {
        // Debug snapshot: the kernel ledger plus live driver accounting. A
        // worker whose engine never finished loading reports a null breakdown
        // rather than triggering the wasm/font load for a poll.
        const kernel = enginePromise ? await engine() : undefined
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
        prepareDisplay(false)
        if(!gpu?.driver.importPresented) { request.bitmap?.close();throw Error('No WebGPU device for display handoff') }
        const gpuTile=gpu.driver.importPresented(request.bitmap)
        self.postMessage({id:request.id,gpuTile})
        return
      }
      selectLane(request.channel === 'interaction' ? 'interaction' : 'canvas')
      if(channel==='interaction'){
        if(poseSession?.patch && request.document===undefined){
          interactionDocument=poseSession.document=poseSession.patch.snapshot()
          deferredInteractionDocument=interactionDocument
        }
        poseSession=undefined;pendingPose=undefined
      }
      const kernel = await engine(),
        start = performance.now()
      const retainInteraction = request.options?.retainInteractionGraph === true && request.options?.renderIntent === 'preview' && request.options?.livePreview === true &&
        !request.options?.tileViewport && allowsResidentSdr(executionPolicy) && !request.png &&
        !request.options?.exportFormat && !request.options?.exportRegion && !request.options?.pixelPreview
      const { interactionChannel: _interactionChannel, livePreview, retainInteractionGraph: _retainInteractionGraph, interactionNative, interactionSelection, interactionWindow, interactionWindowFixed, previewTileFallback, tileViewport,
        tilePrepareViewport: requestedPrepareViewport, coverageTiles, tileOwner, exportFormat, renderIntent, ...renderOptions } = request.options
      const previewCurrent = () => generation === previewGenerations[channel] &&
        (!tileViewport || channel !== 'canvas' || fillGeneration === tileFillGeneration)
      const retainCoverage = channel === 'canvas' && coverageTiles === true && !!tileViewport && renderIntent === 'preview'
      if(renderOptions.captureViewport&&(request.png||request.readback||tileViewport||renderOptions.pixelPreview||exportFormat||renderOptions.exportRegion))
        throw Error('Native viewport capture is only available for canvas presentation')
      // Readback is transport, not quality. Only an explicitly transient
      // preview may simplify effects; settled frames and exports never do.
      renderOptions.interactiveEffects = renderIntent === 'preview' &&
        !executionPolicy.desktopFullMath && !request.png && !exportFormat && !renderOptions.exportRegion
      const canvasDisplayFilters = usesCanvasDisplayFilters(executionPolicy, {
        renderIntent, png: request.png, readback: request.readback, exportFormat,
        exportRegion: renderOptions.exportRegion, pixelPreview: renderOptions.pixelPreview,
      })
      const canvasMath = import.meta.env.VITE_DESIGN_DISPLAY_MATH !== '0' && request.debug?.displayMath !== false &&
        usesDisplayArithmetic(executionPolicy, { renderIntent, rasterProfile: renderOptions.rasterProfile,
          png: request.png, readback: request.readback, exportFormat, exportRegion: renderOptions.exportRegion,
          pixelPreview: renderOptions.pixelPreview })
      // Canvas chrome is never authored/exported content.
      if (request.png || exportFormat || renderOptions.exportRegion) renderOptions.checkerboard = false
      const disableExactCache = request.debug?.disableExactTileCache === true
      const options = JSON.stringify({...renderOptions,...(renderOptions.captureViewport&&requestedPrepareViewport?{prepareViewport:requestedPrepareViewport}:{})})
      const synchronizeDeferred = async () => {
        if (!deferredInteractionDocument) return
        if(synchronizedInteractionDocument?.id===deferredInteractionDocument.id)
          await kernel.apply_document_patch_with_damage(JSON.stringify(documentPatch(synchronizedInteractionDocument,deferredInteractionDocument)))
        else await kernel.load_document(JSON.stringify(deferredInteractionDocument))
        synchronizedInteractionDocument=deferredInteractionDocument
        deferredInteractionDocument = undefined
      }
      if (!retainInteraction) await synchronizeDeferred()
      let translated: { options: string; scene: GpuScene } | undefined
      // Keep the immutable authored snapshot in both lanes. It also proves
      // whether the last displayed pose is exactly the patch being committed.
      let paintDamage: PaintDamage | undefined
      if (request.document !== undefined) {
        // A full resynchronization is a new owner even if its authored id repeats.
        deferredInteractionDocument = undefined
        documentGeneration++
        invalidateTileCache()
        authoredSnapshot = undefined
        interactionDocument = readAuthoredSnapshot(request.document,
          channel === 'interaction' ? lanes.get('canvas')?.authoredSnapshot : undefined)
        loadedDocumentId = interactionDocument.id
        loadedNodeCount = Object.keys(interactionDocument.nodes).length
        synchronizedInteractionDocument=interactionDocument

        if (request.document !== loadedDocument || request.documentRevision !== loadedRevision) {
          await kernel.load_document(request.document)
          loadedDocument = request.document
          compiledScene = undefined
          paintDamage = undefined
        }
        loadedRevision = request.documentRevision
        // Publish only after successful kernel synchronization. A failed load
        // or any later patch must never leave a reusable source certificate.
        authoredSnapshot = {json:request.document,document:interactionDocument}
      } else if (request.documentPatch !== undefined) {
        authoredSnapshot = undefined
        if (request.baseDocumentRevision !== loadedRevision)
          throw new Error('文档补丁版本未同步，请重试当前画布')
        const patch = JSON.parse(request.documentPatch) as DocumentPatch
        if (interactionDocument) {
          const next = applyDocumentPatch(interactionDocument, patch)
          if (retainInteraction && !interactionNative && compiledScene?.revision === loadedRevision) {
            const moved = translatePreviewScene(compiledScene.scene, interactionDocument, next)
            if (moved) translated = { options: compiledScene.options, scene: moved }
          }
          interactionDocument = next
          loadedNodeCount = Object.keys(next.nodes).length
        }
        // Translation already passed geometry/clipping/resource validation and
        // uses the identical compile options. Avoid re-running Rust document
        // layout/damage on every pointer event. Any other request synchronizes
        // the latest authored snapshot before touching the CPU kernel again.
        const defer = translated?.options === options && request.debug?.disableSceneCache !== true
        if (!defer) await synchronizeDeferred()
        const damage = defer ? { full: true, bounds: null, reason: 'transient-translation' } :
          JSON.parse(await kernel.apply_document_patch_with_damage(request.documentPatch)) as {full:boolean;bounds:[number,number,number,number]|null;rects?:[number,number,number,number][];reason?:string}
        if(!defer)synchronizedInteractionDocument=interactionDocument
        if (defer) deferredInteractionDocument = interactionDocument
        // Kernel-tiled frames consume the same damage: full repaint, bounded
        // world rects, or no paint change.
        paintDamage = {full:damage.full,bounds:damage.bounds??undefined,rects:damage.rects,reason:damage.reason}
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
          resourceGeneration++
          invalidateTileCache()
        }
        loadedDocument = ''
        loadedRevision = request.documentRevision
        compiledScene = undefined
      }
      if (request.documentRevision !== loadedRevision) throw new Error('渲染文档版本未同步')
      // Apply the versioned document envelope even when its pixels were
      // superseded; the following request may legitimately patch this revision.
      if ((livePreview || tileViewport) && generation !== previewGenerations[channel]) throw Error('PREVIEW_CANCELLED')
      // Camera-only cancellation must still apply the ordered document above,
      // but need not initialize GPU pipelines or hydrate a stale raster batch.
      // Page coverage is useful across cameras and keeps its explicit exemption.
      if (tileViewport && channel === 'canvas' && fillGeneration !== tileFillGeneration)
        throw Error('PREVIEW_CANCELLED')
      if (deferredInteractionDocument && translated?.options !== options && compiledScene?.options !== options) await synchronizeDeferred()
      // Whole-board translation changes almost every visible program. Its
      // measured full packet is cheaper than diffing/reassembling that stream.
      // Keep deltas for local edits; neither route changes the exact compiler.
      const incrementalScene = interactionNative && import.meta.env.VITE_DESIGN_SCENE_DELTA!=='0' &&
        !(interactionSelection || []).some((id: string) => interactionDocument?.pages.some(page => page.children.includes(id)))
      const hydrateImages = sceneImageHydration(kernel, () => !(livePreview || tileViewport) || previewCurrent())
      const settingsJson = kernel.color_settings()
      const color: ColorSettings | undefined = JSON.parse(settingsJson) || undefined
      if (tileOwner !== undefined && (!tileOwner || typeof tileOwner !== 'object' ||
          tileOwner.documentId !== loadedDocumentId || !Number.isSafeInteger(tileOwner.sessionEpoch) ||
          tileOwner.sessionEpoch < 0)) throw new Error('Invalid tile session owner')
      // Explicit UI session ownership is required for cross-revision reuse.
      const tileOwnerKey = tileOwner === undefined ? ['revision', loadedRevision] :
        ['session', tileOwner.documentId, tileOwner.sessionEpoch]
      const loadMs = performance.now() - start
      const wantsReference = import.meta.env.DEV && request.referenceGpu === true
      const wantsBatch = !(import.meta.env.DEV && request.debug?.disableSolidBatch)
      const cacheScene = !(import.meta.env.DEV && request.debug?.disableSceneCache)
      if (cacheScene && translated?.options === options)
        compiledScene = { revision: loadedRevision, options, scene: translated.scene }
      if (
        settingsJson !== colorKey ||
        preference !== backend ||
        wantsReference !== referenceGpu ||
        wantsBatch !== solidBatchGpu
      ) {
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
        invalidateTileCache()
        gpu.dispose()
        gpu = undefined
      }
      const candidates = rasterCandidates(executionPolicy, preference, request.png)
      let scene: GpuScene | undefined
      let compileMs = 0
      let compileCacheHit = false
      const failures = new Map(unavailable)
      for (const backend of candidates) {
        try {
          if (tileViewport) {
            if (
              !Array.isArray(tileViewport) ||
              tileViewport.length > 256 ||
              tileViewport.some(
                (t) =>
                  ![t.x, t.y, t.width, t.height].every(Number.isSafeInteger) ||
                  t.width < 1 ||
                  t.height < 1 ||
                  t.width > TILE_SIDE + 2 ||
                  t.height > TILE_SIDE + 2 ||
                  !Number.isFinite(t.zoom) ||
                  t.zoom < 0.001 ||
                  t.zoom > 128 ||
                  ![t.phaseX ?? 0, t.phaseY ?? 0].every((p) => Number.isFinite(p) && p >= 0 && p < 1) ||
                  typeof t.key !== 'string' ||
                  t.key.length > 256,
              )
            )
              throw new Error('Invalid tile request')
            if (channel === 'canvas' && request.documentPatch && !tileViewport.length && poseQueued) {
              // The final pointer pose may arrive while the CPU worker applies
              // this patch. Complete that higher-priority GPU job before proving
              // whether the already-rendered native frame can be committed.
              // Otherwise a harmless scheduling race triggers a full tile refill.
              await queue.yieldToHigherPriority(0)
              selectLane('canvas')
              if (generation !== previewGenerations.canvas) throw Error('PREVIEW_CANCELLED')
            }
            if(channel==='canvas'&&request.documentPatch&&!tileViewport.length&&poseSession?.patch)
              poseSession.document=poseSession.patch.snapshot()
            if (channel === 'canvas' && request.documentPatch && !tileViewport.length &&
                renderIntent === 'canvas' && !request.readback && !renderOptions.grid && !renderOptions.checkerboard &&
                !renderOptions.pixelPreview && allowsResidentSdr(executionPolicy) &&
                interactionDocument && poseSession?.input && displayFrame && gpu?.driver.snapshotPresented &&
                renderOptions.view.zoom === poseSession.scene.view.zoom &&
                renderOptions.width === Math.ceil(displayFrame.width * displayFrame.dpr) &&
                renderOptions.height === Math.ceil(displayFrame.height * displayFrame.dpr) &&
                JSON.parse(poseSession.options).pageId === renderOptions.pageId &&
                JSON.parse(poseSession.options).rasterProfile === renderOptions.rasterProfile &&
                canCommitResidentFrame(poseSession.scene, poseSession.document, interactionDocument, displayFrame, poseSession.input)) {
              let snapshot: ReturnType<NonNullable<typeof gpu.driver.snapshotPresented>>
              try { snapshot = gpu.driver.snapshotPresented() }
              catch (error) { if (!isDisplayBudgetError(error)) throw error }
              if (snapshot && canCommitResidentFrame(poseSession.scene, poseSession.document, interactionDocument, snapshot.frame, poseSession.input)) {
                const { view, dpr, width, height } = snapshot.frame
                self.postMessage({ id: request.id, tile: { key: `commit:${loadedRevision}:${snapshot.gpuTile}`,
                  x: -view.x * dpr, y: -view.y * dpr, width: Math.ceil(width * dpr), height: Math.ceil(height * dpr),
                  zoom: view.zoom * dpr, gutter: 0, committedViewport: true, viewportPreview: true,
                  gpuTile: snapshot.gpuTile, backend, description: 'retained native viewport', cached: false } })
                self.postMessage({ id: request.id, backend, milliseconds: performance.now() - start,
                  compileMs: 0, loadMs, retainedCommit: true })
                return
              }
              if (snapshot) gpu.driver.releasePresented?.([snapshot.gpuTile])
            }
            const namespace = JSON.stringify([
              documentGeneration, resourceGeneration, tileOwnerKey,
              renderOptions.pageId,
              renderOptions.rasterProfile,
              renderOptions.interactiveEffects,
              canvasDisplayFilters,
              canvasMath,
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
            if (namespace !== tileNamespace) {
              tileNamespace = namespace
            }
            // One prepare guard shared by every tile of this request: the
            // kernel caches the flattened-geometry phase per camera, so the
            // whole-document walk happens once instead of once per tile.
            const prepareViewport = tilePrepareViewport(tileViewport, renderOptions.view, requestedPrepareViewport)
            let hits = 0, certifiedHits = 0,
              rendered = 0,
              milliseconds = 0, tileCompileMs = 0, tileGraphMs = 0, tileFinishMs = 0, tileCheckpointMs = 0,
              tileFieldMs = 0, tileFieldBytes = 0, tileFieldBuilds = 0,
              tilePeakTextureBytes = 0, tileFinishTransientBytes = 0, tileWorkingTextureBytes = 0, tileDrawCalls = 0, tileTriangles = 0,
              tileLeaves = 0, tileBitmapLeaves = 0, tileBudgetInjections = 0
            const cameraDependent = tileComputationDependsOnCamera(renderOptions, !!color)
            const requestPreference: BackendPreference | undefined = preference
            const batchStarted = performance.now(), packetHitsBefore = kernel.packetCacheHits
            const ahead = new PrepareAhead<{ bytes: Uint8Array; ms: number }>()
            let preparationWaitMs = 0, overlappedPreparations = 0
            const current = () => generation === previewGenerations[channel] &&
              (channel !== 'canvas' || fillGeneration === tileFillGeneration)
            const slot = (tile: RasterTile) => namespace + '/' + coordinateSlot([
              tile.x, tile.y, tile.width, tile.height, tile.zoom, tile.phaseX ?? 0, tile.phaseY ?? 0,
              ...(cameraDependent ? [renderOptions.view.x, renderOptions.view.y, tile.zoom] : [])])
            const compileTile = async (tile: RasterTile) => {
              if (!current()) throw Error('PREVIEW_CANCELLED')
              const at = performance.now()
              const bytes = await kernel.compile_gpu_packet(JSON.stringify({ ...renderOptions,
                view: { ...renderOptions.view, zoom: tile.zoom }, width: tile.width, height: tile.height,
                gpuViewport: { x: tile.x + Math.floor(renderOptions.view.x), y: tile.y + Math.floor(renderOptions.view.y), w: tile.width, h: tile.height },
                ...(prepareViewport ? { prepareViewport } : {}),
              }))
              return { bytes, ms: performance.now() - at }
            }
            try { for (let tileIndex = 0; tileIndex < tileViewport.length; tileIndex++) {
              const tile = tileViewport[tileIndex] as RasterTile
              let undelivered: { bitmap?: ImageBitmap; gpuTile?: number } | undefined
              try {
              if (fillGeneration !== tileFillGeneration && channel === 'canvas') throw new Error('PREVIEW_CANCELLED')
              if (generation !== previewGenerations[channel]) throw new Error('PREVIEW_CANCELLED')
              // World slots retain the computation camera for measured byte
              // dithering, grids and pixel preview. Those established paths
              // cannot certify a translated hit from world address alone.
              // Preview and settled work alternate during zoom. Both contracts
              // keep their own bounded entries instead of clearing each other's
              // cache whenever the quality tier changes.
              const cacheKey = slot(tile)
              const lifetime = cacheGeneration, tileOptions = {
                ...renderOptions, view: { ...renderOptions.view, zoom: tile.zoom },
              }, crop = { x: tile.x + Math.floor(renderOptions.view.x),
                y: tile.y + Math.floor(renderOptions.view.y), width: tile.width, height: tile.height }
              const compileStarted = performance.now()
              let speculativeSavedMs = 0
              let result: TileRender | undefined = disableExactCache || request.debug?.disableCertifiedTileReuse ? undefined : tileCache.certified(cacheKey)
              let witness: Uint8Array = new Uint8Array(), preparedScene: GpuScene | undefined
              let cameraFallback = false
              if (result) { await ahead.drain(); certifiedHits++ }
              else try {
                const waiting = performance.now()
                const prepared = await ahead.take(tileIndex) ?? await compileTile(tile)
                const waited = performance.now() - waiting
                preparationWaitMs += waited
                // Compilation work can overlap the previous tile's GPU work.
                // Keep both CPU work time and exposed wait time in telemetry.
                speculativeSavedMs = Math.max(0, prepared.ms - waited)
                const rawScene = prepared.bytes
                if (generation !== previewGenerations[channel]) throw Error('PREVIEW_CANCELLED')
                if (channel === 'canvas' && fillGeneration !== tileFillGeneration) {
                  // Optional page backing yields to a new viewport. Only an
                  // already prepared visible tile may supply useful pixels.
                  cameraFallback = !retainCoverage && !cameraDependent && preparedTileCanFill(tile, displayFrame)
                  if (!cameraFallback) throw Error('PREVIEW_CANCELLED')
                }
                witness = rawScene
                result = disableExactCache ? undefined : tileCache.get(cacheKey, witness)
                preparedScene = result ? undefined : decodeScenePacket(rawScene)
                if (preparedScene) kernel.observePacket(rawScene,preparedScene)
              } catch (error) {
                // A whole tile may exceed the working-surface budget. Let the
                // regional renderer subdivide it; a compiler admission error
                // must not bypass the same recovery as a GPU allocation error.
                if (!/GPU surface budget exceeded|GPU 表面内存预算超限|Invalid GPU viewport/.test(String(error))) throw error
              }
              const verifyMs = performance.now() - compileStarted + speculativeSavedMs, cached = !!result
              tileCompileMs += verifyMs
              milliseconds += verifyMs
              if (result) {
                hits++
                // Current-request verification cost replaces historical render timings.
                result = { ...result, milliseconds: verifyMs, compileMs: verifyMs,
                  renderMs: 0, graphMs: 0, finishMs: 0, checkpointMs: 0, drawCalls: 0, triangles: 0 }
              } else {
                const next = tileViewport[tileIndex + 1] as RasterTile | undefined
                if (next && current() && !next.prefetch && kernel.canPrepareConcurrently &&
                    import.meta.env.VITE_DESIGN_PREPARE_PIPELINE !== '0' &&
                    (disableExactCache || request.debug?.disableCertifiedTileReuse || !tileCache.certified(slot(next)))) {
                  ahead.start(tileIndex + 1, () => compileTile(next))
                  overlappedPreparations++
                }
                result = await renderTiledPreview(kernel, tileOptions, backend, color,
                  settingsJson, TILE_SIDE + 2, crop, preparedScene,
                  import.meta.env.DEV && request.debug?.forceFirstTileBudgetFailure === true,
                  prepareViewport, !request.readback, canvasDisplayFilters, canvasMath, reportRasterProgress,
                  () => generation === previewGenerations[channel] && (cameraFallback || current()), hydrateImages)
                undelivered = result
                if (generation !== previewGenerations[channel]) throw new Error('PREVIEW_CANCELLED')
                // Only the exact scene actually rendered once certifies these pixels.
                // Budget-subdivided assemblies have no accepted single-scene witness.
                if (!disableExactCache && witness.byteLength && result.previewTiles === 1 && lifetime === cacheGeneration)
                  tileCache.set(cacheKey, witness, {...result,worldBounds:[
                    (crop.x-renderOptions.view.x-2)/tile.zoom,(crop.y-renderOptions.view.y-2)/tile.zoom,
                    (tile.width+4)/tile.zoom,(tile.height+4)/tile.zoom,
                  ]},
                    result.buffer.byteLength + (result.linearBuffer?.byteLength || 0) +
                      JSON.stringify({ ...result, buffer: undefined, linearBuffer: undefined }).length * 2)
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
                tileDrawCalls += result.drawCalls
                tileTriangles += result.triangles
              }
              if (generation !== previewGenerations[channel]) throw new Error('PREVIEW_CANCELLED')
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
                if (generation !== previewGenerations[channel]) {
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
              await queue.yieldToHigherPriority(channel === 'interaction' ? 1 : 0)
              selectLane(channel)
              if (preference !== requestPreference || referenceGpu !== wantsReference || solidBatchGpu !== wantsBatch) {
                gpu?.dispose(); gpu = undefined; invalidateTileCache()
                preference = requestPreference; referenceGpu = wantsReference; solidBatchGpu = wantsBatch
              }
              if (generation !== previewGenerations[channel]) throw new Error('PREVIEW_CANCELLED')
              } finally {
                undelivered?.bitmap?.close()
                if (undelivered?.gpuTile) gpu?.driver.releasePresented?.([undelivered.gpuTile])
              }
            } } finally { await ahead.drain() }
            self.postMessage({
              id: request.id,
              backend,
              milliseconds,
              pipelineWallMs: performance.now() - batchStarted,
              preparationWaitMs, overlappedPreparations,
              compiledPacketHits: kernel.packetCacheHits - packetHitsBefore,
              compiledPacketBytes: kernel.packetCacheBytes,
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
              tileCacheBytes: tileCache.bytes,
              tileCacheEvictions: tileCache.evictions,
              drawCalls: tileDrawCalls,
              triangles: tileTriangles,
              peakTextureBytes: tilePeakTextureBytes,
              finishTransientBytes: tileFinishTransientBytes,
              workingTextureBytes: tileWorkingTextureBytes,
              // Counting diagnostics must not reparse a multi-megabyte source
              // after every tile. This also stays correct after patches clear
              // loadedDocument's full-sync string.
              stats: { nodes: loadedNodeCount },
            })
            return
          }
          if (
            livePreview &&
            (tiledPreviewMode || (import.meta.env.DEV && request.debug?.forcePreviewTiles))
          ) {
            await synchronizeDeferred()
            const result = await renderTiledPreview(
              kernel,
              renderOptions,
              backend,
              color,
              settingsJson,
              256, undefined, undefined, false, undefined, false, false, false, undefined, previewCurrent, hydrateImages,
            )
            self.postMessage(
              { id: request.id, ...result, loadMs },
              { transfer: [result.buffer, ...(result.linearBuffer ? [result.linearBuffer] : [])] },
            )
            return
          }
          // CPU-only runs never even load the graphics drivers.
          const { createGpu, straightAlpha } = await import('./gpu/factory')
          if (channel==='interaction' && retainInteraction && incrementalScene) {
            const t=performance.now(); await synchronizeDeferred()
            scene=await kernel.compile_gpu_scene_update(options,true); compileMs=performance.now()-t
          }
          if (!scene) {
            if (
              cacheScene &&
              compiledScene?.revision === loadedRevision &&
              compiledScene.options === options
            ) {
              scene = compiledScene.scene
              compileCacheHit = true
            } else {
              const t = performance.now()
              await synchronizeDeferred()
              scene = decodeScenePacket(await kernel.compile_gpu_packet(options))
              compileMs = performance.now() - t
              if (cacheScene) compiledScene = { revision: loadedRevision, options, scene: scene! }
            }
          }
          // A compile can outlive the camera request while the preparation
          // worker is busy. Do not initialize/encode its superseded graph.
          if ((livePreview || tileViewport) && !previewCurrent()) throw Error('PREVIEW_CANCELLED')
          if (retainInteraction && interactionSelection !== undefined) {
            if (!Array.isArray(interactionSelection) || interactionSelection.length > 16 ||
                interactionSelection.some(id => typeof id !== 'string')) throw Error('Invalid interaction selection')
            scene = { ...preparePreviewSelection(scene!, interactionSelection), interactionSelection: [...interactionSelection] }
            if (cacheScene) compiledScene = { revision: loadedRevision, options, scene }
          }
          // Color-managed inputs retain linear computation even for SDR output.
          // The HDR preference controls presentation, never the document model.
          scene!.floatCompositing = requiresFloatCompositing(executionPolicy, scene!)
          // HQ resolve/pixel-preview coordinates differ from the input window.
          // They keep the exact ordinary graph until that mapping is supported.
          const retainedScene = allowsInteractionWindow(retainInteraction,scene!)
          scene!.interactionRetained = retainedScene
          scene!.nativeInteraction = retainedScene && interactionNative === true
          scene!.interactionLease = retainedScene ? {} : undefined
          scene!.interactionWindow = retainedScene ? interactionWindow : undefined
          scene!.pairedDisplayFilters = request.debug?.pairedDisplayFilters
          scene!.compactImageFields = request.debug?.denseImageFields !== true
          scene!.disableSparseGlass = request.debug?.disableSparseGlass === true
          scene!.displayFilters = canvasDisplayFilters || usesTransientDisplayFilters(executionPolicy, {
            renderIntent, png: request.png, readback: request.readback, exportFormat,
            exportRegion: renderOptions.exportRegion, pixelPreview: renderOptions.pixelPreview,
          })
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
            invalidateTileCache()
            gpu.dispose()
            gpu = undefined
          }
          if (!gpu) {
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
              )
            } catch (error) {
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
          const t = performance.now(),
            result = await gpu.render(
              scene!,
              request.png || request.readback || (!!color && !gpu.driver.hdr && !((retainInteraction || displayCanvas) && backend === 'webgpu')),
            )
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
          if(channel==='interaction'&&retainInteraction&&interactionDocument&&result.gpuTile&&interactionWindow&&
              !scene!.resolve&&!scene!.presentation&&import.meta.env.VITE_DESIGN_WORKER_POSES!=='0'){
            // Cached coverage is reused only for integer device-pixel moves.
            // Fractional poses request a fresh capture through the normal rebase
            // path; warming their former bilinear approximation is unnecessary.
            poseSession={slot:result.gpuTile,document:interactionDocument,baseDocument:interactionDocument,
              scene:scene!,native:interactionNative===true,delta:!!incrementalScene,window:interactionWindow,fixedWindow:interactionWindowFixed===true,options,stopped:false,
              patch:interactionNative||import.meta.env.VITE_DESIGN_POSE_PATCHES!=='0'?TranslationPatchSession.create(scene!,interactionDocument,interactionSelection||[],interactionNative===true)||undefined:undefined}
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
            try { preservedPreview = await recoverPreviewBudget(error, gpu, invalidateTileCache) }
            catch (recoveryError) { gpu = undefined; throw recoveryError }
          }
          if (preservedPreview && (renderOptions.captureViewport || _retainInteractionGraph ||
              !previewTileFallback || tiledPreviewMode)) {
            throw renderErrorWithBudget(error, `PREVIEW_BUDGET: ${String(error)}`)
          }
          if (tileViewport) {
            if (
              backend === 'webgpu' &&
              preference === 'auto' &&
              !String(error).includes('Invalid tile request')
            ) {
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
                256, undefined, undefined, false, undefined, false, false, false, undefined, previewCurrent, hydrateImages,
              )
              self.postMessage(
                { id: request.id, ...result, loadMs },
                {
                  transfer: [result.buffer, ...(result.linearBuffer ? [result.linearBuffer] : [])],
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
      self.postMessage({
        id: request.id,
        ...renderFailureEnvelope(error),
      })
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
) {
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
  const managedOutput = !!(executionPolicy?.hdrCompositing && color)
  const admissionKey=JSON.stringify([documentGeneration,resourceGeneration,options.pageId,options.view.zoom,
    options.rasterProfile,options.interactiveEffects,backend,managedOutput,canvasDisplayFilters,canvasMath,referenceGpu])
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
    scene.floatCompositing = requiresFloatCompositing(executionPolicy!, scene)
    const displayMath = canvasMath && backend === 'webgpu' && scene.floatCompositing && !scene.softwareRaster
    scene.displayFilters = canvasDisplayFilters || (options.interactiveEffects === true && !executionPolicy?.desktopFullMath)
    {
      try {
        if (gpu && (gpu.driver.lost || gpu.driver.name !== backend || !!gpu.driver.managed !== scene.floatCompositing || !!gpu.driver.displayMath !== displayMath)) {
          invalidateTileCache()
          gpu.dispose()
          gpu = undefined
        }
        gpu ??= await createGpu(
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
        )
        if (gpu.driver.name !== 'webgpu') throw new Error('present fast path unavailable')
        checkCurrent()
        await hydrateImages(scene, isCurrent)
        prepareDisplay()
        const result = await gpu.render(scene, false, true)
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
  let skipFailedRegion = /GPU surface budget exceeded|GPU 表面内存预算超限|Invalid GPU viewport/.test(presentationFailure)
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
        const scene = prepared ?? decodeScenePacket(
          await kernel.compile_gpu_packet(JSON.stringify({ ...options, width: tile.width, height: tile.height,
            view: options.view, gpuViewport: { x: (crop?.x || 0) + tile.x,
              y: (crop?.y || 0) + tile.y, w: tile.width, h: tile.height },
            ...(prepareViewport ? { prepareViewport } : {}) })),
        ) as GpuScene
        checkCurrent()
        compileMs += performance.now() - t
        Object.keys(scene.nodes).forEach((id) => nodes.add(id))
        scene.floatCompositing = requiresFloatCompositing(executionPolicy!, scene)
        // Budget splitting changes transport, not the caller's canvas intent.
        // Keep the same filter contract on every child region.
        scene.displayFilters = canvasDisplayFilters
        const floating = scene.floatCompositing
        const displayMath = canvasMath && backend === 'webgpu' && floating && !scene.softwareRaster
        floatingFrame ||= floating
        if (
          gpu &&
          (gpu.driver.lost ||
            gpu.driver.name !== backend ||
            !!gpu.driver.managed !== floating || !!gpu.driver.displayMath !== displayMath)
        ) {
          invalidateTileCache()
          gpu.dispose()
          gpu = undefined
        }
        gpu ??= await createGpu(
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
        )
        // Assembly needs a bitmap per leaf, but the attached presenter and its
        // previous textures remain alive on this same device during the retry.
        checkCurrent()
        await hydrateImages(scene, isCurrent)
        prepareDisplay(false)
        const result = await gpu.render(scene, !bitmapAssembly, bitmapAssembly)
        bitmap = result.bitmap
        checkCurrent()
        onRegionComplete?.()
        description = result.description
        hybridEffects += result.hybridEffects
        materialFieldHits += result.materialFieldHits
        materialFieldBuilds += result.materialFieldBuilds
        materialFieldBuildMs += result.materialFieldBuildMs
        materialFieldUploadBytes += result.materialFieldUploadBytes
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
    const width = crop?.width ?? options.width, height = crop?.height ?? options.height
    if (bitmapAssembly) {
      const result = await renderBitmapPreviewTiles(width, height, async tile => {
        const pixels = await rasterize(tile)
        if (ArrayBuffer.isView(pixels)) throw new Error('Expected GPU display tile')
        return pixels
      }, tileSide, admission, checkpoint)
      presented = result.bitmap
      bitmapLeaves = result.tiles
    } else assembled = await renderPreviewTiles(width, height, async tile => {
      const pixels = await rasterize(tile)
      if (!ArrayBuffer.isView(pixels)) { pixels.close(); throw new Error('Expected exact tile readback') }
      return pixels
    }, tileSide, admission, checkpoint)
  }
  if (presented || residentTile)
    return {
      bitmap: presented,
      gpuTile: residentTile,
      buffer: new ArrayBuffer(0),
      backend,
      description,
      hybridEffects, materialFieldHits, materialFieldBuilds, materialFieldBuildMs, materialFieldUploadBytes,
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
    buffer: bytes.buffer,
    bitmapLeaves: 0,
    linearBuffer: linear?.buffer,
    backend,
    description,
    hybridEffects, materialFieldHits, materialFieldBuilds, materialFieldBuildMs, materialFieldUploadBytes,
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
