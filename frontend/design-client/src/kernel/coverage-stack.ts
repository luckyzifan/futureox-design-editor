import type { CanvasCamera } from '../canvas-camera'
import { tilesCoverBounds, type RasterTile } from './tile-cache'
import { ORDINARY_SOURCE_TILE } from './source-display-band'
import { panTileOverlap } from './pan-tile'
import { MAX_PREVIEW_SCALE_RATIO, previewCameraScaleWithinLimit, tileIntersectsView } from './tile-preview'

/** World rectangle of a tile's owned core that actually intersects the viewport.
 *  Gutters are not content. Undefined when the core misses the view. */
export function tileVisibleWorld(tile: RasterTile, view: CanvasCamera, size: { width: number; height: number }) {
  const g = tile.gutter ?? 1
  const x0 = (tile.x + g - (tile.phaseX ?? 0)) / tile.zoom
  const y0 = (tile.y + g - (tile.phaseY ?? 0)) / tile.zoom
  const x1 = (tile.x + tile.width - g - (tile.phaseX ?? 0)) / tile.zoom
  const y1 = (tile.y + tile.height - g - (tile.phaseY ?? 0)) / tile.zoom
  const left = Math.max(x0, -view.x / view.zoom)
  const top = Math.max(y0, -view.y / view.zoom)
  const right = Math.min(x1, (size.width - view.x) / view.zoom)
  const bottom = Math.min(y1, (size.height - view.y) / view.zoom)
  if (!(right > left) || !(bottom > top)) return
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** True when this tile would paint a viewport pixel that `resident` does not
 *  already paint at any density. Scale ratio is not a reason to ignore it. */
export function coversUnpaintedViewport(tile: RasterTile, view: CanvasCamera, size: { width: number; height: number },
  resident: Iterable<RasterTile>) {
  const rect = tileVisibleWorld(tile, view, size)
  if (!rect) return false
  return !tilesCoverBounds([...resident], rect)
}

/** Finer than every resident that already paints this rect. Same predicate as
 *  sourceTileBringsDetail, kept here so coverage selection does not import the
 *  viewport planner (and its kernel address binding) at module load. */
function bringsSamplingDetail(tile: RasterTile, view: CanvasCamera, size: { width: number; height: number },
  resident: readonly RasterTile[]) {
  const rect = tileVisibleWorld(tile, view, size)
  if (!rect) return false
  return !tilesCoverBounds([...resident], rect, tile.zoom)
}

/** Coarsest residents that still paint a hole in `shown`. Drawn underneath the
 *  sharper set. A bitmap more than 2× away is not a certified frame, but a
 *  finer one is still the picture when nothing closer paints that viewport.
 *  A coarse thumbnail is not stretched up to fill a zoom-in. One wide overview
 *  beats a stack of fragments that cover less. The previous picture stays up
 *  until this stack covers. */
export function selectCoverageUnderlay<T extends RasterTile>(candidates: readonly T[], view: CanvasCamera,
  size: { width: number; height: number }, shown: readonly RasterTile[], limit = 24, coarseHoles = false): T[] {
  if (!Number.isSafeInteger(limit) || limit < 1) return []
  const shownSet = new Set(shown)
  const order = (a: T, b: T) => a.zoom - b.zoom || a.x - b.x || a.y - b.y
  const visible = candidates.filter(tile => !shownSet.has(tile) && tileIntersectsView(tile, view, size))
  // Near tiles claim their pixels first. A finer bitmap then fills only the
  // hole they left, which is the low-zoom fit with no retained predecessor.
  const near = visible.filter(tile => previewCameraScaleWithinLimit(tile.zoom, view.zoom)).sort(order)
  const finer = visible.filter(tile => tile.zoom > view.zoom * MAX_PREVIEW_SCALE_RATIO).sort(order)
  const pool = [...near, ...finer].slice(0, 64)
  const chosen: T[] = []
  for (const tile of pool) {
    if (chosen.length >= limit) break
    if (!coversUnpaintedViewport(tile, view, size, [...shown, ...chosen])) continue
    chosen.push(tile)
  }
  // A zoom-out crop leaves world the 2× near set does not own. The closest
  // coarser resident may fill only that hole. It is not a certified frame and
  // is never the picture for a zoom-in that has no finer resident.
  if (coarseHoles && !tilesCoverBounds([...shown, ...chosen], backingWorld(view, size))) {
    const coarse = visible.filter(tile => tile.zoom * MAX_PREVIEW_SCALE_RATIO < view.zoom)
      .sort((a, b) => b.zoom - a.zoom || a.x - b.x || a.y - b.y)
    for (const tile of coarse) {
      if (chosen.length >= limit) break
      if (!coversUnpaintedViewport(tile, view, size, [...shown, ...chosen])) continue
      chosen.push(tile)
    }
  }
  return chosen
}

/** Underlay plus every finer resident that actually raises detail, but only
 *  when the union covers the viewport. Otherwise the caller keeps the previous
 *  image instead of publishing a holed frame. */
export function selectCoverageStack<T extends RasterTile>(candidates: readonly T[], view: CanvasCamera,
  size: { width: number; height: number }, limit = 48, coarseHoles = false): T[] | undefined {
  if (![view.x, view.y, view.zoom, size.width, size.height].every(Number.isFinite) || view.zoom <= 0) return
  const under = selectCoverageUnderlay(candidates, view, size, [], limit, coarseHoles)
  const detail: T[] = []
  const rest = candidates.filter(tile => !under.includes(tile) && tileIntersectsView(tile, view, size))
    .sort((a, b) => b.zoom - a.zoom || a.x - b.x || a.y - b.y)
  for (const tile of rest) {
    if (under.length + detail.length >= limit) break
    if (!bringsSamplingDetail(tile, view, size, [...under, ...detail])) continue
    detail.push(tile)
  }
  const stack = [...under, ...detail]
  const world = { x: -view.x / view.zoom, y: -view.y / view.zoom, width: size.width / view.zoom, height: size.height / view.zoom }
  return tilesCoverBounds(stack, world) ? stack : undefined
}

/** World rectangle of a viewport bitmap. Pan and zoom-out expose area outside it. */
export function backingWorld(view: CanvasCamera, size: { width: number; height: number }) {
  return { x: -view.x / view.zoom, y: -view.y / view.zoom, width: size.width / view.zoom, height: size.height / view.zoom }
}

/** Stack for a camera that has moved outside the displayed bitmap. It must
 *  cover the new viewport and paint world the previous bitmap does not contain.
 *  A zoom-in that stays inside the old bitmap returns undefined: CSS already
 *  shows those pixels, and publishing again would only resample them. */
export function coverageBeyondBacking<T extends RasterTile>(candidates: readonly T[], view: CanvasCamera,
  size: { width: number; height: number }, previous: { view: CanvasCamera; width: number; height: number }, limit = 48,
  coarseHoles = false): T[] | undefined {
  if (!(previous.view.zoom > 0) || !(previous.width > 0) || !(previous.height > 0)) return
  const stack = selectCoverageStack(candidates, view, size, limit, coarseHoles)
  if (!stack) return
  const old = backingWorld(previous.view, previous)
  const tol = 1 / Math.max(view.zoom, 1e-6)
  const spills = stack.some(tile => {
    const rect = tileVisibleWorld(tile, view, size)
    if (!rect) return false
    return rect.x < old.x - tol || rect.y < old.y - tol ||
      rect.x + rect.width > old.x + old.width + tol || rect.y + rect.height > old.y + old.height + tol
  })
  return spills ? stack : undefined
}

/** Ready tiles can replace lower-density pixels at the current screen density.
 * Intermediate densities need a twofold gain to avoid swapping similar
 * samples each wheel tick. The backing still supplies the rest of the view. */
export function selectSharperCoverage<T extends RasterTile>(candidates: readonly T[], view: CanvasCamera,
  size: { width: number; height: number; dpr?: number }, shown: readonly RasterTile[], limit = 24): T[] {
  if (!shown.length || !Number.isSafeInteger(limit) || limit < 1) return []
  if (![view.x, view.y, view.zoom, size.width, size.height].every(Number.isFinite) || view.zoom <= 0) return []
  const dpr = size.dpr ?? 0
  const screenDensity = Number.isFinite(dpr) && dpr > 0 ? view.zoom * dpr : Infinity
  const shownSet = new Set(shown)
  const pool = candidates.filter(tile => !shownSet.has(tile) && tile.zoom > 0 && tileIntersectsView(tile, view, size))
    .sort((a, b) => b.zoom - a.zoom || a.x - b.x || a.y - b.y)
  const chosen: T[] = []
  for (const tile of pool) {
    if (chosen.length >= limit) break
    const rect = tileVisibleWorld(tile, view, size)
    if (!rect) continue
    const requiredDensity = tile.zoom >= screenDensity ? tile.zoom : tile.zoom / MAX_PREVIEW_SCALE_RATIO * (1 + 1e-9)
    if (tilesCoverBounds([...shown, ...chosen], rect, requiredDensity)) continue
    chosen.push(tile)
  }
  return chosen
}

/** A finished motion lattice is still the stretched picture when a finer
 * resident is already cached. The union has to cover: a partial sharper
 * region stays with the backing, and a covering finer set can stand alone
 * after that backing texture has been released. Undefined keeps the lattice. */
export function zoomInFramePastPlan<T extends RasterTile>(cached: Iterable<T>, backing: readonly RasterTile[],
  view: CanvasCamera, size: { width: number; height: number }, planScale: number): T[] | undefined {
  if (!(planScale > 0) || !Number.isFinite(planScale)) return
  const available = [...cached]
  const finerThanPlan = (tile: T) => tile.zoom > planScale * (1 + 1e-9)
  const frame = sharperCoverageFrame(available, backing, view, size)
  if (frame?.some(finerThanPlan)) return frame
  return selectCoverageStack(available.filter(finerThanPlan), view, size)
}

/** Backing residents plus every ready tile that replaces a stretched region,
 * when that union still covers the viewport. Undefined leaves the previous
 * image up; a partial set is not published as a hole. */
export function sharperCoverageFrame<T extends RasterTile>(cached: Iterable<T>, backing: readonly RasterTile[],
  view: CanvasCamera, size: { width: number; height: number }): T[] | undefined {
  if (![view.x, view.y, view.zoom, size.width, size.height].every(Number.isFinite) || view.zoom <= 0) return
  const byKey = new Map<string, T>()
  for (const tile of cached) byKey.set(tile.key, tile)
  const base = backing.flatMap(tile => {
    const live = byKey.get(tile.key)
    return live && tileIntersectsView(live, view, size) ? [live] : []
  })
  const extra = selectSharperCoverage([...byKey.values()], view, size, base)
  if (!extra.length) return
  const seen = new Set(base.map(tile => tile.key))
  const stack = [...base, ...extra.filter(tile => !seen.has(tile.key))]
  return tilesCoverBounds(stack, backingWorld(view, size)) ? stack : undefined
}

/** Largest view/sample ratio among five interior probes. A probe with no tile
 * does not count: missing coverage is a hole, not an upscale. */
export function dominantUpscale(tiles: readonly RasterTile[], view: CanvasCamera, size: { width: number; height: number }) {
  if (!(view.zoom > 0)) return Number.POSITIVE_INFINITY
  const samples = [[.5, .5], [.2, .2], [.8, .2], [.2, .8], [.8, .8]]
  let worst = 0
  let seen = 0
  for (const [sx, sy] of samples) {
    const x = -view.x / view.zoom + size.width / view.zoom * sx
    const y = -view.y / view.zoom + size.height / view.zoom * sy
    let best = 0
    for (const tile of tiles) {
      const rect = tileVisibleWorld(tile, view, size)
      if (!rect || x < rect.x || y < rect.y || x >= rect.x + rect.width || y >= rect.y + rect.height) continue
      best = Math.max(best, tile.zoom)
    }
    if (!(best > 0)) continue
    seen++
    worst = Math.max(worst, view.zoom / best)
  }
  return seen ? worst : Number.POSITIVE_INFINITY
}

/** A coverage frame may arrive after the pointer has already panned. Accept it
 *  when it is the frame we submitted, at the live zoom and pixel size, even
 *  if x/y have since moved. A zoom change is a different frame. */
export function acceptTranslatedCoverage(input: {
  outward: boolean; preview: boolean; idsMatch: boolean; tileCount: number; shownCount: number
  sentZoom: number; liveZoom: number; samePixels: boolean; matchesSubmission: boolean
}) {
  // idsMatch is this submission's own tiles, not whichever frame is newest.
  // A later pan must not drop the bitmap that already paints the previous strip.
  return input.outward && !input.preview && input.idsMatch && input.tileCount > 0 &&
    input.tileCount === input.shownCount && input.sentZoom === input.liveZoom &&
    input.samePixels && input.matchesSubmission
}

/** The current exact lattice owns the raster slot. A wider same-density
 * capture, or one more than 8× finer than a demand that is still missing
 * tiles, is not that lattice. An in-plan key stays. Exactly 8× stays too:
 * a fast zoom-out still keeps the hole filler at that bound. */
export function releaseInFlightForDemand(tile: Pick<RasterTile, 'key' | 'width' | 'height' | 'zoom'>, demand: {
  scale: number
  keys: ReadonlySet<string>
  tiles: readonly Pick<RasterTile, 'width' | 'height'>[]
  missing: boolean
}) {
  if (demand.keys.has(tile.key)) return false
  const ordinary = demand.tiles.length > 0 && demand.tiles.every(item => item.width <= ORDINARY_SOURCE_TILE && item.height <= ORDINARY_SOURCE_TILE)
  if (ordinary && (tile.width > ORDINARY_SOURCE_TILE || tile.height > ORDINARY_SOURCE_TILE)) return true
  return demand.missing && demand.scale > 0 && tile.zoom > demand.scale * 8
}

/** Whether an in-flight tile still belongs to the current camera.
 *  A scale change is not staleness. The tile is stale once resident pixels
 *  already paint its viewport rect and it is neither the requested key nor a
 *  nearby density the exact phase may still need. Zoom-out holes stay in
 *  flight even when the new lattice is many times coarser.
 *  A pan that has carried most of an unrequested tile off the live viewport,
 *  without that remainder still covering most of the view, yields the raster
 *  owner. Accepted pixels stay. The current camera's own keys do not yield. */
export function retainInFlightTile(tile: RasterTile, view: CanvasCamera, size: { width: number; height: number },
  resident: Iterable<RasterTile>, wanted: ReadonlySet<string>, prefetch: ReadonlySet<string>,
  continuousZoomIn: boolean, targetScale: number, settling = false) {
  if (tile.prefetch) return wanted.has(tile.key) || prefetch.has(tile.key)
  if (!tileIntersectsView(tile, view, size) || !(targetScale > 0) || !(tile.zoom > 0)) return false
  if (wanted.has(tile.key)) return true
  const overlap = panTileOverlap(tile, view, size)
  if (overlap.viewport < 0.5 && overlap.tile < 0.5) return false
  const painted = [...resident]
  const hole = coversUnpaintedViewport(tile, view, size, painted)
  // A speculative full-viewport capture that does not fill a hole only delays
  // the tile that would. Coverage tiles are kept at any size.
  if ((tile.width > 514 || tile.height > 514) && continuousZoomIn && !hole) return false
  if (hole) return true
  // The gesture can keep a nearby density. Once it stops, a covered viewport
  // must release the single raster owner for the exact phase.
  if (settling) return false
  const relative = targetScale / tile.zoom
  if (relative <= 2 && relative >= 0.5) return true
  return continuousZoomIn && relative > 2 && relative <= 8 && bringsSamplingDetail(tile, view, size, painted)
}
