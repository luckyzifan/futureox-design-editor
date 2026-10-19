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

export function creationPointCount(current: number, delta: number) {
  if (!Number.isFinite(current) || !Number.isFinite(delta)) throw new Error('Invalid polygon point count')
  return Math.max(3, Math.min(60, Math.round(current) + Math.trunc(delta)))
}

/** Allocate once on pointerdown. All subsequent previews and the commit keep
 * this node's identity, paints, strokes and line vertex/edge identities. */
export function createShapeSeed(kind: ShapeCreationKind, id: string = uid(), points?: number): ShapeCreationSeed {
  const seed = node(kind === 'arrow' ? 'line' : kind, 0, 0, kind === 'frame' ? 400 : 100, kind === 'frame' ? 300 : ['line', 'arrow'].includes(kind) ? 1 : 100) as ShapeCreationSeed
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
    const width = seed.kind === 'frame' ? 400 : 100
    const height = seed.kind === 'frame' ? 300 : seed.kind === 'line' ? 0 : 100
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
