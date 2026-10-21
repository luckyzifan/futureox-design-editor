import { readFileSync } from 'node:fs'
import { afterEach, expect, test, vi } from 'vitest'
import { WebGpuDriver } from './webgpu'
import { parameters, type GpuScene, type Texture } from './types'
import { imageCoordinateSource } from './image-coordinate-source'
import { scalarCoverageSource } from './scalar-coverage'
import { imageResolveStepWgsl } from './image-resolve-step'

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })
const source = scalarCoverageSource(imageCoordinateSource(['sampling', 'vector'].map(name => readFileSync(new URL(
  `../../../../../design-studio/crates/design-kernel/shaders/${name}.wgsl`, import.meta.url), 'utf8')).join('\n') + imageResolveStepWgsl))
const scene = (enabled?: boolean) => ({ nodes: {}, displayImageSource: enabled }) as unknown as GpuScene
function fixture() {
  vi.stubGlobal('OffscreenCanvas', class {})
  vi.stubEnv('VITE_DESIGN_EXACT_IMAGE_X_TABLE', '1')
  const driver = new WebGpuDriver(true), raw = driver as any
  const exact = { exact: true }, native = { native: true }, chosen: unknown[] = []
  const compilation = vi.fn(async () => ({ messages: [] as GPUCompilationMessage[] }))
  const compile = vi.fn(async (_descriptor: GPURenderPipelineDescriptor) => native)
  const module = vi.fn((_descriptor: GPUShaderModuleDescriptor) => ({ getCompilationInfo: compilation }))
  const scope = vi.fn(async (): Promise<GPUError | null> => null), pushScope = vi.fn()
  Object.assign(raw, {
    displayImageBaseSource: source, layout: {}, modePipelines: new Map([[12, {}]]),
    imageResolveStepPipeline: exact, normalCornerPipeline: exact, copyCornerPipeline: exact,
    pipelines: { prepare: vi.fn(async () => undefined), register: vi.fn() },
    device: { createShaderModule: module, createRenderPipelineAsync: compile,
      pushErrorScope: pushScope, popErrorScope: scope,
      createPipelineLayout: vi.fn(() => ({})), queue: { writeTexture: vi.fn() } },
    createFormat(width: number, height: number): Texture {
      const texture = { width, height, bytes: width * height * 16, resource: { width, height, format: 'rgba32float', destroy: vi.fn() } as unknown as GPUTexture }
      raw.textures.add(texture); return texture
    },
    bind: vi.fn(() => ({ group: {}, offsets: [] })), closeOver: vi.fn(),
    encoder: { beginRenderPass: () => ({ setPipeline: (p: unknown) => chosen.push(p), setBindGroup: vi.fn(), draw: vi.fn(), end: vi.fn() }) },
    bindingCache: { view: vi.fn(() => ({})) },
  })
  const image = (values = [0, .5, 1, 1]) => driver.uploadLinear(Float32Array.from(values), values.length / 4, 1)
  const r = { x: 3, y: -7, w: 2, h: 1 }
  const pass = (imageTexture: Texture, change?: (u: Float32Array, inputs: Texture[], target: Texture) => void) => {
    const target = raw.createFormat(2, 1), mask = { ...raw.createFormat(2, 1), binaryCoverage: true as const }
    const inputs = [mask, imageTexture, raw.createFormat(2, 1), raw.createFormat(2, 2)]
    const u = parameters(r, r, { x: 0, y: 0, w: imageTexture.width, h: imageTexture.height }, r)
    u[16] = 51; u[17] = 0; u[28] = 3; u[32] = 1; u[241] = 1; u.set([r.x, r.y], 204)
    change?.(u, inputs, target)
    driver.pass(target, u, inputs)
    return target as Texture
  }
  return { driver, raw, exact, native, chosen, module, compilation, compile, image, pass, scope, pushScope }
}

test('scene intent lazily builds a separate pipeline and changes domains without replacing the device', async () => {
  const f = fixture(), image = f.image(), device = f.raw.device
  await f.driver.prepareScene(scene())
  expect(f.module).not.toHaveBeenCalled(); expect(f.driver.usesDisplayImageSource(image)).toBe(false)
  f.pass(image); expect(f.chosen.at(-1)).toBe(f.exact)
  await f.driver.prepareScene(scene(true))
  expect(f.module).toHaveBeenCalledTimes(1); expect(f.compile).toHaveBeenCalledTimes(1)
  expect(f.module.mock.calls[0][0].code).toContain('fn displayImageLinear(')
  expect(f.compile.mock.calls[0][0].fragment!.entryPoint).toBe('exactImageResolveStep')
  expect(f.pushScope).toHaveBeenCalledTimes(2); expect(f.scope).toHaveBeenCalledTimes(2)
  expect(f.driver.usesDisplayImageSource(image)).toBe(true)
  for (let sample = 0; sample < 4; sample++) {
    const target = f.pass(image, u => { u[17] = sample })
    expect(f.chosen.at(-1)).toBe(f.native)
    expect(target.finitePixels).toBeUndefined(); expect(target.opaqueAlpha).toBeUndefined()
    expect(f.driver.imageTableRange(target)).toBeUndefined()
  }
  expect(f.driver.displayImageSourcePasses).toBe(4)
  await f.driver.prepareScene(scene(false)); f.pass(image)
  expect(f.driver.usesDisplayImageSource(image)).toBe(false); expect(f.chosen.at(-1)).toBe(f.exact)
  await f.driver.prepareScene(scene(true))
  expect(f.compile).toHaveBeenCalledTimes(1); expect(f.raw.device).toBe(device)
})

