import { captureFailureCause, observedFailureCause, type FailedCaptureCause } from './pose-failed-cause'
import { PoseActionCorrelation, type PoseActionToken } from './pose-action-correlation'
import type { OverlayCaptureCohort, SurfaceProps } from './Surface'
import { createHandoffTrace, gestureCode, type HandoffTrace } from './handoff-trace'
import { createPoseDiagnostics, type PoseDiagnostics } from './pose-diagnostics'
import { PoseFeedback } from './pose-feedback'
import type { Bounds, DesignDocument, Matrix } from '../model'
import { translateOverlay, transformOverlay, type CanvasOverlay } from './gpu/canvas-overlay'
import type { CanvasCamera } from '../canvas-camera'
import { allowsReducedSampling } from './render-quality'
import { interactionAdaptiveScale } from './interaction-adaptive-density'
import { renderFailureFields } from './render-failure-telemetry'
import { interactionCaptureTiles, recoverableInteractionBudget } from './interaction-capture-tiles'
import { canvasRasterPlan } from './canvas-raster-plan'
import { expandedInteractionCapture } from './interaction-capture-window'
import { tilePlacementAtView } from './tile-preview'
import { scene, unionBounds } from '../geometry'
import { buildInteractionDependencyScope } from './interaction-scene-bounds'
import { rigidInteractionCapture } from './rigid-interaction-capture'
import { guardedForegroundSafe } from './guarded-foreground'
import { KernelClient, type KernelOptions, type KernelResult } from './client'
import type { BackendPreference } from './gpu/types'
import type { CompositeItem, CompositeTile } from './gpu/tile-compositor'
import { interactionOffsets, interactionPatchedDocument, interactionPatchedOffsets, interactionPatchedTransforms, InteractionAffinePlan, interactionPoseMatrices, interactionTransformsOnly, InteractionLayerPlanner,
  type GpuMoveControl, type InteractionPlan, type InteractionProps, type InteractionInput } from './interaction-layers'

let serial = -1
type ResidentInteraction = {
  held?: {plan:InteractionPlan;offsets?:Map<string,{x:number;y:number}>;parentLinear?:Map<string,number[]>;visibleBounds?:Bounds;blend:boolean;
    capture?:ResidentInteraction['overlayCapture'];workerPoses:boolean;viewportRevision:number}
  sampleOrder?: number
  displayedOffsets?: Map<string, {x:number;y:number}>
  plan: InteractionPlan; tiles: CompositeTile[]; scale: number;
  offsets: Map<string, { x: number; y: number }>; active: boolean
  live?: boolean
  rootBounds?: Map<string, Bounds>
  parentLinear?: Map<string, number[]>
  parentMatrices?: Map<string, Matrix>
  affine?: boolean
  affinePlan?: InteractionAffinePlan
  inputPriority?: boolean
  displayedTransforms?: Record<string, Matrix>
  // Only a complete capture may retain chrome from that exact document. World
  // AABBs, size text and measurements cannot be recovered by inverse affine.
  overlayCapture?: { document: DesignDocument; tiles: CompositeTile[]; slots: readonly number[]; cohort: OverlayCaptureCohort;
    pageId: string; epoch: number; generation: number; handoffGeneration?: number;
    ids: ReadonlySet<string>; geometryValid?: boolean; overlay?: { uiIdentity:string; sourceCommands:CanvasOverlay; commands:CanvasOverlay };
    checkedDocument?: DesignDocument; checkedValid?: boolean }
  localizedBounds?: Set<string>
  shortTravelBounds?: Set<string>
  fixedBounds?: Set<string>
  finalForeground?: boolean
  foregroundExclusions?: Bounds[]
  foregroundCapture?: boolean
  foregroundCaptureBounds?: boolean
  captureBounds?: Bounds
  dependencyPadding?: number
  visibleBounds?: Bounds
  repairBounds?: Bounds
  workerPoses?: boolean
  backgroundLinear?:KernelResult['backgroundLinear']
  requestedScale?:number
  tiledExact?:boolean
  retainedFallback?:boolean
}
type IdleWarmContext = {
  resident: ResidentInteraction; document: DesignDocument; pageId: string; ids: string[]
  epoch: number; generation: number; viewportRevision: number
  view: CanvasCamera; width: number; height: number; dpr: number
  profile: KernelOptions['rasterProfile']; backend: BackendPreference | undefined
}

/** A bounded, kernel-rendered set of isolated layer intervals. It is reusable
 * outside the original viewport and preserves order across board overlap.
 * This transient SDR presentation never certifies exact output or exports. */
let nextInteractionOwner = 0
export class InteractionRenderer {
  private qualityZoom = 1
  private client: KernelClient | null = null
  private readonly interactionOwner = ++nextInteractionOwner
  private generation = 0
  private captureAbort = new AbortController()
  private nextGeneration() {
    // A shared worker may serve other interaction owners. Retire only requests
    // issued by this obsolete capture, not the entire interaction channel.
    this.cancelIdleWarmTimer(); this.idleWarmCapture = undefined
    if(this.navigationWarmTimer!==undefined)clearTimeout(this.navigationWarmTimer)
    this.navigationWarmTimer=undefined
    this.navigationWarmRequest=undefined
    this.handoff = undefined
    this.captureAbort.abort(); this.captureAbort = new AbortController()
    return ++this.generation
  }
  private pending?: { document: DesignDocument; pageId: string; ids: string; scale: number; viewportRevision:number }
  private pendingDensity?: Parameters<InteractionRenderer['prepare']>
  private resident?: ResidentInteraction
  private readonly layerPlanner = new InteractionLayerPlanner()
  private readonly poseTopology=new WeakMap<InteractionPlan,readonly string[]>()
  private samePoseTopology(plan:InteractionPlan,document:DesignDocument){
    if(plan.document===document)return true
    const before=plan.document
    if(before.id!==document.id)return false
    let ids=this.poseTopology.get(plan)
    if(!ids){
      const parents=new Map<string,string>();for(const n of Object.values(before.nodes))for(const child of n.children)parents.set(child,n.id)
      const chain=new Set<string>();for(const id of plan.ids){let at:string|undefined=id;while(at&&!chain.has(at)){chain.add(at);at=parents.get(at)}}
      ids=[...chain];this.poseTopology.set(plan,ids)
    }
    for(const id of ids){const a=before.nodes[id],b=document.nodes[id];if(!a||!b||a.children.length!==b.children.length||a.children.some((child,i)=>child!==b.children[i]))return false}
    const a=before.pages.find(p=>p.id===plan.pageId),b=document.pages.find(p=>p.id===plan.pageId)
    return !!a&&!!b&&a.children.length===b.children.length&&a.children.every((id,i)=>id===b.children[i])
  }
  private neutralPageCandidates = new WeakMap<ResidentInteraction,{viewportRevision:number;plan:InteractionPlan|null}>()
  private props?: InteractionProps
  private overlaySource?: SurfaceProps['overlay']
  private disposed = false
  private profile?: KernelOptions['rasterProfile']
  private backend?: BackendPreference
  private sessionEpoch?: number
  // Monotonic authored-document observations, separate from pointer sequence.
  // A complete newer page may hide old pixels without retiring the warm owner.
  private sourceOrder = 0
  // A warm native pose can outlive an authored commit/undo. Its capture's old
  // order must not hide newly sampled input behind a newer complete page.
  // Store the order at submission, never borrow the order at completion.
  private readonly poseOrders = new Map<number,number>()
  private completePageOrder = 0
  private livePendingOrder = 0
  private liveRequestedOrder = -1
  private livePending?: DesignDocument | (()=>DesignDocument)
  private liveRunning = false
  private liveRequested?: DesignDocument
  private liveCancelled = false
  private liveDeferred = false
  private viewport?: { view: CanvasCamera; width: number; height: number; dpr: number }
  private settledViewport?: { document:DesignDocument; pageId:string; epoch:number;
    view:CanvasCamera; width:number; height:number; dpr:number; profile:KernelOptions['rasterProfile']; backend:BackendPreference }
  private settledViewportMatches(document:DesignDocument,view:CanvasCamera) {
    const ready=this.settledViewport,v=this.viewport
    return !!ready&&!!v&&ready.document===document&&ready.pageId===this.resident?.plan.pageId&&ready.epoch===this.props?.epoch&&
      ready.profile===this.profile&&ready.backend===this.backend&&ready.width===v.width&&ready.height===v.height&&ready.dpr===v.dpr&&
      ready.view.x===view.x&&ready.view.y===view.y&&ready.view.zoom===view.zoom&&
      v.view.x===view.x&&v.view.y===view.y&&v.view.zoom===view.zoom
  }
  private viewportRevision = 0
  private lastNavigationAt = -Infinity
  private navigationWarmTimer?: ReturnType<typeof setTimeout>
  private navigationWarmRequest?: Parameters<InteractionRenderer['prepare']>
  private lastSettledDocument?: DesignDocument
  private idleWarmTimer?: ReturnType<typeof setTimeout>
  private idleWarmWaiting?: IdleWarmContext
  private idleWarmCapture?: IdleWarmContext
  private idleWarmAttempt?: IdleWarmContext
  private idleWarmFailed?: IdleWarmContext
  private inputs = new WeakMap<DesignDocument,InteractionInput>()
  private failedGesture = false
  private feedbackDeferred = false
  private readonly feedbackOwners = new WeakMap<DesignDocument, object>()
  private poseDocumentGeneration=0
  private poseRetiredThrough=0
  private poseRetiredReason=2
  private poseEndedThrough=0
  private poseEndSequence:number|undefined
  private readonly poseActions=new PoseActionCorrelation()
  private readonly poseLog:PoseDiagnostics
  private poseEvent(stage:number,reason=0,sequence=this.lastInput.sequence,sampleKind=0,trace?:PoseActionToken,cause?:Record<string,number>) {
    if(!this.poseLog.enabled)return
    this.poseLog.record(stage,reason,sequence,{...this.poseActions.fields(sequence,trace),...cause,interactionGeneration:this.generation,poseEpoch:this.props?.epoch??0,poseSampleKind:sampleKind,poseDocumentGeneration:this.poseDocumentGeneration,poseActive:Number(!!this.resident?.active),poseReady:Number(!!this.resident?.tiles.length),poseDeferred:Number(this.feedbackDeferred)})
  }
  private clearPoseFeedback(reason:number) { this.poseEndSequence=undefined;this.pendingPresentedInput=undefined;this.poseEvent(6,reason);this.poseRetiredThrough=this.lastInput.sequence;this.poseRetiredReason=reason;this.poseFeedback.clear();this.poseDocumentGeneration++ }
  private readonly poseFeedback = new PoseFeedback()
  private lastInput: InteractionInput = {sequence:0,at:0}
  private lastPresentedInput: InteractionInput = {sequence:0,at:0}
  // The worker's synchronous presenter ACK precedes its sample notification.
  // Retain only the newest proven frame ACK, not another document or input queue.
  private pendingPresentedInput?: { sequence:number;at:number;generation:number;resident:ResidentInteraction;owner:object;slot?:number }
  private latestCandidate?: DesignDocument
  private latestPatch?: { document:DesignDocument; patches:Parameters<typeof interactionPatchedDocument>[1] }
  private affineBase?: { plan: InteractionPlan; document: DesignDocument; valid: boolean }
  private patchBase?: { plan:InteractionPlan; document:DesignDocument; offsets:ReturnType<typeof interactionOffsets> }
  readonly inputPreparationTrace:number[]=[]
  private baseOffsets(plan:InteractionPlan,document:DesignDocument) {
    if(import.meta.env.VITE_DESIGN_POSE_PATCHES==='0')return interactionOffsets(plan,document)
    if(this.patchBase?.plan===plan&&this.patchBase.document===document)return this.patchBase.offsets
    const offsets=document===plan.document?new Map(plan.ids.map(id=>[id,{x:0,y:0}])):interactionOffsets(plan,document)
    this.patchBase={plan,document,offsets};return offsets
  }
  private candidateDocument() {
    if(!this.latestCandidate&&this.latestPatch){
      this.latestCandidate=interactionPatchedDocument(this.latestPatch.document,this.latestPatch.patches)
      this.inputs.set(this.latestCandidate,this.lastInput)
    }
    return this.latestCandidate
  }
  private pendingLiveDocument(){
    if(typeof this.livePending==='function')this.livePending=this.livePending()
    return this.livePending
  }
  private queueLivePose(){
    if(!this.liveRunning||!this.latestPatch){this.renderLive(this.candidateDocument()!);return}
    const {document,patches}=this.latestPatch,input=this.lastInput
    // Only the newest compact pose waits behind an in-flight capture. Copying
    // the complete node dictionary for every coalesced pointer sample blocks
    // the UI even though none of those intermediate documents can be rendered.
    this.livePending=()=>{const candidate=interactionPatchedDocument(document,patches);this.inputs.set(candidate,input);return candidate}
    this.livePendingOrder=this.sourceOrder;this.liveRequested=undefined
  }
  private inlineDisabled = false
  private recoverySerial = 0
  private recoveryScope?: { serial: number; document: DesignDocument; epoch: number; pageId: string }
  private retireRecovery() { this.recoverySerial++; this.recoveryScope = undefined }
  private liveAuthored?: DesignDocument
  private endedDocument?: DesignDocument
  private endedMove = false
  /** Keep completed interaction pixels visible while the committed document
   * transfers to exact canvas tiles, without starting another tiled capture. */
  private handoff?: {
    resident: ResidentInteraction; document: DesignDocument; previousDocument: DesignDocument; epoch: number; viewportRevision: number
  }
  error = ''
  warming = false
  moves = 0
  samples = 0
  lastSampleMs = 0
  lastSampleCompileMs = 0
  lastSampleGraphMs = 0
  lastSampleReused = false
  lastSampleGroupHits = 0
  lastSampleLoadMs = 0
  lastSamplePrepareMs = 0
  lastEnd = ''
  get tracing() { return import.meta.env.DEV || this.poseLog.enabled }
  readonly sampleTrace: { documentForks?:number; total: number; prepare: number; load: number; compile: number; graph: number; finish: number; reused: boolean; active: boolean; backend?:string; reason?:string; scale?:number; pixels?:number;sceneUpdateBytes?:number;geometryUploadBytes?:number;residentProgramHits?:number;residentProgramHitBytes?:number;posePrepareMs?:number;documentMs?:number;translationMs?:number;patchSession?:boolean;affectedNodes?:number;passTimings?:unknown[];compileStats?:Record<string,unknown>;fieldUploadBytes?:number;groupBytes?:number;prefixHits?:number;fieldHits?:number;checkpointMs?:number;fieldMs?:number;drawCalls?:number;passPixels?:number;textureBytes?:number }[] = []
  readonly control: GpuMoveControl

