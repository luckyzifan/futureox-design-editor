import { planArrangement } from './commands/arrangement-plan'
import { UI_SELECTION_PROFILE } from './commands/profiles'
import type { Bounds, DesignDocument, Matrix, Point } from './model'
import { identity } from './model'
import { allParents, inverse, multiply, scene, translate, unionBounds, worldMatrix } from './geometry'
import { smartGuidesSnapWorld, type SmartGuideSegment, type SmartSnapResult } from './canvas-smart-guides'

export type AlignCommand =
  | 'align-left'
  | 'align-hcenter'
  | 'align-right'
  | 'align-top'
  | 'align-vcenter'
  | 'align-bottom'
export type DistributeCommand = 'distribute-horizontal' | 'distribute-vertical'
export type ArrangeCommand = AlignCommand | DistributeCommand | 'tidy'

const ALIGN_TARGETS: Record<AlignCommand, { axis: 'x' | 'y'; mode: 'start' | 'center' | 'end' }> = {
  'align-left': { axis: 'x', mode: 'start' },
  'align-hcenter': { axis: 'x', mode: 'center' },
  'align-right': { axis: 'x', mode: 'end' },
  'align-top': { axis: 'y', mode: 'start' },
  'align-vcenter': { axis: 'y', mode: 'center' },
  'align-bottom': { axis: 'y', mode: 'end' },
}

const EPS = 1e-9

/** Per-rect world deltas for one align command. Two or more rects align to
 * their union bounds; a single rect aligns to `container` (the parent bounds).
 * The untouched axis always gets a zero delta. */
export function alignOffsets(rects: Bounds[], command: AlignCommand, container?: Bounds): Point[] | null {
  const { axis, mode } = ALIGN_TARGETS[command]
  return planArrangement(UI_SELECTION_PROFILE, rects, axis, mode, container)?.offsets ?? null
}

/** Equal edge-gap distribution along one axis (Sketch MSDistribute*). The
 * outermost rects stay pinned to the union extent; negative gaps (overlap)
 * distribute the same way. Deltas follow the input order, not the sort order. */
export function distributeOffsets(rects: Bounds[], axis: 'x' | 'y'): Point[] | null {
  return planArrangement(UI_SELECTION_PROFILE, rects, axis, 'distribute')?.offsets ?? null
}

/** Grid tidy (Figma-style "tidy up"): rows clustered by vertical overlap are
 * vertically centered onto their row band, in-row gaps equalize to the global
 * mean gap, and row bands restack with the global mean row gap. The top-left
 * of the first row/column stays anchored. */
export function tidyOffsets(rects: Bounds[]): Point[] | null {
  if (rects.length < 2) return null
  const items = rects.map((r, index) => ({ r, index }))
  const rows: { items: typeof items; top: number; bottom: number }[] = []
  for (const item of [...items].sort((a, b) => a.r.y - b.r.y)) {
    const row = rows.at(-1)
    if (row && item.r.y < row.bottom - 0.01) {
      row.items.push(item)
      row.top = Math.min(row.top, item.r.y)
      row.bottom = Math.max(row.bottom, item.r.y + item.r.height)
    } else rows.push({ items: [item], top: item.r.y, bottom: item.r.y + item.r.height })
  }
  rows.forEach((row) => row.items.sort((a, b) => a.r.x - b.r.x))
  // Global mean in-row gap; single-column layouts have no in-row gap at all.
  const inRowGaps = rows.flatMap((row) =>
    row.items.slice(1).map((item, i) => item.r.x - row.items[i].r.x - row.items[i].r.width),
  )
  const gapX = inRowGaps.length ? inRowGaps.reduce((a, b) => a + b, 0) / inRowGaps.length : 0
  const rowGaps = rows.slice(1).map((row, i) => row.top - rows[i].bottom)
  const gapY = rowGaps.length ? rowGaps.reduce((a, b) => a + b, 0) / rowGaps.length : 0
  const deltas: Point[] = new Array(rects.length)
  let rowTop = rows[0].top
  for (const row of rows) {
    const center = rowTop + (row.bottom - row.top) / 2
    let cursor = row.items[0].r.x
    for (const item of row.items) {
      deltas[item.index] = { x: cursor - item.r.x, y: center - (item.r.y + item.r.height / 2) }
      cursor += item.r.width + gapX
    }
    rowTop += row.bottom - row.top + gapY
  }
  return deltas
}

