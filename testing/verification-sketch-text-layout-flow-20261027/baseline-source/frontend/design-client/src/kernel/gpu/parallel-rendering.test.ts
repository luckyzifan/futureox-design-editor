import { describe, test, expect } from 'vitest'
import { organizeAdvancedBatches, encodeAdvancedBatchInstances } from './advanced-batching'
import type { GpuNode } from './types'
// Real CPU output of an unintegrated prototype, not parallel GPU execution.
const rectangle = (id: string, color = '#ff0000') => ({
  id, fills: [{ kind: 'solid', color, visible: true, opacity: 1, blend: 'normal' }],
  fill: { count: 4, rule: 'nonzero', analyticRect: true },
  matrix: [1, 0, 0, 1, 12, 24], rect: { x: 3, y: 4, w: 50, h: 60 },
  opacity: 1, blend: 'normal', children: [], strokes: [], effects: [], mask: false, passthrough: false,
} as unknown as GpuNode)
describe('production batching CPU contracts, not GPU parallelism', () => {
  test('groups matching geometry/material without merging different paint', () => {
    const groups = organizeAdvancedBatches([rectangle('a'), rectangle('b'), rectangle('c', '#0000ff')], { minInstancesPerBatch: 1 })
    expect(groups.map(group => group.instances.map(instance => instance.nodeId))).toEqual([['a', 'b'], ['c']])
  })
  test('splits large instance groups at the actual 1024 instance limit with no loss', () => {
    const nodes = Array.from({ length: 2050 }, (_, i) => rectangle(String(i)))
    const groups = organizeAdvancedBatches(nodes, { minInstancesPerBatch: 1 })
    expect(groups.map(group => group.instances.length)).toEqual([1024, 1024, 2])
    expect(groups.flatMap(group => group.instances.map(instance => instance.nodeId))).toEqual(nodes.map(node => node.id))
  })
  test('instance transform snapshots cannot change when source transforms mutate', () => {
    const source = rectangle('a'), [group] = organizeAdvancedBatches([source], { minInstancesPerBatch: 1 })
    source.matrix[4] = 999
    expect(Array.from(group.instances[0].transform)).toEqual([1, 0, 0, 1, 12, 24])
  })
  test('encodes the actual 16-float instance layout rather than a hand-built batch', () => {
    const [group] = organizeAdvancedBatches([rectangle('a')], { minInstancesPerBatch: 1 }), encoded = encodeAdvancedBatchInstances(group)
    expect(encoded.instanceCount).toBe(1)
    expect(Array.from(encoded.instanceData)).toEqual([1, 0, 0, 1, 12, 24, 3, 4, 50, 60, 1, 0, 0, 1, 0, 0])
  })
  test('effect-bearing nodes cannot enter the simple fill batch', () => {
    const source = rectangle('a'); source.effects = [{ kind: 'blur' }] as GpuNode['effects']
    expect(organizeAdvancedBatches([source], { minInstancesPerBatch: 1 })).toEqual([])
  })
})
// Keep original unmet scenarios visible. Random shared fences and locally
// constructed objects cannot establish these production/device contracts.
test.todo('实例化描边批次包含多个路径: requires integrated stroke batch API and real GPU output')
test.todo('玻璃效果批次包含 shader 参数: requires integrated glass batch API and shader-output oracle')
test.todo('多个瓦片应该并行提交: requires actual queue/fence and independent device timeline evidence')
test.todo('大量瓦片应该分批提交: requires actual tile scheduler submissions, not local array slicing')
