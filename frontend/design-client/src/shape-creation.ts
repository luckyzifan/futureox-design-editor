import { node, uid, type Bounds, type DesignNode, type Point } from './model'
import { kernelSnapPoint } from './kernel/picking'

export type ShapeCreationKind = 'slice' | 'rectangle' | 'ellipse' | 'polygon' | 'star' | 'line' | 'arrow' | 'frame' | 'section' | 'text'
export type ShapeCreationSeed = DesignNode & { kind: ShapeCreationKind }
export type ShapeCreationOptions = {
  anchor: Point
  pointer: Point
  /** Maximum travelled screen distance, in CSS pixels, supplied by the gesture owner. */
  screenDistance: number
  shift?: boolean
  alt?: boolean
  snap?: boolean
}
export type ShapeCreationResult = {
  node: ShapeCreationSeed
  bounds: Bounds
  /** Actual world-space endpoints, including centre/angle constraints. */
  start: Point
  end: Point
  click: boolean
}
export const SHAPE_CLICK_DISTANCE = 3
/** A bare click matches Figma's shape and frame tools: 100×100.
 * Device frames stay on the preset command. Dragging still uses the pointer span. */
export const CLICK_DEFAULT_SIZE = 100

/** Repeatable creation tools stay armed after a successful drag, matching the
 * shape/frame/sticky tools in Figma. One-shot tools (select handoff, pen
 * completion, text edit) still return to selection at their own call sites. */
const armedCreationTools = new Set([
  'rectangle', 'ellipse', 'polygon', 'star', 'line', 'arrow', 'frame', 'section', 'slice',
  'pencil', 'marker', 'brush', 'washi-tape', 'sticky', 'table', 'code-block', 'sites-responsive-set',
  'shape-whiteboard-square', 'shape-whiteboard-ellipse', 'shape-whiteboard-rounded-rectangle',
  'shape-whiteboard-triangle-up', 'shape-whiteboard-triangle-down', 'shape-whiteboard-diamond',
  'connector-straight', 'connector-elbowed',
])
export function creationToolStaysArmed(tool: string) { return armedCreationTools.has(tool) }

export function creationPointCount(current: number, delta: number) {
  if (!Number.isFinite(current) || !Number.isFinite(delta)) throw new Error('Invalid polygon point count')
  return Math.max(3, Math.min(60, Math.round(current) + Math.trunc(delta)))
}

/** Allocate once on pointerdown. All subsequent previews and the commit keep
 * this node's identity, paints, strokes and line vertex/edge identities. */
export function createShapeSeed(kind: ShapeCreationKind, id: string = uid(), points?: number): ShapeCreationSeed {
  const seed = node(kind === 'arrow' ? 'line' : kind, 0, 0, CLICK_DEFAULT_SIZE, ['line', 'arrow'].includes(kind) ? 1 : CLICK_DEFAULT_SIZE) as ShapeCreationSeed
  seed.id = id
  // Fresh geometric tools use the neutral fill observed in the reference UI.
  // Existing documents and explicitly styled board/pencil tools retain their paints.
  if (['rectangle','ellipse','polygon','star'].includes(kind)) seed.fills[0].color = '#d9d9d9'
  if (kind === 'arrow') { seed.name = '箭头'; seed.strokes[0].endMarker = 'arrow' }
  if (kind === 'polygon' || kind === 'star') seed.points = creationPointCount(points ?? (kind === 'polygon' ? 3 : 5), 0)
  return seed
}

/** Resolve the authored geometry once for both preview and commit. Snapping
 * applies once to each raw endpoint, then constraints operate on those points:
 * square/45-degree constraints therefore cannot become unequal through rounding. */
