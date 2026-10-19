import type { CanvasCamera, CanvasSize } from '../canvas-camera'
import { presentationMatches, type ExactPresentation } from './presentation'
import type { BackendPreference } from './gpu/types'
import type { RasterTile } from './tile-cache'

export const CAMERA_REFINE_IDLE_MS = 120

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
