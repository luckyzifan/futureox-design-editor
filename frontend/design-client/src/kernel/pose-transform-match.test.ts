import { expect, test } from 'vitest'
import { poseTransformMatches } from './pose-transform-match'

test('a released rotation matches the shown matrix within a rounding ulp', () => {
  const shown = [0, 1, -1, 0, 24, 24]
  expect(poseTransformMatches(shown, [0, 1, -1, 0, 24, 24 + 1e-12])).toBe(true)
  expect(poseTransformMatches(shown, [0, 1, -1, 0, 24, 30])).toBe(false)
  expect(poseTransformMatches(shown, [0, 1, -1, 0, 24])).toBe(false)
  expect(poseTransformMatches(undefined, shown)).toBe(false)
  expect(poseTransformMatches([Number.NaN, 1, -1, 0, 0, 0], [Number.NaN, 1, -1, 0, 0, 0])).toBe(true)
})
