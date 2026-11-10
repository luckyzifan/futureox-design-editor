/** Settled visible tiles that share one large blur. The center tile is posted
 * first by the caller. Each cover is one same-zoom raster of a rectangle of
 * the remaining grid, then copied back onto those tiles.
 *
 * A cover is not a production tile. The native tile compiler accepts only
 * `TILE_SIZE + 2` pixels per axis and rejects anything larger as
 * `Invalid GPU tile viewport`. The existing capture viewport already allows
 * 8192 pixels per axis and 8,388,608 pixels, which is the contract used here.
 * This is not an eight-tile batch: a rectangle is emitted only when its
 * horizontal plane fits the existing 64 MiB filter admission, its input
 * window fits the existing 8192 cap, and the halo window stays inside the
 * existing 16,777,216 scene-surface budget. */

import { HORIZONTAL_FILTER_CACHE_BYTES } from './gpu/horizontal-filter-cache'
import { TILE_SIDE } from './tile-cache'

/** Native `gpuViewport` limit: `TILE_SIZE + 2`. Do not raise it. */
export const TILE_VIEWPORT_AXIS = TILE_SIDE + 2
/** Existing capture viewport limits. A packed cover uses these, not the tile limit. */
export const CAPTURE_VIEWPORT_AXIS = 8192
export const CAPTURE_VIEWPORT_PIXELS = 8_388_608
export const CAPTURE_COORDINATE_LIMIT = 16_000_000
/** Existing scene extent budget. A cover whose blur halo cannot fit is not emitted. */
export const SCENE_SURFACE_PIXELS = 16_777_216
/**
 * Existing regional Gaussian output cap (`output.w > 1024` declines the plan).
 * A packed cover above this cannot keep that plan, so it stays on the per-tile path.
 */
export const REGIONAL_GAUSSIAN_OUTPUT_AXIS = 1024
export const REGIONAL_GAUSSIAN_SIGMA = 512

export const SETTLED_BLUR_MIN_RADIUS = 64

export type CohortTile = {
  key: string
  x: number
  y: number
  width: number
  height: number
  zoom: number
  gutter?: number
  phaseX?: number
  phaseY?: number
  prefetch?: true
}

export type SettledBlurCover = {
  x: number
  y: number
  width: number
  height: number
  members: CohortTile[]
}

type BlurNode = {
  opacity?: number
  children?: readonly unknown[]
  matrix?: readonly number[]
  effects?: readonly { visible?: boolean; kind?: string; radius?: number; gradientBlur?: unknown }[]
}

/** The ordinary tile compiler's axis check. A packed cover must not use this. */
export function gpuTileViewportAccepts(width: number, height: number) {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) &&
    width >= 1 && height >= 1 && width <= TILE_VIEWPORT_AXIS && height <= TILE_VIEWPORT_AXIS
}

/** Device-pixel radius of the largest ordinary leaf blur in a compiled tile.
 * The scale matches the renderer. Grouped and gradient blurs stay on the
 * per-tile path; their support is not this halo. */
export function dominantDeviceBlurRadius(nodes: Iterable<BlurNode>): number | undefined {
  let best = 0
  for (const node of nodes) {
    if ((node.opacity ?? 1) <= 0 || node.children?.length) continue
    const scale = node.matrix ? matrixScale(node.matrix) : 1
    if (!Number.isFinite(scale) || scale <= 0) continue
    for (const effect of node.effects ?? []) {
      if (effect.visible === false || effect.gradientBlur) continue
      if (effect.kind !== 'blur' && effect.kind !== 'gaussian-blur') continue
      const radius = (effect.radius ?? 0) * scale
      if (radius > best) best = radius
    }
  }
  return best >= SETTLED_BLUR_MIN_RADIUS ? best : undefined
}

/** A cover wider than the existing regional Gaussian output cap cannot keep
 * that plan. Those tiles stay on the per-tile path (#247), which already
 * admits device sigma in (512, 1024] for a normal tile. */
