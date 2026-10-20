import { afterEach, expect, test, vi } from 'vitest'
import { imageResolveStepWgsl, IMAGE_RESOLVE_STEP_MODE } from './image-resolve-step'
import { WebGpuDriver } from './webgpu'
import { GpuRenderer } from './renderer'
import * as adjustments from './image-adjust'
import { defaultImageAdjust } from '../../model'
import type { Driver, Texture, GpuNode, GpuPaint, Rect } from './types'

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })
const scratch = new DataView(new ArrayBuffer(4))
const bits = (value: number) => { scratch.setFloat32(0, value, true); return scratch.getUint32(0, true) }
const value = (raw: number) => { scratch.setUint32(0, raw, true); return scratch.getFloat32(0, true) }
const f32 = Math.fround
const splat = (value: number) => [value, value, value, value]
const mul = (a: number[], b: number[]) => a.map((value, i) => f32(value * b[i]))
const add = (a: number[], b: number[]) => a.map((value, i) => f32(value + b[i]))
// Execute the new production helper's control flow, translating only scalar
// WGSL syntax and vector builtins. This is a CPU arithmetic-boundary test,
// not a shader compiler or actual texture/GPU equivalence test.
const body = imageResolveStepWgsl.slice(imageResolveStepWgsl.indexOf('{') + 1, imageResolveStepWgsl.indexOf('\n}\n@fragment'))
  .replace(/vec4<f32>/g, 'splat').replace(/bitcast<u32>/g, 'floatBits').replace(/\b(0x[\da-f]+|\d+)u\b/gi, '$1')
  .replace(/\bvar\b/g, 'let').replace(/\bsrc\.a\b/g, 'src[3]')
const fused = new Function('mulRN4', 'addRN4', 'splat', 'floatBits',
  `return (image,coverage,previous,sample)=>{${body}}`)(mul, add, splat, bits) as
  (image: number[], coverage: number, previous: number[], sample: number) => number[]

// Independent old three-pass boundaries, with explicit f32 storage between
// paint, finite integer-centre normal-over-transparent, and resolveStep.
function previousPasses(image: number[], coverage: number, previous: number[], sample: number) {
  const paintTarget = Float32Array.from(image, v => f32(f32(v * 1) * coverage))
  const source = Float32Array.from(paintTarget, v => f32((v === 0 ? 0 : v) * 1))
  const normalTarget = source[3] <= 0 ? new Float32Array(4) : source
  const quarter = Float32Array.from(normalTarget, v => f32(v * .25))
  return sample === 0 ? [...quarter] : [...Float32Array.from(previous, (v, i) => f32(v + quarter[i]))]
}

test('production fused helper preserves every finite f32 materialization/resolve boundary', () => {
  const edges = [0, 0x80000000, 1, 2, 3, 0x007fffff, 0x00800000, 0x00800001,
    0x3effffff, 0x3f000000, 0x3f000001, 0x3f7fffff, 0x3f800000, 0x7f7fffff, 0xff7fffff]
  for (let i = 0; i < 6000; i++) {
    const raw = (i * 2654435761) >>> 0
    const image = [value(edges[i % edges.length]), value(raw & 0xfeffffff),
      value(edges[(i + 5) % edges.length]), value(edges[(i + 8) % edges.length])]
    const coverage = f32((i % 256) / 255), previous = edges.slice(0, 4).map((_, c) => value(edges[(i + c * 3) % edges.length]))
    const sample = i % 4
    expect(fused(image, coverage, previous, sample).map(bits)).toEqual(previousPasses(image, coverage, previous, sample).map(bits))
  }
})

test('zero-alpha HDR RGB is discarded and negative-zero paint is canonicalized before resolving', () => {
  expect(fused([100, -3, value(1), 0], 1, [4, 3, 2, 1], 0).map(bits)).toEqual([0, 0, 0, 0])
  expect(fused([-0, -0, -0, 1], 1, [0, 0, 0, 0], 0).map(bits)).toEqual([0, 0, 0, bits(.25)])
  const image = [value(1), value(3), -value(3), 1]
  let result = [0, 0, 0, 0], reference = [0, 0, 0, 0]
  for (let sample = 0; sample < 4; sample++) {
    result = fused(image, 1, result, sample)
    reference = previousPasses(image, 1, reference, sample)
  }
  expect(result.map(bits)).toEqual(reference.map(bits))
  expect(result.map(bits)).not.toEqual(image.map(bits)) // quarter-first underflow is deliberate
})

