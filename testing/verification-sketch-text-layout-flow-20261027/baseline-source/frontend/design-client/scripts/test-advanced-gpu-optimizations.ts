#!/usr/bin/env bun
/**
 * CPU batching estimates and production GPU module wiring only; no measured GPU performance
 *
 * 1. 扩展实例化批渲染
 * 2. 描边 GPU 计算管线
 * 3. 玻璃效果 GPU 片元化
 */

import { describe, test, expect } from 'bun:test'

// ========== 测试 1: 扩展实例化批渲染 ==========

describe('production batching CPU estimator, not GPU draw or speedup measurements', () => {
  test('纯色批渲染', () => {
    const { organizeAdvancedBatches, estimateAdvancedBatchingSavings } =
      require('../src/kernel/gpu/advanced-batching')

    // 模拟 100 个相似矩形
    const nodes: any[] = Array.from({ length: 100 }, (_, i) => ({
      id: `node-${i}`,
      fills: [{
        kind: 'solid',
        color: '#FF5733',
        visible: true,
        opacity: 1,
        blend: 'normal',
      }],
      fill: {
        count: 4,  // 矩形
        rule: 'nonzero',
        analyticRect: true,
      },
      matrix: [1, 0, 0, 1, i * 10, i * 10],
      rect: { x: i * 10, y: i * 10, w: 50, h: 50 },
      opacity: 1,
      blend: 'normal',
      children: [],
      strokes: [],
      effects: [],
      mask: false,
      passthrough: false,
    }))

    const batches = organizeAdvancedBatches(nodes)
    const savings = estimateAdvancedBatchingSavings(nodes)


    expect(batches.length).toBeGreaterThan(0)
    expect(savings.drawCallReduction).toBeGreaterThan(0)
    expect(savings.savingsPercent).toBeGreaterThan(80)  // 预期 >80% 减少
  })

  test('渐变批渲染', () => {
    const { organizeAdvancedBatches, estimateAdvancedBatchingSavings } =
      require('../src/kernel/gpu/advanced-batching')

    // 模拟 50 个相同渐变的矩形
    const nodes: any[] = Array.from({ length: 50 }, (_, i) => ({
      id: `gradient-node-${i}`,
      fills: [{
        kind: 'linear',
        stops: [
          { offset: 0, color: '#FF0000' },
          { offset: 1, color: '#0000FF' },
        ],
        angle: 90,
        visible: true,
        opacity: 1,
        blend: 'normal',
      }],
      fill: {
        count: 4,
        rule: 'nonzero',
        analyticRect: true,
      },
      matrix: [1, 0, 0, 1, i * 10, 0],
      rect: { x: i * 10, y: 0, w: 50, h: 50 },
      opacity: 1,
      blend: 'normal',
      children: [],
      strokes: [],
      effects: [],
      mask: false,
      passthrough: false,
    }))

    const savings = estimateAdvancedBatchingSavings(nodes, {
      enableGradientBatching: true,
    })


    expect(savings.breakdown.gradient).toBeGreaterThan(0)
    expect(savings.drawCallReduction).toBeGreaterThan(40)
  })

  test('混合批渲染（纯色 + 渐变 + 图片）', () => {
    const { estimateAdvancedBatchingSavings } =
      require('../src/kernel/gpu/advanced-batching')

    const nodes: any[] = [
      // 20 个纯色
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `solid-${i}`,
        fills: [{
          kind: 'solid',
          color: '#FF5733',
          visible: true,
          opacity: 1,
          blend: 'normal',
        }],
        fill: { count: 4, rule: 'nonzero', analyticRect: true },
        matrix: [1, 0, 0, 1, i * 5, 0],
        rect: { x: i * 5, y: 0, w: 50, h: 50 },
        opacity: 1,
        blend: 'normal',
        children: [],
        strokes: [],
        effects: [],
        mask: false,
        passthrough: false,
      })),
      // 15 个渐变
      ...Array.from({ length: 15 }, (_, i) => ({
        id: `gradient-${i}`,
        fills: [{
          kind: 'linear',
          stops: [
            { offset: 0, color: '#FF0000' },
            { offset: 1, color: '#00FF00' },
          ],
          angle: 0,
          visible: true,
          opacity: 1,
          blend: 'normal',
        }],
        fill: { count: 4, rule: 'nonzero', analyticRect: true },
        matrix: [1, 0, 0, 1, i * 5, 60],
        rect: { x: i * 5, y: 60, w: 50, h: 50 },
        opacity: 1,
        blend: 'normal',
        children: [],
        strokes: [],
        effects: [],
        mask: false,
        passthrough: false,
      })),
      // 10 个图片
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `image-${i}`,
        fills: [{
          kind: 'image',
          id: 'image-123',
          fit: 'cover',
          visible: true,
          opacity: 1,
          blend: 'normal',
        }],
        fill: { count: 4, rule: 'nonzero', analyticRect: true },
        matrix: [1, 0, 0, 1, i * 5, 120],
        rect: { x: i * 5, y: 120, w: 50, h: 50 },
        opacity: 1,
        blend: 'normal',
        children: [],
        strokes: [],
        effects: [],
        mask: false,
        passthrough: false,
      })),
    ]

    const savings = estimateAdvancedBatchingSavings(nodes, {
      enableGradientBatching: true,
      enableImageBatching: true,
    })


    expect(savings.breakdown.solid).toBe(20)
    expect(savings.breakdown.gradient).toBe(15)
    expect(savings.breakdown.image).toBe(10)
    expect(savings.savingsPercent).toBeGreaterThan(60)
  })
})

