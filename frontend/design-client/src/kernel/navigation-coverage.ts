import type { CanvasCamera } from '../canvas-camera'
import { navigationPreviewDensity } from './navigation-zoom'
import { MAX_PREVIEW_SCALE_RATIO } from './tile-preview'
import { tilesCoverBounds, type RasterTile } from './tile-cache'

export type CoverageTile = RasterTile & {
  document?: object; revision: number; gpuTile?: number
  residentDevice?: Readonly<{ client: object; key: string }>
}
export type CoverageOwner = {
  document: object; revision: number; resident: boolean; client: object; device?: string
}

export function navigationCoverageBounds(view: CanvasCamera, width: number, height: number) {
  return { x: -view.x / view.zoom, y: -view.y / view.zoom, width: width / view.zoom, height: height / view.zoom }
}

function viewportIntersection(
  bounds: Readonly<{ x: number; y: number; width: number; height: number }>,
  view: CanvasCamera, width: number, height: number) {
  if (!Number.isFinite(view.zoom) || view.zoom <= 0 || !(width > 0) || !(height > 0)) return
  const target = navigationCoverageBounds(view, width, height)
  if (![bounds.x, bounds.y, bounds.width, bounds.height, target.x, target.y, target.width, target.height].every(Number.isFinite)) return
  if (bounds.width <= 0 || bounds.height <= 0 || target.width <= 0 || target.height <= 0) return
  const left = Math.max(target.x, bounds.x), top = Math.max(target.y, bounds.y)
  const right = Math.min(target.x + target.width, bounds.x + bounds.width)
  const bottom = Math.min(target.y + target.height, bounds.y + bounds.height)
  const area = Math.max(0, right - left) * Math.max(0, bottom - top)
  return { area, targetArea: target.width * target.height, sourceArea: bounds.width * bounds.height }
}

/** Share of the live viewport that still lies inside an in-flight capture.
 *  Invalid geometry is zero so a caller can refuse to treat it as coverage. */
export function viewportOverlapFraction(
  bounds: Readonly<{ x: number; y: number; width: number; height: number }>,
  view: CanvasCamera, width: number, height: number) {
  const hit = viewportIntersection(bounds, view, width, height)
  return hit ? hit.area / hit.targetArea : 0
}

/** Share of a capture that still lies inside the live viewport. A zoom-out
 *  keeps the old picture on screen even though it fills little of the wider
 *  view. A pan that carries that picture away returns a small fraction.
 *  Invalid geometry is zero. */
export function captureVisibleFraction(
  bounds: Readonly<{ x: number; y: number; width: number; height: number }>,
  view: CanvasCamera, width: number, height: number) {
  const hit = viewportIntersection(bounds, view, width, height)
  return hit ? hit.area / hit.sourceArea : 0
}

/** True when most of a capture has left the live viewport. Invalid input
 *  stays false so a caller does not yield on a broken threshold. */
export function captureMostlyOffscreen(
  bounds: Readonly<{ x: number; y: number; width: number; height: number }>,
  view: CanvasCamera, width: number, height: number, minimumFraction = 0.5) {
  if (!Number.isFinite(minimumFraction) || minimumFraction <= 0 || minimumFraction > 1) return false
  if (![bounds.x, bounds.y, bounds.width, bounds.height, view.x, view.y, view.zoom, width, height].every(Number.isFinite)) return false
  if (bounds.width <= 0 || bounds.height <= 0 || view.zoom <= 0 || width <= 0 || height <= 0) return false
  return captureVisibleFraction(bounds, view, width, height) < minimumFraction
}

/** Camera a continuity capture should rasterize. Same-zoom pans that leave
 *  the sample use the live camera. A zoom-out whose sample is still an
 *  earlier step does too, once that picture has left the live viewport.
 *  A pure zoom-out keeps the sample so each wheel tick is not a new frame.
 *  Zoom-in keeps the sample; closer detail is a separate decision. */
