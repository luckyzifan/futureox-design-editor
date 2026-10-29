// Actual driver begin/relocation/mask/pass code over a recording device. This
// executes no WGSL and proves no GPU byte equality or speedup.
import { afterEach, expect, test, vi } from 'vitest'
import { WebGpuDriver } from './webgpu'
import { parameters, type GpuScene, type PathMesh, type Texture } from './types'
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })
function fixture(flag: string | undefined, managed = true, header: 3 | 4 = 4) {
  vi.stubEnv('VITE_DESIGN_SAMPLE_ONLY_COVERAGE', flag)
  vi.stubGlobal('OffscreenCanvas', class {})
  vi.stubGlobal('GPUBufferUsage', { STORAGE: 128, COPY_DST: 8, COPY_SRC: 4, VERTEX: 32 })
  const chosen: any[] = [], uniforms: Float32Array[] = [], descriptors: any[] = [], writes: any[] = []
  const driver = new WebGpuDriver(managed), raw = driver as any
  const buffer = ({ size }: any) => ({ size, data: new Uint8Array(size), destroy() {} })
  const device = { createBuffer: buffer, createCommandEncoder: () => ({ copyBufferToBuffer() {}, finish: () => ({}),
    beginRenderPass: () => ({ setPipeline: (p: any) => chosen.push(p), setBindGroup() {}, setScissorRect() {}, draw() {}, end() {} }) }),
    queue: { writeBuffer: (b: any, offset: number, data: Uint32Array) => { b.data.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset); writes.push({ b, offset, bytes: data.byteLength }) }, submit() {} },
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(async () => null), createPipelineLayout: vi.fn(() => ({})),
    createShaderModule: (d: any) => ({ ...d, getCompilationInfo: async () => ({ messages: [] }) }),
    createRenderPipelineAsync: vi.fn(async (d: any) => { descriptors.push(d); return d }) }
  Object.assign(raw, { device, layout: {}, captureDisplay: true, areaPipeline: { legacy: 'color' },
    binaryAreaPipeline: { legacy: 'binary' }, scalarAreaPipeline: { legacy: 'scalar' }, closeOver() {},
    bind: (u: Float32Array) => { uniforms.push(u.slice()); return { group: {}, offsets: [] } },
    pipelines: { prepare: vi.fn(async () => undefined), register() {} },
    modePipelines: new Map(Array.from({ length: 80 }, (_, i) => [i, {}])) })
  vi.spyOn(raw.bindingCache, 'view').mockReturnValue({} as GPUTextureView)
  const count = header === 4 ? 7 : 33, curves = new Float32Array((5 + count) * 4)
  curves.set([header, header === 4 ? 0 : 1, 8, 2], 5 * 4)
  if (header === 4) curves.set([0, 8, 0, 0, 0, 2, 0, 0], 6 * 4)
  else for (let row = 0; row < 8; row++) {
    const span = 9 + row * 3
    curves.set([span, 1, 0, 0], 6 * 4 + row * 4); curves.set([0, 8, 0, 0], (5 + span) * 4)
  }
  const path: PathMesh = { area: { first: 5, count, fingerprint: [1, 2] }, first: 0, count: 3,
    sampleCount: 4, rule: 'nonzero', rect: { x: -2, y: 3, w: 8, h: 2 } }
  const scene = (extra = {}) => ({ coherentSamples: true, curves, nodes: { leaf: { fill: path, strokes: [], effects: [], fills: [], children: [] } },
    roots: ['leaf'], background: '#fff', transparent: false, grid: false, ...extra }) as unknown as GpuScene
  const target = (kind: 'scalar' | 'binary' | 'color' = 'scalar', owned = true) => {
    const format = kind === 'scalar' ? 'r32float' : kind === 'binary' || !managed ? 'rgba8unorm' : 'rgba32float'
    const texture = { width: 8, height: 2, bytes: 8 * 2 * (format === 'rgba32float' ? 16 : 4), resource: { format, width: 8, height: 2 },
      ...(kind === 'scalar' ? { scalarCoverage: true } : kind === 'binary' ? { binaryCoverage: true } : {}) } as unknown as Texture
    if (owned) {
      raw.textures.add(texture)
      raw.byteTentTextures.set(texture, { resource: texture.resource, width: texture.width, height: texture.height, format })
    }
    return texture
  }
  const begin = async (extra = {}, displayOnly = true) => { await driver.prepareScene(scene(extra), displayOnly); driver.begin(new Float32Array(0), curves) }
  return { driver, raw, device, chosen, uniforms, descriptors, writes, curves, path, scene, target, begin }
}

