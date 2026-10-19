import { describe, it, expect, test } from 'vitest'
import { GpuRenderer, mipLevelsFor } from '../kernel/gpu/renderer'
import { imageResourceRegressions } from '../kernel/gpu/renderer-regression-cases'

imageResourceRegressions(test, GpuRenderer)

describe('geometric mip-chain dimensions', () => {
  it.each([
    [[1, 1], 1], [[2, 2], 2], [[4, 4], 3], [[7, 3], 4],
    [[1024, 512], 11], [[1024, 1], 11], [[4096, 4096], 13],
  ] as [[number, number], number][])('counts %j without inferring perceptual fidelity', (dims, expected) => {
    expect(mipLevelsFor(dims)).toBe(expected)
  })
})
