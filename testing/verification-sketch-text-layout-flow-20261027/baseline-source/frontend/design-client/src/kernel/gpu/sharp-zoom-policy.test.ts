import { expect, test } from 'vitest'
import { createRenderPolicy } from '../render-policy'
import { displayTileBudget } from '../tile-cache'
import { sharpZoomScale, usesSharpZoom } from './sharp-zoom-policy'

const view = (zoom: number) => ({ x: 12.125, y: -19.375, zoom })
const desktop = createRenderPolicy(false, false, false, false, true, true)

test('sharp navigation requires the desktop display tier and resident SDR presentation', () => {
  expect(usesSharpZoom(desktop, { resident: true })).toBe(true)
  for (const policy of [createRenderPolicy(false), { ...desktop, desktopDisplay: false },
    { ...desktop, cpuOnly: true }, { ...desktop, hdrCompositing: true }])
    expect(usesSharpZoom(policy, { resident: true })).toBe(false)
  for (const request of [{ resident: false }, { resident: true, pixelPreview: 1 },
    { resident: true, pixelPreview: 2 }, { resident: true, grid: true }, { resident: true, checkerboard: true }])
    expect(usesSharpZoom(desktop, request)).toBe(false)
  expect(usesSharpZoom(desktop, { resident: true, pixelPreview: 0, grid: false, checkerboard: false })).toBe(true)
})

test('eighth-octave requests never reduce density, including low zoom and fractional DPR', () => {
  for (const zoom of [.001, .025, .0625, .249, .51, 1.001, 1.05, 2.73, 8.01, 31.9, 32])
    for (const dpr of [.75, 1, 1.25, 1.5, 2, 3]) {
      const requested = zoom * dpr, actual = sharpZoomScale(view(zoom), dpr, 640, 480)
      expect(actual).toBeGreaterThanOrEqual(requested)
      expect(actual / requested).toBeLessThanOrEqual(2 ** (1 / 8) + Number.EPSILON * 2)
      expect((actual / requested) ** 2).toBeLessThan(1.19)
    }
})

test('nearby inputs share one ceiling bucket and exact powers and eighth-octaves stay unchanged', () => {
  expect(sharpZoomScale(view(.51), 2, 640, 480)).toBe(2 ** (1 / 8))
  expect(sharpZoomScale(view(.54), 2, 640, 480)).toBe(2 ** (1 / 8))
  for (let bucket = -48; bucket <= 56; bucket++) {
    const requested = 2 ** (bucket / 8)
    expect(sharpZoomScale(view(requested / 2), 2, 640, 480)).toBe(requested)
  }
  expect(sharpZoomScale(view(1 + Number.EPSILON), 1, 640, 480)).toBe(2 ** (1 / 8))
  expect(sharpZoomScale(view(1 - Number.EPSILON / 2), 1, 640, 480)).toBe(1)
})

test.each([
  { width: 3840, height: 2160, hdr: false },
  { width: 1920, height: 1080, hdr: true },
])('failed $hdr display headroom admission retains the original DPR', ({ width, height, hdr }) => {
  const camera = view(1.01), dpr = 2, requested = camera.zoom * dpr
  const ahead = 2 ** (Math.ceil(Math.log2(requested) * 8) / 8)
  expect(() => displayTileBudget(width, height, dpr, hdr)).not.toThrow()
  expect(() => displayTileBudget(width, height, ahead / camera.zoom, hdr)).toThrow()
  expect(sharpZoomScale(camera, dpr, width, height, { hdr })).toBe(requested)
  // Even an unsupported original viewport is not silently resampled downward.
  expect(sharpZoomScale(camera, dpr, width * 10, height * 10, { hdr })).toBe(requested)
})

test('disabled headroom and the native scale ceiling preserve the exact requested scale', () => {
  for (const zoom of [.025, .513, 1.01, 32, 64, 65, 100])
    expect(sharpZoomScale(view(zoom), 2, 640, 480, { headroom: false })).toBe(zoom * 2)
  expect(sharpZoomScale(view(64), 2, 640, 480)).toBe(128)
  expect(sharpZoomScale(view(65), 2, 640, 480)).toBe(130)
  expect(sharpZoomScale(view(1.01), 2, 640, 480, { maxScale: 2.1 })).toBe(2.02)
  expect(sharpZoomScale(view(32), 2, 640, 480, { maxScale: 64 })).toBe(64)
})

test('translation and reversing the zoom sequence cannot retain an oversized old density', () => {
  const sequence = [.025, .5, 1.01, 8.1, 32, 8.1, 1.01, .5, .025]
  for (const zoom of sequence) {
    const actual = sharpZoomScale(view(zoom), 2, 640, 480)
    expect(sharpZoomScale({ x: -1e6, y: 1e6, zoom }, 2, 640, 480)).toBe(actual)
    expect(actual).toBeGreaterThanOrEqual(zoom * 2)
    expect(actual).toBeLessThanOrEqual(zoom * 2 * 2 ** (1 / 8) + Number.EPSILON)
  }
})

test('invalid density inputs fail explicitly instead of producing a lower-resolution request', () => {
  for (const zoom of [0, -1, Infinity, NaN])
    expect(() => sharpZoomScale(view(zoom), 2, 640, 480)).toThrow('Invalid sharp zoom density')
  for (const dpr of [0, -1, Infinity, NaN])
    expect(() => sharpZoomScale(view(1), dpr, 640, 480)).toThrow('Invalid sharp zoom density')
  expect(() => sharpZoomScale(view(1), 2, -1, 480)).toThrow('Invalid sharp zoom density')
  expect(() => sharpZoomScale(view(1), 2, 640, Infinity)).toThrow('Invalid sharp zoom density')
  expect(() => sharpZoomScale(view(1), 2, 640, 480, { maxScale: 0 })).toThrow('Invalid sharp zoom density')
})
