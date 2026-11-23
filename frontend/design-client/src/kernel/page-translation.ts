import type { CanvasCamera } from '../canvas-camera'
import type { Bounds, DesignDocument } from '../model'
import { validColor } from '../color'
import { translateOverlay, type CanvasOverlay } from './gpu/canvas-overlay'
import { tilesCoverBounds } from './tile-cache'
import type { CompositeItem, CompositeTile } from './gpu/tile-compositor'
import { PoseFeedback } from './pose-feedback'
import {
  interactionOffsets,
  interactionPatchedOffsets,
  type GpuMoveControl,
  type InteractionPlan,
  type InteractionProps,
  type InteractionInput,
} from './interaction-layers'

function viewportBounds({ view, width, height }: { view: CanvasCamera; width: number; height: number }): Bounds {
  return { x: -view.x / view.zoom, y: -view.y / view.zoom, width: width / view.zoom, height: height / view.zoom }
}

/** Positive-area intersection. Touching edges are not coverage. */
export function intersectBounds(a: Bounds, b: Bounds): Bounds | undefined {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (!(right > x) || !(bottom > y)) return
  return { x, y, width: right - x, height: bottom - y }
}

export function boundsContain(outer: Bounds, inner: Bounds, epsilon = 1e-6) {
  return inner.x >= outer.x - epsilon && inner.y >= outer.y - epsilon &&
    inner.x + inner.width <= outer.x + outer.width + epsilon &&
    inner.y + inner.height <= outer.y + outer.height + epsilon
}

let boardFillTokens = 0

/** Viewport tiles are enough to start a retained board drag. The off-screen
 * remainder of the board is filled through the existing tile budget; it is
 * not a reason to redraw the whole scene on every pointer sample. */
function boardTilesCover(
  tiles: Parameters<typeof tilesCoverBounds>[0],
  board: Bounds,
  camera?: { view: CanvasCamera; width: number; height: number },
) {
  if (tilesCoverBounds(tiles, board)) return true
  if (!camera) return false
  const visible = intersectBounds(board, viewportBounds(camera))
  return !!visible && tilesCoverBounds(tiles, visible)
}

/** Moving every visible page root by the same vector leaves all inter-root
 * backdrop/blend dependencies unchanged. Reuse the already displayed page
 * tiles directly; a uniform page background is translation invariant. */
