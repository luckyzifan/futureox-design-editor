import { expect, test } from 'vitest'
import { continuousZoomInScale } from './continuous-zoom-scale'

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
