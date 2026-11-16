import { expect, test } from 'vitest'
import { zoomFocusCaptureRegions } from './zoom-focus-capture'

test('a settled zoom-focus viewport is one native-density capture', () => {
  const region = zoomFocusCaptureRegions(10, 20, 1938, 1816, false)
  expect(region).toEqual([{ x: 10, y: 20, width: 1938, height: 1816 }])
  expect(region[0].width * region[0].height).toBeLessThanOrEqual(4_194_304)
})

test('the budget fallback keeps the previous four-cell grid and full coverage', () => {
  const regions = zoomFocusCaptureRegions(10, 20, 1938, 1816, true)
  expect(regions).toHaveLength(4)
  const area = regions.reduce((sum, region) => sum + region.width * region.height, 0)
  expect(area).toBe(1938 * 1816)
  expect(regions[0]).toMatchObject({ x: 10, y: 20 })
  const right = Math.max(...regions.map(region => region.x + region.width))
  const bottom = Math.max(...regions.map(region => region.y + region.height))
  expect(right).toBe(10 + 1938)
  expect(bottom).toBe(20 + 1816)
})

test('a viewport of at most 524288 pixels stays one cell even as a fallback', () => {
  expect(zoomFocusCaptureRegions(0, 0, 512, 512, true)).toEqual([{ x: 0, y: 0, width: 512, height: 512 }])
})
