import type { CanvasCamera, CanvasSize } from '../canvas-camera'
import { presentationMatches, type ExactPresentation } from './presentation'
import type { BackendPreference } from './gpu/types'
import type { RasterTile } from './tile-cache'

export const CAMERA_REFINE_IDLE_MS = 120

/** A displayed bitmap may be resampled by at most this factor before it counts
 * as a certified frame of the requested camera. A larger jump stays on screen,
 * CSS-reprojected, until a closer image covers the viewport. */
export const MAX_PREVIEW_SCALE_RATIO = 2

export function previewUpscaleWithinLimit(sourceZoom: number, viewZoom: number) {
  if (!(sourceZoom > 0) || !(viewZoom > 0) || !Number.isFinite(sourceZoom) || !Number.isFinite(viewZoom)) return false
  return viewZoom / sourceZoom <= MAX_PREVIEW_SCALE_RATIO
}

/** CSS camera reprojection in either direction. Downscaling a 25600% crop
 * onto a 100% viewport is the same class of stale picture as stretching a
 * page thumbnail up to the card. */
export function previewCameraScaleWithinLimit(sourceZoom: number, viewZoom: number) {
  if (!previewUpscaleWithinLimit(sourceZoom, viewZoom)) return false
  return sourceZoom / viewZoom <= MAX_PREVIEW_SCALE_RATIO
}

/** 3200% back to 100% or 25% is outside the preview ratio. The flat page
 * color and the camera-preview white are the blank/gray gap. A same-zoom
 * pan, and a zoom-in, stay on their existing paths. */
export function zoomOutBeyondPreview(sourceZoom: number, viewZoom: number) {
  if (!(sourceZoom > 0) || !(viewZoom > 0) || !Number.isFinite(sourceZoom) || !Number.isFinite(viewZoom)) return false
  return sourceZoom > viewZoom && !previewCameraScaleWithinLimit(sourceZoom, viewZoom)
}

/** The last complete bitmap stays visible past the preview ratio until a closer
 * image covers the viewport. Failing the ratio still refuses to certify it. */
export function showRetainedPreview(input: {
  sourceZoom: number
  viewZoom: number
  intersects: boolean
  replacementCovers: boolean
}) {
  if (!input.intersects) return false
  if (input.replacementCovers && !previewCameraScaleWithinLimit(input.sourceZoom, input.viewZoom)) return false
  return true
}

export function previewPlacementIntersects(
  placed: { x: number; y: number; scale: number },
  sourceWidth: number,
  sourceHeight: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  if (![placed.x, placed.y, placed.scale, sourceWidth, sourceHeight, viewportWidth, viewportHeight].every(Number.isFinite)) return false
  if (!(placed.scale > 0) || !(sourceWidth > 0) || !(sourceHeight > 0) || !(viewportWidth > 0) || !(viewportHeight > 0)) return false
  const right = placed.x + sourceWidth * placed.scale
  const bottom = placed.y + sourceHeight * placed.scale
  return placed.x < viewportWidth && placed.y < viewportHeight && right > 0 && bottom > 0
}

export type TilePreviewContract = ExactPresentation & {
  computeBackend: BackendPreference
  managed: boolean
}

/** A temporary camera transform may reuse pixels only within the complete
 * raster contract. It does not certify those pixels at the requested zoom. */
export function tilePreviewContractMatches(
  frame: TilePreviewContract | null,
  requested: TilePreviewContract,
) {
  return !!frame && frame.computeBackend === requested.computeBackend &&
    frame.managed === requested.managed &&
    presentationMatches({ ...frame, view: requested.view }, requested)
}

/** CSS-only reprojection of already sampled world tiles. Final raster inputs,
 * subpixel sampling, and the exact zoom are deliberately left unchanged. */
export function tilePlacementAtView(tile: RasterTile, view: CanvasCamera) {
  const scale = view.zoom / tile.zoom
  return {
    left: (tile.x - (tile.phaseX || 0)) * scale + view.x,
    top: (tile.y - (tile.phaseY || 0)) * scale + view.y,
    width: tile.width * scale,
    height: tile.height * scale,
  }
}

/** Exact screen sample lattice, not merely enough texture density. A cached
 * denser or fractionally placed image cannot outrank these native samples. */
export function tileHasNativePhase(tile:RasterTile,view:CanvasCamera,dpr:number){
  if(!Number.isFinite(dpr)||dpr<=0||!Number.isFinite(view.zoom)||view.zoom<=0||
      tile.zoom!==view.zoom*dpr||!Number.isSafeInteger(tile.width)||!Number.isSafeInteger(tile.height)||
      tile.width<1||tile.height<1)return false
  const placement=tilePlacementAtView(tile,view)
  return Number.isInteger(placement.left*dpr)&&Number.isInteger(placement.top*dpr)
}

/** Gutters are display overlap, not content coverage. A cached tile elsewhere
 * on the page cannot make this viewport's preview appear available. */
export function tileIntersectsView(tile: RasterTile, view: CanvasCamera, size: CanvasSize) {
  const scale = view.zoom / tile.zoom
  const gutter=tile.gutter??1
  const left = (tile.x + gutter - (tile.phaseX || 0)) * scale + view.x
  const top = (tile.y + gutter - (tile.phaseY || 0)) * scale + view.y
  return left < size.width && top < size.height &&
    left + (tile.width - 2*gutter) * scale > 0 && top + (tile.height - 2*gutter) * scale > 0
}
