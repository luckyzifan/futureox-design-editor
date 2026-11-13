import { MOVING_DETAIL_CORE } from './source-display-band'
import { MAX_PREVIEW_SCALE_RATIO } from './tile-preview'

/** Sampling scale to raster during a continuous zoom-in.
 * One lattice stays in flight across wheel ticks. It is replaced when the
 * camera is more than the preview ratio ahead of it. The replacement is at
 * least half the current native density, so the picture being waited on is
 * not the fit bitmap stretched far past that ratio. The result never exceeds
 * the caller's motion scale or the native density. Settled certification
 * still uses the native lattice. */
export function continuousZoomInScale(visibleDensity: number, native: number, motionScale: number, held: number) {
  if (!(visibleDensity > 0) || !(native > visibleDensity) || !(motionScale > 0) || !Number.isFinite(native)) return motionScale
  if (held > visibleDensity && held <= native * 1.2 && held * MAX_PREVIEW_SCALE_RATIO >= native) return held
  const step = 2 ** (Math.floor(Math.log2(visibleDensity) * 2 + 1e-9) / 2 + 0.5)
  const half = native / MAX_PREVIEW_SCALE_RATIO
  const pow = half > 0 && Number.isFinite(half) ? 2 ** Math.ceil(Math.log2(half) - 1e-12) : native
  return Math.min(motionScale, Math.min(native, Math.max(step, pow)))
}

/** Device-pixel side of one moving zoom-in tile, when a 514px tile would
 * keep the previous picture stretched. Undefined keeps the caller's lattice.
 * The bound is the existing moving-detail core, not a new batch size. */
export function zoomInLatticeCore(scale: number, native: number) {
  if (!(scale >= 2) || !(native < 8) || !(scale + 1e-9 < native)) return
  if (!(scale * MAX_PREVIEW_SCALE_RATIO + 1e-6 >= native)) return
  return MOVING_DETAIL_CORE
}

/** CSS zoom of the coarsest sample still in the picture. A camera acknowledgement
 * can move to the live view while the texels are still the stretched fit. */
export function zoomInSampleZoom(cameraZoom: number, dpr: number, sampleZooms: readonly number[]) {
  if (!(cameraZoom > 0) || !Number.isFinite(cameraZoom)) return cameraZoom
  if (!(dpr > 0) || !Number.isFinite(dpr)) return cameraZoom
  const samples = sampleZooms.filter(zoom => Number.isFinite(zoom) && zoom > 0)
  if (!samples.length) return cameraZoom
  return Math.min(cameraZoom, Math.min(...samples) / dpr)
}

/** Raster scale that replaces a fit bitmap stretched past the preview ratio.
 * The result stays inside that ratio of the live camera and below native
 * density, so the settled lattice is unchanged. Undefined means the picture
 * is already inside the ratio, or the only legal sample is native density. */
export function continuousZoomReplacementScale(displayedZoom: number, requestedZoom: number, dpr: number) {
  if (!(dpr > 0) || !Number.isFinite(dpr) || !Number.isFinite(displayedZoom) || !Number.isFinite(requestedZoom)) return
  if (!(displayedZoom > 0) || !(requestedZoom > displayedZoom)) return
  if (requestedZoom / displayedZoom <= MAX_PREVIEW_SCALE_RATIO) return
  const native = requestedZoom * dpr
  const visible = displayedZoom * dpr
  const scale = continuousZoomInScale(visible, native, native, 0)
  if (!(scale > 0) || !(scale + 1e-9 < native)) return
  return { scale, core: zoomInLatticeCore(scale, native) }
}
