import { expect, test } from 'vitest'
import { planTiles } from './tile-cache'
import { planTilesWithPrefetchRim } from './tile-plan-aligned'
import { tileViewportDistance, tileOverlapsViewport } from './tile-scheduler'

test('bounded prefetch equals exhaustive viewport-height expansion and distance ordering', () => {
  for (const zoom of [.473, 1, 2.78]) for (const phase of [{ x: 0, y: 0 }, { x: .25, y: .75 }]) {
    const bounds = { x: -63.25, y: 118.375, width: 900 / zoom, height: 750 / zoom }
    const expanded = { x: bounds.x - bounds.height, y: bounds.y - bounds.height,
      width: bounds.width + 2 * bounds.height, height: 3 * bounds.height }
    const all = planTiles(expanded, zoom, 4096, phase)
    const viewport = planTiles(bounds, zoom, 256, phase), visible = new Set(viewport.map(t => t.key))
    const reference = all.filter(t => !visible.has(t.key)).sort((a, b) =>
      tileViewportDistance(a, bounds) - tileViewportDistance(b, bounds) || a.y - b.y || a.x - b.x)
    for (const limit of [viewport.length, viewport.length + 3, 64, 256]) {
      const actual = planTilesWithPrefetchRim(bounds, zoom, limit, phase)
      const expected = reference.slice(0, limit - viewport.length)
      expect(actual.rim.map(t => t.key)).toEqual(expected.map(t => t.key))
      expect(actual.cacheLimitSkipped).toBe(reference.length - expected.length)
      expect(actual.rim.every(t => !tileOverlapsViewport(t, bounds))).toBe(true)
    }
  }
})

test('overlap gutters and fractional phases cannot spend the viewport exemption', () => {
  const tile = { key: 'edge', x: 511, y: -1, width: 514, height: 514, zoom: 1 }
  expect(tileOverlapsViewport(tile, { x: 0, y: 0, width: 512, height: 512 })).toBe(false)
  expect(tileViewportDistance(tile, { x: 0, y: 0, width: 512, height: 512 })).toBe(0)
  expect(tileOverlapsViewport({ ...tile, phaseX: .25 }, { x: 0, y: 0, width: 512, height: 512 })).toBe(true)
})