export function arrangeOffsets(rects: Bounds[], command: ArrangeCommand, container?: Bounds): Point[] | null {
  if (command === 'tidy') return tidyOffsets(rects)
  if (command === 'distribute-horizontal') return distributeOffsets(rects, 'x')
  if (command === 'distribute-vertical') return distributeOffsets(rects, 'y')
  return alignOffsets(rects, command, container)
}

type AxisInterval = { start: number; end: number; crossStart: number; crossEnd: number }

function axisInterval(b: Bounds, axis: 'x' | 'y'): AxisInterval {
  return axis === 'x'
    ? { start: b.x, end: b.x + b.width, crossStart: b.y, crossEnd: b.y + b.height }
    : { start: b.y, end: b.y + b.height, crossStart: b.x, crossEnd: b.x + b.width }
}

function spacingSnapAxis(
  moving: Bounds,
  siblings: Bounds[],
  axis: 'x' | 'y',
  threshold: number,
): { delta: number; guide: SmartGuideSegment } | null {
  const m = axisInterval(moving, axis),
    size = m.end - m.start
  const near = (a: AxisInterval, b: AxisInterval) =>
    a.crossStart <= b.crossEnd + threshold && b.crossStart <= a.crossEnd + threshold
  const list = siblings
    .map((s) => axisInterval(s, axis))
    .filter((s) => near(s, m))
    .sort((a, b) => a.start - b.start)
  // Spacing values come from adjacent sibling pairs (Sketch SpacingSnapTargetProvider).
  const gaps: number[] = []
  for (let i = 1; i < list.length; i++) {
    if (!near(list[i - 1], list[i])) continue
    const g = list[i].start - list[i - 1].end
    if (g >= 0 && !gaps.some((v) => Math.abs(v - g) < 1e-6)) gaps.push(g)
  }
  // The holder keeps callback assignments visible to TypeScript's control-flow
  // analysis; a captured nullable local is otherwise narrowed to `never` here.
  const candidate: { best?: { delta: number; position: number; start: number; end: number } } = {}
  const consider = (delta: number, position: number, others: AxisInterval[]) => {
    if (!Number.isFinite(delta) || Math.abs(delta) < EPS || Math.abs(delta) >= threshold) return
    if (candidate.best && Math.abs(delta) >= Math.abs(candidate.best.delta)) return
    candidate.best = {
      delta,
      position,
      start: Math.min(m.crossStart, ...others.map((o) => o.crossStart)),
      end: Math.max(m.crossEnd, ...others.map((o) => o.crossEnd)),
    }
  }
  for (const s of list)
    for (const g of gaps) {
      consider(s.end + g - m.start, s.end, [s])
      consider(s.start - g - size - m.start, s.start, [s])
    }
  // Bracketed pair: equalize the gap on both sides of the moving rect.
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i],
        b = list[j],
        span = b.start - a.end
      if (span < size - EPS || m.start < a.end - EPS || m.end > b.start + EPS) continue
      consider(a.end + (span - size) / 2 - m.start, a.end, [a, b])
    }
  const best = candidate.best
  return best ? { delta: best.delta, guide: { axis, position: best.position, start: best.start, end: best.end } } : null
}

const NO_SNAP: SmartSnapResult = { dx: 0, dy: 0, guides: [null, null] }

/** Spacing snap: drag toward a position whose edge gap to a sibling repeats an
 * existing sibling gap, or sits centered with equal gaps inside a sibling pair.
 * The returned guide line marks the stationary sibling edge and spans every
 * participating rect on the cross axis. Zero-area rects (ruler guides) never
 * contribute spacing values. */
