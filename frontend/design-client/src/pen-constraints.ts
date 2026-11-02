import type { Point } from './model'

/** Snap a point onto the nearest `step` ray from `origin`, keeping its distance.
 * Figma's pen uses 45° while Shift is held. */
export function constrainAngle(origin: Point, point: Point, step = Math.PI / 4): Point {
  const dx = point.x - origin.x, dy = point.y - origin.y
  const length = Math.hypot(dx, dy)
  if (!(length > 1e-6) || !Number.isFinite(length)) return { x: point.x, y: point.y }
  const snapped = Math.round(Math.atan2(dy, dx) / step) * step
  return { x: origin.x + Math.cos(snapped) * length, y: origin.y + Math.sin(snapped) * length }
}

/** Outgoing handle for a pen point. Option/Alt disconnects the mirror;
 * without it the incoming handle stays the point reflection of the outgoing one. */
export function penHandle(vertex: Point, pointer: Point, alt: boolean, shift: boolean): { outgoing: Point; mirror?: Point } {
  const outgoing = shift ? constrainAngle(vertex, pointer) : { x: pointer.x, y: pointer.y }
  if (alt) return { outgoing }
  return { outgoing, mirror: { x: 2 * vertex.x - outgoing.x, y: 2 * vertex.y - outgoing.y } }
}