export function liveNavigationCapture(
  sample: CanvasCamera, requested: CanvasCamera, width: number, height: number, minimumFraction = 0.5): CanvasCamera {
  if (![sample.x, sample.y, sample.zoom, requested.x, requested.y, requested.zoom, width, height, minimumFraction].every(Number.isFinite)) return sample
  if (!(sample.zoom > 0) || !(requested.zoom > 0) || !(width > 0) || !(height > 0)) return sample
  if (!(minimumFraction > 0) || minimumFraction > 1) return sample
  const bounds = navigationCoverageBounds(sample, width, height)
  if (sample.zoom === requested.zoom)
    return viewportOverlapFraction(bounds, requested, width, height) < minimumFraction ? requested : sample
  if (requested.zoom < sample.zoom && captureVisibleFraction(bounds, requested, width, height) < minimumFraction)
    return requested
  return sample
}

/** Geometric scheduling evidence only. Import/presenter readiness and live GPU
 * ownership must precede coverage reuse; an intersecting crop is not a backing.
 * The contract revision includes page, session, raster and authored changes. */
export function navigationCoverageTiles<T extends CoverageTile>(tiles: Iterable<T>, ready: ReadonlySet<string>, owner: CoverageOwner): T[] {
  return [...tiles].filter(tile => tile.document === owner.document && tile.revision === owner.revision &&
    ready.has(tile.key) && (!owner.resident || !!owner.device && tile.gpuTile !== undefined &&
      tile.residentDevice?.client === owner.client && tile.residentDevice.key === owner.device))
}

export function navigationHasCoverage(tiles: Iterable<RasterTile>, view: CanvasCamera, width: number, height: number, density = 0) {
  return tilesCoverBounds([...tiles], navigationCoverageBounds(view, width, height), density)
}

/** Density a bounded continuity preview would sample. A coarser resident may
 * stay on screen, but it is not finished coverage and must not cancel the
 * preview that fills the rest of the viewport. */
export function navigationReadyDensity(zoom: number, dpr: number, width: number, height: number, native = false) {
  if (!Number.isFinite(zoom) || zoom <= 0) return 0
  return zoom * navigationPreviewDensity(dpr, width, height, native)
}

/** A viewport preview fills holes under same-content residents. It hides a
 * tile only when that tile belongs to another document revision. */
export function previewUnderlayHides(tile: { document?: object; revision?: number }, preview: { document?: object; revision?: number }) {
  return tile.document !== preview.document || tile.revision !== preview.revision
}

/** Compositing and halo failures must not replace a frame that still has
 * residents. The kernel retries a degraded display; this keeps the last
 * pixels if that retry is still in flight. */
export function retainedPressureError(error: unknown) {
  return /Compositing memory budget exceeded|Combined filter dependency halo exceeds 2048 device pixels|Combined zoom source dependency halo exceeds 2048 device pixels|Zoom source filter halo exceeds 2048 device pixels|Frame compositing work budget exceeded|Layer surface exceeds 16 million pixels|Gaussian sigma must be in/.test(String(error))
}

/** One running immutable capture may finish over quiet/release. Waiting goals
 * still belong to the latest camera; a generation change revokes this flight.
 * A delivered tile is NOT ready coverage and never certifies an exact frame. */
/** Scheduling-only capture geometry, never a certificate of pixel quality.
 * Only the original optional navigation intent may supply this cancellation. */
