import { expect, test } from 'vitest'
import { sharperCoverageFrame } from './coverage-stack'
import { continuousZoomInScale, continuousZoomReplacementScale, zoomInLatticeCore, zoomInSampleZoom } from './continuous-zoom-scale'
import { materialTiles } from './source-display-band'
import { MAX_PREVIEW_SCALE_RATIO } from './tile-preview'
import { tilesCoverBounds, type RasterTile } from './tile-cache'

test('a continuous zoom-in does not keep a lattice coarser than half the camera', () => {
  // Visible density 1, camera native 16. The previous rung floor was native/4
  // (4). Half native is 8, which is the preview-ratio boundary.
  expect(continuousZoomInScale(1, 16, 16, 0)).toBe(8)
  expect(continuousZoomInScale(1, 16, 16, 8)).toBe(8)
  expect(continuousZoomInScale(1, 32, 32, 8)).toBe(16)
  expect(continuousZoomInScale(1, 16, 16, 4)).toBe(8)
})

test('a small wheel step keeps the lattice that is already inside the preview ratio', () => {
  const first = continuousZoomInScale(0.5, 0.9, 0.9, 0)
  expect(first).toBeCloseTo(2 ** -0.5)
  expect(continuousZoomInScale(0.5, 1.12, 1.12, first)).toBe(first)
  expect(continuousZoomInScale(first, 1.16, 1.16, first)).toBeGreaterThan(first)
})

test('invalid continuous-zoom inputs keep the caller motion scale', () => {
  expect(continuousZoomInScale(0, 16, 9, 0)).toBe(9)
  expect(continuousZoomInScale(16, 16, 9, 4)).toBe(9)
  expect(continuousZoomInScale(Number.NaN, 16, 9, 4)).toBe(9)
})

test('a fit bitmap stretched to 394% is replaced inside the preview ratio by a bounded core', () => {
  const displayed = 0.403
  const requested = 3.942
  const dpr = 2
  const native = requested * dpr
  // The old refinement target is the full native lattice. Its ratio to the
  // fit sample is the severe stretch that stays up until that lattice lands.
  expect(requested / displayed).toBeGreaterThan(MAX_PREVIEW_SCALE_RATIO)
  expect(native / (displayed * dpr)).toBeGreaterThan(MAX_PREVIEW_SCALE_RATIO)
  const plan = continuousZoomReplacementScale(displayed, requested, dpr)
  expect(plan).toEqual({ scale: 4, core: 160 })
  expect(native / plan!.scale).toBeLessThanOrEqual(MAX_PREVIEW_SCALE_RATIO)
  expect(plan!.scale).toBeLessThan(native)
  expect(zoomInLatticeCore(plan!.scale, native)).toBe(160)
  const bounds = { x: 0, y: 0, width: 855 / requested, height: 836 / requested }
  const tiles = materialTiles(bounds, plan!.scale, { x: 0, y: 0 }, plan!.core!)
  expect(tiles).toBeTruthy()
  expect(tiles!.length).toBeGreaterThan(1)
  expect(tiles!.every(tile => tile.width <= 162 && tile.height <= 162)).toBe(true)
  expect(tiles![0].width * tiles![0].height).toBeLessThan(514 * 514 / 4)
  expect(tilesCoverBounds(tiles!, bounds, plan!.scale)).toBe(true)
  const fit: RasterTile = {
    key: 'fit', x: -1, y: -1, gutter: 1, zoom: displayed * dpr,
    width: Math.ceil(bounds.width * displayed * dpr) + 2,
    height: Math.ceil(bounds.height * displayed * dpr) + 2,
  }
  const ready = tiles![0]
  const frame = sharperCoverageFrame([fit, ready], [fit], { x: 0, y: 0, zoom: requested }, { width: 855, height: 836 })
  expect(frame?.some(tile => tile.key === ready.key)).toBe(true)
  expect(tilesCoverBounds(frame!, bounds)).toBe(true)
  expect((requested * dpr) / ready.zoom).toBeLessThanOrEqual(MAX_PREVIEW_SCALE_RATIO)
})

test('a caught-up camera still replaces the fit texels it is showing', () => {
  const dpr = 2
  const caughtUp = zoomInSampleZoom(3.942, dpr, [0.403 * dpr, 4])
  expect(caughtUp).toBeCloseTo(0.403)
  expect(continuousZoomReplacementScale(caughtUp, 3.942, dpr)).toEqual({ scale: 4, core: 160 })
  const replaced = zoomInSampleZoom(3.942, dpr, [4])
  expect(replaced).toBe(2)
  expect(continuousZoomReplacementScale(replaced, 3.942, dpr)).toBeUndefined()
  expect(zoomInSampleZoom(0.403, dpr, [])).toBe(0.403)
})

test('a zoom already inside the preview ratio, and a 3200% jump, do not take the bounded core', () => {
  expect(continuousZoomReplacementScale(1, 1.8, 2)).toBeUndefined()
  expect(continuousZoomReplacementScale(3.942, 0.88, 2)).toBeUndefined()
  expect(continuousZoomReplacementScale(0, 4, 2)).toBeUndefined()
  const high = continuousZoomReplacementScale(1, 16, 2)
  expect(high?.scale).toBe(16)
  expect(high?.core).toBeUndefined()
  expect(32 / high!.scale).toBeLessThanOrEqual(MAX_PREVIEW_SCALE_RATIO)
  expect(zoomInLatticeCore(32, 64)).toBeUndefined()
  expect(zoomInLatticeCore(4, 8)).toBeUndefined()
})
