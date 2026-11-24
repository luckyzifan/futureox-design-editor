import { prepareSelectionArrangement, SelectionCommandError } from './commands/selection-command'
import { planArrangement } from './commands/arrangement-plan'
import { CORE_SELECTION_PROFILE } from './commands/profiles'
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
  return planArrangement(CORE_SELECTION_PROFILE, rects, axis, mode, container)?.offsets ?? null
}

/** Equal edge-gap distribution along one axis (Sketch MSDistribute*). The
 * outermost rects stay pinned to the union extent; negative gaps (overlap)
 * distribute the same way. Deltas follow the input order, not the sort order. */
export function distributeOffsets(rects: Bounds[], axis: 'x' | 'y'): Point[] | null {
  return planArrangement(CORE_SELECTION_PROFILE, rects, axis, 'distribute')?.offsets ?? null
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

/** One axis of a gesture's spacing targets, sorted by start once. Targets do
 * not change while a gesture owns its guide index, so a query never sorts. */
type SpacingAxisIndex = { start: Float64Array; end: Float64Array; crossStart: Float64Array; crossEnd: Float64Array }
export type SpacingIndex = { x: SpacingAxisIndex; y: SpacingAxisIndex }

function buildSpacingAxis(siblings: Bounds[], axis: 'x' | 'y'): SpacingAxisIndex {
  const horizontal = axis === 'x'
  // Target i occupies [4i, 4i + 4) of `columns`; zero-area rects are skipped.
  const columns = new Float64Array(siblings.length * 4)
  const order: number[] = []
  for (let i = 0; i < siblings.length; i++) {
    const s = siblings[i]!
    if (!(s.width > 0 && s.height > 0)) continue
    order.push(i)
    const base = i * 4
    columns[base] = horizontal ? s.x : s.y
    columns[base + 1] = columns[base]! + (horizontal ? s.width : s.height)
    columns[base + 2] = horizontal ? s.y : s.x
    columns[base + 3] = columns[base + 2]! + (horizontal ? s.height : s.width)
  }
  // Array.prototype.sort is stable, so equal starts keep document order.
  order.sort((a, b) => columns[a * 4]! - columns[b * 4]!)
  const startColumn = new Float64Array(order.length), endColumn = new Float64Array(order.length),
    crossStartColumn = new Float64Array(order.length), crossEndColumn = new Float64Array(order.length)
  for (let i = 0; i < order.length; i++) {
    const base = order[i]! * 4
    startColumn[i] = columns[base]!
    endColumn[i] = columns[base + 1]!
    crossStartColumn[i] = columns[base + 2]!
    crossEndColumn[i] = columns[base + 3]!
  }
  return { start: startColumn, end: endColumn, crossStart: crossStartColumn, crossEnd: crossEndColumn }
}

/** Spacing targets of one gesture. Ruler guides (zero-area rects) never
 * contribute spacing values. */
export function createSpacingIndex(siblings: Bounds[]): SpacingIndex {
  return { x: buildSpacingAxis(siblings, 'x'), y: buildSpacingAxis(siblings, 'y') }
}

/** First position whose value is not below `value`, inside `[low, high)`. */
function lowerBound(values: ArrayLike<number>, value: number, low = 0, high = values.length) {
  while (low < high) {
    const middle = (low + high) >>> 1
    if (values[middle]! < value) low = middle + 1
    else high = middle
  }
  return low
}

type SpacingCandidate = { delta: number; position: number; start: number; crossEnd: number }


/** One axis of a spacing query. Targets are visited in start order and every
 * candidate is found with a binary search, so a query never compares each
 * target with each gap or with every later target. */
function spacingSnapIndexedAxis(index: SpacingAxisIndex, moving: Bounds, axis: 'x' | 'y', threshold: number):
  { delta: number; guide: SmartGuideSegment } | null {
  const m = axisInterval(moving, axis),
    size = m.end - m.start
  const { start, end, crossStart, crossEnd } = index
  // Targets near the moving rect on the cross axis, in start order.
  const near: number[] = []
  for (let i = 0; i < start.length; i++)
    if (crossStart[i]! <= m.crossEnd + threshold && m.crossStart <= crossEnd[i]! + threshold) near.push(i)
  const meets = (a: number, b: number) => crossStart[a]! <= crossEnd[b]! + threshold && crossStart[b]! <= crossEnd[a]! + threshold
  // Spacing values come from adjacent sibling pairs (Sketch SpacingSnapTargetProvider),
  // in discovery order. A value within 1e-6 of an earlier one is the same gap.
  const found: { gap: number; order: number }[] = []
  for (let k = 1; k < near.length; k++) {
    const p = near[k - 1]!, q = near[k]!
    if (!meets(p, q)) continue
    const gap = start[q]! - end[p]!
    if (gap >= 0) found.push({ gap, order: found.length })
  }
  // Sorting by value groups equal gaps, and the stable order keeps the first
  // of them. Each value is compared with the last kept one only: in sorted
  // order that is the nearest earlier value.
  found.sort((a, b) => a.gap - b.gap)
  const gaps: number[] = [], orders: number[] = []
  for (const item of found)
    if (!gaps.length || item.gap - gaps[gaps.length - 1]! >= 1e-6) { gaps.push(item.gap); orders.push(item.order) }
  let best: SpacingCandidate | undefined
  // The first candidate of the smallest correction wins; an equal one never replaces it.
  const consider = (delta: number, position: number, from: number, to: number) => {
    const magnitude = Math.abs(delta)
    if (!(magnitude >= EPS && magnitude < threshold)) return
    if (best && magnitude >= Math.abs(best.delta)) return
    best = {
      delta, position,
      start: Math.min(m.crossStart, crossStart[from]!, crossStart[to]!),
      crossEnd: Math.max(m.crossEnd, crossEnd[from]!, crossEnd[to]!),
    }
  }
  // Repeat an existing gap before or after one target. Only the gap nearest
  // to the requested one on each side can be that target's best candidate.
  for (const i of near) {
    let chosen: { delta: number; position: number; order: number; side: number } | undefined
    for (let side = 0; side < 2; side++) {
      const target = side === 0 ? m.start - end[i]! : start[i]! - size - m.start
      // Nearest gap on each side, skipping a gap that would not move the rect.
      const at = lowerBound(gaps, target)
      let left = at - 1
      while (left >= 0 && target - gaps[left]! < EPS) left--
      let right = at
      while (right < gaps.length && gaps[right]! - target < EPS) right++
      for (const k of [left, right]) {
        if (k < 0 || k >= gaps.length) continue
        const delta = side === 0 ? end[i]! + gaps[k]! - m.start : start[i]! - gaps[k]! - size - m.start
        const magnitude = Math.abs(delta)
        if (!(magnitude >= EPS && magnitude < threshold)) continue
        // The same target compares by gap discovery order, then by side.
        if (chosen && (magnitude > Math.abs(chosen.delta) ||
            magnitude === Math.abs(chosen.delta) && (orders[k]! > chosen.order || orders[k]! === chosen.order && side >= chosen.side))) continue
        chosen = { delta, position: side === 0 ? end[i]! : start[i]!, order: orders[k]!, side }
      }
    }
    if (chosen) consider(chosen.delta, chosen.position, i, i)
  }
  // Bracketed pair: equalize the gap on both sides of the moving rect. The
  // correction grows with the second target's start, so for each first target
  // only the starts nearest to the equalizing one can be the best candidate.
  const seek = (from: number, value: number) => {
    let low = from, high = near.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (start[near[middle]!]! < value) low = middle + 1
      else high = middle
    }
    return low
  }
  for (let k = 0; k < near.length; k++) {
    const a = near[k]!
    if (m.start < end[a]! - EPS) continue
    const first = Math.max(m.end - EPS, end[a]! + size - EPS), equal = 2 * m.start + size - end[a]!
    const lowest = seek(k + 1, first)
    if (lowest >= near.length) continue
    const at = seek(lowest, equal - 2 * EPS), above = seek(lowest, equal + 2 * EPS)
    // Several targets can share one start; the first of them is visited first.
    const below = at > lowest ? seek(lowest, start[near[at - 1]!]!) : -1
    let chosen: { delta: number; b: number } | undefined
    // Later targets are visited in start order, so an equal correction keeps the earlier one.
    for (const b of [below, at, above]) {
      if (b < lowest || b >= near.length) continue
      const delta = end[a]! + (start[near[b]!]! - end[a]! - size) / 2 - m.start
      const magnitude = Math.abs(delta)
      if (!(magnitude >= EPS && magnitude < threshold)) continue
      if (chosen && magnitude >= Math.abs(chosen.delta)) continue
      chosen = { delta, b: near[b]! }
    }
    if (chosen) consider(chosen.delta, end[a]!, a, chosen.b)
  }
  return best ? { delta: best.delta, guide: { axis, position: best.position, start: best.start, end: best.crossEnd } } : null
}

