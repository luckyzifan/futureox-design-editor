import { expect, test } from 'vitest'
import { acceptTranslatedCoverage, retainInFlightTile } from './coverage-stack'
import type { RasterTile } from './tile-cache'

const view = { x: 0, y: 0, zoom: 1 }
const size = { width: 800, height: 600 }
const tile = (key: string, zoom: number, x: number, y: number, span = 512): RasterTile => ({
  key, x: x * zoom - 1, y: y * zoom - 1, width: span + 2, height: span + 2, zoom, gutter: 1,
})

test('a reversed pan yields a covered same-density neighbour and keeps a hole or finer detail', () => {
  const resident = tile('native', 1, 0, 0, 256)
  const covered = tile('covered', 1, 0, 0, 200)
  const edge = tile('edge', 1, 400, 0, 256)
  const finer = tile('finer', 2, 0, 0, 256)
  const wanted = new Set(['wanted'])
  expect(retainInFlightTile(covered, view, size, [resident], new Set(), new Set(), false, 1)).toBe(true)
  expect(retainInFlightTile(covered, view, size, [resident], new Set(), new Set(), false, 1, false, true)).toBe(false)
  expect(retainInFlightTile({ ...covered, key: 'wanted' }, view, size, [resident], wanted, new Set(), false, 1, false, true)).toBe(true)
  expect(retainInFlightTile(edge, view, size, [resident], new Set(), new Set(), false, 1, false, true)).toBe(true)
  expect(retainInFlightTile(finer, view, size, [resident], new Set(), new Set(), false, 1, false, true)).toBe(true)
})

test('a late frame from the abandoned pan cannot replace a closer displayed camera', () => {
  const frame = { outward: true, preview: false, idsMatch: true, tileCount: 2, shownCount: 2,
    sentZoom: 1, liveZoom: 1, samePixels: true, matchesSubmission: true }
  const cameras = {
    displayed: { x: 0, y: 0, zoom: 1 },
    sent: { x: -400, y: 0, zoom: 1 },
    live: { x: -40, y: 0, zoom: 1 },
  }
  expect(acceptTranslatedCoverage({ ...frame, cameras })).toBe(false)
  expect(acceptTranslatedCoverage({ ...frame, cameras: { ...cameras, live: { x: -520, y: 0, zoom: 1 } } })).toBe(true)
  expect(acceptTranslatedCoverage({ ...frame, cameras: { ...cameras, displayed: { x: -400, y: 0, zoom: 1 }, live: { x: -400, y: 0, zoom: 1 } } })).toBe(true)
  expect(acceptTranslatedCoverage({ ...frame, cameras: { ...cameras, sent: { ...cameras.sent, zoom: 2 } } })).toBe(true)
  expect(acceptTranslatedCoverage(frame)).toBe(true)
})
