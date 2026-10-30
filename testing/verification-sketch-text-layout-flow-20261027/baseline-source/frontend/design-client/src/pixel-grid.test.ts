import { test, expect } from 'vitest'
import { pixelGridPathData, pixelGridVisible } from './pixel-grid'

test('visibility follows the Figma 400% threshold', () => {
  expect(pixelGridVisible(3.99)).toBe(false)
  expect(pixelGridVisible(4)).toBe(true)
  expect(pixelGridVisible(16)).toBe(true)
  expect(pixelGridVisible(Number.NaN)).toBe(false)
  expect(pixelGridPathData({ x: 0, y: 0, zoom: 3.5 }, 800, 600, true)).toBe('')
  expect(pixelGridPathData({ x: 0, y: 0, zoom: 8 }, 800, 600, false)).toBe('')
})

test('lines sit on world integers for any camera phase', () => {
  const view = { x: -123.75, y: 200.25, zoom: 6 }
  const data = pixelGridPathData(view, 1200, 900, true)
  // Viewport spans world x ∈ [20.625, 220.625), y ∈ [-33.375, 116.625):
  // verticals 21..220, horizontals -33..116.
  const verticals = [...data.matchAll(/M(-?[\d.]+),(-?[\d.]+)V/g)].map((m) => Number(m[1]))
  expect(verticals[0]).toBe(21)
  expect(verticals.at(-1)).toBe(220)
  expect(verticals.every((x) => Number.isInteger(x))).toBe(true)
  const horizontals = [...data.matchAll(/M(-?[\d.]+),(-?[\d.]+)H/g)].map((m) => Number(m[2]))
  expect(horizontals[0]).toBe(-33)
  expect(horizontals.at(-1)).toBe(116)
  expect(horizontals.every((y) => Number.isInteger(y))).toBe(true)
  // Each vertical spans the full viewport world band.
  expect(data).toContain('M21,-33.375V116.625')
})

test('segment caps bound pathological viewports', () => {
  // A degenerate 1e9 px viewport must not build an unbounded path.
  const data = pixelGridPathData({ x: 0, y: 0, zoom: 4 }, 1e9, 1e9, true)
  expect(data.match(/M/g)!.length).toBeLessThanOrEqual(8192)
  expect(data.length).toBeLessThan(1 << 20)
})