  constructor(private readonly changed: () => void, private readonly sharedClient?: KernelClient,
    private readonly allowIdleWarm = false, poseDiagnostics?:PoseDiagnostics, private readonly handoffTrace:HandoffTrace=createHandoffTrace()) {
    this.poseLog=poseDiagnostics??createPoseDiagnostics(this.interactionOwner)
    this.control = {
      releaseInput:()=>{
        const r=this.resident
        if(r?.active&&r.live&&r.workerPoses&&!this.error&&!this.inlineDisabled&&r.tiles[0]?.gpuTile)
          this.sharedClient?.settleResidentInteraction(r.tiles[0].gpuTile,this.lastInput.sequence)
      },
      isActive: () => !!this.resident?.active,
      guidesInSurface: () => !!this.sharedClient,
      blocksCanvasRefinement:(document,ids,view)=>{
        const r=this.resident,v=this.viewport
        if(import.meta.env.VITE_DESIGN_ACTIVE_GESTURE_PRIORITY!=='0'&&import.meta.env.VITE_DESIGN_RETAINED_INPUT_PRIORITY!=='0'&&
            this.sharedClient&&r?.active&&!this.error&&!this.endedDocument&&!this.handoff&&this.sameIds(ids)&&
            this.settledViewportMatches(document,view))return true
        if(import.meta.env.VITE_DESIGN_RETAINED_INPUT_PRIORITY!=='1')return false
        return !!this.sharedClient&&!!r&&r.active&&!r.live&&!r.affine&&!this.error&&!this.endedDocument&&!this.handoff&&
          !!v&&v.view.x===view.x&&v.view.y===view.y&&v.view.zoom===view.zoom&&r.scale>=view.zoom*v.dpr&&
          r.tiles.length===r.plan.layers.length&&r.tiles.length>0&&r.tiles.every(tile=>!!tile.gpuTile&&tile.zoom>=view.zoom*v.dpr)&&
          this.sameIds(ids)&&!!this.baseOffsets(r.plan,document)
      },
      apply: (document, patches, trace, guides) => {
        const inputStarted=performance.now()
        const committedHandoff=!!this.endedDocument||!!this.handoff
        this.endedDocument = undefined
        const r = this.resident
        if (!r || this.error && (!r.tiles.length || r.live && !r.retainedFallback) || Object.keys(patches).some(id => !r.plan.ids.includes(id))) { this.poseEvent(7,!r?11:this.error?5:13,0,0,trace);return null }
        const fast=import.meta.env.VITE_DESIGN_POSE_PATCHES!=='0'
        const offsets = interactionPatchedOffsets(r.plan, document, patches,fast?this.baseOffsets(r.plan,document):undefined)
        const affineBase = document === r.plan.document || this.affineBase?.plan === r.plan && this.affineBase.document === document
          ? document === r.plan.document || this.affineBase!.valid : interactionTransformsOnly(r.plan, document)
        this.affineBase = { plan: r.plan, document, valid: affineBase }
        const poses = interactionPatchedTransforms(r.plan, document, patches, affineBase)
        if (!poses || !affineBase) { this.poseEvent(7,13,0,0,trace);return null }
        const affine = !offsets
        if (affine) {
          if(r.affinePlan?.plan!==r.plan)r.affinePlan=new InteractionAffinePlan(r.plan)
          if(!r.affinePlan.accepts(patches)){this.poseEvent(7,13,0,0,trace);return null}
        }
        if (r.foregroundExclusions && guardedForegroundSafe(r.foregroundExclusions,r.rootBounds,r.plan.ids,
            offsets,r.parentLinear,r.scale) !== r.foregroundCapture && !this.inlineDisabled) {
          this.inlineDisabled = true; r.captureBounds = undefined
          if (r.tiles[0]?.gpuTile) this.sharedClient?.stopResidentInteraction(r.tiles[0].gpuTile)
        }
        // Never affine-transform retained bitmap pixels. The first affine pose
        // promotes to a fresh native capture with compiler-owned halos.
        if (affine && !r.affine) {
          r.affine = true; r.captureBounds = undefined; this.inlineDisabled = true
          if (r.tiles[0]?.gpuTile) this.sharedClient?.stopResidentInteraction(r.tiles[0].gpuTile)
          if (!r.parentMatrices) Object.assign(r, buildInteractionDependencyScope(document, r.plan.pageId,
            this.props?.scene?.entriesFor(document,r.plan.pageId,this.props.epoch) ?? scene(document,r.plan.pageId),
            r.plan.ids, { zoom: this.qualityZoom, dpr: this.viewport?.dpr || 1, allowFixedBackdrop: false }))
        }
        // A useful same-context capture can finish into the first/latest pose
        // handoff. Only an unstarted idle timer is cancelled by this gesture.
        this.cancelIdleWarmTimer(); this.idleWarmCapture = undefined
        // A new accepted gesture owns new capture work. The previous complete
        // pixels remain available while an aborted predecessor unwinds.
        this.handoff = undefined
        const transforms = poses
        if (this.liveAuthored !== document) this.clearPoseFeedback(2)
        if (!this.recoveryScope || this.recoveryScope.document !== document) {
          this.recoveryScope = { serial: ++this.recoverySerial, document, epoch: this.props!.epoch, pageId: r.plan.pageId }
        }
        this.liveAuthored=document
        this.latestPatch={document,patches:Object.fromEntries(r.plan.ids.map(id=>[id,{transform:transforms[id]}]))}
        this.latestCandidate=fast?undefined:interactionPatchedDocument(document,patches)
        const wasActive = r.active
        const newGesture=!wasActive||committedHandoff
        const retainedRebase = !r.live && (affine || !!offsets && !this.retainedOffsetsReusable(r, offsets))
        if (!retainedRebase && offsets) r.offsets = offsets
        r.active = true; this.moves++
        const inputPriority=!!this.viewport&&!!this.control.blocksCanvasRefinement?.(document,r.plan.ids,this.viewport.view)
        if(inputPriority&&(newGesture||!r.inputPriority))this.sharedClient?.cancelPreview('canvas')
        r.inputPriority=inputPriority
        this.lastInput={sequence:this.moves,at:performance.now(),guides:guides?.slice(0,2).map(g=>({...g}))}
        this.poseOrders.set(this.moves,this.sourceOrder)
        while(this.poseOrders.size>180)this.poseOrders.delete(this.poseOrders.keys().next().value!)
        if(this.poseLog.enabled){this.poseActions.bind(this.moves,trace);this.poseEndSequence=this.moves}
        if(this.latestCandidate)this.inputs.set(this.latestCandidate,this.lastInput)
        if (!r.live && !retainedRebase) this.lastPresentedInput = this.lastInput
        this.changed()
        if (newGesture) this.props?.onReady()
        if (retainedRebase) {
          if (r.tiles.length) this.promoteRetained(this.candidateDocument()!)
          else {
            // No isolated pixels exist yet, and this pose cannot reuse them
            // even when they arrive. Keep the complete page underneath and
            // spend this owner's work on the latest exact pose immediately.
            this.nextGeneration(); this.pending = undefined; this.pendingDensity = undefined; this.warming = false
            if (this.props && this.props.document !== document) {
              // PageTranslation can hand off from its displayed translated
              // snapshot while input still belongs to the authored document.
              // Adopt that validated owner before starting the async sample;
              // the following React prepare must not treat it as an older edit.
              this.props = { ...this.props, document }; this.sourceOrder++
              if (this.lastSettledDocument === document) this.completePageOrder = this.sourceOrder
            }
            r.live = true
            if (!r.parentMatrices) Object.assign(r, buildInteractionDependencyScope(document,r.plan.pageId,
              this.props?.scene?.entriesFor(document,r.plan.pageId,this.props.epoch) ?? scene(document,r.plan.pageId),
              r.plan.ids,{zoom:this.qualityZoom,dpr:this.viewport?.dpr||1,allowFixedBackdrop:!affine}))
            this.renderLive(this.candidateDocument()!)
          }
        }
        else if (r.live) {
          if(this.sharedClient&&r.workerPoses&&!this.inlineDisabled&&r.tiles[0]?.gpuTile){
            this.sharedClient.moveResidentInteraction(r.tiles[0].gpuTile,transforms,this.lastInput)
          }else this.queueLivePose()
        }
        const id = r.plan.ids[0], next = patches[id]?.transform, current = document.nodes[id].transform
        const m = r.parentLinear?.get(id) || [1, 0, 0, 1], dx = next ? next[4] - current[4] : 0, dy = next ? next[5] - current[5] : 0
        if(import.meta.env.DEV){this.inputPreparationTrace.push(performance.now()-inputStarted);if(this.inputPreparationTrace.length>180)this.inputPreparationTrace.shift()}
        const matrix = affine ? interactionPoseMatrices(Object.fromEntries(r.plan.ids.map(id => [id, document.nodes[id].transform])),
          transforms, r.parentMatrices)?.get(id) : undefined
        const offset = { x: m[0] * dx + m[2] * dy, y: m[1] * dx + m[3] * dy, ...(matrix ? { matrix } : {}) }
        // Even an integer retained move crosses the compositor queue. Chrome
        // must follow the accepted draw, not the requested pointer position.
        this.poseFeedback.submit(this.lastInput.sequence, offset, this.feedbackOwner(document))
        this.feedbackDeferred = true
        this.poseEvent(1)
        return offset
      },
      covers: (document, ids, _view) => !!this.resident && (!this.error || (!this.resident.live || !!this.resident.retainedFallback) && this.ready) && this.sameIds(ids) &&
        (this.resident.live && document.id === this.resident.plan.document.id && (this.props?.active || this.resident.active) ||
          !!this.baseOffsets(this.resident.plan, document) || interactionTransformsOnly(this.resident.plan, document)),
      feedbackPending: () => this.feedbackDeferred,
      inputSequence: () => this.lastInput.sequence,
      previewFailure: () => this.error ? 1 : 0,
      end: document => {
        this.lastInput={...this.lastInput,guides:undefined}
        this.lastPresentedInput={...this.lastPresentedInput,guides:undefined}
        // Diagnostic-only provenance: consume the last accepted apply once.
        // Reset/retirement clears eligibility; never read a newer Canvas action.
        const endPatch=this.poseLog.enabled?this.latestPatch:undefined
        const endMatches=!!endPatch&&endPatch.document===this.liveAuthored&&document.id===endPatch.document.id&&
          Object.entries(endPatch.patches).every(([id,patch])=>!!patch.transform&&
            patch.transform.every((value,index)=>value===document.nodes[id]?.transform[index]))
        const endSequence=endMatches&&this.poseEndSequence===this.lastInput.sequence?this.poseEndSequence:undefined
        this.poseEndSequence=undefined
        if (this.recoveryScope) this.retireRecovery()
        this.poseEvent(5)
        this.poseEndedThrough=this.lastInput.sequence
        this.poseFeedback.clear(); this.pendingPresentedInput=undefined; this.feedbackDeferred = false
        const r = this.resident
        // Canvas forwards idle editor notifications (including hover) here.
        // They must not dispose a warmed worker before the first pointer-down.
        if (!r?.active) return
        if(this.endedDocument===document)return
        this.endedMove=this.props?.gestureKind==='move'
        this.latestPatch=undefined;this.latestCandidate=document
        if (this.error && r.live && !r.retainedFallback) {
          // Normal editor.preview now owns the authored transform. Do not keep
          // the failed native pose active over that new document, or submit it
          // a second time as a successful gesture handoff. Retain allocations
          // until ordinary ownership retirement; only stop this pose session.
          if (r.tiles[0]?.gpuTile) this.sharedClient?.stopResidentInteraction(r.tiles[0].gpuTile)
          this.endedDocument = document
          this.failedGesture = true
          this.inlineDisabled = true
          this.livePending = this.liveRequested = undefined
          this.handoff = undefined
          this.nextGeneration()
          r.active = false
          this.changed()
          return
        }
        const offsets = this.baseOffsets(r.plan, document)
        // Rotation/scale edits have no translation offsets, but a selected-
        // transforms-only diff still validates the last completed capture as
        // the pose to retain across the commit handoff below. A cancelled
        // gesture reverts to the plan snapshot and must not take that fence.
        const affine = !offsets && document !== r.plan.document && interactionTransformsOnly(r.plan, document)
        this.lastEnd = offsets ? [...offsets.values()].map(p => `${p.x},${p.y}`).join(';') : affine ? 'affine' : 'content-changed'
        r.active = r.live ? document !== r.plan.document && document.id === r.plan.document.id :
          !!offsets && [...offsets.values()].some(p => p.x !== 0 || p.y !== 0)
        if (offsets && !r.live && !this.retainedOffsetsReusable(r, offsets)) {
          if (r.tiles.length) this.promoteRetained(document)
          this.changed(); return
        }
        if (offsets) r.offsets = offsets
        if(r.live&&r.active&&(offsets||affine)&&r.workerPoses&&this.sharedClient&&!this.liveRunning&&!this.livePending&&r.tiles[0]?.gpuTile){
          // Finish the gesture through the already compiled pose session.
          // The settled document lane will apply its own patch; it must not
          // wait behind a redundant whole-viewport interaction render. Both
          // translation and admitted affine poses are freshly native-compiled.
          this.latestCandidate=document;this.liveAuthored=document
          this.lastInput={sequence:++this.moves,at:performance.now()}
          if(this.poseLog.enabled&&endSequence!==undefined)this.poseActions.inherit(endSequence,this.moves)
          this.sharedClient.moveResidentInteraction(r.tiles[0].gpuTile,
            Object.fromEntries(r.plan.ids.map(id=>[id,document.nodes[id].transform])),this.lastInput,true)
          this.endedDocument = document
          this.handoff = this.props && this.viewport && this.sessionEpoch !== undefined ? {
            resident: r, document, previousDocument: this.props.document, epoch: this.sessionEpoch, viewportRevision: this.viewportRevision,
          } : undefined
          this.changed();return
        }
        const contentRelease = this.props?.active && this.props.gestureKind === 'resize'
        if (this.sharedClient && r.live && (r.active || contentRelease) &&
            (contentRelease || offsets && !r.workerPoses || affine) &&
            this.viewport && this.props && this.sessionEpoch !== undefined && this.props.epoch === this.sessionEpoch &&
            document.id === r.plan.document.id && this.props.document.id === document.id &&
            this.sameIds(this.props.selection) && document.pages.some(page => page.id === r.plan.pageId) &&
            r.plan.ids.every(id => !!document.nodes[id])) {
          this.nextGeneration()
          // A released first capture has no useful successor in this lane.
          // Waiting for it to become tiled/complete first can enqueue an entire
          // old capture and a final capture ahead of the exact canvas repair.
          // Its private abort retains the physical request's completion fence;
          // empty residents remain unready and cannot certify any new pixels.
          this.livePending = this.liveRequested = undefined
          this.pending = undefined; this.pendingDensity = undefined
          this.handoff = { resident: r, document, previousDocument: this.props.document, epoch: this.sessionEpoch,
            viewportRevision: this.viewportRevision }
          // Only this explicit handoff carries the completed capture's chrome
          // across capture cancellation. Other generations cannot borrow it.
          if(r.overlayCapture)r.overlayCapture.handoffGeneration=this.generation
          this.endedDocument = document
          this.liveAuthored = document
          this.warming = false
          // r.active describes visible preview ownership, not permission to
          // enqueue more work. Hiding it here would jump back to old page pixels.
          r.active = !contentRelease || r.tiles.length > 0
          if (contentRelease) {
            // Resize changes authored geometry, so an old pose program cannot
            // sample or ACK that revision. Keep only its completed picture;
            // the exact canvas owns the final content and next presentation.
            if (r.tiles[0]?.gpuTile) this.sharedClient.stopResidentInteraction(r.tiles[0].gpuTile)
            this.inlineDisabled = true
          }
          this.changed()
          return
        }
        this.endedDocument = document
        if(r.live&&r.tiles[0]?.gpuTile){this.sharedClient?.stopResidentInteraction(r.tiles[0].gpuTile);this.inlineDisabled=true}
        if (r.live) {
          if (r.active) this.renderLive(document)
          else { this.livePending = undefined; this.nextGeneration(); this.releaseClient() }
        }
        this.changed()
      },
    }
  }