export function resolveShapeCreation(seed: ShapeCreationSeed, options: ShapeCreationOptions): ShapeCreationResult {
  const { anchor, pointer, screenDistance, shift = false, alt = false, snap = false } = options
  if (![anchor.x, anchor.y, pointer.x, pointer.y, screenDistance].every(Number.isFinite) || screenDistance < 0)
    throw new Error('Invalid shape creation gesture')
  const click = screenDistance < SHAPE_CLICK_DISTANCE
  const a = snap ? kernelSnapPoint(anchor) : { ...anchor }
  let delta: Point
  if (click) {
    const width = CLICK_DEFAULT_SIZE
    const height = seed.kind === 'line' ? 0 : CLICK_DEFAULT_SIZE
    delta = { x: width / (alt ? 2 : 1), y: height / (alt ? 2 : 1) }
  } else {
    const b = snap ? kernelSnapPoint(pointer) : pointer
    delta = { x: b.x - a.x, y: b.y - a.y }
    if (shift && seed.kind === 'line') {
      const sector = ((Math.round(Math.atan2(delta.y, delta.x) / (Math.PI / 4)) % 8) + 8) % 8
      const directions: Point[] = [
        { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: -1, y: 1 },
        { x: -1, y: 0 }, { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 },
      ]
      const direction = directions[sector]
      const extent = direction.x && direction.y ? Math.max(Math.abs(delta.x), Math.abs(delta.y))
        : direction.x ? Math.abs(delta.x) : Math.abs(delta.y)
      delta = { x: direction.x * extent, y: direction.y * extent }
    } else if (shift) {
      const extent = Math.max(Math.abs(delta.x), Math.abs(delta.y))
      delta = { x: Math.sign(delta.x || 1) * extent, y: Math.sign(delta.y || 1) * extent }
    }
  }
  const start = alt ? { x: a.x - delta.x, y: a.y - delta.y } : a
  const end = { x: a.x + delta.x, y: a.y + delta.y }
  const rawWidth = Math.abs(end.x - start.x), rawHeight = Math.abs(end.y - start.y)
  const width = Math.max(seed.kind === 'line' && rawWidth === 0 ? 1 : 0.01, rawWidth)
  const height = Math.max(seed.kind === 'line' && rawHeight === 0 ? 1 : 0.01, rawHeight)
  const bounds: Bounds = {
    x: alt && seed.kind !== 'line' ? a.x - width / 2 : Math.min(start.x, end.x),
    y: alt && seed.kind !== 'line' ? a.y - height / 2 : Math.min(start.y, end.y),
    width, height,
  }
  const result = structuredClone(seed)
  result.transform = [1, 0, 0, 1, bounds.x, bounds.y]
  result.width = width
  result.height = height
  if (seed.kind === 'line') {
    result.network = {
      vertices: [
        { id: `${seed.id}:start`, x: start.x - bounds.x, y: start.y - bounds.y },
        { id: `${seed.id}:end`, x: end.x - bounds.x, y: end.y - bounds.y },
      ],
      edges: [{ id: `${seed.id}:edge`, from: `${seed.id}:start`, to: `${seed.id}:end` }],
      fillRule: 'evenodd',
    }
  }
  return { node: result, bounds, start, end, click }
}

/** Solid fill shown while a shape is being drawn. Lines use their stroke.
 * The same color is already on the seed, so preview and commit cannot disagree. */
export function creationVisiblePaint(node: { kind: string; fills: ShapeCreationSeed['fills']; strokes: ShapeCreationSeed['strokes'] }): string {
  if (node.kind === 'line') {
    const stroke = node.strokes.find(entry => entry.visible && entry.paint.visible && entry.paint.kind === 'solid' && entry.paint.color)
    return stroke?.paint.color || '#303344'
  }
  const fill = node.fills.find(entry => entry.visible && entry.kind === 'solid' && entry.color)
  return fill?.color || 'none'
}

/** Local polygon used only for the creation ghost. The committed node still
 * uses the kernel's authored star/polygon geometry. */
export function creationPreviewPoints(node: { kind: string; width: number; height: number; points: number; innerRadius: number }): string | null {
  if (node.kind !== 'polygon' && node.kind !== 'star') return null
  const count = Math.max(3, Math.min(60, Math.round(node.points || (node.kind === 'star' ? 5 : 3))))
  const inner = node.kind === 'star' ? Math.max(0, Math.min(1, node.innerRadius || 0.45)) : 1
  const coords: string[] = []
  for (let index = 0; index < count; index++) {
    const angle = -Math.PI / 2 + index * 2 * Math.PI / count
    coords.push(`${node.width / 2 + Math.cos(angle) * node.width / 2},${node.height / 2 + Math.sin(angle) * node.height / 2}`)
    if (inner < 1) {
      const mid = angle + Math.PI / count
      coords.push(`${node.width / 2 + Math.cos(mid) * node.width / 2 * inner},${node.height / 2 + Math.sin(mid) * node.height / 2 * inner}`)
    }
  }
  return coords.join(' ')
}

/** Keep the filled ghost until the committed document has actually been presented.
 * Clearing it on mouseup, while the surface still shows the previous frame,
 * flashes an empty shape and then the fill. */
export function creationGhostNode<T extends { id: string }>(
  preview: T | null,
  held: T | null,
  committedAndPresented: (id: string) => boolean,
): T | null {
  if (preview) return preview
  if (!held || committedAndPresented(held.id)) return null
  return held
}
