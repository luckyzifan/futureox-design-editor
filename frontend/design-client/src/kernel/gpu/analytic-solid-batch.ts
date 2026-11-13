import type { GpuNode, Rect } from './types'
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
      area ? program.first : 0, area ? program.count : 0, 0, area ? 0 : 2,
      ...(program.kind === 'rect' ? program.edges : [0, 0, 0, 0]),
      item.rgb[0], item.rgb[1], item.rgb[2], item.alpha,
      item.opacity, item.write.x, item.write.y, item.write.w,
      item.write.h, 0, 0, 0,
    ], at)
  })
  return out
}

/** Sequential batches. Overlapping footprints and shapes that cover at least
 * half the target stay in their own draw so the old neighbour rule still applies. */
export function planAnalyticSolidBatches(items: readonly AnalyticSolid[], targetArea: number, limit = ANALYTIC_SOLID_LIMIT) {
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
