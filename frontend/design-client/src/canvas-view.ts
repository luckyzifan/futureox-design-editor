import type { Bounds, DesignDocument, DesignNode, Matrix, Point } from './model'
import { apply, around, inverse, multiply, rotate, boxPoints, bounds } from './geometry'
import { kernelSnapPoint, kernelBounds } from './kernel/picking'
import { pixelGridVisible } from './pixel-grid'
export { zoomAt } from './canvas-camera'

export function localBounds(n: DesignNode): Bounds {
  return ((n.network || n.vectorGeometry || n.textPath || n.pathOffset) ? kernelBounds(n) : null) || { x: 0, y: 0, width: n.width, height: n.height }
}
/** A group's authored width can be stale after editing its descendants. Measure
 * children in the group's own axes instead of rotating a world AABB twice. */
export function selectionLocalBounds(doc: DesignDocument, id: string): Bounds {
  const n=doc.nodes[id]
  if(n.kind!=='group')return localBounds(n)
  const points=n.children.filter(id=>doc.nodes[id]?.visible).flatMap(id=>{
    const child=doc.nodes[id]
    return boxPoints(selectionLocalBounds(doc,id)).map(p=>apply(child.transform,p))
  })
  return points.length?bounds(points):localBounds(n)
}
/** Inspector/scale bounds only. An empty group falls back to its authored box.
 * Optional transform lets an edit use its draft transform with snapshot children. */
export function selectionParentBounds(doc: DesignDocument, id: string, transform: Matrix = doc.nodes[id].transform): Bounds {
  return bounds(boxPoints(selectionLocalBounds(doc, id)).map(point => apply(transform, point)))
}
export function parentBounds(n: DesignNode): Bounds {
  return bounds(boxPoints(localBounds(n)).map((p) => apply(n.transform, p)))
}
/** Clockwise degrees of an affine x-axis. This is the inspector "旋转 °" value.
 * Positive is clockwise on the y-down canvas, matching Mac Figma and
 * `figma_rotation::clockwise_degrees`. */
export function clockwiseDegrees(matrix: Matrix) {
  const degrees = (Math.atan2(matrix[1], matrix[0]) * 180) / Math.PI
  if (!Number.isFinite(degrees) || Object.is(degrees, -0)) return 0
  return degrees
}
export function rotationDegrees(n: DesignNode) {
  return clockwiseDegrees(n.transform)
}
/** Local clockwise angle after `delta` is applied in world space. Null when
 * the parent cannot be inverted. The canvas hint and the inspector both use it. */
export function localClockwiseAfter(parent: Matrix, worldStart: Matrix, delta: Matrix) {
  try { return clockwiseDegrees(multiply(inverse(parent), multiply(delta, worldStart))) }
  catch { return null }
}
/** Shift-snap that local angle onto 15° steps. A reflected parent conjugates
 * the correction so the number the inspector stores still lands on the step. */
export function snapLocalClockwise(parent: Matrix, worldStart: Matrix, delta: Matrix, center: Point): Matrix {
  const angle = localClockwiseAfter(parent, worldStart, delta)
  if (angle === null) return delta
  const snapped = Math.round(angle / 15) * 15
  const correction = snapped - angle
  if (Math.abs(correction) < 1e-6) return delta
  const det = parent[0] * parent[3] - parent[1] * parent[2]
  const worldTurn = det < 0 ? -correction : correction
  return multiply(around(center, rotate(worldTurn)), delta)
}
export function rotateNode(n: DesignNode, degrees: number, b = localBounds(n)) {
  const center = apply(n.transform, { x: b.x + b.width / 2, y: b.y + b.height / 2 })
  n.transform = multiply(around(center, rotate(degrees - rotationDegrees(n))), n.transform)
}
/** Pixel-grid snap for a vector point. Control suspends it only once the
 * pixel grid is drawn at this zoom. Layer move and resize keep their own rule
 * and do not use this vector exception. */
export const vectorPointSnaps = (snapPixels: boolean, ctrlKey: boolean, zoom: number) =>
  snapPixels && !(ctrlKey && pixelGridVisible(zoom))
