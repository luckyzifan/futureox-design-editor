import { tilesCoverBounds, type RasterTile } from './tile-cache'

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
