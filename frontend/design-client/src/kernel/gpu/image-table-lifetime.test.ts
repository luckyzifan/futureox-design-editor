import { afterEach, expect, test, vi } from 'vitest'
import { setGpuDiagnosticSink } from '../../../../design-desktop/src/render-terminal-diagnostics.mjs'
import { WebGpuDriver } from './webgpu'
import { GpuRenderer } from './renderer'
import { certifyExactImageRange, imageXTablePlanRange, planExactImageXTable, type ExactImageXTablePlan } from './exact-image-x-table'
import type { Driver, Texture } from './types'

afterEach(() => { setGpuDiagnosticSink(undefined); vi.unstubAllEnvs(); vi.unstubAllGlobals() })
function fixture(width = 4, height = 3, imageWidth = 8, imageHeight = 8, rgba = [1, 1, 1, 1]) {
  vi.stubEnv('VITE_DESIGN_EXACT_IMAGE_X_TABLE', '1')
  vi.stubGlobal('GPUBufferUsage', { UNIFORM: 1, COPY_DST: 2, STORAGE: 4 })
  const pixels = new Float32Array(imageWidth * imageHeight * 4)
  for (let i = 0; i < pixels.length; i += 4) pixels.set(rgba, i)
  const range = certifyExactImageRange(pixels)!
  const axes = Array.from({ length: 4 }, (_, phase) => {
    const data = new Float32Array(width * 8)
    for (let x = 0; x < width; x++) data.set([x + 1, (phase + 1) / 8, 1, -1], x * 4)
    for (let y = 0; y < height; y++) data.set([y + 1, (phase + 1) / 8, 1, -1], (width + y) * 4)
    return data
  })
  const plan = planExactImageXTable({ width, height, imageWidth, imageHeight, range, axes, maxTableBytes: 32 * 1024 * 1024 })!
  const resource = { destroy: vi.fn(), createView: () => ({}) }, image = { width: imageWidth, height: imageHeight,
    bytes: pixels.byteLength, finitePixels: true, resource } as unknown as Texture
  let resolvePipeline!: (value: unknown) => void, rejectPipeline!: (error: unknown) => void
  const compiling = new Promise((resolve, reject) => { resolvePipeline = resolve; rejectPipeline = reject })
  const buffers: any[] = [], writes: Uint32Array[] = []
  const pipeline = { encodeBuild: vi.fn(), encodeResolve: vi.fn() }
  const driver = Object.assign(Object.create(WebGpuDriver.prototype), {
    managed: true, displayMath: false, disposed: false, lost: false, resourceEpoch: 7, completedResourceEpoch: 0, frameScratchBytes: 0,
    imageTables: new Map(), preparingImageTables: new Map(), imageTablePipeline: compiling,
    imageRanges: new WeakMap([[image, range]]), imageAxisPrograms: new WeakMap(),
    textures: new Set([image]), replayParameterTextures: new Set(), encoder: {}, closeOver() {},
    device: { createBuffer(descriptor: any) { const buffer = { ...descriptor, destroy: vi.fn() }; buffers.push(buffer); return buffer },
      queue: { writeBuffer(_buffer: unknown, _offset: number, value: Uint32Array) { writes.push(value.slice()) } } },
    checkpoint: vi.fn(async () => {}),
  }) as WebGpuDriver
  const renderer = new GpuRenderer(driver as Driver) as any
  renderer.images.set('image', { texture: image, rect: { x: 0, y: 0, w: imageWidth, h: imageHeight } })
  renderer.bytes = image.bytes
  return { driver, renderer, image, resource, range, plan, axes, buffers, writes, pipeline, width, height,
    ready() { resolvePipeline(pipeline) }, fail(error = Error('pipeline failed')) { rejectPipeline(error) } }
}
function checkpoint(f: ReturnType<typeof fixture>, wait: () => Promise<void> = async () => {}, completedPoolEpoch?: number) {
  Object.assign(f.driver, { submitCommands: vi.fn(), waitForQueue: vi.fn(wait) })
  return WebGpuDriver.prototype.checkpoint.call(f.driver, 'admission', undefined, completedPoolEpoch)
}
test('logical retirement adds no fence and retains source, buffers and scratch bytes until a real completion boundary', async () => {
  const f = fixture(), preparing = f.driver.prepareImageTable(f.image, f.plan, 256 * 1024 * 1024)
  expect(f.driver.hasActiveImageTableSource(f.image)).toBe(true)
  f.renderer.evictImages(f.image.bytes, true)
  expect(f.resource.destroy).not.toHaveBeenCalled(); expect(f.renderer.images.has('image')).toBe(true)
  f.ready(); const table = (await preparing)!
  expect(table).toBeDefined(); expect(f.pipeline.encodeBuild).toHaveBeenCalledOnce()
  f.renderer.evictImages(f.image.bytes, true)
  expect(f.resource.destroy).not.toHaveBeenCalled()
  const bytes = f.driver.scratchBytes
  await f.driver.retireImageTable(table)
  expect(f.driver.checkpoint).not.toHaveBeenCalled()
  expect(f.driver.scratchBytes).toBe(bytes)
  expect(f.driver.retiredImageTableBytes).toBe(table.bytes)
  expect(f.driver.hasActiveImageTableSource(f.image)).toBe(true)
  expect(() => f.driver.resolveImageTable({} as Texture, table, 0, 0)).toThrow('Invalid exact image table window')
  let complete!: () => void
  const retiring = checkpoint(f, () => new Promise<void>(resolve => { complete = resolve }))
  f.renderer.evictImages(f.image.bytes, true)
  expect(f.resource.destroy).not.toHaveBeenCalled(); expect(f.buffers.every(buffer => !buffer.destroy.mock.calls.length)).toBe(true)
  complete(); await retiring
  expect(f.driver.hasActiveImageTableSource(f.image)).toBe(false)
  expect(f.driver.scratchBytes).toBe(0)
  expect(f.driver.retiredImageTableBytes).toBe(0)
  expect(f.buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true)
  f.renderer.evictImages(f.image.bytes, true)
  expect(f.resource.destroy).toHaveBeenCalledOnce(); expect(f.renderer.images.has('image')).toBe(false)
  expect(f.renderer.bytes).toBe(0)
})
test.each(['rejection', 'device-loss'] as const)('a %s at the completion boundary preserves all retired table owners', async failure => {
  const f = fixture(), preparing = f.driver.prepareImageTable(f.image, f.plan, 256 * 1024 * 1024)
  f.ready(); const table = (await preparing)!
  await f.driver.retireImageTable(table)
  const bytes = f.driver.scratchBytes
  const wait = async () => {
    if (failure === 'rejection') throw Error('failed queue fence')
    f.driver.lost = true
  }
  await expect(checkpoint(f, wait)).rejects.toThrow(failure === 'rejection' ? 'failed queue fence' : 'GPU 设备已丢失')
  expect(f.driver.scratchBytes).toBe(bytes)
  expect(f.driver.hasActiveImageTableSource(f.image)).toBe(true)
  expect(f.buffers.every(buffer => !buffer.destroy.mock.calls.length)).toBe(true)
  expect((f.driver as any).imageTables.has(table)).toBe(true)
})
test('a completed prior-frame pool proof submits but cannot collect current retired table reads', async () => {
  const f = fixture(), preparing = f.driver.prepareImageTable(f.image, f.plan, 256 * 1024 * 1024)
  f.ready(); const table = (await preparing)!
  await f.driver.retireImageTable(table); f.driver.completedResourceEpoch = 6
  await checkpoint(f, async () => { throw Error('Completion wait was not expected') }, 6)
  expect((f.driver as any).submitCommands).toHaveBeenCalledOnce()
  expect((f.driver as any).waitForQueue).not.toHaveBeenCalled()
  expect(f.driver.scratchBytes).toBe(table.bytes)
  expect(f.driver.hasActiveImageTableSource(f.image)).toBe(true)
  expect(f.buffers.every(buffer => !buffer.destroy.mock.calls.length)).toBe(true)
})
test('a completion snapshot collects only tables retired before submission and collection is idempotent', async () => {
  const f = fixture(), firstPreparation = f.driver.prepareImageTable(f.image, f.plan, 256 * 1024 * 1024)
  f.ready(); const first = (await firstPreparation)!, second = (await f.driver.prepareImageTable(f.image, f.plan, 256 * 1024 * 1024))!
  await f.driver.retireImageTable(first)
  let complete!: () => void
  const waiting = checkpoint(f, () => new Promise<void>(resolve => { complete = resolve }))
  await f.driver.retireImageTable(second)
  complete(); await waiting
  expect(f.driver.scratchBytes).toBe(second.bytes)
  expect((f.driver as any).imageTables.has(first)).toBe(false)
  expect((f.driver as any).imageTables.has(second)).toBe(true)
  expect(f.buffers.slice(0, 4).every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true)
  expect(f.buffers.slice(4).every(buffer => !buffer.destroy.mock.calls.length)).toBe(true)
  ;(f.driver as any).collectRetiredImageTables([first])
  expect(f.buffers.slice(0, 4).every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true)
  await checkpoint(f)
  expect(f.driver.scratchBytes).toBe(0)
  expect(f.driver.hasActiveImageTableSource(f.image)).toBe(false)
})
test('finish snapshot closes active handles without reclaiming storage or source ownership before completion', async () => {
  const f = fixture(), preparing = f.driver.prepareImageTable(f.image, f.plan, 256 * 1024 * 1024)
  f.ready(); const table = (await preparing)!
  expect((f.driver as any).retiredImageTableSnapshot()).toEqual([])
  const finishing = (f.driver as any).retiredImageTableSnapshot(true)
  expect(finishing).toEqual([table])
  expect(() => f.driver.resolveImageTable({} as Texture, table, 0, 0)).toThrow('Invalid exact image table window')
  expect(f.driver.scratchBytes).toBe(table.bytes)
  expect(f.driver.hasActiveImageTableSource(f.image)).toBe(true)
  expect(f.buffers.every(buffer => !buffer.destroy.mock.calls.length)).toBe(true)
  await checkpoint(f)
  expect(f.driver.scratchBytes).toBe(0)
})
test('real allocation pressure drains retired tables even below the maintenance threshold with no pool or uploads', async () => {
  const f = fixture(), preparing = f.driver.prepareImageTable(f.image, f.plan, 256 * 1024 * 1024)
  f.ready(); const table = (await preparing)!
  await f.driver.retireImageTable(table)
  f.renderer.scene = {}; f.renderer.bytes = f.image.bytes + table.bytes
  const before = f.renderer.bytes, required = f.renderer.frameBudget - f.image.bytes
  let complete!: () => void
  ;(f.driver as any).checkpoint = vi.fn(() => checkpoint(f, () => new Promise<void>(resolve => { complete = resolve })))
  setGpuDiagnosticSink(() => {})
  const pressure = f.renderer.reclaimScratch(required)
  expect(f.driver.checkpoint).toHaveBeenCalledOnce()
  expect((f.driver.checkpoint as any).mock.calls[0][1]).toMatchObject({
    admissionPressure: 1, admissionRetiredKinds: 16, admissionReclaimableBytes: table.bytes,
    admissionPoolCount: 0, admissionUploadCount: 0,
  })
  expect(f.renderer.bytes).toBe(before)
  expect(f.driver.scratchBytes).toBe(table.bytes)
  expect(f.buffers.every(buffer => !buffer.destroy.mock.calls.length)).toBe(true)
  complete(); await pressure
  expect(f.renderer.bytes).toBe(f.image.bytes)
  expect(f.driver.scratchBytes).toBe(0)
  expect(f.renderer.overBudget(required)).toBe(false)
  expect(f.resource.destroy).not.toHaveBeenCalled()
})
test.each(['rejection', 'device-loss'] as const)('failed %s during pressure preserves retired scratch accounting and all source owners', async failure => {
  const f = fixture(), preparing = f.driver.prepareImageTable(f.image, f.plan, 256 * 1024 * 1024)
  f.ready(); const table = (await preparing)!
  await f.driver.retireImageTable(table)
  f.renderer.scene = {}; f.renderer.bytes = f.image.bytes + table.bytes
  const before = f.renderer.bytes, required = f.renderer.frameBudget - f.image.bytes
  ;(f.driver as any).checkpoint = vi.fn(() => checkpoint(f, async () => {
    if (failure === 'rejection') throw Error('failed queue fence')
    f.driver.lost = true
  }))
  await expect(f.renderer.reclaimScratch(required)).rejects.toThrow(failure === 'rejection' ? 'failed queue fence' : 'GPU 设备已丢失')
  expect(f.renderer.bytes).toBe(before)
  expect(f.driver.scratchBytes).toBe(table.bytes)
  expect(f.driver.hasActiveImageTableSource(f.image)).toBe(true)
  expect(f.resource.destroy).not.toHaveBeenCalled()
  expect(f.buffers.every(buffer => !buffer.destroy.mock.calls.length)).toBe(true)
})
test('an active table is not a retired pressure candidate and cannot be discarded to admit another allocation', async () => {
  const f = fixture(), preparing = f.driver.prepareImageTable(f.image, f.plan, 256 * 1024 * 1024)
  f.ready(); const table = (await preparing)!
  f.renderer.scene = {}; f.renderer.bytes = f.image.bytes + table.bytes
  const required = f.renderer.frameBudget - f.image.bytes
  expect(f.driver.retiredImageTableBytes).toBe(0)
  await f.renderer.reclaimScratch(required)
  expect(f.driver.checkpoint).not.toHaveBeenCalled()
  expect(f.renderer.overBudget(required)).toBe(true)
  expect(f.driver.scratchBytes).toBe(table.bytes)
  expect(f.driver.hasActiveImageTableSource(f.image)).toBe(true)
  expect(f.resource.destroy).not.toHaveBeenCalled()
})
test('failed asynchronous preparation releases its source pin and allocates no GPU storage', async () => {
  const f = fixture(), preparing = f.driver.prepareImageTable(f.image, f.plan, 256 * 1024 * 1024)
  expect(f.driver.hasActiveImageTableSource(f.image)).toBe(true)
  f.fail(); await expect(preparing).rejects.toThrow('pipeline failed')
  expect(f.driver.hasActiveImageTableSource(f.image)).toBe(false); expect(f.buffers).toHaveLength(0)
  f.renderer.evictImages(f.image.bytes, true); expect(f.resource.destroy).toHaveBeenCalledOnce()
})
test.each([
  ['positive', [1, 2, 3, 1], true], ['signed zero', [-0, 0, 1, 1], true],
  ['negative subnormal', [-(2 ** -149), 1, 1, 1], false], ['negative normal', [-1, 1, 1, 1], false],
  ['negative alpha', [1, 2, 3, -1], true], ['HDR alpha', [1, 2, 3, 2], true],
] as const)('frozen handle derives its resolved sign proof from actual upload: %s', async (_name, rgba, expected) => {
  const f = fixture(4, 3, 8, 8, [...rgba]), pending = f.driver.prepareImageTable(f.image, f.plan, 256 * 1024 * 1024)
  f.ready(); const table = (await pending)!
  expect(table).toBeDefined(); expect(Object.isFrozen(table)).toBe(true)
  expect(table.nonnegativeResolved).toBe(expected ? true : undefined)
  expect(table.opaqueAlpha).toBe(rgba[3] === 1 ? true : undefined)
  await f.driver.retireImageTable(table)
})
test('explicit source retirement while preparation awaits invalidates the captured upload certificate', async () => {
  const f = fixture(), preparing = f.driver.prepareImageTable(f.image, f.plan, 256 * 1024 * 1024)
  f.driver.destroy(f.image); f.ready()
  await expect(preparing).rejects.toThrow('source retired')
  expect(f.buffers).toHaveLength(0); expect(f.driver.hasActiveImageTableSource(f.image)).toBe(false)
})
test.each([NaN, Infinity, -1, 1.5, 0])('invalid or insufficient available budget %s never pins or allocates', async available => {
  const f = fixture()
  expect(await f.driver.prepareImageTable(f.image, f.plan, available)).toBeUndefined()
  expect(f.driver.hasActiveImageTableSource(f.image)).toBe(false); expect(f.buffers).toHaveLength(0)
  f.ready()
})
const corruptions: [string, (plan: ExactImageXTablePlan) => void][] = [
  ['X cell', plan => { plan.x[0] = 999999 }], ['Y weight', plan => { plan.y[1] = 0xffffffff }],
  ['shape', plan => { plan.uniform[0] += 1 }], ['row count', plan => { plan.rowCount += 1 }],
  ['packed channel stride', plan => { plan.uniform[6] = 4 }], ['packed alpha proof', plan => { plan.uniform[7] = 0 }],
  ['storage size', plan => { plan.tableBytes = 16 }], ['limb bound', plan => { plan.maxKx = 127 }],
  ['shared metadata', plan => { const data = new Uint32Array(new SharedArrayBuffer(plan.x.byteLength)); data.set(plan.x); plan.x = data }],
]
test.each(corruptions)('a mutated legitimate plan cannot retain admission: %s', async (_name, mutate) => {
  const f = fixture(); mutate(f.plan)
  expect(imageXTablePlanRange(f.plan)).toBeUndefined()
  expect(await f.driver.prepareImageTable(f.image, f.plan, 256 * 1024 * 1024)).toBeUndefined()
  expect(f.driver.hasActiveImageTableSource(f.image)).toBe(false); expect(f.buffers).toHaveLength(0)
  f.ready()
})
test('post-admission caller changes cannot alter captured buffers or expose private storage through the handle', async () => {
  const f = fixture(), original = { x: f.plan.x.slice(), y: f.plan.y.slice(), uniform: f.plan.uniform.slice() }
  const pending = f.driver.prepareImageTable(f.image, f.plan, 256 * 1024 * 1024)
  f.plan.x.fill(0xffffffff); f.plan.y.fill(0xffffffff); f.plan.uniform[0] = 8192; f.plan.tableBytes = 16
  f.ready(); const handle = (await pending)!
  expect(handle.width).toBe(4); expect(handle.height).toBe(3)
  expect(f.writes).toEqual([original.uniform, original.x, original.y])
  expect(Object.isFrozen(handle)).toBe(true); expect(Object.isFrozen(handle.resource)).toBe(true)
  expect(Object.keys(handle.resource as object)).toEqual([])
  await f.driver.retireImageTable(handle)
})
test('axis metadata getter cannot mutate the private copy corresponding to the GPU upload', () => {
  const f = fixture(), field = { ...f.image, resource: {} } as Texture, original = f.axes[0].slice()
  ;(f.driver as any).textures.add(field); (f.driver as any).imageAxisPrograms.set(field, original)
  const exposed = f.driver.imageTableAxes(field)!
  exposed.fill(0)
  expect(f.driver.imageTableAxes(field)).toEqual(original)
  expect(exposed).not.toEqual(original)
  f.ready()
})

