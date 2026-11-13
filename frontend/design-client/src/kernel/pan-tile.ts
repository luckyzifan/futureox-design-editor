import type { CanvasCamera } from '../canvas-camera'
import type { RasterTile } from './tile-cache'

/** Fractions of the viewport and of the tile that still overlap. A zero result
 * is not coverage: bad geometry must not keep a stale capture. */
export function panTileOverlap(
  tile: Pick<RasterTile, 'x' | 'y' | 'width' | 'height' | 'zoom' | 'gutter' | 'phaseX' | 'phaseY'>,
  view: CanvasCamera,
  size: { width: number; height: number },
) {
  const none = { viewport: 0, tile: 0 }
  if (!(tile.zoom > 0) || !(view.zoom > 0) || !(size.width > 0) || !(size.height > 0)) return none
  const gutter = tile.gutter ?? 1
  const x0 = (tile.x + gutter - (tile.phaseX ?? 0)) / tile.zoom
  const y0 = (tile.y + gutter - (tile.phaseY ?? 0)) / tile.zoom
  const x1 = (tile.x + tile.width - gutter - (tile.phaseX ?? 0)) / tile.zoom
  const y1 = (tile.y + tile.height - gutter - (tile.phaseY ?? 0)) / tile.zoom
  const vx = -view.x / view.zoom
  const vy = -view.y / view.zoom
  const vw = size.width / view.zoom
  const vh = size.height / view.zoom
  if (![x0, y0, x1, y1, vx, vy, vw, vh].every(Number.isFinite)) return none
  if (!(x1 > x0) || !(y1 > y0) || !(vw > 0) || !(vh > 0)) return none
  const left = Math.max(x0, vx)
  const top = Math.max(y0, vy)
  const right = Math.min(x1, vx + vw)
  const bottom = Math.min(y1, vy + vh)
  const area = Math.max(0, right - left) * Math.max(0, bottom - top)
  return { viewport: area / (vw * vh), tile: area / ((x1 - x0) * (y1 - y0)) }
}

/** Keep an in-flight tile during a large pan when it still paints most of the
 * viewport, or when most of the tile is on screen and that overlap is still a
 * real fraction of the view. A tiny cell left over from a zoom-in can sit
 * fully on screen while covering almost none of the panned view; keeping it
 * occupied the raster owner and the coarse picture never followed the pointer.
 * A viewport-sized capture that has slid more than halfway yields. An invalid
 * threshold does not yield. */
export function retainPannedTile(
  tile: Pick<RasterTile, 'x' | 'y' | 'width' | 'height' | 'zoom' | 'gutter' | 'phaseX' | 'phaseY'>,
  view: CanvasCamera,
  size: { width: number; height: number },
  minimumFraction = 0.5,
) {
  if (!Number.isFinite(minimumFraction) || minimumFraction <= 0 || minimumFraction > 1) return true
  const overlap = panTileOverlap(tile, view, size)
  if (overlap.viewport >= minimumFraction) return true
  // Most of a tiny cell can sit inside the viewport after a shrink without
  // painting enough of it to hold the raster owner. A neighbour that still
  // covers a real fraction of the view stays.
  return overlap.tile >= minimumFraction && overlap.viewport >= minimumFraction / 4
}