test('actual private resident upload/remap dispatches all four sample indices and counts only encoded draws', async () => {
  const f = fixture('1'); await f.begin()
  expect(f.raw.programOffsets.get(5)).toBe(0); expect(f.descriptors).toHaveLength(3)
  expect(f.raw.sampleOnlyCoveragePasses).toBe(0); expect(f.raw.pipelines.prepare).toHaveBeenCalled()
  for (const kind of ['scalar', 'binary', 'color'] as const) for (let phase = 0; phase < 4; phase++) f.driver.mask(f.path, f.target(kind), phase)
  expect(f.chosen).toHaveLength(12); expect(f.chosen.every(p => p.fragment.entryPoint === 'areaSampleFragment')).toBe(true)
  expect(f.raw.sampleOnlyCoveragePasses).toBe(12); expect(f.raw.sampleOnlyCoveragePixels).toBe(12 * 16)
  expect(f.uniforms.map(u => u[36])).toEqual(Array(12).fill(0))
  expect(f.raw.sampleOnlyDispatch).toBeUndefined(); expect(f.writes.length).toBeGreaterThan(0)
})

test('sparse flag specializes the sample pipelines without changing their dispatch contract', async () => {
  vi.stubEnv('VITE_DESIGN_SPARSE_COVERAGE', '1')
  const f = fixture('1'); await f.begin()
  expect(f.descriptors).toHaveLength(3)
  expect(f.descriptors.every(descriptor => descriptor.fragment.constants.SPARSE_COVERAGE === true)).toBe(true)
  f.driver.mask(f.path, f.target(), 0)
  expect(f.chosen.at(-1).fragment.entryPoint).toBe('areaSampleFragment')
})

test('reference changes only the private enable bit; buffer and exact sample uniforms remain unchanged', async () => {
  const f = fixture('1'); await f.begin(); const target = f.target(), buffer = f.raw.curves
  f.driver.mask(f.path, target, 2); const original = f.uniforms.at(-1)
  f.raw.sampleOnlyCoverageEnabled = false; f.driver.mask(f.path, target, 2)
  expect(f.uniforms.at(-1)).toEqual(original); expect(f.raw.curves).toBe(buffer)
  expect(f.chosen.at(-1)).toEqual({ legacy: 'scalar' }); expect(f.raw.sampleOnlyCoveragePasses).toBe(1)
})

test('bitmap display intent works without resident capture; lifetime hits survive a cached frame and exact preparations', async () => {
  const f = fixture('1'); f.raw.captureDisplay = false
  await f.begin(); f.driver.mask(f.path, f.target(), 0)
  expect(f.raw.captureDisplay).toBe(false); expect(f.raw.sampleOnlyCoveragePasses).toBe(1)
  expect(f.raw.sampleOnlyCoverageLifetimePasses).toBe(1); expect(f.raw.sampleOnlyCoverageLifetimePixels).toBe(16)
  expect(f.raw.sampleOnlyCoverageEligibleScenes).toBe(1)
  await f.begin()
  expect(f.raw.sampleOnlyCoveragePasses).toBe(0); expect(f.raw.sampleOnlyCoverageLifetimePasses).toBe(1)
  expect(f.raw.sampleOnlyCoverageEligibleScenes).toBe(2)
  await f.driver.prepareScene(f.scene()) // omitted intent defaults to exact even with a cached pipeline
  f.driver.begin(new Float32Array(0), f.curves); f.driver.mask(f.path, f.target(), 0)
  expect(f.chosen.at(-1)).toEqual({ legacy: 'scalar' })
  expect(f.raw.sampleOnlyCoverageLifetimePasses).toBe(1); expect(f.raw.sampleOnlyCoverageEligibleScenes).toBe(2)
  expect(f.driver.stats()).toMatchObject({ sampleOnlyCoveragePasses: 0, sampleOnlyCoverageLifetimePasses: 1,
    sampleOnlyCoverageLifetimePixels: 16, sampleOnlyCoverageEligibleScenes: 2 })
})

