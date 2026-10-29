import { afterEach, expect, test, vi } from 'vitest'
import { WebGpuDriver } from './webgpu'
import { GpuRenderer } from './renderer'
import type { GpuNode, GpuScene, PathMesh, Texture } from './types'

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

function fixture(packed: string | undefined | null = '1') {
  vi.stubEnv('VITE_DESIGN_SAMPLE_ONLY_COVERAGE', '1')
  vi.stubEnv('VITE_DESIGN_PACKED_COVERAGE', packed ?? undefined)
  vi.stubGlobal('OffscreenCanvas', class {})
  vi.stubGlobal('GPUBufferUsage', { STORAGE: 128, COPY_DST: 8, COPY_SRC: 4, VERTEX: 32 })
  const passes: any[] = [], descriptors: any[] = [], uniforms: Float32Array[] = []
  const driver = new WebGpuDriver(true), raw = driver as any
  const device = {
    createBuffer: ({ size }: any) => ({ size, data: new Uint8Array(size), destroy() {} }),
    createCommandEncoder: () => ({ copyBufferToBuffer() {}, finish: () => ({}),
      beginRenderPass: (descriptor: any) => { const pass = { descriptor, chosen: undefined as any, draws: 0,
        setPipeline(value: any) { this.chosen = value }, setBindGroup() {}, setScissorRect() {},
        draw() { this.draws++ }, end() {} }; passes.push(pass); return pass } }),
    queue: { writeBuffer() {}, submit() {} }, pushErrorScope: vi.fn(), popErrorScope: vi.fn(async () => null),
    createPipelineLayout: vi.fn(() => ({})),
    createShaderModule: (d: any) => ({ ...d, getCompilationInfo: async () => ({ messages: [] }) }),
    createRenderPipelineAsync: vi.fn(async (d: any) => { descriptors.push(d); return d }),
  }
  Object.assign(raw, { device, layout: {}, captureDisplay: true, areaPipeline: { legacy: 'color' },
    binaryAreaPipeline: { legacy: 'binary' }, scalarAreaPipeline: { legacy: 'scalar' }, closeOver() {},
    bind: (u: Float32Array) => { uniforms.push(u.slice()); return { group: {}, offsets: [] } },
    pipelines: { prepare: vi.fn(async () => undefined), register() {} },
    modePipelines: new Map(Array.from({ length: 80 }, (_, i) => [i, {}])) })
  vi.spyOn(raw.bindingCache, 'view').mockImplementation((resource: any) => resource)
  const curves = new Float32Array(12 * 4)
  curves.set([4, 0, 8, 2], 5 * 4)
  curves.set([0, 8, 0, 0, 0, 2, 0, 0], 6 * 4)
  const path: PathMesh = { area: { first: 5, count: 7, fingerprint: [1, 2] }, first: 0, count: 3,
    sampleCount: 4, rule: 'nonzero', rect: { x: -2, y: 3, w: 8, h: 2 } }
  const scene = { coherentSamples: true, curves, nodes: { leaf: { fill: path, strokes: [], effects: [], fills: [], children: [] } },
    roots: ['leaf'], background: '#fff', transparent: false, grid: false } as unknown as GpuScene
  const target = (width = 8, height = 2, format = 'rgba8unorm') => {
    const texture = { width, height, bytes: width * height * 4, binaryCoverage: true,
      resource: { format, width, height } } as unknown as Texture
    raw.textures.add(texture); raw.byteTentTextures.set(texture, { resource: texture.resource, width, height, format })
    return texture
  }
  const begin = async (displayOnly = true) => { await driver.prepareScene(scene, displayOnly); driver.begin(new Float32Array(0), curves) }
  return { driver, raw, device, passes, descriptors, uniforms, curves, path, scene, target, begin }
}

test('four fresh binary targets use one four-attachment pass with the original program and pixel origin', async () => {
  const f = fixture(); await f.begin()
  const targets = [f.target(), f.target(), f.target(), f.target()]
  expect(f.driver.maskAll(f.path, targets)).toBe(true)
  expect(f.descriptors).toHaveLength(4); expect(f.passes).toHaveLength(1)
  expect(f.passes[0].descriptor.colorAttachments).toHaveLength(4)
  expect(f.passes[0].chosen.fragment.entryPoint).toBe('areaSamplesFragment')
  expect(f.passes[0].chosen.fragment.targets).toHaveLength(4); expect(f.passes[0].draws).toBe(1)
  expect(f.uniforms[0].slice(36, 44)).toEqual(new Float32Array([0, 0, 0, 0, 0, 0, 8, 2]))
  expect(f.driver.packedCoveragePasses).toBe(1); expect(f.driver.triangles).toBe(1)
})

