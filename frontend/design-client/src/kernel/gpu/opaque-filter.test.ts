import { afterEach, expect, test, vi } from 'vitest'
import { completeFilterAxisSupport } from './opaque-filter'
import { GpuRenderer, type Surface } from './renderer'
import { WebGpuDriver } from './webgpu'
import { parameters, type Driver, type GpuNode, type Rect, type Texture } from './types'
import { SOLID_INSTANCE_FLOATS } from './solid-batch'

afterEach(() => vi.unstubAllEnvs())
const source = { x: 0, y: 0, w: 100, h: 100 }, output = { x: 40, y: 40, w: 12, h: 12 }
const radius = 38.25948715209961
test('full X and Y halos admit exact equality at each support boundary', () => {
  for (const axis of [0, 1]) {
    expect(completeFilterAxisSupport(source, output, axis, radius)).toBe(true)
    const exact = { x: 0, y: 0, w: 92, h: 92 }
    expect(completeFilterAxisSupport(exact, output, axis, radius)).toBe(true)
    expect(completeFilterAxisSupport({ ...exact, [axis ? 'h' : 'w']: 91 }, output, axis, radius)).toBe(false)
    expect(completeFilterAxisSupport(source, { ...output, [axis ? 'y' : 'x']: 39 }, axis, radius)).toBe(false)
  }
})
test('X-clipped input cannot certify a horizontal result even when the later Y footprint is complete', () => {
  const clipped = { x: 40, y: 0, w: 60, h: 100 }
  expect(completeFilterAxisSupport(clipped, output, 0, radius)).toBe(false)
  expect(completeFilterAxisSupport(clipped, output, 1, radius)).toBe(true)
  expect(completeFilterAxisSupport(source, { ...output, y: -1 }, 0, radius)).toBe(false)
  expect(completeFilterAxisSupport(source, { ...output, x: -1 }, 1, radius)).toBe(false)
})
test.each([0, -1, 2048.01, NaN, Infinity, -Infinity])('invalid radius %s cannot certify opaque alpha', value => {
  expect(completeFilterAxisSupport(source, output, 0, value)).toBe(false)
})
test.each([-1, 2, .5, NaN, Infinity])('invalid axis %s cannot certify opaque alpha', axis => {
  expect(completeFilterAxisSupport(source, output, axis, radius)).toBe(false)
})
test('fractional, nonfinite, empty, oversized and out-of-input rectangles decline', () => {
  for (const value of [.5, NaN, Infinity, -Infinity, 1048577]) {
    expect(completeFilterAxisSupport({ ...source, x: value }, output, 0, radius)).toBe(false)
    expect(completeFilterAxisSupport(source, { ...output, y: value }, 1, radius)).toBe(false)
  }
  for (const value of [0, -1, .5, NaN, Infinity]) {
    expect(completeFilterAxisSupport({ ...source, w: value }, output, 1, radius)).toBe(false)
    expect(completeFilterAxisSupport(source, { ...output, h: value }, 0, radius)).toBe(false)
  }
  expect(completeFilterAxisSupport({ x: -5000, y: -5000, w: 10000, h: 10000 }, output, 0, 2048)).toBe(true)
})

const texture = (w = 100, h = 100): Texture => ({ width: w, height: h, bytes: w * h * 16,
  resource: { format: 'rgba32float', createView: () => ({}), destroy: vi.fn() } as unknown as GPUTexture })
test('real pass dispatcher skips alpha only with the complete source footprint and preserves RGBA fallback', () => {
  const encode = vi.fn(() => true), driver = Object.assign(Object.create(WebGpuDriver.prototype), {
    prefix: { encode, lastRenderPasses: 3 }, displayMath: false, displayFilters: false,
    closeOver() {}, drawCalls: 0, opaqueTentPasses: 0, blank: texture(),
  }) as WebGpuDriver
  const image = texture(); image.opaqueAlpha = true
  const target = texture(12, 12), kernel = texture(), u = parameters(output, source)
  u[16] = 22; u[36] = radius; u[37] = 0
  driver.pass(target, u, [image, kernel], undefined, 15, { kind: 'tent', radius })
  expect(encode.mock.calls[0].slice(7,11)).toEqual([7, 255, true, 0])
  expect(target.opaqueAlpha).toBe(true)
  u[4] = 40; u[6] = 60
  driver.pass(target, u, [image, kernel], undefined, 15, { kind: 'tent', radius })
  expect(encode.mock.calls[1].slice(7,11)).toEqual([15, 255, false, 0])
  expect(target.opaqueAlpha).toBeUndefined()
})

/** Production stream control with source samples promised opaque by a fake
 * table transport. No shader arithmetic is emulated or claimed verified. */