export function spacingSnap(moving: Bounds, siblings: Bounds[], threshold: number): SmartSnapResult {
  if (!Number.isFinite(threshold) || threshold <= 0) return NO_SNAP
  const solid = siblings.filter((s) => s.width > 0 && s.height > 0)
  const x = spacingSnapAxis(moving, solid, 'x', threshold),
    y = spacingSnapAxis(moving, solid, 'y', threshold)
  return { dx: x?.delta ?? 0, dy: y?.delta ?? 0, guides: [x?.guide ?? null, y?.guide ?? null] }
}

/** Full drag snap: kernel edge/center snapping plus spacing snapping, picking
 * the smallest correction per axis. `edgeSnap` is injectable so the geometry
 * stays testable without the WASM kernel. */
export function dragSnap(
  moving: Bounds,
  parent: Bounds | undefined,
  siblings: Bounds[],
  threshold: number,
  edgeSnap: typeof smartGuidesSnapWorld = smartGuidesSnapWorld,
): SmartSnapResult {
  const edge = edgeSnap(moving, parent, siblings, threshold),
    spaced = spacingSnap(moving, siblings, threshold)
  const pick = (
    edgeDelta: number,
    edgeGuide: SmartGuideSegment | null,
    spaceDelta: number,
    spaceGuide: SmartGuideSegment | null,
  ): [number, SmartGuideSegment | null] => {
    if (edgeGuide && spaceGuide)
      return Math.abs(spaceDelta) < Math.abs(edgeDelta)
        ? [spaceDelta, spaceGuide]
        : [edgeDelta, edgeGuide]
    if (spaceGuide) return [spaceDelta, spaceGuide]
    return [edgeGuide ? edgeDelta : 0, edgeGuide]
  }
  const [dx, gx] = pick(edge.dx, edge.guides[0], spaced.dx, spaced.guides[0]),
    [dy, gy] = pick(edge.dy, edge.guides[1], spaced.dy, spaced.guides[1])
  return { dx, dy, guides: [gx, gy] }
}

/** Drag-time snap entry point used by the canvas: identical result shape to
 * the kernel smart guides, so guides render through the existing channel and
 * disappear on pointer release. */
export function alignSnapWorld(
  moving: Bounds,
  parent: Bounds | undefined,
  siblings: Bounds[],
  threshold: number,
): SmartSnapResult {
  return dragSnap(moving, parent, siblings, threshold)
}

/** World-space transform patches for one arrange command over live selection
 * ids. Returns null when the command does not apply (too few layers, no
 * parent container for a single-layer align, nothing movable). */
export function arrangePatches(
  doc: DesignDocument,
  page: string,
  ids: string[],
  command: ArrangeCommand,
): Record<string, { transform: Matrix }> | null {
  const selected = new Set(ids),
    parents = allParents(doc),
    entries = scene(doc, page)
  const movable = entries.filter((e) => {
    if (!selected.has(e.id) || e.locked || e.ancestors.some((id) => selected.has(id))) return false
    const n = doc.nodes[e.id],
      parent = doc.nodes[parents.get(e.id)!]
    if (n.instanceOrigin) return false
    // Auto-layout children are positioned by the container, not by transforms.
    return !(parent?.layout && parent.layout.mode !== 'none' && !n.sizing?.absolute)
  })
  if (!movable.length) return null
  let container: Bounds | undefined
  if (movable.length === 1) {
    const parentId = parents.get(movable[0].id)
    if (!parentId || !doc.nodes[parentId]) return null
    container = entries.find((e) => e.id === parentId)?.bounds
    if (!container) return null
  }
  const offsets = arrangeOffsets(movable.map((e) => e.bounds), command, container)
  if (!offsets) return null
  const patches: Record<string, { transform: Matrix }> = {}
  movable.forEach((e, i) => {
    const delta = offsets[i]
    if (Math.abs(delta.x) < EPS && Math.abs(delta.y) < EPS) return
    const parent = parents.get(e.id),
      basis = parent && doc.nodes[parent] ? worldMatrix(doc, parent, parents) : identity()
    patches[e.id] = {
      transform: multiply(inverse(basis), multiply(translate(delta.x, delta.y), e.matrix)),
    }
  })
  return Object.keys(patches).length ? patches : null
}
