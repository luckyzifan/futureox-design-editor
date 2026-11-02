import { expect, test } from 'vitest'
import { cpuDisplayPressure, cpuTileFrameOptions, solidDisplayTile } from './cpu-tile-frame'

test('cpu tile camera shifts the gpu viewport origin to device zero', () => {
  const frame = cpuTileFrameOptions(
    { pageId: 'p', width: 1600, height: 900, view: { x: 10.4, y: -3.2, zoom: 0.5 }, rasterProfile: 'analytic', grid: false },
    { x: 511, y: -1, width: 514, height: 514, zoom: 0.5 },
  )
  expect(frame.width).toBe(514)
  expect(frame.height).toBe(514)
  expect(frame.view).toEqual({ x: 10.4 - (511 + 10), y: -3.2 - (-1 + -4), zoom: 0.5 })
  expect(frame.gpuViewport).toBeUndefined()
  expect(frame.pageId).toBe('p')
  expect(frame.rasterProfile).toBe('analytic')
})

test('pressure errors are the only cpu tile failures that stay on screen', () => {
  expect(cpuDisplayPressure(Error('Compositing memory budget exceeded'))).toBe(true)
  expect(cpuDisplayPressure(Error('Layer surface exceeds 16 million pixels'))).toBe(true)
  expect(cpuDisplayPressure('Gaussian sigma must be in 0..1')).toBe(true)
  expect(cpuDisplayPressure(Error('Page not found'))).toBe(false)
  const solid = solidDisplayTile(2, 1, [255, 255, 255, 255])
  expect(solid).toEqual(new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255]))
})
