#!/usr/bin/env bun

/**
 * 测试高倍率放大时的 mipmap 层级选择
 * 验证：700% 放大时应该使用高清晰度图层
 */

import { describe, test, expect } from 'bun:test'

// 模拟 mipmap 层级计算
function mipLevelsFor(dims: [number, number]): number {
  const max = Math.max(dims[0], dims[1])
  return Math.floor(Math.log2(max)) + 1
}

function calculateImageLevel(
  imageDims: [number, number],
  scaleX: number,
  scaleY: number,
  imageMips: boolean
): number {
  const pixelCount = imageDims[0] * imageDims[1]

  // mipmap 未启用
  if (!imageMips) {
    if (pixelCount > 16_777_216) {
      // 强制降级大图
      const maxLevel = mipLevelsFor(imageDims) - 1
      let level = maxLevel
      while (level < maxLevel) {
        const scaledWidth = Math.ceil(imageDims[0] / (2 ** level))
        const scaledHeight = Math.ceil(imageDims[1] / (2 ** level))
        if (scaledWidth * scaledHeight <= 16_777_216) break
        level++
      }
      return level
    }
    return 0
  }

  // mipmap 已启用，计算基础层级
  const avgScale = (Math.abs(scaleX) + Math.abs(scaleY)) / 2
  const maxLevel = mipLevelsFor(imageDims) - 1

  // 缩小时使用较低分辨率
  if (avgScale < 0.5) {
    const level = Math.floor(-Math.log2(avgScale))
    return Math.min(level, maxLevel)
  }

  // 放大时始终使用原始分辨率（level 0）
  return 0
}

describe('High Zoom Mipmap Level Selection', () => {
  test('4K image at 100% zoom', () => {
    const level = calculateImageLevel([3840, 2160], 1, 1, true)
    expect(level).toBe(0)  // 原始分辨率
  })

  test('4K image at 200% zoom', () => {
    const level = calculateImageLevel([3840, 2160], 2, 2, true)
    expect(level).toBe(0)  // 原始分辨率
  })

  test('4K image at 400% zoom', () => {
    const level = calculateImageLevel([3840, 2160], 4, 4, true)
    expect(level).toBe(0)  // 原始分辨率
  })

  test('4K image at 700% zoom (high zoom)', () => {
    const level = calculateImageLevel([3840, 2160], 7, 7, true)
    expect(level).toBe(0)  // ✅ 应该使用原始分辨率
  })

  test('4K image at 800% zoom (very high zoom)', () => {
    const level = calculateImageLevel([3840, 2160], 8, 8, true)
    expect(level).toBe(0)  // ✅ 应该使用原始分辨率
  })

  test('4K image at 1000% zoom (extreme zoom)', () => {
    const level = calculateImageLevel([3840, 2160], 10, 10, true)
    expect(level).toBe(0)  // ✅ 应该使用原始分辨率
  })

  test('8K image at 700% zoom', () => {
    const level = calculateImageLevel([7680, 4320], 7, 7, true)
    expect(level).toBe(0)  // ✅ 应该使用原始分辨率
  })

  test('4K image at 50% zoom (zooming out)', () => {
    const level = calculateImageLevel([3840, 2160], 0.5, 0.5, true)
    expect(level).toBeGreaterThanOrEqual(0)
    expect(level).toBeLessThanOrEqual(1)  // 可以使用 mipmap
  })

  test('4K image at 25% zoom (zooming out more)', () => {
    const level = calculateImageLevel([3840, 2160], 0.25, 0.25, true)
    expect(level).toBeGreaterThanOrEqual(1)  // 应该使用较低分辨率
  })
})

console.log('\n🧪 运行高倍率放大 mipmap 测试...\n')
