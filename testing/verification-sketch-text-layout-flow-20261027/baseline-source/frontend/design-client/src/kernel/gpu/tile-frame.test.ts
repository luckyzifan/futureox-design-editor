import { beforeAll, afterAll, expect, test } from 'vitest'
import { blank, node } from '../../model'
import { Graph } from '../graph'
import { INVALID_HANDLE } from '../graph'
import {
  planTileFrame,
  planKernelTileFrame,
  releaseTileFrame,
  levelForZoom,
  TILE_SIZE,
} from './tile-frame'

let graph: Graph | undefined
let documentJson = ''

beforeAll(() => {
  const document = blank('tile frame')
  const frame = node('rectangle', 0, 0, 1000, 700)
  document.nodes[frame.id] = frame
  document.pages[0]!.children = [frame.id]
  documentJson = JSON.stringify(document)
  try {
    graph = Graph.open(documentJson)
  } catch {
    graph = undefined // wasm unavailable in this worker: address-only tests still run
  }
})

afterAll(() => {
  graph?.free()
})

test('level snaps to powers of two with clamps', () => {
  expect(levelForZoom(1)).toBe(0)
  expect(levelForZoom(0.5)).toBe(-1)
  expect(levelForZoom(4)).toBe(2)
  expect(levelForZoom(1e9)).toBe(8)
  expect(levelForZoom(0)).toBe(0)
  expect(levelForZoom(-2)).toBe(0)
})

test('tile frame covers the world rect without gaps', () => {
  const frame = planTileFrame({ x: 100, y: 100, w: 600, h: 300 }, 1)
  expect(frame.level).toBe(0)
  // Union of tile extents must cover the device rect [100,700)x[100,400).
  const covered = frame.tiles.map((t) => t.device)
  const minX = Math.min(...covered.map((d) => d[0]))
  const minY = Math.min(...covered.map((d) => d[1]))
  const maxX = Math.max(...covered.map((d) => d[0] + d[2]))
  const maxY = Math.max(...covered.map((d) => d[1] + d[3]))
  expect(minX).toBeLessThanOrEqual(100)
  expect(minY).toBeLessThanOrEqual(100)
  expect(maxX).toBeGreaterThanOrEqual(700)
  expect(maxY).toBeGreaterThanOrEqual(400)
  // Tiles do not overlap.
  const seen = new Set(frame.tiles.map((t) => `${t.x},${t.y}`))
  expect(seen.size).toBe(frame.tiles.length)
})

test('scissor clips tiles to the requested rect', () => {
  const frame = planTileFrame({ x: 100, y: 100, w: 600, h: 300 }, 1)
  for (const tile of frame.tiles) {
    const [sx, sy, sw, sh] = tile.scissor
    expect(sw).toBeGreaterThan(0)
    expect(sh).toBeGreaterThan(0)
    expect(sx).toBeGreaterThanOrEqual(100)
    expect(sy).toBeGreaterThanOrEqual(100)
    expect(sx + sw).toBeLessThanOrEqual(700)
    expect(sy + sh).toBeLessThanOrEqual(400)
    // Scissor lies inside the tile viewport.
    expect(sx).toBeGreaterThanOrEqual(tile.device[0])
    expect(sy).toBeGreaterThanOrEqual(tile.device[1])
  }
  // Union of scissors equals the device rect exactly (no double coverage).
  const area = frame.tiles.reduce((sum, t) => sum + t.scissor[2] * t.scissor[3], 0)
  expect(area).toBe(600 * 300)
})

test('zoomed frame scales tiles and matrix together', () => {
  const frame = planTileFrame({ x: 0, y: 0, w: 128, h: 128 }, 4)
  expect(frame.level).toBe(2)
  expect(frame.scale).toBe(4)
  expect(frame.tiles.length).toBe(1)
  const first = frame.tiles[0]!
  // At level 2 a tile covers 128 world units; tile→world maps 512 px to 128 u.
  expect(first.tileToWorld[0]).toBeCloseTo(1 / 4)
  const originX = first.tileToWorld[6]!
  expect(originX).toBeCloseTo(first.x * (TILE_SIZE / 4))
})

test('kernel tile frame mirrors address-only planning', () => {
  if (!graph) return
  const view = { x: 100, y: 100, w: 600, h: 300 }
  const local = planTileFrame(view, 1)
  const kernel = planKernelTileFrame(graph, view, 1)
  expect(kernel.tiles.length).toBe(local.tiles.length)
  for (const [i, tile] of kernel.tiles.entries()) {
    expect(tile.handle).not.toBe(INVALID_HANDLE)
    const reference = local.tiles[i]!
    expect(tile.device[0]).toBe(reference.device[0])
    expect(tile.device[1]).toBe(reference.device[1])
    // Kernel scissor is tile-clipped (uncropped viewport); the crop to the
    // requested rect must match the address-only planner inside the tile.
    const clipped = [
      Math.max(tile.scissor[0], reference.scissor[0]),
      Math.max(tile.scissor[1], reference.scissor[1]),
      Math.min(tile.scissor[0] + tile.scissor[2], reference.scissor[0] + reference.scissor[2]) -
        Math.max(tile.scissor[0], reference.scissor[0]),
      Math.min(tile.scissor[1] + tile.scissor[3], reference.scissor[1] + reference.scissor[3]) -
        Math.max(tile.scissor[1], reference.scissor[1]),
    ] as const
    expect(clipped[0]).toBeCloseTo(reference.scissor[0])
    expect(clipped[1]).toBeCloseTo(reference.scissor[1])
    expect(clipped[2]).toBeCloseTo(reference.scissor[2])
    expect(clipped[3]).toBeCloseTo(reference.scissor[3])
    expect(tile.tileToWorld[0]).toBeCloseTo(reference.tileToWorld[0])
    expect(tile.tileToWorld[6]).toBeCloseTo(reference.tileToWorld[6])
    expect(tile.needsColorClear).toBe(true)
  }
  releaseTileFrame(graph, kernel)
})

test('pad expands coverage outward only', () => {
  const tight = planTileFrame({ x: 300, y: 300, w: 100, h: 100 }, 1)
  const padded = planTileFrame({ x: 300, y: 300, w: 100, h: 100 }, 1, { pad: 300 })
  expect(padded.tiles.length).toBeGreaterThan(tight.tiles.length)
  const paddedSet = new Set(padded.tiles.map((t) => `${t.x},${t.y}`))
  for (const tile of tight.tiles) expect(paddedSet.has(`${tile.x},${tile.y}`)).toBe(true)
})
