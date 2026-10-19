import { expect, test } from 'vitest'
import { parseSvgViewBox, svgViewportTransform } from './import-svg-viewport'

test.each([
  ['xMinYMin meet', [-10, -20]],
  ['xMidYMin meet', [40, -20]],
  ['xMaxYMin meet', [90, -20]],
  ['xMinYMid meet', [-10, -20]],
  ['xMidYMid meet', [40, -20]],
  ['xMaxYMid meet', [90, -20]],
  ['xMinYMax meet', [-10, -20]],
  ['xMidYMax meet', [40, -20]],
  ['xMaxYMax meet', [90, -20]],
] as const)('wide SVG viewport preserves %s alignment with a nonzero viewBox origin', (align, offset) => {
  expect(svgViewportTransform([10, 20, 100, 100], 200, 100, align))
    .toEqual([1, 0, 0, 1, ...offset])
})

test.each([
  ['xMinYMin', -20], ['xMidYMid', 30], ['xMaxYMax', 80],
] as const)('tall SVG viewport preserves %s alignment', (align, y) => {
  expect(svgViewportTransform([10, 20, 100, 100], 100, 200, align))
    .toEqual([1, 0, 0, 1, -10, y])
})

test('slice covers the viewport and preserves its chosen crop anchor', () => {
  expect(svgViewportTransform([10, 20, 100, 100], 200, 100, 'xMidYMid slice'))
    .toEqual([2, 0, 0, 2, -20, -90])
  expect(svgViewportTransform([10, 20, 100, 100], 200, 100, 'xMaxYMax slice'))
    .toEqual([2, 0, 0, 2, -20, -140])
  expect(svgViewportTransform([10, 20, 100, 100], 200, 100, 'none'))
    .toEqual([2, 0, 0, 1, -20, -20])
  expect(svgViewportTransform([10, 20, 100, 100], 200, 100, null))
    .toEqual([1, 0, 0, 1, 40, -20])
})

test('invalid viewport metadata fails explicitly instead of changing the geometry', () => {
  expect(parseSvgViewBox(null)).toBeUndefined()
  expect(parseSvgViewBox('-10, 20, 100, 50')).toEqual([-10, 20, 100, 50])
  for (const value of ['', '0 0 100', '0 0 -1 100', '0 0 0 100', 'NaN 0 10 10'])
    expect(() => parseSvgViewBox(value)).toThrow(/viewBox/)
  expect(() => svgViewportTransform([0, 0, 10, 10], 20, 10, 'xUnknownYMid')).toThrow(/preserveAspectRatio/)
})