  private retainedOffsetsReusable(r: ResidentInteraction, offsets: Map<string, { x: number; y: number }>) {
    if (allowsReducedSampling(this.qualityZoom)) return true
    if(this.desktopRetainedTranslation(r))return true
    return r.plan.layers.every((layer, index) => {
      const local = layer.moving && offsets.get(layer.moving), parent=layer.moving && r.parentLinear?.get(layer.moving)
      const offset=local&&parent ? {x:parent[0]*local.x+parent[2]*local.y,y:parent[1]*local.x+parent[3]*local.y} : local
      const scale = r.tiles[index]?.zoom ?? r.scale
      return !offset || [offset.x * scale, offset.y * scale].every(Number.isSafeInteger)
    })
  }

  private desktopRetainedTranslation(r:ResidentInteraction){
    // Independent root intervals already preserve clipping, masks, effects
    // and linear-light order. Move their full-density pixels with the current
    // pointer pose, including fractional device pixels. This is a transient
    // interaction frame; the committed document still requires native-phase
    // page tiles. Re-rasterizing every fractional pointer position starved
    // this presentation even though the isolated content did not change.
    return import.meta.env.VITE_DESIGN_RETAINED_TRANSLATION!=='0'&&this.allowIdleWarm&&!!this.sharedClient&&
      this.profile==='figmaSubpixel'&&!r.live&&!r.affine&&r.plan.layers.length>0&&
      (r.tiles.length===0||r.tiles.length===r.plan.layers.length)
  }

  private promoteRetained(document: DesignDocument) {
    const r = this.resident
    if (!r || r.live || !r.tiles.length) return
    // A fractional translation changes coverage phase. Keep the last complete
    // isolated layers until the kernel publishes a freshly rasterized pose;
    // do not snap the pointer or translate old antialiasing samples instead.
    r.displayedOffsets = new Map(r.offsets)
    r.live = true; r.retainedFallback = true
    this.liveAuthored = this.latestPatch?.document || this.props?.document
    this.renderLive(document)
  }

  private readonly planSelections = new WeakMap<InteractionPlan, ReadonlySet<string>>()
  private selectionIds(plan: InteractionPlan) {
    let ids=this.planSelections.get(plan)
    if(!ids){ids=new Set(plan.ids);this.planSelections.set(plan,ids)}
    return ids
  }
  private sameIds(ids: string[], countOverlayWork=false) {
    const plan=this.resident?.plan
    if(!plan||ids.length!==plan.ids.length||new Set(ids).size!==ids.length)return false
    const selected=this.selectionIds(plan)
    return ids.every(id=>{if(countOverlayWork)this.overlayWork.ownerMembershipChecks++;return selected.has(id)})
  }
  private readonly overlayWork = { geometryChecks:0, snapshotCopies:0, snapshotReuses:0, ownerMembershipChecks:0 }
  get overlayCaptureDiagnostics(){return {...this.overlayWork}}
  private overlayGeometryValid(plan:InteractionPlan,document:DesignDocument){
    this.overlayWork.geometryChecks++
    return interactionTransformsOnly(plan,document)
  }

  private captureMoveOverlay(document:DesignDocument,resident:ResidentInteraction,planOffsets:ReturnType<typeof interactionOffsets>) {
    const source=this.overlaySource,ids=resident.plan.ids,commands=source?.commands,owners=commands?.selection?.owners
    // Freeze chrome with the consumed capture input, before awaiting the GPU.
    // Single-node translation preserves local bounds/size labels. Affine AABBs,
    // measured distances and dependency edits require their own Canvas snapshot.
    if(!source||!source.uiIdentity||!commands||resident.affine||ids.length!==1||commands.measurements?.length||
        owners?.length!==1||owners[0]!==ids[0]||
        source.document!==this.props?.document||source.epoch!==this.sessionEpoch)return
    if(source.document!==document&&!interactionTransformsOnly(resident.plan,source.document))return
    const offsets=source.document===resident.plan.document?planOffsets:
      interactionOffsets({...resident.plan,document:source.document},document)
    if(!offsets)return
    const id=ids[0],local=offsets.get(id),parent=resident.parentLinear?.get(id)||[1,0,0,1]
    if(!local)return
    const offset={x:parent[0]*local.x+parent[2]*local.y,y:parent[1]*local.x+parent[3]*local.y}
    if(!Number.isFinite(offset.x)||!Number.isFinite(offset.y))return
    const snapshot=translateOverlay(structuredClone(commands),new Map([[id,offset]]))
    snapshot.transforms={[id]:[...document.nodes[id].transform]}
    this.overlayWork.snapshotCopies++
    return {uiIdentity:source.uiIdentity,sourceCommands:commands,commands:snapshot}
  }

  private cancelIdleWarmTimer() {
    if (this.idleWarmTimer !== undefined) clearTimeout(this.idleWarmTimer)
    this.idleWarmTimer = undefined; this.idleWarmWaiting = undefined
  }
  private sameIdleWarmContext(context: IdleWarmContext, props: InteractionProps | undefined,
    pageId: string, profile: KernelOptions['rasterProfile'], backend: BackendPreference | undefined) {
    const viewport = this.viewport
    return !this.disposed && !!props && !!viewport && this.resident === context.resident &&
      this.generation === context.generation && this.viewportRevision === context.viewportRevision &&
      props.document === context.document && props.epoch === context.epoch && pageId === context.pageId &&
      profile === context.profile && backend === context.backend &&
      props.selection.length === context.ids.length && props.selection.every((id, i) => id === context.ids[i]) &&
      viewport.view.x === context.view.x && viewport.view.y === context.view.y && viewport.view.zoom === context.view.zoom &&
      viewport.width === context.width && viewport.height === context.height && viewport.dpr === context.dpr
  }
  private scheduleIdleWarm() {
    const props = this.props, resident = this.resident, viewport = this.viewport
    if (!this.allowIdleWarm || import.meta.env.VITE_DESIGN_NESTED_IDLE_WARM !== '1' || !this.sharedClient ||
        this.profile !== 'figmaSubpixel' || this.backend !== 'webgpu' && this.backend !== 'auto' ||
        !props || !resident?.live || !viewport || this.disposed ||
        props.active || resident.active || this.handoff || this.error || this.liveRunning || this.livePending ||
        this.lastSettledDocument !== props.document || resident.plan.document !== props.document ||
        this.sessionEpoch !== props.epoch || !this.sameIds(props.selection) ||
        resident.tiles.length > 0 && !this.inlineDisabled) return
    const page = props.document.pages.find(page => page.id === resident.plan.pageId)
    if (!page || !props.selection.length || props.selection.some(id => page.children.includes(id))) return
    const same = (context: IdleWarmContext | undefined) => !!context &&
      this.sameIdleWarmContext(context, props, resident.plan.pageId, this.profile, this.backend)
    if (same(this.idleWarmWaiting) || same(this.idleWarmAttempt)) return
    this.cancelIdleWarmTimer()
    const context: IdleWarmContext = { resident, document: props.document, pageId: resident.plan.pageId,
      ids: [...props.selection], epoch: props.epoch, generation: this.generation, viewportRevision: this.viewportRevision,
      view: { ...viewport.view }, width: viewport.width, height: viewport.height, dpr: viewport.dpr,
      profile: this.profile, backend: this.backend }
    this.idleWarmWaiting = context
    this.idleWarmTimer = setTimeout(() => {
      if (this.idleWarmWaiting !== context) return
      this.idleWarmTimer = undefined; this.idleWarmWaiting = undefined
      if (!this.sameIdleWarmContext(context, this.props, context.pageId, this.profile, this.backend) ||
          this.lastSettledDocument !== context.document || this.props!.active || resident.active ||
          this.liveRunning || this.livePending || this.handoff || this.error ||
          resident.tiles.length > 0 && !this.inlineDisabled) return
      // One attempt per stable context, including failures. This moves work to
      // an idle moment; it neither removes GPU work nor acknowledges an input.
      this.idleWarmAttempt = context; this.idleWarmCapture = context; this.idleWarmFailed = undefined
      this.renderLive(context.document)
    }, 150)
  }

