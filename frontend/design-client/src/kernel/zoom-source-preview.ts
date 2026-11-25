import { apply, multiply } from '../commands/affine'
import type { DesignDocument, Effect, Matrix } from '../model'

/** Mirrors `zoom_support::finite_support`. This does not raise or bypass the
 * kernel's 2048 device-pixel admission; it only predicts that a whole-page
 * interactive preview would be rejected before any pixels are produced. */
const MAX_DEVICE_HALO = 2048
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

export type WorldRect = { x: number; y: number; width: number; height: number }

export function isZoomSourceHaloAdmission(error: unknown) {
  return /Zoom source filter halo exceeds 2048 device pixels|Combined zoom source dependency halo exceeds 2048 device pixels/.test(String(error))
}

function zoomSamples(effect: Effect) {
  const zoom = effect.zoomBlur
  return !!effect.visible && !!zoom && Number.isFinite(zoom.amount) && Math.exp(-Math.fround(zoom.amount) / 50) !== 1
}

function materialHalo(effect: Effect) {
  const glass = effect.glass
  if (glass) {
    const bevel = glass.bevelSize ?? 1
    return Math.max(glass.depth, bevel) * (1 + (glass.refraction + glass.dispersion * 0.125) * 2)
  }
  if (effect.texture) return effect.radius * 2
  if (effect.kind === 'texture' || effect.kind === 'glass') return Math.abs(effect.amount) * 2
  return 0
}

/** Device pixels of non-zoom filter support. Zoom parameters themselves use
 * the radial source transform and are not this halo. */
export function zoomSourceFilterHaloDevicePixels(effect: Effect, scale: number) {
  if (!effect.visible || effect.zoomBlur) return 0
  if (effect.kind === 'color-controls' || effect.kind === 'noise') return 0
  if (effect.kind === 'gaussian-blur' || effect.kind === 'motion-blur')
    return effect.radius > 0 ? 3 * effect.radius * scale + 2 : 0
  const gradient = effect.gradientBlur
  const blur = effect.radius * (gradient && !gradient.sketch ? Math.max(1, gradient.startCount, gradient.endCount) : 1)
  return (blur * 2 + Math.abs(effect.spread) + Math.abs(effect.x) + Math.abs(effect.y) + materialHalo(effect)) * scale
}

function exceedsDeviceHalo(value: number) {
  return !Number.isFinite(value) || Math.ceil(value) > MAX_DEVICE_HALO
}

/** Same singular value as `Transform::max_scale`. The camera scale is applied
 * separately; this is only the placed node matrix. */
function matrixMaxScale(matrix: Matrix) {
  const [a, b, c, d] = matrix
  const sum = a * a + b * b + c * c + d * d
  const det = a * d - b * c
  const span = sum * sum - 4 * det * det
  return Math.sqrt((sum + Math.sqrt(span > 0 ? span : 0)) * 0.5)
}

function boundsOf(matrix: Matrix, width: number, height: number, pad: number): WorldRect {
  const corners = [apply(matrix, { x: 0, y: 0 }), apply(matrix, { x: width, y: 0 }),
    apply(matrix, { x: 0, y: height }), apply(matrix, { x: width, y: height })]
  const xs = corners.map(point => point.x), ys = corners.map(point => point.y)
  const x = Math.min(...xs) - pad, y = Math.min(...ys) - pad
  return { x, y, width: Math.max(...xs) + pad - x, height: Math.max(...ys) + pad - y }
}

function intersects(a: WorldRect, b: WorldRect) {
  return a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0 &&
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/** True when a whole-page interactive preview at `scale` device pixels per
 * world unit would hit the existing zoom-source halo admission. A missing
 * viewport means the preview may sample any page content. Effects that cannot
 * reach the preview's viewport do not count: only that hit range is rejected. */
export function zoomSourcePreviewExceedsDeviceHalo(document: DesignDocument, pageId: string, scale: number, viewport?: WorldRect) {
  if (document.schemaVersion < 19 || !Number.isFinite(scale) || scale <= 0) return false
  const page = document.pages.find(entry => entry.id === pageId)
  if (!page) return false
  let zoom = false
  let halo = false
  const visit = (id: string, parent: Matrix) => {
    const node = document.nodes[id]
    if (!node?.visible || node.opacity <= 0) return
    const matrix = multiply(parent, node.transform)
    const placed = matrixMaxScale(matrix)
    for (const effect of node.effects) {
      if (zoomSamples(effect)) zoom = true
      // `finite_support` uses the device matrix, camera scale times the placed
      // node scale. The world pad is that device halo divided by camera scale.
      const support = zoomSourceFilterHaloDevicePixels(effect, placed * scale)
      if (!exceedsDeviceHalo(support)) continue
      const pad = support / scale
      if (!viewport || intersects(boundsOf(matrix, node.width, node.height, pad), viewport)) halo = true
    }
    for (const child of node.children) visit(child, matrix)
  }
  for (const id of page.children) visit(id, IDENTITY)
  return zoom && halo
}
