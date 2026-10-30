import { smart_guides_snap } from './generated/design-kernel/design_kernel'
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
}

/** Bounds list -> flat [x,y,w,h] rows; the kernel rounds onto its integer grid. */
export function flatRects(rects: Bounds[]): Float64Array {
  const values = new Float64Array(rects.length * 4)
  rects.forEach((r, i) => values.set([r.x, r.y, r.width, r.height], i * 4))
  return values
}

/** Parse the kernel JSON back into finite numbers, failing closed so a
 * malformed payload can never displace a drag. */
export function parseSmartSnap(json: string): SmartSnapResult {
  const parsed = JSON.parse(json) as { dx?: unknown; dy?: unknown; guides?: unknown }
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
  return {
    dx: Number.isFinite(dx) ? dx : 0,
    dy: Number.isFinite(dy) ? dy : 0,
    guides: [guide(list[0]), guide(list[1])],
  }
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
