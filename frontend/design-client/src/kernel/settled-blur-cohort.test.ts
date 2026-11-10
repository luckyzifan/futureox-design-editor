import { expect, test } from 'vitest'
import { recordDetailClock, type DetailClock } from './detail-timing'
import { cohortSliceRect, dominantDeviceBlurRadius, settledBlurCovers, settledBlurPlaneFits, SETTLED_BLUR_PLANE_BYTES, type CohortTile } from './settled-blur-cohort'

const tile = (x: number, y: number, extra: Partial<CohortTile> = {}): CohortTile => ({
  x, y, width: 514, height: 514, zoom: 64, gutter: 1, phaseX: 0, phaseY: 0, ...extra,
})

/** 4×3 grid at the production 512 stride. Union is one raster, not eight batches. */
function highZoomGrid() {
  const tiles: CohortTile[] = []
  for (let row = 0; row < 3; row++) for (let column = 0; column < 4; column++)
    tiles.push(tile(column * 512 - 1, row * 512 - 1))
  return tiles
}

test('a settled 117-scale blur packs the visible grid inside the existing plane budget', () => {
  const tiles = highZoomGrid()
  const covers = settledBlurCovers(tiles, { radius: 1224.3035888671875, quiet: true })
  expect(covers?.map(cover => [cover.width, cover.height, cover.members.length])).toEqual([[1026, 1538, 6], [1026, 1538, 6]])
  const seen = new Set<CohortTile>()
  for (const cover of covers ?? []) {
    expect(cover.members.length).toBeGreaterThan(1)
    expect(cover.members.length).toBeLessThan(8)
    expect(settledBlurPlaneFits(cover.width, cover.height, 1224.3035888671875)).toBe(true)
    expect(cover.width * (cover.height + (Math.ceil(1224.3035888671875) + 1) * 2) * 16).toBeLessThanOrEqual(SETTLED_BLUR_PLANE_BYTES)
    for (const member of cover.members) {
      expect(seen.has(member)).toBe(false)
      seen.add(member)
      expect(cohortSliceRect(cover, member)).toBeTruthy()
    }
  }
  expect(seen.size).toBe(tiles.length)
})

test('the same grid is not covered while moving, for a small blur, or past the input cap', () => {
  const tiles = highZoomGrid()
  expect(settledBlurCovers(tiles, { radius: 1224.3035888671875, quiet: false })).toBeUndefined()
  expect(settledBlurCovers(tiles, { radius: 32, quiet: true })).toBeUndefined()
  expect(settledBlurCovers(tiles.slice(0, 1), { radius: 1224, quiet: true })).toBeUndefined()
  expect(settledBlurCovers(tiles, { radius: 4000, quiet: true })).toBeUndefined()
  expect(settledBlurCovers(tiles.map((entry, index) => index === 3 ? { ...entry, zoom: 32 } : entry), { radius: 1224, quiet: true })).toBeUndefined()
})

test('prefetch tiles stay outside the covering raster', () => {
  const visible = [tile(-1, -1), tile(511, -1)]
  const covers = settledBlurCovers([...visible, tile(1023, -1, { prefetch: true })], { radius: 200, quiet: true })
  expect(covers).toHaveLength(1)
  expect(covers?.[0].members).toEqual(visible)
  expect(covers?.[0]).toMatchObject({ x: -1, y: -1, width: 1026, height: 514 })
})

test('117 device radius admits a cover and a 100% leaf blur does not', () => {
  const authored = 9.564871788024902
  expect(dominantDeviceBlurRadius([{
    opacity: 1, children: [], matrix: [64, 0, 0, 64, 0, 0],
    effects: [{ kind: 'blur', visible: true, radius: authored }],
  }])).toBeCloseTo(authored * 64, 6)
  expect(dominantDeviceBlurRadius([{
    matrix: [1, 0, 0, 1, 0, 0],
    effects: [{ kind: 'blur', visible: true, radius: authored }],
  }])).toBeUndefined()
  expect(dominantDeviceBlurRadius([{
    matrix: [64, 0, 0, 64, 0, 0], children: ['child'],
    effects: [{ kind: 'blur', visible: true, radius: authored }],
  }])).toBeUndefined()
  expect(dominantDeviceBlurRadius([{
    matrix: [64, 0, 0, 64, 0, 0],
    effects: [{ kind: 'blur', visible: true, radius: authored, gradientBlur: {} }],
  }])).toBeUndefined()
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
