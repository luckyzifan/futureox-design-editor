import { tilesCoverBounds, type RasterTile } from './tile-cache'
import type { ResidentFrame } from './gpu/resident-presenter'
import { compositePlacement } from './gpu/composite-draw-plan'

/** Admission only for the ONE tile whose compilation already finished during
 * camera cancellation. The caller must first prove unchanged document/policy
 * and world-anchored sampling. Never continue the obsolete batch or predict input. */
export function preparedTileCanFill(tile: RasterTile, frame: ResidentFrame | undefined): boolean {
  if (!frame || frame.interaction || !(frame.width > 0 && frame.height > 0 && frame.dpr > 0 && frame.view.zoom > 0)) return false
  const requested = frame.view.zoom * frame.dpr
  // Nearby densities improve continuity. Huge oversampling or severely
  // stretched old pixels must not delay the current native request.
  if (tile.zoom < requested / 2 || tile.zoom > requested * 2) return false
  const box = (t: RasterTile, p: ReturnType<typeof compositePlacement>, gutter: number,
    clip?: { left: number; top: number; width: number; height: number }) => {
    const x = Math.max(0, p.left + p.width * gutter / t.width, clip?.left ?? -Infinity)
    const y = Math.max(0, p.top + p.height * gutter / t.height, clip?.top ?? -Infinity)
    const right = Math.min(frame.width, p.left + p.width * (1 - gutter / t.width), clip ? clip.left + clip.width : Infinity)
    const bottom = Math.min(frame.height, p.top + p.height * (1 - gutter / t.height), clip ? clip.top + clip.height : Infinity)
    return { x, y, width: right - x, height: bottom - y }
  }
  const scale = frame.view.zoom / tile.zoom
  const target = box(tile, { left: (tile.x - (tile.phaseX || 0)) * scale + frame.view.x,
    top: (tile.y - (tile.phaseY || 0)) * scale + frame.view.y, width: tile.width * scale, height: tile.height * scale }, tile.gutter ?? 1)
  if (!(target.width > 0 && target.height > 0)) return false
  const covering = frame.items.filter(item => item.active && !item.blend && item.tile.zoom >= tile.zoom).map(item => {
    const rect = box(item.tile, compositePlacement(item, frame.view), item.gutter ?? 1, item.clip)
    return { ...rect, key: item.tile.key, zoom: 1, gutter: 0 }
  }).filter(rect => rect.width > 0 && rect.height > 0)
  return !tilesCoverBounds(covering, target)
}

/** A prepared tile's exception belongs to the current visible gap, not to all
 * future cameras. Recheck at each existing renderer cancellation boundary. */
export function preparedTileContinuation(tile: RasterTile, current: () => boolean,
  allowFallback: boolean, frame: () => ResidentFrame | undefined): () => boolean {
  return () => current() || allowFallback && preparedTileCanFill(tile, frame())
}
