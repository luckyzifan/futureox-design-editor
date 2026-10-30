#!/usr/bin/env bun

/**
 * 自适应预算策略测试
 */

import { describe, test, expect } from 'bun:test'
import {
  budgetMultiplierForZoom,
  adaptiveBudget,
  tileStrategyForZoom,
  evictionPriority,
  optimizationStrategyForZoom
} from '../src/kernel/gpu/adaptive-budget'

describe('Adaptive Budget Strategy', () => {
  const BASE_BUDGET = 256 * 1024 * 1024 // 256MB

  test('Budget multiplier scales with zoom', () => {
    expect(budgetMultiplierForZoom(0.5)).toBe(1)    // 50%: 1×
    expect(budgetMultiplierForZoom(1)).toBe(1)      // 100%: 1×
    expect(budgetMultiplierForZoom(2)).toBe(1.5)    // 200%: 1.5×
    expect(budgetMultiplierForZoom(4)).toBe(2)      // 400%: 2×
    expect(budgetMultiplierForZoom(7)).toBe(3)      // 700%: 3×
    expect(budgetMultiplierForZoom(16)).toBe(4)     // 1600%: 4×
    expect(budgetMultiplierForZoom(32)).toBe(6)     // 3200%: 6×
    expect(budgetMultiplierForZoom(64)).toBe(8)     // 6400%: 8×
  })

  test('Adaptive budget increases with zoom', () => {
    const budget100 = adaptiveBudget(BASE_BUDGET, 1)
    const budget700 = adaptiveBudget(BASE_BUDGET, 7)
    const budget3200 = adaptiveBudget(BASE_BUDGET, 32)

    expect(budget100).toBe(256 * 1024 * 1024)       // 256MB
    expect(budget700).toBe(768 * 1024 * 1024)       // 768MB (3×)
    // 32× = 6× = 1536MB，但限制在 1GB
    expect(budget3200).toBe(1024 * 1024 * 1024)     // 1024MB (限制)
  })

  test('Budget respects device memory limits', () => {
    const deviceMemory = 4 * 1024 * 1024 * 1024 // 4GB
    const budget = adaptiveBudget(BASE_BUDGET, 64, deviceMemory)

    // 应该限制在设备内存的 25% (1GB)
    expect(budget).toBeLessThanOrEqual(1024 * 1024 * 1024)
  })

  test('Tiling disabled for small images', () => {
    const strategy = tileStrategyForZoom(7, [3840, 2160]) // 4K @ 700%
    expect(strategy.enabled).toBe(false)
  })

  test('Tiling enabled for huge images', () => {
    const strategy = tileStrategyForZoom(32, [7680, 4320]) // 8K @ 3200%
    // 8K × 16 bytes = 501MB > 512MB 阈值
    expect(strategy.enabled).toBe(true)
    expect(strategy.tileSize).toBeGreaterThan(0)
  })

  test('Eviction priority for interaction textures', () => {
    const priority = evictionPriority(
      { width: 1920, height: 1080, bytes: 8 * 1024 * 1024 },
      95,   // lastUsedFrame
      100,  // currentFrame
      true, // isInteraction
      false
    )
    expect(priority.category).toBe('critical')
  })

  test('Eviction priority for old disposable textures', () => {
    const priority = evictionPriority(
      { width: 4096, height: 4096, bytes: 256 * 1024 * 1024 }, // 256MB 大纹理
      50,   // lastUsedFrame
      100,  // currentFrame
      false,
      false
    )
    expect(priority.category).toBe('disposable')
    expect(priority.score).toBeLessThanOrEqual(0) // 旧纹理≤0分（50帧前）
  })

  test('Full optimization strategy for 3200% zoom', () => {
    const strategy = optimizationStrategyForZoom(
      32,              // 3200%
      [7680, 4320],    // 8K
      BASE_BUDGET,
      8 * 1024 * 1024 * 1024 // 8GB 设备
    )

    expect(strategy.budgetMultiplier).toBe(6)
    expect(strategy.budgetBytes).toBeGreaterThan(BASE_BUDGET)
    expect(strategy.batchingEnabled).toBe(true)
    expect(strategy.aggressiveEviction).toBe(true)
    expect(strategy.evictionThreshold).toBe(0.7)
  })
})

console.log('\n🧪 运行自适应预算策略测试...\n')
