import { exactBlendLattice } from './effect-region'
import { intersect, type GpuNode, type GpuScene, type PathMesh, type Rect } from './types'

export type SequentialDisplayOptions = Readonly<{
  managed: boolean
  hdr: boolean
  present: boolean
  readback?: boolean
  /** The caller has prepared the immutable source, real upload/range proof
   * and complete device/source halo. An ID alone is never that proof. */
  preparedMaterialIds?: ReadonlySet<string>
  /** Plain image nodes whose actual immutable uploads were privately checked
   * by the caller. IDs are routing information, never range certificates. */
  preparedImageIds?: ReadonlySet<string>
  /** Trusted compiled-packet semantics only: absent own keys are native
   * culling sentinels, never permission to ignore missing authored nodes. */
  allowCulledNodes?: boolean
  maxDepth?: number
  /** Optional conservative planning guard. The renderer's real allocation
   * ledger remains authoritative, including its cache and scratch storage. */
  maxWorkingBytes?: number
  /** At most one numeric diagnostic for a rejected plan. Observer failures
   * are ignored and never change the admission result. */
  onReject?: (code: number) => void
}>

export const sequentialDisplayRejection = Object.freeze({
  scenePolicy: 1, output: 2, tree: 3, geometry: 4, blend: 5,
  clip: 6, mask: 7, replay: 8, strokes: 9, materialShape: 10,
  paint: 11, effects: 12, area: 13, materialCount: 14,
  duplicate: 15, unusedMaterial: 16, depth: 17, nodeCount: 18,
  workingBudget: 19, passthrough: 20, unusedImage: 21,
})

export type SequentialDisplayPlan = Readonly<{
  roots: readonly string[]
  /** Color scratch only. Original node, matrix and PathMesh bounds remain
   * unchanged; regional coverage must receive the original PathMesh. */
  regions: ReadonlyMap<string, Rect>
  maxDepth: number
  /** Deliberate upper estimate, not measured GPU residency. Transparent
   * isolation can initially use a shared one-texel zero surface. */
  estimatedPeakBytes: number
}>

const DEFAULT_MAX_DEPTH = 32
const MAX_NODES = 100_000
const positiveRect = (r: Rect) => !!r && exactBlendLattice([r]) && r.w > 0 && r.h > 0 &&
  Number.isSafeInteger(r.x + r.w) && Number.isSafeInteger(r.y + r.h)
const contains = (outer: Rect, inner: Rect) => inner.x >= outer.x && inner.y >= outer.y &&
  inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h
const finiteColor = (scene: GpuScene, color: string) => {
  const linear = scene.colors?.[color]
  // Regional copies may omit zero-weight neighbours. Keep all intermediates
  // finite so that cannot change the exact sampler's NaN-neighbour behavior.
  return linear ? Array.isArray(linear) && linear.length === 4 && linear.slice(0, 3).every(value =>
    Number.isFinite(value) && Math.abs(value) <= 65_536) &&
    Number.isFinite(linear[3]) && linear[3] >= 0 && linear[3] <= 1 : /^#[0-9a-f]{6}$/i.test(color)
}

/** Validate the regional coverage program, without snapping bounds or
 * interpreting packed f64 endpoint bits as ordinary finite f32 values. */
function fourSampleArea(path: PathMesh, curves: GpuScene['curves']): boolean {
  if (!path || !positiveRect(path.rect) || path.sampleCount !== 4 || !path.area ||
      !Number.isSafeInteger(path.count) || path.count <= 0 || !curves) return false
  const { first, count } = path.area
  if (!Number.isSafeInteger(first) || first < 0 || !Number.isSafeInteger(count) || count < 1 ||
      (first + count) * 4 > curves.length) return false
  const start = first * 4, end = (first + count) * 4, header = curves[start]
  if (curves[start + 2] !== path.rect.w || curves[start + 3] !== path.rect.h) return false
  if (header === 4) return count >= 7
  if (header !== 3) return false
  const rows = curves[start + 1]
  if (!Number.isSafeInteger(rows) || rows < 1 || rows + path.rect.h * 4 > count) return false
  const tableEnd = rows + path.rect.h * 4
  for (let row = 0; row < path.rect.h * 4; row++) {
    const at = start + (rows + row) * 4, span = curves[at], spans = curves[at + 1]
    if (!Number.isSafeInteger(span) || span < 0 || !Number.isSafeInteger(spans) || spans < 0 ||
        spans > 0 && span < tableEnd || span + spans * 3 > count || start + (span + spans * 3) * 4 > end) return false
  }
  return true
}

