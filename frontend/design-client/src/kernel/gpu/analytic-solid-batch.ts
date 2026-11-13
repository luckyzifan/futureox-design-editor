import type { GpuNode, GpuPaint, Rect } from './types'
import { intersect } from './types'

/** One analytic solid fused into a single paint-over draw. 6 vec4 records. */
export const ANALYTIC_SOLID_FLOATS = 24
export const ANALYTIC_SOLID_LIMIT = 48
/** Fixed viewport tiles are 514 px. Larger isolation targets keep their old draws. */
export const ANALYTIC_SOLID_TARGET_PIXELS = 514 * 514

export type AnalyticSolid = {
  path: Rect
  write: Rect
  /** Area-program index, or a rectangle's local edges when `rect` is set. */
  program: { kind: 'area'; first: number; count: number } | { kind: 'rect'; edges: readonly [number, number, number, number] }
  rgb: readonly [number, number, number]
  alpha: number
  opacity: number
  /** 0 paints directly over the destination. A positive id isolates every
   * brush of one leaf, then composites that layer once. */
  group?: number
  /** 0 paint, 1 paint and remember shape coverage, 2 shape coverage only. */
  role?: 0 | 1 | 2
  /** 0 none, 2 inside, 3 outside. Mode 1's plain product, not a rounded multiply. */
  clip?: 0 | 2 | 3
}

const finiteUnit = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1
const lattice = (rect: Rect | undefined): rect is Rect => !!rect && rect.w > 0 && rect.h > 0 &&
  [rect.x, rect.y, rect.w, rect.h].every(value => Number.isSafeInteger(value) && Math.abs(value) <= 1_048_576)

export function expandAnalyticSolid(rect: Rect): Rect {
  return { x: rect.x - 1, y: rect.y - 1, w: rect.w + 2, h: rect.h + 2 }
}
export function analyticSolidsOverlap(a: Rect, b: Rect) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** Same admission the per-leaf analytic paint-over already proved, packed for one draw. */
export function analyticSolidLeaf(node: GpuNode | undefined, target: Rect, curveWords: number,
  color: (value: string) => readonly number[], alpha: (value: string) => number): AnalyticSolid | undefined {
  const paint = node?.fills[0]
  const path = node?.fill
  if (!node || !path || !paint || node.opacity !== 1 || node.blend !== 'normal' || node.passthrough ||
    node.mask || node.maskId || node.clip || node.children.length || node.strokes.length ||
    node.effects.some(effect => effect.visible) || node.captureReplay || node.textureReplay ||
    node.opticalPrefixNext || node.gaussianRegion || node.sourceFilterField || node.fills.length !== 1 ||
    !paint.visible || paint.kind !== 'solid' || paint.blend !== 'normal' || !finiteUnit(paint.opacity)) return
  const rgb = color(paint.color)
  const channel = alpha(paint.color)
  if (rgb.length < 3 || !rgb.slice(0, 3).every(finiteUnit) || !finiteUnit(channel)) return
  if (!lattice(node.rect) || !lattice(path.rect) || !lattice(target)) return
  const write = intersect(intersect(node.rect, path.rect), target)
  if (!lattice(write)) return
  if (path.area && path.area.count > 0 && Number.isSafeInteger(path.area.first) && path.area.first >= 0 &&
    path.area.first <= 16_777_216 && Number.isSafeInteger(path.area.count) &&
    path.area.first + path.area.count <= curveWords) {
    return { path: path.rect, write, program: { kind: 'area', first: path.area.first, count: path.area.count },
      rgb: [rgb[0], rgb[1], rgb[2]], alpha: channel, opacity: paint.opacity }
  }
  const edges = path.analyticRect
  if (!path.area && edges && edges.length === 4 && edges.every(value => Number.isFinite(value) && Math.abs(value) <= 1_048_576)) {
    const local = edges.map((value, index) => value - (index % 2 ? path.rect.y : path.rect.x)) as [number, number, number, number]
    if (local.every(value => Number.isFinite(value))) {
      return { path: path.rect, write, program: { kind: 'rect', edges: local },
        rgb: [rgb[0], rgb[1], rgb[2]], alpha: channel, opacity: paint.opacity }
    }
  }
}

