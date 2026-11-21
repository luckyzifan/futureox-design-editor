import type { CanvasCamera } from '../canvas-camera'
import type { Bounds } from '../model'
import type { Rect } from './gpu/types'
import { TILE_SIDE, type RasterTile } from './tile-cache'
import { clipAlignedTile } from './tile-plan-aligned'

export type BoardViewport = { view: CanvasCamera; width: number; height: number; dpr?: number }

export function boardViewportBounds({ view, width, height }: BoardViewport): Bounds {
  return { x: -view.x / view.zoom, y: -view.y / view.zoom, width: width / view.zoom, height: height / view.zoom }
}

export function visibleBoardSource(board: Bounds, viewport: Bounds, offset = { x: 0, y: 0 }): Bounds | undefined {
  const x = Math.max(board.x, viewport.x - offset.x)
  const y = Math.max(board.y, viewport.y - offset.y)
  const right = Math.min(board.x + board.width, viewport.x + viewport.width - offset.x)
  const bottom = Math.min(board.y + board.height, viewport.y + viewport.height - offset.y)
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined
}

export function containsBoardSource(outer: Bounds, inner: Bounds) {
  return outer.x <= inner.x && outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height
}

export function clippedBoardSource(board: Bounds, camera: BoardViewport) {
  const viewport = boardViewportBounds(camera)
  if (containsBoardSource(viewport, board) || !visibleBoardSource(board, viewport)) return
  // Borrow no more than half a native cell on each side. Arbitrarily large
  // boards can reuse the certified viewport area, and larger moves rebase.
  const margin = (TILE_SIDE / 2) / (camera.view.zoom * (camera.dpr ?? 1))
  return visibleBoardSource(board, {
    x: viewport.x - margin, y: viewport.y - margin,
    width: viewport.width + 2 * margin, height: viewport.height + 2 * margin,
  })
}

export function tileOnBoardLattice(tile: RasterTile, view: CanvasCamera, dpr: number) {
  if (tile.zoom !== view.zoom * dpr || tile.width < 1 || tile.height < 1) return false
  // Subtract the phases before adding the integer tile origin. Grouping the
  // origin with the phase first can lose an ulp on the far side of a canvas.
  const x = view.x * dpr - (tile.phaseX ?? 0)
  const y = view.y * dpr - (tile.phaseY ?? 0)
  return [x, y, tile.x, tile.y, tile.width, tile.height, x + tile.x, y + tile.y].every(Number.isSafeInteger)
}

function exteriorStrips(source: Rect, viewport: Rect): Rect[] {
  const top = Math.max(source.y, viewport.y)
  const bottom = Math.min(source.y + source.h, viewport.y + viewport.h)
  const left = Math.max(source.x, viewport.x)
  const right = Math.min(source.x + source.w, viewport.x + viewport.w)
  return [
    { x: source.x, y: source.y, w: source.w, h: top - source.y },
    { x: source.x, y: bottom, w: source.w, h: source.y + source.h - bottom },
    { x: source.x, y: top, w: left - source.x, h: bottom - top },
    { x: right, y: top, w: source.x + source.w - right, h: bottom - top },
  ].filter(strip => strip.w > 0 && strip.h > 0)
}

/** Extra tiles carry the same density, phase, gutter and cache contract as
 * their on-screen siblings. Only offscreen interiors are requested. */
export function clippedBoardPrefetch(
  source: Bounds, camera: BoardViewport, cells: readonly RasterTile[], limit: number,
): RasterTile[] {
  if (!cells.length || limit <= 0) return []
  const { view, width, height, dpr = 1 } = camera
  const { zoom, phaseX = 0, phaseY = 0 } = cells[0]
  const x = Math.floor(source.x * zoom + phaseX), y = Math.floor(source.y * zoom + phaseY)
  const right = Math.ceil((source.x + source.width) * zoom + phaseX)
  const bottom = Math.ceil((source.y + source.height) * zoom + phaseY)
  const viewport = { x: phaseX - view.x * dpr, y: phaseY - view.y * dpr,
    w: Math.ceil(width * dpr), h: Math.ceil(height * dpr) }
  if (![x, y, right, bottom, viewport.x, viewport.y].every(Number.isSafeInteger)) return []
  const patches: RasterTile[] = []
  for (const strip of exteriorStrips({ x, y, w: right - x, h: bottom - y }, viewport)) {
    for (const cell of cells) {
      const gutter = cell.gutter ?? 1
      if (cell.x + gutter >= strip.x + strip.w || cell.x + cell.width - gutter <= strip.x ||
          cell.y + gutter >= strip.y + strip.h || cell.y + cell.height - gutter <= strip.y) continue
      patches.push({ ...clipAlignedTile(cell, strip), prefetch: true })
      if (patches.length === limit) return patches
    }
  }
  return patches
}
