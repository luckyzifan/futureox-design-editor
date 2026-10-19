import { test, expect } from 'vitest'
import { frameCovers, frameTransform, previewPixelBudget, surfaceMetrics, presentationMatches } from './presentation'
import { worldToScreen } from '../canvas-camera'

test('checkerboard toggle invalidates a completed presentation without changing the document', () => {
  const frame = { document: {}, pageId: 'p', epoch: 1, width: 64, height: 64,
    pixelRatio: 2, view: { x: 0.25, y: 0.5, zoom: 1 } }
  expect(presentationMatches(frame, { ...frame, checkerboard: false })).toBe(true)
  expect(presentationMatches(frame, { ...frame, checkerboard: true })).toBe(false)
})

test('reprojected frame pixels and live selection coordinates agree throughout pan and zoom', () => {
  const frame = { x: 240, y: 180, zoom: 0.75 }
  for (const view of [
    { x: -20, y: 50, zoom: 0.75 },
    { x: 60, y: -30, zoom: 2 },
    { x: 100, y: 70, zoom: 0.25 },
  ]) {
    const t = frameTransform(view, frame)
    for (const p of [
      { x: -180, y: 45 },
      { x: 1250, y: 800 },
    ]) {
      const old = worldToScreen(frame, p),
        current = worldToScreen(view, p)
      expect(old.x * t.scale + t.x).toBeCloseTo(current.x, 10)
      expect(old.y * t.scale + t.y).toBeCloseTo(current.y, 10)
    }
  }
})

test('render margin covers nearby panning and requests work before its edge is exposed', () => {
  const frame = { x: 192, y: 192, zoom: 1 },
    rendered = { width: 1328, height: 1158 },
    viewport = { width: 944, height: 774 }
  expect(frameCovers({ x: 80, y: -60, zoom: 1 }, frame, rendered, viewport, 96)).toBe(true)
  expect(frameCovers({ x: 150, y: 0, zoom: 1 }, frame, rendered, viewport, 96)).toBe(false)
  expect(frameCovers({ x: 150, y: 0, zoom: 1 }, frame, rendered, viewport)).toBe(true)
})

test('measured float scene memory limits Retina refinement despite an SDR document', () => {
  const budget = previewPixelBudget(944 * 774, 6589345, true, 4_000_000)
  expect(budget).toBeGreaterThan(944 * 774)
  expect(budget).toBeLessThan(944 * 774 * 1.5 ** 2)
})
test('fractional layout never introduces a second scale between raster and editing overlay', () => {
  for (const [w, h] of [
    [780.5, 631.375],
    [375.328125, 610.125],
    [1000, 700],
  ])
    for (const quality of [1, 1.25, 1.5, 2]) {
      const m = surfaceMetrics(w, h, quality)
      for (const x of [0, 0.5, 10.125, w - 1]) {
        const pixel = x * m.ratio,
          displayed = (pixel / m.pixelWidth) * m.cssWidth
        expect(Math.abs(displayed - x)).toBeLessThan(1e-10)
      }
      expect(m.cssWidth).toBeGreaterThanOrEqual(w)
      expect(m.cssHeight).toBeGreaterThanOrEqual(h)
      expect(m.cssWidth - w).toBeLessThan(1 / m.ratio)
    }
})
test('large viewport pixel budgets retain the same camera scale in both axes', () => {
  const m = surfaceMetrics(4000.375, 2000.125, 2)
  expect(m.ratio).toBeLessThan(1)
  expect(m.pixelWidth / m.cssWidth).toBe(m.pixelHeight / m.cssHeight)
})
test('Figma high-DPI GPU output keeps its doubled source inside native viewport limits', () => {
  for (const [width, height] of [
    [944, 770],
    [4000.375, 2000.125],
    [8000, 900],
  ]) {
    const m = surfaceMetrics(width, height, 2, { maxPixels: 2_000_000, maxDimension: 4096 })
    expect(m.pixelWidth * 2).toBeLessThanOrEqual(8192)
    expect(m.pixelHeight * 2).toBeLessThanOrEqual(8192)
    expect(m.pixelWidth * m.pixelHeight * 4).toBeLessThanOrEqual(8_388_608)
    expect(m.pixelWidth / m.cssWidth).toBe(m.pixelHeight / m.cssHeight)
  }
})
test('managed Figma preview leaves memory for four float sampling planes', () => {
  const m = surfaceMetrics(944, 770, 2, { maxPixels: 500_000, maxDimension: 4096 })
  const bytesPerPlane = m.pixelWidth * m.pixelHeight * 4 * 16
  expect(bytesPerPlane * 4).toBeLessThan(128 * 1024 * 1024)
  expect(m.pixelWidth * m.pixelHeight * 4).toBeLessThan(8_388_608)
})
test('the former rounded canvas display could drift by nearly half a pixel', () => {
  const w = 780.51,
    x = 780,
    rounded = Math.round(w)
  expect(Math.abs((x * w) / rounded - x)).toBeGreaterThan(0.48)
  const m = surfaceMetrics(w, 630.4, 1)
  expect(((x * m.ratio) / m.pixelWidth) * m.cssWidth).toBeCloseTo(x, 12)
})
