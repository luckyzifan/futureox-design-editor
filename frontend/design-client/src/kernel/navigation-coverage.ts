import type { CanvasCamera } from '../canvas-camera'
import { navigationPreviewDensity } from './navigation-zoom'
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
  /** Yield an undelivered optional capture to settled native work. Its owner
   * still controls the completion fence and any late payload retirement. */
  cancelForNative(): boolean
  /** Revoke only an unfinished, narrower old navigation capture after quiet.
   * Its original run still owns done and late-payload retirement. */
  cancelObsoleteZoomOut(view: CanvasCamera, width: number, height: number, minimumRatio?: number): boolean
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
    finish: () => { pending = undefined; finish() },
    cancelForNative: () => flight.tile === undefined && cancelPending(),
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
  }
  return flight
}
