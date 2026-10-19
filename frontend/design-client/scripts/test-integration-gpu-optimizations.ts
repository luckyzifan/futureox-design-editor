/**
 * 🎯 GPU 优化集成测试
 *
 * 验证渲染器优化在渲染器中正常工作
 */

import { describe, test, expect } from 'bun:test'
import { calculateDynamicDensity } from '../src/kernel/tile-cache'
import { isElectronEnvironment, adaptiveBudget } from '../src/kernel/gpu/adaptive-budget'
import { RendererOptimizations } from '../src/kernel/gpu/renderer-optimizations'

describe('🎯 GPU 优化集成测试', () => {
  test('渲染器优化扩展正确集成', () => {
    expect(RendererOptimizations).toBeDefined()
    expect(typeof RendererOptimizations).toBe('function')
  })

  test('Electron 环境检测工作正常', () => {
    const isElectron = isElectronEnvironment()
    expect(typeof isElectron).toBe('boolean')
    expect(isElectron).toBe(false) // 测试环境中应该是 false
  })

  test('自适应预算区分 Electron 和 Web', () => {
    const baseBudget = 128 * 1024 * 1024 // 128MB
    const zoom = 5.0
    const deviceMemory = 8 * 1024 * 1024 * 1024 // 8GB

    const webBudget = adaptiveBudget(baseBudget, zoom, deviceMemory, false)
    const electronBudget = adaptiveBudget(baseBudget, zoom, deviceMemory, true)

    expect(webBudget).toBeLessThanOrEqual(deviceMemory * 0.25)
    expect(electronBudget).toBeLessThanOrEqual(deviceMemory * 0.50)
    expect(electronBudget).toBeGreaterThanOrEqual(webBudget)
  })

  test('渲染器优化模块可以实例化', () => {
    const mockDevice = {
      createBuffer: () => ({}),
      createComputePipeline: () => ({}),
      createRenderPipeline: () => ({}),
    } as any

    const optimizations = new RendererOptimizations(mockDevice)
    expect(optimizations).toBeDefined()
    expect(typeof optimizations.initialize).toBe('function')
  })
})

describe('🎯 清晰度动态调整', () => {
  const viewport = { width: 1920, height: 1080 }

  test('放大时清晰度平滑提升', () => {
    const densities = []
    for (let zoom = 1.0; zoom <= 4.0; zoom += 0.5) {
      densities.push(calculateDynamicDensity(zoom, viewport))
    }

    // 验证单调递增
    for (let i = 1; i < densities.length; i++) {
      expect(densities[i]).toBeGreaterThanOrEqual(densities[i - 1])
    }
  })

  test('缩小时清晰度平滑降低', () => {
    const densities = []
    for (let zoom = 1.0; zoom >= 0.2; zoom -= 0.1) {
      densities.push(calculateDynamicDensity(zoom, viewport))
    }

    // 验证单调递减或相等
    for (let i = 1; i < densities.length; i++) {
      expect(densities[i]).toBeLessThanOrEqual(densities[i - 1])
    }
  })

  test('大视口限制清晰度', () => {
    const smallViewport = { width: 800, height: 600 }
    const largeViewport = { width: 3840, height: 2160 }

    const smallDensity = calculateDynamicDensity(2.0, smallViewport)
    const largeDensity = calculateDynamicDensity(2.0, largeViewport)

    // 大视口应该限制清晰度（避免超出瓦片预算）
    expect(largeDensity).toBeLessThanOrEqual(smallDensity)
  })
})