  prepare(props: InteractionProps | undefined, pageId: string, view: CanvasCamera, dpr: number,
    profile: KernelOptions['rasterProfile'], backend: BackendPreference, settledDocument?: DesignDocument,
    size?: { width: number; height: number }, overlay?: SurfaceProps['overlay']) {
    this.prepareCurrent(props,pageId,view,dpr,profile,backend,settledDocument,size,overlay)
    if (this.resident && props && !props.active && settledDocument === props.document) this.resident.repairBounds = undefined
    // Selection/capture replacement can close residents without replacing the
    // complete page. Publish this proof only after the new context is installed.
    if(props&&size&&this.props===props&&settledDocument===props.document)this.settledViewport={document:settledDocument,pageId,epoch:props.epoch,
      view:{...view},dpr,...size,profile,backend}
  }
  private prepareCurrent(props: InteractionProps | undefined, pageId: string, view: CanvasCamera, dpr: number,
    profile: KernelOptions['rasterProfile'], backend: BackendPreference, settledDocument?: DesignDocument,
    size?: { width: number; height: number }, overlay?: SurfaceProps['overlay']) {
    this.overlaySource=overlay&&props&&overlay.document===props.document&&overlay.pageId===pageId&&overlay.epoch===props.epoch?overlay:undefined
    const previousViewport = this.viewport
    this.viewport = size ? { view, dpr, ...size } : undefined
    this.qualityZoom = view.zoom
    const cameraChanged = !!size && (!previousViewport || previousViewport.view.zoom !== view.zoom ||
      previousViewport.view.x !== view.x || previousViewport.view.y !== view.y || previousViewport.dpr !== dpr ||
      previousViewport.width !== size.width || previousViewport.height !== size.height)
    if (cameraChanged) this.viewportRevision++
    const navigationPriority=import.meta.env.VITE_DESIGN_NAVIGATION_CAPTURE_PRIORITY==='1'&&!!this.sharedClient&&!!size
    if(navigationPriority&&(props?.navigating||cameraChanged&&previousViewport))this.lastNavigationAt=performance.now()
    this.lastSettledDocument = settledDocument
    if (this.sharedClient && size && this.warming && this.pending && this.resident && !this.resident.live &&
        !props?.active && (!this.resident.active || !!props && this.endedDocument === props.document) &&
        (cameraChanged || settledDocument !== props?.document)) {
      // Isolated root-layer captures are optional while no gesture owns them.
      // Unlike live captures, the old density-wait path could keep encoding a
      // stale warm-up ahead of a new exact canvas plan. Revoke only this owner's
      // signal: accepted document mutations and already submitted GPU resources
      // still complete through the worker's existing cancellation boundary.
      // A matched end() snapshot retires input ownership even while r.active
      // keeps the last complete pose visible; imperative apply() clears it.
      this.nextGeneration()
      this.pending = undefined; this.pendingDensity = undefined; this.warming = false
      // Completed layers remain reusable. An empty, cancelled plan must not hit
      // the same-document fast return and strand the next real pointer input.
      if (!this.resident.tiles.length) this.closeResidents()
    }
    const idleWarm = this.idleWarmCapture || this.idleWarmWaiting
    if (idleWarm && (!this.sameIdleWarmContext(idleWarm, props, pageId, profile, backend) ||
        !props?.active && !this.resident?.active && settledDocument !== idleWarm.document)) {
      const capture = this.idleWarmCapture
      this.cancelIdleWarmTimer()
      if (capture) {
        this.nextGeneration()
        this.livePending = this.liveRequested = undefined
        this.pending = undefined; this.pendingDensity = undefined
        this.liveCancelled = this.liveDeferred = true
      }
    } else if (props?.active) {
      this.cancelIdleWarmTimer(); this.idleWarmCapture = undefined
    }
    if (cameraChanged && this.resident?.live) {
      if (this.liveRunning || this.livePending) {
        // Active captures have the same camera ownership as idle ones. A
        // completed old crop cannot replace the current pose after zoom/pan.
        // Keep completed pixels while this owner's obsolete work unwinds.
        this.nextGeneration()
        this.livePending = this.liveRequested = undefined
        this.pending = undefined; this.pendingDensity = undefined
        this.liveCancelled = true
      }
      if(this.resident.tiles[0]?.gpuTile)this.sharedClient?.stopResidentInteraction(this.resident.tiles[0].gpuTile)
      this.inlineDisabled=true
      this.resident.captureBounds = undefined
      this.resident.scale = view.zoom * dpr
      this.liveRequested = undefined
    }
    if (this.props?.control !== props?.control && this.props?.control.current === this.control) this.props.control.current = null
    if (this.props?.document !== props?.document) { this.clearPoseFeedback(2); this.retireRecovery(); this.sourceOrder++ }
    const previousFloor=this.completePageOrder
    if (props && settledDocument === props.document) this.completePageOrder = this.sourceOrder
    this.props = props
    if(previousFloor!==this.completePageOrder)this.traceHandoff(2,0)
    if (props) props.control.current = this.control
    if (this.disposed) return
    if (!props) {
      this.nextGeneration(); this.releaseClient(); this.pending = undefined; this.pendingDensity = undefined
      this.closeResidents(); this.warming = false; return
    }
    if (this.sessionEpoch !== props.epoch) {
      this.nextGeneration(); this.releaseClient(); this.pending = undefined; this.pendingDensity = undefined
      this.closeResidents(); this.error = ''; this.sessionEpoch = props.epoch
    }
    if (this.failedGesture) {
      // React updates from ordinary editor.preview must not reclaim the same
      // failed gesture and reapply its retained native pose. Retry only after
      // the gesture ends or its selection/session ownership changes.
      if (props.active && this.resident?.plan.pageId === pageId && this.sameIds(props.selection)) return
      this.failedGesture = false
      this.pending = undefined; this.pendingDensity = undefined
      this.closeResidents(); this.error = ''
    }
    const idle = this.resident
    if(import.meta.env.VITE_DESIGN_NEUTRAL_PAGE_GROUP==='1'&&this.allowIdleWarm&&this.sharedClient&&size&&
        idle?.live&&!props.active&&!idle.active&&!this.handoff&&!this.error&&!this.liveRunning&&!this.livePending&&
        settledDocument===props.document&&idle.plan.document===props.document&&idle.plan.pageId===pageId&&this.sameIds(props.selection)&&
        profile==='figmaSubpixel'&&profile===this.profile&&backend===this.backend&&(backend==='webgpu'||backend==='auto')){
      let cached=this.neutralPageCandidates.get(idle)
      if(cached?.viewportRevision!==this.viewportRevision){
        const pad=128/view.zoom,capture={x:-view.x/view.zoom-pad,y:-view.y/view.zoom-pad,
          width:size.width/view.zoom+2*pad,height:size.height/view.zoom+2*pad}
        let plan=this.layerPlanner.plan(props.document,pageId,props.selection,capture,
          {neutralPageGroup:true,scene:props.scene,epoch:props.epoch})
        if(plan&&!allowsReducedSampling(view.zoom)&&plan.layers.some(layer=>
          layer.bounds.width*layer.bounds.height*(view.zoom*dpr)**2>8_388_608/Math.max(1,plan!.layers.length)))plan=null
        cached={viewportRevision:this.viewportRevision,plan};this.neutralPageCandidates.set(idle,cached)
      }
      if(cached.plan){
        // A temporary live lease installed before canvas readiness must not
        // permanently suppress an eligible independent capture. Promotion is
        // idle-only: the exact page is visible, and no gesture or handoff owns
        // the old pixels. The existing owner-scoped cancellation retires it.
        this.nextGeneration();this.pending=undefined;this.pendingDensity=undefined
        this.livePending=this.liveRequested=undefined;this.closeResidents();this.warming=false
      }
    }
    const r = this.resident, key = props.selection.join(',')
    const samePolicy = profile === this.profile && backend === this.backend
    const handoff = this.handoff
    if (handoff) {
      // end() can run synchronously before React publishes the final document.
      // Do not let that stale props pass revoke the committed handoff fence.
      if (props.document === handoff.previousDocument && props.document !== handoff.document &&
          props.epoch === handoff.epoch && r === handoff.resident && r.plan.pageId === pageId &&
          this.sameIds(props.selection) && samePolicy && !!this.viewport && !cameraChanged &&
          this.viewportRevision === handoff.viewportRevision) return
      const sameHandoff = !!r && r === handoff.resident && props.document === handoff.document &&
        props.epoch === handoff.epoch && r.plan.pageId === pageId && this.sameIds(props.selection) &&
        !!this.viewport && samePolicy && !cameraChanged && this.viewportRevision === handoff.viewportRevision
      if (r && sameHandoff) {
        // ProgressiveSurface supplies fullPlanReady here. Waiting for a later
        // presentation ACK would keep the interaction layer covering that frame.
        if (settledDocument === props.document && r.active) {
          r.active = false; props.onReady()
        }
        // Retain the ownership fence across idle React updates, even after
        // preview retirement. A real apply(), changed authored snapshot or
        // context revokes it; an active no-op click alone needs no recapture.
        return
      }
      this.handoff = undefined
      this.endedDocument = undefined
    }
    if (!props.active && (props.navigating || cameraChanged) && samePolicy && r?.live &&
        r.plan.pageId === pageId && r.plan.document.id === props.document.id && this.sameIds(props.selection)) {
      // A release handoff may keep r.active solely to retain visible pixels.
      // It is not an object gesture and must not recapture every new camera.
      this.cancelIdleWarmTimer(); this.liveDeferred = true
      return
    }
    if(navigationPriority&&!props.active&&(!r?.active||this.endedDocument===props.document)&&
        (props.navigating||performance.now()-this.lastNavigationAt<100)){
      // A cached exact viewport may be ready between wheel samples. That does
      // not make speculative selection capture current visible work. Wait for
      // a quiet camera, retaining completed layers and their source identity.
      this.cancelIdleWarmTimer()
      this.navigationWarmRequest=[props,pageId,view,dpr,profile,backend,settledDocument,size]
      if(this.navigationWarmTimer===undefined){
        const generation=this.generation
        this.navigationWarmTimer=setTimeout(()=>{
          this.navigationWarmTimer=undefined
          const request=this.navigationWarmRequest;this.navigationWarmRequest=undefined
          if(this.disposed||generation!==this.generation||!this.props||this.props.active||!request)return
          this.prepare(...request)
        },Math.max(16,100-(performance.now()-this.lastNavigationAt)))
      }
      return
    }
    if (r?.live && (this.liveCancelled || this.liveDeferred) && props.active && samePolicy && r.plan.pageId === pageId &&
        props.document.id === r.plan.document.id && this.sameIds(props.selection)) {
      // A deferred or cancelled capture has no reusable pixels even when its authored
      // object and density are unchanged. Retry for an active gesture before
      // same-document reuse can hide the interruption. Idle camera preparation
      // must leave the queue to the exact canvas instead of warming a full view.
      r.active = true
      this.liveAuthored = props.document
      const candidate = this.latestPatch?.document === props.document ? this.candidateDocument() : undefined
      this.renderLive(candidate || props.document)
      return
    }
    // Normal/high zoom cannot keep a drag bitmap upscaled by up to 25% after
    // the camera settles. Only the explicitly reduced low-zoom tier retains
    // hysteresis; native tiers refresh whenever their real sampled density
    // falls below the current camera/DPR requirement.
    const requestedScale = view.zoom * dpr
    const needsDensity = !!r && !r.live && requestedScale > (allowsReducedSampling(view.zoom)
      ? (r.requestedScale || r.scale) * 1.25 : r.scale)
    if (!needsDensity) this.pendingDensity = undefined
    const viewport = size ? { x: -view.x / view.zoom, y: -view.y / view.zoom,
      width: size.width / view.zoom, height: size.height / view.zoom } : undefined
    const capture = r?.plan.viewport
    const needsViewport = !!capture && !!viewport && (viewport.x < capture.x || viewport.y < capture.y ||
      viewport.x + viewport.width > capture.x + capture.width || viewport.y + viewport.height > capture.y + capture.height)
    if (r && samePolicy && r.plan.pageId === pageId && this.sameIds(props.selection)) {
      if(props.active&&props.document.id===r.plan.document.id&&!this.samePoseTopology(r.plan,props.document)){
        // A structural pointer preview needs a fresh pose owner immediately.
        // Freeze the last complete capture at its old placement while the new
        // capture is pending; never apply new parent matrices to those pixels.
        const held=r.held||{plan:r.plan,offsets:r.live?r.displayedOffsets:r.offsets,parentLinear:r.parentLinear,visibleBounds:r.visibleBounds,blend:!r.live||!!r.retainedFallback,
          capture:r.overlayCapture,workerPoses:!!r.workerPoses,viewportRevision:this.viewportRevision}
        // The first capture may still be pending when the pointer crosses a
        // parent. Its source pixels nevertheless exist in the settled page.
        // Freeze their erase footprint before replacing the source/scope.
        const original = r.plan.ids.every(id=>r.rootBounds?.has(id))
          ? unionBounds(r.plan.ids.map(id=>r.rootBounds!.get(id)!)) : viewport
        if (original) {
          const halo=16+(r.dependencyPadding||0)
          const erase={x:original.x-halo,y:original.y-halo,width:original.width+2*halo,height:original.height+2*halo}
          r.repairBounds=unionBounds([erase,...(r.repairBounds?[r.repairBounds]:[]),...(r.visibleBounds?[r.visibleBounds]:[])])
        }
        this.nextGeneration();if(r.tiles[0]?.gpuTile)this.sharedClient?.stopResidentInteraction(r.tiles[0].gpuTile)
        this.latestPatch=undefined;this.latestCandidate=undefined;this.patchBase=undefined;this.affineBase=undefined
        this.livePending=undefined;this.liveRequested=undefined;this.pending=undefined;this.pendingDensity=undefined
        r.held=r.tiles.length?held:undefined;r.plan={document:props.document,pageId,ids:[...props.selection],layers:[]}
        r.live=true;r.active=true
        r.offsets=new Map(props.selection.map(id=>[id,{x:0,y:0}]))
        r.workerPoses=false;r.retainedFallback=false;r.displayedOffsets=undefined;r.displayedTransforms=undefined;r.overlayCapture=undefined;r.affinePlan=undefined;r.captureBounds=undefined
        this.inlineDisabled=true
        const entries=props.scene?.entriesFor(props.document,pageId,props.epoch)??scene(props.document,pageId)
        Object.assign(r,buildInteractionDependencyScope(props.document,pageId,entries,props.selection,{zoom:view.zoom,dpr,allowFixedBackdrop:!r.affine}))
        this.liveAuthored=props.document;this.renderLive(props.document);props.onReady();this.changed();return
      }
      if (r.live && props.document.id === r.plan.document.id && (props.active || r.active && settledDocument !== props.document)) {
        r.active = true
        // Imperative pointer updates precede the authored commit. A React
        // repaint must not enqueue the old authored position over newer input.
        if (props.active && (this.liveAuthored !== props.document || cameraChanged)) { this.liveAuthored = props.document; this.renderLive(cameraChanged?(this.candidateDocument()||props.document):props.document) }
        return
      }
      const candidate = r.active && this.latestPatch?.document === props.document ? this.candidateDocument() : undefined
      const offsets = this.baseOffsets(r.plan, candidate || props.document)
      if (this.sharedClient && size && !r.live && r.tiles.length && !props.active &&
          (!r.active || this.endedDocument === props.document) && settledDocument !== props.document &&
          offsets && this.retainedOffsetsReusable(r, offsets)) {
        // Keep completed layers, including a final pose awaiting canvas repair.
        // An optional density/viewport replacement must not restart after its
        // owner was cancelled. A real apply() or a complete canvas can retry.
        r.offsets = offsets; return
      }
      // A page fast-path handover warms the last displayed pose while the
      // authored document remains unchanged. Do not replace that useful warm
      // job with the old authored pose on the next React layout pass.
      if (candidate && r.active && this.pending && !needsDensity && !needsViewport && !cameraChanged) return
      if (!r.live && offsets && !this.retainedOffsetsReusable(r, offsets) && r.tiles.length) {
        this.promoteRetained(candidate || props.document); return
      }
      if (offsets && r.active && settledDocument !== props.document && !needsDensity && !needsViewport) { r.offsets = offsets; return }
      if (r.plan.document === props.document && !needsDensity && !needsViewport) {
        // A boolean/dependency capture may adopt the committed document after
        // end() has run. Even this same-document reuse must retire its preview
        // once the complete page takes over; otherwise Canvas stays "editing".
        if(!props.active&&settledDocument===props.document&&r.active){r.active=false;props.onReady()}
        this.scheduleIdleWarm(); return
      }
      if (offsets && settledDocument === props.document && !needsDensity && !needsViewport && !cameraChanged) {
        // The final pose already owns the right pixels/programs. Publishing the
        // authored translation must not synchronously rebuild scene bounds and
        // warm the same selection again before the committed frame can paint.
        // Keep the original local source and cumulative offsets for a second
        // drag; any content/policy/viewport change still revokes this reuse.
        r.offsets = offsets
        if(r.active){r.active=false;props.onReady()}
        this.liveAuthored = props.document
        this.scheduleIdleWarm()
        return
      }
      if (settledDocument === props.document && r.active) { r.active = false; props.onReady() }
    }
    if (samePolicy && this.pending?.document === props.document && this.pending.pageId === pageId && this.pending.ids === key &&
        (!needsViewport||this.pending.viewportRevision===this.viewportRevision) &&
        (!this.error || this.pending.scale === requestedScale)) {
      // Preserve one useful capture and remember only the latest higher
      // density. Recompiling/cancelling on every small zoom input would turn
      // native-density fidelity into an unbounded warm-up backlog.
      this.pendingDensity = needsDensity && this.pending.scale < requestedScale
        ? [props, pageId, { ...view }, dpr, profile, backend, settledDocument, size && { ...size }]
        : undefined
      return
    }
    this.pendingDensity = undefined
    this.profile = profile; this.backend = backend
    const token = this.nextGeneration()
    if (!this.sharedClient) this.client?.cancelPreview()
    this.pending = { document: props.document, pageId, ids: key, scale: requestedScale,viewportRevision:this.viewportRevision }
    const contentGesture = props.active && (!!r && !this.baseOffsets(r.plan, props.document) || ['rotate', 'scale'].includes(props.gestureKind || ''))
    // Managed layers require linear-light recomposition. The legacy byte
    // presenter leaves that work to the kernel instead of blending sRGB bytes.
    const pad = 128 / view.zoom
    const captureViewport = viewport ? { x: viewport.x - pad, y: viewport.y - pad,
      width: viewport.width + 2 * pad, height: viewport.height + 2 * pad } : undefined
    let plan = contentGesture || props.document.colorManagement && !this.sharedClient
      ? null : this.layerPlanner.plan(props.document, pageId, props.selection, captureViewport,
        {scene:props.scene,epoch:props.epoch,
          neutralPageGroup:import.meta.env.VITE_DESIGN_NEUTRAL_PAGE_GROUP==='1'&&this.allowIdleWarm&&!!this.sharedClient&&
          profile==='figmaSubpixel'&&(backend==='webgpu'||backend==='auto')})
    if(plan&&!allowsReducedSampling(view.zoom)&&plan.layers.some(layer=>
      layer.bounds.width*layer.bounds.height*(view.zoom*dpr)**2>8_388_608/Math.max(1,plan!.layers.length)))plan=null
    // Idle root-layer warming competed with exact viewport repair after every
    // zoom. Install a callable live lease now, but leave capture to the gesture
    // while the current page is incomplete. Nested plans already do this.
    if (plan && this.sharedClient && size && !props.active && !r?.active && settledDocument !== props.document) plan = null
    if (!plan) {
      this.closeResidents(); this.warming = false
      // Dependency-sensitive/nested selections keep the complete kernel scene.
      // Coalesce input, but present every completed interaction sample instead
      // of cancelling it on the next pointer move and starving the display.
      if (props.selection.length && props.selection.every(id => props.document.nodes[id])) {
        // Live captures use liveRunning/livePending, not the independent-layer
        // marker. A stale marker here blocked a fresh scope after undo. Keep
        // the no-selection marker below to deduplicate idle notifications.
        this.pending=undefined;this.pendingDensity=undefined
        const livePlan = { document: props.document, pageId, ids: [...props.selection], layers: [] }
        this.resident = { plan: livePlan, tiles: [], scale: view.zoom * dpr,
          offsets: interactionOffsets(livePlan, props.document)!, active: props.active, live: true,
          affine: ['rotate', 'scale'].includes(props.gestureKind || '') }
        // Borrow only current Canvas geometry under its original slot/scope
        // guards. No cache is created for mutable or standalone callers.
        const entries = props.scene?.entriesFor(props.document, pageId, props.epoch) ?? scene(props.document, pageId)
        Object.assign(this.resident, buildInteractionDependencyScope(props.document, pageId, entries,
          props.selection, { zoom: view.zoom, dpr, allowFixedBackdrop: import.meta.env.VITE_DESIGN_LOCAL_BACKDROP !== '0' }))
        this.liveAuthored = props.document
        this.error = ''; props.onReady()
        // Navigation temporarily removes interaction props and recreates this
        // resident when it settles. Install its control/scope now, but give the
        // exact canvas the queue until an actual gesture needs live pixels.
        if (props.active) this.renderLive(props.document)
        else { this.liveDeferred = true; this.scheduleIdleWarm() }
      } else { this.releaseClient() }
      props.onReady(); this.changed(); return
    }
    // Incompatible edits must never display a stale moved layer. Ordinary
    // exact page residents remain underneath while a new selection warms.
    if (!r || !this.baseOffsets(r.plan, props.document) || !this.sameIds(props.selection)) this.closeResidents()
    this.resident ??= { plan, tiles: [], scale: view.zoom * dpr,
      offsets: interactionOffsets(plan, props.document)!, active: false, parentLinear: plan.parentLinear }
    props.onReady()
    this.warming = true; this.error = ''
    const current = () => !this.disposed && this.generation === token
    this.client ??= this.sharedClient || new KernelClient()
    const client = this.client, tiles: CompositeTile[] = []
    const signal = this.sharedClient ? this.captureAbort.signal : undefined
    let backgroundLinear:KernelResult['backgroundLinear']
    let accepted=false, rebase:DesignDocument|undefined
    void (async () => {
      try {
        // 8M pixels across all intervals; replacement may temporarily retain
        // another set. This is separate from the viewport tile budget.
        const pixelsPerLayer = 8_388_608 / Math.max(1, plan.layers.length)
        for (const [index, layer] of plan.layers.entries()) {
          if (!current()) return
          const b = layer.bounds
          const reduced=allowsReducedSampling(view.zoom)
          let scale = reduced ? Math.min(view.zoom * dpr, 8192 / Math.max(b.width, b.height),
            Math.sqrt(pixelsPerLayer / Math.max(1, b.width * b.height))) : view.zoom*dpr
          const targetScale=scale
          let phaseX=0,phaseY=0
          let width = 1, height = 1, originX = 0, originY = 0, result: KernelResult | undefined
          for (let attempt = 0; attempt < 5 && current(); attempt++) {
            // Low zoom permits a budget fallback, but does not imply that
            // this capture was reduced. At actual DPR keep the page lattice;
            // otherwise stationary text gets filtered a second time on place.
            const nativeDensity=scale===view.zoom*dpr
            phaseX=nativeDensity?view.x*dpr-Math.floor(view.x*dpr):0
            phaseY=nativeDensity?view.y*dpr-Math.floor(view.y*dpr):0
            originX = Math.floor(b.x * scale+phaseX); originY = Math.floor(b.y * scale+phaseY)
            width = Math.max(1, Math.ceil((b.x + b.width) * scale+phaseX) - originX)
            height = Math.max(1, Math.ceil((b.y + b.height) * scale+phaseY) - originY)
            try {
              result = await client.render(layer.document, { pageId, width, height,
                gpuRoots: layer.roots,
                view: { x: -originX + phaseX, y: -originY + phaseY, zoom: scale },
                interactionOwner: this.interactionOwner, interactionGeneration: token, interactionBranch: 1,
                transparent: true, grid: false, rasterProfile: profile, livePreview: true, renderIntent: 'preview', interactionChannel: !!this.sharedClient,
              }, false, backend, !this.sharedClient, false, undefined, undefined, signal)
              break
            } catch (error) {
              // Read-only transient rasterization: bounded resolution reduction
              // handles effect intermediates, not just output bitmap area.
              if (!reduced || attempt === 4 || !/PREVIEW_BUDGET|GPU.*(?:budget|预算)/i.test(String(error))) throw error
              if(import.meta.env.DEV)console.debug('[interaction-budget]',JSON.stringify({scale,reason:String(error)}))
              scale = targetScale * [.7,.5,.25,.125][attempt]
            }
          }
          if (!current()) {result?.bitmap?.close();if(result?.gpuTile)this.sharedClient?.releasePresented([result.gpuTile]);return}
          if (!result) throw Error('交互图层未能完成渲染')
          backgroundLinear=result.backgroundLinear
          // Straight RGBA is intentional for isolated source-over layers.
          result.bitmap?.close()
          if (!current()) return
          if (!result.gpuTile && result.bytes.length !== width * height * 4) throw Error('交互图层像素不完整')
          tiles.push({ key: `interaction:${token}:${index}`, serial: serial--,
            x: originX, y: originY, width, height, zoom: scale, phaseX, phaseY, bytes: result.bytes, gpuTile: result.gpuTile })
        }
        if (!current()) return
        const candidate=this.resident?.active?this.candidateDocument():undefined
        const latestPatch=this.latestPatch
        const offsets=interactionOffsets(plan,candidate||this.props!.document)
        if (!offsets) return
        const active = !!this.resident?.active
        const keepFeedback=active&&!!latestPatch&&latestPatch.document===this.liveAuthored&&
          !!this.resident&&this.desktopRetainedTranslation(this.resident)
        this.closeResidents(keepFeedback)
        this.resident = { plan, tiles, offsets, scale: Math.min(...tiles.map(tile=>tile.zoom)),requestedScale:view.zoom*dpr,active,backgroundLinear,parentLinear:plan.parentLinear }
        if (!this.retainedOffsetsReusable(this.resident, offsets)) {
          this.resident.offsets = new Map(plan.ids.map(id => [id, { x: 0, y: 0 }]))
          rebase = candidate || this.props!.document
        } else this.lastPresentedInput = this.lastInput
        this.poseEvent(2,0,0,3)
        accepted=true
        this.latestCandidate=candidate; this.latestPatch=latestPatch
        this.warming = false; this.props?.onReady(); this.changed()
      } catch (error) {
        if (!current()) return
        this.warming = false; this.error = String(error); this.props?.onReady(); this.changed()
      } finally {
        if(!accepted){for(const tile of tiles)tile.bitmap?.close();this.sharedClient?.releasePresented(tiles.flatMap(tile=>tile.gpuTile?[tile.gpuTile]:[]))}
        if (current()) {
          // A prepared interaction must not occupy the second raster GPU slot
          // indefinitely and starve image export/prototype clients.
          if (client !== this.sharedClient) client.dispose(); this.client = null
          if (!this.error) this.pending = undefined
          const refresh = this.pendingDensity
          this.pendingDensity = undefined
          // A failure applies to the attempted density, not a newer request
          // already waiting behind it. Consume that request once; an unchanged
          // failed signature remains latched until the user changes input.
          if (refresh) this.prepare(...refresh)
          else if (!this.error && rebase) this.promoteRetained(rebase)
        }
      }
    })()
  }

