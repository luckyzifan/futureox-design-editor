import { expect, test } from 'vitest'
import { tileIntersectsView, tilePlacementAtView, tilePreviewContractMatches, type TilePreviewContract } from './tile-preview'

function contract(): TilePreviewContract {
  return {
    document: {}, pageId: 'page', epoch: 7,
    view: { x: 20, y: -30, zoom: 1 }, width: 800, height: 600,
    pixelRatio: 2, grid: false, computeBackend: 'webgpu', managed: false,
    displayCapability: 'srgb/standard',
  }
}

test('completed pixels remain reusable above 100% on Retina without certifying exact zoom', () => {
  const frame = contract()
  const requested = { ...frame, view: { x: -80.25, y: 49.5, zoom: 2.4 } }
  expect(tilePreviewContractMatches(frame, requested)).toBe(true)
  const tile = { key: 'resident', x: 511, y: 1023, width: 514, height: 514, zoom: 2 }
  const placement = tilePlacementAtView(tile, requested.view)
  expect(placement.left).toBeCloseTo(532.95, 8)
  expect(placement.top).toBeCloseTo(1277.1, 8)
  expect(placement.width).toBeCloseTo(616.8, 8)
  expect(placement.height).toBeCloseTo(616.8, 8)
  // CSS reprojection consumes existing pixels; it does not rewrite the source
  // sampling scale or precision contract used by the worker.
  expect(tile.zoom).toBe(2)
  expect(frame.view.zoom).toBe(1)
})

test('camera preview rejects every cross-owner and output-contract change', () => {
  const frame = contract()
  const changes: Partial<TilePreviewContract>[] = [
    { document: {} }, { pageId: 'other' }, { epoch: 8 },
    { width: 801 }, { height: 601 }, { pixelRatio: 1 },
    { grid: true }, { pixelPreview: 1 }, { rasterProfile: 'figma' },
    { computeBackend: 'webgl2' }, { managed: true }, { displayCapability: 'p3/high' },
  ]
  for (const change of changes)
    expect(tilePreviewContractMatches(frame, { ...frame, ...change })).toBe(false)
  expect(tilePreviewContractMatches(null, frame)).toBe(false)
})

test('a distant cached coarse tile is not a visible preview, including its gutter', () => {
  const tile = { key: 'resident', x: 511, y: 511, width: 514, height: 514, zoom: 1 }
  const view = { x: 0, y: 0, zoom: 1 }
  expect(tileIntersectsView(tile, view, { width: 100, height: 100 })).toBe(false)
  expect(tileIntersectsView(tile, { ...view, x: -512, y: -512 }, { width: 100, height: 100 })).toBe(true)
  expect(tileIntersectsView(tile, { ...view, x: -412, y: -412 }, { width: 100, height: 100 })).toBe(false)
})
test('settled fractional camera places native-density tiles on device pixel boundaries', () => {
  const dpr = 1.8, view = { x: 17.123, y: -11.987, zoom: 0.7639 }
  const phase = { x: view.x * dpr - Math.floor(view.x * dpr), y: view.y * dpr - Math.floor(view.y * dpr) }
  const tile = { key: 'phase', x: 511, y: -513, width: 514, height: 514, zoom: view.zoom * dpr,
    phaseX: phase.x, phaseY: phase.y }
  const placed = tilePlacementAtView(tile, view)
  expect(placed.width * dpr).toBeCloseTo(514, 10)
  expect(placed.left * dpr).toBeCloseTo(tile.x + Math.floor(view.x * dpr), 10)
  expect(placed.top * dpr).toBeCloseTo(tile.y + Math.floor(view.y * dpr), 10)
})
