import type { GpuNode, GpuPaint, Rect } from './types'
import { intersect } from './types'
import { gradientFieldMaximumStop } from './gradient-paint-over'

/** One analytic solid fused into a single paint-over draw. 6 vec4 records. */
export const ANALYTIC_SOLID_FLOATS = 24
export const ANALYTIC_SOLID_LIMIT = 48
/** Gradient records keep that header and then eight stop pairs. Fields follow the records. */
export const ANALYTIC_GRADIENT_FLOATS = 96
export const ANALYTIC_GRADIENT_STOPS = 8
/** Above this, the existing per-leaf field texture stays on the old draws. */
export const ANALYTIC_GRADIENT_FIELD_TEXELS = 4096
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
  /** Present only for an opaque gradient leaf. Solids and strokes leave this unset. */
  gradient?: AnalyticGradient
}

export type AnalyticGradientField = { width: number; height: number; values: Float32Array }
export type AnalyticGradient = {
  node: Rect
  field: AnalyticGradientField
  stops: readonly { offset: number; rgb: readonly [number, number, number]; alpha: number }[]
  base: readonly [number, number, number, number]
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
  if (items.length < 1 || items.length > ANALYTIC_SOLID_LIMIT || items.some(item => item.gradient)) throw new Error('Analytic solid batch size')
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

const gradientKinds = new Set(['linear', 'radial', 'angular', 'diamond'])

function ownedGradientField(width: number, height: number, values: ArrayLike<number>, offset: number, node: Rect): AnalyticGradientField | undefined {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || offset < 0) return
  if (width * height > ANALYTIC_GRADIENT_FIELD_TEXELS) return
  const full = width === node.w && height === node.h
  const row = height === 1 && width === node.w
  const column = width === 1 && height === node.h
  const point = width === 1 && height === 1
  if (!full && !row && !column && !point) return
  const words = width * height * 4
  if (values.length !== offset + words) return
  const copy = new Float32Array(words)
  for (let index = 0; index < words; index++) copy[index] = values[offset + index]
  if (gradientFieldMaximumStop(copy) === undefined) return
  return { width, height, values: copy }
}

/** Prefer the kernel's separable axis field. A dense centre-sample grid is the
 * same texture the per-leaf paint already uploads, capped so it fits this draw. */
export function analyticGradientFieldFromSamples(node: Rect, axes?: ArrayLike<number>, dense?: ArrayLike<number>): AnalyticGradientField | undefined {
  if (axes && axes.length >= 4) {
    const field = ownedGradientField(axes[0], axes[1], axes, 4, node)
    if (field) return field
  }
  if (!dense || node.w * node.h > ANALYTIC_GRADIENT_FIELD_TEXELS) return
  return ownedGradientField(node.w, node.h, dense, 0, node)
}

export function analyticGradientFloats(item: AnalyticSolid) {
  const field = item.gradient?.field
  return field ? ANALYTIC_GRADIENT_FLOATS + field.width * field.height * 4 : 0
}

/** One opaque gradient leaf whose kernel field fits the analytic draw.
 * The callback runs only after the structural gate, and only for this leaf. */
export function analyticGradientLeaf(node: GpuNode | undefined, target: Rect, curveWords: number,
  color: (value: string) => readonly number[], alpha: (value: string) => number,
  fieldFor: (node: GpuNode, paint: GpuPaint) => AnalyticGradientField | undefined): AnalyticSolid | undefined {
  const paint = node?.fills[0]
  const path = node?.fill
  if (!node || !path || !paint || node.opacity !== 1 || node.blend !== 'normal' || node.passthrough ||
    node.mask || node.maskId || node.clip || node.children.length || node.strokes.length ||
    node.effects.some(effect => effect.visible) || node.captureReplay || node.textureReplay ||
    node.opticalPrefixNext || node.gaussianRegion || node.sourceFilterField || node.previewSource ||
    node.fills.length !== 1 || !paint.visible || !gradientKinds.has(paint.kind) || paint.blend !== 'normal' ||
    !finiteUnit(paint.opacity) || paint.stops.length < 2 || paint.stops.length > ANALYTIC_GRADIENT_STOPS) return
  if (!lattice(node.rect) || !lattice(path.rect) || !lattice(target) || node.rect.w * node.rect.h > 262144) return
  if (!node.size || node.size.length < 2 || !node.matrix || node.matrix.length < 6) return
  if (![...node.size, ...node.matrix].every(value => Number.isFinite(value))) return
  if (node.size.some(value => value <= 0)) return
  const channelsOf = (value: string) => {
    const rgb = color(value)
    const channel = alpha(value)
    if (rgb.length < 3 || !rgb.slice(0, 3).every(finiteUnit) || !finiteUnit(channel)) return
    if ([rgb[0], rgb[1], rgb[2], channel].some(entry => Object.is(entry, -0))) return
    return { rgb: [rgb[0], rgb[1], rgb[2]] as const, alpha: channel }
  }
  const base = channelsOf(paint.color)
  if (!base) return
  const ordered = [...paint.stops].sort((a, b) => a.offset - b.offset)
  const stops: { offset: number; rgb: readonly [number, number, number]; alpha: number }[] = []
  for (let index = 0; index < ordered.length; index++) {
    const stop = ordered[index]
    if (!Number.isFinite(stop.offset) || stop.offset < 0 || stop.offset > 1) return
    if (index > 0 && stop.offset < ordered[index - 1].offset) return
    const channels = channelsOf(stop.color)
    if (!channels) return
    stops.push({ offset: stop.offset, rgb: channels.rgb, alpha: channels.alpha })
  }
  const write = intersect(intersect(node.rect, path.rect), target)
  if (!lattice(write)) return
  const shape = coverageOf(path, write, curveWords)
  if (!shape) return
  const field = fieldFor(node, paint)
  if (!field) return
  const maximum = gradientFieldMaximumStop(field.values)
  if (maximum === undefined || maximum >= stops.length) return
  return {
    ...shape, rgb: base.rgb, alpha: base.alpha, opacity: paint.opacity,
    gradient: { node: { ...node.rect }, field, stops, base: [base.rgb[0], base.rgb[1], base.rgb[2], base.alpha] },
  }
}