function uploadFixture() {
  vi.stubGlobal('OffscreenCanvas', class {})
  const writes: Float32Array[] = []
  const driver = Object.assign(new WebGpuDriver(true), {
    managed: true,
    device: { queue: { writeTexture: (_target: unknown, data: Float32Array) => writes.push(data.slice()) } },
    createFormat: (width: number, height: number): Texture => ({ width, height, bytes: width * height * 16, resource: {} as GPUTexture }),
  }) as any
  return { driver, writes }
}

test('finite certificate covers final uploaded floats and managed RGBA conversion, never an unchecked partial atlas', () => {
  const { driver, writes } = uploadFixture()
  const original = new Float32Array([1, -.5, value(1), 1])
  const texture = driver.uploadLinear(original, 1, 1) as Texture
  expect(texture.finitePixels).toBe(true)
  original[0] = NaN
  expect(writes[0][0]).toBe(1)
  const bytes = driver.uploadRgba8(new Uint8Array([255, 128, 0, 1]), 1, 1) as Texture
  expect(bytes.finitePixels).toBe(true)
  expect(writes[1]).toEqual(Float32Array.from([1, 128 / 255, 0, 1 / 255]))
  driver.uploadAtlasLinear(texture, 0, 0, 1, 1, new Float32Array([NaN, 0, 0, 1]))
  expect(texture.finitePixels).toBeUndefined()
  expect(Number.isNaN(writes[2][0])).toBe(true) // existing atlas behavior is preserved, fusion is declined
})

test('nonfinite and shared uploads cannot obtain a finite certificate', () => {
  const { driver, writes } = uploadFixture()
  for (const bad of [NaN, Infinity, -Infinity])
    expect(() => driver.uploadLinear(new Float32Array([bad, 0, 0, 1]), 1, 1)).toThrow('材质参数')
  expect(writes).toHaveLength(0)
  const shared = new Float32Array(new SharedArrayBuffer(16)); shared[3] = 1
  expect(driver.uploadLinear(shared, 1, 1).finitePixels).toBeUndefined()
})

test('renderer certifies adjusted/premultiplied output, not the decoder input', () => {
  const { driver, writes } = uploadFixture()
  const decoded = new Float32Array([.2, .3, .4, .5])
  const renderer = new GpuRenderer(driver, true, false, () => ({ width: 1, height: 1, pixels: decoded })) as any
  renderer.scene = { floatCompositing: true }
  const adjust = { ...defaultImageAdjust(), exposure: .2 }
  vi.spyOn(adjustments, 'adjustLinearPremultiplied').mockReturnValueOnce(new Float32Array([NaN, 0, 0, .5]))
    .mockReturnValueOnce(new Float32Array([.1, .15, .2, .5]))
  expect(() => renderer.uploadImage('data:image/png;base64,eA==', 0, false, adjust)).toThrow('材质参数')
  expect(writes).toHaveLength(0)
  const result = renderer.uploadImage('data:image/png;base64,eA==', 0, false, adjust)
  expect(result.texture.finitePixels).toBe(true)
  expect(writes[0]).toEqual(new Float32Array([.1, .15, .2, .5]))
  expect(decoded).toEqual(new Float32Array([.2, .3, .4, .5]))
})

