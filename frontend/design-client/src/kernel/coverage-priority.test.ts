import { expect, test } from 'vitest'
import { prioritizeUncoveredTiles } from './coverage-priority'
import { planTiles } from './tile-cache'

test('uncovered viewport tiles precede covered centre refinement at native density', () => {
  const viewport = { x: 0, y: 0, width: 1536, height: 512 }
  const tiles = planTiles(viewport, 1)
  const centre = planTiles({ x: 512, y: 0, width: 512, height: 512 }, 1)[0]
  const ordered = prioritizeUncoveredTiles(tiles, [centre], viewport)
  expect(ordered.at(-1)?.key).toBe(centre.key)
  expect(ordered.slice(0, -1)).toEqual(tiles.filter(tile => tile.key !== centre.key))
  expect(ordered.every(tile => tile.zoom === 1)).toBe(true)
})

test('a full lower-density layer preserves normal distance priority', () => {
  const viewport = { x: -10, y: -20, width: 1536, height: 512 }
  const tiles = planTiles(viewport, 2)
  expect(prioritizeUncoveredTiles(tiles, planTiles(viewport, .25), viewport)).toBe(tiles)
  expect(prioritizeUncoveredTiles(tiles, [], viewport)).toBe(tiles)
})
