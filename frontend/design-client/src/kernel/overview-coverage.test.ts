import { expect, test } from 'vitest'
import { planTiles } from './tile-cache'
import { hasRetainedOverview } from './overview-coverage'

test('sharper page backing replaces maintenance at arbitrary scale, negative origin and fractional phase', () => {
  const document = {}, revision = 17, bounds = { x: -1800.25, y: -500.75, width: 4100, height: 1900 }
  const tiles = planTiles(bounds, .37, 64, { x: .375, y: .125 }).map(tile => ({ ...tile, document, revision, overview: true }))
  const ready = new Set(tiles.map(tile => tile.key))
  const covered = (items = tiles, keys = ready, doc = document, rev = revision) =>
    hasRetainedOverview(items, keys, doc, rev, bounds, .12)
  expect(covered()).toBe(true)
  const without = tiles.slice(1)
  expect(covered(without)).toBe(false)
  expect(covered(tiles, new Set(without.map(tile => tile.key)))).toBe(false)
  expect(covered(tiles.map(tile => ({ ...tile, overview: false })))).toBe(false)
  expect(covered(tiles, ready, {})).toBe(false)
  expect(covered(tiles, ready, document, revision + 1)).toBe(false)
  expect(hasRetainedOverview(tiles, ready, document, revision, bounds, .74)).toBe(false)
})
