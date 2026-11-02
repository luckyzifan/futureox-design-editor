import type { Bounds, Point } from './model'
export type MeasurementAxis = 'horizontal' | 'vertical'
export type Measurement = { from: Point; to: Point; distance: number; axis: MeasurementAxis }
const EPS = 1e-9
const encloses = (outer: Bounds, inner: Bounds) => outer.x <= inner.x + EPS && outer.y <= inner.y + EPS
  && outer.x + outer.width + EPS >= inner.x + inner.width && outer.y + outer.height + EPS >= inner.y + inner.height
const segment = (x: number, y: number, u: number, v: number, axis: MeasurementAxis): Measurement =>
  ({ from: { x, y }, to: { x: u, y: v }, distance: Math.hypot(u - x, v - y), axis })

/** Figma Mac Option/Alt spacing between a selection and one other box.
 * The first box is the selection. A containing pair reports the four edge
 * paddings. Each separated axis reports only that positive gap: centered on
 * the perpendicular overlap, or sitting on the selection's facing edge when
 * the ranges miss, so a diagonal pair forms an L. An overlapping axis does
 * not draw an edge-to-edge offset. */
export function measureBounds(selection: Bounds, target: Bounds): Measurement[] {
  if (encloses(selection, target) || encloses(target, selection)) {
    const outer = encloses(selection, target) ? selection : target
    const inner = outer === selection ? target : selection
    const cx = inner.x + inner.width / 2, cy = inner.y + inner.height / 2
    return [
      segment(outer.x, cy, inner.x, cy, 'horizontal'),
      segment(inner.x + inner.width, cy, outer.x + outer.width, cy, 'horizontal'),
      segment(cx, outer.y, cx, inner.y, 'vertical'),
      segment(cx, inner.y + inner.height, cx, outer.y + outer.height, 'vertical'),
    ].filter(item => item.distance > EPS)
  }
  const result: Measurement[] = []
  const y0 = Math.max(selection.y, target.y), y1 = Math.min(selection.y + selection.height, target.y + target.height)
  const x0 = Math.max(selection.x, target.x), x1 = Math.min(selection.x + selection.width, target.x + target.width)
  const yOverlap = y0 <= y1 + EPS, xOverlap = x0 <= x1 + EPS
  const horizontalY = yOverlap ? (y0 + y1) / 2 : target.y + target.height <= selection.y + EPS ? selection.y : selection.y + selection.height
  const verticalX = xOverlap ? (x0 + x1) / 2 : target.x + target.width <= selection.x + EPS ? selection.x : selection.x + selection.width
  if (selection.x + selection.width <= target.x + EPS) result.push(segment(selection.x + selection.width, horizontalY, target.x, horizontalY, 'horizontal'))
  else if (target.x + target.width <= selection.x + EPS) result.push(segment(target.x + target.width, horizontalY, selection.x, horizontalY, 'horizontal'))
  if (selection.y + selection.height <= target.y + EPS) result.push(segment(verticalX, selection.y + selection.height, verticalX, target.y, 'vertical'))
  else if (target.y + target.height <= selection.y + EPS) result.push(segment(verticalX, target.y + target.height, verticalX, selection.y, 'vertical'))
  return result.filter(item => item.distance > EPS)
}

/** Six CSS pixels, perpendicular, centered on each end. Length is in world units. */
export function measurementTicks(measurement: Pick<Measurement, 'from' | 'to' | 'axis'>, zoom: number): [Point, Point][] {
  const half = 3 / (Number.isFinite(zoom) && zoom > EPS ? zoom : 1)
  const cap = (point: Point): [Point, Point] => measurement.axis === 'horizontal'
    ? [{ x: point.x, y: point.y - half }, { x: point.x, y: point.y + half }]
    : [{ x: point.x - half, y: point.y }, { x: point.x + half, y: point.y }]
  return [cap(measurement.from), cap(measurement.to)]
}

/** Screen-pixel label placement. The red number sits on the segment; a short
 * gap steps aside so the glyph clears the ticks. */
export function measurementLabel(measurement: Measurement, zoom = 1): { anchor: Point; offset: Point } {
  const anchor = { x: (measurement.from.x + measurement.to.x) / 2, y: (measurement.from.y + measurement.to.y) / 2 }
  const scale = Number.isFinite(zoom) && zoom > EPS ? zoom : 1
  const short = measurement.distance * scale < 28
  if (measurement.axis === 'vertical') return { anchor, offset: short ? { x: 16, y: -6 } : { x: 0, y: -6 } }
  return { anchor, offset: short ? { x: 0, y: -16 } : { x: 0, y: -6 } }
}