test('regional four-phase coverage keeps the global interval origin', async () => {
  const f = fixture(); await f.begin()
  const region = { x: 1, y: 4, w: 3, h: 1 }, targets = [f.target(3, 1), f.target(3, 1), f.target(3, 1), f.target(3, 1)]
  expect(f.driver.maskAll(f.path, targets, region)).toBe(true)
  expect(f.uniforms[0].slice(40, 44)).toEqual(new Float32Array([3, 1, 8, 2]))
})

test.each([null, '0'])('packed flag %s declines without encoding', async flag => {
  const f = fixture(flag); await f.begin()
  expect(f.driver.maskAll(f.path, [f.target(), f.target(), f.target(), f.target()])).toBe(false)
  expect(f.passes).toHaveLength(0); expect(f.driver.packedCoveragePasses).toBe(0)
})

test('non-display, duplicate, foreign and wrong-format targets decline before any draw', async () => {
  const f = fixture(); await f.begin(false)
  const targets = [f.target(), f.target(), f.target(), f.target()]
  expect(f.driver.maskAll(f.path, targets)).toBe(false)
  await f.begin()
  expect(f.driver.maskAll(f.path, [targets[0], targets[0], targets[1], targets[2]])).toBe(false)
  const foreign = f.target(); f.raw.textures.delete(foreign)
  expect(f.driver.maskAll(f.path, [targets[0], targets[1], targets[2], foreign])).toBe(false)
  const wrong = f.target(8, 2, 'r32float')
  expect(f.driver.maskAll(f.path, [targets[0], targets[1], targets[2], wrong])).toBe(false)
  expect(f.passes).toHaveLength(0); expect(f.driver.packedCoveragePasses).toBe(0)
})

test('a changed uploaded header cannot reuse the previous four-phase proof', async () => {
  const f = fixture(); await f.begin()
  expect(f.driver.maskAll(f.path, [f.target(), f.target(), f.target(), f.target()])).toBe(true)
  f.curves[20] = 1; f.driver.begin(new Float32Array(0), f.curves)
  expect(f.driver.maskAll(f.path, [f.target(), f.target(), f.target(), f.target()])).toBe(false)
  expect(f.driver.packedCoveragePasses).toBe(1)
})

test('packed preparation failure retains the exact fallback and settles every pipeline job', async () => {
  const f = fixture(); vi.spyOn(console, 'warn').mockImplementation(() => {})
  f.device.createRenderPipelineAsync.mockImplementation(async descriptor => {
    if (descriptor.fragment.targets.length === 4) throw Error('unsupported four attachments')
    return descriptor
  })
  await f.begin()
  expect(f.raw.sampleOnlyUnavailable).toBe(true)
  expect(f.driver.maskAll(f.path, [f.target(), f.target(), f.target(), f.target()])).toBe(false)
  expect(f.passes).toHaveLength(0)
})

function rendererFixture(maskAllResult: boolean) {
  const curves = new Float32Array(7 * 4)
  curves.set([4, 0, 8, 2], 0)
  curves.set([0, 8, 0, 0, 0, 2, 0, 0], 4)
  const path: PathMesh = { area: { first: 0, count: 7 }, first: 0, count: 3, sampleCount: 4,
    rule: 'nonzero', rect: { x: 0, y: 0, w: 8, h: 2 } }
  const node = { id: 'leaf', fill: path, fills: [], strokes: [], effects: [], children: [] } as unknown as GpuNode
  const createBinaryCoverage = (width: number, height: number) => ({ width, height, bytes: width * height * 4,
    binaryCoverage: true, resource: { format: 'rgba8unorm', width, height } }) as Texture
  const driver = { name: 'webgpu', managed: true, createBinaryCoverage,
    maskAll: vi.fn(() => maskAllResult), mask: vi.fn(), clear: vi.fn(), pass: vi.fn(), destroy: vi.fn() }
  const renderer = new GpuRenderer(driver as any, true, false) as any
  renderer.scene = { coherentSamples: true, curves }
  renderer.curveBits = new Uint32Array(curves.buffer)
  return { renderer, driver, node }
}

test('renderer batches only four fresh masks and reuses cached phases without rewriting them', async () => {
  const f = rendererFixture(true)
  const first = await f.renderer.maskFour(f.node)
  expect(first).toHaveLength(4); expect(f.driver.maskAll).toHaveBeenCalledOnce(); expect(f.driver.mask).not.toHaveBeenCalled()
  const second = await f.renderer.maskFour(f.node)
  expect(second).toHaveLength(4); expect(f.driver.maskAll).toHaveBeenCalledOnce(); expect(f.driver.mask).not.toHaveBeenCalled()
})

test('renderer falls back to four original mask calls when the packed driver declines', async () => {
  const f = rendererFixture(false)
  await f.renderer.maskFour(f.node)
  expect(f.driver.maskAll).toHaveBeenCalledOnce(); expect(f.driver.mask).toHaveBeenCalledTimes(4)
  expect(f.driver.mask.mock.calls.map(call => call[2])).toEqual([0, 1, 2, 3])
})
