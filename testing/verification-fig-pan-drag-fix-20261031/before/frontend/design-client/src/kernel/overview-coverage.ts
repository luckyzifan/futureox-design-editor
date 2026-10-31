import { tilesCoverBounds, type RasterTile } from './tile-cache'

/** Reuse an already completed wide viewport as a bounded page backing. This
 * creates no new raster work and never changes the requested native density.
 * A cropped viewport, an expensive frame, or a high-zoom view cannot qualify. */
export function completeViewportBacking(tiles: RasterTile[], bounds: { x: number; y: number; width: number; height: number } | undefined,
  scale: number, residentBytes: number, budgetBytes: number) {
  return !!bounds && bounds.width > 0 && bounds.height > 0 && Number.isFinite(scale) && scale > 0 && scale <= 1 &&
    Number.isSafeInteger(residentBytes) && residentBytes > 0 && Number.isSafeInteger(budgetBytes) &&
    residentBytes <= budgetBytes / 4 && tilesCoverBounds(tiles, bounds, scale)
}

/** Only retained page residents can replace page maintenance. Viewport-only
 * coverage is not pinned through later pan/zoom eviction. Coordinates and
 * sample phases remain exact; no dyadic/Morton assumption on a design canvas. */
export function hasRetainedOverview(
  tiles: Iterable<RasterTile & { overview?: boolean; document?: object; revision?: number }>,
  ready: ReadonlySet<string>, document: object, revision: number,
  bounds: { x: number; y: number; width: number; height: number }, minZoom: number,
) {
  return tilesCoverBounds([...tiles].filter(tile => tile.overview && tile.document === document &&
    tile.revision === revision && ready.has(tile.key)), bounds, minZoom)
}
