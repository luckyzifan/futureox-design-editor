/** Settled visible tiles that share one large blur. The center tile is posted
 * first by the caller. Each cover is one same-zoom raster of a rectangle of
 * the remaining grid, then copied back onto those tiles. This is not an
 * eight-tile batch: a rectangle is emitted only when its horizontal plane
 * fits the existing 64 MiB filter-cache admission and the 8192 input cap. */

export const SETTLED_BLUR_MIN_RADIUS = 64
export const SETTLED_BLUR_OUTPUT_LIMIT = 8192
export const SETTLED_BLUR_PLANE_BYTES = 64 * 1024 * 1024

export type CohortTile = {
  x: number
  y: number
  width: number
  height: number
  zoom: number
  gutter?: number
  phaseX?: number
  phaseY?: number
  prefetch?: boolean
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
 * Larger than the existing cache admission, or an input past 8192, does not fit. */
export function settledBlurPlaneFits(width: number, height: number, radius: number) {
  const reach = Math.ceil(radius) + 1
  if (!Number.isSafeInteger(reach) || reach < 1 || width < 1 || height < 1 ||
      width > SETTLED_BLUR_OUTPUT_LIMIT || height > SETTLED_BLUR_OUTPUT_LIMIT ||
      width + reach * 2 > SETTLED_BLUR_OUTPUT_LIMIT || height + reach * 2 > SETTLED_BLUR_OUTPUT_LIMIT) return false
  const bytes = width * (height + reach * 2) * 16
  return Number.isSafeInteger(bytes) && bytes <= SETTLED_BLUR_PLANE_BYTES
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
        if (settledBlurPlaneFits(box.width, box.height, input.radius)) {
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
        if (settledBlurPlaneFits(box.width, box.height, input.radius)) {
          for (const tile of downTiles) chosen.add(tile)
          grew = true
        }
      }
    }
    if (chosen.size < 2) continue
    const box = unionOf([...chosen])
    const cover = { ...box, members: [...chosen] }
    if (cover.members.some(tile => !cohortSliceRect(cover, tile))) continue
    covers.push(cover)
    for (const tile of chosen) unused.delete(tile)
  }
  return covers.length ? covers : undefined
}
