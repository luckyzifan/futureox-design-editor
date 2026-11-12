import { afterEach, describe, expect, test, vi } from 'vitest'
import { planTiles, TILE_SIDE, type RasterTile } from './tile-cache'
import { planTileFrame } from './gpu/tile-frame'
import { prioritizeTileFill } from './tile-scheduler'
import {
  DEFAULT_TILE_PREFETCH_RINGS,
  MAX_TILE_PREFETCH_RINGS,
  clipAlignedTile,
  planTilesAligned,
  planTilesWithPrefetchRim,
  tilePrefetchRingsFromHost,
} from './tile-plan-aligned'

test('cold edge crops keep their fractional lattice and filtering gutter', () => {
  const tile: RasterTile = { key: 'full', x: -513, y: 511, width: 514, height: 514,
    zoom: .25, phaseX: .125, phaseY: .75, gutter: 1 }
  const cropped = clipAlignedTile(tile, { x: -255, y: 576, w: 272, h: 384 })
  expect(cropped).toMatchObject({ x: -256, y: 575, width: 257, height: 386,
    zoom: tile.zoom, phaseX: tile.phaseX, phaseY: tile.phaseY, gutter: 1 })
  expect(cropped.key).not.toBe(tile.key)
  expect(clipAlignedTile(tile, { x: -512, y: 512, w: 512, h: 512 })).toBe(tile)
})

/** The production viewport planner and the kernel's open tile-frame model
 * compute the same world-aligned grid: every zoom/bounds combination must
 * agree on the tile count (phase only shifts sampling inside a tile). */
describe('tile planners agree', () => {
  const cases: [string, { x: number; y: number; width: number; height: number }, number][] = [
    ['origin at zoom 1', { x: 0, y: 0, width: 512, height: 384 }, 1],
    ['offset viewport', { x: 100.5, y: -60, width: 600, height: 300 }, 1],
    ['zoom 2', { x: 0, y: 0, width: 300, height: 300 }, 2],
    ['zoom 0.5', { x: 0, y: 0, width: 1024, height: 768 }, 0.5],
    // off-level zoom: the open model snaps to the power-of-two level grid,
    // so it needs strictly fewer-or-equal tiles than the any-zoom planner
    ['off-level zoom snaps down', { x: -40, y: 24, width: 512, height: 384 }, 1.375],
    ['single tile', { x: 10, y: 10, width: 100, height: 100 }, 1],
    ['exact tile boundary', { x: 0, y: 0, width: 512, height: 512 }, 1],
  ]
  for (const [name, bounds, zoom] of cases) {
    test(name, () => {
      const production = planTiles(bounds, zoom, 4096)
      const open = planTileFrame(
        { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height },
        zoom,
      )
      const level = Math.round(Math.log2(zoom))
      const onLevel = Math.abs(zoom - 2 ** level) < 1e-9
      if (onLevel) expect(production.length).toBe(open.tiles.length)
      else expect(open.tiles.length).toBeLessThanOrEqual(production.length)
      // Coverage identity: production tiles carry a 1px gutter (x*256-1),
      // the open model addresses the bare grid - origins agree modulo it.
      const px0 = Math.min(...production.map((t) => t.x)) + 1
      const ox0 = Math.min(...open.tiles.map((t) => t.device[0]))
      expect(px0).toBeCloseTo(ox0, 6)
    })
  }
})

/** Prefetch rim: the production viewport plan extended by whole outer tile
 * rings on the same Rust-addressed world grid, Figma off-screen prefetch
 * parity (see tile-plan-aligned.ts). Ring counts are exact by construction
 * because rim addresses are enumerated around the viewport address range. */
