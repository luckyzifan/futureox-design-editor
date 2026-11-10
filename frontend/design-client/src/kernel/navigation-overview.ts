import { planTilesAligned } from './tile-plan-aligned'
import type { RasterTile } from './tile-cache'
import type { Bounds } from '../model'
import type { CanvasCamera } from '../canvas-camera'

/** A single page overview cannot be left half built by a camera reversal.
 * Keep a physical gutter on both sides and retain the fractional camera phase. */
export function navigationOverview(bounds: Bounds, maxScale: number, nodes = 0) {
  const { x, y, width, height } = bounds
  // Large pages can exceed path/compile budgets even at a tiny output size.
  // Split their world bounds into regional jobs on the existing tile grid.
  const regional = nodes >= 3000
  const scale = Math.min(maxScale, (regional ? 2046 : 510) / Math.max(width, height))
  if (![x,y,width,height,scale].every(Number.isFinite) || width <= 0 || height <= 0 || scale < .001) return
  const view = {x: 1-x*scale, y: 1-y*scale, zoom: scale}
  const left = Math.floor(view.x), top = Math.floor(view.y)
  const tile: RasterTile = {key: 'navigation-overview:'+JSON.stringify([x,y,width,height,scale]),
    x: -left, y: -top, phaseX:view.x-left, phaseY:view.y-top, zoom:scale,
    width:Math.ceil(width*scale)+2,height:Math.ceil(height*scale)+2,gutter:1}
  const tiles = regional ? planTilesAligned(bounds, scale, 32, {x:tile.phaseX!,y:tile.phaseY!}).map(region=>({
    ...region,key:tile.key+'/'+region.key,
  })) : [tile]
  return {view,tiles}
}

/** Schedule a useful neighborhood first in a very large document. */
export function nearOverviewTiles(tiles: readonly RasterTile[], view: CanvasCamera, width: number, height: number) {
  const x=(width/2-view.x)/view.zoom, y=(height/2-view.y)/view.zoom
  const distance = (tile: RasterTile) => Math.hypot(
    (tile.x + tile.width/2 - (tile.phaseX ?? 0))/tile.zoom-x,
    (tile.y + tile.height/2 - (tile.phaseY ?? 0))/tile.zoom-y)
  return [...tiles].sort((a,b)=>distance(a)-distance(b))
}

/** The live viewport is larger than the page, so pasteboard is on screen. */
export function viewportExtendsPastPage(page: Bounds, view: CanvasCamera, size: { width: number; height: number }) {
  if (!(page.width > 0) || !(page.height > 0) || !(view.zoom > 0)) return false
  if (![page.x, page.y, page.width, page.height, view.x, view.y, view.zoom, size.width, size.height].every(Number.isFinite)) return false
  const left = -view.x / view.zoom, top = -view.y / view.zoom
  const right = left + size.width / view.zoom, bottom = top + size.height / view.zoom
  const tol = 1 / view.zoom
  return left < page.x - tol || top < page.y - tol || right > page.x + page.width + tol || bottom > page.y + page.height + tol
}

/** One coarse tile covering the viewport plus a full viewport of margin.
 *  A pan of at least a quarter of the screen stays inside it, including
 *  pasteboard outside the page. Quantized so that pan reuses the same tile. */
export function panStripBounds(view: CanvasCamera, size: { width: number; height: number }, page?: Bounds) {
  if (!(view.zoom > 0) || !(size.width > 0) || !(size.height > 0)) return
  if (![view.x, view.y, view.zoom, size.width, size.height].every(Number.isFinite)) return
  const vw = size.width / view.zoom, vh = size.height / view.zoom
  const vx = -view.x / view.zoom, vy = -view.y / view.zoom
  let x0 = Math.floor((vx - vw) / vw) * vw
  let y0 = Math.floor((vy - vh) / vh) * vh
  let x1 = Math.ceil((vx + vw * 2) / vw) * vw
  let y1 = Math.ceil((vy + vh * 2) / vh) * vh
  if (page && page.width > 0 && page.height > 0 && page.width * page.height < vw * vh * 64 &&
      [page.x, page.y, page.width, page.height].every(Number.isFinite)) {
    x0 = Math.min(x0, Math.floor(page.x / vw) * vw)
    y0 = Math.min(y0, Math.floor(page.y / vh) * vh)
    x1 = Math.max(x1, Math.ceil((page.x + page.width) / vw) * vw)
    y1 = Math.max(y1, Math.ceil((page.y + page.height) / vh) * vh)
  }
  if (!(x1 > x0) || !(y1 > y0)) return
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/** One coarse page tile before a finer refine. Pasteboard keeps its quiet
 *  admission. A same-zoom pan that has left the resident pictures asks for
 *  the strip even while the previous zoom gesture is still marked continuous. */
export function coarsePanCoverNeeded(options: {
  firstNative: boolean
  hasStrip: boolean
  stripCached: boolean
  pasteboard: boolean
  cpuOnly: boolean
  translated: boolean
  moving: boolean
  continuousZoom: boolean
  translationFollow: boolean
  residentsCover: boolean
  quietStripAllowed?: boolean
}) {
  if (options.firstNative || !options.hasStrip || options.stripCached) return false
  const quietPasteboard = options.pasteboard && (options.cpuOnly || options.translated || (!options.moving && !options.continuousZoom && options.quietStripAllowed !== false))
  return quietPasteboard || (options.translationFollow && !options.residentsCover)
}

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

/** Page-level coarse tile for the pasteboard around a zoomed-out artboard.
 *  nodes is forced to 0 so a large file stays one tile, not a regional grid. */
export function panStripOverview(page: Bounds, view: CanvasCamera, size: { width: number; height: number }) {
  const bounds = panStripBounds(view, size, page)
  return bounds ? navigationOverview(bounds, 1, 0) : undefined
}

/** One optional overview request shares the established two-tile pipeline. */
export function overviewWarmBatch(tiles: readonly RasterTile[], view: CanvasCamera, width: number, height: number,
  available: (tile: RasterTile) => boolean) {
  return nearOverviewTiles(tiles,view,width,height).filter(available).slice(0,2)
}
