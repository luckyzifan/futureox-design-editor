import type { Bounds, DesignDocument, DesignNode, Effect, Matrix } from '../model'
import { zoomSourceHaloRejection } from './zoom-source-halo'

type CaptureEntry = {
  id: string
  matrix: Matrix
  bounds: Bounds
  ancestors: readonly string[]
  hidden?: boolean
}

export { zoomSourceHaloRejection }

/** Same device-pixel ceiling as `zoom_support::MAX_HALO`. This gate only
 * refuses a whole-frame interactive preview the kernel would reject. It does
 * not change the limit, the effect, or the exact tile path. */
const MAX_HALO = 2048

function matrixMaxScale(matrix: Matrix) {
  const [a, b, c, d] = matrix
  const sum = a * a + b * b + c * c + d * d
  const det = a * d - b * c
  const span = sum * sum - 4 * det * det
  return Math.sqrt((sum + Math.sqrt(span > 0 ? span : 0)) * 0.5)
}

function blurRadius(effect: Effect) {
  const gradient = effect.gradientBlur
  const factor = gradient ? (gradient.sketch ? 1 : Math.max(gradient.startCount, gradient.endCount, 1)) : 1
  return effect.radius * factor
}

function materialHalo(effect: Effect) {
  const glass = effect.glass
  if (glass) {
    return Math.max(glass.depth, glass.bevelSize ?? 1) * (1 + (glass.refraction + glass.dispersion * 0.125) * 2)
  }
  if (effect.texture) return effect.radius * 2
  if (effect.kind === 'texture' || effect.kind === 'glass') return Math.abs(effect.amount) * 2
  return 0
}

/** Mirrors `zoom_support::finite_support`. The `+ 2` term is device pixels. */
export function zoomSourceFilterHalo(effect: Effect, scale: number) {
  if (effect.kind === 'color-controls' || effect.kind === 'noise') return 0
  if (effect.kind === 'gaussian-blur' || effect.kind === 'motion-blur') {
    return effect.radius > 0 ? 3 * effect.radius * scale + 2 : 0
  }
  return (blurRadius(effect) * 2 + Math.abs(effect.spread) + Math.abs(effect.x) + Math.abs(effect.y) + materialHalo(effect)) * scale
}

function zoomActive(effect: Effect) {
  return effect.visible && !!effect.zoomBlur && Math.exp(-Math.fround(effect.zoomBlur.amount) / 50) !== 1
}

function controlsActive(effect: Effect) {
  const controls = effect.colorControls
  return !!controls && !(controls.brightness === 0 && controls.contrast === 1 && controls.saturation === 1 && controls.hue === 0)
}

function glassActive(effect: Effect) {
  const glass = effect.glass
  return effect.kind === 'glass' && (glass
    ? glass.refraction !== 0 || glass.dispersion !== 0 || glass.lightIntensity !== 0
    : effect.amount !== 0 || effect.opacity !== 0)
}

function backdropSelected(effect: Effect) {
  if (!effect.visible || (effect.kind !== 'background-blur' && effect.kind !== 'glass')) return false
  const radius = effect.kind === 'glass' && (effect.glass || (effect.amount === 0 && effect.opacity === 0 && effect.radius > 0))
    ? Math.max(effect.radius, 1) : blurRadius(effect)
  return radius > 0 || controlsActive(effect) || glassActive(effect)
}

function haloEffects(node: DesignNode) {
  const effects: Effect[] = []
  for (const effect of node.effects) {
    if (!effect.visible || effect.kind === 'background-blur' || effect.kind === 'glass' || effect.zoomBlur) continue
    effects.push(effect)
  }
  const backdrop = node.effects.find(backdropSelected)
  if (backdrop) effects.push(backdrop)
  return effects
}

function exceeds(value: number) {
  return !Number.isFinite(value) || Math.ceil(value) > MAX_HALO
}

function intersects(entry: Bounds, pad: number, capture: Bounds) {
  return entry.x - pad < capture.x + capture.width && entry.x + entry.width + pad > capture.x
    && entry.y - pad < capture.y + capture.height && entry.y + entry.height + pad > capture.y
}

function inRoots(entry: CaptureEntry, roots: ReadonlySet<string>) {
  return roots.has(entry.id) || entry.ancestors.some(id => roots.has(id))
}

/** True when a regular interactive preview of `capture` at `cameraZoom`
 * device pixels per world unit would be rejected by the zoom-source halo
 * guard. Exact tiles use a smaller capture and are not decided here.
 * `roots` limits the check to one interaction-layer subtree. The caller
 * passes the scene entries it already published; this does not walk Rust. */
export function zoomSourcePreviewExceedsHalo(document: DesignDocument, _pageId: string, capture: Bounds,
  cameraZoom: number, entries: readonly CaptureEntry[] = [], roots?: readonly string[]) {
  if (!(cameraZoom > 0) || !Number.isFinite(cameraZoom) || !(capture.width > 0) || !(capture.height > 0)) return false
  const rootSet = roots ? new Set(roots) : undefined
  const considered = rootSet ? entries.filter(entry => inRoots(entry, rootSet)) : entries
  if (!considered.some(entry => document.nodes[entry.id]?.effects.some(zoomActive))) return false
  for (const entry of considered) {
    if (entry.hidden) continue
    const node = document.nodes[entry.id]
    if (!node?.visible) continue
    const scale = matrixMaxScale(entry.matrix) * cameraZoom
    if (!(scale > 0) || !Number.isFinite(scale)) continue
    let pad = 0
    let rejected = false
    for (const effect of haloEffects(node)) {
      const halo = zoomSourceFilterHalo(effect, scale)
      if (exceeds(halo)) rejected = true
      pad = Math.max(pad, halo > 0 ? halo / scale : 0)
    }
    if (rejected && intersects(entry.bounds, pad, capture)) return true
  }
  return false
}
