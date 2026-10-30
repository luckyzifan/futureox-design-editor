import { expect, test } from 'vitest'
import { displayFilterWeights } from './display-filter'

test('display tents conserve constant colour, have finite support and nonnegative energy', () => {
  for (const radius of [0.00001, 0.3, 1, 4.125, 18.39398384094238, 127.75, 512, 513.5, 4096, 16384]) {
    const weights = displayFilterWeights(radius)
    expect(weights.length).toBe(Math.ceil(radius) + 1)
    expect(weights.every(w => Number.isFinite(w) && w >= 0)).toBe(true)
    expect(weights[0] + 2 * weights.slice(1).reduce((sum, w) => sum + w, 0)).toBeCloseTo(1, 7)
  }
  // Integrated pixel boxes preserve small-radius energy instead of dropping
  // the blur or turning it into a point-sampled triangle.
  expect([...displayFilterWeights(0.3)]).toEqual([Math.fround(0.9), Math.fround(0.05)])
  expect(() => displayFilterWeights(Infinity)).toThrow()
  expect(() => displayFilterWeights(16385)).toThrow()
})
