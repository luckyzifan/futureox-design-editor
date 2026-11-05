import type { Bounds, Point } from './model'
export type MeasurementAxis = 'horizontal' | 'vertical'
export type Measurement = { from: Point; to: Point; distance: number; axis: MeasurementAxis; tick?: boolean; role?: 'box' | 'span' | 'gap' | 'padding' }
export type SpacingPill = { text: string; anchor: Point; offset: Point }
/** Mac desktop Figma spacing red from gaps5. DOM and the GPU overlay both use this. */
export const SPACING_RED = '#e05634'
/** White type on the red distance pill. */
export const DISTANCE_PILL_TEXT = '#ffffff'
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

/** Mac desktop Figma: hold Option/Alt with a selection and the red guides
 * measure that selection against the layer the pointer would select. They do
 * not measure through the selection to whatever is stacked behind it, and
 * they stay off while a drag or Space-pan owns the pointer. */
export function altMeasurementTarget(input: {
  alt: boolean
  dragging: boolean
  space: boolean
  tool: string
  selection: readonly string[]
  hover: string | null
}): string | null {
  if (!input.alt || input.dragging || input.space || input.tool !== 'select') return null
  if (!input.selection.length || !input.hover || input.selection.includes(input.hover)) return null
  return input.hover
}

const distanceText = (value: number) => String(Number(value.toFixed(2)))
const boxEdges = (box: Bounds): Measurement[] => [
  segment(box.x, box.y, box.x + box.width, box.y, 'horizontal'),
  segment(box.x + box.width, box.y, box.x + box.width, box.y + box.height, 'vertical'),
  segment(box.x, box.y + box.height, box.x + box.width, box.y + box.height, 'horizontal'),
  segment(box.x, box.y, box.x, box.y + box.height, 'vertical'),
].map(item => ({ ...item, tick: false, role: 'box' as const })).filter(item => item.distance > EPS)

/** Mac gaps5 Option diagram. Side-by-side boxes get a red edge around each,
 * the width (or height) of each, and the gap. A gap too small for a pill is
 * labeled at both ends of the seam, as in the 1px crop. A box inside another
 * keeps the four edge paddings. */
export function spacingDiagram(selection: Bounds, target: Bounds, zoom = 1): { lines: Measurement[]; pills: SpacingPill[] } {
  const scale = Number.isFinite(zoom) && zoom > EPS ? zoom : 1
  const pills: SpacingPill[] = []
  const outline = [...boxEdges(selection), ...boxEdges(target)]
  if (encloses(selection, target) || encloses(target, selection)) {
    const gaps = measureBounds(selection, target).map(item => ({ ...item, tick: true, role: 'padding' as const }))
    for (const line of gaps) {
      const placed = measurementLabel(line, scale)
      pills.push({ text: distanceText(line.distance), anchor: placed.anchor, offset: placed.offset })
    }
    return { lines: [...outline, ...gaps], pills }
  }
  const y0 = Math.max(selection.y, target.y), y1 = Math.min(selection.y + selection.height, target.y + target.height)
  const x0 = Math.max(selection.x, target.x), x1 = Math.min(selection.x + selection.width, target.x + target.width)
  const yOverlap = y0 <= y1 + EPS, xOverlap = x0 <= x1 + EPS
  const selRight = selection.x + selection.width, tgtRight = target.x + target.width
  const selBottom = selection.y + selection.height, tgtBottom = target.y + target.height
  if (yOverlap && (selRight <= target.x + EPS || tgtRight <= selection.x + EPS)) {
    const left = selRight <= target.x + EPS ? selection : target
    const right = left === selection ? target : selection
    const gap = right.x - (left.x + left.width)
    const yMid = (y0 + y1) / 2
    const span = (box: Bounds): Measurement => ({ ...segment(box.x, yMid, box.x + box.width, yMid, 'horizontal'), tick: false, role: 'span' })
    const lines = [...outline, span(left), span(right)]
    if (gap > EPS) lines.push({ ...segment(left.x + left.width, yMid, right.x, yMid, 'horizontal'), tick: false, role: 'gap' })
    pills.push(
      { text: distanceText(left.width), anchor: { x: left.x + left.width / 2, y: yMid }, offset: { x: 0, y: 0 } },
      { text: distanceText(right.width), anchor: { x: right.x + right.width / 2, y: yMid }, offset: { x: 0, y: 0 } },
    )
    if (gap > EPS) {
      const gapX = (left.x + left.width + right.x) / 2
      const label = distanceText(gap)
      if (gap * scale < 18) pills.push(
        { text: label, anchor: { x: gapX, y: y0 }, offset: { x: 0, y: -12 } },
        { text: label, anchor: { x: gapX, y: y1 }, offset: { x: 0, y: 12 } },
      )
      else pills.push({ text: label, anchor: { x: gapX, y: yMid }, offset: { x: 0, y: -14 } })
    }
    return { lines: lines.filter(item => item.distance > EPS), pills }
  }
  if (xOverlap && (selBottom <= target.y + EPS || tgtBottom <= selection.y + EPS)) {
    const top = selBottom <= target.y + EPS ? selection : target
    const bottom = top === selection ? target : selection
    const gap = bottom.y - (top.y + top.height)
    const xMid = (x0 + x1) / 2
    const span = (box: Bounds): Measurement => ({ ...segment(xMid, box.y, xMid, box.y + box.height, 'vertical'), tick: false, role: 'span' })
    const lines = [...outline, span(top), span(bottom)]
    if (gap > EPS) lines.push({ ...segment(xMid, top.y + top.height, xMid, bottom.y, 'vertical'), tick: false, role: 'gap' })
    pills.push(
      { text: distanceText(top.height), anchor: { x: xMid, y: top.y + top.height / 2 }, offset: { x: 0, y: 0 } },
      { text: distanceText(bottom.height), anchor: { x: xMid, y: bottom.y + bottom.height / 2 }, offset: { x: 0, y: 0 } },
    )
    if (gap > EPS) {
      const gapY = (top.y + top.height + bottom.y) / 2
      const label = distanceText(gap)
      if (gap * scale < 18) pills.push(
        { text: label, anchor: { x: x0, y: gapY }, offset: { x: -14, y: 0 } },
        { text: label, anchor: { x: x1, y: gapY }, offset: { x: 14, y: 0 } },
      )
      else pills.push({ text: label, anchor: { x: xMid, y: gapY }, offset: { x: 14, y: 0 } })
    }
    return { lines: lines.filter(item => item.distance > EPS), pills }
  }
  const gaps = measureBounds(selection, target).map(item => ({ ...item, tick: true, role: 'gap' as const }))
  for (const line of gaps) {
    const placed = measurementLabel(line, scale)
    pills.push({ text: distanceText(line.distance), anchor: placed.anchor, offset: placed.offset })
  }
  return { lines: [...outline, ...gaps], pills }
}
