import { describe, test, expect } from 'vitest'
import { generatePathFingerprint, matchesFingerprint, organizeBatches, estimateBatchingSavings } from './path-batching'
import type { GpuNode, PathMesh, GpuPaint } from './types'

describe('Path Batching', () => {
  test('generatePathFingerprint creates consistent fingerprints', () => {
    const path1: PathMesh = {
      rect: { x: 0, y: 0, w: 100, h: 100 },
      first: 0,
      count: 4,
      rule: 'nonzero',
      analyticRect: [10, 10, 90, 90],
    }

    const path2: PathMesh = {
      rect: { x: 100, y: 100, w: 100, h: 100 },
      first: 4,
      count: 4,
      rule: 'nonzero',
      analyticRect: [10, 10, 90, 90],
    }

    const fp1 = generatePathFingerprint(path1)
    const fp2 = generatePathFingerprint(path2)

    expect(fp1.type).toBe('rect')
    expect(fp2.type).toBe('rect')
    expect(matchesFingerprint(fp1, fp2)).toBe(true)
  })

  test('organizeBatches groups similar nodes', () => {
    const nodes: GpuNode[] = []

    // 创建 20 个相似的矩形节点
    for (let i = 0; i < 20; i++) {
      const node: Partial<GpuNode> = {
        id: `rect-${i}`,
        rect: { x: i * 10, y: 0, w: 100, h: 100 },
        opacity: 1,
        blend: 'normal',
        children: [],
        strokes: [],
        effects: [],
        mask: false,
        passthrough: false,
        previewDynamic: false,
        fills: [{
          kind: 'solid',
          color: '#FF0000',
          visible: true,
          opacity: 1,
          blend: 'normal',
          id: '',
          angle: 0,
          stops: [],
          fit: 'cover',
        } as GpuPaint],
        fill: {
          rect: { x: i * 10, y: 0, w: 100, h: 100 },
          first: 0,
          count: 4,
          rule: 'nonzero',
          analyticRect: [0, 0, 100, 100],
        },
        matrix: [1, 0, 0, 1, 0, 0],
        inverse: [1, 0, 0, 1, 0, 0],
        size: [100, 100],
      }
      nodes.push(node as GpuNode)
    }

    const batches = organizeBatches(nodes)

    // 应该只有 1-2 个批次（取决于 MAX_BATCH_INSTANCES）
    expect(batches.length).toBeGreaterThan(0)
    expect(batches.length).toBeLessThanOrEqual(2)

    // 所有 20 个节点都应该被批处理
    const totalInstances = batches.reduce((sum, b) => sum + b.instances.length, 0)
    expect(totalInstances).toBe(20)
  })

  test('estimateBatchingSavings calculates correct savings', () => {
    const nodes: GpuNode[] = []

    // 16 个相似节点
    for (let i = 0; i < 16; i++) {
      const node: Partial<GpuNode> = {
        id: `rect-${i}`,
        rect: { x: i * 10, y: 0, w: 100, h: 100 },
        opacity: 1,
        blend: 'normal',
        children: [],
        strokes: [],
        effects: [],
        fills: [{
          kind: 'solid',
          color: '#FF0000',
          visible: true,
          opacity: 1,
          blend: 'normal',
          id: '',
          angle: 0,
          stops: [],
          fit: 'cover',
        } as GpuPaint],
        fill: {
          rect: { x: i * 10, y: 0, w: 100, h: 100 },
          first: 0,
          count: 4,
          rule: 'nonzero',
          analyticRect: [0, 0, 100, 100],
        },
        matrix: [1, 0, 0, 1, 0, 0],
        inverse: [1, 0, 0, 1, 0, 0],
        size: [100, 100],
      }
      nodes.push(node as GpuNode)
    }

    const stats = estimateBatchingSavings(nodes)

    expect(stats.totalNodes).toBe(16)
    expect(stats.batchableNodes).toBe(16)
    expect(stats.estimatedDrawCalls.before).toBe(16)
    expect(stats.estimatedDrawCalls.after).toBeLessThan(16)
    expect(stats.savings).toBeGreaterThan(0)
  })

  test('batch filtering excludes nodes below threshold', () => {
    const nodes: GpuNode[] = []

    // 只创建 5 个相似节点（低于 8 的阈值）
    for (let i = 0; i < 5; i++) {
      const node: Partial<GpuNode> = {
        id: `rect-${i}`,
        rect: { x: i * 10, y: 0, w: 100, h: 100 },
        opacity: 1,
        blend: 'normal',
        children: [],
        strokes: [],
        effects: [],
        fills: [{
          kind: 'solid',
          color: '#FF0000',
          visible: true,
          opacity: 1,
          blend: 'normal',
          id: '',
          angle: 0,
          stops: [],
          fit: 'cover',
        } as GpuPaint],
        fill: {
          rect: { x: i * 10, y: 0, w: 100, h: 100 },
          first: 0,
          count: 4,
          rule: 'nonzero',
          analyticRect: [0, 0, 100, 100],
        },
        matrix: [1, 0, 0, 1, 0, 0],
        inverse: [1, 0, 0, 1, 0, 0],
        size: [100, 100],
      }
      nodes.push(node as GpuNode)
    }

    const batches = organizeBatches(nodes)

    // 不应该有批次（低于阈值）
    expect(batches.length).toBe(0)
  })
})
