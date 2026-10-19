import type { CanvasCamera } from '../canvas-camera'
import { calculateDynamicDensity, displayTileBudget } from './tile-cache'
import { allowsReducedSampling } from './render-quality'

/** Live zoom admits useful sharp pixels immediately at the next half-octave
 * density. Nearby inputs reuse that work instead of cancelling it every frame.
 * This is a host scheduling policy, not a recovered Figma constant; settled
 * frames still use their exact native scale. Never raise the display limit. */
export function motionRasterScale(view: CanvasCamera, dpr: number, width: number, height: number) {
  const requested = view.zoom * dpr, scale = 2 ** (Math.ceil(Math.log2(requested) * 2) / 2)
  if (scale > 128) return requested
  try { displayTileBudget(width, height, scale / view.zoom, false); return scale }
  catch { return requested }
}

/** Density is device pixels per world unit. The viewport must use world
 * units too, so zoom cancels instead of multiplying memory demand twice. */
export function canvasLodScale(zoom: number, dpr: number, width: number, height: number, maxTiles: number) {
  return calculateDynamicDensity(zoom * dpr, { width: width / zoom, height: height / zoom }, maxTiles)
}

/** Old sharp textures remain reusable, but new work at an old high density
 * must not exceed the display's budget during a rapid zoom-out. */
export function canvasSamplingScale(view: CanvasCamera, dpr: number, width: number, height: number,
  stableScale: number, hdr = false) {
  const requested = view.zoom * dpr
  if (stableScale <= requested) return allowsReducedSampling(view.zoom) ? stableScale : requested
  try { displayTileBudget(width, height, stableScale / view.zoom, hdr); return stableScale }
  catch { return requested }
}

/** Figma viewer's devicePixelsPerCanvasPixel = zoom * devicePixelRatio.
 * Density changes are debounced by the surface, not rounded to a scale ladder.
 * Canonical world samples remain reusable during translation at that density.
 * Pixel preview and screen-anchored chrome retain native sampling. */
export function canvasRasterPlan(
  view: CanvasCamera,
  dpr: number,
  width: number,
  height: number,
  options: { pixelPreview?: number; grid?: boolean; checkerboard?: boolean; rasterProfile?: string; hdr?: boolean;
    /** After camera motion, align final coverage to the display's pixel phase.
     * Moving cameras may keep reprojecting canonical tiles as a preview. */
    exactPhase?: boolean;
    /** Preserve the exact debounced world scale across camera reprojection. */
    samplingScale?: number },
) {
  if (![view.x, view.y, view.zoom, dpr, width, height].every(Number.isFinite) || view.zoom <= 0 || dpr <= 0)
    throw new Error('Invalid canvas raster density')
  const needed = options.samplingScale ?? view.zoom * dpr
  if (!Number.isFinite(needed) || needed <= 0) throw new Error('Invalid canvas sampling scale')
  const native = () => {
    const camera = { x: view.x * dpr, y: view.y * dpr, zoom: needed }
    return { mode: 'native' as const, scale: needed, camera,
      phase: { x: camera.x - Math.floor(camera.x), y: camera.y - Math.floor(camera.y) }, density: dpr }
  }
  if (options.pixelPreview || options.grid || options.checkerboard) return native()
  if (options.exactPhase && (!Number.isInteger(view.x * dpr) || !Number.isInteger(view.y * dpr))) return native()
  const ceiling = options.rasterProfile === 'figma' || options.rasterProfile === 'figmaSoftware' ? 64 : 128
  if (needed > ceiling) return native() // Preserve the renderer's explicit limit error.
  const scale = needed
  // World-origin rasterization must not send distant device coordinates past
  // exact half-pixel representation. Such views keep the existing local camera.
  if ([-view.x, width - view.x, -view.y, height - view.y]
    .some(value => Math.abs(value * scale / view.zoom) >= 4_000_000)) return native()
  const density = dpr
  try { displayTileBudget(width, height, density, !!options.hdr) }
  catch { return native() } // Extra density must not reject an otherwise supported display.
  return { mode: 'density-cache' as const, scale, camera: { x: 0, y: 0, zoom: scale },
    phase: { x: 0, y: 0 }, density }
}

/** Density alone cannot certify a reprojected tile as an exact display sample.
 * Both axes must land on the same device-pixel lattice as the current camera. */
export function canvasRasterPhaseMatches(view: CanvasCamera, dpr: number, scale: number, phase: { x: number; y: number }) {
  return scale === view.zoom * dpr &&
    Number.isInteger(view.x * dpr - phase.x) && Number.isInteger(view.y * dpr - phase.y)
}