function resolveFixture(finite = true) {
  const rect = { x: -13, y: 83, w: 80, h: 58 }
  const texture = (binary = false): Texture => ({ width: 80, height: 58, bytes: 80 * 58 * 16, resource: {} as GPUTexture,
    ...(binary ? { binaryCoverage: true as const } : {}) })
  const image = { rect: { x: 0, y: 0, w: 100, h: 250 }, texture: { ...texture(), ...(finite ? { finitePixels: true as const } : {}) } }
  const field = { rect: { x: -13, y: 19, w: 80, h: 192 }, texture: texture() }
  const driver = { name: 'webgpu', managed: true, exactImageResolveStep: true, createBinaryCoverage: () => texture(true),
    maskRegion: vi.fn(), clear: vi.fn() } as unknown as Driver
  const renderer = new GpuRenderer(driver, true, false) as any
  renderer.scene = {}
  renderer.imageLevel = vi.fn(() => 0); renderer.imageFor = vi.fn(() => image); renderer.imageGrid = vi.fn(() => field)
  renderer.acquire = vi.fn(() => ({ rect, texture: texture(true) })); renderer.release = vi.fn()
  const runs: { mode: number; inputs: any[]; uniforms: Float32Array }[] = []
  renderer.run = (mode: number, _region: Rect, inputs: any[], configure: (u: Float32Array) => void) => {
    const uniforms = new Float32Array(256); configure(uniforms); runs.push({ mode, inputs, uniforms })
    return { rect, texture: texture() }
  }
  const paint = { id: 'image-paint', kind: 'image', image: 'data:image/png;base64,eA==', visible: true, blend: 'normal', opacity: 1,
    color: '#ffffff', fit: 'stretch', angle: 0, stops: [] } as GpuPaint
  const node = { id: 'leaf', rect, matrix: [1, 0, 0, 1, 0, 0], inverse: [1, 0, 0, 1, 0, 0], size: [100, 250],
    fill: { count: 1, area: { first: 0, count: 1 } }, fills: [paint], strokes: [], effects: [], children: [],
  } as unknown as GpuNode
  return { renderer, driver, node, rect, runs, image, field }
}

test('four source samples retain four masks and the original field origin, but encode only four fused colour passes', () => {
  const f = resolveFixture()
  let previous: any
  for (let sample = 0; sample < 4; sample++) {
    const next = f.renderer.resolveFilterImageSample(f.node, f.rect, sample, previous)
    expect(next).toBeDefined()
    const run = f.runs[sample]
    expect(run.mode).toBe(IMAGE_RESOLVE_STEP_MODE)
    expect(run.inputs[1]).toBe(f.image); expect(run.inputs[3]).toBe(f.field)
    if (sample) expect(run.inputs[2]).toBe(previous)
    expect(run.uniforms[17]).toBe(sample); expect(run.uniforms[32]).toBe(1)
    expect([...run.uniforms.slice(204, 206)]).toEqual([-13, 19])
    previous = next
  }
  expect(f.runs).toHaveLength(4)
  expect(f.driver.maskRegion).toHaveBeenCalledTimes(4)
  expect(f.renderer.release).toHaveBeenCalledTimes(4)
})

test('unknown finite proof, multiple paints, nested subtrees, non-normal paint and fractional regions keep the old path', () => {
  const unproved = resolveFixture(false)
  expect(unproved.renderer.resolveFilterImageSample(unproved.node, unproved.rect, 0)).toBeUndefined()
  expect(unproved.runs).toHaveLength(0)
  for (const change of [
    (n: GpuNode) => { n.fills.push({ ...n.fills[0] }) },
    (n: GpuNode) => { n.children.push('child') },
    (n: GpuNode) => { n.fills[0].blend = 'multiply' },
    (n: GpuNode) => { n.fills[0].opacity = .5 },
  ]) {
    const f = resolveFixture(); change(f.node)
    expect(f.renderer.resolveFilterImageSample(f.node, f.rect, 0)).toBeUndefined()
    expect(f.runs).toHaveLength(0)
  }
  const f = resolveFixture()
  expect(f.renderer.resolveFilterImageSample(f.node, { ...f.rect, x: .5 }, 0)).toBeUndefined()
  expect(f.renderer.resolveFilterImageSample(f.node, f.rect, 1)).toBeUndefined()
  vi.stubEnv('VITE_DESIGN_IMAGE_RESOLVE_FUSION', '0')
  expect(f.renderer.resolveFilterImageSample(f.node, f.rect, 0)).toBeUndefined()
})