function rendererPreparation(f: ReturnType<typeof fixture>) {
  const { width, height, renderer } = f, input = { x: 0, y: 0, w: width, h: height }
  const header = 1 + height * 4, curves = new Float32Array((header + height * 12) * 4)
  curves.set([3, 1, width, height])
  for (let row = 0; row < height * 4; row++) {
    curves.set([header + row * 3, 1, 0, 0], 4 + row * 4)
    curves.set([0, width, 0, 0], (header + row * 3) * 4)
  }
  const node = { children: [], fills: [{ kind: 'image', image: 'source', blend: 'normal', opacity: 1, visible: true }],
    fill: { rect: input, count: 3, sampleCount: 4, area: { first: 0, count: curves.length / 4 } } }
  renderer.scene = { curves }
  renderer.imageFor = () => ({ texture: f.image, rect: { x: 0, y: 0, w: f.image.width, h: f.image.height } })
  const fields = f.axes.map(values => {
    const texture = { width, height: 2, bytes: values.byteLength, finitePixels: true, resource: {} } as Texture
    ;(f.driver as any).textures.add(texture); (f.driver as any).imageAxisPrograms.set(texture, values)
    return texture
  })
  renderer.imageGrid = () => ({ texture: fields[renderer.sampleIndex], rect: input })
  renderer.reclaimScratch = vi.fn(async () => { renderer.evictImages(f.image.bytes, true) })
  renderer.frameBudget = 256 * 1024 * 1024
  return { run: () => renderer.prepareFilterImageTable(node, input), input }
}
test('renderer pins before forced pre-admission reclaim and transfers ownership to the active driver table', async () => {
  const f = fixture(), preparation = rendererPreparation(f)
  f.ready(); const table = await preparation.run()
  expect(table).toBeDefined(); expect(f.resource.destroy).not.toHaveBeenCalled()
  expect(f.renderer.pendingImageTableSources.size).toBe(0)
  expect(f.driver.hasActiveImageTableSource(f.image)).toBe(true)
  await f.driver.retireImageTable(table)
  await checkpoint(f)
  f.renderer.evictImages(f.image.bytes, true); expect(f.resource.destroy).toHaveBeenCalledOnce()
})
test('pre-admission cancellation always releases the renderer pin', async () => {
  const f = fixture(), preparation = rendererPreparation(f)
  f.renderer.reclaimScratch = vi.fn(async () => { throw Error('PREVIEW_CANCELLED') })
  await expect(preparation.run()).rejects.toThrow('PREVIEW_CANCELLED')
  expect(f.renderer.pendingImageTableSources.size).toBe(0)
  expect(f.driver.hasActiveImageTableSource(f.image)).toBe(false)
  f.renderer.evictImages(f.image.bytes, true); expect(f.resource.destroy).toHaveBeenCalledOnce()
  f.ready()
})
test('default large table and explicit small fallback reserve strip headroom within the same ledger', async () => {
  const f = fixture(1024, 120, 1026, 122), preparation = rendererPreparation(f)
  expect(f.plan.tableBytes).toBeGreaterThan(16 * 1024 * 1024)
  expect(f.plan.tableBytes).toBeLessThan(32 * 1024 * 1024)
  f.ready()
  vi.stubEnv('VITE_DESIGN_EXACT_IMAGE_X_TABLE_LARGE', '0')
  expect(await preparation.run()).toBeUndefined(); expect(f.buffers).toHaveLength(0)
  vi.stubEnv('VITE_DESIGN_EXACT_IMAGE_X_TABLE_LARGE', undefined)
  const table = await preparation.run()
  expect(table).toBeDefined(); expect(f.resource.destroy).not.toHaveBeenCalled()
  expect(f.renderer.frameBudget).toBe(256 * 1024 * 1024)
  expect(f.renderer.bytes).toBe(f.image.bytes + table.bytes)
  expect(f.renderer.bytes).toBeLessThanOrEqual(f.renderer.frameBudget)
  await f.driver.retireImageTable(table)
  const limited = fixture(1024, 120, 1026, 122), retry = rendererPreparation(limited)
  limited.ready()
  const required = 256 + limited.plan.tableBytes + limited.plan.x.byteLength + limited.plan.y.byteLength
  const headroom = 1024 * 64 * 16 * 2 + 4 * 1024 * 1024
  limited.renderer.frameBudget = limited.image.bytes + required + headroom - 1
  expect(await retry.run()).toBeUndefined(); expect(limited.buffers).toHaveLength(0)
  expect(limited.renderer.pendingImageTableSources.size).toBe(0)
  expect(limited.driver.hasActiveImageTableSource(limited.image)).toBe(false)
  limited.renderer.evictImages(limited.image.bytes, true); expect(limited.resource.destroy).toHaveBeenCalledOnce()
})