export function packAnalyticGradients(items: readonly AnalyticSolid[]) {
  if (items.length < 1 || items.length > ANALYTIC_SOLID_LIMIT || items.some(item => !item.gradient)) throw new Error('Analytic gradient batch size')
  let texels = 0
  for (const item of items) texels += item.gradient!.field.width * item.gradient!.field.height
  const out = new Float32Array(items.length * ANALYTIC_GRADIENT_FLOATS + texels * 4)
  let fieldAt = items.length * (ANALYTIC_GRADIENT_FLOATS / 4)
  items.forEach((item, index) => {
    const gradient = item.gradient!
    const at = index * ANALYTIC_GRADIENT_FLOATS
    const program = item.program
    const area = program.kind === 'area'
    out.set([
      item.path.x, item.path.y, item.path.w, item.path.h,
      area ? program.first : 0, area ? program.count : 0, item.clip ?? 0, area ? 0 : 2,
      ...(program.kind === 'rect' ? program.edges : [0, 0, 0, 0]),
      gradient.node.x, gradient.node.y, gradient.node.w, gradient.node.h,
      item.opacity, item.write.x, item.write.y, item.write.w,
      item.write.h, item.group ?? 0, item.role ?? 0, gradient.field.width,
      gradient.field.height, fieldAt, gradient.stops.length, gradient.base[3],
      gradient.base[0], gradient.base[1], gradient.base[2], 0,
    ], at)
    gradient.stops.forEach((stop, stopIndex) => {
      out.set([stop.offset, stop.rgb[0], stop.rgb[1], stop.rgb[2], stop.alpha, 0, 0, 0], at + 32 + stopIndex * 8)
    })
    out.set(gradient.field.values, fieldAt * 4)
    fieldAt += gradient.field.width * gradient.field.height
  })
  if (!acceptAnalyticGradientBatch(out, items.length)) throw new Error('Analytic gradient batch rejected')
  return out
}

/** GPU admission for one analytic gradient upload. Stop indices have to address
 * the packed stops; the payload has to be exactly the fields those records name. */
export function acceptAnalyticGradientBatch(data: Float32Array, count: number) {
  if (!Number.isInteger(count) || count < 1 || count > ANALYTIC_SOLID_LIMIT) return false
  if (!(data instanceof Float32Array) || data.length < count * ANALYTIC_GRADIENT_FLOATS) return false
  if ((data.length - count * ANALYTIC_GRADIENT_FLOATS) % 4 !== 0) return false
  const words = data.length / 4
  let cursor = count * (ANALYTIC_GRADIENT_FLOATS / 4)
  for (let index = 0; index < count; index++) {
    const at = index * ANALYTIC_GRADIENT_FLOATS
    const fieldW = data[at + 23], fieldH = data[at + 24], fieldOffset = data[at + 25], stops = data[at + 26], opacity = data[at + 16]
    if (![fieldW, fieldH, fieldOffset, stops, opacity].every(Number.isFinite)) return false
    if (!Number.isInteger(fieldW) || !Number.isInteger(fieldH) || !Number.isInteger(fieldOffset) || !Number.isInteger(stops)) return false
    if (fieldW < 1 || fieldH < 1 || fieldW * fieldH > ANALYTIC_GRADIENT_FIELD_TEXELS) return false
    if (stops < 2 || stops > ANALYTIC_GRADIENT_STOPS || opacity < 0 || opacity > 1) return false
    if (fieldOffset !== cursor) return false
    const texels = fieldW * fieldH
    if (cursor + texels > words) return false
    for (let texel = 0; texel < texels; texel++) {
      const offset = (cursor + texel) * 4
      const x = data[offset], y = data[offset + 1], weight = data[offset + 2], extra = data[offset + 3]
      if (![x, y, weight, extra].every(Number.isFinite)) return false
      if (x < 0) continue
      if (!Number.isInteger(x) || !Number.isInteger(y) || y < 0 || x >= stops || y >= stops || weight < 0 || weight > 1) return false
    }
    cursor += texels
  }
  return cursor === words
}