export class PageTranslation {
  private plan?: InteractionPlan
  private props?: InteractionProps
  private residents: CompositeTile[] = []
  private active = false
  private phaseRevoked = false
  private fractional = false
  private feedback = new PoseFeedback()
  private offset = { x: 0, y: 0 }
  private epoch = -1
  private input: InteractionInput = { sequence: 0, at: 0 }
  private pendingPose?: { document: DesignDocument; patches: Parameters<GpuMoveControl['apply']>[1] }
  private board?: Bounds
  private tracking = false
  private readonly fillToken = ++boardFillTokens
  private boardFillSequence = 0
  private coveredMisses = 0
  private srgbBoard?: { others: Bounds[]; viewport: Bounds; shown: { x: number; y: number } }
  private checkedDocument?: DesignDocument
  private checkedOffset: { x: number; y: number } | null = null
  moves = 0
  readonly samples = 0
  readonly warming = false
  readonly error = ''
  lastEnd = ''
  get mode() { return this.board ? 'retained-board' : 'retained-page' }
  readonly lastSampleMs = 0
  readonly lastSampleCompileMs = 0
  readonly lastSampleGraphMs = 0
  readonly lastSampleReused = true
  readonly lastSampleGroupHits = 0
  readonly sampleTrace: unknown[] = []
  readonly backgroundLinear = undefined
  constructor(private changed: () => void, private fractionalPose?: (
    document: DesignDocument, patches: Parameters<GpuMoveControl['apply']>[1], displayed: DesignDocument, guides?:InteractionInput['guides'],
  ) => ReturnType<GpuMoveControl['apply']>, private reportPhase?: (fields:Record<string,number>)=>void,
    private fillCoverage?: (source:DesignDocument,offset:{x:number;y:number},sequence:number,failed:()=>void,region?:Bounds)=>boolean) {}
  get handingOff() { return this.phaseRevoked }
  get backgroundTranslation() { return this.board ? undefined : { ...this.offset } }
  get backgroundBoard() {
    if (!this.srgbBoard || !this.board) return
    const view = this.srgbBoard.viewport
    const visible = this.srgbBoard.others.filter(b => b.x < view.x + view.width && b.x + b.width > view.x &&
      b.y < view.y + view.height && b.y + b.height > view.y)
    return { moving: { ...this.board, x: this.board.x + this.offset.x, y: this.board.y + this.offset.y }, stationary: visible }
  }
  /** A viewport crop is not a complete page. Missing original pixels are
   * filled through the existing tile budget. A clipped board asks for its own
   * uncovered pixels there. A rejected fill, or a covered pose the presenter
   * still refuses, returns to the live scene. Late replies cannot restart a
   * retired owner, and a pointer-up does not. */
  repairMissingCoverage(sequence: number) {
    const pending = this.pendingPose
    if (!this.active || this.phaseRevoked || sequence !== this.input.sequence || !pending) return false
    // An uncommitted whole-page translation can fill the missing original
    // world tiles through the canvas's existing owner/budget/queue. No document
    // patch or enlarged capture is needed. A clipped board uses that same
    // budget for the board's own missing pixels instead of a full redraw.
    const owner=this.plan
    const failPage=()=>{
      const latest=this.pendingPose
      if(this.plan===owner&&this.active&&!this.phaseRevoked&&latest)this.rebase(latest.document,latest.patches)
    }
    if (!this.board && this.fillCoverage?.(owner!.document, {...this.offset}, sequence, failPage)) return true
    if (this.board) {
      if (!tilesCoverBounds(this.residents, this.board)) {
        if (this.requestBoardFill()) return true
      } else if (this.boardFillSequence !== 0 && this.coveredMisses++ < 2) {
        // The incomplete frame was recorded before these board pixels arrived.
        // One stale rejection must not start a whole-scene redraw.
        return false
      }
      if (this.boardFillSequence !== 0 && !this.tracking) return false
    }
    this.rebase(pending.document, pending.patches)
    return true
  }
  private requestBoardFill() {
    const owner = this.plan, board = this.board
    if (!owner || !board || !this.tracking || this.phaseRevoked || tilesCoverBounds(this.residents, board)) return false
    if (!this.boardFillSequence) this.boardFillSequence = this.fillToken
    return this.fillCoverage?.(owner.document, { ...this.offset }, this.boardFillSequence, () => {
      const latest = this.pendingPose
      if (this.tracking && this.plan === owner && this.active && !this.phaseRevoked && latest)
        this.rebase(latest.document, latest.patches)
    }, { ...board }) === true
  }
  private integerPhysicalOffset(offset: { x: number; y: number }) {
    return this.residents.length > 0 && this.residents.every(tile =>
      [offset.x * tile.zoom, offset.y * tile.zoom].every(Number.isSafeInteger))
  }
  private reusableOffset(offset: { x: number; y: number }) {
    // A clipped board's texels belong to one sample lattice. Both axes must
    // land on whole physical pixels before those texels can move. A fractional
    // axis keeps the last accepted frame and asks native to rasterize the real
    // pose on that same camera lattice. Whole-page desktop reprojection is
    // unchanged.
    if (this.board) return this.integerPhysicalOffset(offset)
    return this.residents.length > 0 && (this.fractional || this.integerPhysicalOffset(offset))
  }
  private rebase(document: DesignDocument, patches: Parameters<GpuMoveControl['apply']>[1], guides=this.input.guides) {
    this.tracking = false
    this.phaseRevoked = true
    if(this.reportPhase){
      // Uniform translation was checked by the caller. Inspect one transform
      // and the bounded resident list; diagnostics never clone the document.
      const id=this.plan!.ids[0],before=this.plan!.document.nodes[id].transform,after=patches[id]?.transform||document.nodes[id].transform
      let error=0
      for(const tile of this.residents)for(const shift of [(after[4]-before[4])*tile.zoom,(after[5]-before[5])*tile.zoom])
        error=Math.max(error,Math.abs(shift-Math.round(shift)))
      this.reportPhase({retainedPhaseRejects:1,retainedPhaseSamples:this.residents.length*2,retainedPhaseError:error})
    }
    return this.fractionalPose?.(document, patches, this.displayedDocument(), guides) ?? null
  }
  private displayedDocument() {
    const document = this.plan!.document
    const offset = this.srgbBoard?.shown ?? this.offset
    // No pixels have moved yet. Preserve the authored snapshot's private
    // native receipt instead of cloning every node and forcing a full bridge
    // serialization merely to hand the first fractional pose to the kernel.
    if (offset.x === 0 && offset.y === 0) return document
    return { ...document, nodes: { ...document.nodes,
      ...Object.fromEntries(this.plan!.ids.map(id => {
        const node = document.nodes[id], transform = [...node.transform] as typeof node.transform
        transform[4] += offset.x; transform[5] += offset.y
        return [id, { ...node, transform }]
      })),
    } }
  }
  private overlapsStationary(offset: { x: number; y: number }) {
    if (!this.board || !this.srgbBoard) return false
    const { viewport, others } = this.srgbBoard
    const x = this.board.x + offset.x, y = this.board.y + offset.y
    const left = Math.max(x, viewport.x), top = Math.max(y, viewport.y)
    const right = Math.min(x + this.board.width, viewport.x + viewport.width)
    const bottom = Math.min(y + this.board.height, viewport.y + viewport.height)
    return left < right && top < bottom && others.some(b =>
      b.x < right && b.x + b.width > left && b.y < bottom && b.y + b.height > top)
  }
  private delta(document: DesignDocument) {
    if (!this.plan) return null
    if (document === this.plan.document) return { x: 0, y: 0 }
    if (document === this.checkedDocument) return this.checkedOffset
    const offsets = interactionOffsets(this.plan, document)
    this.checkedDocument = document
    if (!offsets?.size) return this.checkedOffset = null
    const first = offsets.values().next().value!
    return this.checkedOffset = [...offsets.values()].every(
      (v) => Math.abs(v.x - first.x) < 1e-7 && Math.abs(v.y - first.y) < 1e-7,
    )
      ? first
      : null
  }
  readonly control: GpuMoveControl = {
    isActive: () => this.active,
    guidesInSurface:()=>true,
    feedbackPending:()=>true,
    inputSequence:()=>this.input.sequence,
    covers: (document, ids) =>
      !!this.plan &&
      ids.length === this.plan.ids.length &&
      ids.every((id) => this.plan!.ids.includes(id)) &&
      !!this.delta(document),
    apply: (document, patches, _trace, guides) => {
      if (!this.plan || Object.keys(patches).some((id) => !this.plan!.ids.includes(id))) return null
      if (!this.delta(document)) return null
      // The editor document is immutable during a retained move. Validate it
      // once by identity; pointer samples only need the selected transforms.
      // Do not clone/enumerate a 20,000-node document for every mouse event.
      let offset: { x: number; y: number } | undefined
      for (const id of this.plan.ids) {
        const patch = patches[id], before = this.plan.document.nodes[id].transform
        if (patch && Object.keys(patch).some(key => key !== 'transform')) return null
        const after = patch?.transform || document.nodes[id].transform
        if (after.length !== 6 || !after.every(Number.isFinite) || after.slice(0, 4).some((v, i) => v !== before[i])) return null
        const next = { x: after[4] - before[4], y: after[5] - before[5] }
        if (offset && (Math.abs(next.x - offset.x) > 1e-7 || Math.abs(next.y - offset.y) > 1e-7)) return null
        offset = next
      }
      if (!offset || this.phaseRevoked) return null
      // A visible overlap needs native painter order. Motion beyond the edge
      // of the viewport does not invalidate this composition.
      if (this.overlapsStationary(offset)) return this.rebase(document, patches, guides)
      // Whole-page desktop motion may reproject full-density texels. Clipped
      // boards require an integer physical phase on both axes. Final readiness
      // always belongs to the committed native page, not this pose.
      if (!this.reusableOffset(offset)) return this.rebase(document, patches, guides)
      const id = this.plan.ids[0],
        before = document.nodes[id].transform,
        after = patches[id]?.transform || before
      const wasActive = this.active
      this.offset = offset
      this.active = true
      this.tracking = true
      this.moves++
      this.input = { sequence: this.moves, at: performance.now(), guides:guides?.slice(0,2).map(g=>({...g})) }
      this.pendingPose = { document, patches: Object.fromEntries(this.plan.ids.map(id =>
        [id, { transform: [...(patches[id]?.transform || document.nodes[id].transform)] }])) }
      const feedback={ x: after[4] - before[4], y: after[5] - before[5] }
      this.feedback.submit(this.input.sequence,feedback,document)
      this.changed()
      if (!wasActive) this.props?.onReady()
      if (this.board) this.requestBoardFill()
      return feedback
    },
    end: (document) => {
      this.tracking = false
      this.input = { ...this.input, guides:undefined }
      this.feedback.clear()
      if (!this.active || this.phaseRevoked) return
      const offset = this.delta(document)
      if (offset && !this.reusableOffset(offset)) { this.rebase(document, {}); return }
      this.active = !!offset && (offset.x !== 0 || offset.y !== 0)
      if (offset) this.offset = offset
      this.lastEnd = offset ? `${offset.x},${offset.y}` : 'content-changed'
      this.changed()
    },
  }
  prepare(
    props: InteractionProps | undefined,
    pageId: string,
    source: DesignDocument,
    items: CompositeItem[],
    settled: DesignDocument | undefined,
    allowed: boolean,
    fractional=false,
    camera?: { view: CanvasCamera; width: number; height: number },
  ) {
    if(this.fractional!==fractional){this.clear();this.fractional=fractional}
    if (this.phaseRevoked) {
      // React refreshes during imperative input still refer to the old
      // authored document. Do not rebind its invalid pixel fast path.
      if (this.plan && props?.epoch === this.epoch && source === this.plan.document &&
          props?.selection.length === this.plan.ids.length && props.selection.every(id => this.plan!.ids.includes(id))) return false
      this.clear()
    }
    const document = this.active && this.plan ? this.plan.document : props?.document
    const page = document?.pages.find((page) => page.id === pageId)
    const roots = page?.children.filter((id) => document?.nodes[id]?.visible) || []
    const all = roots.length === props?.selection.length && roots.every(id => props?.selection.includes(id))
    const allowSrgb = !!camera && props?.figmaBoardPreview === true && !document?.colorManagement
    const proof = document && props?.selection.length === 1
      ? opaqueBoardProof(document, roots, props.selection[0], allowSrgb) : undefined
    const board = proof?.box
    const coveredBoard = !!board && (this.active && !!this.board || boardTilesCover(items.map(i => i.tile), board, camera))
    const eligible =
      !!props &&
      allowed &&
      roots.length > 0 &&
      (all || coveredBoard)
    if (!eligible || this.epoch !== props?.epoch || this.plan?.pageId !== pageId) {
      this.clear()
      this.epoch = props?.epoch ?? -1
    }
    if (!eligible || !props) return false
    this.props = props
    if (this.active && this.srgbBoard && camera) {
      this.srgbBoard.viewport = viewportBounds(camera)
      if (this.pendingPose && this.overlapsStationary(this.offset)) {
        const { document, patches } = this.pendingPose
        this.rebase(document, patches)
        return false
      }
    }
    if (this.plan && this.active) {
      if (!this.delta(props.document)) {
        this.clear()
        return false
      }
      if (props.active || props.document === this.plan.document) {
        if (source === this.plan.document && items.length)
          this.residents = items.map((item) => item.tile)
        return true
      }
      if (settled !== props.document) return true
    }
    if (settled === source && items.length) {
      this.plan = { document: source, pageId, ids: [...props.selection], layers: [] }
      this.checkedDocument = undefined
      this.board = all ? undefined : board
      this.srgbBoard = this.board && proof?.srgb && camera
        ? { others: proof.others, viewport: viewportBounds(camera), shown: { x: 0, y: 0 } } : undefined
      this.residents = items.map((item) => item.tile)
      const offset = this.delta(props.document) || { x: 0, y: 0 }
      this.offset = { x: 0, y: 0 }
      if (!this.reusableOffset(offset)) { this.rebase(props.document, {}); return false }
      this.offset = offset
      this.active = props.active && (this.offset.x !== 0 || this.offset.y !== 0)
    }
    return !!this.plan && this.plan.document === source && this.residents.length > 0
  }
  bind() {
    if (this.props) this.props.control.current = this.control
  }
  acceptPresentedInput(sequence:number,at:number,ownerMatches:boolean,slots:readonly number[]){
    const document=this.pendingPose?.document
    if(!this.active||this.phaseRevoked||!ownerMatches||!document||!this.props||
      this.residents.some(tile=>!tile.gpuTile||!slots.includes(tile.gpuTile)))return
    const offset=this.feedback.present(sequence,document)
    if (offset && this.srgbBoard) {
      const base = this.delta(document)
      if (base) this.srgbBoard.shown = { x: base.x + offset.x, y: base.y + offset.y }
    }
    if(offset)this.props.onPosePresented?.({sequence,offset,document,epoch:this.props.epoch,control:this.control,latencyMs:Math.max(0,performance.now()-at)})
  }
  items(view: CanvasCamera): CompositeItem[] | null {
    if (!this.active) return null
    if (this.board) {
      const b = this.board, left = b.x * view.zoom + view.x, top = b.y * view.zoom + view.y
      const width = b.width * view.zoom, height = b.height * view.zoom
      const items: CompositeItem[] = []
      for (const tile of this.residents) {
        const s = view.zoom / tile.zoom
        const placement = { left: (tile.x - (tile.phaseX || 0)) * s + view.x,
          top: (tile.y - (tile.phaseY || 0)) * s + view.y, width: tile.width * s, height: tile.height * s }
        const x0 = placement.left, y0 = placement.top, x1 = x0 + placement.width, y1 = y0 + placement.height
        // Remove the board's old rectangle from the stationary page. The
        // uniform page background underneath fills the vacancy immediately.
        for (const clip of [
          { left: x0, top: y0, width: x1 - x0, height: Math.min(y1, top) - y0 },
          { left: x0, top: Math.max(y0, top + height), width: x1 - x0, height: y1 - Math.max(y0, top + height) },
          { left: x0, top: Math.max(y0, top), width: Math.min(x1, left) - x0, height: Math.min(y1, top + height) - Math.max(y0, top) },
          { left: Math.max(x0, left + width), top: Math.max(y0, top), width: x1 - Math.max(x0, left + width), height: Math.min(y1, top + height) - Math.max(y0, top) },
        ]) if (clip.width > 0 && clip.height > 0) items.push({ tile, active: true, layer: 0, placement, clip, gutter: tile.gutter ?? 1 })
        const dx = this.offset.x * view.zoom, dy = this.offset.y * view.zoom
        items.push({ tile, active: true, layer: 4, gutter: tile.gutter ?? 1,
          placement: { ...placement, left: placement.left + dx, top: placement.top + dy },
          clip: { left: left + dx, top: top + dy, width, height } })
      }
      return items
    }
    return this.residents.map((tile) => {
      const scale = view.zoom / tile.zoom
      return {
        tile,
        active: true,
        layer: 0,
        gutter: tile.gutter ?? 1,
        placement: {
          left: (tile.x - (tile.phaseX || 0)) * scale + view.x + this.offset.x * view.zoom,
          top: (tile.y - (tile.phaseY || 0)) * scale + view.y + this.offset.y * view.zoom,
          width: tile.width * scale,
          height: tile.height * scale,
        },
      }
    })
  }
  overlay(overlay:CanvasOverlay):CanvasOverlay|undefined {
    if(!this.active||!this.plan||!overlay.transforms)return overlay
    const base=interactionPatchedOffsets(this.plan,this.plan.document,Object.fromEntries(Object.entries(overlay.transforms).map(([id,transform])=>[id,{transform}])))
    if(!base)return undefined
    return translateOverlay(overlay,new Map([...base].map(([id,p])=>[id,{x:this.offset.x-p.x,y:this.offset.y-p.y}])))
  }
  get tiles() {
    return this.residents
  }
  get ready() {
    return this.residents.length > 0
  }
  get presentedInput() {
    return this.input
  }
  clear() {
    this.feedback.clear()
    if (this.props?.control.current === this.control) this.props.control.current = null
    this.plan = undefined
    this.checkedDocument = undefined
    this.checkedOffset = null
    this.props = undefined
    this.residents = []
    this.board = undefined
    this.srgbBoard = undefined
    this.tracking = false
    this.boardFillSequence = 0
    this.coveredMisses = 0
    this.active = false
    this.phaseRevoked = false
    this.pendingPose = undefined
    this.offset = { x: 0, y: 0 }
  }
}