test.each([undefined, '1', 'true', '01'])('default and enabled flag %s select sample-only preparation/dispatch', async flag => {
  const f = fixture(flag); await f.begin(); f.driver.mask(f.path, f.target(), 0)
  expect(f.descriptors).toHaveLength(3); expect(f.chosen.at(-1).fragment.entryPoint).toBe('areaSampleFragment')
  expect(f.raw.sampleOnlyCoveragePasses).toBe(1)
})

test('explicit 0 leaves original area preparation/dispatch', async () => {
  const f = fixture('0'); await f.begin(); f.driver.mask(f.path, f.target(), 0)
  expect(f.descriptors).toHaveLength(0); expect(f.chosen.at(-1)).toEqual({ legacy: 'scalar' }); expect(f.raw.sampleOnlyCoveragePasses).toBe(0)
})

test.each(['non-coherent', 'software', 'HDR', 'no-display-intent', 'resolve', 'pixel-presentation', 'grid', 'checker'])('%s scene/transport cannot select the sample-only display candidate', async variant => {
  const f = fixture('1'); if (variant === 'HDR') f.raw.hdr = true
  const extra = variant === 'non-coherent' ? { coherentSamples: false } : variant === 'software' ? { softwareRaster: true } :
    variant === 'resolve' ? { resolve: {} } : variant === 'pixel-presentation' ? { presentation: {} } :
    variant === 'grid' ? { grid: true } : variant === 'checker' ? { checkerboard: true } : {}
  await f.begin(extra, variant !== 'no-display-intent'); f.driver.mask(f.path, f.target(), 0)
  expect(f.chosen.at(-1)).toEqual({ legacy: 'scalar' }); expect(f.raw.sampleOnlyCoveragePasses).toBe(0)
})

test('direct mode31, missing phase, foreign target/remap and next prepare without begin all keep the original pipeline', async () => {
  const f = fixture('1'); await f.begin(); const target = f.target(), u = parameters(f.path.rect); u[16] = 31; u[38] = 1
  f.driver.pass(target, u, []); f.driver.mask(f.path, target); f.driver.mask(f.path, f.target('scalar', false), 0)
  f.raw.programOffsets.set(5, 1); f.driver.mask(f.path, target, 0); f.raw.programOffsets.set(5, 0)
  await f.driver.prepareScene(f.scene()); f.driver.mask(f.path, target, 0)
  expect(f.chosen).toEqual(Array(5).fill({ legacy: 'scalar' })); expect(f.raw.sampleOnlyCoveragePasses).toBe(0)
})

test('native header changes at a new upload and disabled residency cannot use old sample proof', async () => {
  const f = fixture('1'); await f.begin(); f.driver.mask(f.path, f.target(), 0); expect(f.raw.sampleOnlyCoveragePasses).toBe(1)
  f.curves[20] = 1; f.driver.begin(new Float32Array(0), f.curves); f.driver.mask(f.path, f.target(), 0)
  expect(f.chosen.at(-1)).toEqual({ legacy: 'scalar' }); expect(f.raw.sampleOnlyCoveragePasses).toBe(0)
  vi.stubEnv('VITE_DESIGN_PROGRAM_RESIDENCY', '0'); await f.begin(); f.driver.mask(f.path, f.target(), 0)
  expect(f.chosen.at(-1)).toEqual({ legacy: 'scalar' })
})

test('failed shader preparation settles all jobs and retains the original pipeline without counting eligibility', async () => {
  const f = fixture('1'); vi.spyOn(console, 'warn').mockImplementation(() => {})
  f.device.createRenderPipelineAsync.mockImplementation(async d => { if (d.fragment.targets[0].format === 'r32float') throw Error('unsupported candidate'); return d })
  await f.begin(); f.driver.mask(f.path, f.target(), 0)
  expect(f.device.createRenderPipelineAsync).toHaveBeenCalledTimes(3); expect(f.raw.sampleOnlyUnavailable).toBe(true)
  expect(f.chosen.at(-1)).toEqual({ legacy: 'scalar' }); expect(f.raw.sampleOnlyCoveragePasses).toBe(0)
  expect(f.device.popErrorScope).toHaveBeenCalledTimes(5)
})

