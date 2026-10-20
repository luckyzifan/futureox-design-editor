import type { Bounds, DesignDocument, Matrix } from '../model'
import { translateOverlay, type CanvasOverlay } from './gpu/canvas-overlay'
import type { CanvasCamera } from '../canvas-camera'
import { allowsReducedSampling } from './render-quality'
import { interactionCaptureTiles, recoverableInteractionBudget } from './interaction-capture-tiles'
import { canvasRasterPlan } from './canvas-raster-plan'
import { tilePlacementAtView } from './tile-preview'
import { scene, unionBounds } from '../geometry'
import { buildInteractionDependencyScope } from './interaction-scene-bounds'
import { KernelClient, type KernelOptions, type KernelResult } from './client'
import type { BackendPreference } from './gpu/types'
import type { CompositeItem, CompositeTile } from './gpu/tile-compositor'
import { interactionOffsets, interactionPatchedDocument, interactionPatchedOffsets, planInteractionLayers,
  type GpuMoveControl, type InteractionPlan, type InteractionProps } from './interaction-layers'

let serial = -1
type ResidentInteraction = {
  displayedOffsets?: Map<string, {x:number;y:number}>
  plan: InteractionPlan; tiles: CompositeTile[]; scale: number;
  offsets: Map<string, { x: number; y: number }>; active: boolean
  live?: boolean
  rootBounds?: Map<string, Bounds>
  parentLinear?: Map<string, number[]>
  localizedBounds?: Set<string>
  fixedBounds?: Set<string>
  finalForeground?: boolean
  captureBounds?: Bounds
  dependencyPadding?: number
  visibleBounds?: Bounds
  workerPoses?: boolean
  backgroundLinear?:KernelResult['backgroundLinear']
  requestedScale?:number
  tiledExact?:boolean
  retainedFallback?:boolean
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
    this.handoff = undefined
    this.captureAbort.abort(); this.captureAbort = new AbortController()
    return ++this.generation
  }
  private pending?: { document: DesignDocument; ids: string; scale: number }
  private pendingDensity?: Parameters<InteractionRenderer['prepare']>
  private resident?: ResidentInteraction
  private props?: InteractionProps
  private disposed = false
  private profile?: KernelOptions['rasterProfile']
  private backend?: BackendPreference
  private sessionEpoch?: number
  private livePending?: DesignDocument
  private liveRunning = false
  private liveRequested?: DesignDocument
  private liveCancelled = false
  private liveDeferred = false
  private viewport?: { view: CanvasCamera; width: number; height: number; dpr: number }
  private viewportRevision = 0
  private inputs = new WeakMap<DesignDocument,{sequence:number;at:number}>()
  private lastInput = {sequence:0,at:0}
  private lastPresentedInput = {sequence:0,at:0}
  private latestCandidate?: DesignDocument
  private latestPatch?: { document:DesignDocument; patches:Parameters<typeof interactionPatchedDocument>[1] }
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
  private inlineDisabled = false
  private liveAuthored?: DesignDocument
  private endedDocument?: DesignDocument
  /** Keep completed interaction pixels visible while the committed document
   * transfers to exact canvas tiles, without starting another tiled capture. */
  private handoff?: {
    resident: ResidentInteraction; document: DesignDocument; epoch: number; viewportRevision: number
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
  readonly sampleTrace: { documentForks?:number; total: number; prepare: number; load: number; compile: number; graph: number; finish: number; reused: boolean; active: boolean; backend?:string; reason?:string; scale?:number; pixels?:number;sceneUpdateBytes?:number;geometryUploadBytes?:number;residentProgramHits?:number;residentProgramHitBytes?:number;posePrepareMs?:number;documentMs?:number;translationMs?:number;patchSession?:boolean;affectedNodes?:number;passTimings?:unknown[];compileStats?:Record<string,unknown>;fieldUploadBytes?:number;groupBytes?:number;prefixHits?:number;fieldHits?:number;checkpointMs?:number;fieldMs?:number;drawCalls?:number;passPixels?:number;textureBytes?:number }[] = []
  readonly control: GpuMoveControl

  constructor(private readonly changed: () => void, private readonly sharedClient?: KernelClient) {
    this.control = {
      isActive: () => !!this.resident?.active,
      apply: (document, patches) => {
        const inputStarted=performance.now()
        this.endedDocument = undefined
        const r = this.resident
        if (!r || this.error && !r.tiles.length || Object.keys(patches).some(id => !r.plan.ids.includes(id))) return null
        const fast=import.meta.env.VITE_DESIGN_POSE_PATCHES!=='0'
        const offsets = interactionPatchedOffsets(r.plan, document, patches,fast?this.baseOffsets(r.plan,document):undefined)
        if (!offsets) return null
        // A new accepted gesture owns new capture work. The previous complete
        // pixels remain available while an aborted predecessor unwinds.
        this.handoff = undefined
        const transforms=Object.fromEntries(r.plan.ids.map(id=>[id,[...(patches[id]?.transform||document.nodes[id].transform)] as Matrix]))
        this.liveAuthored=document
        this.latestPatch={document,patches:Object.fromEntries(r.plan.ids.map(id=>[id,{transform:transforms[id]}]))}
        this.latestCandidate=fast?undefined:interactionPatchedDocument(document,patches)
        const wasActive = r.active
        const retainedRebase = !r.live && !this.retainedOffsetsReusable(r, offsets)
        if (!retainedRebase) r.offsets = offsets
        r.active = true; this.moves++
        this.lastInput={sequence:this.moves,at:performance.now()}
        if(this.latestCandidate)this.inputs.set(this.latestCandidate,this.lastInput)
        if (!r.live && !retainedRebase) this.lastPresentedInput = this.lastInput
        this.changed()
        if (!wasActive) this.props?.onReady()
        if (retainedRebase && r.tiles.length) this.promoteRetained(this.candidateDocument()!)
        else if (r.live) {
          if(this.sharedClient&&r.workerPoses&&!this.inlineDisabled&&r.tiles[0]?.gpuTile){
            this.sharedClient.moveResidentInteraction(r.tiles[0].gpuTile,transforms,this.lastInput)
          }else this.renderLive(this.candidateDocument()!)
        }
        const id = r.plan.ids[0], next = patches[id]?.transform, current = document.nodes[id].transform
        const m = r.parentLinear?.get(id) || [1, 0, 0, 1], dx = next ? next[4] - current[4] : 0, dy = next ? next[5] - current[5] : 0
        if(import.meta.env.DEV){this.inputPreparationTrace.push(performance.now()-inputStarted);if(this.inputPreparationTrace.length>180)this.inputPreparationTrace.shift()}
        return { x: m[0] * dx + m[2] * dy, y: m[1] * dx + m[3] * dy }
      },
      covers: (document, ids, _view) => !!this.resident && (!this.error || this.ready) && this.sameIds(ids) &&
        (this.resident.live && document.id === this.resident.plan.document.id && (this.props?.active || this.resident.active) ||
          !!this.baseOffsets(this.resident.plan, document)),
      end: document => {
        const r = this.resident
        // Canvas forwards idle editor notifications (including hover) here.
        // They must not dispose a warmed worker before the first pointer-down.
        if (!r?.active) return
        if(this.endedDocument===document)return
        this.endedDocument=document
        this.latestPatch=undefined;this.latestCandidate=document
        const offsets = this.baseOffsets(r.plan, document)
        this.lastEnd = offsets ? [...offsets.values()].map(p => `${p.x},${p.y}`).join(';') : 'content-changed'
        r.active = r.live ? document !== r.plan.document && document.id === r.plan.document.id :
          !!offsets && [...offsets.values()].some(p => p.x !== 0 || p.y !== 0)
        if (offsets && !r.live && !this.retainedOffsetsReusable(r, offsets)) {
          if (r.tiles.length) this.promoteRetained(document)
          this.changed(); return
        }
        if (offsets) r.offsets = offsets
        if(r.live&&r.active&&offsets&&r.workerPoses&&this.sharedClient&&!this.liveRunning&&!this.livePending&&r.tiles[0]?.gpuTile){
          // Finish the gesture through the already compiled pose session.
          // The settled document lane will apply its own patch; it must not
          // wait behind a redundant whole-viewport interaction render.
          this.latestCandidate=document;this.liveAuthored=document
          this.lastInput={sequence:++this.moves,at:performance.now()}
          this.sharedClient.moveResidentInteraction(r.tiles[0].gpuTile,
            Object.fromEntries(r.plan.ids.map(id=>[id,document.nodes[id].transform])),this.lastInput)
          this.changed();return
        }
        if (this.sharedClient && r.live && r.tiledExact && !r.workerPoses && offsets &&
            this.viewport && this.props && this.sessionEpoch !== undefined && this.props.epoch === this.sessionEpoch &&
            document.id === r.plan.document.id && this.props.document.id === document.id &&
            this.sameIds(this.props.selection)) {
          this.nextGeneration()
          this.livePending = this.liveRequested = undefined
          this.pending = undefined; this.pendingDensity = undefined
          this.handoff = { resident: r, document, epoch: this.sessionEpoch, viewportRevision: this.viewportRevision }
          this.liveAuthored = document
          this.warming = false
          // r.active describes visible preview ownership, not permission to
          // enqueue more work. Hiding it here would jump back to old page pixels.
          r.active = true
          this.changed()
          return
        }
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
    return r.plan.layers.every((layer, index) => {
      const offset = layer.moving && offsets.get(layer.moving)
      const scale = r.tiles[index]?.zoom ?? r.scale
      return !offset || [offset.x * scale, offset.y * scale].every(Number.isSafeInteger)
    })
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

  private sameIds(ids: string[]) {
    return !!this.resident && ids.length === this.resident.plan.ids.length && ids.every(id => this.resident!.plan.ids.includes(id))
  }

  prepare(props: InteractionProps | undefined, pageId: string, view: CanvasCamera, dpr: number,
    profile: KernelOptions['rasterProfile'], backend: BackendPreference, settledDocument?: DesignDocument,
    size?: { width: number; height: number }) {
    const previousViewport = this.viewport
    this.viewport = size ? { view, dpr, ...size } : undefined
    this.qualityZoom = view.zoom
    const cameraChanged = !!size && (!previousViewport || previousViewport.view.zoom !== view.zoom ||
      previousViewport.view.x !== view.x || previousViewport.view.y !== view.y || previousViewport.dpr !== dpr ||
      previousViewport.width !== size.width || previousViewport.height !== size.height)
    if (cameraChanged) this.viewportRevision++
    if (cameraChanged && this.resident?.live) {
      if (!props?.active && !this.resident.active && (this.liveRunning || this.livePending)) {
        // Idle selection warm-up must not finish an obsolete camera ahead of
        // current canvas tiles. Keep any completed resident, but retire only
        // this owner's in-flight capture and defer retry until a real gesture.
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
    this.props = props
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
    const r = this.resident, key = props.selection.join(',')
    const samePolicy = profile === this.profile && backend === this.backend
    const handoff = this.handoff
    if (handoff) {
      const sameHandoff = !!r && r === handoff.resident && props.document === handoff.document &&
        props.epoch === handoff.epoch && r.plan.pageId === pageId && this.sameIds(props.selection) &&
        !!this.viewport && samePolicy && !cameraChanged && this.viewportRevision === handoff.viewportRevision
      if (r && sameHandoff && !props.active) {
        // ProgressiveSurface supplies fullPlanReady here. Waiting for a later
        // presentation ACK would keep the interaction layer covering that frame.
        if (settledDocument === props.document) {
          r.active = false
        }
        // Retain the ownership fence across idle React updates, even after
        // preview retirement. A new gesture or context change revokes it.
        return
      }
      this.handoff = undefined
      this.endedDocument = undefined
    }
    if (r?.live && (this.liveCancelled || this.liveDeferred) && (props.active || r.active) && samePolicy && r.plan.pageId === pageId &&
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
      if (r.live && props.document.id === r.plan.document.id && (props.active || r.active && settledDocument !== props.document)) {
        r.active = true
        // Imperative pointer updates precede the authored commit. A React
        // repaint must not enqueue the old authored position over newer input.
        if (this.liveAuthored !== props.document || cameraChanged) { this.liveAuthored = props.document; this.renderLive(cameraChanged?(this.candidateDocument()||props.document):props.document) }
        return
      }
      const candidate = r.active && this.latestPatch?.document === props.document ? this.candidateDocument() : undefined
      const offsets = this.baseOffsets(r.plan, candidate || props.document)
      // A page fast-path handover warms the last displayed pose while the
      // authored document remains unchanged. Do not replace that useful warm
      // job with the old authored pose on the next React layout pass.
      if (candidate && r.active && this.pending && !needsDensity && !needsViewport && !cameraChanged) return
      if (!r.live && offsets && !this.retainedOffsetsReusable(r, offsets) && r.tiles.length) {
        this.promoteRetained(candidate || props.document); return
      }
      if (offsets && r.active && settledDocument !== props.document && !needsDensity && !needsViewport) { r.offsets = offsets; return }
      if (r.plan.document === props.document && !needsDensity && !needsViewport) return
      if (offsets && settledDocument === props.document && !needsDensity && !needsViewport && !cameraChanged) {
        // The final pose already owns the right pixels/programs. Publishing the
        // authored translation must not synchronously rebuild scene bounds and
        // warm the same selection again before the committed frame can paint.
        // Keep the original local source and cumulative offsets for a second
        // drag; any content/policy/viewport change still revokes this reuse.
        r.offsets = offsets; r.active = false
        this.liveAuthored = props.document
        return
      }
      if (settledDocument === props.document) r.active = false
    }
    if (samePolicy && this.pending?.document === props.document && this.pending.ids === key && !needsViewport &&
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
    this.pending = { document: props.document, ids: key, scale: requestedScale }
    const contentGesture = props.active && !!r && !this.baseOffsets(r.plan, props.document)
    // Managed layers require linear-light recomposition. The legacy byte
    // presenter leaves that work to the kernel instead of blending sRGB bytes.
    const pad = 128 / view.zoom
    const captureViewport = viewport ? { x: viewport.x - pad, y: viewport.y - pad,
      width: viewport.width + 2 * pad, height: viewport.height + 2 * pad } : undefined
    let plan = contentGesture || props.document.colorManagement && !this.sharedClient
      ? null : planInteractionLayers(props.document, pageId, props.selection, captureViewport)
    if(plan&&!allowsReducedSampling(view.zoom)&&plan.layers.some(layer=>
      layer.bounds.width*layer.bounds.height*(view.zoom*dpr)**2>8_388_608/Math.max(1,plan!.layers.length)))plan=null
    if (!plan) {
      this.closeResidents(); this.warming = false
      // Dependency-sensitive/nested selections keep the complete kernel scene.
      // Coalesce input, but present every completed interaction sample instead
      // of cancelling it on the next pointer move and starving the display.
      if (props.selection.length && props.selection.every(id => props.document.nodes[id])) {
        const livePlan = { document: props.document, pageId, ids: [...props.selection], layers: [] }
        this.resident = { plan: livePlan, tiles: [], scale: view.zoom * dpr,
          offsets: interactionOffsets(livePlan, props.document)!, active: props.active, live: true }
        const entries = scene(props.document, pageId)
        Object.assign(this.resident, buildInteractionDependencyScope(props.document, pageId, entries,
          props.selection, { zoom: view.zoom, dpr, allowFixedBackdrop: import.meta.env.VITE_DESIGN_LOCAL_BACKDROP !== '0' }))
        this.liveAuthored = props.document
        this.error = ''; props.onReady()
        // Navigation temporarily removes interaction props and recreates this
        // resident when it settles. Install its control/scope now, but give the
        // exact canvas the queue until an actual gesture needs live pixels.
        if (props.active) this.renderLive(props.document)
        else this.liveDeferred = true
      } else { this.releaseClient() }
      props.onReady(); this.changed(); return
    }
    // Incompatible edits must never display a stale moved layer. Ordinary
    // exact page residents remain underneath while a new selection warms.
    if (!r || !this.baseOffsets(r.plan, props.document) || !this.sameIds(props.selection)) this.closeResidents()
    this.resident ??= { plan, tiles: [], scale: view.zoom * dpr,
      offsets: interactionOffsets(plan, props.document)!, active: false }
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
          const phaseX = reduced ? 0 : view.x * dpr - Math.floor(view.x * dpr)
          const phaseY = reduced ? 0 : view.y * dpr - Math.floor(view.y * dpr)
          let width = 1, height = 1, originX = 0, originY = 0, result: KernelResult | undefined
          for (let attempt = 0; attempt < 5 && current(); attempt++) {
            originX = Math.floor(b.x * scale); originY = Math.floor(b.y * scale)
            width = Math.max(1, Math.ceil((b.x + b.width) * scale) - originX)
            height = Math.max(1, Math.ceil((b.y + b.height) * scale) - originY)
            try {
              result = await client.render(layer.document, { pageId, width, height,
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
        this.closeResidents()
        this.resident = { plan, tiles, offsets, scale: Math.min(...tiles.map(tile=>tile.zoom)),requestedScale:view.zoom*dpr,active,backgroundLinear }
        if (!this.retainedOffsetsReusable(this.resident, offsets)) {
          this.resident.offsets = new Map(plan.ids.map(id => [id, { x: 0, y: 0 }]))
          rebase = candidate || this.props!.document
        } else this.lastPresentedInput = this.lastInput
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
    return r.tiles.map((tile, i) => {
      const offsets = r.retainedFallback ? r.displayedOffsets : r.offsets
      const offset = (!r.live || r.retainedFallback) && r.plan.layers[i]?.moving ? offsets?.get(r.plan.layers[i].moving!) : undefined
      const scale = view.zoom / tile.zoom
      return { tile, active: true, layer: i, gutter: tile.gutter ?? 0, blend: !r.live || !!r.retainedFallback,
        ...(r.live && !r.retainedFallback && r.visibleBounds ? {clip:{left:r.visibleBounds.x*view.zoom+view.x,top:r.visibleBounds.y*view.zoom+view.y,
          width:r.visibleBounds.width*view.zoom,height:r.visibleBounds.height*view.zoom}} : {}),
        placement: { ...tilePlacementAtView(tile,view),
          left: (tile.x-(tile.phaseX||0)) * scale + view.x + (offset?.x || 0) * view.zoom,
          top: (tile.y-(tile.phaseY||0)) * scale + view.y + (offset?.y || 0) * view.zoom } }
    })
  }
  overlay(overlay:CanvasOverlay):CanvasOverlay|undefined {
    const r=this.resident
    if(!r?.active||!overlay.transforms)return overlay
    // The GPU worker applies the last completed pose, not the latest pointer
    // input, for an inline live scene.
    if(r.live&&r.workerPoses)return overlay
    const source=interactionPatchedOffsets(r.plan,r.plan.document,Object.fromEntries(Object.entries(overlay.transforms).map(([id,transform])=>[id,{transform}])))
    const actual=r.live?r.displayedOffsets:r.offsets
    if(!source||!actual)return undefined
    const offsets=new Map<string,{x:number;y:number}>()
    for(const [id,p] of actual){const base=source.get(id)||{x:0,y:0},m=r.parentLinear?.get(id)||[1,0,0,1],x=p.x-base.x,y=p.y-base.y
      offsets.set(id,{x:m[0]*x+m[2]*y,y:m[1]*x+m[3]*y})}
    return translateOverlay(overlay,offsets)
  }
  get tiles() { return this.resident?.tiles || [] }
  get ready() { return !!this.resident?.tiles.length }
  get mode() { return this.resident?.live && !this.resident.retainedFallback ? 'live-kernel' : 'retained-layers' }
  get presentedInput() { return this.resident?.live ? this.lastPresentedInput : this.lastInput }
  get backgroundLinear(){return this.resident?.backgroundLinear}
  acceptResidentSample(sample:{slot:number;sequence:number;at:number;total?:number;compileMs?:number;nativePose?:boolean;graphMs?:number;finishMs?:number;groupHits?:number;sceneUpdateBytes?:number;geometryUploadBytes?:number;residentProgramHits?:number;residentProgramHitBytes?:number;posePrepareMs?:number;documentMs?:number;translationMs?:number;patchSession?:boolean;affectedNodes?:number;passTimings?:unknown[];compileStats?:Record<string,unknown>;fieldUploadBytes?:number;groupBytes?:number;prefixHits?:number;fieldHits?:number;checkpointMs?:number;fieldMs?:number;drawCalls?:number;passPixels?:number;textureBytes?:number;bounds?:Bounds;needsRebase?:boolean;signature?:string}) {
    const resident=this.resident
    if(this.disposed||!resident?.live||resident.tiles[0]?.gpuTile!==sample.slot)return
    if(sample.needsRebase){
      if(this.inlineDisabled)return
      this.inlineDisabled=true;resident.captureBounds=undefined;this.liveRequested=undefined
      this.renderLive(this.candidateDocument()||this.props!.document);return
    }
    if(sample.sequence<=this.lastPresentedInput.sequence)return
    this.lastPresentedInput={sequence:sample.sequence,at:sample.at}
    if(sample.bounds)resident.visibleBounds=sample.bounds
    this.samples++;this.lastSampleMs=sample.total||0;this.lastSampleCompileMs=sample.compileMs||0;this.lastSampleGraphMs=sample.graphMs||0
    this.lastSampleReused=!sample.nativePose;this.lastSampleLoadMs=0;this.lastSampleGroupHits=sample.groupHits||0
    if(import.meta.env.DEV){this.sampleTrace.push({total:this.lastSampleMs,prepare:0,load:0,compile:this.lastSampleCompileMs,graph:this.lastSampleGraphMs,
      finish:sample.finishMs||0,reused:this.lastSampleReused,active:!!this.props?.active,backend:'webgpu',scale:resident.scale,
      sceneUpdateBytes:sample.sceneUpdateBytes,geometryUploadBytes:sample.geometryUploadBytes,residentProgramHits:sample.residentProgramHits,residentProgramHitBytes:sample.residentProgramHitBytes,posePrepareMs:sample.posePrepareMs,documentMs:sample.documentMs,translationMs:sample.translationMs,patchSession:sample.patchSession,affectedNodes:sample.affectedNodes,passTimings:sample.passTimings,compileStats:sample.compileStats,fieldUploadBytes:sample.fieldUploadBytes,
      groupBytes:sample.groupBytes,prefixHits:sample.prefixHits,fieldHits:sample.fieldHits,checkpointMs:sample.checkpointMs,fieldMs:sample.fieldMs,drawCalls:sample.drawCalls,passPixels:sample.passPixels,textureBytes:sample.textureBytes})
      if(this.sampleTrace.length>120)this.sampleTrace.shift()}
    this.changed()
  }
  private renderLive(document: DesignDocument) {
    const handoff = this.handoff
    if (handoff && handoff.resident === this.resident && handoff.document === document) return
    if (this.liveRequested === document) return
    this.liveRequested = document; this.livePending = document
    this.liveCancelled = false
    this.liveDeferred = false
    if (this.liveRunning) return
    this.liveRunning = true
    const token = this.generation, resident = this.resident!
    const signal = this.sharedClient ? this.captureAbort.signal : undefined
    const current = () => !this.disposed && token === this.generation && this.resident === resident
    void (async () => {
      try {
        while (current() && this.livePending) {
          const started = performance.now()
          const viewportRevision = this.viewportRevision
          const document = this.livePending; this.livePending = undefined
          const input = this.inputs.get(document) || this.lastInput
          const offsets = interactionOffsets(resident.plan, document)
          const roots = resident.rootBounds
          let bounds = this.viewport ? { x: -this.viewport.view.x / this.viewport.view.zoom,
            y: -this.viewport.view.y / this.viewport.view.zoom, width: this.viewport.width / this.viewport.view.zoom,
            height: this.viewport.height / this.viewport.view.zoom } : offsets && roots && resident.plan.ids.every(id => roots.has(id))
            ? unionBounds([...roots].map(([id, b]) => ({ ...b, x: b.x + (offsets.get(id)?.x || 0), y: b.y + (offsets.get(id)?.y || 0) })))
            : unionBounds(scene(document, resident.plan.pageId).map(e => e.bounds))
          const pad = this.viewport ? 16 : Math.max(16, ...Object.values(document.nodes).flatMap(n => n.effects.filter(e => e.visible)
            .map(e => e.radius * 3 + Math.abs(e.x || 0) + Math.abs(e.y || 0) + Math.abs(e.spread || 0))))
          if (this.viewport && offsets && roots && resident.plan.ids.every(id => roots.has(id))) {
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
            let guard = finalForeground ? pad + Math.max(32 / this.viewport!.view.zoom, bounds.width * .05) :
              pad + Math.max(64, this.viewport ? 96 / this.viewport.view.zoom : 0, bounds.width * .05, bounds.height * .05)
            if (!finalForeground && this.viewport && resident.plan.ids.every(id => resident.localizedBounds?.has(id))) {
              const travelGuard = Math.max(guard, pad + 256 / this.viewport.view.zoom)
              if ((bounds.width + 2 * travelGuard) * (bounds.height + 2 * travelGuard) * resident.scale ** 2 <= 4_194_304)
                guard = travelGuard
            }
            b = resident.captureBounds = { x: bounds.x - guard, y: bounds.y - guard, width: bounds.width + guard * 2, height: bounds.height + guard * 2 }
          }
          const reduced=allowsReducedSampling(this.qualityZoom)
          if(!reduced && b.width*b.height*resident.scale**2>8_000_000){
            // Spend the native pixel budget on visible output, not speculative
            // movement guard. A later pose can expand/rebase the exact capture.
            const area=8_000_000/resident.scale**2
            const guard=Math.max(0,Math.min(pad,(-(bounds.width+bounds.height)+Math.sqrt((bounds.width-bounds.height)**2+4*area))/4))
            b=resident.captureBounds={x:bounds.x-guard,y:bounds.y-guard,width:bounds.width+2*guard,height:bounds.height+2*guard}
          }
          let scale = reduced ? Math.min(resident.scale, 8192 / Math.max(1, b.width, b.height),
            Math.sqrt(4_194_304 / Math.max(1, b.width * b.height))) : resident.scale
          const targetScale=scale
          this.lastSamplePrepareMs = performance.now() - started
          let result: KernelResult | undefined, width = 1, height = 1, originX = 0, originY = 0, phaseX = 0, phaseY = 0
          let capturedTiles: CompositeTile[] | undefined
          this.client ??= this.sharedClient || new KernelClient()
          const client = this.client
          for (let attempt = 0; attempt < 5 && current(); attempt++) {
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
              // Use the settled canvas's computation camera too. Re-anchoring
              // exact geometry at the capture origin changes floating-point
              // operation order, even if the final world position is identical.
              const raster=this.viewport?canvasRasterPlan(this.viewport.view,scale/this.viewport.view.zoom,
                this.viewport.width,this.viewport.height,{rasterProfile:this.profile,samplingScale:scale,exactPhase:!reduced}):
                {camera:{x:0,y:0,zoom:scale},phase:{x:0,y:0}}
              const plan=interactionCaptureTiles(originX,originY,width,height,scale).map(tile=>({...tile,
                phaseX:raster.phase.x,phaseY:raster.phase.y})), staged:CompositeTile[]=[]
              try {
                const result=await client.render(document,{pageId:resident.plan.pageId,width,height,
                  view:raster.camera,transparent:false,grid:false,rasterProfile:this.profile,
                  interactionOwner:this.interactionOwner,interactionGeneration:token,interactionBranch:2,
                  livePreview:true,renderIntent:'preview',interactionChannel:!!this.sharedClient,
                  tileViewport:plan,tilePrepareViewport:{x:originX+Math.floor(raster.camera.x)-1,
                    y:originY+Math.floor(raster.camera.y)-1,w:width+2,h:height+2}},
                  false,this.backend,false,false,undefined,tile=>{
                    staged.push({...tile,serial:serial--})
                  }, signal)
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
              const canonical=this.viewport?canvasRasterPlan(this.viewport.view,scale/this.viewport.view.zoom,
                this.viewport.width,this.viewport.height,{rasterProfile:this.profile,samplingScale:scale,exactPhase:!reduced}):undefined
              const worldCapture=!!this.sharedClient && !reduced && this.profile!=='figma' && this.profile!=='figmaSoftware' &&
                canonical?.camera.x===0 && canonical?.camera.y===0
              phaseX = canonical?.phase.x || 0; phaseY = canonical?.phase.y || 0
              result = await client.render(document, { pageId: resident.plan.pageId, width, height,
                view: { x: worldCapture?0:-originX+phaseX, y: worldCapture?0:-originY+phaseY, zoom: scale }, transparent: false, grid: false,
                ...(worldCapture?{captureViewport:{x:originX,y:originY,w:width,h:height}}:{}),
                interactionOwner: this.interactionOwner, interactionGeneration: token, interactionBranch: 3,
                rasterProfile: this.profile, livePreview: true, retainInteractionGraph: true, interactionSelection: resident.plan.ids,
                interactionNative: !allowsReducedSampling(this.qualityZoom),
                renderIntent: 'preview', interactionChannel: !!this.sharedClient,
                interactionWindowFixed: resident.plan.ids.every(id=>resident.fixedBounds?.has(id)),
                ...(this.viewport ? { interactionWindow: { x: worldCapture?bounds.x*scale:(bounds.x - b.x) * scale, y: worldCapture?bounds.y*scale:(bounds.y - b.y) * scale,
                  w: bounds.width * scale, h: bounds.height * scale } } : {}) }, false, this.backend, false, false, undefined, undefined, signal)
              break
            } catch (error) {
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
            result?.bitmap?.close();for(const tile of capturedTiles||[])tile.bitmap?.close()
            client.releasePresented([...(result?.gpuTile?[result.gpuTile]:[]),...(capturedTiles||[]).flatMap(t=>t.gpuTile?[t.gpuTile]:[])])
            return
          }
          if (!result || !capturedTiles && !result.gpuTile && !result.bitmap && result.bytes.length !== width * height * 4) throw Error('交互场景像素不完整')
          // Remember a successful budget negotiation. Retrying an oversized
          // capture on every pointer sample discarded the warmed GPU caches.
          if (this.viewportRevision === viewportRevision) resident.scale = scale
          resident.visibleBounds = this.viewport ? { ...bounds } : undefined
          this.lastPresentedInput = input
          this.error = ''
          resident.retainedFallback = false
          resident.displayedOffsets=offsets||undefined
          resident.workerPoses=!capturedTiles && result.residentInteraction===true
          this.inlineDisabled=false
          for (const tile of resident.tiles) tile.bitmap?.close()
          resident.tiles = capturedTiles || [{ key: `interaction-live:${token}`, serial: serial--,
            x: originX, y: originY, width, height, zoom: scale, phaseX, phaseY, bytes: result.bytes, bitmap: result.bitmap, gpuTile: result.gpuTile }]
          this.samples++; this.lastSampleMs = performance.now() - started
          this.lastSampleCompileMs = result.compileMs; this.lastSampleGraphMs = result.graphMs || 0
          this.lastSampleReused = !!result.compileCacheHit
          this.lastSampleGroupHits = result.retainedGroupHits || 0
          this.lastSampleLoadMs = result.loadMs || 0
          if (import.meta.env.DEV) {
            this.sampleTrace.push({ total: this.lastSampleMs, prepare: this.lastSamplePrepareMs, load: this.lastSampleLoadMs,
              documentForks:result.documentForks,compile: result.compileMs, graph: result.graphMs || 0, finish: result.finishMs || 0,
              fieldMs:result.materialFieldBuildMs,fieldUploadBytes:result.materialFieldUploadBytes,checkpointMs:result.checkpointMs,
              reused: !!result.compileCacheHit, active: !!this.props?.active, backend:result.backend,reason:result.reason,scale,pixels:width*height })
            if (this.sampleTrace.length > 120) this.sampleTrace.shift()
          }
          this.props?.onReady(); this.changed()
        }
      } catch (error) {
        if (current()) {
          if (String(error).includes('PREVIEW_CANCELLED')) {
            // Cancellation is an interrupted preview, not a rendering failure.
            // Clear the request dedup fence so a later prepare or pointer input
            // can retry. Do not call onReady here: that schedules React prepare
            // and would turn repeated cancellations into a self-retry loop.
            this.liveCancelled = true
            this.liveRequested = undefined
          } else {
            this.error = String(error)
            this.props?.onReady()
          }
          this.changed()
        }
      }
      finally {
        this.liveRunning = false
        // Keep the warmed WASM/font state for the next input sample. The client
        // pool can park this idle GPU without destroying that state when an
        // export or another consumer needs its device slot.
        // A new owner may have queued work while the old job was unwinding.
        if (this.livePending && !this.disposed) { const pending = this.livePending; this.liveRequested = undefined; this.renderLive(pending) }
      }
    })()
  }
  private releaseClient() {
    if (this.client !== this.sharedClient) this.client?.dispose()
    this.client = null
  }
  private closeResidents() {
    if(this.resident?.tiles[0]?.gpuTile)this.sharedClient?.stopResidentInteraction(this.resident.tiles[0].gpuTile)
    for (const tile of this.resident?.tiles || []) tile.bitmap?.close()
    this.resident = undefined; this.livePending = undefined; this.liveRequested = undefined; this.liveAuthored = undefined
    this.liveCancelled = false
    this.liveDeferred = false
    this.latestCandidate=undefined;this.latestPatch=undefined;this.patchBase=undefined;this.inlineDisabled=false
    this.endedDocument=undefined
    this.handoff=undefined
  }
  dispose() {
    this.disposed = true; this.nextGeneration(); this.releaseClient(); this.pendingDensity = undefined
    if (this.props?.control.current === this.control) this.props.control.current = null
    this.closeResidents()
  }
}