test('an old asynchronous preparation never re-enables a newer exact scene', async () => {
  const f = fixture(), image = f.image()
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  f.compilation.mockImplementation(async () => { await waiting; return { messages: [] } })
  const first = f.driver.prepareScene(scene(true)), second = f.driver.prepareScene(scene(true))
  await vi.waitFor(() => expect(f.module).toHaveBeenCalledTimes(1))
  expect(f.pushScope).toHaveBeenCalledTimes(1); expect(f.scope).toHaveBeenCalledTimes(1)
  await f.driver.prepareScene(scene(false))
  release(); await Promise.all([first, second])
  expect(f.compile).toHaveBeenCalledTimes(1)
  expect(f.driver.usesDisplayImageSource(image)).toBe(false)
  await f.driver.prepareScene(scene(true))
  expect(f.driver.usesDisplayImageSource(image)).toBe(true)
})

test('compile and pipeline failures disable only the candidate, warn once, and preserve exact rendering', async () => {
  for (const kind of ['shader', 'pipeline', 'validation', 'synchronous'] as const) {
    const f = fixture(), image = f.image(), warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    if (kind === 'shader') f.compilation.mockResolvedValue({ messages: [{ type: 'error', lineNum: 3, message: 'fixture compile failure' } as GPUCompilationMessage] })
    else if (kind === 'pipeline') f.compile.mockRejectedValue(Error('fixture pipeline failure'))
    else if (kind === 'validation') f.scope.mockResolvedValueOnce({ message: 'fixture captured validation failure' } as GPUError)
    else f.module.mockImplementationOnce(() => { throw Error('fixture synchronous failure') })
    await f.driver.prepareScene(scene(true)); await f.driver.prepareScene(scene(true))
    expect(f.driver.usesDisplayImageSource(image)).toBe(false); expect(warn).toHaveBeenCalledTimes(1)
    expect(f.module).toHaveBeenCalledTimes(1); f.pass(image); expect(f.chosen.at(-1)).toBe(f.exact)
    expect(f.pushScope.mock.calls.length).toBe(f.scope.mock.calls.length)
    warn.mockRestore()
  }
})

test('actual immutable finite range, nonnegative RGB, opaque alpha and exponent bound are required', async () => {
  const f = fixture(); await f.driver.prepareScene(scene(true))
  for (const pixels of [[0, -0, 1.9999998807907104, 1], [2 ** -149, 2 ** -126, .25, 1]])
    expect(f.driver.usesDisplayImageSource(f.image(pixels))).toBe(true)
  for (const pixels of [[-.001, .5, 1, 1], [0, .5, 2, 1], [0, .5, 1, .5], [0, .5, 1, 0], [0, .5, 1, -1]]) {
    const image = f.image(pixels)
    expect(f.driver.usesDisplayImageSource(image)).toBe(false)
    f.pass(image); expect(f.chosen.at(-1)).toBe(f.exact)
  }
  const unknown = f.driver.uploadParameters(new Float32Array([0, .5, 1, 1]), 1, 1)
  expect(f.driver.usesDisplayImageSource(unknown)).toBe(false)
  const image = f.image()
  expect(f.driver.usesDisplayImageSource({ ...image })).toBe(false)
  const originalResource = image.resource
  image.resource = { width: 1, height: 1, format: 'rgba32float' } as GPUTexture
  expect(f.driver.usesDisplayImageSource(image)).toBe(false)
  image.resource = originalResource
  image.width = 2; expect(f.driver.usesDisplayImageSource(image)).toBe(false); image.width = 1
  image.height = 2; expect(f.driver.usesDisplayImageSource(image)).toBe(false); image.height = 1
  ;(originalResource as any).format = 'rgba8unorm'
  expect(f.driver.usesDisplayImageSource(image)).toBe(false)
  ;(originalResource as any).format = 'rgba32float'
  expect(f.driver.usesDisplayImageSource(image)).toBe(true)
  const shared = new Float32Array(new SharedArrayBuffer(16)); shared.set([0, .5, 1, 1])
  expect(f.driver.usesDisplayImageSource(f.driver.uploadLinear(shared, 1, 1))).toBe(false)
  f.driver.uploadAtlasLinear(image, 0, 0, 1, 1, new Float32Array([0, .5, 1, 1])); image.finitePixels = true
  expect(f.driver.usesDisplayImageSource(image)).toBe(false) // writer revocation cannot be revived by a public flag
})

test('native selection retains the original mode51 integer, phase, binary, paint and target guards', async () => {
  const f = fixture(), image = f.image(); await f.driver.prepareScene(scene(true))
  for (const change of [
    (u: Float32Array) => { u[0] = .25 }, (u: Float32Array) => { u[242] = 1 },
    (u: Float32Array) => { u[17] = 4 }, (u: Float32Array) => { u[17] = .5 },
    (u: Float32Array) => { u[28] = 2 }, (u: Float32Array) => { u[32] = .5 },
    (_u: Float32Array, inputs: Texture[]) => { delete inputs[0].binaryCoverage },
    (_u: Float32Array, inputs: Texture[]) => { delete inputs[1].finitePixels },
    (_u: Float32Array, _inputs: Texture[], target: Texture) => { target.scalarCoverage = true },
  ]) expect(() => f.pass(f.image(), change)).toThrow('精确图片累积')
  expect(f.driver.displayImageSourcePasses).toBe(0)
  for (const property of ['hdr', 'displayMath', 'lost', 'disposed'] as const) {
    f.raw[property] = true; expect(f.driver.usesDisplayImageSource(image)).toBe(false); f.raw[property] = false
  }
  f.raw.managed = false; expect(f.driver.usesDisplayImageSource(image)).toBe(false)
})
