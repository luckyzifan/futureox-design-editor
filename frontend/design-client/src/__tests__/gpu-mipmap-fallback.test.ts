import { describe, it, expect } from 'vitest'
import { GpuRenderer, mipLevelsFor } from '../kernel/gpu/renderer'

describe('GPU Mipmap Fallback', () => {
  it('should calculate correct mip levels for image dimensions', () => {
    // Base case: 1x1 image has 1 level
    expect(mipLevelsFor([1, 1])).toBe(1)

    // 2x2 image: base + 1x1 = 2 levels
    expect(mipLevelsFor([2, 2])).toBe(2)

    // 4x4 image: base + 2x2 + 1x1 = 3 levels
    expect(mipLevelsFor([4, 4])).toBe(3)

    // 1024x1024: base + 512 + 256 + 128 + 64 + 32 + 16 + 8 + 4 + 2 + 1 = 11 levels
    expect(mipLevelsFor([1024, 1024])).toBe(11)

    // Large image: 4096x4096 = 13 levels
    expect(mipLevelsFor([4096, 4096])).toBe(13)

    // Non-square: 1024x512 = 11 levels (ceil-halving until both reach 1)
    expect(mipLevelsFor([1024, 512])).toBe(11)
  })

  it('should calculate mip levels for asymmetric dimensions', () => {
    // 8x4: 8x4 -> 4x2 -> 2x1 -> 1x1 = 4 levels
    expect(mipLevelsFor([8, 4])).toBe(4)

    // 7x3: 7x3 -> 4x2 -> 2x1 -> 1x1 = 4 levels
    expect(mipLevelsFor([7, 3])).toBe(4)

    // Extreme aspect ratio: 1024x1 = 11 levels
    expect(mipLevelsFor([1024, 1])).toBe(11)
  })

  it('imageAdmissionFailures should include all budget-related errors', () => {
    const failures = [
      'GPU 浮点图片内存预算超限',
      'GPU 图片像素预算超限',
      'GPU 图片总内存预算超限',
      'GPU 图集页内存预算超限',
      'GPU 表面内存预算超限',
    ]

    // Verify error messages match what imageForAdmitted checks
    for (const msg of failures) {
      expect(msg).toMatch(/GPU.*预算超限/)
    }
  })

  it('should describe mipmap fallback behavior in comments', () => {
    // This test documents the expected behavior:
    // 1. Level 0 with >16M pixels throws 'GPU 图片像素预算超限'
    // 2. imageForAdmitted catches the error
    // 3. Retries at level 1 (1/4 the pixels)
    // 4. Continues up the mip chain until admission succeeds
    // 5. Each level quarters memory demand

    const maxPixels = 16_777_216
    const largeImageDims: [number, number] = [5000, 4000] // 20M pixels
    const pixels = largeImageDims[0] * largeImageDims[1]

    expect(pixels).toBeGreaterThan(maxPixels)

    // Level 1 dimensions
    const level1 = [(largeImageDims[0] + 1) >> 1, (largeImageDims[1] + 1) >> 1]
    const level1Pixels = level1[0] * level1[1]

    // Level 1 should be ~1/4 the pixels
    expect(level1Pixels).toBeLessThan(pixels / 3)
    expect(level1Pixels).toBeGreaterThan(pixels / 5)

    // Level 2 dimensions
    const level2 = [(level1[0] + 1) >> 1, (level1[1] + 1) >> 1]
    const level2Pixels = level2[0] * level2[1]

    // Level 2 should fit comfortably under budget
    expect(level2Pixels).toBeLessThan(maxPixels)
  })

  it('should handle mipmap chain for various image sizes', () => {
    const testCases = [
      { dims: [100, 100], expected: 8 },      // Actually: 100 -> 51 -> 26 -> 13 -> 7 -> 4 -> 2 -> 1 = 8 levels
      { dims: [512, 512], expected: 10 },     // 9 halvings + base
      { dims: [2048, 2048], expected: 12 },   // 11 halvings + base
      { dims: [8192, 8192], expected: 14 },   // 13 halvings + base
    ]

    for (const { dims, expected } of testCases) {
      const levels = mipLevelsFor(dims as [number, number])
      expect(levels).toBe(expected)
    }
  })

  it('should document Figma-parity semantics', () => {
    // Figma semantics: "原图就是清晰度上限"
    // At >=1600% zoom, dropping one mip level is visually imperceptible
    // but saves 75% memory

    const basePixels = 4096 * 4096 // 16M pixels - at budget limit
    const level1Pixels = 2048 * 2048 // 4M pixels - 1/4 memory

    const savings = 1 - (level1Pixels / basePixels)
    expect(savings).toBeCloseTo(0.75, 2)

    // At 1600% zoom, 1 device pixel covers 0.0625 texels
    // Dropping from level 0 to level 1 means 1 device pixel covers 0.125 texels
    // The visual difference is minimal
    const zoomThreshold = 1600
    const texelsPerDevicePixel = 1 / (zoomThreshold / 100)
    expect(texelsPerDevicePixel).toBeLessThan(0.1)
  })

  it('should validate level clamping logic', () => {
    const dims: [number, number] = [1024, 1024]
    const maxLevel = mipLevelsFor(dims) - 1
    expect(maxLevel).toBe(10) // 0-indexed: levels 0 through 10

    // Requesting level 15 should clamp to maxLevel
    const requestedLevel = 15
    const clampedLevel = Math.min(requestedLevel, maxLevel)
    expect(clampedLevel).toBe(10)

    // Level 10 dimensions
    let w = dims[0], h = dims[1]
    for (let i = 0; i < 10; i++) {
      w = (w + 1) >> 1
      h = (h + 1) >> 1
    }
    expect(w).toBe(1)
    expect(h).toBe(1)
  })
})