export function regionalGaussianBlocksCover(nodes: Iterable<BlurNode>, width: number, height: number) {
  if (width <= REGIONAL_GAUSSIAN_OUTPUT_AXIS && height <= REGIONAL_GAUSSIAN_OUTPUT_AXIS) return false
  for (const node of nodes) {
    if ((node.opacity ?? 1) <= 0) continue
    const scale = node.matrix ? matrixScale(node.matrix) : 1
    if (!Number.isFinite(scale) || scale <= 0) continue
    for (const effect of node.effects ?? []) {
      if (effect.visible === false) continue
      if (effect.kind !== 'gaussian-blur') continue
      const sigma = (effect.radius ?? 0) * scale
      if (sigma > REGIONAL_GAUSSIAN_SIGMA) return true
    }
  }
  return false
}

function matrixScale(matrix: readonly number[]) {
  const [a, b, c, d] = matrix
  if (![a, b, c, d].every(Number.isFinite)) return Number.NaN
  const square = a * a + b * b + c * c + d * d
  const determinant = a * d - b * c
  return Math.sqrt((square + Math.sqrt(Math.max(0, square * square - 4 * determinant * determinant))) / 2)
}

export function cohortSliceRect(cover: Pick<SettledBlurCover, 'x' | 'y' | 'width' | 'height'>, tile: CohortTile) {
  const x = tile.x - cover.x
  const y = tile.y - cover.y
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 ||
      !Number.isSafeInteger(tile.width) || !Number.isSafeInteger(tile.height) ||
      tile.width < 1 || tile.height < 1 || x + tile.width > cover.width || y + tile.height > cover.height) return
  return { x, y, w: tile.width, h: tile.height }
}

function unionOf(tiles: readonly CohortTile[]) {
  const x = Math.min(...tiles.map(tile => tile.x))
  const y = Math.min(...tiles.map(tile => tile.y))
  return {
    x, y,
    width: Math.max(...tiles.map(tile => tile.x + tile.width)) - x,
    height: Math.max(...tiles.map(tile => tile.y + tile.height)) - y,
  }
}

/** Horizontal-plane bytes the isolated filter reserves for this output.
 * Larger than the existing cache admission, or an input past 8192, does not fit.
 * The scene extent uses the ordinary blur outset, `ceil(2 * radius)`, which is
 * wider than the tent sample reach. That window must stay inside the existing
 * 16,777,216 surface budget or the capture compiler rejects it. */
export function settledBlurPlaneFits(width: number, height: number, radius: number) {
  const reach = Math.ceil(radius) + 1
  const extent = Math.ceil(radius * 2)
  if (!Number.isSafeInteger(reach) || !Number.isSafeInteger(extent) || reach < 1 || extent < 1 ||
      width < 1 || height < 1 ||
      width > CAPTURE_VIEWPORT_AXIS || height > CAPTURE_VIEWPORT_AXIS ||
      width + reach * 2 > CAPTURE_VIEWPORT_AXIS || height + reach * 2 > CAPTURE_VIEWPORT_AXIS) return false
  const bytes = width * (height + reach * 2) * 16
  const extentWidth = width + extent * 2
  const extentHeight = height + extent * 2
  return Number.isSafeInteger(bytes) && bytes <= HORIZONTAL_FILTER_CACHE_BYTES &&
    Number.isSafeInteger(extentWidth) && Number.isSafeInteger(extentHeight) &&
    extentWidth * extentHeight <= SCENE_SURFACE_PIXELS
}

/** Device rectangle for the existing capture compiler. Returns undefined when
 * the rectangle is a legal ordinary tile, or when it misses the capture limits.
 * Callers must submit this as `captureViewport`, never as `gpuViewport`. */
