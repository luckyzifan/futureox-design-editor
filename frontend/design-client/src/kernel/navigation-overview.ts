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

/** One optional overview request shares the established two-tile pipeline. */
export function overviewWarmBatch(tiles: readonly RasterTile[], view: CanvasCamera, width: number, height: number,
  available: (tile: RasterTile) => boolean) {
  return nearOverviewTiles(tiles,view,width,height).filter(available).slice(0,2)
}
