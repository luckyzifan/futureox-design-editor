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
export type NavigationCoverageFlight<T> = {
  contract: object; generation: number; tile?: T; done: Promise<void>; finish: () => void
}
export function navigationCoverageFlight<T>(contract: object, generation: number): NavigationCoverageFlight<T> {
  let finish!: () => void
  const done = new Promise<void>(resolve => { finish = resolve })
  return { contract, generation, done, finish }
}
