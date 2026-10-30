import { expect, test } from 'vitest'
import { budgetTileLimit, displayTileBudget, MAX_DISPLAY_TILE_BYTES, devicePixelPhase, planTiles, tileLevel, TileCache, tilesCoverBounds } from './tile-cache'
import { planTilesAligned } from './tile-plan-aligned'

test('panning shares world tiles, including negative coordinates and gutters', () => {
  const a = planTiles({ x: -120, y: -80, width: 600, height: 400 }, 2)
  const b = planTiles({ x: -100, y: -60, width: 600, height: 400 }, 2)
  expect(a.filter((t) => b.some((other) => other.key === t.key)).length).toBeGreaterThan(4)
  for (const tile of a) {
    expect(Math.abs((tile.x + 1) % 512)).toBe(0)
    expect(tile.width).toBe(514)
  }
  expect(planTiles({ x: 0, y: 0, width: 512, height: 512 }, 1)).toHaveLength(1)
})
test('detail levels meet requested density without more than a quarter-octave overshoot', () => {
  for (const requested of [0.025, 0.3, 0.75, 1, 1.5, 2, 4, 16, 32]) {
    expect(tileLevel(requested)).toBeGreaterThanOrEqual(requested)
    expect(tileLevel(requested) / requested).toBeLessThanOrEqual(2 ** 0.25 + 1e-10)
  }
})
test('bounded LRU retains recently visited tiles and never exceeds its byte limit', () => {
  const cache = new TileCache<string>(12)
  cache.set('a', 'A', 4)
  cache.set('b', 'B', 4)
  cache.set('c', 'C', 4)
  expect(cache.get('a')).toBe('A')
  cache.set('d', 'D', 4)
  expect(cache.get('b')).toBeUndefined()
  expect(cache.bytes).toBe(12)
  cache.set('too large', 'X', 13)
  expect(cache.get('too large')).toBeUndefined()
  cache.clear()
  expect(cache.bytes).toBe(0)
  expect(cache.size).toBe(0)
})
test('invalid and unbounded tile plans fail explicitly', () => {
  expect(() => planTiles({ x: 0, y: 0, width: 1e9, height: 1e9 }, 2)).toThrow('budget')
  expect(() => planTiles({ x: NaN, y: 0, width: 1, height: 1 }, 2)).toThrow('bounds')
})

test('Retina display budgets cover panned native-density viewports and atomic replacement', () => {
  for (const [width, height, dpr] of [[2560, 1440, 2], [1920, 1080, 3], [1600, 1000, 2]]) {
    const budget = displayTileBudget(width, height, dpr, false)
    expect(budget).toBeLessThanOrEqual(MAX_DISPLAY_TILE_BYTES)
    for (const x of [-1.25, 0, 1, 511]) {
      const bounds = { x, y: x, width, height }
      const tiles = planTilesAligned(bounds, dpr, budgetTileLimit(budget, false), { x: 0.25, y: 0.75 })
      expect(tilesCoverBounds(tiles, bounds)).toBe(true)
      expect(tiles.reduce((n, t) => n + t.width * t.height * 12, 0)).toBeLessThanOrEqual(budget)
    }
  }
  expect(() => displayTileBudget(100000, 100000, 3, false)).toThrow('budget')
})

test('fractional device camera phases get distinct exact samples and integer pans reuse them', () => {
  const camera = { x: -123.375, y: 61.625, zoom: 1.3 }, dpr = 2
  const make = (x: number, y: number) => planTiles({ x: -x / camera.zoom, y: -y / camera.zoom,
    width: 600 / camera.zoom, height: 400 / camera.zoom }, camera.zoom * dpr, 256,
    { x: devicePixelPhase(x, dpr), y: devicePixelPhase(y, dpr) })
  const a = make(camera.x, camera.y), b = make(camera.x + 10, camera.y + 20), c = make(camera.x + 0.125, camera.y)
  expect(a.some((tile) => b.some((other) => other.key === tile.key))).toBe(true)
  expect(a.some((tile) => c.some((other) => other.key === tile.key))).toBe(false)
  expect(devicePixelPhase(-123.375, 2)).toBe(0.25)
  expect(tilesCoverBounds(a, { x: -camera.x / camera.zoom, y: -camera.y / camera.zoom,
    width: 600 / camera.zoom, height: 400 / camera.zoom }, camera.zoom * dpr)).toBe(true)
  for (const tile of a) {
    const screenX = tile.x + Math.floor(camera.x * dpr)
    expect(Number.isInteger(screenX)).toBe(true)
    expect(-tile.x + tile.phaseX! + screenX).toBe(camera.x * dpr)
  }
})