// ========== 测试 2: 描边 GPU 计算管线 ==========

describe('描边 GPU 计算', () => {
  test('production stroke initialization selects its four shader entry points', async () => {
    const { StrokeGpuPipeline } = require('../src/kernel/gpu/stroke-gpu-pipeline')
    const modules: any[] = [], pipelines: any[] = []
    const device = {
      createShaderModule(descriptor: any) { modules.push(descriptor); return descriptor },
      createComputePipeline(descriptor: any) { pipelines.push(descriptor); return descriptor },
    }
    await new StrokeGpuPipeline(device).initialize()
    expect(modules.length).toBe(4)
    expect(pipelines.map(p => p.compute.entryPoint)).toEqual(['prefixSum', 'computeNormals', 'computeOffsets', 'computeJoints'])
    for (const p of pipelines) expect(p.compute.module.code).toContain(`fn ${p.compute.entryPoint}(`)
  })
  test.todo('actual WebGPU stroke geometry and shader compilation require a real device and independent output oracle')

  test('stroke shader and class exports retain their public structure (not compilation)', () => {
    const { parallelPrefixSumWGSL } = require('../src/kernel/gpu/parallel-prefix-sum.wgsl')
    const { StrokeGpuPipeline } = require('../src/kernel/gpu/stroke-gpu-pipeline')


    expect(parallelPrefixSumWGSL).toContain('@compute')
    expect(parallelPrefixSumWGSL).toContain('prefixSum')
    expect(typeof StrokeGpuPipeline).toBe('function')
  })
})

// ========== 测试 3: 玻璃效果 GPU 片元化 ==========

describe('玻璃效果 GPU', () => {
  test('glass shader exposes its declared SDF entry points (structural contract only)', () => {
    // 验证 Shader 代码
    const { glassEffectFragmentShaderWGSL } = require('../src/kernel/gpu/glass-sdf-shader')


    expect(glassEffectFragmentShaderWGSL).toContain('roundedBoxSDF')
    expect(glassEffectFragmentShaderWGSL).toContain('smoothSDF')
    expect(glassEffectFragmentShaderWGSL).toContain('computeNormal')
    expect(glassEffectFragmentShaderWGSL).toContain('computeRefraction')
    expect(glassEffectFragmentShaderWGSL).toContain('chromaticAberration')
    expect(glassEffectFragmentShaderWGSL).toContain('bevelEffect')
    expect(glassEffectFragmentShaderWGSL).toContain('splayDistortion')
  })

  test('glass renderer constructor remains exported (not pixel correctness)', () => {
    const { GlassEffectGpuRenderer } = require('../src/kernel/gpu/glass-sdf-shader')


    expect(typeof GlassEffectGpuRenderer).toBe('function')
  })
})

// No device timing, utilization, FPS or speedup is measured by this suite.
test.todo('actual WebGPU glass pixels and performance require matched device/browser evidence')
