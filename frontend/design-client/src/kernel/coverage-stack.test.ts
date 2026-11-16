import { expect, test } from 'vitest'
import { acceptTranslatedCoverage, coverageBeyondBacking, coversUnpaintedViewport, dominantUpscale, releaseInFlightForDemand, retainInFlightTile, selectCoverageStack, selectCoverageUnderlay, selectSharperCoverage, sharperCoverageFrame } from './coverage-stack'
import { MAX_PREVIEW_SCALE_RATIO } from './tile-preview'
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

test('a low-zoom fit keeps the only finer bitmap and drops it once a closer tile covers the view', () => {
  const fitted = { x: 0, y: 0, zoom: 0.15 }
  const fittedSize = { width: 800, height: 600 }
  const only = tile('page', 1, 0, 0, 5400)
  expect(selectCoverageUnderlay([only], fitted, fittedSize, [])).toEqual([only])
  expect(selectCoverageStack([only], fitted, fittedSize)?.map(item => item.key)).toEqual(['page'])
  const closer = tile('fit', 0.2, 0, 0, 1200)
  expect(selectCoverageUnderlay([only, closer], fitted, fittedSize, []).map(item => item.key)).toEqual(['fit'])
  expect(selectCoverageUnderlay([only], fitted, fittedSize, [closer])).toEqual([])
})

test('a bitmap more than 2× finer is not published as the covering underlay', () => {
  const fine = tile('fine', 8, 0, 0, 4096)
  expect(selectCoverageUnderlay([fine], view, size, [tile('native', 1, 0, 0, 1024)])).toEqual([])
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

test('a continuous zoom-in replaces a stretched backing where a twice-finer tile is ready', () => {
  const view = { x: 0, y: 0, zoom: 8 }
  const backing = tile('backing', 1, 0, 0, 800)
  const ready = tile('ready', 4, 0, 0, 800)
  const twice = tile('twice', 2, 0, 0, 800)
  const near = tile('near', 1.5, 0, 0, 800)
  expect(selectSharperCoverage([ready, near], view, size, [])).toEqual([])
  expect(selectSharperCoverage([ready, near], view, size, [backing]).map(item => item.key)).toEqual(['ready'])
  expect(selectSharperCoverage([twice], { x: 0, y: 0, zoom: 4 }, size, [backing]).map(item => item.key)).toEqual(['twice'])
  const frame = sharperCoverageFrame([backing, ready, near], [backing], view, size)
  expect(frame?.map(item => item.key)).toEqual(['backing', 'ready'])
  expect(dominantUpscale(frame!, view, size)).toBeLessThanOrEqual(MAX_PREVIEW_SCALE_RATIO)
  expect(dominantUpscale([backing], view, size)).toBe(8)
  expect(sharperCoverageFrame([ready], [backing], view, size)).toBeUndefined()
})

test('screen-density detail can replace a preview during a small zoom-in step', () => {
  const view = { x: 0, y: 0, zoom: 1.2 }
  const display = { ...size, dpr: 2 }
  const backing = tile('backing', 2, 0, 0, 2048)
  const intermediate = tile('intermediate', 2.2, 0, 0, 512)
  const detail = tile('detail', 2.4, 0, 0, 512)
  expect(selectSharperCoverage([intermediate, detail], view, display, [backing])).toEqual([detail])
  expect(selectSharperCoverage([detail], view, display, [backing, { ...detail, key: 'ready' }])).toEqual([])
})

test('a slightly late native tile can replace a visibly stretched backing during zoom-in', () => {
  const camera = { x: 0, y: 0, zoom: 1.45 }
  const display = { ...size, dpr: 2 }
  const backing = tile('backing', 2, 0, 0, 2048)
  const late = tile('late-native', 2.6, 0, 0, 512)
  const stale = tile('stale', 2.2, 220, 0, 512)

  expect(selectSharperCoverage([late, stale], camera, display, [backing])).toEqual([late])
  expect(selectSharperCoverage([late], camera, display, [backing, { ...late, key: 'shown' }])).toEqual([])
  expect(selectSharperCoverage([late], camera, size, [backing])).toEqual([])
})

test('zooming out from 3200% keeps the crop and fills the new viewport from a cached coarse page', () => {
  const low = { x: 0, y: 0, zoom: 1 }
  const crop = tile('crop', 32, 0, 0, 64)
  const page = tile('page', 0.05, 0, 0, 4000)
  expect(selectCoverageUnderlay([page], low, size, [])).toEqual([])
  expect(selectCoverageUnderlay([page], low, size, [crop])).toEqual([])
  expect(selectCoverageUnderlay([page], low, size, [crop], 24, true).map(item => item.key)).toEqual(['page'])
  expect(selectCoverageStack([crop, page], low, size, 48, true)?.map(item => item.key).sort()).toEqual(['crop', 'page'])
  const previous = { view: { x: 0, y: 0, zoom: 32 }, width: size.width, height: size.height }
  expect(coverageBeyondBacking([crop, page], low, size, previous, 48, true)?.map(item => item.key).sort()).toEqual(['crop', 'page'])
  expect(coverageBeyondBacking([crop], low, size, previous, 48, true)).toBeUndefined()
})

test('a wide capture yields to the ordinary lattice, and a far zoom yields while that lattice is missing', () => {
  const keys = new Set(['low'])
  const ordinary = [{ width: 514, height: 514 }]
  const wide = { key: 'band', width: 962, height: 962, zoom: 64 }
  expect(releaseInFlightForDemand(wide, { scale: 64, keys, tiles: ordinary, missing: true })).toBe(true)
  expect(releaseInFlightForDemand({ ...wide, key: 'low' }, { scale: 64, keys: new Set(['low']), tiles: ordinary, missing: true })).toBe(false)
  expect(releaseInFlightForDemand({ key: 'fine', width: 514, height: 514, zoom: 64 }, {
    scale: 0.5, keys, tiles: ordinary, missing: true,
  })).toBe(true)
  expect(releaseInFlightForDemand({ key: 'near', width: 514, height: 514, zoom: 4 }, {
    scale: 0.5, keys, tiles: ordinary, missing: true,
  })).toBe(false)
  expect(releaseInFlightForDemand(wide, { scale: 64, keys, tiles: [{ width: 962, height: 962 }], missing: true })).toBe(false)
  expect(releaseInFlightForDemand({ key: 'fine', width: 514, height: 514, zoom: 64 }, {
    scale: 0.5, keys, tiles: ordinary, missing: false,
  })).toBe(false)
})

test('zoom-in still drops a large capture that does not fill a hole, and keeps a large hole filler', () => {
  const covered = tile('covered', 1, 0, 0, 1024)
  const huge = { ...tile('capture', 1, 0, 0, 2048), width: 2048, height: 2048 }
  expect(retainInFlightTile(huge, view, size, [covered], new Set(), new Set(), true, 4)).toBe(false)
  expect(retainInFlightTile(huge, view, size, [], new Set(), new Set(), true, 4)).toBe(true)
})
