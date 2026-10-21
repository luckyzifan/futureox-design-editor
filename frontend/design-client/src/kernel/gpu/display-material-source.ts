import type { ExactImageRange } from './exact-image-x-table'
import type { GpuNode, GpuScene, Rect } from './types'

export type DisplayMaterialSourcePlan = Readonly<{ radius: number }>
const MATRIX_RELATIVE_TOLERANCE = 1e-12
const MAX_SOURCE_PIXELS = 1_500_000

const validRect = (r: Rect) => [r.x, r.y, r.w, r.h, r.x + r.w, r.y + r.h].every(Number.isSafeInteger) &&
  r.w > 0 && r.h > 0

/** Optional screen-material admission, not an exact-output or texture proof.
 * Source-space filtering/reconstruction is not the original device-lattice
 * convolution. The explicit 1e-12 matrix tolerance is a display approximation;
 * this function never snaps the matrix or replaces the original image grid.
 *
 * The caller owns display-only routing, the actual immutable upload/range
 * binding, fullSampleCoverage over the complete device halo, source-coordinate
 * bounds/edge admission, mip/atlas rejection, cache identity and GPU lifetime.
 * In particular, receiving this plan must not mint a finite-pixel certificate.
 */
export function planDisplayMaterialSource(scene: GpuScene, node: GpuNode, input: Rect,
  imageWidth: number, imageHeight: number, range: ExactImageRange | undefined): DisplayMaterialSourcePlan | undefined {
  if (scene.floatCompositing !== true || scene.coherentSamples !== true || scene.integratedBlur !== true ||
      scene.resolve || scene.presentation || scene.softwareRaster || scene.displayFilters ||
      node.children.length || node.strokes.length || node.mask || node.maskId || node.clip || node.passthrough ||
      node.previewSource || node.captureReplay || node.textureReplay || node.blend !== 'normal') return
  if (!validRect(input) || !validRect(node.rect) || input.w > 8192 || input.h > 8192 ||
      input.x < node.rect.x || input.y < node.rect.y ||
      input.x + input.w > node.rect.x + node.rect.w || input.y + input.h > node.rect.y + node.rect.h) return
  if (![imageWidth, imageHeight].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2048) ||
      imageWidth * imageHeight > MAX_SOURCE_PIXELS || !range || range.pixels !== imageWidth * imageHeight ||
      range.opaqueAlpha !== true || range.nonnegativeRgb !== true || range.maximum.length !== 4 ||
      !range.maximum.every(value => Number.isInteger(value) && value >= 1 && value <= 127)) return
  const fills = node.fills.filter(paint => paint.visible), effects = node.effects.filter(effect => effect.visible)
  if (fills.length !== 1 || effects.length !== 1) return
  const paint = fills[0], effect = effects[0]
  if (paint.kind !== 'image' || !paint.image || paint.blend !== 'normal' || paint.opacity !== 1 ||
      paint.fit !== 'cover' || paint.transform !== undefined || paint.tile !== undefined || paint.adjust !== undefined ||
      effect.kind !== 'blur' || effect.gradientBlur || !Number.isFinite(effect.radius) || effect.radius <= 0) return
  if (node.size.length !== 2 || !node.size.every(value => Number.isFinite(value) && value > 0) ||
      node.matrix.length !== 6 || !node.matrix.every(Number.isFinite)) return
  // Exact aspect equality makes cover identical to a whole-image fit. Do not
  // infer that crop/contain or a nearly matching aspect has the same support.
  const horizontalAspect = imageWidth * node.size[1], verticalAspect = imageHeight * node.size[0]
  if (!Number.isFinite(horizontalAspect) || horizontalAspect !== verticalAspect) return
  const [a, b, c, d] = node.matrix, sx = Math.abs(a), sy = Math.abs(d), scale = Math.max(sx, sy)
  if (!(sx > 0 && sy > 0) || !Number.isFinite(scale) ||
      Math.max(Math.abs(b), Math.abs(c)) / scale > MATRIX_RELATIVE_TOLERANCE ||
      Math.abs(sx - sy) / scale > MATRIX_RELATIVE_TOLERANCE) return
  // Keep one camera-independent radius for the admitted similarity mapping.
  // Node opacity remains the caller's post-filter merge; it is not baked here.
  const radius = effect.radius * (imageWidth / node.size[0])
  return Number.isFinite(radius) && radius > 0 && radius <= 32 ? Object.freeze({ radius }) : undefined
}
