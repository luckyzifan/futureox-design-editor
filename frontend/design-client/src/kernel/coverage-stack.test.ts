import { expect, test } from 'vitest'
import { acceptTranslatedCoverage, coverageBeyondBacking, coversUnpaintedViewport, retainInFlightTile, selectCoverageStack, selectCoverageUnderlay } from './coverage-stack'
import { panStripBounds, panStripOverview, viewportExtendsPastPage } from './navigation-overview'
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

test('settle releases a covered nearby density and keeps a tile that still paints a hole', () => {
  const resident = tile('native', 1, 0, 0, 256)
  const nearby = tile('nearby', 1, 0, 0, 200)
  const edge = tile('edge', 1, 400, 0, 256)
  expect(retainInFlightTile(nearby, view, size, [resident], new Set(), new Set(), false, 1)).toBe(true)
  expect(retainInFlightTile(nearby, view, size, [resident], new Set(), new Set(), false, 1, true)).toBe(false)
  expect(retainInFlightTile(edge, view, size, [resident], new Set(), new Set(), false, 1, true)).toBe(true)
})

test('a nearby density stays in flight when the cache already paints it, including an inexact return', () => {
  const resident = tile('native', 1, 0, 0, 1024)
  const nearby = tile('nearby', 2, 0, 0, 256)
  expect(retainInFlightTile(nearby, view, size, [resident], new Set(), new Set(), false, 1)).toBe(true)
  expect(retainInFlightTile({ ...nearby, prefetch: true }, view, size, [resident], new Set(), new Set(), false, 1)).toBe(false)
})

test('a pan past the displayed bitmap keeps the coarse tile that paints the new strip', () => {
  const previous = { view: { x: 0, y: 0, zoom: 1 }, width: 800, height: 600 }
  const panned = { x: -120, y: 0, zoom: 1 }
  const sharp = tile('sharp', 4, 0, 0, 128)
  const coarse = tile('coarse', 0.5, 0, 0)
  expect(coverageBeyondBacking([sharp], panned, size, previous)).toBeUndefined()
  const stack = coverageBeyondBacking([sharp, coarse], panned, size, previous)
  expect(stack?.map(item => item.key)).toContain('coarse')
  expect(coverageBeyondBacking([sharp, coarse], { x: 0, y: 0, zoom: 4 }, size, previous)).toBeUndefined()
})

test('an 8% pasteboard pan reuses one coarse page tile that covers the new strip', () => {
  const page = { x: 0, y: 0, width: 1912, height: 1062 }
  const size = { width: 1000, height: 700 }
  const view = { x: 460, y: 300, zoom: 0.08 }
  expect(viewportExtendsPastPage(page, view, size)).toBe(true)
  const bounds = panStripBounds(view, size, page)
  expect(bounds).toBeTruthy()
  const panned = { ...view, x: view.x - 250 }
  expect(panStripBounds(panned, size, page)).toEqual(bounds)
  const overview = panStripOverview(page, view, size)
  expect(overview?.tiles).toHaveLength(1)
  const tile = overview!.tiles[0]
  expect(tile.width).toBeLessThanOrEqual(514)
  expect(tile.height).toBeLessThanOrEqual(514)
  const previous = { view, width: size.width, height: size.height }
  const stack = coverageBeyondBacking([tile], panned, size, previous)
  expect(stack?.map(item => item.key)).toEqual([tile.key])
  expect(viewportExtendsPastPage(page, { x: 0, y: 0, zoom: 1 }, { width: 800, height: 600 })).toBe(false)
})

test('a coverage frame is kept when the pan moves before its acknowledgement', () => {
  const frame = { outward: true, preview: false, idsMatch: true, tileCount: 3, shownCount: 3,
    sentZoom: 1, liveZoom: 1, samePixels: true, matchesSubmission: true }
  expect(acceptTranslatedCoverage(frame)).toBe(true)
  expect(acceptTranslatedCoverage({ ...frame, liveZoom: 2 })).toBe(false)
  expect(acceptTranslatedCoverage({ ...frame, preview: true })).toBe(false)
  expect(acceptTranslatedCoverage({ ...frame, idsMatch: true, tileCount: 2, shownCount: 2 })).toBe(true)
  expect(acceptTranslatedCoverage({ ...frame, matchesSubmission: false })).toBe(false)
  expect(acceptTranslatedCoverage({ ...frame, idsMatch: false })).toBe(false)
})

test('zoom-in still drops a large capture that does not fill a hole, and keeps a large hole filler', () => {
  const covered = tile('covered', 1, 0, 0, 1024)
  const huge = { ...tile('capture', 1, 0, 0, 2048), width: 2048, height: 2048 }
  expect(retainInFlightTile(huge, view, size, [covered], new Set(), new Set(), true, 4)).toBe(false)
  expect(retainInFlightTile(huge, view, size, [], new Set(), new Set(), true, 4)).toBe(true)
})
