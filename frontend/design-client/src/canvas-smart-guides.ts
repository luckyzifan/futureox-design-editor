import { smart_guides_snap, SmartGuidesIndex } from './generated/design-kernel/design_kernel'
import { kernelModuleReady } from './kernel/module'
import type { Bounds } from './model'

export type SmartGuideSegment = {
  axis: 'x' | 'y'
  /** World coordinate of the guide line. */
  position: number
  /** Extent of the drawn segment along the other axis. */
  start: number
  end: number
}
export type SmartSnapResult = {
  dx: number
  dy: number
  guides: [SmartGuideSegment | null, SmartGuideSegment | null]
  targetSpans?: [readonly [number, number] | null, readonly [number, number] | null]
}

/** Preserve fractional world coordinates through the kernel snap query. */
export function flatRects(rects: Bounds[]): Float64Array {
  const values = new Float64Array(rects.length * 4)
  rects.forEach((r, i) => values.set([r.x, r.y, r.width, r.height], i * 4))
  return values
}

/** Parse the kernel JSON back into finite numbers, failing closed so a
 * malformed payload can never displace a drag. */
export function parseSmartSnap(json: string): SmartSnapResult {
  const parsed = JSON.parse(json) as { dx?: unknown; dy?: unknown; guides?: unknown; targetSpans?: unknown }
  const guide = (value: unknown): SmartGuideSegment | null => {
    if (!value || typeof value !== 'object') return null
    const g = value as Record<string, unknown>
    const position = Number(g.position),
      start = Number(g.start),
      end = Number(g.end)
    if (g.axis !== 'x' && g.axis !== 'y') return null
    return [position, start, end].every(Number.isFinite)
      ? { axis: g.axis, position, start, end }
      : null
  }
  const dx = Number(parsed.dx),
    dy = Number(parsed.dy),
    list = Array.isArray(parsed.guides) ? parsed.guides : []
  const span = (value: unknown): readonly [number, number] | null => Array.isArray(value) && value.length === 2 &&
    value.every(v => typeof v === 'number' && Number.isFinite(v)) && value[0] <= value[1] ? [value[0],value[1]] : null
  return {
    dx: Number.isFinite(dx) ? dx : 0,
    dy: Number.isFinite(dy) ? dy : 0,
    guides: [guide(list[0]), guide(list[1])],
    ...(Array.isArray(parsed.targetSpans) ? { targetSpans:[span(parsed.targetSpans[0]),span(parsed.targetSpans[1])] as SmartSnapResult['targetSpans'] } : {}),
  }
}

/** Draw the solver's chosen targets against the final constrained rectangle.
 * This changes chrome extents only; Rust remains the alignment authority. */
export function placedSmartGuides(result: SmartSnapResult | undefined, moving: Bounds, axes: {x:boolean;y:boolean}) {
  const project = (slot: 0 | 1): SmartGuideSegment | undefined => {
    const guide = result?.guides[slot]
    if (!guide || !(slot === 0 ? axes.x : axes.y)) return
    const span = result?.targetSpans?.[slot]
    const start = slot === 0 ? moving.y : moving.x, end = start + (slot === 0 ? moving.height : moving.width)
    return { ...guide, start:Math.min(span?.[0] ?? guide.start,start), end:Math.max(span?.[1] ?? guide.end,end) }
  }
  return { x:project(0), y:project(1) }
}

const NO_SNAP: SmartSnapResult = { dx: 0, dy: 0, guides: [null, null] }

/** Kernel smart-guide snapping over world rects: `moving` is the dragged
 * rect, `parent` its immediate container, `siblings` every other snap target
 * on the page (ruler guides join as zero-width/zero-height rects). */
export function smartGuidesSnapWorld(
  moving: Bounds,
  parent: Bounds | undefined,
  siblings: Bounds[],
  threshold: number,
): SmartSnapResult {
  if (!kernelModuleReady() || !Number.isFinite(threshold) || threshold <= 0) return NO_SNAP
  const result = parseSmartSnap(
    smart_guides_snap(
      flatRects([moving]),
      parent ? flatRects([parent]) : null,
      flatRects(siblings),
      threshold,
    ),
  )
  // The kernel admits |delta| <= threshold; the historical canvas behavior is
  // strictly exclusive, so boundary deltas snap to nothing.
  if (result.guides[0] && Math.abs(result.dx) >= threshold) {
    result.guides[0] = null
    result.dx = 0
  }
  if (result.guides[1] && Math.abs(result.dy) >= threshold) {
    result.guides[1] = null
    result.dy = 0
  }
  return result
}

/** One owned native index per immutable gesture target set. */
export function createSmartGuidesIndex(parent: Bounds | undefined, siblings: Bounds[]) {
  if (!kernelModuleReady()) return
  const index = new SmartGuidesIndex(parent ? flatRects([parent]) : null, flatRects(siblings))
  return {
    free: () => index.free(),
    snap: (moving: Bounds, threshold: number): SmartSnapResult => {
      const result = parseSmartSnap(index.snap(flatRects([moving]), threshold))
      if (result.guides[0] && Math.abs(result.dx) >= threshold) { result.guides[0] = null; result.dx = 0 }
      if (result.guides[1] && Math.abs(result.dy) >= threshold) { result.guides[1] = null; result.dy = 0 }
      return result
    },
  }
}
