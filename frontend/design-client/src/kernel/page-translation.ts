import type { CanvasCamera } from '../canvas-camera'
import type { Bounds, DesignDocument } from '../model'
import { translateOverlay, type CanvasOverlay } from './gpu/canvas-overlay'
import { tilesCoverBounds } from './tile-cache'
import type { CompositeItem, CompositeTile } from './gpu/tile-compositor'
import {
  interactionOffsets,
  interactionPatchedOffsets,
  type GpuMoveControl,
  type InteractionPlan,
  type InteractionProps,
} from './interaction-layers'

/** Moving every visible page root by the same vector leaves all inter-root
 * backdrop/blend dependencies unchanged. Reuse the already displayed page
 * tiles directly; a uniform page background is translation invariant. */
export class PageTranslation {
  private plan?: InteractionPlan
  private props?: InteractionProps
  private residents: CompositeTile[] = []
  private active = false
  private offset = { x: 0, y: 0 }
  private epoch = -1
  private input = { sequence: 0, at: 0 }
  private board?: Bounds
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
  constructor(private changed: () => void) {}
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
    covers: (document, ids) =>
      !!this.plan &&
      ids.length === this.plan.ids.length &&
      ids.every((id) => this.plan!.ids.includes(id)) &&
      !!this.delta(document),
    apply: (document, patches) => {
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
      if (!offset) return null
      const id = this.plan.ids[0],
        before = document.nodes[id].transform,
        after = patches[id]?.transform || before
      const wasActive = this.active
      this.offset = offset
      this.active = true
      this.moves++
      this.input = { sequence: this.moves, at: performance.now() }
      this.changed()
      if (!wasActive) this.props?.onReady()
      return { x: after[4] - before[4], y: after[5] - before[5] }
    },
    end: (document) => {
      if (!this.active) return
      const offset = this.delta(document)
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
  ) {
    const document = this.active && this.plan ? this.plan.document : props?.document
    const page = document?.pages.find((page) => page.id === pageId)
    const roots = page?.children.filter((id) => document?.nodes[id]?.visible) || []
    const all = roots.length === props?.selection.length && roots.every(id => props?.selection.includes(id))
    const board = document && props?.selection.length === 1
      ? isolatedOpaqueBoard(document, roots, props.selection[0]) : undefined
    const coveredBoard = !!board && (this.active && !!this.board || tilesCoverBounds(items.map(i => i.tile), board))
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
      this.residents = items.map((item) => item.tile)
      this.offset = this.delta(props.document) || { x: 0, y: 0 }
      this.active = props.active && (this.offset.x !== 0 || this.offset.y !== 0)
    }
    return !!this.plan && this.plan.document === source && this.residents.length > 0
  }
  bind() {
    if (this.props) this.props.control.current = this.control
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
    if (this.props?.control.current === this.control) this.props.control.current = null
    this.plan = undefined
    this.checkedDocument = undefined
    this.checkedOffset = null
    this.props = undefined
    this.residents = []
    this.board = undefined
    this.active = false
    this.offset = { x: 0, y: 0 }
  }
}

/** Page pixels are an exact isolated board source only when the board is an
 * opaque clipped rectangle and other roots cannot paint into its old bounds.
 * Transparent/overlapping/effect-dependent selections use the layer renderer. */
export function isolatedOpaqueBoard(document: DesignDocument, roots: string[], id: string): Bounds | undefined {
  if (!roots.includes(id)) return
  const boxes = roots.map(key => {
    const n = document.nodes[key], m = n.transform
    if (n.kind !== 'frame' || !n.clip || n.blend !== 'normal' || n.mask ||
      m[0] !== 1 || m[1] !== 0 || m[2] !== 0 || m[3] !== 1 ||
      n.effects.some(e => e.visible) || n.strokes.some(s => s.visible && s.width > 0)) return undefined
    return { x: m[4], y: m[5], width: n.width, height: n.height }
  })
  if (boxes.some(box => !box)) return
  const n = document.nodes[id], box = boxes[roots.indexOf(id)]!
  if (n.opacity !== 1 || n.radii.some(r => r !== 0) || !n.fills.some(p =>
    p.visible && p.kind === 'solid' && p.opacity === 1 && p.blend === 'normal' && /^#[\da-f]{6}$/i.test(p.color))) return
  if (boxes.some((other, i) => roots[i] !== id && other!.x < box.x + box.width &&
    other!.x + other!.width > box.x && other!.y < box.y + box.height && other!.y + other!.height > box.y)) return
  return box
}