describe('prefetch rim planning', () => {
  // Device space [10,710]x[20,500] at zoom 1: addresses x∈{0,1} (2 cols),
  // y∈{0} (1 row) → a 2-tile viewport with unambiguous ring arithmetic.
  const bounds = { x: 10, y: 20, width: 700, height: 480 }
  const addr = (t: RasterTile) => ({ x: (t.x + 1) / TILE_SIDE, y: (t.y + 1) / TILE_SIDE })

  test('ring count × tile count: rings widen the address box by exactly 2·rings per axis', () => {
    const one = planTilesWithPrefetchRim(bounds, 1, 256, { x: 0, y: 0 }, 1)
    expect(one.viewport).toHaveLength(2)
    expect(one.rim).toHaveLength(10) // (2+2)·(1+2) − 2
    expect(one.cacheLimitSkipped).toBe(0)
    const two = planTilesWithPrefetchRim(bounds, 1, 256, { x: 0, y: 0 }, 2)
    expect(two.rim).toHaveLength(28) // (2+4)·(1+4) − 2
    expect(one.rim.every((tile) => two.rim.some((other) => other.key === tile.key))).toBe(true)
  })

  test('rings=0 is byte-equivalent to the pre-rim planner: no rim, no skips', () => {
    const legacy = planTilesAligned(bounds, 1, 256)
    const plan = planTilesWithPrefetchRim(bounds, 1, 256, { x: 0, y: 0 }, 0)
    expect(plan.viewport).toEqual(legacy)
    expect(plan.rim).toEqual([])
    expect(plan.cacheLimitSkipped).toBe(0)
  })

  test('rim tiles are prefetch-marked gutters of the same phase-shifted grid', () => {
    const phase = { x: 0.25, y: 0.5 }
    const plan = planTilesWithPrefetchRim(bounds, 2, 256, phase)
    for (const tile of plan.rim) {
      expect(tile.prefetch).toBe(true)
      expect(tile.zoom).toBe(2)
      expect(tile.phaseX).toBe(phase.x)
      expect(tile.phaseY).toBe(phase.y)
      expect(tile.width).toBe(TILE_SIDE + 2)
      expect(Math.abs((tile.x + 1) % TILE_SIDE)).toBe(0)
      expect(tile.key.startsWith(`2:${phase.x}:${phase.y}:`)).toBe(true)
      // Rim keys never collide with viewport keys (disjoint address sets).
      expect(plan.viewport.some((v) => v.key === tile.key)).toBe(false)
    }
    // Viewport tiles carry no prefetch marking.
    expect(plan.viewport.every((tile) => tile.prefetch === undefined)).toBe(true)
  })

  test('a one-tile pan reveals only tiles the rim already prefetched', () => {
    const before = planTilesWithPrefetchRim(bounds, 1, 256)
    const panned = planTilesAligned({ ...bounds, x: bounds.x + TILE_SIDE }, 1, 256)
    const warmed = new Set([...before.viewport, ...before.rim].map((t) => t.key))
    expect(panned.length).toBeGreaterThan(0)
    expect(panned.every((tile) => warmed.has(tile.key))).toBe(true)
  })

  test('the plan limit trims the rim, never the viewport, and reports cache skips', () => {
    const legacy = planTilesAligned(bounds, 1, 6)
    const plan = planTilesWithPrefetchRim(bounds, 1, 6, { x: 0, y: 0 }, 2)
    // 2 viewport tiles + allowance 4 → 4 rim tiles kept, 24 skipped.
    expect(plan.viewport).toEqual(legacy)
    expect(plan.rim).toHaveLength(4)
    expect(plan.cacheLimitSkipped).toBe(24)
    const xs = plan.viewport.map((t) => addr(t).x), ys = plan.viewport.map((t) => addr(t).y)
    const minX = Math.min(...xs), maxX = Math.max(...xs)
    const minY = Math.min(...ys), maxY = Math.max(...ys)
    const ringOf = (a: { x: number; y: number }) => Math.max(
      a.x < minX ? minX - a.x : a.x > maxX ? a.x - maxX : 0,
      a.y < minY ? minY - a.y : a.y > maxY ? a.y - maxY : 0,
    )
    // Survivors are nearest-ring tiles only (Chebyshev ring distance 1).
    for (const tile of plan.rim) expect(ringOf(addr(tile))).toBe(1)
    // An exhausted limit skips the whole rim while keeping the viewport.
    const full = planTilesWithPrefetchRim(bounds, 1, 2, { x: 0, y: 0 }, 1)
    expect(full.viewport).toHaveLength(2)
    expect(full.rim).toEqual([])
    expect(full.cacheLimitSkipped).toBe(10)
  })

  test('planned rim tiles classify as off-screen in the fill scheduler', () => {
    const plan = planTilesWithPrefetchRim(bounds, 1, 256)
    const ranked = prioritizeTileFill([...plan.rim, ...plan.viewport], bounds)
    expect(ranked.onScreen.map((t) => t.key).sort()).toEqual(plan.viewport.map((t) => t.key).sort())
    expect(ranked.offScreen.map((t) => t.key).sort()).toEqual(plan.rim.map((t) => t.key).sort())
  })
})

describe('prefetch rim host configuration', () => {
  afterEach(() => vi.unstubAllGlobals())
  test('defaults to viewport-height expansion without storage', () => {
    expect(DEFAULT_TILE_PREFETCH_RINGS).toBe(1)
    expect(tilePrefetchRingsFromHost()).toBeUndefined()
  })
  test('reads whole ring counts from forma.render.tilePrefetchRings, 0 disables', () => {
    const store: Record<string, string> = {}
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value },
    })
    store['forma.render.tilePrefetchRings'] = '0'
    expect(tilePrefetchRingsFromHost()).toBe(0)
    store['forma.render.tilePrefetchRings'] = '3'
    expect(tilePrefetchRingsFromHost()).toBe(3)
    // Clamped to the bounded enumeration maximum; invalid values fall back.
    store['forma.render.tilePrefetchRings'] = '99'
    expect(tilePrefetchRingsFromHost()).toBe(MAX_TILE_PREFETCH_RINGS)
    for (const invalid of ['abc', '-2', '1.5', '']) {
      store['forma.render.tilePrefetchRings'] = invalid
      expect(tilePrefetchRingsFromHost()).toBeUndefined()
    }
  })
})