  items(view: CanvasCamera): CompositeItem[] | null {
    const r = this.resident
    if (!r?.active || !r.tiles.length) return null
    if (r.live && !r.retainedFallback && !r.held?.blend && (r.sampleOrder ?? -1) < this.completePageOrder) { this.traceHandoff(6,4,r.sampleOrder);return null }
    return r.tiles.map((tile, i) => {
      const offsets = r.held?r.held.offsets:r.retainedFallback ? r.displayedOffsets : r.offsets
      const moving=r.held?r.held.blend&&r.held.plan.layers[i]?.moving:(!r.live || r.retainedFallback) && r.plan.layers[i]?.moving
      const local=moving ? offsets?.get(moving) : undefined, parent=moving && (r.held?r.held.parentLinear:r.parentLinear)?.get(moving)
      const offset=local&&parent ? {x:parent[0]*local.x+parent[2]*local.y,y:parent[1]*local.x+parent[3]*local.y} : local
      const scale = view.zoom / tile.zoom
      const clip=r.held?r.held.blend?undefined:r.held.visibleBounds:r.live&&!r.retainedFallback?r.visibleBounds:undefined
      return { tile, active: true, layer: i, gutter: tile.gutter ?? 0, blend: r.held?r.held.blend:!r.live || !!r.retainedFallback,
        ...(clip ? {clip:{left:clip.x*view.zoom+view.x,top:clip.y*view.zoom+view.y,width:clip.width*view.zoom,height:clip.height*view.zoom}} : {}),
        placement: { ...tilePlacementAtView(tile,view),
          left: (tile.x-(tile.phaseX||0)) * scale + view.x + (offset?.x || 0) * view.zoom,
          top: (tile.y-(tile.phaseY||0)) * scale + view.y + (offset?.y || 0) * view.zoom } }
    })
  }
  capturedOverlay(document:DesignDocument,pageId:string,epoch:number,commands:CanvasOverlay,uiIdentity?:string):{commands?:CanvasOverlay;cohort?:OverlayCaptureCohort;overlayPoseSlot?:number}|undefined {
    const r=this.resident,capture=r?.overlayCapture,props=this.props,owners=commands.selection?.owners
    if(r?.held){
      const held=r.held,old=held.capture
      // Structural movement retains an entire old capture, including its own
      // chrome. Its stopped worker slot supplies the last compiled parent basis;
      // no geometry from the new parent may be projected onto these pixels.
      if(this.disposed||this.error||!this.sharedClient||!r.active||r.affine||held.blend||!old?.overlay||!props||
          !uiIdentity||old.overlay.uiIdentity!==uiIdentity||props.document!==document||document.id!==old.document.id||
          props.epoch!==epoch||this.sessionEpoch!==epoch||old.epoch!==epoch||old.pageId!==pageId||r.plan.pageId!==pageId||
          this.viewportRevision!==held.viewportRevision||!this.sameIds(props.selection)||
          !owners||owners.length!==old.ids.size||new Set(owners).size!==owners.length||owners.some(id=>!old.ids.has(id))||
          r.tiles!==old.tiles||!r.tiles.length||r.tiles.some((tile,i)=>!tile.gpuTile||tile.gpuTile!==old.slots[i])||
          (props.active?props.gestureKind!=='move':!this.endedMove||this.endedDocument!==document))return {}
      return {commands:old.overlay.commands,cohort:old.cohort,...(held.workerPoses?{overlayPoseSlot:old.slots[0]}:{})}
    }
    // Undefined means this is not a capture-owned path. An empty resolution
    // means the capture owns chrome but proof failed: the caller must keep DOM
    // visible, not retry a geometry-only fallback over the same old pixels.
    if(!r?.live||r.retainedFallback||r.workerPoses&&(r.affine||this.inlineDisabled))return undefined
    const unavailable = {}
    // Inline programs still require worker-side pose/session proof.
    if(this.disposed||this.error||!r.active||!capture||!props||!uiIdentity||
        props.document!==document||props.epoch!==epoch||this.sessionEpoch!==epoch||
        capture.epoch!==epoch||capture.pageId!==pageId||r.plan.pageId!==pageId||
        !this.sameIds(props.selection,true)||!owners||owners.length!==capture.ids.size||new Set(owners).size!==owners.length||
        owners.some(id=>{this.overlayWork.ownerMembershipChecks++;return !capture.ids.has(id)})||
        r.tiles!==capture.tiles||!r.tiles.length||r.tiles.some((tile,i)=>!tile.gpuTile||tile.gpuTile!==capture.slots[i])||
        capture.generation!==this.generation&&!(capture.handoffGeneration===this.generation&&this.handoff?.resident===r)||
        props.gestureKind==='resize'||props.active&&!['move','rotate','scale'].includes(props.gestureKind||'')||
        !props.active&&this.handoff?.resident!==r)return unavailable
    // A new C capture has no authority to retain S commands. Without C's own
    // Canvas snapshot, no whole-document transform proof can make it usable.
    if(document!==capture.document&&!capture.overlay)return unavailable
    capture.geometryValid??=this.overlayGeometryValid(r.plan,capture.document)
    if(!capture.geometryValid)return unavailable
    if(capture.checkedDocument!==document){
      capture.checkedDocument=document
      capture.checkedValid=document===capture.document?true:this.overlayGeometryValid(r.plan,document)
    }
    if(!capture.checkedValid)return unavailable
    // Canvas memoizes an immutable command object. Snapshot at most once per
    // exact producer object/UI context, not once per compositor repaint.
    if(document===capture.document){
      if(capture.overlay?.sourceCommands!==commands||capture.overlay.uiIdentity!==uiIdentity){
        capture.overlay={uiIdentity,sourceCommands:commands,commands:structuredClone(commands)}
        this.overlayWork.snapshotCopies++
      }else this.overlayWork.snapshotReuses++
    }
    // The compiler-owned slot, rather than the latest pointer or main-thread
    // ACK, determines the actual pose. A missing worker basis clears chrome.
    // Affine/AABB changes remain excluded by the checks above.
    return capture.overlay?.uiIdentity===uiIdentity ? {commands:capture.overlay.commands,cohort:capture.cohort,
      ...(r.workerPoses?{overlayPoseSlot:capture.slots[0]}:{})} : unavailable
  }

