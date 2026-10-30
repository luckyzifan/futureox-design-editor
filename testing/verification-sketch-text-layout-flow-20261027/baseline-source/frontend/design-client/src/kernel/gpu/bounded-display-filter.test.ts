import { afterEach, expect, test, vi } from 'vitest'
import { WebGpuDriver } from './webgpu'
import { TexturePrefix } from './texture-prefix'
import { parameters, type GpuScene, type Texture } from './types'

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })
function fixture() {
  vi.stubGlobal('OffscreenCanvas', class {})
  vi.stubEnv('VITE_DESIGN_BOUNDED_DISPLAY_FILTER', '1')
  const chosen: any[] = [], descriptors: any[] = []
  const prefix = { encode: vi.fn((..._args: any[]) => true), lastRenderPasses: 2, scratchBytes: 0,
    canEncode: vi.fn(() => true), reserveScratch: vi.fn(), resetCounters: vi.fn() }
  const prefixCreate = vi.spyOn(TexturePrefix, 'create').mockResolvedValue(prefix as unknown as TexturePrefix)
  const shader = vi.fn((descriptor: GPUShaderModuleDescriptor) => ({ ...descriptor, getCompilationInfo: async () => ({ messages: [] as GPUCompilationMessage[] }) }))
  const device = { features: new Set(['float32-filterable']), createShaderModule: shader,
    createPipelineLayout: vi.fn(() => ({})), createRenderPipelineAsync: vi.fn(async (descriptor: any) => { descriptors.push(descriptor); return descriptor }),
    createSampler: vi.fn(), pushErrorScope: vi.fn(), popErrorScope: vi.fn(async () => null) }
  const driver = new WebGpuDriver(true), raw = driver as any
  Object.assign(raw, { device, layout: {}, prefixEnabled: true, pipelines: { prepare: async () => undefined, register() {} },
    blank: { width: 1, height: 1, resource: {} },
    modePipelines: new Map([[12, {}]]), closeOver() {}, bind: () => ({ group: {}, offsets: [] }),
    bindingCache: { view: () => ({}) }, encoder: { beginRenderPass: () => ({ setPipeline: (p: any) => chosen.push(p), setBindGroup() {}, setScissorRect() {}, draw() {}, end() {} }) } })
  const texture = (): Texture => ({ width: 80, height: 7, bytes: 80 * 7 * 16, resource: {} as GPUTexture })
  const scene = (limit: number | undefined = 32, enabled = true) => ({ nodes: {}, displayFilters: enabled, displayFilterRadiusLimit: limit }) as unknown as GpuScene
  const pass = (radius: number, channels = 15, metadata = true, change?: (u: Float32Array, target: Texture, source: Texture) => void) => {
    const u = parameters({ x: 0, y: 0, w: 80, h: 7 }); u[16] = 22; u.set([radius, 0, 0, 1], 36)
    const target = texture(), source = texture(); change?.(u, target, source)
    driver.pass(target, u, [source, texture()], undefined, channels, metadata ? { kind: 'tent', radius } : undefined)
    return target
  }
  return { driver, raw, device, shader, prefix, prefixCreate, descriptors, chosen, texture, scene, pass }
}

test('bounded preparation keeps display, exact RGBA/scalar and prefix ready on the same device; pairing stays off', async () => {
  const f = fixture(); await f.driver.prepareScene(f.scene()); await f.driver.prepareFilters(true)
  expect(f.descriptors.filter(d => d.fragment.module.label === 'Canvas integrated tent')).toHaveLength(1)
  expect(f.descriptors.filter(d => d.fragment.module.label === 'Exact rational filter')).toHaveLength(5)
  expect(f.prefixCreate).toHaveBeenCalledTimes(1); expect(f.device.createSampler).not.toHaveBeenCalled()
  expect(f.raw.filterPipelines).toHaveLength(4); expect(f.raw.scalarFilterPipeline).toBeDefined()
  await f.driver.prepareFilters(true)
  expect(f.descriptors).toHaveLength(6); expect(f.prefixCreate).toHaveBeenCalledTimes(1)
  for (const radius of [.1, .3, 1, 19.129743576049805, 31.999, 32]) {
    expect(f.driver.usesDisplayFilter(radius)).toBe(true)
    const target = f.pass(radius)
    expect(f.chosen.at(-1).fragment.module.label).toBe('Canvas integrated tent')
    expect(target.opaqueAlpha).toBeUndefined(); expect(target.finitePixels).toBeUndefined()
  }
  expect(f.driver.boundedDisplayFilterPasses).toBe(6); expect(f.prefix.encode).not.toHaveBeenCalled()
  expect(f.device.pushErrorScope).toHaveBeenCalledTimes(2); expect(f.device.popErrorScope).toHaveBeenCalledTimes(2)
})

