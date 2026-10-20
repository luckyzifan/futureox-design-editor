import type { Bounds } from '../model'
import { tilesCoverBounds, type RasterTile, type TileFillPriority } from './tile-cache'

/** Repair holes first, then visibly undersampled regions, then already-sharp
 * regions needing a new exact key. A whole-page overview supplies continuity,
 * not sharpness. Preserve distance order within each tier and retain every
 * original tile, density, and preparation/filter guard. */
export function prioritizeUncoveredTiles(tiles: RasterTile[], residents: RasterTile[], viewport: Bounds,
  priorities?: Map<RasterTile, TileFillPriority>) {
  if (!residents.length) {
    if (priorities) for (const tile of tiles) priorities.set(tile, 0)
    return tiles
  }
  const residentBounds = residents.map(tile => {
    const g = tile.gutter ?? 1, phaseX = tile.phaseX || 0, phaseY = tile.phaseY || 0
    return { tile, x: (tile.x + g - phaseX) / tile.zoom, y: (tile.y + g - phaseY) / tile.zoom,
      right: (tile.x + tile.width - g - phaseX) / tile.zoom,
      bottom: (tile.y + tile.height - g - phaseY) / tile.zoom }
  })
  const uncovered: RasterTile[] = [], coarse: RasterTile[] = [], sharp: RasterTile[] = []
  for (const tile of tiles) {
    const gutter = tile.gutter ?? 1
    const x = Math.max(viewport.x, (tile.x + gutter - (tile.phaseX || 0)) / tile.zoom)
    const y = Math.max(viewport.y, (tile.y + gutter - (tile.phaseY || 0)) / tile.zoom)
    const right = Math.min(viewport.x + viewport.width, (tile.x + tile.width - gutter - (tile.phaseX || 0)) / tile.zoom)
    const bottom = Math.min(viewport.y + viewport.height, (tile.y + tile.height - gutter - (tile.phaseY || 0)) / tile.zoom)
    const bounds = { x, y, width: right - x, height: bottom - y }
    if (right <= x || bottom <= y) { sharp.push(tile); priorities?.set(tile, 2); continue }
    // Reject off-region residents before the union walk. The bounded history
    // can contain many tiles elsewhere on a large page; they cannot help this
    // candidate and must not multiply its coverage-sweep cost.
    const local = residentBounds.filter(r => r.x < right && r.right > x && r.y < bottom && r.bottom > y).map(r => r.tile)
    if (!tilesCoverBounds(local, bounds)) { uncovered.push(tile); priorities?.set(tile, 0) }
    else if (!tilesCoverBounds(local, bounds, tile.zoom)) { coarse.push(tile); priorities?.set(tile, 1) }
    else { sharp.push(tile); priorities?.set(tile, 2) }
  }
  // Keep the allocation-free, original-order path when all work has one tier.
  if ([uncovered, coarse, sharp].some(tier => tier.length === tiles.length)) return tiles
  return [...uncovered, ...coarse, ...sharp]
}
