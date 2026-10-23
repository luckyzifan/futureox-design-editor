import type { CanvasCamera } from '../canvas-camera'
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
  /** Revoke only an unfinished, narrower old navigation capture after quiet.
   * Its original run still owns done and late-payload retirement. */
  cancelObsoleteZoomOut(view: CanvasCamera, width: number, height: number): boolean
}
export function navigationCoverageFlight<T>(contract: object, generation: number, capture?: NavigationCoverageCapture): NavigationCoverageFlight<T> {
  let finish!: () => void
  const done = new Promise<void>(resolve => { finish = resolve })
  let cancellationRequested = false
  let pending = capture ? { ...capture, bounds: { ...capture.bounds } } : undefined
  return { contract, generation, done,
    get cancellationRequested() { return cancellationRequested },
    finish: () => { pending = undefined; finish() },
    cancelObsoleteZoomOut: (view, width, height) => {
      const source = pending
      if (!source || !Number.isFinite(view.zoom) || view.zoom <= 0 || !(view.zoom < source.zoom)) return false
      const target = navigationCoverageBounds(view, width, height), bounds = source.bounds
      if (![target.x, target.y, target.width, target.height].every(Number.isFinite) ||
          target.width <= 0 || target.height <= 0) return false
      if (bounds.x <= target.x && bounds.y <= target.y &&
          bounds.x + bounds.width >= target.x + target.width &&
          bounds.y + bounds.height >= target.y + target.height) return false
      // Abort is per-request and idempotent. Do not resolve done early or
      // clear/release acknowledged pixels; cancellation may await a GPU boundary.
      pending = undefined
      cancellationRequested = true
      source.cancel()
      return true
    },
  }
}