test('large radii keep prefix and original opaque admission; unsupported prefix uses exact scalar channels', async () => {
  const f = fixture(); await f.driver.prepareScene(f.scene()); await f.driver.prepareFilters(true)
  for (const radius of [32 + 2 ** -30, 38.25948715209961, 64, 1224.3035888671875]) {
    expect(f.driver.usesDisplayFilter(radius)).toBe(false); f.pass(radius)
  }
  expect(f.prefix.encode).toHaveBeenCalledTimes(4); expect(f.chosen).toHaveLength(0)
  f.prefix.encode.mockReturnValueOnce(false)
  f.pass(64)
  expect(f.chosen).toHaveLength(4)
  expect(f.chosen.every(p => p.fragment.module.label === 'Exact rational filter')).toBe(true)
  expect(f.driver.boundedDisplayFilterPasses).toBe(0)
  const opaque = f.pass(64, 15, true, (u, _target, source) => {
    source.opaqueAlpha = true; u[0] = 65; u[2] = 16; u[6] = 146
  })
  expect(f.prefix.encode.mock.calls.at(-1)?.[7]).toBe(7)
  expect(f.prefix.encode.mock.calls.at(-1)?.[9]).toBe(true)
  expect(opaque.opaqueAlpha).toBe(true)
})

test('the original double radius and tent metadata prevent rounded boundaries or unrelated kernels from entering display', async () => {
  const f = fixture(); await f.driver.prepareScene(f.scene()); await f.driver.prepareFilters(true)
  expect(Math.fround(32 + 2 ** -30)).toBe(32)
  f.pass(32 + 2 ** -30); expect(f.prefix.encode).toHaveBeenCalledTimes(1)
  expect(f.driver.usesDisplayFilter(1 + 2 ** -30)).toBe(false)
  expect(f.driver.usesDisplayFilter(2 ** -150)).toBe(false)
  f.pass(1 + 2 ** -30); expect(f.chosen.at(-1).fragment.module.label).toBe('Exact rational filter')
  f.pass(19, 15, false); expect(f.chosen.at(-1).fragment.module.label).toBe('Exact rational filter')
  f.pass(19, 15, true, u => { u[36] = 18 }); expect(f.chosen.at(-1).fragment.module.label).toBe('Exact rational filter')
  expect(f.driver.usesDisplayFilter(19, 8)).toBe(false)
  f.pass(19, 8); expect(f.chosen.at(-1).fragment.constants.FILTER_CHANNEL).toBe(3)
  expect(f.driver.boundedDisplayFilterPasses).toBe(0)
  expect(() => f.pass(19, 15, true, (_u, target) => { target.scalarCoverage = true })).toThrow('ordinary RGBA')
  expect(() => f.pass(19, 15, true, (_u, _target, source) => { source.binaryCoverage = true })).toThrow('ordinary RGBA')
})

test('flag-off, invalid limits, HDR, global native math and exact-output scenes all decline bounded display', async () => {
  for (const variant of ['off', 'zero', 'negative', 'too-large', 'nan', 'infinite', 'hdr', 'math', 'exact-output'] as const) {
    const f = fixture()
    if (variant === 'off') vi.stubEnv('VITE_DESIGN_BOUNDED_DISPLAY_FILTER', '0')
    if (variant === 'hdr') f.raw.hdr = true
    if (variant === 'math') f.raw.displayMath = true
    const limits = { zero: 0, negative: -1, 'too-large': 33, nan: NaN, infinite: Infinity }
    await f.driver.prepareScene(f.scene(variant in limits ? limits[variant as keyof typeof limits] : 32, variant !== 'exact-output'))
    await f.driver.prepareFilters(true)
    expect(f.driver.usesDisplayFilter(19), variant).toBe(false)
    expect(f.descriptors.every(d => d.fragment.module.label === 'Exact rational filter'), variant).toBe(true)
    f.prefixCreate.mockRestore()
  }
})

test('a bounded shader failure preserves exact readiness and does not repeat compilation or enable a later exact scene', async () => {
  const f = fixture(), warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  f.shader.mockImplementation(descriptor => ({ ...descriptor, getCompilationInfo: async () => ({ messages: descriptor.label === 'Canvas integrated tent'
    ? [{ type: 'error', lineNum: 1, message: 'fixture optional shader failure' } as GPUCompilationMessage] : [] }) }))
  await f.driver.prepareScene(f.scene()); await f.driver.prepareFilters(true)
  expect(f.driver.usesDisplayFilter(19)).toBe(false); expect(f.raw.filterPipelines).toHaveLength(4)
  await f.driver.prepareScene(f.scene()); await f.driver.prepareFilters(true)
  expect(f.shader.mock.calls.filter(([d]) => d.label === 'Canvas integrated tent')).toHaveLength(1)
  expect(warn).toHaveBeenCalledTimes(1)
  await f.driver.prepareScene(f.scene(32, false)); f.pass(19)
  expect(f.chosen.at(-1).fragment.module.label).toBe('Exact rational filter')
})
