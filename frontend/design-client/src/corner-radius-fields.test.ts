import { expect, test } from 'vitest'
import { radiiAreUniform, uniformRadii } from './corner-radius-fields'
test('a uniform corner radius writes all four corners and mixed radii stay independent', () => {
  expect(uniformRadii(12)).toEqual([12, 12, 12, 12])
  expect(radiiAreUniform([6, 6, 6, 6])).toBe(true)
  expect(radiiAreUniform([6, 6, 8, 6])).toBe(false)
  expect(radiiAreUniform([6, 6])).toBe(false)
})