/** Page pixels are an exact isolated board source only when the board is an
 * opaque clipped rectangle and other roots cannot paint into its old bounds.
 * Transparent/overlapping/effect-dependent selections use the layer renderer. */
export function isolatedOpaqueBoard(document: DesignDocument, roots: string[], id: string): Bounds | undefined {
  return opaqueBoardProof(document, roots, id, false)?.box
}

function opaqueBoardProof(document: DesignDocument, roots: string[], id: string, allowSrgb: boolean) {
  if (!roots.includes(id)) return
  const boxes = roots.map(key => {
    const n = document.nodes[key], m = n.transform
    if (n.kind !== 'frame' || !n.clip || n.blend !== 'normal' || n.mask || (allowSrgb && n.spatial) ||
      m[0] !== 1 || m[1] !== 0 || m[2] !== 0 || m[3] !== 1 ||
      n.effects.some(e => e.visible) || n.strokes.some(s => s.visible && s.width > 0)) return undefined
    return { x: m[4], y: m[5], width: n.width, height: n.height }
  })
  if (boxes.some(box => !box)) return
  const n = document.nodes[id], box = boxes[roots.indexOf(id)]!
  if (n.opacity !== 1 || n.radii.some(r => r !== 0)) return
  const solids = n.fills.filter(p => p.kind === 'solid').filter(p => p.visible && p.opacity === 1 && p.blend === 'normal')
  const hex = solids.some(p => /^#[\da-f]{6}$/i.test(p.color))
  const srgb = !hex && allowSrgb && solids.some(p => {
    if (!p.color.startsWith('color(srgb ') || !validColor(p.color)) return false
    const alpha = p.color.slice(6, -1).split('/')[1]
    return alpha === undefined || Number(alpha) === 1
  })
  if (!hex && !srgb) return
  const others = boxes.filter((other): other is Bounds => !!other && other !== box)
  if (others.some(other => other.x < box.x + box.width &&
    other.x + other.width > box.x && other.y < box.y + box.height && other.y + other.height > box.y)) return
  return { box, srgb, others }
}
