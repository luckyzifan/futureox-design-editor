import { expect, test } from 'vitest'
import { coversUnpaintedViewport, retainInFlightTile, selectCoverageStack, selectCoverageUnderlay } from './coverage-stack'
import type { RasterTile } from './tile-cache'

const view = { x: 0, y: 0, zoom: 1 }
const size = { width: 800, height: 600 }
const tile = (key: string, zoom: number, x: number, y: number, span = 512): RasterTile => ({
  key, x: x * zoom - 1, y: y * zoom - 1, width: span + 2, height: span + 2, zoom, gutter: 1,
})

test('zoom-out keeps a coarse overview under the sharp crop and does not publish a hole', () => {
  const sharp = [tile('sharp-a', 4, 0, 0, 128), tile('sharp-b', 4, 128, 0, 128)]
  expect(selectCoverageStack(sharp, view, size)).toBeUndefined()
  const overview = tile('overview', 0.5, 0, 0)
  const stack = selectCoverageStack([...sharp, overview], view, size)
  expect(stack?.map(item => item.key)).toEqual(['overview', 'sharp-a', 'sharp-b'])
  expect(stack?.some(item => item.key === 'overview')).toBe(true)
  expect(stack?.some(item => item.key.startsWith('sharp'))).toBe(true)
})

test('an overview already covered by the shown frame is not stacked again', () => {
  const full = tile('full', 1, 0, 0, 1024)
  const overview = tile('overview', 0.25, 0, 0, 2048)
  expect(selectCoverageUnderlay([overview, tile('corner', 0.25, 0, 0, 64)], view, size, [full])).toEqual([])
  expect(coversUnpaintedViewport(overview, view, size, [full])).toBe(false)
})

test('a shown sharp crop still receives the overview that paints the newly exposed margin', () => {
  const crop = tile('crop', 4, 0, 0, 128)
  const overview = tile('overview', 0.5, 0, 0)
  expect(selectCoverageUnderlay([overview, crop], view, size, [crop]).map(item => item.key)).toEqual(['overview'])
})

test('a fast zoom-out keeps the in-flight tile that paints the hole and drops one the cache already paints', () => {
  const edge = tile('edge', 2, 0, 0, 1024)
  const centre = tile('centre', 8, 0, 0, 64)
  const wanted = new Set<string>()
  expect(retainInFlightTile(edge, view, size, [], wanted, new Set(), false, 0.25)).toBe(true)
  expect(retainInFlightTile(centre, view, size, [edge], wanted, new Set(), false, 0.25)).toBe(false)
})

test('a nearby density stays in flight when the cache already paints it, including an inexact return', () => {
  const resident = tile('native', 1, 0, 0, 1024)
  const nearby = tile('nearby', 2, 0, 0, 256)
  expect(retainInFlightTile(nearby, view, size, [resident], new Set(), new Set(), false, 1)).toBe(true)
  expect(retainInFlightTile({ ...nearby, prefetch: true }, view, size, [resident], new Set(), new Set(), false, 1)).toBe(false)
})

test('zoom-in still drops a large capture that does not fill a hole, and keeps a large hole filler', () => {
  const covered = tile('covered', 1, 0, 0, 1024)
  const huge = { ...tile('capture', 1, 0, 0, 2048), width: 2048, height: 2048 }
  expect(retainInFlightTile(huge, view, size, [covered], new Set(), new Set(), true, 4)).toBe(false)
  expect(retainInFlightTile(huge, view, size, [], new Set(), new Set(), true, 4)).toBe(true)
})