export function packAnalyticSolids(items: readonly AnalyticSolid[]) {
  if (items.length < 1 || items.length > ANALYTIC_SOLID_LIMIT) throw new Error('Analytic solid batch size')
  const out = new Float32Array(items.length * ANALYTIC_SOLID_FLOATS)
  items.forEach((item, index) => {
    const at = index * ANALYTIC_SOLID_FLOATS
    const program = item.program
    const area = program.kind === 'area'
    out.set([
      item.path.x, item.path.y, item.path.w, item.path.h,
      area ? program.first : 0, area ? program.count : 0, item.clip ?? 0, area ? 0 : 2,
      ...(program.kind === 'rect' ? program.edges : [0, 0, 0, 0]),
      item.rgb[0], item.rgb[1], item.rgb[2], item.alpha,
      item.opacity, item.write.x, item.write.y, item.write.w,
      item.write.h, item.group ?? 0, item.role ?? 0, 0,
    ], at)
  })
  return out
}

/** Sequential batches. Overlapping footprints and shapes that cover at least
 * half the target stay in their own draw so the old neighbour rule still applies.
 * A multi-brush leaf stays in one batch even when its own brushes overlap. */
export function planAnalyticSolidBatches(items: readonly AnalyticSolid[], targetArea: number, limit = ANALYTIC_SOLID_LIMIT) {
  if (items.some(item => item.group)) return planAnalyticSolidGroups(items, targetArea, limit)
  const batches: { items: AnalyticSolid[]; fullPass: boolean }[] = []
  let current: AnalyticSolid[] = []
  const flush = () => { if (current.length) batches.push({ items: current, fullPass: false }); current = [] }
  for (const item of items) {
    if (item.write.w * item.write.h * 2 >= targetArea) {
      flush()
      batches.push({ items: [item], fullPass: true })
      continue
    }
    const box = expandAnalyticSolid(item.write)
    if (current.length >= limit || current.some(other => analyticSolidsOverlap(expandAnalyticSolid(other.write), box))) flush()
    current.push(item)
  }
  flush()
  return batches
}

function unionArea(items: readonly AnalyticSolid[]) {
  let box: Rect | undefined
  for (const item of items) {
    const rect = item.write
    if (!box) box = { ...rect }
    else {
      const x = Math.min(box.x, rect.x), y = Math.min(box.y, rect.y)
      box = {
        x, y,
        w: Math.max(box.x + box.w, rect.x + rect.w) - x,
        h: Math.max(box.y + box.h, rect.y + rect.h) - y,
      }
    }
  }
  return box ? box.w * box.h : 0
}

/** Same split rules as the direct planner. Items that share a group id are one
 * atom, so a fill and its overlapping stroke are not pulled into two draws. */
function planAnalyticSolidGroups(items: readonly AnalyticSolid[], targetArea: number, limit: number) {
  const atoms: AnalyticSolid[][] = []
  for (let index = 0; index < items.length;) {
    const group = items[index].group ?? 0
    let end = index + 1
    if (group) while (end < items.length && items[end].group === group) end++
    atoms.push(items.slice(index, end))
    index = end
  }
  const batches: { items: AnalyticSolid[]; fullPass: boolean }[] = []
  let current: AnalyticSolid[] = []
  let currentAtoms: AnalyticSolid[][] = []
  const flush = () => { if (current.length) batches.push({ items: current, fullPass: false }); current = []; currentAtoms = [] }
  const expanded = (atom: readonly AnalyticSolid[]) => atom.map(item => expandAnalyticSolid(item.write))
  for (const atom of atoms) {
    if (unionArea(atom) * 2 >= targetArea) {
      flush()
      batches.push({ items: atom, fullPass: true })
      continue
    }
    const boxes = expanded(atom)
    const overlap = currentAtoms.some(other => expanded(other).some(box => boxes.some(next => analyticSolidsOverlap(box, next))))
    if (current.length + atom.length > limit || overlap) flush()
    current.push(...atom)
    currentAtoms.push(atom)
  }
  flush()
  return batches
}

