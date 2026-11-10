import type { Point, Matrix } from './model'
import { around, rotate, pointInContours } from './geometry'
import { formatAngleDegrees, normalizeDegrees } from './angle-text'
export { formatAngleDegrees, normalizeDegrees } from './angle-text'

/** At overview zoom the fixed-size handles can cover the whole object. Keep
 * its interior available for moving; the exterior still resizes/rotates. */
export function smallSelectionInterior(corners: Point[], zoom: number, point: Point) {
  return corners.length === 4 && corners.some((p, i) => {
    const q = corners[(i + 1) % 4]
    return Math.hypot(q.x - p.x, q.y - p.y) * zoom < 16
  }) && pointInContours(point, [corners])
}

const unit = (p: Point, q: Point) => {
  const length = Math.hypot(q.x - p.x, q.y - p.y)
  return length > 1e-10 ? { x: (q.x - p.x) / length, y: (q.y - p.y) / length } : null
}
const cursorCache = new Map<string, string>()
/** CSS cursors use screen-space directions, including reflected/rotated parents. */
export function transformCursor(kind: 'resize' | 'rotate', angle: number) {
  const degrees = ((Math.round(angle / 5) * 5) % 360 + 360) % 360
  const key = `${kind}:${degrees}`
  if (cursorCache.has(key)) return cursorCache.get(key)!
  const d = kind === 'resize'
    ? 'M5 12H19 M9 8L5 12L9 16 M15 8L19 12L15 16'
    : 'M5 16A8 8 0 0 1 19 16 M5 16L4 10 M5 16L11 14 M19 16L20 10 M19 16L13 14'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g transform="rotate(${degrees} 12 12)" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="${d}" stroke="white" stroke-width="3.5"/><path d="${d}" stroke="#181818" stroke-width="1.5"/></g></svg>`
  const result = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, crosshair`
  cursorCache.set(key, result)
  return result
}

/** Exterior L regions leave the object interior and resize handles untouched.
 * Sizes are CSS pixels regardless of zoom or nonuniform parent transforms. */
export function selectionHandles(corners: Point[], zoom: number) {
  return corners.map((p, index) => {
    const next = corners[(index + 1) % 4], prev = corners[(index + 3) % 4]
    const u = unit(p, next) || { x: 1, y: 0 }, v = unit(p, prev) || { x: -u.y, y: u.x }
    const at = (x: number, y: number) => ({ x: p.x + (u.x * x + v.x * y) / zoom, y: p.y + (u.y * x + v.y * y) / zoom })
    const outward = Math.atan2(-u.y - v.y, -u.x - v.x) * 180 / Math.PI
    return {
      index, point: p, next,
      // Outside the corner and clear of the resize square. The grab is about
      // 32 CSS px, so a second drag still hits the handle after the box turns.
      rotatePoints: [[-32,-32],[14,-32],[14,-10],[-10,-10],[-10,14],[-32,14]].map(([x,y]) => at(x,y)),
      rotateAnchor: at(-20,-20),
      resizePoints: [[-4,-4],[4,-4],[4,4],[-4,4]].map(([x,y]) => at(x,y)),
      resizeCursor: transformCursor('resize', outward),
      rotateCursor: transformCursor('rotate', outward + 90),
      edgeCursor: transformCursor('resize', Math.atan2(u.y,u.x) * 180 / Math.PI + 90),
    }
  })
}

export function selectionRotation(center: Point, start: Point, end: Point, initialDegrees: number, snap: boolean): { matrix: Matrix; degrees: number } {
  const raw = normalizeDegrees((Math.atan2(end.y - center.y, end.x - center.x) - Math.atan2(start.y - center.y, start.x - center.x)) * 180 / Math.PI)
  const absolute = initialDegrees + raw
  const snapped = snap ? Math.round(absolute / 15) * 15 : absolute
  const delta = snapped - initialDegrees
  return { matrix: around(center, rotate(delta)), degrees: normalizeDegrees(snapped) }
}
