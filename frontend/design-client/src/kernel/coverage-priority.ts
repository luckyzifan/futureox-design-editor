import type { Bounds } from '../model'
import { tilesCoverBounds, type RasterTile } from './tile-cache'

/** Repair exposed pixels before refining pixels already supplied by a valid
 * density layer. Keep distance order within both groups, and keep the same
 * native-density request/prepare guard instead of adding a serial preview. */
export function prioritizeUncoveredTiles(tiles: RasterTile[], residents: RasterTile[], viewport: Bounds) {
  if (!residents.length || tilesCoverBounds(residents, viewport)) return tiles
  const uncovered: RasterTile[] = [], covered: RasterTile[] = []
  for (const tile of tiles) {
    const gutter = tile.gutter ?? 1
    const x = Math.max(viewport.x, (tile.x + gutter - (tile.phaseX || 0)) / tile.zoom)
    const y = Math.max(viewport.y, (tile.y + gutter - (tile.phaseY || 0)) / tile.zoom)
    const right = Math.min(viewport.x + viewport.width, (tile.x + tile.width - gutter - (tile.phaseX || 0)) / tile.zoom)
    const bottom = Math.min(viewport.y + viewport.height, (tile.y + tile.height - gutter - (tile.phaseY || 0)) / tile.zoom)
    const supplied = right <= x || bottom <= y || tilesCoverBounds(residents, { x, y, width: right - x, height: bottom - y })
    ;(supplied ? covered : uncovered).push(tile)
  }
  return [...uncovered, ...covered]
}