export function settledBlurCaptureRect(
  cover: Pick<SettledBlurCover, 'x' | 'y' | 'width' | 'height'>,
  origin: { x: number; y: number },
) {
  const x = cover.x + origin.x
  const y = cover.y + origin.y
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) ||
      Math.abs(x) > CAPTURE_COORDINATE_LIMIT || Math.abs(y) > CAPTURE_COORDINATE_LIMIT) return
  if (gpuTileViewportAccepts(cover.width, cover.height)) return
  if (!Number.isSafeInteger(cover.width) || !Number.isSafeInteger(cover.height) ||
      cover.width < 1 || cover.height < 1 ||
      cover.width > CAPTURE_VIEWPORT_AXIS || cover.height > CAPTURE_VIEWPORT_AXIS ||
      cover.width * cover.height > CAPTURE_VIEWPORT_PIXELS) return
  return { x, y, w: cover.width, h: cover.height }
}

export function settledBlurCovers(tiles: readonly CohortTile[], input: { radius: number; quiet: boolean }): SettledBlurCover[] | undefined {
  if (!input.quiet || !Number.isFinite(input.radius) || input.radius < SETTLED_BLUR_MIN_RADIUS) return
  const members = tiles.filter(tile => tile.prefetch !== true)
  if (members.length < 2) return
  const [first] = members
  const gutter = first.gutter ?? 1
  const strideX = first.width - 2 * gutter
  const strideY = first.height - 2 * gutter
  if (!Number.isSafeInteger(strideX) || !Number.isSafeInteger(strideY) || strideX < 1 || strideY < 1) return
  for (const tile of members) {
    if (tile.zoom !== first.zoom || tile.width !== first.width || tile.height !== first.height ||
        (tile.gutter ?? 1) !== gutter || !Object.is(tile.phaseX ?? 0, first.phaseX ?? 0) ||
        !Object.is(tile.phaseY ?? 0, first.phaseY ?? 0) ||
        ![tile.x, tile.y, tile.width, tile.height, tile.zoom].every(Number.isSafeInteger) ||
        tile.width < 1 || tile.height < 1 || !(tile.zoom > 0)) return
  }
  const at = new Map<string, CohortTile>()
  for (const tile of members) {
    const key = `${tile.x}:${tile.y}`
    if (at.has(key)) return
    at.set(key, tile)
  }
  const unused = new Set(members)
  const covers: SettledBlurCover[] = []
  const seeds = [...members].sort((a, b) => a.y - b.y || a.x - b.x)
  for (const seed of seeds) {
    if (!unused.has(seed)) continue
    const chosen = new Set<CohortTile>([seed])
    const contains = (x: number, y: number) => [...chosen].some(tile => tile.x === x && tile.y === y)
    let grew = true
    while (grew) {
      grew = false
      const ys = [...new Set([...chosen].map(tile => tile.y))]
      const xs = [...new Set([...chosen].map(tile => tile.x))]
      const right = Math.max(...xs) + strideX
      const rightTiles = ys.map(y => at.get(`${right}:${y}`))
      if (rightTiles.every((tile): tile is CohortTile => !!tile && unused.has(tile) && !contains(tile.x, tile.y))) {
        const next = [...chosen, ...rightTiles]
        const box = unionOf(next)
        if (settledBlurPlaneFits(box.width, box.height, input.radius) &&
            settledBlurCaptureRect(box, { x: 0, y: 0 })) {
          for (const tile of rightTiles) chosen.add(tile)
          grew = true
          continue
        }
      }
      const bottom = Math.max(...ys) + strideY
      const downTiles = xs.map(x => at.get(`${x}:${bottom}`))
      if (downTiles.every((tile): tile is CohortTile => !!tile && unused.has(tile) && !contains(tile.x, tile.y))) {
        const next = [...chosen, ...downTiles]
        const box = unionOf(next)
        if (settledBlurPlaneFits(box.width, box.height, input.radius) &&
            settledBlurCaptureRect(box, { x: 0, y: 0 })) {
          for (const tile of downTiles) chosen.add(tile)
          grew = true
        }
      }
    }
    if (chosen.size < 2) continue
    const box = unionOf([...chosen])
    const cover = { ...box, members: [...chosen] }
    if (!settledBlurCaptureRect(cover, { x: 0, y: 0 }) || cover.members.some(tile => !cohortSliceRect(cover, tile))) continue
    covers.push(cover)
    for (const tile of chosen) unused.delete(tile)
  }
  return covers.length ? covers : undefined
}
