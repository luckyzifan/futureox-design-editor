import type { Bounds, Matrix, Point } from './model'
import type { TextVerticalMeasurement } from './kernel/picking'
export type MeasurementAxis = 'horizontal' | 'vertical'
export type Measurement = { from: Point; to: Point; distance: number; axis: MeasurementAxis; tick?: boolean; role?: 'box' | 'span' | 'gap' | 'padding'; dash?: boolean }
export type SpacingPill = { text: string; anchor: Point; offset: Point }
/** Mac desktop Figma spacing red from gaps5. DOM and the GPU overlay both use this. */
export const SPACING_RED = '#e05634'
/** White type on the red distance pill. */
export const DISTANCE_PILL_TEXT = '#ffffff'
/** CSS size of the distance numeral. DOM and the GPU measure chip share it. */
export const DISTANCE_PILL_FONT_SIZE = 11
/** Horizontal padding inside the red pill, CSS px. */
export const DISTANCE_PILL_PAD_X = 4
/** Extra CSS px added to the font size for the pill height. */
export const DISTANCE_PILL_EXTRA_HEIGHT = 4
/** CSS px from the pill top to the text baseline: font size plus this lead. */
export const DISTANCE_PILL_BASELINE_LEAD = 3
export const DISTANCE_PILL_RADIUS = 3
/**
 * CSS px from the measurement line to the near edge of the pill.
 * Help-center attachment 30101683610903 (not a live Figma 126.10.13 desktop
 * capture) shows about 12–13 device px of clearance. The selection handle in
 * that image is 16 device px, and these handles are 8 CSS px, so the image
 * reads as 2× and the clearance is about 6 CSS px.
 */
export const DISTANCE_PILL_GAP = 6

/** Screen-pixel width of a selection or distance chip. CJK counts as one em; Latin is narrower. */
export function selectionChromeChipWidth(text: string, size: number) {
  let em = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    em += code > 0xff ? 1 : code <= 0x20 ? 0.34 : 0.58
  }
  return Math.max(size * 0.5, em * size)
}
const EPS = 1e-9
const encloses = (outer: Bounds, inner: Bounds) => outer.x <= inner.x + EPS && outer.y <= inner.y + EPS
  && outer.x + outer.width + EPS >= inner.x + inner.width && outer.y + outer.height + EPS >= inner.y + inner.height
const segment = (x: number, y: number, u: number, v: number, axis: MeasurementAxis): Measurement =>
  ({ from: { x, y }, to: { x: u, y: v }, distance: Math.hypot(u - x, v - y), axis })

/** Project the two text edges onto the canvas Y axis; keep the box's X extent. */
export function textMeasurementBounds(box: Bounds, width: number, matrix: Matrix, text: TextVerticalMeasurement): Bounds {
  const [, b, , d, , originY] = matrix
  const left = Math.min(0, b * width), right = Math.max(0, b * width)
  const baseline = originY + d * text.baselineY
  const cap = text.capY === null ? null : originY + d * text.capY
  const top = d < 0 ? baseline + left : cap === null ? box.y : cap + left
  const bottom = d >= 0 ? baseline + right : cap === null ? box.y + box.height : cap + right
  return Number.isFinite(top) && Number.isFinite(bottom) && bottom > top ? { ...box, y: top, height: bottom - top } : box
}

const spanOverlap = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0)

/** Both axes have a positive overlap and neither box contains the other.
 * Figma measures each pair of matching edges (left to left, right to right,
 * top to top, bottom to bottom) through the midpoint of the other overlap.
 * Aligned edges are omitted. The Mac desktop 126.10.13 pixel check of this
 * formula is still outstanding. */
function partialOverlap(selection: Bounds, target: Bounds): Measurement[] | null {
  const sx1 = selection.x + selection.width, sy1 = selection.y + selection.height
  const tx1 = target.x + target.width, ty1 = target.y + target.height
  if (spanOverlap(selection.x, sx1, target.x, tx1) <= EPS) return null
  if (spanOverlap(selection.y, sy1, target.y, ty1) <= EPS) return null
  const mx = (Math.max(selection.x, target.x) + Math.min(sx1, tx1)) / 2
  const my = (Math.max(selection.y, target.y) + Math.min(sy1, ty1)) / 2
  return [
    segment(selection.x, my, target.x, my, 'horizontal'),
    segment(sx1, my, tx1, my, 'horizontal'),
    segment(mx, selection.y, mx, target.y, 'vertical'),
    segment(mx, sy1, mx, ty1, 'vertical'),
  ].filter(item => item.distance > EPS)
}