  overlay(overlay:CanvasOverlay):CanvasOverlay|undefined {
    const r=this.resident
    if(r?.held)return undefined
    if(!r?.active||!overlay.transforms)return overlay
    // The GPU worker applies the last completed pose, not the latest pointer
    // input, for an inline live scene.
    if(r.live&&r.workerPoses)return overlay
    if (r.live && r.affine && r.displayedTransforms) {
      const matrices = interactionPoseMatrices(overlay.transforms, r.displayedTransforms, r.parentMatrices)
      return matrices ? transformOverlay(overlay, matrices) : undefined
    }
    const source=interactionPatchedOffsets(r.plan,r.plan.document,Object.fromEntries(Object.entries(overlay.transforms).map(([id,transform])=>[id,{transform}])))
    const actual=r.live?r.displayedOffsets:r.offsets
    if(!source||!actual)return undefined
    const offsets=new Map<string,{x:number;y:number}>()
    for(const [id,p] of actual){const base=source.get(id)||{x:0,y:0},m=r.parentLinear?.get(id)||[1,0,0,1],x=p.x-base.x,y=p.y-base.y
      offsets.set(id,{x:m[0]*x+m[2]*y,y:m[1]*x+m[3]*y})}
    return translateOverlay(overlay,offsets)
  }
  get tiles() { return this.resident?.tiles || [] }
  get holdingReleasedMove() { return this.endedMove&&!!this.endedDocument&&!!this.resident?.active&&!this.resident.affine }
  get holdingMoveCapture() {
    const r=this.resident
    return !this.error&&!!r?.live&&r.active&&!r.affine&&!!this.props?.active&&this.props.gestureKind==='move'&&
      (!r.tiles.length||!!r.held)
  }
  get ready() { return !!this.resident?.tiles.length }
  get mode() { return this.resident?.live && !this.resident.retainedFallback && !this.resident.held?.blend ? 'live-kernel' : 'retained-layers' }
  get presentedInput() { return this.resident?.live ? this.lastPresentedInput : this.lastInput }
  get backgroundLinear(){return this.resident?.backgroundLinear}
  /** Only the compositor's owner-validated presented-frame acknowledgement
   * may advance DOM feedback. Native sampling completion alone is insufficient. */
  private feedbackOwner(document: DesignDocument) {
    let owner = this.feedbackOwners.get(document)
    if (!owner) { owner = {}; this.feedbackOwners.set(document, owner) }
    return owner
  }

  acceptPresentedInput(sequence: number, at = performance.now(), ownerMatches=true, framePresented=true, presentedSlots?: readonly number[]) {
    // A retired gesture stays retired even when its capture is also frozen.
    // Keep the terminal reason distinct from a temporarily held live capture.
    if(this.disposed||!this.resident?.active||sequence<=this.poseEndedThrough){this.poseEvent(4,6,sequence);return}
    if(this.resident?.held || this.resident?.live && this.inlineDisabled){this.poseEvent(4,9,sequence);return}
    if(!framePresented){this.poseEvent(4,4,sequence);return}
    this.poseEvent(3,0,sequence)
    if(!ownerMatches){this.poseEvent(4,1,sequence);return}
    if(presentedSlots && this.resident && (!this.resident.tiles.length ||
        this.resident.tiles.some(tile=>!tile.gpuTile || !presentedSlots.includes(tile.gpuTile)))) {
      this.poseEvent(4,9,sequence);return
    }
    this.acceptSampledInput(sequence,at)
  }

  private acceptSampledInput(sequence:number,at:number) {
    const owner=this.liveAuthored&&this.feedbackOwner(this.liveAuthored)
    const status=this.poseFeedback.status(sequence,owner)
    // Preserve the previous consumption order for owner-valid frame ACKs.
    // New owner/no-frame observations must never consume feedback.
    const reason=this.disposed||!this.resident?.active||sequence<=this.poseEndedThrough?6:this.error?5:
      !this.liveAuthored||!this.props?11:sequence<=this.poseRetiredThrough?this.poseRetiredReason:status
    if (!reason && sequence > this.lastPresentedInput.sequence) {
      // The frame is owner-validated, but its sampled pose has not arrived.
      // Never advance feedback from this ACK alone; sampling rechecks every
      // ordinary retirement/document/sequence gate before consuming it.
      if (!this.pendingPresentedInput || sequence > this.pendingPresentedInput.sequence)
        this.pendingPresentedInput={sequence,at,generation:this.generation,resident:this.resident!,owner:owner!,slot:this.resident!.tiles[0]?.gpuTile}
      return
    }
    const offset=this.poseFeedback.present(sequence,owner)
    if(reason||!offset){this.poseEvent(4,reason||3,sequence);return}
    if(this.pendingPresentedInput && this.pendingPresentedInput.sequence<=sequence)this.pendingPresentedInput=undefined
    this.poseEvent(8,0,sequence)
    this.props!.onPosePresented?.({ sequence, offset, document: this.liveAuthored!, epoch: this.props!.epoch, control:this.control, latencyMs: Math.max(0, performance.now() - at) })
  }

