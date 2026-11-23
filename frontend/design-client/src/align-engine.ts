import { prepareSelectionArrangement, SelectionCommandError } from './commands/selection-command'
import { planArrangement } from './commands/arrangement-plan'
import { CORE_SELECTION_PROFILE } from './commands/profiles'
import type { Bounds, DesignDocument, Matrix, Point } from './model'
import { identity } from './model'
import { allParents, inverse, multiply, scene, translate, unionBounds, worldMatrix } from './geometry'
import { smartGuidesSnapWorld, type GapSnapLine, type SmartGuideSegment, type SmartSnapResult } from './canvas-smart-guides'

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

function crossCenter(parts: AxisInterval[]): number {
  const overlapLo = Math.max(...parts.map(part => part.crossStart))
  const overlapHi = Math.min(...parts.map(part => part.crossEnd))
  if (overlapLo <= overlapHi) return (overlapLo + overlapHi) / 2
  return (Math.min(...parts.map(part => part.crossStart)) + Math.max(...parts.map(part => part.crossEnd))) / 2
}
function gapLine(axis: 'x' | 'y', start: number, end: number, cross: number): GapSnapLine | null {
  if (!(end - start > EPS) || !Number.isFinite(cross)) return null
  return { axis, start, end, cross, distance: end - start }
}
function dedupLines(lines: GapSnapLine[]): GapSnapLine[] {
  const out: GapSnapLine[] = []
  for (const line of lines) {
    if (out.some(item => Math.abs(item.start - line.start) < 1e-6 && Math.abs(item.end - line.end) < 1e-6 && Math.abs(item.cross - line.cross) < 1e-6)) continue
    out.push(line)
  }
  return out
}
function lowerBoundStart(list: AxisInterval[], from: number, value: number): number {
  let lo = from, hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (list[mid].start < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

function spacingSnapAxis(
  moving: Bounds,
  siblings: Bounds[],
  axis: 'x' | 'y',
  threshold: number,
): { delta: number; guide: SmartGuideSegment; lines: GapSnapLine[] } | null {
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
  const sortedGaps = gaps.map((g, index) => ({ g, index })).sort((a, b) => a.g - b.g || a.index - b.index)
  // One reference gap, the nearest pair with this width. A uniform row must not
  // emit a line for every sibling or the drag overlay grows with the page.
  const nearestMatchingGap = (gap: number, anchor: number) => {
    if (!(gap > EPS)) return null
    let best: { line: GapSnapLine; distance: number } | null = null
    for (let i = 1; i < list.length; i++) {
      if (!near(list[i - 1], list[i])) continue
      const g = list[i].start - list[i - 1].end
      if (!(g > EPS) || Math.abs(g - gap) >= 1e-6) continue
      const line = gapLine(axis, list[i - 1].end, list[i].start, crossCenter([list[i - 1], list[i]]))
      if (!line) continue
      const distance = Math.min(Math.abs(line.start - anchor), Math.abs(line.end - anchor))
      if (!best || distance < best.distance) best = { line, distance }
    }
    return best?.line ?? null
  }
  // |correction| is the distance from the ideal gap, so only the closest gap
  // value (and the closest legal bracket) can win. Ties keep the earlier pair.
  const bestGap = (ideal: number) => {
    const found: { best?: { g: number; index: number; distance: number } } = {}
    const tryAt = (index: number) => {
      if (index < 0 || index >= sortedGaps.length) return
      const item = sortedGaps[index]
      const distance = Math.abs(item.g - ideal)
      if (distance < EPS || distance >= threshold) return
      if (!found.best || distance < found.best.distance || (distance === found.best.distance && item.index < found.best.index))
        found.best = { g: item.g, index: item.index, distance }
    }
    let lo = 0, hi = sortedGaps.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (sortedGaps[mid].g < ideal) lo = mid + 1
      else hi = mid
    }
    tryAt(lo - 1)
    tryAt(lo)
    if (!found.best) {
      let left = lo - 1, right = lo
      while (left >= 0 && Math.abs(sortedGaps[left].g - ideal) < EPS) left--
      while (right < sortedGaps.length && Math.abs(sortedGaps[right].g - ideal) < EPS) right++
      tryAt(left)
      tryAt(right)
    }
    return found.best
  }
  // The holder keeps callback assignments visible to TypeScript's control-flow
  // analysis; a captured nullable local is otherwise narrowed to `never` here.
  const candidate: { best?: { delta: number; position: number; start: number; end: number; lines: GapSnapLine[] } } = {}
  const consider = (delta: number, position: number, others: AxisInterval[], linesFor: () => GapSnapLine[]) => {
    if (!Number.isFinite(delta) || Math.abs(delta) < EPS || Math.abs(delta) >= threshold) return
    if (candidate.best && Math.abs(delta) >= Math.abs(candidate.best.delta)) return
    candidate.best = {
      delta,
      position,
      start: Math.min(m.crossStart, ...others.map((o) => o.crossStart)),
      end: Math.max(m.crossEnd, ...others.map((o) => o.crossEnd)),
      lines: linesFor(),
    }
  }
  const snappedAt = (delta: number): AxisInterval => ({
    start: m.start + delta, end: m.start + delta + size, crossStart: m.crossStart, crossEnd: m.crossEnd,
  })
  for (const s of list) {
    const after = bestGap(m.start - s.end)
    const before = bestGap(s.start - size - m.start)
    const chosen: { best?: { delta: number; g: number; index: number; kind: 'after' | 'before' } } = {}
    const take = (kind: 'after' | 'before', found: { g: number; index: number; distance: number } | undefined, delta: number) => {
      if (!found) return
      const current = chosen.best
      if (current) {
        const currentDistance = Math.abs(current.delta)
        if (found.distance > currentDistance) return
        if (found.distance === currentDistance && (found.index > current.index || (found.index === current.index && kind === 'before'))) return
      }
      chosen.best = { delta, g: found.g, index: found.index, kind }
    }
    if (after) take('after', after, s.end + after.g - m.start)
    if (before) take('before', before, s.start - before.g - size - m.start)
    const pick = chosen.best
    if (!pick) continue
    const anchor = pick.kind === 'after' ? s.end : s.start
    consider(pick.delta, anchor, [s], () => {
      const snapped = snappedAt(pick.delta)
      const lines: GapSnapLine[] = []
      const reference = nearestMatchingGap(pick.g, anchor)
      if (reference) lines.push(reference)
      const created = pick.kind === 'after'
        ? gapLine(axis, s.end, snapped.start, crossCenter([s, snapped]))
        : gapLine(axis, snapped.end, s.start, crossCenter([s, snapped]))
      if (created) lines.push(created)
      return dedupLines(lines)
    })
  }
  // Bracketed pair: equalize the gap on both sides of the moving rect.
  for (let i = 0; i < list.length; i++) {
    const a = list[i]
    if (m.start < a.end - EPS) continue
    const minStart = Math.max(m.end - EPS, a.end + size - EPS)
    const from = lowerBoundStart(list, i + 1, minStart)
    if (from >= list.length) continue
    const target = 2 * m.start + size - a.end
    const at = lowerBoundStart(list, from, target)
    const deltaAt = (index: number) => {
      const b = list[index]
      return a.end + (b.start - a.end - size) / 2 - m.start
    }
    const bracket: { best?: { index: number; delta: number; distance: number } } = {}
    const tryBracket = (index: number) => {
      if (index < from || index >= list.length) return
      const delta = deltaAt(index)
      const distance = Math.abs(delta)
      if (distance < EPS || distance >= threshold) return
      if (!bracket.best || distance < bracket.best.distance || (distance === bracket.best.distance && index < bracket.best.index))
        bracket.best = { index, delta, distance }
    }
    tryBracket(at - 1)
    tryBracket(at)
    if (!bracket.best) {
      let left = at - 1, right = at
      while (left >= from && Math.abs(deltaAt(left)) < EPS) left--
      while (right < list.length && Math.abs(deltaAt(right)) < EPS) right++
      tryBracket(left)
      tryBracket(right)
    }
    const found = bracket.best
    if (!found) continue
    const b = list[found.index]
    consider(found.delta, a.end, [a, b], () => {
      const snapped = snappedAt(found.delta)
      const lines: GapSnapLine[] = []
      const reference = nearestMatchingGap((b.start - a.end - size) / 2, (a.end + b.start) / 2)
      if (reference) lines.push(reference)
      const left = gapLine(axis, a.end, snapped.start, crossCenter([a, snapped]))
      const right = gapLine(axis, snapped.end, b.start, crossCenter([b, snapped]))
      if (left) lines.push(left)
      if (right) lines.push(right)
      return dedupLines(lines)
    })
  }
  const best = candidate.best
  return best ? { delta: best.delta, lines: best.lines, guide: { axis, position: best.position, start: best.start, end: best.end } } : null
}

const NO_SNAP: SmartSnapResult = { dx: 0, dy: 0, guides: [null, null] }

/** Spacing snap: drag toward a position whose edge gap to a sibling repeats an
 * existing sibling gap, or sits centered with equal gaps inside a sibling pair.
 * The guide still marks the stationary sibling edge. `gapLines` are the new gap
 * and the nearest existing gap of that same width.
 * Zero-area rects (ruler guides) never contribute spacing values. */
export function spacingSnap(moving: Bounds, siblings: Bounds[], threshold: number): SmartSnapResult {
  if (!Number.isFinite(threshold) || threshold <= 0) return NO_SNAP
  const solid = siblings.filter((s) => s.width > 0 && s.height > 0)
  const x = spacingSnapAxis(moving, solid, 'x', threshold),
    y = spacingSnapAxis(moving, solid, 'y', threshold)
  const gapLines = [...(x?.lines ?? []), ...(y?.lines ?? [])]
  return {
    dx: x?.delta ?? 0, dy: y?.delta ?? 0, guides: [x?.guide ?? null, y?.guide ?? null],
    ...(gapLines.length ? { gapLines } : {}),
  }
}

/** Smallest correction per axis. Spacing wins only when its correction is strictly smaller. */
export function combineSmartSnap(edge: SmartSnapResult, spaced: SmartSnapResult): SmartSnapResult {
  const pick = (
    edgeDelta: number,
    edgeGuide: SmartGuideSegment | null,
    spaceDelta: number,
    spaceGuide: SmartGuideSegment | null,
    lines: GapSnapLine[],
  ) => {
    if (edgeGuide && spaceGuide)
      return Math.abs(spaceDelta) < Math.abs(edgeDelta)
        ? { delta: spaceDelta, guide: spaceGuide, lines }
        : { delta: edgeDelta, guide: edgeGuide, lines: [] as GapSnapLine[] }
    if (spaceGuide) return { delta: spaceDelta, guide: spaceGuide, lines }
    return { delta: edgeGuide ? edgeDelta : 0, guide: edgeGuide, lines: [] as GapSnapLine[] }
  }
  const linesFor = (axis: 'x' | 'y') => (spaced.gapLines ?? []).filter(line => line.axis === axis)
  const x = pick(edge.dx, edge.guides[0], spaced.dx, spaced.guides[0], linesFor('x'))
  const y = pick(edge.dy, edge.guides[1], spaced.dy, spaced.guides[1], linesFor('y'))
  const gapLines = [...x.lines, ...y.lines]
  return { dx: x.delta, dy: y.delta, guides: [x.guide, y.guide], ...(gapLines.length ? { gapLines } : {}) }
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
  return combineSmartSnap(edgeSnap(moving, parent, siblings, threshold), spacingSnap(moving, siblings, threshold))
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