/** Figma Mac Option/Alt spacing between a selection and one other box.
 * The first box is the selection. A containing pair reports the four edge
 * paddings. A partial overlap reports the matching-edge offsets. Each
 * separated axis reports only that positive gap: centered on the
 * perpendicular overlap, or sitting on the selection's facing edge when the
 * ranges miss, so a diagonal pair forms an L. */
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
  const overlap = partialOverlap(selection, target)
  if (overlap) return overlap
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

/** Screen-pixel label placement. Padding pills sit below a horizontal line and
 * to the right of a vertical line. Other segments keep the shorter label
 * stepped off the ticks. The offset is the text baseline. */
export function measurementLabel(measurement: Measurement, zoom = 1): { anchor: Point; offset: Point } {
  const anchor = { x: (measurement.from.x + measurement.to.x) / 2, y: (measurement.from.y + measurement.to.y) / 2 }
  if (measurement.role === 'padding') {
    const text = distanceText(measurement.distance)
    const baselineFromTop = DISTANCE_PILL_FONT_SIZE + DISTANCE_PILL_BASELINE_LEAD
    if (measurement.axis === 'vertical') {
      const boxW = selectionChromeChipWidth(text, DISTANCE_PILL_FONT_SIZE) + DISTANCE_PILL_PAD_X * 2
      const boxH = DISTANCE_PILL_FONT_SIZE + DISTANCE_PILL_EXTRA_HEIGHT
      return { anchor, offset: { x: DISTANCE_PILL_GAP + boxW / 2, y: baselineFromTop - boxH / 2 } }
    }
    return { anchor, offset: { x: 0, y: DISTANCE_PILL_GAP + baselineFromTop } }
  }
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
  /** Dev Mode shows the same guides on hover, without Option/Alt. */
  inspect?: boolean
  dragging: boolean
  space: boolean
  tool: string
  selection: readonly string[]
  hover: string | null
}): string | null {
  if ((!input.alt && !input.inspect) || input.dragging || input.space || input.tool !== 'select') return null
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
    const gaps = measureBounds(selection, target).map(item => ({ ...item, tick: false, role: 'padding' as const }))
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

/** Gap from a selection box to one axis-aligned ruler guide.
 * Outside the box, one line from the near edge. Crossing the box, both sides. */
export function measureToGuide(selection: Bounds, guide: { axis: 'x' | 'y'; position: number }): Measurement[] {
  const mark = (line: Measurement): Measurement => ({ ...line, tick: false, role: 'gap' })
  if (guide.axis === 'x') {
    const y = selection.y + selection.height / 2
    const left = selection.x, right = selection.x + selection.width
    if (guide.position < left - EPS) return [mark(segment(guide.position, y, left, y, 'horizontal'))].filter(item => item.distance > EPS)
    if (guide.position > right + EPS) return [mark(segment(right, y, guide.position, y, 'horizontal'))].filter(item => item.distance > EPS)
    return [
      mark(segment(left, y, guide.position, y, 'horizontal')),
      mark(segment(guide.position, y, right, y, 'horizontal')),
    ].filter(item => item.distance > EPS)
  }
  const x = selection.x + selection.width / 2
  const top = selection.y, bottom = selection.y + selection.height
  if (guide.position < top - EPS) return [mark(segment(x, guide.position, x, top, 'vertical'))].filter(item => item.distance > EPS)
  if (guide.position > bottom + EPS) return [mark(segment(x, bottom, x, guide.position, 'vertical'))].filter(item => item.distance > EPS)
  return [
    mark(segment(x, top, x, guide.position, 'vertical')),
    mark(segment(x, guide.position, x, bottom, 'vertical')),
  ].filter(item => item.distance > EPS)
}

/** Authored positions of two guides. No spacing line: the reader subtracts. */
export function guidePositionReadout(positions: readonly number[], at: Point): SpacingPill[] {
  return positions.map((position, index) => ({
    text: distanceText(position),
    anchor: at,
    offset: { x: 12, y: -14 - index * 18 },
  }))
}

/** Horizontal then vertical distance between two anchor points. */
export function measureAnchors(from: Point, to: Point): Measurement[] {
  const lines: Measurement[] = []
  if (Math.abs(to.x - from.x) > EPS) lines.push({ ...segment(from.x, from.y, to.x, from.y, 'horizontal'), tick: true, role: 'gap' })
  if (Math.abs(to.y - from.y) > EPS) lines.push({ ...segment(to.x, from.y, to.x, to.y, 'vertical'), tick: true, role: 'gap' })
  return lines
}

/** Dashed width/height rectangle from a selected anchor to the pointer. */
export function anchorPlacementBox(from: Point, to: Point): { lines: Measurement[]; pills: SpacingPill[] } {
  const x0 = Math.min(from.x, to.x), y0 = Math.min(from.y, to.y)
  const x1 = Math.max(from.x, to.x), y1 = Math.max(from.y, to.y)
  const width = x1 - x0, height = y1 - y0
  if (width <= EPS && height <= EPS) return { lines: [], pills: [] }
  const edge = (ax: number, ay: number, bx: number, by: number, axis: MeasurementAxis): Measurement =>
    ({ ...segment(ax, ay, bx, by, axis), tick: false, role: 'box', dash: true })
  const lines = [
    edge(x0, y0, x1, y0, 'horizontal'),
    edge(x1, y0, x1, y1, 'vertical'),
    edge(x0, y1, x1, y1, 'horizontal'),
    edge(x0, y0, x0, y1, 'vertical'),
  ].filter(item => item.distance > EPS)
  const pills: SpacingPill[] = []
  const mid = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }
  if (width > EPS) pills.push({ text: distanceText(width), anchor: mid, offset: { x: 0, y: -14 } })
  if (height > EPS) pills.push({ text: distanceText(height), anchor: mid, offset: { x: 14, y: 0 } })
  return { lines, pills }
}