  acceptResidentSample(sample:{slot:number;sequence:number;at:number;guides?:InteractionInput['guides'];total?:number;compileMs?:number;nativePose?:boolean;graphMs?:number;finishMs?:number;groupHits?:number;sceneUpdateBytes?:number;geometryUploadBytes?:number;residentProgramHits?:number;residentProgramHitBytes?:number;posePrepareMs?:number;documentMs?:number;translationMs?:number;patchSession?:boolean;affectedNodes?:number;passTimings?:unknown[];compileStats?:Record<string,unknown>;fieldUploadBytes?:number;groupBytes?:number;prefixHits?:number;fieldHits?:number;checkpointMs?:number;fieldMs?:number;drawCalls?:number;passPixels?:number;textureBytes?:number;bounds?:Bounds;needsRebase?:boolean;expandCapture?:boolean;signature?:string}, accepted?:()=>void) {
    const resident=this.resident
    if(this.disposed||!resident?.live||resident.held||this.inlineDisabled||!resident.workerPoses||resident.tiles[0]?.gpuTile!==sample.slot){this.poseEvent(4,this.disposed?6:9,sample.sequence);return}
    this.poseEvent(2,0,sample.sequence,1)
    if(sample.needsRebase){
      this.poseEvent(4,10,sample.sequence)
      if(this.inlineDisabled)return
      this.inlineDisabled=true;if(sample.expandCapture!==true)resident.captureBounds=undefined;this.liveRequested=undefined
      this.renderLive(this.candidateDocument()||this.props!.document);return
    }
    if(sample.sequence>this.lastInput.sequence||sample.sequence<=this.lastPresentedInput.sequence){this.poseEvent(4,7,sample.sequence);return}
    this.lastPresentedInput={sequence:sample.sequence,at:sample.at,guides:sample.guides}
    const sampleOrder=this.poseOrders.get(sample.sequence)
    if(sampleOrder!==undefined)resident.sampleOrder=sampleOrder
    for(const sequence of this.poseOrders.keys())if(sequence<=sample.sequence)this.poseOrders.delete(sequence)
    // Update presentation dedup only after this owner accepts the sample and
    // before notifying chrome/repainting. Rejected late samples have no say.
    accepted?.()
    const pending=this.pendingPresentedInput
    if(pending && sample.sequence>=pending.sequence){
      this.pendingPresentedInput=undefined
      if(sample.sequence===pending.sequence && sample.slot===pending.slot && pending.generation===this.generation && pending.resident===resident &&
          this.liveAuthored && pending.owner===this.feedbackOwner(this.liveAuthored))
        this.acceptSampledInput(pending.sequence,pending.at)
    }
    if(sample.bounds)resident.visibleBounds=sample.bounds
    this.samples++;this.lastSampleMs=sample.total||0;this.lastSampleCompileMs=sample.compileMs||0;this.lastSampleGraphMs=sample.graphMs||0
    this.lastSampleReused=!sample.nativePose;this.lastSampleLoadMs=0;this.lastSampleGroupHits=sample.groupHits||0
    if(this.tracing){this.sampleTrace.push({total:this.lastSampleMs,prepare:0,load:0,compile:this.lastSampleCompileMs,graph:this.lastSampleGraphMs,
      finish:sample.finishMs||0,reused:this.lastSampleReused,active:!!this.props?.active,backend:'webgpu',scale:resident.scale,
      sceneUpdateBytes:sample.sceneUpdateBytes,geometryUploadBytes:sample.geometryUploadBytes,residentProgramHits:sample.residentProgramHits,residentProgramHitBytes:sample.residentProgramHitBytes,posePrepareMs:sample.posePrepareMs,documentMs:sample.documentMs,translationMs:sample.translationMs,patchSession:sample.patchSession,affectedNodes:sample.affectedNodes,passTimings:sample.passTimings,compileStats:sample.compileStats,fieldUploadBytes:sample.fieldUploadBytes,
      groupBytes:sample.groupBytes,prefixHits:sample.prefixHits,fieldHits:sample.fieldHits,checkpointMs:sample.checkpointMs,fieldMs:sample.fieldMs,drawCalls:sample.drawCalls,passPixels:sample.passPixels,textureBytes:sample.textureBytes})
      if(this.sampleTrace.length>120)this.sampleTrace.shift()}
    this.changed()
  }
  private traceHandoff(decision:number,reason:number,sampleOrder?:number,generation=this.generation) {
    this.handoffTrace.record(decision,reason,{interactionOwner:this.interactionOwner,interactionGeneration:generation,
      handoffGesture:gestureCode(this.props?.gestureKind),handoffActive:Number(!!this.props?.active),
      handoffSourceOrder:this.sourceOrder,handoffFloor:this.completePageOrder,
      handoffSampleKnown:Number(sampleOrder!==undefined),handoffSampleOrder:Math.max(0,sampleOrder??0)})
  }
  private renderLive(document: DesignDocument, order = this.sourceOrder) {
    const handoff = this.handoff
    if (handoff && handoff.resident === this.resident && handoff.document === document) return
    if (this.liveRequested === document && this.liveRequestedOrder === order) return
    this.liveRequestedOrder = order; this.livePendingOrder = order
    this.liveRequested = document; this.livePending = document
    this.liveCancelled = false
    this.liveDeferred = false
    if (this.liveRunning) return
    this.liveRunning = true
    const token = this.generation, resident = this.resident!, captureViewport = this.viewportRevision
    const signal = this.sharedClient ? this.captureAbort.signal : undefined
    const current = () => !this.disposed && token === this.generation && this.resident === resident && captureViewport === this.viewportRevision
    let captureSerial = this.recoverySerial, captureHadScope = !!this.recoveryScope
    let captureCause:FailedCaptureCause|undefined, causePhase=0, causeAttempt=0, causeBranch=0
    void (async () => {
      try {
        while (current() && this.livePending) {
          captureCause=undefined;causePhase=0;causeAttempt=0;causeBranch=0
          captureSerial = this.recoverySerial; captureHadScope = !!this.recoveryScope
          const started = performance.now()
          const viewportRevision = this.viewportRevision
          const document = this.pendingLiveDocument()!, sampleOrder = this.livePendingOrder; this.livePending = undefined
          this.traceHandoff(3,0,sampleOrder,token)
          // A capture of an authored baseline is not the latest pointer pose.
          // Never acknowledge a newer input that merely arrived during setup.
          const input = this.inputs.get(document) || { sequence: 0, at: 0 }
          // Freeze the actual consumed input before any preparation or await.
          captureCause=this.poseLog.enabled?captureFailureCause(input.sequence,token,this.props?.epoch??0,this.poseActions.fields(input.sequence)):undefined
          causePhase=1;causeAttempt=0;causeBranch=0
          const offsets = interactionOffsets(resident.plan, document)
          const capturedCommands=this.captureMoveOverlay(document,resident,offsets)
          const roots = resident.rootBounds
          const foregroundSafe = guardedForegroundSafe(resident.foregroundExclusions,roots,resident.plan.ids,
            offsets,resident.parentLinear,resident.scale)
          if (resident.foregroundExclusions && foregroundSafe !== resident.foregroundCaptureBounds) {
            resident.captureBounds = undefined; resident.foregroundCaptureBounds = foregroundSafe
          }
          let bounds = this.viewport ? { x: -this.viewport.view.x / this.viewport.view.zoom,
            y: -this.viewport.view.y / this.viewport.view.zoom, width: this.viewport.width / this.viewport.view.zoom,
            height: this.viewport.height / this.viewport.view.zoom } : offsets && roots && resident.plan.ids.every(id => roots.has(id))
            ? unionBounds([...roots].map(([id, b]) => ({ ...b, x: b.x + (offsets.get(id)?.x || 0), y: b.y + (offsets.get(id)?.y || 0) })))
            : unionBounds(scene(document, resident.plan.pageId).map(e => e.bounds))
          const pad = this.viewport ? 16 : Math.max(16, ...Object.values(document.nodes).flatMap(n => n.effects.filter(e => e.visible)
            .map(e => e.radius * 3 + Math.abs(e.x || 0) + Math.abs(e.y || 0) + Math.abs(e.spread || 0))))
          const rotationBounds=this.viewport&&resident.affine&&!resident.foregroundExclusions?rigidInteractionCapture(resident.plan,document,roots,
            resident.localizedBounds,resident.fixedBounds,resident.parentMatrices,resident.scale):undefined
          if(rotationBounds){
            const x=Math.max(bounds.x,rotationBounds.x-pad),y=Math.max(bounds.y,rotationBounds.y-pad)
            const right=Math.min(bounds.x+bounds.width,rotationBounds.x+rotationBounds.width+pad)
            const bottom=Math.min(bounds.y+bounds.height,rotationBounds.y+rotationBounds.height+pad)
            if(right>x&&bottom>y)bounds={x,y,width:right-x,height:bottom-y}
          }
          if (this.viewport && !resident.affine && foregroundSafe && offsets && roots && resident.plan.ids.every(id => roots.has(id))) {
            // Re-render the swept selection plus its backdrop dependency halo.
            // Unaffected pixels continue using the settled resident tile stack.
            const affected = unionBounds(resident.plan.ids.flatMap(id => {
              const source=roots.get(id)!, local=offsets.get(id) || {x:0,y:0},m=resident.parentLinear?.get(id)||[1,0,0,1]
              const offset={x:m[0]*local.x+m[2]*local.y,y:m[1]*local.x+m[3]*local.y}
              return resident.fixedBounds?.has(id) ? [source] : [source,{...source,x:source.x+offset.x,y:source.y+offset.y}]
            }))
            const halo=pad+(resident.dependencyPadding || 0)
            const x=Math.max(bounds.x,affected.x-halo),y=Math.max(bounds.y,affected.y-halo)
            const right=Math.min(bounds.x+bounds.width,affected.x+affected.width+halo),bottom=Math.min(bounds.y+bounds.height,affected.y+affected.height+halo)
            if(right>x&&bottom>y)bounds={x,y,width:right-x,height:bottom-y}
          }
          if (this.viewport && resident.active && !resident.retainedFallback && (resident.visibleBounds || resident.repairBounds)) {
            // A structural rebase can replace the pose's source document while
            // the settled page still contains the gesture's original pixels.
            // Keep repairing the previously displayed footprint too; shrinking
            // to only the latest local source exposes old text/shapes below it.
            const prior=unionBounds([...(resident.visibleBounds?[resident.visibleBounds]:[]),...(resident.repairBounds?[resident.repairBounds]:[])]),view=this.viewport
            const x=Math.max(-view.view.x/view.view.zoom,Math.min(bounds.x,prior.x))
            const y=Math.max(-view.view.y/view.view.zoom,Math.min(bounds.y,prior.y))
            const right=Math.min((view.width-view.view.x)/view.view.zoom,Math.max(bounds.x+bounds.width,prior.x+prior.width))
            const bottom=Math.min((view.height-view.view.y)/view.view.zoom,Math.max(bounds.y+bounds.height,prior.y+prior.height))
            if(right>x&&bottom>y)bounds={x,y,width:right-x,height:bottom-y}
          }
          // Keep a stable capture coordinate system through a gesture. Even
          // sub-ulp differences from regrouping bounds used to change the
          // compile key on the first move; root motion near a page edge also
          // needs a small guard before expanding/recompiling the capture.
          let b = resident.captureBounds
          const epsilon = Math.max(1, bounds.width, bounds.height) * 1e-9
          if (!b || bounds.x - pad < b.x - epsilon || bounds.y - pad < b.y - epsilon ||
              bounds.x + bounds.width + pad > b.x + b.width + epsilon || bounds.y + bounds.height + pad > b.y + b.height + epsilon) {
            // The proven final foreground needs only a short movement reserve.
            // The complete old/new footprint and semantic pad remain in bounds;
            // leaving this reserve still expands and recompiles the capture.
            const finalForeground = !!(this.viewport && offsets && resident.finalForeground)
            const localizedDesktop = !!(this.viewport && this.allowIdleWarm && this.sharedClient &&
              this.profile === 'figmaSubpixel' && resident.plan.ids.every(id => resident.localizedBounds?.has(id) && !resident.fixedBounds?.has(id)))
            const shortTravel = this.profile === 'analytic' && resident.plan.ids.every(id => resident.shortTravelBounds?.has(id))
            let guard = shortTravel && this.viewport ? pad + Math.max(16 / this.viewport.view.zoom, bounds.width * .05, bounds.height * .05) :
              finalForeground ? pad + Math.max(32 / this.viewport!.view.zoom, bounds.width * .05) :
              localizedDesktop ? pad + Math.max(48 / this.viewport!.view.zoom, bounds.width * .05, bounds.height * .05) :
              pad + Math.max(64, this.viewport ? 96 / this.viewport.view.zoom : 0, bounds.width * .05, bounds.height * .05)
            if (!finalForeground && !localizedDesktop && !shortTravel && this.viewport && resident.plan.ids.every(id => resident.localizedBounds?.has(id))) {
              const travelGuard = Math.max(guard, pad + 256 / this.viewport.view.zoom)
              if ((bounds.width + 2 * travelGuard) * (bounds.height + 2 * travelGuard) * resident.scale ** 2 <= 4_194_304)
                guard = travelGuard
            }
            b = resident.captureBounds = expandedInteractionCapture(b, { x: bounds.x - guard, y: bounds.y - guard, width: bounds.width + guard * 2, height: bounds.height + guard * 2 }, resident.scale)
          }
          const reduced=allowsReducedSampling(this.qualityZoom)
          // Gesture-time adaptive density (strict opt-in): a still-moving
          // capture above the pixel budget rasterizes at the Figma-viewer
          // stepped density instead of full zoom*DPR. Settled exact tiles and
          // the low-zoom reduced tier are unchanged.
          const gestureScale = interactionAdaptiveScale(resident.scale, b, this.props?.active === true, reduced)
          const adaptive = gestureScale !== resident.scale
          if(!adaptive && !reduced && b.width*b.height*resident.scale**2>8_000_000){
            // Spend the native pixel budget on visible output, not speculative
            // movement guard. A later pose can expand/rebase the exact capture.
            const area=8_000_000/resident.scale**2
            const guard=Math.max(0,Math.min(pad,(-(bounds.width+bounds.height)+Math.sqrt((bounds.width-bounds.height)**2+4*area))/4))
            b=resident.captureBounds={x:bounds.x-guard,y:bounds.y-guard,width:bounds.width+2*guard,height:bounds.height+2*guard}
          }
          let scale = reduced ? Math.min(resident.scale, 8192 / Math.max(1, b.width, b.height),
            Math.sqrt(4_194_304 / Math.max(1, b.width * b.height))) : gestureScale
          const targetScale=scale
          this.lastSamplePrepareMs = performance.now() - started
          let result: KernelResult | undefined, width = 1, height = 1, originX = 0, originY = 0, phaseX = 0, phaseY = 0
          let capturedTiles: CompositeTile[] | undefined
          this.client ??= this.sharedClient || new KernelClient()
          const client = this.client
          for (let attempt = 0; attempt < 5 && current(); attempt++) {
            causeAttempt=attempt+1;causePhase=1;causeBranch=0
            // Capture on the world pixel lattice. A fractional capture origin
            // adds a second resampling phase when the final pose joins the page.
            originX = Math.floor(b.x * scale); originY = Math.floor(b.y * scale)
            width = Math.max(1, Math.ceil((b.x + b.width) * scale) - originX)
            height = Math.max(1, Math.ceil((b.y + b.height) * scale) - originY)
            b = resident.captureBounds = { x: originX / scale, y: originY / scale, width: width / scale, height: height / scale }
            // HQ resolve also has screen-anchored byte dithering. Use the
            // settled tile compiler/camera instead of relocating a whole
            // resolved snapshot or applying an unscaled interaction window.
            if(this.sharedClient && this.profile==='figma')resident.tiledExact=true
            const renderTiles = async () => {
              causePhase=1;causeBranch=2
              // Use the settled canvas's computation camera too. Re-anchoring
              // exact geometry at the capture origin changes floating-point
              // operation order, even if the final world position is identical.
              const raster=this.viewport?canvasRasterPlan(this.viewport.view,scale/this.viewport.view.zoom,
                this.viewport.width,this.viewport.height,{rasterProfile:this.profile,samplingScale:scale,exactPhase:!reduced}):
                {camera:{x:0,y:0,zoom:scale},phase:{x:0,y:0}}
              const plan=interactionCaptureTiles(originX,originY,width,height,scale).map(tile=>({...tile,
                phaseX:raster.phase.x,phaseY:raster.phase.y})), staged:CompositeTile[]=[]
              try {
                causePhase=2;causeBranch=2
                const result=await client.render(document,{pageId:resident.plan.pageId,width,height,
                  view:raster.camera,transparent:false,grid:false,rasterProfile:this.profile,
                  interactionOwner:this.interactionOwner,interactionGeneration:token,interactionBranch:2,
                  livePreview:true,renderIntent:'preview',interactionChannel:!!this.sharedClient,
                  tileViewport:plan,tilePrepareViewport:{x:originX+Math.floor(raster.camera.x)-1,
                    y:originY+Math.floor(raster.camera.y)-1,w:width+2,h:height+2}},
                  false,this.backend,false,false,undefined,tile=>{
                    staged.push({...tile,serial:serial--})
                  }, signal)
                causePhase=3
                if(!current())throw Error('PREVIEW_CANCELLED')
                if(staged.length!==plan.length)throw Error('Incomplete exact interaction tile group')
                capturedTiles=staged
                return result
              } catch(error) {
                for(const tile of staged)tile.bitmap?.close()
                client.releasePresented(staged.flatMap(tile=>tile.gpuTile?[tile.gpuTile]:[]))
                throw error
              }
            }
            try {
              if(resident.tiledExact){result=await renderTiles();break}
              const nativeDensity = scale === resident.scale && !adaptive
              const localNativePose = reduced && nativeDensity && resident.plan.ids.every(id=>resident.shortTravelBounds?.has(id)) &&
                import.meta.env.VITE_DESIGN_LOW_ZOOM_NATIVE_POSE !== '0'
              const canonical=this.viewport?canvasRasterPlan(this.viewport.view,scale/this.viewport.view.zoom,
                this.viewport.width,this.viewport.height,{rasterProfile:this.profile,samplingScale:scale,exactPhase:nativeDensity}):undefined
              const worldCapture=!!this.sharedClient && !reduced && this.profile!=='figma' && this.profile!=='figmaSoftware' &&
                canonical?.camera.x===0 && canonical?.camera.y===0
              const canonicalCapture=(import.meta.env.VITE_DESIGN_CANONICAL_CAPTURE==='1'||!!resident.foregroundExclusions&&foregroundSafe)&&this.allowIdleWarm&&!!this.sharedClient&&nativeDensity&&
                this.profile==='figmaSubpixel'&&!!canonical
              phaseX = canonical?.phase.x || 0; phaseY = canonical?.phase.y || 0
              const captureCamera=canonicalCapture?canonical!.camera:{x:worldCapture?0:-originX+phaseX,y:worldCapture?0:-originY+phaseY,zoom:scale}
              // Keep the already-established camera arithmetic, but tell the
              // compiler the actual consumed output. A localized capture that
              // omits this region still prepares/allocates a whole page graph.
              const boundedCapture=this.allowIdleWarm&&!!this.sharedClient&&(
                import.meta.env.VITE_DESIGN_BOUNDED_POSE_CAPTURE==='1'&&!reduced&&this.profile==='figmaSubpixel'||
                localNativePose&&(this.profile==='figmaSubpixel'||this.profile==='analytic'))
              const captureViewport=canonicalCapture?{x:originX+Math.floor(captureCamera.x),y:originY+Math.floor(captureCamera.y),w:width,h:height}:
                worldCapture?{x:originX,y:originY,w:width,h:height}:boundedCapture?{x:0,y:0,w:width,h:height}:undefined
              causePhase=2;causeBranch=3
              result = await client.render(document, { pageId: resident.plan.pageId, width, height,
                view:captureCamera,transparent:false,grid:false,
                ...(captureViewport?{captureViewport}:{}),
                interactionOwner: this.interactionOwner, interactionGeneration: token, interactionBranch: 3,
                rasterProfile: this.profile, livePreview: true, retainInteractionGraph: true, interactionSelection: resident.plan.ids,
                interactionNative: !!resident.affine || !reduced || localNativePose,
                interactionAffine: !!resident.affine,
                renderIntent: 'preview', interactionChannel: !!this.sharedClient,
                interactionWindowFixed: !!resident.affine || resident.plan.ids.every(id=>resident.fixedBounds?.has(id)),
                ...(this.viewport ? { interactionWindow: { x: bounds.x*scale+captureCamera.x,
                  y:bounds.y*scale+captureCamera.y,
                  w: bounds.width * scale, h: bounds.height * scale } } : {}) }, false, this.backend, false, false, undefined, undefined, signal)
              causePhase=3
              break
            } catch (error) {
              if (!current()) throw Error('PREVIEW_CANCELLED')
              if(!reduced && !resident.tiledExact && recoverableInteractionBudget(error)){
                // Keep the previous complete pose until every replacement
                // tile is ready. The kernel owns backdrop halo and HQ resolve.
                resident.tiledExact=true
                result=await renderTiles();break
              }
              if (!reduced || attempt === 4 || !/PREVIEW_BUDGET|GPU.*(?:budget|预算)/i.test(String(error))) throw error
              if(import.meta.env.DEV)console.debug('[interaction-budget]',JSON.stringify({scale,reason:String(error)}))
              scale = targetScale * [.7,.5,.25,.125][attempt]
            }
          }
          if (!current()) {
            this.traceHandoff(5,5,sampleOrder,token)
            result?.bitmap?.close();for(const tile of capturedTiles||[])tile.bitmap?.close()
            client.releasePresented([...(result?.gpuTile?[result.gpuTile]:[]),...(capturedTiles||[]).flatMap(t=>t.gpuTile?[t.gpuTile]:[])])
            return
          }
          if (sampleOrder < this.completePageOrder) {
            this.traceHandoff(5,4,sampleOrder,token)
            // The exact page has already advanced past this in-flight sample.
            // Never bring the old pose back; keep the page and the warm owner.
            result?.bitmap?.close(); for (const tile of capturedTiles || []) tile.bitmap?.close()
            client.releasePresented([...(result?.gpuTile ? [result.gpuTile] : []), ...(capturedTiles || []).flatMap(t => t.gpuTile ? [t.gpuTile] : [])])
            continue
          }
          if (!result || !capturedTiles && !result.gpuTile && !result.bitmap && result.bytes.length !== width * height * 4) throw Error('交互场景像素不完整')
          let completedOffsets=offsets
          if(!interactionTransformsOnly(resident.plan,document)){
            // A reparent/content preview has now produced a complete kernel
            // capture. Only this completion may become the new pose baseline;
            // changing it before the await would reinterpret old pixels using
            // new parent matrices. Keep pending newer captures and their order.
            resident.plan={document,pageId:resident.plan.pageId,ids:[...resident.plan.ids],layers:[]}
            resident.affinePlan=undefined
            completedOffsets=new Map(resident.plan.ids.map(id=>[id,{x:0,y:0}]))
            resident.offsets=completedOffsets
            const entries=this.props?.scene?.entriesFor(document,resident.plan.pageId,this.props.epoch)??scene(document,resident.plan.pageId)
            Object.assign(resident,buildInteractionDependencyScope(document,resident.plan.pageId,entries,resident.plan.ids,
              {zoom:this.qualityZoom,dpr:this.viewport?.dpr||1,allowFixedBackdrop:!resident.affine}))
            this.patchBase=undefined;this.affineBase=undefined
            if(this.latestPatch&&!interactionTransformsOnly(resident.plan,this.latestPatch.document)){this.latestPatch=undefined;this.latestCandidate=undefined}
            else if(this.latestCandidate&&!interactionTransformsOnly(resident.plan,this.latestCandidate))this.latestCandidate=undefined
          }
          // Remember a successful budget negotiation. Retrying an oversized
          // capture on every pointer sample discarded the warmed GPU caches.
          // An adaptively reduced gesture sample must not overwrite the full
          // device-density record: post-gesture density bookkeeping and the
          // next gesture's demand computation both read resident.scale.
          if (this.viewportRevision === viewportRevision && !adaptive) resident.scale = scale
          resident.visibleBounds = this.viewport ? { ...bounds } : undefined
          this.poseEvent(2,0,input.sequence,2)
          this.lastPresentedInput = input
          this.error = ''
          resident.held=undefined
          resident.retainedFallback = false
          resident.sampleOrder = sampleOrder
          this.traceHandoff(4,0,sampleOrder,token)
          resident.displayedOffsets=completedOffsets||undefined
          resident.displayedTransforms = Object.fromEntries(resident.plan.ids.map(id => [id, [...document.nodes[id].transform] as Matrix]))
          resident.workerPoses=!capturedTiles && result.residentInteraction===true
          resident.foregroundCapture=foregroundSafe
          this.inlineDisabled=false
          for (const tile of resident.tiles) tile.bitmap?.close()
          resident.tiles = capturedTiles || [{ key: `interaction-live:${token}`, serial: serial--,
            x: originX, y: originY, width, height, zoom: scale, phaseX, phaseY, bytes: result.bytes, bitmap: result.bitmap, gpuTile: result.gpuTile }]
          const slots=Object.freeze(resident.tiles.map(tile=>tile.gpuTile||0))
          resident.overlayCapture = { document, tiles:resident.tiles, slots, cohort:Object.freeze({slots}),
            pageId:resident.plan.pageId, epoch:this.sessionEpoch!, generation:token, ids:this.selectionIds(resident.plan),overlay:capturedCommands }
          this.samples++; this.lastSampleMs = performance.now() - started
          this.lastSampleCompileMs = result.compileMs; this.lastSampleGraphMs = result.graphMs || 0
          this.lastSampleReused = !!result.compileCacheHit
          this.lastSampleGroupHits = result.retainedGroupHits || 0
          this.lastSampleLoadMs = result.loadMs || 0
          if (this.tracing) {
            this.sampleTrace.push({ total: this.lastSampleMs, prepare: this.lastSamplePrepareMs, load: this.lastSampleLoadMs,
              documentForks:result.documentForks,compile: result.compileMs, graph: result.graphMs || 0, finish: result.finishMs || 0,
              fieldMs:result.materialFieldBuildMs,fieldUploadBytes:result.materialFieldUploadBytes,checkpointMs:result.checkpointMs,
              reused: !!result.compileCacheHit, active: !!this.props?.active, backend:result.backend,reason:result.reason,scale,pixels:width*height })
            if (this.sampleTrace.length > 120) this.sampleTrace.shift()
          }
          // Pointer tasks can replace this field across the awaited capture.
          const pending = this.pendingLiveDocument()
          const pendingInput = pending && this.inputs.get(pending)
          if (import.meta.env.VITE_DESIGN_RESIDENT_PENDING_POSE !== '0' && pending && pendingInput &&
              pendingInput.sequence > input.sequence && current() &&
              this.viewportRevision === viewportRevision && resident.workerPoses &&
              !this.inlineDisabled && this.sharedClient && result.gpuTile &&
              guardedForegroundSafe(resident.foregroundExclusions,resident.rootBounds,resident.plan.ids,
                interactionOffsets(resident.plan,pending),resident.parentLinear,resident.scale) === foregroundSafe &&
              interactionTransformsOnly({ ...resident.plan, document }, pending)) {
            // Inputs arriving during the first capture already belong to its
            // warmed worker session. Send their absolute transforms there;
            // another whole capture would discard the lease and static prefix.
            // Only this pending snapshot's input may be acknowledged. Camera
            // or content changes keep the ordinary capture/rebase path.
            this.livePending = undefined
            this.sharedClient.moveResidentInteraction(result.gpuTile,
              Object.fromEntries(resident.plan.ids.map(id => [id, pending.nodes[id].transform])), pendingInput)
          }
          causePhase=4
          this.props?.onReady(); this.changed()
        }
      } catch (error) {
        // Snapshot before recovery microtasks; latest input may change meanwhile.
        const failedCause=captureCause, failedPhase=causePhase, failedAttempt=causeAttempt, failedBranch=causeBranch
        if (current()) {
          const idleWarm = this.idleWarmCapture
          const failedIdleWarm = idleWarm?.generation === token && idleWarm.resident === resident &&
            !resident.active && !this.props?.active
          const deviceLost = renderFailureFields(error).failureCategory === 4 ||
            /device lost|GPU device|has been lost|设备已丢失/i.test(String(error))
          if (String(error).includes('PREVIEW_CANCELLED')) {
            // Cancellation is an interrupted preview, not a rendering failure.
            // Clear the request dedup fence so a later prepare or pointer input
            // can retry. Do not call onReady here: that schedules React prepare
            // and would turn repeated cancellations into a self-retry loop.
            this.liveCancelled = true
            this.liveRequested = undefined
          } else if (failedIdleWarm && !deviceLost) {
            // Optional preparation must not disable a selection before its
            // first gesture. Keep this context's failed attempt (no idle loop),
            // while a real gesture can retry the ordinary capture/fallback.
            this.idleWarmFailed = idleWarm
            this.liveDeferred = true; this.liveRequested = undefined
          } else {
            this.error = String(error)
            // apply() must return so Canvas can publish its latest pending patch.
            // Native wrappers may throw synchronously before the first await.
            queueMicrotask(() => {
            if (!current()) return
            const scope = this.recoveryScope, props = this.props
            if (scope && props?.onPreviewFailed && resident.active && !resident.retainedFallback &&
                scope.document === this.liveAuthored && scope.document === props.document && scope.epoch === props.epoch &&
                scope.pageId === resident.plan.pageId && this.sameIds(props.selection) &&
                (scope.serial === captureSerial || !captureHadScope && scope.serial === captureSerial + 1)) {
              // Retire the failed native pose before handing the absolute edit to
              // the editor. A reentrant callback cannot recover this scope twice.
              const failure = { document: scope.document, epoch: scope.epoch, pageId: scope.pageId,
                sequence: this.lastInput.sequence, ids: [...resident.plan.ids] }
              const failureDiagnostic=this.poseLog.enabled?
                observedFailureCause(failedCause,failedPhase,failedAttempt,failedBranch,this.lastInput.sequence,this.generation,this.props?.epoch??0):undefined
              this.poseEvent(7,5,this.lastInput.sequence,0,undefined,failureDiagnostic)
              this.poseEvent(5,5,this.lastInput.sequence,0,undefined,failureDiagnostic)
              this.poseEndedThrough=this.lastInput.sequence
              this.retireRecovery()
              if (resident.tiles[0]?.gpuTile) this.sharedClient?.stopResidentInteraction(resident.tiles[0].gpuTile)
              resident.active = false; this.failedGesture = true; this.inlineDisabled = true
              this.livePending = this.liveRequested = undefined; this.handoff = undefined
              this.clearPoseFeedback(5); this.nextGeneration()
              props.onPreviewFailed(failure)
            }
            })
            this.props?.onReady()
          }
          this.changed()
        }
      }
      finally {
        this.liveRunning = false
        if (this.idleWarmCapture?.generation === token && this.idleWarmCapture.resident === resident)
          this.idleWarmCapture = undefined
        // Keep the warmed WASM/font state for the next input sample. The client
        // pool can park this idle GPU without destroying that state when an
        // export or another consumer needs its device slot.
        // A new owner may have queued work while the old job was unwinding.
        if (this.livePending && !this.disposed) { const pending = this.pendingLiveDocument()!, order = this.livePendingOrder; this.liveRequested = undefined; this.renderLive(pending, order) }
      }
    })()
  }
  private releaseClient() {
    if (this.client !== this.sharedClient) this.client?.dispose()
    this.client = null
  }
  private closeResidents(keepFeedback=false) {
    if(this.resident)this.traceHandoff(7,5,this.resident.sampleOrder)
    if(!keepFeedback)this.retireRecovery()
    this.poseEvent(5,this.disposed?6:9)
    this.cancelIdleWarmTimer(); this.idleWarmCapture = undefined
    this.idleWarmAttempt = this.idleWarmFailed = undefined
    if(this.resident?.tiles[0]?.gpuTile)this.sharedClient?.stopResidentInteraction(this.resident.tiles[0].gpuTile)
    for (const tile of this.resident?.tiles || []) tile.bitmap?.close()
    this.failedGesture = false
    if(!keepFeedback)this.poseOrders.clear()
    this.completePageOrder = 0
    this.settledViewport=undefined
    if(!keepFeedback){this.clearPoseFeedback(9);this.liveAuthored=undefined;this.feedbackDeferred=false}
    this.resident = undefined; this.livePending = undefined; this.liveRequested = undefined
    this.liveCancelled = false
    this.liveDeferred = false
    this.latestCandidate=undefined;this.latestPatch=undefined;this.patchBase=undefined;this.affineBase=undefined;this.inlineDisabled=false
    this.endedDocument=undefined
    this.handoff=undefined
  }
  dispose() {
    this.disposed = true; this.nextGeneration(); this.releaseClient(); this.pendingDensity = undefined
    this.layerPlanner.clear()
    if (this.props?.control.current === this.control) this.props.control.current = null
    this.closeResidents()
  }
}
