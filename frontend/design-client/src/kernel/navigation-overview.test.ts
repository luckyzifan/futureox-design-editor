import { expect, test } from 'vitest'
import { coarsePanCoverNeeded, retainPannedTile } from './navigation-overview'

const base = {
  firstNative: false, hasStrip: true, stripCached: false, pasteboard: false, cpuOnly: false,
  translated: false, moving: true, continuousZoom: true, translationFollow: false, residentsCover: false,
}

test('pasteboard still asks for the coarse strip when the camera is quiet', () => {
  expect(coarsePanCoverNeeded({ ...base, pasteboard: true, moving: false, continuousZoom: false })).toBe(true)
  expect(coarsePanCoverNeeded({ ...base, pasteboard: true, moving: true, continuousZoom: true })).toBe(false)
  expect(coarsePanCoverNeeded({ ...base, pasteboard: true, translated: true })).toBe(true)
})

test('a pan that leaves resident pictures asks for the strip before the old refine', () => {
  expect(coarsePanCoverNeeded({ ...base, translationFollow: true, residentsCover: false })).toBe(true)
  expect(coarsePanCoverNeeded({ ...base, translationFollow: true, residentsCover: true })).toBe(false)
  expect(coarsePanCoverNeeded({ ...base, translationFollow: false })).toBe(false)
  expect(coarsePanCoverNeeded({ ...base, translationFollow: true, firstNative: true })).toBe(false)
  expect(coarsePanCoverNeeded({ ...base, translationFollow: true, stripCached: true })).toBe(false)
})

test('a large pan yields a viewport tile that only clips the edge, and keeps a cell that is still on screen', () => {
  const size = { width: 1000, height: 800 }
  const view = { x: -600, y: 0, zoom: 1 }
  const shifted = { x: 0, y: 0, width: 1000, height: 800, zoom: 1, gutter: 0 }
  expect(retainPannedTile(shifted, view, size)).toBe(false)
  const cell = { x: 600, y: 0, width: 200, height: 200, zoom: 1, gutter: 0 }
  expect(retainPannedTile(cell, view, size)).toBe(true)
  const page = { x: 0, y: 0, width: 4000, height: 3000, zoom: 1, gutter: 0 }
  expect(retainPannedTile(page, { x: 0, y: 0, zoom: 1 }, size)).toBe(true)
  expect(retainPannedTile(shifted, view, size, Number.NaN)).toBe(true)
  expect(retainPannedTile({ ...shifted, zoom: 0 }, view, size)).toBe(false)
})
