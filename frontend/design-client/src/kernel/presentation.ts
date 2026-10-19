import { useSyncExternalStore } from 'react'
import type { CanvasCamera, CanvasSize } from '../canvas-camera'
import type { DesignDocument } from '../model'
import type { KernelOptions } from './client'
import { allowsColorPresentation, type RenderBackend, type RenderPolicy } from './render-policy'

export type ExactPresentation = {
  document: object
  pageId: string
  epoch: number
  view: CanvasCamera
  width: number
  height: number
  pixelRatio: number
  grid?: boolean
  checkerboard?: boolean
  pixelPreview?: 0 | 1 | 2
  rasterProfile?: KernelOptions['rasterProfile']
  animation?: KernelOptions['animation']
  displayCapability?: string
  /** Reprojected coarse presentation; geometry may use its camera, but it
   * cannot satisfy an exact-frame or CPU fallback completion contract. */
  preview?: boolean
}

function effectiveRasterProfile(frame: ExactPresentation) {
  const document = frame.document as Partial<DesignDocument>
  return frame.rasterProfile || document.rasterProfile ||
    (document.colorManagement ? 'figma' : 'analytic')
}

/** A completed frame belongs to one document snapshot and exact device viewport.
 * Document ids alone do not invalidate edits made while a renderer is awaiting work. */
export function presentationMatches(frame: ExactPresentation | null, requested: ExactPresentation) {
  return !!frame && frame.document === requested.document && frame.pageId === requested.pageId &&
    frame.epoch === requested.epoch && frame.width === requested.width &&
    frame.height === requested.height && frame.pixelRatio === requested.pixelRatio &&
    frame.view.x === requested.view.x && frame.view.y === requested.view.y &&
    frame.view.zoom === requested.view.zoom && !!frame.grid === !!requested.grid && !!frame.checkerboard === !!requested.checkerboard &&
    (frame.pixelPreview || 0) === (requested.pixelPreview || 0) &&
    effectiveRasterProfile(frame) === effectiveRasterProfile(requested) &&
    // Playback can finish behind the clock; seeks/replacements have an epoch.
    frame.animation?.clipId === requested.animation?.clipId &&
    frame.displayCapability === requested.displayCapability
}

/** A real presented camera may trail input. It still owns overlay/picking
 * coordinates, but must never certify the requested camera as complete. */
export function presentationContentMatches(frame: ExactPresentation | null, requested: ExactPresentation) {
  return !!frame && presentationMatches(frame, { ...requested, view: frame.view })
}

/** Automatic compute fallback may retain the original display capability. An
 * explicit CPU preference or a strict CPU host must never acquire a presenter. */
export function referencePresentationPolicy(
  policy: RenderPolicy,
  computeBackend: RenderBackend,
  fallbackFrom?: RenderBackend,
) {
  const backend = !policy.cpuOnly && computeBackend === 'cpu' && fallbackFrom === 'auto'
    ? fallbackFrom : computeBackend
  return {
    backend,
    requireManaged: policy.hdrCompositing && allowsColorPresentation(policy, backend),
  }
}

/** Null, stale, or failed CPU work cannot retire a previously complete GPU frame. */
export function canReplaceFallback(
  frame: ExactPresentation | null,
  requested: ExactPresentation,
  requireManaged: boolean,
  managed: boolean,
) {
  return !frame?.preview && (!requireManaged || managed) && presentationMatches(frame, requested)
}

/** The rendered camera uses one uniform device scale. Do not stretch rounded
 * backing dimensions back onto fractional layout dimensions: that introduces a
 * second, different scale for each axis and shifts geometry relative to handles.
 */
export function surfaceMetrics(
  width: number,
  height: number,
  quality: number,
  limits: { maxPixels?: number; maxDimension?: number } = {},
) {
  const ratio = Math.min(
    quality,
    Math.sqrt((limits.maxPixels ?? 4_000_000) / Math.max(1, width * height)),
    (limits.maxDimension ?? Infinity) / Math.max(1, width),
    (limits.maxDimension ?? Infinity) / Math.max(1, height),
  )
  const pixelWidth = Math.max(1, Math.ceil(width * ratio)),
    pixelHeight = Math.max(1, Math.ceil(height * ratio))
  return {
    ratio,
    pixelWidth,
    pixelHeight,
    cssWidth: pixelWidth / ratio,
    cssHeight: pixelHeight / ratio,
  }
}
export function frameTransform(view: CanvasCamera, frame: CanvasCamera) {
  const scale = view.zoom / frame.zoom
  return { x: view.x - frame.x * scale, y: view.y - frame.y * scale, scale }
}

export function frameCovers(
  view: CanvasCamera,
  frame: CanvasCamera,
  rendered: CanvasSize,
  viewport: CanvasSize,
  margin = 0,
) {
  const { x, y, scale } = frameTransform(view, frame)
  return (
    x <= -margin &&
    y <= -margin &&
    x + rendered.width * scale >= viewport.width + margin &&
    y + rendered.height * scale >= viewport.height + margin
  )
}

// Reserve pool headroom for masks/effects and texture sizes retained between frames.
// Calibrate from an actual successful GPU frame rather than assuming every SDR
// document uses byte textures: effects can require float compositing too.
export function previewPixelBudget(
  pixels: number,
  peakPixels: number,
  floating: boolean,
  maximum: number,
) {
  if (!(peakPixels > 0)) return maximum
  return Math.max(
    128_000,
    Math.min(
      maximum,
      Math.floor((pixels * (160 * 1024 * 1024)) / (peakPixels * (floating ? 16 : 4))),
    ),
  )
}

function subscribePixelRatio(changed: () => void) {
  let media: MediaQueryList
  const listen = () => {
    media?.removeEventListener('change', update)
    media = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
    media.addEventListener('change', update)
  }
  const update = () => { listen(); changed() }
  listen()
  window.addEventListener('resize', update)
  return () => {
    media.removeEventListener('change', update)
    window.removeEventListener('resize', update)
  }
}
/** A monitor scale change can leave CSS bounds unchanged. Repaint for its DPR. */
export function useDevicePixelRatio() {
  return useSyncExternalStore(subscribePixelRatio, () => window.devicePixelRatio || 1, () => 1)
}

function displayCapabilitySnapshot() {
  if (typeof window === 'undefined' || !window.matchMedia) return 'srgb/standard'
  return `${window.matchMedia('(color-gamut: p3)').matches ? 'p3' : 'srgb'}/${window.matchMedia('(dynamic-range: high)').matches ? 'high' : 'standard'}`
}
function subscribeDisplayCapability(changed: () => void) {
  const media = ['(color-gamut: p3)', '(dynamic-range: high)'].map(query => window.matchMedia(query))
  media.forEach(query => query.addEventListener('change', changed))
  return () => media.forEach(query => query.removeEventListener('change', changed))
}
/** Display encoding changes independently of CSS dimensions and render DPR. */
export function useDisplayCapability() {
  return useSyncExternalStore(subscribeDisplayCapability, displayCapabilitySnapshot, () => 'srgb/standard')
}
