import type { CanvasCamera } from '../canvas-camera'
import { tilesCoverBounds, type RasterTile } from './tile-cache'
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

/** Ready tiles that are at least twice as dense as the stretched picture under
 * them. A smaller step stays on the current bitmap so a wheel tick does not
 * swap nearly identical samples. This never supplies the sole picture: the
 * caller keeps the backing in the same stack, and the union must cover. */
export function selectSharperCoverage<T extends RasterTile>(candidates: readonly T[], view: CanvasCamera,
  size: { width: number; height: number }, shown: readonly RasterTile[], limit = 24): T[] {
  if (!shown.length || !Number.isSafeInteger(limit) || limit < 1) return []
  if (![view.x, view.y, view.zoom, size.width, size.height].every(Number.isFinite) || view.zoom <= 0) return []
  const shownSet = new Set(shown)
  const pool = candidates.filter(tile => !shownSet.has(tile) && tile.zoom > 0 && tileIntersectsView(tile, view, size))
    .sort((a, b) => b.zoom - a.zoom || a.x - b.x || a.y - b.y)
  const chosen: T[] = []
  for (const tile of pool) {
    if (chosen.length >= limit) break
    const rect = tileVisibleWorld(tile, view, size)
    if (!rect) continue
    // Equality is included: a tile twice as dense as the picture under it is
    // already enough to stop that picture dominating the sample.
    if (tilesCoverBounds([...shown, ...chosen], rect, tile.zoom / MAX_PREVIEW_SCALE_RATIO * (1 + 1e-9))) continue
    if (!bringsSamplingDetail(tile, view, size, [...shown, ...chosen])) continue
    chosen.push(tile)
  }
  return chosen
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
 *  if x/y have since moved. A zoom change is a different frame. A frame whose
 *  camera is farther from the live camera than the picture already on screen
 *  is a late rollback: keep that picture and let the latest camera converge. */
export function acceptTranslatedCoverage(input: {
  outward: boolean; preview: boolean; idsMatch: boolean; tileCount: number; shownCount: number
  sentZoom: number; liveZoom: number; samePixels: boolean; matchesSubmission: boolean
  cameras?: {
    displayed: { x: number; y: number; zoom: number }
    sent: { x: number; y: number; zoom: number }
    live: { x: number; y: number; zoom: number }
  }
}) {
  // idsMatch is this submission's own tiles, not whichever frame is newest.
  // A later pan must not drop the bitmap that already paints the previous strip.
  const sameZoom = input.cameras && input.cameras.displayed.zoom === input.cameras.live.zoom &&
    input.cameras.sent.zoom === input.cameras.live.zoom
  const distance = (camera: { x: number; y: number }) => Math.hypot(input.cameras!.live.x - camera.x, input.cameras!.live.y - camera.y)
  const stepsBackward = !!sameZoom && [input.cameras!.displayed.x, input.cameras!.displayed.y, input.cameras!.sent.x,
    input.cameras!.sent.y, input.cameras!.live.x, input.cameras!.live.y].every(Number.isFinite) &&
    distance(input.cameras!.displayed) + 1e-6 < distance(input.cameras!.sent)
  return input.outward && !input.preview && input.idsMatch && input.tileCount > 0 &&
    input.tileCount === input.shownCount && input.sentZoom === input.liveZoom &&
    input.samePixels && input.matchesSubmission && !stepsBackward
}

/** Whether an in-flight tile still belongs to the current camera.
 *  A scale change is not staleness. The tile is stale once resident pixels
 *  already paint its viewport rect and it is neither the requested key nor a
 *  nearby density the exact phase may still need. Zoom-out holes stay in
 *  flight even when the new lattice is many times coarser. */
export function retainInFlightTile(tile: RasterTile, view: CanvasCamera, size: { width: number; height: number },
  resident: Iterable<RasterTile>, wanted: ReadonlySet<string>, prefetch: ReadonlySet<string>,
  continuousZoomIn: boolean, targetScale: number, settling = false, yieldCoveredNeighbor = false) {
  if (tile.prefetch) return wanted.has(tile.key) || prefetch.has(tile.key)
  if (!tileIntersectsView(tile, view, size) || !(targetScale > 0) || !(tile.zoom > 0)) return false
  if (wanted.has(tile.key)) return true
  const painted = [...resident]
  const hole = coversUnpaintedViewport(tile, view, size, painted)
  // A speculative full-viewport capture that does not fill a hole only delays
  // the tile that would. Coverage tiles are kept at any size.
  if ((tile.width > 514 || tile.height > 514) && continuousZoomIn && !hole) return false
  if (hole) return true
  // The gesture can keep a nearby density. Once it stops, a covered viewport
  // must release the single raster owner for the exact phase. A reversed pan
  // is the same release while the pointer is still moving: a covered neighbour
  // from the abandoned heading only delays the latest camera. A finer tile
  // that still raises detail on this rect stays, and cached keys are untouched.
  if (settling) return false
  const relative = targetScale / tile.zoom
  if (yieldCoveredNeighbor) return relative < 1 && relative >= 0.5 && bringsSamplingDetail(tile, view, size, painted)
  if (relative <= 2 && relative >= 0.5) return true
  return continuousZoomIn && relative > 2 && relative <= 8 && bringsSamplingDetail(tile, view, size, painted)
}
