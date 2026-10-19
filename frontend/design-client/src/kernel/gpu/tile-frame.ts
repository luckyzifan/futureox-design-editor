/**
 * Tile frame planning: the open tile-addressing layer over the kernel's
 * tile stack.  A viewport (world rect + zoom) resolves to the power-of-two
 * tile level and a set of tile passes — each with its device viewport,
 * clear policy and tile→node matrix — matching the per-tile render pass
 * contract a tile-based GPU compositor consumes.
 */
import { Graph, INVALID_HANDLE } from '../graph'

export const TILE_SIZE = 512

export type WorldRect = { x: number; y: number; w: number; h: number }

export type TilePlan = {
  /** Opaque kernel handle; INVALID_HANDLE when the planner runs without one. */
  handle: number
  /** Tile coordinates at `level` (pixel units at that level's scale). */
  level: number
  x: number
  y: number
  /** Device-space viewport of the tile at its own level: x, y, w, h. */
  device: [number, number, number, number]
  /** Clip of the viewport to the requested world rect, in device units. */
  scissor: [number, number, number, number]
  /** UV rect of the scissor inside the tile texture. */
  uv: [number, number, number, number]
  /** Row-major 3×3 tile-local pixel → world matrix. */
  tileToWorld: number[]
  needsColorClear: boolean
}

export type TileFrame = {
  level: number
  /** World scale of `level`. */
  scale: number
  tiles: TilePlan[]
}

/** Nearest power-of-two level for a zoom, clamped like the kernel. */
export function levelForZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 0
  return Math.min(8, Math.max(-8, Math.round(Math.log2(zoom))))
}

/**
 * Plan the tile frame for a world rect.  When `graph` is provided the plan
 * comes from the kernel tile stack (handles stay valid until released);
 * otherwise an address-only mirror of the same math runs locally, which
 * keeps planner consumers testable without a wasm instance.
 */
export function planTileFrame(
  view: WorldRect,
  zoom: number,
  options: { graph?: Graph; pad?: number } = {},
): TileFrame {
  const level = levelForZoom(zoom)
  const scale = Math.pow(2, level)
  const pad = options.pad ?? 0
  const graph = options.graph
  const worldX0 = Math.min(view.x, view.x + view.w)
  const worldY0 = Math.min(view.y, view.y + view.h)
  const worldW = Math.abs(view.w)
  const worldH = Math.abs(view.h)
  const tileWorld = TILE_SIZE / scale

  const x0 = Math.floor((worldX0 - pad) / tileWorld)
  const y0 = Math.floor((worldY0 - pad) / tileWorld)
  const x1 = Math.ceil((worldX0 + worldW + pad) / tileWorld)
  const y1 = Math.ceil((worldY0 + worldH + pad) / tileWorld)

  // Requested rect in device pixels at this level, for scissor clipping.
  const devX = (worldX0 - pad) * scale
  const devY = (worldY0 - pad) * scale
  const devW = (worldW + 2 * pad) * scale
  const devH = (worldH + 2 * pad) * scale

  const tiles: TilePlan[] = []
  for (let ty = y0; ty <= y1; ty += 1) {
    for (let tx = x0; tx <= x1; tx += 1) {
      const deviceX = tx * TILE_SIZE
      const deviceY = ty * TILE_SIZE
      const clipX = Math.max(deviceX, devX)
      const clipY = Math.max(deviceY, devY)
      const clipR = Math.min(deviceX + TILE_SIZE, devX + devW)
      const clipB = Math.min(deviceY + TILE_SIZE, devY + devH)
      if (clipR <= clipX || clipB <= clipY) continue
      const scissor: [number, number, number, number] = [clipX, clipY, clipR - clipX, clipB - clipY]
      const uv: [number, number, number, number] = [
        (clipX - deviceX) / TILE_SIZE,
        (clipY - deviceY) / TILE_SIZE,
        (clipR - clipX) / TILE_SIZE,
        (clipB - clipY) / TILE_SIZE,
      ]
      const handle = graph
        ? graph.tile(level, tx, ty)
        : INVALID_HANDLE
      tiles.push({
        handle,
        level,
        x: tx,
        y: ty,
        device: [deviceX, deviceY, TILE_SIZE, TILE_SIZE],
        scissor,
        uv,
        tileToWorld: [
          1 / scale, 0, 0,
          0, 1 / scale, 0,
          tx * tileWorld, ty * tileWorld, 1,
        ],
        needsColorClear: true,
      })
    }
  }
  return { level, scale, tiles }
}

/**
 * Kernel-backed variant: every tile carries its kernel handle with the
 * stack's own viewport/scissor/uv/clear answers, so the GPU layer consumes
 * one source of truth.
 */
export function planKernelTileFrame(
  graph: Graph,
  view: WorldRect,
  zoom: number,
  pad = 0,
): TileFrame {
  const frame = planTileFrame(view, zoom, { graph, pad })
  for (const tile of frame.tiles) {
    if (tile.handle === INVALID_HANDLE) continue
    const viewport = graph.tileViewport(tile.handle)
    tile.device = [viewport[0]!, viewport[1]!, viewport[2]!, viewport[3]!]
    const clear = graph.tileScissorForClear(tile.handle)
    tile.scissor = [clear[0]!, clear[1]!, clear[2]!, clear[3]!]
    const uv = graph.tileUvRect(tile.handle)
    tile.uv = [uv[0]!, uv[1]!, uv[2]!, uv[3]!]
    tile.needsColorClear = graph.tileNeedsColorClear(tile.handle)
    tile.tileToWorld = graph.tileToNode(tile.level, tile.x, tile.y)
  }
  return frame
}

export function releaseTileFrame(graph: Graph, frame: TileFrame): void {
  for (const tile of frame.tiles) {
    if (tile.handle !== INVALID_HANDLE) graph.releaseTile(tile.handle)
  }
}
