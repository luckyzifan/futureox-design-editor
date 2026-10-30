import { expect, test } from 'vitest'
import { planTiles } from './tile-cache'
import { hasRetainedOverview, completeViewportBacking } from './overview-coverage'

test('only a complete low-scale viewport within the existing allowance can become backing', () => {
  const bounds = { x: -100, y: -200, width: 4000, height: 1600 }, scale = .25
  const tiles = planTiles(bounds, scale, 64, { x: .125, y: .375 })
  expect(completeViewportBacking(tiles, bounds, scale, 12 * 1024 ** 2, 128 * 1024 ** 2)).toBe(true)
  expect(completeViewportBacking(tiles.slice(1), bounds, scale, 12 * 1024 ** 2, 128 * 1024 ** 2)).toBe(false)
  expect(completeViewportBacking(tiles, bounds, scale, 33 * 1024 ** 2, 128 * 1024 ** 2)).toBe(false)
  expect(completeViewportBacking(tiles, bounds, 2, 12 * 1024 ** 2, 128 * 1024 ** 2)).toBe(false)
  expect(completeViewportBacking(tiles, undefined, scale, 12 * 1024 ** 2, 128 * 1024 ** 2)).toBe(false)
})

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