export function snapMove(
  box: Bounds,
  delta: Point,
  enabled: boolean,
  axes = { x: true, y: true },
): Point {
  if (!enabled) return delta
  const p = kernelSnapPoint({ x: box.x + delta.x, y: box.y + delta.y })
  return { x: axes.x ? p.x - box.x : delta.x, y: axes.y ? p.y - box.y : delta.y }
}
export function createBox(a: Point, b: Point, snap: boolean): Bounds {
  if (snap) {
    a = kernelSnapPoint(a)
    b = kernelSnapPoint(b)
  }
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  }
}
export function resizeInBasis(
  basis: Matrix,
  box: Bounds,
  start: Point,
  end: Point,
  corner: number,
  aspect: boolean,
  center: boolean,
  snap: boolean,
  pixelAxes?: { x: boolean; y: boolean },
): Matrix {
  const inv = inverse(basis),
    a = apply(inv, start),
    b = apply(inv, end)
  const corners = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ]
  const edge = corner >= 4 ? corner - 4 : -1
  const opposite = edge >= 0 ? (edge + 2) % 4 : -1
  const anchor = center
    ? { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    : edge >= 0 ? { x: (corners[opposite].x + corners[(opposite+1)%4].x)/2, y: (corners[opposite].y + corners[(opposite+1)%4].y)/2 }
    : corners[(corner + 2) % 4]
  const horizontal = edge < 0 || edge % 2 === 1, vertical = edge < 0 || edge % 2 === 0
  let sx = horizontal && box.width > 1e-10 ? (b.x - anchor.x) / (a.x - anchor.x || 1) : 1,
    sy = vertical && box.height > 1e-10 ? (b.y - anchor.y) / (a.y - anchor.y || 1) : 1
  // A 1% magnitude floor keeps the matrix invertible. The sign stays, so the
  // handle can cross the opposite edge and mirror that axis.
  sx = sx < 0 ? Math.min(-0.01, sx) : Math.max(0.01, sx)
  sy = sy < 0 ? Math.min(-0.01, sy) : Math.max(0.01, sy)
  if (aspect) {
    if (edge >= 0) {
      const primary = horizontal ? sx : sy
      if (primary >= 0) sx = sy = primary
      else {
        const magnitude = Math.abs(primary)
        sx = horizontal ? primary : magnitude
        sy = vertical ? primary : magnitude
      }
    } else if (sx < 0 || sy < 0) {
      const magnitude = Math.max(Math.abs(sx), Math.abs(sy))
      sx = (sx < 0 ? -1 : 1) * magnitude
      sy = (sy < 0 ? -1 : 1) * magnitude
    } else sx = sy = Math.max(sx, sy)
  }
  if (snap) {
    const allowX = pixelAxes?.x !== false
    const allowY = pixelAxes?.y !== false
    const signOf = (scale: number) => scale < 0 ? -1 : 1
    const size = kernelSnapPoint({ x: Math.abs(box.width * sx), y: Math.abs(box.height * sy) })
    if (aspect) {
      if (allowX && allowY) {
        const factor =
          box.width >= box.height
            ? Math.max(1, size.x) / Math.max(box.width, 1e-10)
            : Math.max(1, size.y) / Math.max(box.height, 1e-10)
        sx = signOf(sx) * factor
        sy = signOf(sy) * factor
      }
    } else {
      if (allowX && horizontal && box.width > 1e-10) sx = signOf(sx) * Math.max(1, size.x) / box.width
      if (allowY && vertical && box.height > 1e-10) sy = signOf(sy) * Math.max(1, size.y) / box.height
    }
  }
  return multiply(basis, multiply(around(anchor, [sx, 0, 0, sy, 0, 0]), inv))
}

export type ResizeSnapGuide = { axis: 'x' | 'y'; position: number; start: number; end: number }
export type ResizeSnapQuery = (moving: Bounds, threshold: number) => {
  dx: number
  dy: number
  guides: [ResizeSnapGuide | null, ResizeSnapGuide | null]
  targetSpans?: [readonly [number, number] | null, readonly [number, number] | null]
}
export type ResizeSnapEnd = {
  end: Point
  guides: [ResizeSnapGuide | null, ResizeSnapGuide | null]
  targetSpans: [readonly [number, number] | null, readonly [number, number] | null]
  snapped: { x: boolean; y: boolean }
}