export type NavigationCoverageCapture = Readonly<{
  zoom: number; bounds: Readonly<{ x: number; y: number; width: number; height: number }>
  cancel(): void
}>
export type NavigationCoverageFlight<T> = {
  contract: object; generation: number; tile?: T; done: Promise<void>; finish: () => void
  /** Intent revocation only, not worker completion or payload release. */
  readonly cancellationRequested: boolean
  /** Can the running capture fill the current view's holes if it finishes? */
  coversViewport(view: CanvasCamera, width: number, height: number): boolean
  /** Yield an undelivered optional capture to settled native work. Its owner
   * still controls the completion fence and any late payload retirement. */
  cancelForNative(): boolean
  /** Revoke only an unfinished, narrower old navigation capture after quiet.
   * Its original run still owns done and late-payload retirement. */
  cancelObsoleteZoomOut(view: CanvasCamera, width: number, height: number, minimumRatio?: number): boolean
  /** Revoke an unfinished capture once the live zoom has left the preview
   * ratio. Keeping it holds the only raster channel on a bitmap that can
   * only be stretched. A delivered tile and a still-usable capture stay. */
  cancelStaleZoomIn(view: CanvasCamera, maximumRatio?: number): boolean
  /** Yield an undelivered capture once most of the newest viewport is outside
   * it. A delivered tile and a capture that still covers the view stay.
   * sameZoomOnly leaves a zoom sample running while its picture is still on
   * screen. A same-zoom pan that misses, and a zoom-out whose sample has
   * left the live viewport, still yield so the live camera can be drawn. */
  cancelMissedViewport(view: CanvasCamera, width: number, height: number, minimumFraction?: number, sameZoomOnly?: boolean): boolean
}
export function navigationCoverageFlight<T>(contract: object, generation: number, capture?: NavigationCoverageCapture): NavigationCoverageFlight<T> {
  let finish!: () => void
  const done = new Promise<void>(resolve => { finish = resolve })
  let cancellationRequested = false
  let pending = capture ? { ...capture, bounds: { ...capture.bounds } } : undefined
  const cancelPending = () => {
    const source = pending
    if (!source) return false
    pending = undefined
    cancellationRequested = true
    source.cancel()
    return true
  }
  const flight: NavigationCoverageFlight<T> = { contract, generation, done,
    get cancellationRequested() { return cancellationRequested },
    coversViewport: (view, width, height) => {
      if (!pending) return false
      const target = navigationCoverageBounds(view, width, height)
      const source = pending.bounds
      return target.width > 0 && target.height > 0 &&
        source.x <= target.x && source.y <= target.y &&
        source.x + source.width >= target.x + target.width &&
        source.y + source.height >= target.y + target.height
    },
    finish: () => { pending = undefined; finish() },
    cancelForNative: () => flight.tile === undefined && cancelPending(),
    cancelStaleZoomIn: (view, maximumRatio = MAX_PREVIEW_SCALE_RATIO) => {
      const source = pending
      if (!source || flight.tile !== undefined) return false
      if (!Number.isFinite(view.zoom) || view.zoom <= 0 || !Number.isFinite(maximumRatio) || maximumRatio < 1) return false
      if (!(view.zoom > source.zoom * maximumRatio)) return false
      return cancelPending()
    },
    cancelObsoleteZoomOut: (view, width, height, minimumRatio = 1) => {
      const source = pending
      if (!source || !Number.isFinite(view.zoom) || view.zoom <= 0 || !(view.zoom < source.zoom) ||
          !Number.isFinite(minimumRatio) || minimumRatio < 1 || source.zoom < view.zoom * minimumRatio) return false
      const target = navigationCoverageBounds(view, width, height), bounds = source.bounds
      if (![target.x, target.y, target.width, target.height].every(Number.isFinite) ||
          target.width <= 0 || target.height <= 0) return false
      if (bounds.x <= target.x && bounds.y <= target.y &&
          bounds.x + bounds.width >= target.x + target.width &&
          bounds.y + bounds.height >= target.y + target.height) return false
      // Abort is per-request and idempotent. Do not resolve done early or
      // clear/release acknowledged pixels; cancellation may await a GPU boundary.
      return cancelPending()
    },
    cancelMissedViewport: (view, width, height, minimumFraction = 0.5, sameZoomOnly = false) => {
      const source = pending
      if (!source || flight.tile !== undefined) return false
      if (!Number.isFinite(view.zoom) || view.zoom <= 0 || !(width > 0) || !(height > 0)) return false
      if (!Number.isFinite(minimumFraction) || minimumFraction <= 0 || minimumFraction > 1) return false
      // A pure zoom-out still contains the sample. Yield only once that
      // picture has left the live viewport, including while its zoom lags.
      if (sameZoomOnly && source.zoom !== view.zoom) {
        if (!(view.zoom < source.zoom) || captureVisibleFraction(source.bounds, view, width, height) >= minimumFraction) return false
        return cancelPending()
      }
      if (viewportOverlapFraction(source.bounds, view, width, height) >= minimumFraction) return false
      return cancelPending()
    },
  }
  return flight
}
