import { apply, inverse } from './geometry'
import type { DesignNode, Matrix, Paint, Point } from './model'

/** Same object-bounding-box line as Renderer.gradientLine and the kernel angle projection. */
function gradientLine(angle: number) {
  const radians = (angle * Math.PI) / 180
  const x = Math.cos(radians)
  const y = Math.sin(radians)
  const half = (Math.abs(x) + Math.abs(y)) / 2
  return { x1: 0.5 - x * half, y1: 0.5 - y * half, x2: 0.5 + x * half, y2: 0.5 + y * half }
}

/** TL, TR, BR, BL. Matches FIG import and the kernel rectangle. */
export type CornerIndex = 0 | 1 | 2 | 3

/** Radius consumed by each corner before smoothing. Same limit as design-kernel `fitted_radii`. */
export function fittedCornerRadii(width: number, height: number, radii: readonly number[]): [number, number, number, number] {
  const source = [0, 1, 2, 3].map((i) => {
    const value = radii[i] ?? 0
    return Number.isFinite(value) ? Math.max(0, value) : 0
  })
  return source.map((radius, index) => {
    if (radius === 0) return 0
    const horizontal = index === 0 ? 1 : index === 1 ? 0 : index === 2 ? 3 : 2
    const vertical = 3 - index
    const limit = Math.min(
      width * radius / (radius + source[horizontal]),
      height * radius / (radius + source[vertical]),
    )
    return Math.min(radius, limit)
  }) as [number, number, number, number]
}

export function rectangleCornerTarget(node: Pick<DesignNode, 'kind' | 'network' | 'vectorGeometry'>): boolean {
  return (node.kind === 'rectangle' || node.kind === 'frame' || node.kind === 'section') && !node.network && !node.vectorGeometry
}

export function cornerHandlePoint(width: number, height: number, radii: readonly number[], index: CornerIndex, minInset: number): Point {
  const fitted = fittedCornerRadii(width, height, radii)[index]
  const corner = [
    { x: 0, y: 0, ix: 1, iy: 1 },
    { x: width, y: 0, ix: -1, iy: 1 },
    { x: width, y: height, ix: -1, iy: -1 },
    { x: 0, y: height, ix: 1, iy: -1 },
  ][index]
  const inset = Math.max(fitted, Math.max(0, minInset) / Math.SQRT2)
  return {
    x: Math.max(0, Math.min(width, corner.x + corner.ix * inset)),
    y: Math.max(0, Math.min(height, corner.y + corner.iy * inset)),
  }
}

/** Authored radius from the pointer, before the kernel fits it against the neighbouring corners. */
export function cornerRadiusAtPointer(width: number, height: number, index: CornerIndex, local: Point): number {
  const inset = index === 0 ? Math.min(local.x, local.y)
    : index === 1 ? Math.min(width - local.x, local.y)
      : index === 2 ? Math.min(width - local.x, height - local.y)
        : Math.min(local.x, height - local.y)
  if (!Number.isFinite(inset)) return 0
  return Math.max(0, Math.min(inset, 1e7))
}

export function cornerRadiiAfterDrag(
  width: number, height: number, radii: readonly number[], index: CornerIndex, local: Point, uniform: boolean, start?: Point,
): [number, number, number, number] {
  let next = cornerRadiusAtPointer(width, height, index, local)
  if (start) {
    const dx = (local.x - start.x) * (index === 0 || index === 3 ? 1 : -1)
    const dy = (local.y - start.y) * (index < 2 ? 1 : -1)
    const change = Math.abs(dx) >= Math.abs(dy) ? dx : dy
    next = Number.isFinite(change) ? Math.max(0, Math.min(1e7, radii[index] + change)) : radii[index]
  }
  if (uniform) return [next, next, next, next]
  const copy: [number, number, number, number] = [
    radii[0] ?? 0, radii[1] ?? 0, radii[2] ?? 0, radii[3] ?? 0,
  ]
  copy[index] = next
  return copy
}

/** Direction of the analytic glass light for an unrotated node. Angle 0 points down. */
export function glassLightDirection(angleDeg: number): Point {
  const angle = (angleDeg * Math.PI) / 180 + Math.PI / 2
  return { x: Math.cos(angle), y: Math.sin(angle) }
}

