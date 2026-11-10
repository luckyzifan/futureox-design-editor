import type { RasterTile } from './tile-cache'
import type { Rect } from './gpu/types'

/** Visible work must not prepare the offscreen rim before the first pixels.
 * Include the actual batch too: callers may mix visible and prefetch tiles. */
export function tileBatchPrepareViewport(visible: readonly RasterTile[], rim: readonly RasterTile[], batch: readonly RasterTile[], view: { x: number; y: number }) {
  const prefetchOnly = batch.length > 0 && batch.every(tile => tile.prefetch === true)
  return tilePrepareViewport([...visible, ...(prefetchOnly ? rim : []), ...batch], view)
}

/** A camera-wide geometry guard shared by bounded raster batches. Every
 * requested crop must fit; a smaller stale guard would silently omit paths. */
export function tilePrepareViewport(tiles: readonly RasterTile[], view: { x: number; y: number }, requested?: Rect): Rect | undefined {
  if (!tiles.length) return
  const x = Math.min(...tiles.map(tile => tile.x + Math.floor(view.x)))
  const y = Math.min(...tiles.map(tile => tile.y + Math.floor(view.y)))
  const right = Math.max(...tiles.map(tile => tile.x + Math.floor(view.x) + tile.width))
  const bottom = Math.max(...tiles.map(tile => tile.y + Math.floor(view.y) + tile.height))
  const union = { x, y, w: right - x, h: bottom - y }
  if (!requested) return union
  if (![requested.x, requested.y, requested.w, requested.h].every(Number.isSafeInteger) ||
      requested.w <= 0 || requested.h <= 0 || requested.w > 1e7 || requested.h > 1e7 ||
      Math.abs(requested.x) > 1e8 || Math.abs(requested.y) > 1e8 ||
      requested.x > x || requested.y > y || requested.x + requested.w < right || requested.y + requested.h < bottom)
    throw Error('Invalid tile prepare viewport: it must cover every requested tile')
  return requested
}

/** A small density tile can contain thousands of world-space objects. Keep
 * the optional preparation window local for large minified display scenes.
 * A wider retained window must not change the published tile: the kernel
 * emits from this tile's own guard. Low-zoom display stays on that local
 * window (`VITE_DESIGN_LOCAL_PREPARE_SCOPE` defaults on). This changes no
 * output crop, sample phase, halo or admission limit. */
export function localDisplayPrepareScope(nodes:number,scale:number,display:boolean) {
  return import.meta.env.VITE_DESIGN_LOCAL_PREPARE_SCOPE!=='0'&&display&&nodes>=3000&&Number.isFinite(scale)&&scale>0&&
    (scale<=.5||import.meta.env.VITE_DESIGN_LOCAL_PREPARE_SCOPE==='1')
}
export function tileLocalPrepareViewport(tile:RasterTile,view:{x:number;y:number},shared:Rect|undefined,local:boolean) {
  if(!shared||!local)return shared
  // Validate the original request before selecting the current crop. A local
  // optimization must not turn a malformed or incomplete guard into success.
  tilePrepareViewport([tile],view,shared)
  return tilePrepareViewport([tile],view)
}