type ShapeMesh = { rect?: Rect; area?: { first: number; count: number }; analyticRect?: readonly number[] }

function coverageOf(shape: ShapeMesh | undefined, write: Rect, curveWords: number): Pick<AnalyticSolid, 'path' | 'write' | 'program'> | undefined {
  if (!shape?.rect || !lattice(shape.rect)) return
  const path = shape.rect
  if (shape.area && shape.area.count > 0 && Number.isSafeInteger(shape.area.first) && shape.area.first >= 0 &&
    shape.area.first <= 16_777_216 && Number.isSafeInteger(shape.area.count) &&
    shape.area.first + shape.area.count <= curveWords) {
    return { path, write, program: { kind: 'area', first: shape.area.first, count: shape.area.count } }
  }
  const edges = shape.analyticRect
  if (!shape.area && edges && edges.length === 4 && edges.every(value => Number.isFinite(value) && Math.abs(value) <= 1_048_576)) {
    const local = edges.map((value, index) => value - (index % 2 ? path.y : path.x)) as [number, number, number, number]
    if (local.every(value => Number.isFinite(value))) return { path, write, program: { kind: 'rect', edges: local } }
  }
}

function paintChannels(paint: GpuPaint | undefined, color: (value: string) => readonly number[], alpha: (value: string) => number) {
  if (!paint?.visible || paint.kind !== 'solid' || paint.blend !== 'normal' || !finiteUnit(paint.opacity)) return
  const rgb = color(paint.color)
  const channel = alpha(paint.color)
  if (rgb.length < 3 || !rgb.slice(0, 3).every(finiteUnit) || !finiteUnit(channel)) return
  return { rgb: [rgb[0], rgb[1], rgb[2]] as const, alpha: channel, opacity: paint.opacity }
}

/** Opaque solid fills and strokes of one leaf. The write is the whole node so
 * the later single composite covers the same rectangle as the old isolation. */
export function analyticSolidBrushes(node: GpuNode | undefined, target: Rect, curveWords: number,
  color: (value: string) => readonly number[], alpha: (value: string) => number): AnalyticSolid[] | undefined {
  if (!node || node.opacity !== 1 || node.blend !== 'normal' || node.passthrough ||
    node.mask || node.maskId || node.clip || node.children.length || !node.strokes.length ||
    node.effects.some(effect => effect.visible) || node.captureReplay || node.textureReplay ||
    node.opticalPrefixNext || node.gaussianRegion || node.sourceFilterField) return
  if (!lattice(node.rect) || !lattice(target)) return
  const write = intersect(node.rect, target)
  if (!lattice(write)) return
  const fills = node.fills.filter(paint => paint.visible)
  if (fills.length + node.strokes.length + 1 > ANALYTIC_SOLID_LIMIT) return
  const shape = coverageOf(node.fill, write, curveWords)
  const needsShape = node.strokes.some(stroke => stroke.align === 'inside' || stroke.align === 'outside')
  if ((fills.length || needsShape) && !shape) return
  const items: AnalyticSolid[] = []
  if (!fills.length && needsShape && shape)
    items.push({ ...shape, rgb: [0, 0, 0], alpha: 0, opacity: 0, group: 1, role: 2, clip: 0 })
  for (const paint of fills) {
    const channels = paintChannels(paint, color, alpha)
    if (!channels || !shape) return
    items.push({ ...shape, ...channels, group: 1, role: needsShape ? 1 : 0, clip: 0 })
  }
  for (const stroke of node.strokes) {
    if (stroke.align !== 'center' && stroke.align !== 'inside' && stroke.align !== 'outside') return
    const channels = paintChannels(stroke.paint, color, alpha)
    const covered = coverageOf(stroke.path, write, curveWords)
    if (!channels || !covered) return
    const clip = stroke.align === 'inside' ? 2 : stroke.align === 'outside' ? 3 : 0
    items.push({ ...covered, ...channels, group: 1, role: 0, clip })
  }
  return items.length ? items : undefined
}
