import { MAX_CANVAS_RASTER_SCALE, type CanvasCamera } from '../canvas-camera'
import { calculateDynamicDensity, displayTileBudget, tileLevel } from './tile-cache'
import { allowsReducedSampling } from './render-quality'
import { usesDesktopDisplay, type DisplayRenderRequest, type RenderPolicy } from './render-policy'

export type GestureDensityRequest = Readonly<{
  /** Immutable trusted host policy, never document metadata. */
  policy: RenderPolicy
  active: boolean
  request: DisplayRenderRequest
  grid?: boolean
  checkerboard?: boolean
}>

/** Experimental display-only headroom. One rung ahead of the next
 * quarter-octave world lattice can
 * finish useful pixels for adjacent zoom inputs without sampling below the
 * current physical screen density. Undefined keeps the caller's ordinary
 * route, including settled native-phase repair and all exact outputs.
 * This chooses density only; it never certifies a reprojected native phase. */
export function gestureRasterScale(view: CanvasCamera, dpr: number, width: number, height: number,
  options: GestureDensityRequest): number | undefined {
  if (import.meta.env.VITE_DESIGN_GESTURE_DENSITY_HEADROOM !== '1' || options.active !== true ||
      options.grid || options.checkerboard || !usesDesktopDisplay(options.policy, options.request)) return
  if (![view.x, view.y, view.zoom, dpr, width, height].every(Number.isFinite) ||
      view.zoom <= 0 || dpr <= 0 || width < 0 || height < 0) return
  const requested = view.zoom * dpr
  const nextRung = Math.round(Math.log2(tileLevel(requested)) * 4) + 1
  const scale = 2 ** (nextRung / 4)
  const ceiling = options.request.rasterProfile === 'figma' ? 64 : 128
  // tileLevel clamps its supported range. Neither end of that clamp may turn
  // headroom into undersampling or many speculative levels at tiny zoom.
  if (!Number.isFinite(requested) || requested <= 0 || scale > ceiling ||
      scale / requested < 2 ** .25 - Number.EPSILON * 8 ||
      scale / requested > Math.SQRT2 + Number.EPSILON * 8) return
  // Keep the original world sample lattice. A captured window may translate
  // it by an integer pixel origin; far views retain their existing camera route.
  if ([-view.x, width - view.x, -view.y, height - view.y]
    .some(value => Math.abs(value * scale / view.zoom) >= 4_000_000)) return
  try { displayTileBudget(width, height, scale / view.zoom, false) }
  catch { return }
  return scale
}

export type GestureViewportCapture = Readonly<{
  camera: CanvasCamera
  tile: Readonly<{ x: number; y: number; w: number; h: number; zoom: number }>
}>

/** Pure geometry for an explicitly selected gesture density. A fixed target
 * size and 128-pixel world lattice avoid allocating a new color-target shape
 * for every fractional zoom. The local camera translates that same world
 * lattice; presentation still uses the actual scale and global tile origin.
 * This is a transient capture, never a native-phase or exact-output proof. */
export function gestureViewportCapture(view: CanvasCamera, dpr: number, width: number, height: number,
  scale: number): GestureViewportCapture | undefined {
  if (![view.x, view.y, view.zoom, dpr, width, height, scale].every(Number.isFinite) ||
      view.zoom <= 0 || dpr <= 0 || width <= 0 || height <= 0 || scale <= 0 || scale > 128) return
  const requested = view.zoom * dpr
  if (!Number.isFinite(requested) || requested <= 0 || scale < requested ||
      scale / requested > Math.SQRT2 + Number.EPSILON * 8) return
  const w = Math.ceil((width * dpr * Math.SQRT2 + 128) / 128) * 128
  const h = Math.ceil((height * dpr * Math.SQRT2 + 128) / 128) * 128
  if (![w, h].every(Number.isSafeInteger) || w > 8192 || h > 8192 || w * h > 8_388_608) return
  const left = -view.x / view.zoom * scale, top = -view.y / view.zoom * scale
  const right = (width - view.x) / view.zoom * scale, bottom = (height - view.y) / view.zoom * scale
  const x = Math.floor(left / 128) * 128, y = Math.floor(top / 128) * 128
  // Include the padded target in the same exact-coordinate guard as ordinary
  // world rasterization; a visible ROI alone is insufficient near the limit.
  if (![left, top, right, bottom, x, y, x + w, y + h].every(value =>
    Number.isFinite(value) && Math.abs(value) < 4_000_000) ||
      left < x || top < y || right > x + w || bottom > y + h) return
  return { camera: { x: -x, y: -y, zoom: scale }, tile: { x, y, w, h, zoom: scale } }
}

