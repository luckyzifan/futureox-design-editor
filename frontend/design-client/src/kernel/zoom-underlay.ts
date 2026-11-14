import type { CanvasCamera } from '../canvas-camera'
import { selectSharperCoverage, tileVisibleWorld } from './coverage-stack'
import { tilesCoverBounds, type RasterTile } from './tile-cache'
import { clipAlignedTile } from './tile-plan-aligned'

export type CameraSample = {
  view: CanvasCamera
  width: number
  height: number
  dpr: number
}

/** The incremental camera transform identifies the unchanged screen point.
 * Clamp to the viewport center for a compound zoom and pan whose pivot lies
 * outside it. Use an integer grid on the tile's own sample lattice. */
export function focusTileDuringZoom(
  tiles: readonly RasterTile[], view: CanvasCamera, previous: CanvasCamera,
  size: { width: number; height: number },
) {
  const delta = view.zoom - previous.zoom
  if (!(delta > 0)) return
  const anchor = (old: number, current: number, extent: number) => {
    const screen = (old * view.zoom - current * previous.zoom) / delta
    return ((screen >= 0 && screen < extent ? screen : extent / 2) - current) / view.zoom
  }
  const x = anchor(previous.x, view.x, size.width)
  const y = anchor(previous.y, view.y, size.height)
  const tile = tiles.find(tile => {
    const core = tileVisibleWorld(tile, view, size)
    return core && x >= core.x && y >= core.y && x < core.x + core.width && y < core.y + core.height
  })
  if (!tile) return
  const side = 160
  const crop = clipAlignedTile(tile, {
    x: Math.floor((x * tile.zoom + (tile.phaseX ?? 0)) / side) * side,
    y: Math.floor((y * tile.zoom + (tile.phaseY ?? 0)) / side) * side,
    w: side, h: side,
  })
  if (crop !== tile) return { ...crop, key: `${crop.key}/zoom-focus` }
}

/** UV of the next viewport inside the retained picture's device texture.
 * Undefined when that picture does not contain the viewport. A zoom-out,
 * a size change, and a DPR change are not this hold. */
export function retainedPreviewUnderlay(
  base: CameraSample & { textureWidth: number; textureHeight: number },
  next: CameraSample,
) {
  if (!(base.dpr > 0) || base.dpr !== next.dpr) return
  if (!(base.width > 0) || base.width !== next.width || base.height !== next.height) return
  if (!(base.view.zoom > 0) || !(next.view.zoom > base.view.zoom)) return
  if (!(base.textureWidth > 0) || !(base.textureHeight > 0)) return
  const world = (camera: CameraSample) => ({
    x: -camera.view.x / camera.view.zoom,
    y: -camera.view.y / camera.view.zoom,
    w: camera.width / camera.view.zoom,
    h: camera.height / camera.view.zoom,
  })
  const nextWorld = world(next)
  const baseWorld = world(base)
  const eps = 1e-6
  if (nextWorld.x < baseWorld.x - eps || nextWorld.y < baseWorld.y - eps) return
  if (nextWorld.x + nextWorld.w > baseWorld.x + baseWorld.w + eps) return
  if (nextWorld.y + nextWorld.h > baseWorld.y + baseWorld.h + eps) return
  const u = (x: number) => (x * base.view.zoom + base.view.x) * base.dpr / base.textureWidth
  const v = (y: number) => (y * base.view.zoom + base.view.y) * base.dpr / base.textureHeight
  const u0 = u(nextWorld.x), v0 = v(nextWorld.y)
  const u1 = u(nextWorld.x + nextWorld.w), v1 = v(nextWorld.y + nextWorld.h)
  if (![u0, v0, u1, v1].every(value => Number.isFinite(value) && value >= -1e-6 && value <= 1 + 1e-6)) return
  return { u0, v0, u1, v1 }
}

function tileCore(tile: RasterTile) {
  const gutter = tile.gutter ?? 1
  const x = (tile.x + gutter - (tile.phaseX ?? 0)) / tile.zoom
  const y = (tile.y + gutter - (tile.phaseY ?? 0)) / tile.zoom
  return { x, y, width: (tile.width - 2 * gutter) / tile.zoom, height: (tile.height - 2 * gutter) / tile.zoom }
}

/** A ready tile improves a zoom underlay when it is finer than the retained
 * picture and the retained tiles do not already paint its rectangle at that
 * density. The retained bitmap still fills everything else. */
export function zoomUnderlayImproves(
  previous: { view: CanvasCamera; dpr: number },
  tiles: readonly RasterTile[],
  view: CanvasCamera,
  size: { width: number; height: number },
  former: readonly RasterTile[],
) {
  if (!(previous.dpr > 0) || !(previous.view.zoom > 0)) return false
  return tiles.some(tile => {
    if (!(tile.zoom > previous.view.zoom * previous.dpr + 1e-6)) return false
    const core = tileCore(tile)
    const x = Math.max(core.x, -view.x / view.zoom)
    const y = Math.max(core.y, -view.y / view.zoom)
    const right = Math.min(core.x + core.width, (size.width - view.x) / view.zoom)
    const bottom = Math.min(core.y + core.height, (size.height - view.y) / view.zoom)
    if (!(right > x) || !(bottom > y)) return false
    return !tilesCoverBounds([...former], { x, y, width: right - x, height: bottom - y }, tile.zoom)
  })
}

/** Finer residents that can paint over a stretched picture before they cover
 * the viewport. The retained picture supplies every pixel they do not.
 * Undefined when nothing finer is ready. */
export function zoomInPartialTiles<T extends RasterTile>(
  cached: Iterable<T>,
  backing: readonly RasterTile[],
  view: CanvasCamera,
  size: { width: number; height: number; dpr?: number },
) {
  if (!backing.length) return
  const extra = selectSharperCoverage([...cached], view, size, backing)
  return extra.length ? extra : undefined
}