function materialLeaf(node: GpuNode): boolean {
  if (node.children.length || node.fills.length !== 1 || node.effects.length !== 1) return false
  const paint = node.fills[0], effect = node.effects[0]
  return paint.visible === true && paint.kind === 'image' && typeof paint.image === 'string' &&
    paint.image.length > 0 && paint.blend === 'normal' && paint.opacity === 1 &&
    effect.visible === true && effect.kind === 'blur' && !effect.gradientBlur &&
    Number.isFinite(effect.radius) && effect.radius > 0
}

/** Narrow admission for four sequential, correlated display samples. It
 * preserves every original tree/isolation boundary and painter order. The
 * caller still owns SDR screen routing, pixel-preview exclusion, material
 * proofs, shader availability and the actual shared memory/lifetime ledger.
 * Missing children reject unless trusted compiled-packet culling is explicitly
 * admitted; defined invalid entries always reject. */
export function planSequentialDisplay(scene: GpuScene, output: Rect,
  options: SequentialDisplayOptions): SequentialDisplayPlan | undefined {
  const codes = sequentialDisplayRejection
  let rejected = false
  const reject = (code: number): false => {
    if (!rejected) {
      rejected = true
      try { options.onReject?.(code) } catch { /* Diagnostics cannot alter admission. */ }
    }
    return false
  }
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  if (!options.managed || options.hdr || !options.present || options.readback ||
      !(scene.floatCompositing || scene.colorManagement) || scene.coherentSamples !== true ||
      scene.version !== 7 && scene.version !== 8 || scene.resolve || scene.presentation ||
      scene.interactionRetained || scene.nativeInteraction || scene.interactionWindow ||
      scene.softwareRaster || scene.grid || scene.checkerboard || scene.displayFilters) {
    reject(codes.scenePolicy); return
  }
  if (!finiteColor(scene, scene.background)) { reject(codes.paint); return }
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 128) { reject(codes.depth); return }
  if (options.maxWorkingBytes !== undefined &&
      (!Number.isSafeInteger(options.maxWorkingBytes) || options.maxWorkingBytes <= 0)) {
    reject(codes.workingBudget); return
  }
  if (!positiveRect(output) || output.w > 8192 || output.h > 8192 ||
      !positiveRect(scene.extent) || !contains(scene.extent, output)) { reject(codes.output); return }
  if (!Array.isArray(scene.roots) || !scene.nodes) { reject(codes.tree); return }
  const materialIds = options.preparedMaterialIds ?? new Set<string>()
  const imageIds = options.preparedImageIds ?? new Set<string>()
  if (materialIds.size > 1) { reject(codes.materialCount); return }
  const seen = new Set<string>(), regions = new Map<string, Rect>(), usedMaterials = new Set<string>(), usedImages = new Set<string>()
  let depth = 0, stackPeak = 0, transientPeak = 0
  const visit = (id: string, level: number, parentRegion: Rect | undefined, stackBytes: number): boolean => {
    // Reject shared incoming edges as well as cycles: one region per ID may
    // not stand in for two different isolation/opacity occurrences.
    if (typeof id !== 'string' || !id) return reject(codes.tree)
    if (seen.has(id)) return reject(codes.duplicate)
    if (seen.size >= MAX_NODES) return reject(codes.nodeCount)
    if (level > maxDepth) return reject(codes.depth)
    seen.add(id); depth = Math.max(depth, level)
    if (!Object.hasOwn(scene.nodes, id)) return options.allowCulledNodes === true || reject(codes.tree)
    const node = scene.nodes[id]
    if (!node || node.id !== id || !Array.isArray(node.children)) return reject(codes.tree)
    if (!positiveRect(node.rect) || !Number.isFinite(node.opacity) || node.opacity < 0 || node.opacity > 1)
      return reject(codes.geometry)
    const region = parentRegion && node.opacity > 0 ? intersect(node.rect, parentRegion) : undefined
    const contributes = !!region && region.w > 0 && region.h > 0
    let nextStack = stackBytes
    if (contributes) {
      if (node.blend !== 'normal') return reject(codes.blend)
      if (node.passthrough) return reject(codes.passthrough)
      if (node.mask || node.maskId) return reject(codes.mask)
      if (node.clip) return reject(codes.clip)
      if (node.captureReplay || node.textureReplay || node.previewSource || node.previewDynamic) return reject(codes.replay)
      if (!Array.isArray(node.fills) || !Array.isArray(node.strokes) || !Array.isArray(node.effects)) return reject(codes.tree)
      if (node.strokes.length) return reject(codes.strokes)
      if (!Array.isArray(node.matrix) || node.matrix.length !== 6 ||
          !node.matrix.every(Number.isFinite) || !Array.isArray(node.inverse) || node.inverse.length !== 6 ||
          !node.inverse.every(Number.isFinite) || !Array.isArray(node.size) || node.size.length !== 2 ||
          !node.size.every(value => Number.isFinite(value) && value >= 0)) return reject(codes.geometry)
      if (materialIds.has(id)) {
        if (!materialLeaf(node)) return reject(codes.materialShape)
        usedMaterials.add(id)
      } else {
        if (node.effects.length) return reject(codes.effects)
        if (node.fills.some(paint => paint.blend !== 'normal')) return reject(codes.blend)
        if (node.fills.some(paint => !Number.isFinite(paint.opacity) || paint.opacity < 0 || paint.opacity > 1 ||
            (paint.kind === 'solid' ? !finiteColor(scene, paint.color) :
              paint.kind !== 'image' || !imageIds.has(id) || paint.visible !== true ||
              typeof paint.image !== 'string' || !paint.image.length))) return reject(codes.paint)
        if (imageIds.has(id) && node.fills.some(paint => paint.kind === 'image')) usedImages.add(id)
      }
      if (node.fills.some(paint => paint.visible) && (!node.fill || !Number.isSafeInteger(node.fill.count) ||
          node.fill.count < 0 || node.fill.count > 0 && !fourSampleArea(node.fill, scene.curves))) return reject(codes.area)
      regions.set(id, Object.freeze({ ...region }))
      nextStack += region.w * region.h * 16
      stackPeak = Math.max(stackPeak, nextStack)
      transientPeak = Math.max(transientPeak, region.w * region.h * 20)
    }
    return node.children.every(child => visit(child, level + 1, contributes ? region : undefined, nextStack))
  }
  if (!scene.roots.every(id => visit(id, 1, output, 0))) return
  if ([...materialIds].some(id => !usedMaterials.has(id))) { reject(codes.unusedMaterial); return }
  if ([...imageIds].some(id => !usedImages.has(id))) { reject(codes.unusedImage); return }
  const estimatedPeakBytes = output.w * output.h * 16 * 3 + stackPeak + transientPeak
  if (!Number.isSafeInteger(estimatedPeakBytes) || options.maxWorkingBytes !== undefined &&
      estimatedPeakBytes > options.maxWorkingBytes) { reject(codes.workingBudget); return }
  return Object.freeze({ roots: Object.freeze([...scene.roots]), regions, maxDepth: depth, estimatedPeakBytes })
}
