import { expect, test } from 'vitest'
import { recordDetailClock, type DetailClock } from './detail-timing'
import {
  CAPTURE_VIEWPORT_PIXELS, dominantDeviceBlurRadius, gpuTileViewportAccepts, regionalGaussianBlocksCover,
  SCENE_SURFACE_PIXELS, settledBlurCaptureRect, settledBlurCovers, settledBlurPlaneFits, TILE_VIEWPORT_AXIS,
  type CohortTile,
} from './settled-blur-cohort'

const AUTHORED = 9.564871788024902
const SCALE_64 = AUTHORED * 64
const SCALE_128 = 1224.3035888671875

function tile(x: number, y: number, extra?: Partial<CohortTile>): CohortTile {
  return { key: `${x}:${y}`, x, y, width: 514, height: 514, zoom: 64, gutter: 1, ...extra }
}

function grid(columns: number, rows: number) {
  const tiles: CohortTile[] = []
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++)
    tiles.push(tile(column * 512 - 1, row * 512 - 1))
  return tiles
}

test('sampling scale 64 packs a quiet 4 by 3 grid into captures the tile compiler rejects', () => {
  const covers = settledBlurCovers(grid(4, 3), { radius: SCALE_64, quiet: true })
  expect(covers?.map(cover => [cover.x, cover.y, cover.width, cover.height, cover.members.length])).toEqual([
    [-1, -1, 2050, 514, 4],
    [-1, 511, 2050, 514, 4],
    [-1, 1023, 2050, 514, 4],
  ])
  for (const cover of covers ?? []) {
    expect(gpuTileViewportAccepts(cover.width, cover.height)).toBe(false)
    expect(cover.width).toBeGreaterThan(TILE_VIEWPORT_AXIS)
    const capture = settledBlurCaptureRect(cover, { x: 0, y: 0 })
    expect(capture).toMatchObject({ x: cover.x, y: cover.y, w: cover.width, h: cover.height })
    expect(settledBlurPlaneFits(cover.width, cover.height, SCALE_64)).toBe(true)
    const reach = Math.ceil(SCALE_64) + 1
    const extent = Math.ceil(SCALE_64 * 2)
    expect(cover.width * (cover.height + reach * 2) * 16).toBeLessThanOrEqual(64 * 1024 * 1024)
    expect((cover.width + extent * 2) * (cover.height + extent * 2)).toBeLessThanOrEqual(SCENE_SURFACE_PIXELS)
    expect(cover.width * cover.height).toBeLessThanOrEqual(CAPTURE_VIEWPORT_PIXELS)
  }
  expect(settledBlurCovers(grid(4, 3), { radius: SCALE_128, quiet: true })).toBeUndefined()
  expect(settledBlurPlaneFits(1026, 514, SCALE_128)).toBe(false)
})

test('motion, a small radius, one tile, and a mismatched phase stay on the per-tile path', () => {
  const tiles = grid(4, 3)
  expect(settledBlurCovers(tiles, { radius: SCALE_64, quiet: false })).toBeUndefined()
  expect(settledBlurCovers(tiles, { radius: 32, quiet: true })).toBeUndefined()
  expect(settledBlurCovers(tiles.slice(0, 1), { radius: SCALE_64, quiet: true })).toBeUndefined()
  expect(settledBlurCovers(tiles, { radius: 4000, quiet: true })).toBeUndefined()
  expect(settledBlurCovers(tiles.map((entry, index) => index === 3 ? { ...entry, zoom: 32 } : entry), { radius: SCALE_64, quiet: true })).toBeUndefined()
  expect(gpuTileViewportAccepts(514, 514)).toBe(true)
  expect(settledBlurCaptureRect({ x: 0, y: 0, width: 514, height: 514 }, { x: 0, y: 0 })).toBeUndefined()
})

test('prefetch tiles stay outside the covering raster', () => {
  const visible = [tile(-1, -1), tile(511, -1)]
  const covers = settledBlurCovers([...visible, tile(1023, -1, { prefetch: true })], { radius: 200, quiet: true })
  expect(covers).toHaveLength(1)
  expect(covers?.[0].members).toEqual(visible)
  expect(covers?.[0]).toMatchObject({ x: -1, y: -1, width: 1026, height: 514 })
  expect(gpuTileViewportAccepts(1026, 514)).toBe(false)
})

test('117 device radius admits a cover and a 100% leaf blur does not', () => {
  expect(dominantDeviceBlurRadius([{
    opacity: 1, children: [], matrix: [64, 0, 0, 64, 0, 0],
    effects: [{ kind: 'blur', visible: true, radius: AUTHORED }],
  }])).toBeCloseTo(AUTHORED * 64, 6)
  expect(dominantDeviceBlurRadius([{
    matrix: [1, 0, 0, 1, 0, 0],
    effects: [{ kind: 'blur', visible: true, radius: AUTHORED }],
  }])).toBeUndefined()
  expect(dominantDeviceBlurRadius([{
    matrix: [64, 0, 0, 64, 0, 0], children: ['child'],
    effects: [{ kind: 'blur', visible: true, radius: AUTHORED }],
  }])).toBeUndefined()
  expect(dominantDeviceBlurRadius([{
    matrix: [64, 0, 0, 64, 0, 0],
    effects: [{ kind: 'blur', visible: true, radius: AUTHORED, gradientBlur: {} }],
  }])).toBeUndefined()
})

test('a large gaussian keeps covers above the existing 1024 output cap on the per-tile path', () => {
  const nodes = [{
    opacity: 1, matrix: [64, 0, 0, 64, 0, 0],
    effects: [{ kind: 'gaussian-blur', visible: true, radius: AUTHORED }],
  }]
  expect(regionalGaussianBlocksCover(nodes, 1026, 1538)).toBe(true)
  expect(regionalGaussianBlocksCover(nodes, 1024, 1024)).toBe(false)
  expect(regionalGaussianBlocksCover([{
    opacity: 1, matrix: [64, 0, 0, 64, 0, 0],
    effects: [{ kind: 'blur', visible: true, radius: AUTHORED }],
  }], 1026, 1538)).toBe(false)
  const covers = settledBlurCovers(grid(4, 3), { radius: AUTHORED * 64, quiet: true })
  expect(covers?.every(cover => regionalGaussianBlocksCover(nodes, cover.width, cover.height))).toBe(true)
})

test('the first presented region does not complete the viewport', () => {
  const clock: DetailClock = { started: 1000 }
  recordDetailClock(clock, 'present', 1678)
  expect(clock).toEqual({ started: 1000, firstPresentMs: 678 })
  recordDetailClock(clock, 'present', 2000)
  expect(clock.firstPresentMs).toBe(678)
  expect(clock.completeMs).toBeUndefined()
  recordDetailClock(clock, 'complete', 6625)
  expect(clock.completeMs).toBe(5625)
  recordDetailClock(clock, 'complete', 9000)
  expect(clock.completeMs).toBe(5625)
})