const NO_SNAP: SmartSnapResult = { dx: 0, dy: 0, guides: [null, null] }

/** Spacing snap against targets indexed for this call. A caller that repeats
 * the query, such as a gesture, keeps the index from `createSpacingIndex` and
 * calls `spacingSnapIndexed` instead. */
export function spacingSnap(moving: Bounds, siblings: Bounds[], threshold: number): SmartSnapResult {
  return spacingSnapIndexed(createSpacingIndex(siblings), moving, threshold)
}

export function spacingSnapIndexed(index: SpacingIndex, moving: Bounds, threshold: number): SmartSnapResult {
  if (!Number.isFinite(threshold) || threshold <= 0) return NO_SNAP
  const x = spacingSnapIndexedAxis(index.x, moving, 'x', threshold),
    y = spacingSnapIndexedAxis(index.y, moving, 'y', threshold)
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

/** One-off edge and spacing snap. Interactive Canvas moves use a gesture-owned
 * SmartGuidesIndex. */
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
  if (command !== 'tidy') {
    try {
      const target = command === 'distribute-horizontal' ? { axis: 'x' as const, mode: 'distribute' as const } :
        command === 'distribute-vertical' ? { axis: 'y' as const, mode: 'distribute' as const } : ALIGN_TARGETS[command]
      const plan = prepareSelectionArrangement(doc, ids, target.axis, target.mode, { fresh: true })
      const parents = allParents(doc)
      if (plan.ids.some(id => { let at: string | undefined = id; while (at && doc.nodes[at]) at = parents.get(at); return at !== page })) return null
      return plan.patches.length ? Object.fromEntries(plan.patches.map(patch => [patch.id, { transform: patch.transform }])) : null
    } catch (error) { if (error instanceof SelectionCommandError) return null; throw error }
  }
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