export function resizeBasisIsAxisAligned(basis: Matrix): boolean {
  return Math.abs(basis[1]) <= 1e-8 && Math.abs(basis[2]) <= 1e-8
}

function resizeHandlePoint(box: Bounds, corner: number): Point {
  const right = box.x + box.width, bottom = box.y + box.height
  const corners = [
    { x: box.x, y: box.y },
    { x: right, y: box.y },
    { x: right, y: bottom },
    { x: box.x, y: bottom },
  ]
  if (corner < 4) return corners[corner] ?? corners[2]
  const edge = corner - 4
  const a = corners[edge] ?? corners[0], b = corners[(edge + 1) % 4]
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

function queryResizeLine(query: ResizeSnapQuery, axis: 'x' | 'y', position: number, proposed: Bounds, threshold: number) {
  const moving = axis === 'x'
    ? { x: position, y: proposed.y, width: 0, height: proposed.height }
    : { x: proposed.x, y: position, width: proposed.width, height: 0 }
  const hit = query(moving, threshold)
  const slot = axis === 'x' ? 0 : 1
  const guide = hit.guides[slot]
  const delta = axis === 'x' ? hit.dx : hit.dy
  if (!guide || guide.axis !== axis || !Number.isFinite(delta)) return null
  return { delta, guide, span: hit.targetSpans?.[slot] ?? null }
}

/** Find a world guide by correcting the pointer within the existing resize
 * transform. This leaves the opposite edge or the center at its anchor. */
function rotatedResizeSnapEnd(
  proposed: Bounds, end: Point, threshold: number, query: ResizeSnapQuery,
  measure: (at: Point) => Bounds, proportionalDirection?: Point,
): ResizeSnapEnd | undefined {
  type Axis = 'x' | 'y'
  const coordinate = (rect: Bounds, axis: Axis, fraction: number) =>
    axis === 'x' ? rect.x + rect.width * fraction : rect.y + rect.height * fraction
  const move = (dx: number, dy: number) => ({ x: end.x + dx, y: end.y + dy })
  const step = Math.min(0.25, threshold / 8)
  const magnitude = proportionalDirection ? Math.hypot(proportionalDirection.x, proportionalDirection.y) : 1
  if (magnitude < 1e-8) return
  const directions = proportionalDirection
    ? [{ x: proportionalDirection.x / magnitude, y: proportionalDirection.y / magnitude }]
    : [{ x: 1, y: 0 }, { x: 0, y: 1 }]
  const probes = directions.map(({ x, y }) => ({
    x, y,
    before: measure(move(-step * x, -step * y)),
    after: measure(move(step * x, step * y)),
  }))
  const landed = (pose: Bounds, axis: Axis, fraction: number, guide: ResizeSnapGuide) =>
    Math.abs(coordinate(pose, axis, fraction) - guide.position) <= 1e-4
  const pick = (axis: Axis) => {
    type Hit = NonNullable<ReturnType<typeof queryResizeLine>> & {
      gradient: Point; fraction: number; pointer: Point; pose: Bounds; distance: number; limit: number
    }
    let best: Hit | undefined
    for (const fraction of [0, 1, 0.5]) {
      const gradient = { x: 0, y: 0 }
      for (const { x, y, before, after } of probes) {
        const slope = (coordinate(after, axis, fraction) - coordinate(before, axis, fraction)) / (2 * step)
        gradient.x += x * slope
        gradient.y += y * slope
      }
      const scale = gradient.x ** 2 + gradient.y ** 2
      if (!(scale > 1e-12)) continue
      const hit = queryResizeLine(query, axis, coordinate(proposed, axis, fraction), proposed, threshold)
      if (!hit) continue
      const dx = hit.delta * gradient.x / scale, dy = hit.delta * gradient.y / scale
      const distance = Math.hypot(dx, dy)
      // A nearly perpendicular target must not pull the handle a long way.
      // A center moves half as far as a resize edge.
      const limit = threshold * (fraction === 0.5 ? 2 : 1)
      if (!(distance <= limit) || (best && best.distance <= distance)) continue
      const pointer = move(dx, dy), pose = measure(pointer)
      if (landed(pose, axis, fraction, hit.guide)) best = { ...hit, gradient, fraction, pointer, pose, distance, limit }
    }
    return best
  }
  const x = pick('x'), y = pick('y')
  if (!x && !y) return
  const pack = (pointer: Point, pose: Bounds): ResizeSnapEnd => {
    const gx = x && landed(pose, 'x', x.fraction, x.guide) ? x : undefined
    const gy = y && landed(pose, 'y', y.fraction, y.guide) ? y : undefined
    return {
      end: pointer, guides: [gx?.guide ?? null, gy?.guide ?? null],
      targetSpans: [gx?.span ?? null, gy?.span ?? null], snapped: { x: !!gx, y: !!gy },
    }
  }
  if (x && y) {
    // A free corner can satisfy two independent guides. An edge or a
    // proportional resize has only one usable direction.
    const a = x.gradient, b = y.gradient
    const determinant = a.x * b.y - a.y * b.x
    if (Math.abs(determinant) > 1e-8) {
      const dx = (x.delta * b.y - a.y * y.delta) / determinant
      const dy = (a.x * y.delta - x.delta * b.x) / determinant
      if (Math.hypot(dx, dy) <= Math.hypot(x.limit, y.limit)) {
        const pointer = move(dx, dy)
        const combined = pack(pointer, measure(pointer))
        if (combined.snapped.x && combined.snapped.y) return combined
      }
    }
  }
  const nearest = x && (!y || x.distance <= y.distance) ? x : y!
  return pack(nearest.pointer, nearest.pose)
}

export function resizeSnapEnd(
  basis: Matrix,
  box: Bounds,
  start: Point,
  end: Point,
  corner: number,
  aspect: boolean,
  center: boolean,
  threshold: number,
  query: ResizeSnapQuery,
): ResizeSnapEnd {
  const none = (): ResizeSnapEnd => ({
    end, guides: [null, null], targetSpans: [null, null], snapped: { x: false, y: false },
  })
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1e4) return none()
  let preliminary: Matrix
  try { preliminary = resizeInBasis(basis, box, start, end, corner, aspect, center, false) }
  catch { return none() }
  const worldCorners = boxPoints(box).map(point => apply(basis, point))
  const outerBounds = (matrix: Matrix) => bounds(worldCorners.map(point => apply(matrix, point)))
  const proposed = outerBounds(preliminary)
  if (!resizeBasisIsAxisAligned(basis)) {
    const measure = (at: Point) => outerBounds(resizeInBasis(basis, box, start, at, corner, aspect, center, false))
    let proportionalDirection: Point | undefined
    if (aspect && corner < 4) {
      const anchor = apply(basis, center
        ? { x: box.x + box.width / 2, y: box.y + box.height / 2 }
        : resizeHandlePoint(box, (corner + 2) % 4))
      proportionalDirection = { x: end.x - anchor.x, y: end.y - anchor.y }
    }
    return rotatedResizeSnapEnd(proposed, end, threshold, query, measure, proportionalDirection) ?? none()
  }
  const local = resizeHandlePoint(box, corner)
  const at = (matrix: Matrix) => apply(matrix, apply(basis, local))
  const worldHandle = at(preliminary)
  const edge = corner >= 4 ? corner - 4 : -1
  const horizontal = edge < 0 || edge % 2 === 1
  const vertical = edge < 0 || edge % 2 === 0
  const mode = (active: boolean): 'move' | 'both' | 'none' => !active ? 'none' : center ? 'both' : 'move'
  type Pick = {
    pointerDelta: number
    guide: ResizeSnapGuide
    span: readonly [number, number] | null
    align: 'handle' | 'center' | 'opposite'
  }
  const choose = (axis: 'x' | 'y', kind: 'move' | 'both' | 'none'): Pick | null => {
    if (kind === 'none') return null
    const low = axis === 'x' ? proposed.x : proposed.y
    const size = axis === 'x' ? proposed.width : proposed.height
    const high = low + size
    const handle = axis === 'x' ? worldHandle.x : worldHandle.y
    const picks: (Pick & { feature: number; rank: number })[] = []
    const push = (position: number, scale: number, rank: number, align: Pick['align']) => {
      const hit = queryResizeLine(query, axis, position, proposed, threshold)
      if (!hit || !Number.isFinite(hit.delta * scale)) return
      picks.push({
        pointerDelta: hit.delta * scale, guide: hit.guide, span: hit.span, align,
        feature: Math.abs(hit.delta), rank,
      })
    }
    if (kind === 'both') {
      const pointerLow = Math.abs(handle - low) <= Math.abs(handle - high)
      push(pointerLow ? low : high, 1, 0, 'handle')
      push(pointerLow ? high : low, -1, 1, 'opposite')
    } else {
      push(handle, 1, 0, 'handle')
      push(low + size / 2, 2, 1, 'center')
    }
    picks.sort((a, b) => Math.abs(a.pointerDelta) - Math.abs(b.pointerDelta) || a.feature - b.feature || a.rank - b.rank)
    return picks[0] ?? null
  }
  const picked = { x: choose('x', mode(horizontal)), y: choose('y', mode(vertical)) }
  if (!picked.x && !picked.y) return none()
  const slope = (axis: 'x' | 'y') => {
    const nudged = axis === 'x' ? { x: end.x + 1, y: end.y } : { x: end.x, y: end.y + 1 }
    try {
      const moved = at(resizeInBasis(basis, box, start, nudged, corner, aspect, center, false))
      return axis === 'x' ? moved.x - worldHandle.x : moved.y - worldHandle.y
    } catch { return 0 }
  }
  const shift = (axis: 'x' | 'y', pick: Pick) => {
    const scale = slope(axis)
    if (!Number.isFinite(scale) || Math.abs(scale) < 1e-6) return null
    const delta = pick.pointerDelta / scale
    return Number.isFinite(delta) ? delta : null
  }
  const placed = (next: Point, axis: 'x' | 'y', pick: Pick) => {
    try {
      const matrix = resizeInBasis(basis, box, start, next, corner, aspect, center, false)
      const handle = at(matrix)
      const rect = outerBounds(matrix)
      const low = axis === 'x' ? rect.x : rect.y
      const size = axis === 'x' ? rect.width : rect.height
      const high = low + size
      const handleCoord = axis === 'x' ? handle.x : handle.y
      const value = pick.align === 'handle' ? handleCoord
        : pick.align === 'center' ? low + size / 2
        : Math.abs(handleCoord - low) <= Math.abs(handleCoord - high) ? high : low
      return Math.abs(value - pick.guide.position) <= 1e-4
    } catch { return false }
  }
  const from = (dx: number, dy: number): Point => ({ x: end.x + dx, y: end.y + dy })
  const pack = (next: Point, x: Pick | null, y: Pick | null): ResizeSnapEnd => ({
    end: next,
    guides: [x?.guide ?? null, y?.guide ?? null],
    targetSpans: [x?.span ?? null, y?.span ?? null],
    snapped: { x: !!x, y: !!y },
  })
  let useX = picked.x, useY = picked.y
  if (aspect && useX && useY) {
    const options = (['x', 'y'] as const).flatMap(axis => {
      const pick = axis === 'x' ? useX : useY
      if (!pick) return []
      const delta = shift(axis, pick)
      if (delta === null) return []
      const next = from(axis === 'x' ? delta : 0, axis === 'y' ? delta : 0)
      return placed(next, axis, pick) ? [{ axis, delta, next }] : []
    }).sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta))
    const best = options[0]
    if (!best) return none()
    return pack(best.next, best.axis === 'x' ? useX : null, best.axis === 'y' ? useY : null)
  }
  const dx = useX ? shift('x', useX) : 0
  const dy = useY ? shift('y', useY) : 0
  if (dx === null) useX = null
  if (dy === null) useY = null
  const accept = (x: Pick | null, y: Pick | null) => {
    if (!x && !y) return null
    const next = from(x ? dx ?? 0 : 0, y ? dy ?? 0 : 0)
    if (x && !placed(next, 'x', x)) return null
    if (y && !placed(next, 'y', y)) return null
    return pack(next, x, y)
  }
  return accept(useX, useY) ?? accept(useX, null) ?? accept(null, useY) ?? none()
}
