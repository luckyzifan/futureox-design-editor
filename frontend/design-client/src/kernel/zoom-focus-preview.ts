/** Admission for a live Zoom Blur preview at the exact canvas's analytic zoom.
 *
 * A whole-scene compile with no region returns
 * `Zoom source filter halo exceeds 2048 device pixels` when a sibling Gaussian
 * is wider than that device-pixel guard. The same camera, output, and effects
 * compile when the request is the existing analytic capture: the wide image
 * keeps its projection (`sigma > 1024`) and the Zoom Blur stays in the scene.
 * The flag alone does not admit a regionless compile. Density, the 2048 guard,
 * and effect omission stay unchanged.
 */
export const ZOOM_SOURCE_HALO_DEVICE_PIXELS = 2048
export const WIDE_GAUSSIAN_SIGMA = 1024
/** Capture compiler limit. Larger outputs use the same analytic flag per tile. */
export const ANALYTIC_CAPTURE_LIMIT = 8_388_608
export const ANALYTIC_CAPTURE_SIDE = 8192
export const ANALYTIC_ZOOM_TILE_SIDE = 512

export type ZoomPreviewEffect = {
  visible?: boolean
  kind?: string
  radius?: number
  zoomBlur?: { amount?: number } | null
}

export type ZoomPreviewRequest = {
  livePreview?: boolean
  renderIntent?: string
  sequentialViewport?: boolean
  rasterProfile?: string
  backend?: string
  zoom?: number
  width?: number
  height?: number
  analyticRegionsEnabled: boolean
  hasTileViewport: boolean
  hasCaptureViewport: boolean
  hasGpuViewport: boolean
  captureWidth?: number
  captureHeight?: number
  effects: readonly ZoomPreviewEffect[]
}

export type ZoomPreviewAdmission =
  | { kind: 'unchanged' }
  | { kind: 'capture' }
  | { kind: 'tiles' }

export function zoomPreviewEffects(nodes: Record<string, { effects?: readonly ZoomPreviewEffect[] } | undefined> | undefined) {
  if (!nodes) return []
  const effects: ZoomPreviewEffect[] = []
  for (const node of Object.values(nodes)) if (node?.effects) effects.push(...node.effects)
  return effects
}

export function doomedZoomSourceHalo(zoom: number, effects: readonly ZoomPreviewEffect[]) {
  let zoomBlur = false
  let wideGaussian = false
  for (const effect of effects) {
    if (effect.visible === false) continue
    if (effect.zoomBlur && typeof effect.zoomBlur.amount === 'number' && effect.zoomBlur.amount > 0) zoomBlur = true
    if (effect.kind === 'gaussian-blur' && typeof effect.radius === 'number' && effect.radius > 0) {
      const sigma = effect.radius * zoom
      if (sigma > WIDE_GAUSSIAN_SIGMA && 3 * effect.radius * zoom + 2 > ZOOM_SOURCE_HALO_DEVICE_PIXELS) wideGaussian = true
    }
  }
  return zoomBlur && wideGaussian
}

/** How the live preview should compile. `capture` is one analytic region of the
 * output. `tiles` is the same flag on 512px tiles when one capture cannot fit. */
export function zoomPreviewAdmission(input: ZoomPreviewRequest): ZoomPreviewAdmission {
  const zoom = input.zoom
  if (input.livePreview !== true || input.renderIntent !== 'preview' || input.hasTileViewport || input.sequentialViewport) return { kind: 'unchanged' }
  if (input.backend !== 'webgpu' || input.rasterProfile !== 'analytic' || !input.analyticRegionsEnabled) return { kind: 'unchanged' }
  if (typeof zoom !== 'number' || !Number.isFinite(zoom) || zoom < 32) return { kind: 'unchanged' }
  if (!doomedZoomSourceHalo(zoom, input.effects)) return { kind: 'unchanged' }
  if (input.hasGpuViewport) return { kind: 'capture' }
  const width = input.hasCaptureViewport ? input.captureWidth ?? input.width : input.width
  const height = input.hasCaptureViewport ? input.captureHeight ?? input.height : input.height
  if (!fitsAnalyticCapture(width, height)) return typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0
    ? { kind: 'tiles' } : { kind: 'unchanged' }
  return { kind: 'capture' }
}

export function withAnalyticZoomPreview<T extends {
  livePreview?: boolean
  renderIntent?: string
  sequentialViewport?: boolean
  rasterProfile?: string
  width: number
  height: number
  view: { zoom: number }
  captureViewport?: { x: number; y: number; w: number; h: number }
  gpuAnalyticRegions?: boolean
  tileViewport?: unknown
}>(options: T, input: { backend?: string; analyticRegionsEnabled: boolean; effects: readonly ZoomPreviewEffect[] }):
  { kind: 'capture'; options: T } | { kind: 'tiles'; options: T } | undefined {
  const admission = zoomPreviewAdmission({
    livePreview: options.livePreview, renderIntent: options.renderIntent, sequentialViewport: options.sequentialViewport,
    rasterProfile: options.rasterProfile, backend: input.backend, zoom: options.view.zoom,
    width: options.width, height: options.height, analyticRegionsEnabled: input.analyticRegionsEnabled,
    hasTileViewport: !!options.tileViewport, hasCaptureViewport: !!options.captureViewport, hasGpuViewport: false,
    captureWidth: options.captureViewport?.w, captureHeight: options.captureViewport?.h, effects: input.effects,
  })
  if (admission.kind === 'unchanged') return undefined
  if (admission.kind === 'tiles') {
    const { captureViewport: _capture, ...rest } = options
    return { kind: 'tiles', options: { ...rest, gpuAnalyticRegions: true } as T }
  }
  return { kind: 'capture', options: {
    ...options, gpuAnalyticRegions: true,
    captureViewport: options.captureViewport ?? { x: 0, y: 0, w: options.width, h: options.height },
  } as T }
}

function fitsAnalyticCapture(width: unknown, height: unknown): width is number {
  return typeof width === 'number' && typeof height === 'number' && Number.isSafeInteger(width) && Number.isSafeInteger(height) &&
    width >= 1 && height >= 1 && width <= ANALYTIC_CAPTURE_SIDE && height <= ANALYTIC_CAPTURE_SIDE &&
    width * height <= ANALYTIC_CAPTURE_LIMIT
}
