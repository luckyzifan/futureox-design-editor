import { afterEach, expect, test, vi } from 'vitest'
import { paint } from '../../model'
import { GpuRenderer, type Surface } from './renderer'
import { WebGpuDriver } from './webgpu'
import { MAX_SOLID_INSTANCES, SOLID_INSTANCE_FLOATS } from './solid-batch'
import { parameters, type GpuNode, type Texture } from './types'
// Actual renderer scheduling + actual WebGPU arena accounting; GPU command
// recording is controlled. Painter order is checked, not shader pixel output.
afterEach(() => vi.unstubAllGlobals())
const bounds = { x: 0, y: 0, w: 12, h: 12 }
function node(index: number): GpuNode {
  return { id: String(index), rect: bounds, matrix: [1, 0, 0, 1, 0, 0], inverse: [1, 0, 0, 1, 0, 0], size: [12, 12],
    fill: { rect: bounds, first: 0, count: 6, rule: 'nonzero', analyticRect: [0, 0, 12, 12] },
    fills: [paint(`#${index.toString(16).padStart(6, '0')}`)],
    children: [], strokes: [], effects: [], blend: 'normal', opacity: 1, mask: false, clip: false } as GpuNode
}
function fixture(nodes: GpuNode[]) {
  vi.stubGlobal('OffscreenCanvas', class {})
  vi.stubGlobal('GPUBufferUsage', { STORAGE: 1, COPY_DST: 2, COPY_SRC: 4, VERTEX: 8 })
  const driver = new WebGpuDriver(false), internal = driver as any
  const order: number[][] = [[], [], [], []], batchSizes: number[] = []
  let base = 0
  const encoder = () => ({ finish: () => ({}), beginRenderPass: (descriptor: any) => {
    const sample = descriptor.colorAttachments[0].view.sample
    return { setPipeline() {}, setBindGroup() {}, end() {}, draw(_vertices: number, count: number) {
      if (sample === 0) batchSizes.push(count)
      for (let i = 0; i < count; i++) { const at = base * 4 + i * SOLID_INSTANCE_FLOATS + 12
        order[sample].push(Math.round(internal.solidData[at] * 255) * 65536 + Math.round(internal.solidData[at + 1] * 255) * 256 + Math.round(internal.solidData[at + 2] * 255)) }
    } }
  } })
  const writes = vi.fn(), submits = vi.fn(), waits = vi.fn(async () => {})
  Object.assign(driver, { solidBuffer: {}, solidBind: {}, solidPipeline: {}, closeOver() {},
    bindingCache: { view: (resource: unknown) => resource, begin() {} },
    bind: (u: Float32Array) => { base = u[36]; return { group: {}, offsets: [] } }, encoder: encoder(),
    device: { queue: { writeBuffer: writes, submit: submits, onSubmittedWorkDone: waits }, createCommandEncoder: encoder,
      createBuffer: (d: { size: number }) => ({ size: d.size, destroy() {} }), pushErrorScope() {} },
  })
  const targets: Surface[] = order.map((_, sample) => ({ rect: bounds, texture: { width: 12, height: 12, bytes: 576, resource: { sample } as unknown as GPUTexture } }))
  const renderer = new GpuRenderer(driver, true, true) as any
  Object.assign(renderer, { scene: { nodes: Object.fromEntries(nodes.map(n => [n.id, n])), curves: new Float32Array() },
    yieldEncoding() {}, cropPainterTargets: async (targets: Surface[]) => targets, streamImageLeaf: async () => undefined,
    streamIsolatedFilter: async (n: GpuNode, targets: Surface[]) => {
      if (n.opacity === .5) { for (const sample of order) sample.push(Number(n.id)); return targets }
    }, replayTexture: () => false, reclaimScratch: async () => {}, retireLeafMasks() {}, nodeMask: () => targets[0],
  })
  driver.over = (target: Texture) => { order[(target.resource as any).sample].push(Number(renderer.activeNode)) }
  return { driver, internal, renderer, targets, order, batchSizes, writes, submits, waits,
    draw: () => renderer.drawBundle(nodes.map(n => n.id), targets) }
}
test('20,001 consecutive overlapping solids retain every painter in four sample planes', async () => {
  const nodes = Array.from({ length: MAX_SOLID_INSTANCES + 1 }, (_, i) => node(i + 1)), f = fixture(nodes)
  await f.draw()
  for (const order of f.order) expect(order).toEqual(nodes.map(n => Number(n.id)))
  expect(f.batchSizes).toEqual([MAX_SOLID_INSTANCES])
  expect(f.internal.solidOffset).toBe(MAX_SOLID_INSTANCES * SOLID_INSTANCE_FLOATS)
})
test('oversized reported capacity is clamped to the independent per-call safety bound', async () => {
  const nodes = Array.from({ length: MAX_SOLID_INSTANCES + 1 }, (_, i) => node(i + 1)), f = fixture(nodes)
  f.internal.solidBatchRemaining = () => Number.MAX_SAFE_INTEGER
  await f.draw()
  expect(f.batchSizes).toEqual([MAX_SOLID_INSTANCES])
  for (const order of f.order) expect(order).toEqual(nodes.map(n => Number(n.id)))
})
test('separated batches above the cumulative frame arena preserve overlap order and ordinary fallback', async () => {
  const nodes = Array.from({ length: 24001 }, (_, i) => node(i + 1)); nodes[12000].opacity = .5
  const f = fixture(nodes); await f.draw()
  for (const order of f.order) expect(order).toEqual(nodes.map(n => Number(n.id)))
  expect(f.batchSizes).toEqual([12000, 8000])
  expect(f.internal.solidOffset).toBe(MAX_SOLID_INSTANCES * SOLID_INSTANCE_FLOATS)
})
test.each([undefined, NaN, Infinity, -1, 7, 8.5])('unknown/malformed/insufficient reported capacity %s uses exact ordinary dispatch', async capacity => {
  const nodes = Array.from({ length: 8 }, (_, i) => node(i + 1)), f = fixture(nodes)
  f.internal.solidBatchRemaining = capacity === undefined ? undefined : () => capacity
  await f.draw()
  expect(f.batchSizes).toEqual([])
  for (const order of f.order) expect(order).toEqual(nodes.map(n => Number(n.id)))
})
test('one data array shared by four samples is charged once; submission does not reopen the arena', async () => {
  const f = fixture([]), data = new Float32Array(9 * SOLID_INSTANCE_FLOATS), u = parameters(bounds)
  for (const target of f.targets) f.driver.solidBatch(target.texture, u, data)
  expect(f.internal.solidBatchRemaining()).toBe(MAX_SOLID_INSTANCES - 9)
  f.internal.submitCommands()
  expect(f.submits).toHaveBeenCalledOnce(); expect(f.waits).not.toHaveBeenCalled()
  expect(f.internal.solidBatchRemaining()).toBe(MAX_SOLID_INSTANCES - 9)
  expect(f.internal.solidRanges.has(data)).toBe(true)
  // Existing caller-owned completed-frame boundary, not a new reset at submit.
  await f.internal.device.queue.onSubmittedWorkDone()
  f.driver.begin(new Float32Array())
  expect(f.internal.solidBatchRemaining()).toBe(MAX_SOLID_INSTANCES)
  expect(f.internal.solidRanges.has(data)).toBe(false)
})