export function diagramFromLines(lines: readonly Measurement[], zoom = 1): { lines: Measurement[]; pills: SpacingPill[] } {
  const pills: SpacingPill[] = []
  for (const line of lines) {
    if (line.role === 'box') continue
    const placed = measurementLabel(line, zoom)
    pills.push({ text: distanceText(line.distance), anchor: placed.anchor, offset: placed.offset })
  }
  return { lines: [...lines], pills }
}

function pointSegmentDistance(point: Point, a: Point, b: Point) {
  const dx = b.x - a.x, dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 <= EPS) return Math.hypot(point.x - a.x, point.y - a.y)
  const t = Math.min(1, Math.max(0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / len2))
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t))
}

/** Distance text under the pointer, for the Space readout. Box outlines are not values. */
export function readoutAtPoint(lines: readonly Measurement[], pills: readonly SpacingPill[], point: Point, zoom: number, slackPx = 8): string | null {
  const scale = Number.isFinite(zoom) && zoom > EPS ? zoom : 1
  const lineSlack = slackPx / scale
  const pillSlack = 16 / scale
  let best = Infinity
  let text: string | null = null
  for (const line of lines) {
    if (line.role === 'box') continue
    const distance = pointSegmentDistance(point, line.from, line.to)
    if (distance <= lineSlack && distance <= best) { best = distance; text = distanceText(line.distance) }
  }
  for (const pill of pills) {
    const distance = Math.hypot(point.x - (pill.anchor.x + pill.offset.x / scale), point.y - (pill.anchor.y + pill.offset.y / scale))
    if (distance <= pillSlack && distance <= best) { best = distance; text = pill.text }
  }
  return text
}

export type SpacingInteraction =
  | { kind: 'layers'; id: string }
  | { kind: 'guide' }
  | { kind: 'guide-positions' }
  | { kind: 'anchors' }
  | { kind: 'anchor-place' }

/** Which Option / Dev Mode / keyboard / guide / anchor measurement is showing. */
export function spacingInteraction(input: {
  tool: string
  alt: boolean
  inspect: boolean
  dragging: boolean
  space: boolean
  selection: readonly string[]
  hover: string | null
  pick: string | null
  guideHover: boolean
  guideMeasurable: boolean
  guidePair: boolean
  vectorAnchor: boolean
  vectorPlace: boolean
}): SpacingInteraction | null {
  if (input.dragging || input.space) return null
  if (input.tool === 'vector') {
    if (!input.alt) return null
    if (input.vectorAnchor) return { kind: 'anchors' }
    if (input.vectorPlace) return { kind: 'anchor-place' }
    return null
  }
  if (input.tool !== 'select') return null
  if (input.guidePair) return { kind: 'guide-positions' }
  if (input.guideHover && input.guideMeasurable && input.alt && input.selection.length > 0) return { kind: 'guide' }
  if (input.guideHover) return null
  const keyboard = input.alt && input.pick && !input.selection.includes(input.pick) ? input.pick : null
  const id = altMeasurementTarget({
    alt: input.alt || !!keyboard,
    inspect: input.inspect && !keyboard,
    dragging: false,
    space: false,
    tool: input.tool,
    selection: input.selection,
    hover: keyboard ?? input.hover,
  })
  return id ? { kind: 'layers', id } : null
}