test('optional pipeline validation scopes are popped before parallel compilation yields and failure waits for every job', async () => {
  const f = fixture('1'); vi.spyOn(console, 'warn').mockImplementation(() => {})
  let open = 0, maximum = 0
  f.device.pushErrorScope.mockImplementation(() => { open++; maximum = Math.max(maximum, open) })
  f.device.popErrorScope.mockImplementation(async () => { open--; return null })
  const jobs: { descriptor: any; resolve: (value: any) => void; reject: (error: Error) => void }[] = []
  f.device.createRenderPipelineAsync.mockImplementation(descriptor => new Promise((resolve, reject) => jobs.push({ descriptor, resolve, reject })))
  let completed = false
  const preparing = f.driver.prepareScene(f.scene(), true).then(() => { completed = true })
  for (let i = 0; i < 200 && jobs.length !== 3; i++) await Promise.resolve()
  expect(jobs).toHaveLength(3); expect(open).toBe(0); expect(maximum).toBe(1)
  jobs[0].reject(Error('unsupported candidate format')); jobs[1].resolve(jobs[1].descriptor)
  for (let i = 0; i < 16; i++) await Promise.resolve()
  expect(completed).toBe(false); expect(f.raw.sampleOnlyScalarPipeline).toBeUndefined()
  jobs[2].resolve(jobs[2].descriptor); await preparing
  expect(open).toBe(0); expect(f.raw.sampleOnlyUnavailable).toBe(true); expect(f.raw.sampleOnlyScalarPipeline).toBeUndefined()
})

test('throwing pass clears the private dispatch witness so a foreign later mode31 cannot inherit it', async () => {
  const f = fixture('1'); await f.begin(); const target = f.target(), pass = vi.spyOn(f.driver, 'pass').mockImplementationOnce(() => { throw Error('injected encode failure') })
  expect(() => f.driver.mask(f.path, target, 0)).toThrow('injected encode failure'); expect(f.raw.sampleOnlyDispatch).toBeUndefined()
  pass.mockRestore(); const u = parameters(f.path.rect); u[16] = 31; u[38] = 1; f.driver.pass(target, u, [])
  expect(f.chosen.at(-1)).toEqual({ legacy: 'scalar' }); expect(f.raw.sampleOnlyCoveragePasses).toBe(0)
})

test.each([true, false])('known managed=%s normal targets use their actual storage pipeline for all four phases', async managed => {
  const f = fixture('1', managed); await f.begin()
  for (let phase = 0; phase < 4; phase++) f.driver.mask(f.path, f.target('color'), phase)
  expect(f.chosen).toHaveLength(4)
  expect(f.chosen.every(p => p.fragment.entryPoint === 'areaSampleFragment' &&
    p.fragment.targets[0].format === (managed ? 'rgba32float' : 'rgba8unorm'))).toBe(true)
  expect(f.uniforms.map(u => u[38])).toEqual([1, 2, 3, 4])
  expect(f.raw.sampleOnlyCoveragePasses).toBe(4); expect(f.raw.sampleOnlyCoverageEligibleScenes).toBe(1)
})

test.each([3, 4] as const)('unmanaged bitmap display accepts private uploaded header%s and preserves the original four-phase uniforms', async header => {
  const f = fixture('1', false, header); f.raw.captureDisplay = false; await f.begin()
  const target = f.target('color'), buffer = f.raw.curves
  for (let phase = 0; phase < 4; phase++) f.driver.mask(f.path, target, phase)
  const original = f.uniforms.map(u => u.slice())
  f.raw.sampleOnlyCoverageEnabled = false
  for (let phase = 0; phase < 4; phase++) f.driver.mask(f.path, target, phase)
  expect(f.uniforms.slice(4)).toEqual(original); expect(f.raw.curves).toBe(buffer)
  expect(f.chosen.slice(0, 4).every(p => p.fragment.targets[0].format === 'rgba8unorm')).toBe(true)
  expect(f.chosen.slice(4)).toEqual(Array(4).fill({ legacy: 'color' }))
  expect(f.raw.sampleOnlyCoveragePasses).toBe(4)
})

