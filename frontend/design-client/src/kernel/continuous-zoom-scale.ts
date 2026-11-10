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