export function motionRasterScale(view: CanvasCamera, dpr: number, width: number, height: number) {
  const requested = view.zoom * dpr, scale = 2 ** (Math.ceil(Math.log2(requested) * 2) / 2)
  if (scale > 128) return requested
  try { displayTileBudget(width, height, scale / view.zoom, false); return scale }
  catch { return requested }
}

/** Reuse a quarter-octave world lattice without undersampling or increasing
 * the current viewport's admission allowance for speculative headroom. */
export function nativeTileMotionScale(view: CanvasCamera, dpr: number, width: number, height: number) {
  const requested = view.zoom * dpr, scale = tileLevel(requested)
  if (!(requested > 0) || !Number.isFinite(requested) || scale < requested ||
      scale / requested > 2 ** .25 + Number.EPSILON * 8) return requested
  try {
    return displayTileBudget(width, height, scale / view.zoom, false) === displayTileBudget(width, height, dpr, false)
      ? scale : requested
  } catch { return requested }
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

/** Raster density is zoom * devicePixelRatio.
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
    const ratio=needed===view.zoom*dpr ? dpr : needed/view.zoom
    const camera = { x: view.x * ratio, y: view.y * ratio, zoom: needed }
    return { mode: 'native' as const, scale: needed, camera,
      phase: { x: camera.x - Math.floor(camera.x), y: camera.y - Math.floor(camera.y) }, density: dpr }
  }
  if (options.pixelPreview || options.grid || options.checkerboard) return native()
  if (options.exactPhase && (!Number.isInteger(view.x * dpr) || !Number.isInteger(view.y * dpr))) return native()
  const ceiling = options.rasterProfile === 'figma' || options.rasterProfile === 'figmaSoftware' ? MAX_CANVAS_RASTER_SCALE / 2 : MAX_CANVAS_RASTER_SCALE
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

/** A whole-device-pixel pan can continue an already-native sample lattice.
 * Do not switch it to phase zero only to rebuild the same native lattice at
 * settle. This certifies sampling geometry, never content/cache ownership. */
export function preservesNativePanPhase(
  view: CanvasCamera, dpr: number, scale: number, cameraDependent: boolean,
  previous?: { view: CanvasCamera; dpr: number; rasterScale: number; samplingMode: string } | null,
) {
  if (!previous || cameraDependent || !['native', 'density-cache'].includes(previous.samplingMode) ||
      ![view.x, view.y, view.zoom, dpr, scale, previous.view.x, previous.view.y, previous.view.zoom].every(Number.isFinite) ||
      dpr <= 0 || view.zoom <= 0 || previous.dpr !== dpr || previous.view.zoom !== view.zoom ||
      scale !== view.zoom * dpr || previous.rasterScale !== scale) return false
  // Canonical world tiles are already native when the original camera lands
  // on integer device pixels. Their mode name must not force a low-density
  // viewport recapture before repairing the newly exposed strips of a pan.
  if (previous.samplingMode === 'density-cache' &&
      (!Number.isInteger(previous.view.x*dpr) || !Number.isInteger(previous.view.y*dpr))) return false
  const sameAxis = (current: number, prior: number) => {
    const a = current * dpr, b = prior * dpr
    // Exact equality avoids issuing a new floating-point phase key or silently
    // snapping genuinely fractional movement to an old sample lattice.
    return Number.isInteger(a - b) && a - Math.floor(a) === b - Math.floor(b)
  }
  return sameAxis(view.x, previous.view.x) && sameAxis(view.y, previous.view.y)
}
