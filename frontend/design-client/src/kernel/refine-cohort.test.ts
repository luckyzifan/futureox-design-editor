import { expect, test } from 'vitest'
import { leadingCoarseTiles, sourceDensePaintRequested, sourceRasterBatchLimit } from './refine-cohort'

const base = {
  enabled: true, sourceSnapshot: true, channel: 'canvas', renderIntent: 'preview' as const, tileOwner: true,
  zoom: 0.125, backend: 'webgpu', rasterProfile: 'figmaSubpixel', hdr: false, reference: false, png: false,
  readback: false, exportFormat: false, exportRegion: false, pixelPreview: false, animation: false,
  materialOverview: false, settledCohort: true,
}

test('a quiet large source uses one eight-tile cohort and motion stays small', () => {
  expect(sourceRasterBatchLimit({ overviewMode: false, optional: false, moving: false, rasterScale: 0.125, nodes: 124447, pipelineTiles: 2 })).toBe(8)
  expect(sourceRasterBatchLimit({ overviewMode: true, optional: false, moving: false, rasterScale: 1, nodes: 20, pipelineTiles: 2 })).toBe(8)
  expect(sourceRasterBatchLimit({ overviewMode: false, optional: false, moving: true, rasterScale: 0.125, nodes: 124447, pipelineTiles: 2 })).toBe(2)
  expect(sourceRasterBatchLimit({ overviewMode: false, optional: true, moving: false, rasterScale: 0.125, nodes: 124447, pipelineTiles: 2 })).toBe(2)
  expect(sourceRasterBatchLimit({ overviewMode: false, optional: false, moving: false, rasterScale: 32, nodes: 124447, pipelineTiles: 2 })).toBe(2)
  expect(sourceRasterBatchLimit({ overviewMode: false, optional: false, moving: false, rasterScale: 0.5, nodes: 2999, pipelineTiles: 2 })).toBe(2)
  expect(sourceRasterBatchLimit({ overviewMode: false, optional: false, moving: false, rasterScale: 0, nodes: 124447, pipelineTiles: 2 })).toBe(2)
})

test('dense paint stays on the overview gate and a stopped full-artboard cohort', () => {
  expect(sourceDensePaintRequested(base)).toBe(true)
  expect(sourceDensePaintRequested({ ...base, settledCohort: false, materialOverview: true })).toBe(true)
  expect(sourceDensePaintRequested({ ...base, settledCohort: false })).toBe(false)
  expect(sourceDensePaintRequested({ ...base, enabled: false })).toBe(false)
  expect(sourceDensePaintRequested({ ...base, zoom: 32 })).toBe(false)
  expect(sourceDensePaintRequested({ ...base, zoom: 1.001 })).toBe(false)
  expect(sourceDensePaintRequested({ ...base, rasterProfile: 'figma' })).toBe(false)
  expect(sourceDensePaintRequested({ ...base, hdr: true })).toBe(false)
  expect(sourceDensePaintRequested({ ...base, png: true })).toBe(false)
  expect(sourceDensePaintRequested({ ...base, readback: true })).toBe(false)
  expect(sourceDensePaintRequested({ ...base, exportFormat: true })).toBe(false)
  expect(sourceDensePaintRequested({ ...base, animation: true })).toBe(false)
  expect(sourceDensePaintRequested({ ...base, renderIntent: 'canvas' })).toBe(false)
  expect(sourceDensePaintRequested({ ...base, backend: 'webgl2' })).toBe(false)
  expect(sourceDensePaintRequested({ ...base, sourceSnapshot: false })).toBe(false)
})

test('a heavy cold view keeps only the coarse tile nearest the focal point', () => {
  const tiles = [
    { x: 0, y: 0, width: 514, height: 514, zoom: 0.25 },
    { x: 512, y: 0, width: 514, height: 514, zoom: 0.25 },
    { x: 0, y: 512, width: 514, height: 514, zoom: 0.25 },
  ]
  expect(leadingCoarseTiles(tiles, { nodes: 20082, zoom: 0.25, centerX: 2200, centerY: 200 })).toEqual([tiles[1]])
  expect(leadingCoarseTiles(tiles, { nodes: 137, zoom: 32, centerX: 100, centerY: 100 })).toEqual([tiles[0]])
  expect(leadingCoarseTiles(tiles, { nodes: 752, zoom: 1, centerX: 0, centerY: 0 })).toEqual(tiles)
  expect(leadingCoarseTiles(tiles.slice(0, 1), { nodes: 20082, zoom: 0.25, centerX: 0, centerY: 0 })).toEqual(tiles.slice(0, 1))
  expect(leadingCoarseTiles([], { nodes: 20082, zoom: 32, centerX: 0, centerY: 0 })).toEqual([])
})