test.each(['rgba32float', 'r32float', 'bgra8unorm', 'wrong-bytes', 'wrong-dimensions', 'swapped-resource',
  'missing-creation-proof', 'foreign-target', 'binary-flag', 'scalar-flag', 'conflicting-flags'] as const)(
  'unmanaged %s target cannot select the byte sample pipeline', async variant => {
    const f = fixture('1', false); await f.begin()
    const target = f.target(variant === 'scalar-flag' ? 'scalar' : variant === 'binary-flag' ? 'binary' : 'color', variant !== 'foreign-target')
    const resource = target.resource as any
    if (variant === 'rgba32float' || variant === 'r32float' || variant === 'bgra8unorm') resource.format = variant
    if (variant === 'wrong-bytes') target.bytes++
    if (variant === 'wrong-dimensions') resource.width++
    if (variant === 'swapped-resource') target.resource = { ...resource }
    if (variant === 'missing-creation-proof') f.raw.byteTentTextures.delete(target)
    if (variant === 'conflicting-flags') { target.scalarCoverage = true; target.binaryCoverage = true }
    f.driver.mask(f.path, target, 0)
    expect(f.chosen.at(-1)).toEqual({ legacy: variant === 'scalar-flag' || variant === 'conflicting-flags' ? 'scalar' : variant === 'binary-flag' ? 'binary' : 'color' })
    expect(f.raw.sampleOnlyCoveragePasses).toBe(0)
  })

test.each([undefined, 0, 'false'])('unknown managed runtime value %s cannot grant sample-only display intent', async managed => {
  const f = fixture('1', false); f.raw.managed = managed; await f.begin(); f.driver.mask(f.path, f.target('color'), 0)
  expect(f.raw.sampleOnlyRequested).toBe(false); expect(f.descriptors).toHaveLength(0)
  expect(f.chosen.at(-1)).toEqual({ legacy: 'color' }); expect(f.raw.sampleOnlyCoverageEligibleScenes).toBe(0)
})

test.each(['rgba8unorm', 'r32float', 'bgra8unorm'] as const)('a normal managed target cannot be reclassified as %s storage', async format => {
  const f = fixture('1', true); await f.begin(); const target = f.target('color')
  ;(target.resource as any).format = format
  // Even a correctly recorded foreign-format allocation is not a normal
  // RGBA32 managed target. No inferred truthiness may select a byte pipeline.
  f.raw.byteTentTextures.set(target, { resource: target.resource, width: 8, height: 2, format })
  f.driver.mask(f.path, target, 0)
  expect(f.chosen.at(-1)).toEqual({ legacy: 'color' }); expect(f.raw.sampleOnlyCoveragePasses).toBe(0)
})

test.each(['non-coherent', 'software', 'HDR', 'no-display-intent', 'resolve', 'pixel-presentation', 'grid', 'checker'])(
  'unmanaged %s keeps the original RGBA8 coverage path', async variant => {
    const f = fixture('1', false); if (variant === 'HDR') f.raw.hdr = true
    const extra = variant === 'non-coherent' ? { coherentSamples: false } : variant === 'software' ? { softwareRaster: true } :
      variant === 'resolve' ? { resolve: {} } : variant === 'pixel-presentation' ? { presentation: {} } :
      variant === 'grid' ? { grid: true } : variant === 'checker' ? { checkerboard: true } : {}
    await f.begin(extra, variant !== 'no-display-intent'); f.driver.mask(f.path, f.target('color'), 0)
    expect(f.chosen.at(-1)).toEqual({ legacy: 'color' }); expect(f.raw.sampleOnlyCoveragePasses).toBe(0)
  })

test.each([0, 1, 2, 5, NaN])('unmanaged non-sample/unknown uploaded header %s cannot borrow a previous certificate', async header => {
  const f = fixture('1', false); f.curves[20] = header; await f.begin(); f.driver.mask(f.path, f.target('color'), 0)
  expect(f.chosen.at(-1)).toEqual({ legacy: 'color' }); expect(f.raw.sampleOnlyCoveragePasses).toBe(0)
})