test.each([0, 100])('horizontal strip stitching certifies alpha only with X halo (output x=%i)', async x => {
  vi.stubEnv('VITE_DESIGN_PREFIX_ALIGNED_STRIPS', '0')
  const seen: (true | undefined)[] = []
  const driver = { name: 'webgpu', managed: true, maskRegion() {}, sequentialSampleResolve: true,
    create: texture, clear(t: Texture) { delete t.opaqueAlpha }, pass(t: Texture) { delete t.opaqueAlpha },
    resolveImageTable(t: Texture) { t.opaqueAlpha = true },
  } as unknown as Driver
  const renderer = new GpuRenderer(driver, true, false) as any
  const shape = { x: 0, y: 0, w: 256, h: 256 }, region = { x, y: 100, w: 8, h: 8 }
  const node = { id: 'image', rect: shape, matrix: [1, 0, 0, 1, 0, 0], children: [], strokes: [],
    fill: { count: 0 }, fills: [], effects: [{ kind: 'blur', radius: 64, visible: true }], opacity: 1, blend: 'normal' } as unknown as GpuNode
  renderer.scene = { integratedBlur: true, coherentSamples: true, nodes: { image: node } }
  renderer.prepareFilterImageTable = async () => Object.freeze({ opaqueAlpha: true })
  renderer.exactTentAxis = (input: Surface, _radius: number, axis: number, rect: Rect) => {
    if (axis === 1) seen.push(input.texture.opaqueAlpha)
    return renderer.acquire(rect)
  }
  renderer.merge = (_src: Surface, target: Surface) => target
  const targets = Array.from({ length: 4 }, () => renderer.acquire(region))
  expect(await renderer.streamIsolatedFilter(node, targets)).toBe(targets)
  expect(seen.length).toBeGreaterThan(0)
  expect(seen.every(value => value === (x === 100 ? true : undefined))).toBe(true)
})

function writerFixture() {
  const target = texture(), input = texture()
  const draws = vi.fn(), writes = vi.fn(), copies = vi.fn(), ends = vi.fn()
  const pass = { setPipeline() {}, setBindGroup() {}, setScissorRect() {}, draw: draws, end: ends }
  const driver = Object.assign(Object.create(WebGpuDriver.prototype), {
    managed: true, displayMath: false, displayFilters: false, drawCalls: 0, triangles: 0, closeOver() {},
    textures: new Set([target, input]), replayParameterTextures: new Set([target]), bindingCache: { view: () => ({}) },
    device: { queue: { writeTexture: writes } }, encoder: { beginRenderPass: () => pass, copyTextureToTexture: copies },
    bind: () => ({ group: {}, offsets: [] }), modePipelines: new Map([[12, {}]]), areaPipeline: {},
    overPipeline: {}, solidBuffer: {}, solidData: new Float32Array(SOLID_INSTANCE_FLOATS * 2), solidOffset: 0,
    solidRanges: new WeakMap(), solidBind: {}, solidPipeline: {}, submitCommands() {},
  }) as WebGpuDriver
  return { driver, target, input, draws, writes, copies, ends }
}
test.each(['clear', 'pass', 'mask', 'solid', 'copy', 'atlas-float', 'atlas-byte', 'replay', 'over'] as const)(
  'actual %s writer revokes a prior opaque-alpha certificate', writer => {
    const f = writerFixture(); f.target.opaqueAlpha = true; f.target.finitePixels = true
    const u = parameters(source); u[16] = 12
    switch (writer) {
      case 'clear': f.driver.clear(f.target); break
      case 'pass': f.driver.pass(f.target, u, []); break
      case 'mask': f.driver.mask({ rect: source, count: 1, first: 0, rule: 'nonzero', area: { first: 0, count: 1 } }, f.target); break
      case 'solid': f.driver.solidBatch(f.target, u, new Float32Array(SOLID_INSTANCE_FLOATS)); break
      case 'copy': f.driver.copyRegion(f.target, f.input, { x: 0, y: 0, w: 1, h: 1 }, [0, 0]); break
      case 'atlas-float': f.driver.uploadAtlasLinear(f.target, 0, 0, 1, 1, new Float32Array(4)); break
      case 'atlas-byte': f.driver.uploadAtlasRgba8(f.target, 0, 0, 1, 1, new Uint8Array(4)); break
      case 'replay': f.driver.uploadReplayParameters(new Float32Array(4), 1, 1, f.target); break
      case 'over': (f.driver as any).managed = false; f.driver.over(f.target, u, [f.input], { x: 0, y: 0, w: 1, h: 1 }); break
    }
    expect(f.draws.mock.calls.length + f.writes.mock.calls.length + f.copies.mock.calls.length + f.ends.mock.calls.length).toBeGreaterThan(0)
    expect(f.target.opaqueAlpha).toBeUndefined()
    expect(f.target.finitePixels).toBeUndefined()
  },
)
test('renderer pool reacquisition revokes old alpha proof before the new owner can use it', () => {
  const renderer = new GpuRenderer({ create: texture, managed: true } as unknown as Driver) as any
  const a = renderer.acquire(output); a.texture.opaqueAlpha = true
  renderer.release(a)
  const b = renderer.acquire(output)
  expect(b.texture).toBe(a.texture)
  expect(b.texture.opaqueAlpha).toBeUndefined()
})