export function glassLightAngle(dx: number, dy: number, snap: boolean, fallback: number): number {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return fallback
  let angle = Math.atan2(-dx, dy) * 180 / Math.PI
  if (snap) angle = Math.round(angle / 15) * 15
  angle = ((angle + 180) % 360 + 360) % 360 - 180
  return angle === -180 ? 180 : angle
}

export function glassHandleLocal(width: number, height: number, angleDeg: number, reach: number): Point {
  const direction = glassLightDirection(angleDeg)
  return { x: width / 2 + direction.x * reach, y: height / 2 + direction.y * reach }
}

export function firstGlass(node: Pick<DesignNode, 'effects'>): { index: number; angle: number } | null {
  const index = node.effects.findIndex((effect) => effect.visible && effect.kind === 'glass' && effect.glass)
  if (index < 0) return null
  return { index, angle: node.effects[index].glass!.lightAngle }
}

export function gradientEndpoints(width: number, height: number, angle: number): { start: Point; end: Point } {
  const line = gradientLine(angle)
  return {
    start: { x: line.x1 * width, y: line.y1 * height },
    end: { x: line.x2 * width, y: line.y2 * height },
  }
}

export function gradientAngleFromLocal(width: number, height: number, local: Point, snap: boolean, fallback: number): number {
  const dx = local.x - width / 2
  const dy = local.y - height / 2
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return fallback
  let angle = Math.atan2(dy, dx) * 180 / Math.PI
  if (snap) angle = Math.round(angle / 45) * 45
  return angle
}

export function gradientAngleHandle(width: number, height: number, angle: number, extra: number): Point {
  const ends = gradientEndpoints(width, height, angle)
  const dx = ends.end.x - ends.start.x
  const dy = ends.end.y - ends.start.y
  const length = Math.hypot(dx, dy) || 1
  return { x: ends.end.x + (dx / length) * extra, y: ends.end.y + (dy / length) * extra }
}

export function gradientStopPoint(width: number, height: number, angle: number, offset: number): Point {
  const ends = gradientEndpoints(width, height, angle)
  return {
    x: ends.start.x + (ends.end.x - ends.start.x) * offset,
    y: ends.start.y + (ends.end.y - ends.start.y) * offset,
  }
}

function boundedAxis(value: number, limit: number) {
  return Math.max(-limit, Math.min(limit, value))
}

/** Pointer delta in the node's local space, including parent scale, rotation, and flip. */
export function blurLocalDelta(matrix: Matrix, worldAt: Point, worldStart: Point) {
  const local = inverse(matrix)
  const at = apply(local, worldAt)
  const start = apply(local, worldStart)
  return { dx: at.x - start.x, dy: at.y - start.y }
}

/** Node-local gradient endpoint after one gesture. The limit matches effect validation. */
export function blurEndpointAfterDrag(point: readonly [number, number], dx: number, dy: number, limit = 1e7): [number, number] {
  return [boundedAxis(point[0] + dx, limit), boundedAxis(point[1] + dy, limit)]
}

/** Normalized zoom-blur focal point. A zero-area node cannot host a focus. */
export function zoomCenterAfterDrag(
  center: readonly [number, number], width: number, height: number, dx: number, dy: number, limit = 1e6,
): [number, number] | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width === 0 || height === 0) return
  const x = center[0] + dx / width
  const y = center[1] + dy / height
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  return [boundedAxis(x, limit), boundedAxis(y, limit)]
}

export function gradientStopOffset(start: Point, end: Point, local: Point): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = dx * dx + dy * dy
  if (length <= 1e-12) return 0
  return Math.max(0, Math.min(1, ((local.x - start.x) * dx + (local.y - start.y) * dy) / length))
}

/** The topmost visible fill, when it is an untransformed gradient the kernel evaluates from `angle`. */
export function editableGradient(node: Pick<DesignNode, 'fills'>): { index: number; paint: Paint } | null {
  for (let index = node.fills.length - 1; index >= 0; index -= 1) {
    const paint = node.fills[index]
    if (!paint.visible) continue
    if (!['linear', 'radial', 'angular', 'diamond'].includes(paint.kind) || paint.transform || paint.stops.length < 2) return null
    return { index, paint }
  }
  return null
}
