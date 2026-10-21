import { afterEach, expect, test, vi } from 'vitest'
import { rational_tent_kernel_rgba } from '../../generated/design-kernel/design_kernel'
import { WebGpuDriver } from './webgpu'
import { SOLID_INSTANCE_FLOATS } from './solid-batch'
import { parameters, type ExactImageTable, type Texture } from './types'
import * as preflight from './prefix-preflight'

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })
const radius = 38.25948715209961
function fixture() {
  vi.stubEnv('VITE_DESIGN_PREFIX_TIGHT_BOUND', '1')
  vi.stubGlobal('OffscreenCanvas', class { constructor(readonly width: number, readonly height: number) {} })
  vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 1, RENDER_ATTACHMENT: 2, COPY_SRC: 4, COPY_DST: 8 })
  const encode = vi.fn(() => true), writes = vi.fn(), draws = vi.fn(), copies = vi.fn()
  const renderPass = { setPipeline() {}, setBindGroup() {}, setScissorRect() {}, draw: draws, end() {} }
  const driver = new WebGpuDriver(true)
  Object.assign(driver, {
    device: { limits: { maxTextureDimension2D: 8192 },
      createTexture: (descriptor: { format: string }) => ({ format: descriptor.format, createView: () => ({}), destroy: vi.fn() }),
      queue: { writeTexture: writes } },
    prefix: { encode, lastRenderPasses: 1 }, blank: {},
    encoder: { beginRenderPass: () => renderPass, copyTextureToTexture: copies },
    bindingCache: { view: () => ({}) }, bind: () => ({ group: {}, offsets: [] }), closeOver() {}, submitCommands() {},
    modePipelines: new Map([[12, {}]]), areaPipeline: {}, overPipeline: {}, solidBuffer: {}, solidBind: {}, solidPipeline: {},
  })
  const source = driver.create(100, 100), target = driver.create(12, 12)
  const dispatch = (kernel: Texture, opaque = false, originalRadius = radius) => {
    if (opaque) source.opaqueAlpha = true; else delete source.opaqueAlpha
    const u = parameters({ x: 40, y: 40, w: 12, h: 12 }, { x: 0, y: 0, w: 100, h: 100 })
    u[16] = 22; u[36] = originalRadius; u[37] = 0
    driver.pass(target, u, [source, kernel], undefined, 15, { kind: 'tent', radius: originalRadius })
    return (encode.mock.calls.at(-1) as unknown as unknown[])[10]
  }
  const upload = (bytes = rational_tent_kernel_rgba(radius)) => driver.uploadRgba8(bytes, bytes.length / 4, 1)
  return { driver, encode, writes, draws, copies, source, target, upload, dispatch }
}

test('actual uploaded ordinary bytes own a captured proof shared by RGBA and opaque RGB dispatch', () => {
  const f = fixture(), bytes = rational_tent_kernel_rgba(radius), kernel = f.upload(bytes)
  const bound = f.dispatch(kernel)
  expect(bound).toBeGreaterThan(0); expect(bound).toBeLessThanOrEqual(120)
  expect(f.dispatch(kernel, true)).toBe(bound)
  expect((f.encode.mock.calls.at(-1) as unknown as unknown[]).slice(7)).toEqual([7, 255, true, bound])
  bytes.fill(255)
  expect(f.dispatch(kernel)).toBe(bound)
  expect(f.dispatch(kernel, false, 40.25)).toBe(0)
  expect(f.writes).toHaveBeenCalledOnce()
})

test('disabled tight-bound uploads never invoke the BigInt packet parser', () => {
  for (const flag of [undefined, '', '0', 'true']) {
    const f = fixture(), bytes = rational_tent_kernel_rgba(radius)
    vi.stubEnv('VITE_DESIGN_PREFIX_TIGHT_BOUND', flag)
    const parser = vi.spyOn(preflight, 'certifyPrefixRationalBound')
    const kernel = f.upload(bytes)
    expect(parser).not.toHaveBeenCalled(); expect(f.dispatch(kernel)).toBe(0)
    expect(f.writes).toHaveBeenCalledOnce()
    parser.mockRestore()
  }
})

test('public flags, forged ownership and changed resource identity cannot grant a bound', () => {
  const f = fixture(), kernel = f.upload(), unknown = f.driver.create(kernel.width, kernel.height)
  Object.assign(unknown, { finitePixels: true, prefixRationalUnsupported: false, rationalBoundBits: 1 })
  expect(f.dispatch(unknown)).toBe(0)
  const clone = { ...kernel }; (f.driver as any).textures.add(clone)
  expect(f.dispatch(clone)).toBe(0)
  ;(f.driver as any).textures.delete(kernel); expect(f.dispatch(kernel)).toBe(0)
  ;(f.driver as any).textures.add(kernel)
  const resource = kernel.resource; kernel.resource = unknown.resource
  expect(f.dispatch(kernel)).toBe(0); kernel.resource = resource
  kernel.width++; expect(f.dispatch(kernel)).toBe(0); kernel.width--
  expect(f.dispatch(kernel)).toBeGreaterThan(0)
})

test('shared, malformed and non-byte-upload metadata stays on the original prefix gate', () => {
  const f = fixture(), bytes = rational_tent_kernel_rgba(radius)
  const shared = new Uint8Array(new SharedArrayBuffer(bytes.length)); shared.set(bytes)
  expect(f.dispatch(f.upload(shared))).toBe(0)
  expect(f.dispatch(f.upload(new Uint8Array(16)))).toBe(0)
  const linear = f.driver.uploadLinear(Float32Array.from(bytes, value => value / 255), bytes.length / 4, 1)
  expect(linear.finitePixels).toBe(true); expect(f.dispatch(linear)).toBe(0)
})

test.each(['clear', 'pass', 'mask', 'solid', 'copy', 'atlas-float', 'atlas-byte', 'replay', 'over', 'table', 'destroy'] as const)(
  'actual %s writer revokes bound ownership even if finitePixels is reasserted', writer => {
    const f = fixture(), kernel = f.upload()
    expect(f.dispatch(kernel)).toBeGreaterThan(0)
    const u = parameters({ x: 0, y: 0, w: kernel.width, h: 1 }); u[16] = 12
    switch (writer) {
      case 'clear': f.driver.clear(kernel); break
      case 'pass': f.driver.pass(kernel, u, []); break
      case 'mask': f.driver.mask({ rect: { x: 0, y: 0, w: kernel.width, h: 1 }, count: 1, first: 0, rule: 'nonzero', area: { first: 0, count: 1 } }, kernel); break
      case 'solid': f.driver.solidBatch(kernel, u, new Float32Array(SOLID_INSTANCE_FLOATS)); break
      case 'copy': f.driver.copyRegion(kernel, f.source, { x: 0, y: 0, w: 1, h: 1 }, [0, 0]); break
      case 'atlas-float': f.driver.uploadAtlasLinear(kernel, 0, 0, 1, 1, new Float32Array(4)); break
      case 'atlas-byte': f.driver.uploadAtlasRgba8(kernel, 0, 0, 1, 1, new Uint8Array(4)); break
      case 'replay':
        ;(f.driver as any).replayParameterTextures.add(kernel)
        f.driver.uploadReplayParameters(new Float32Array(4), 1, 1, kernel); break
      case 'over':
        ;(f.driver as any).managed = false
        f.driver.over(kernel, u, [f.source], { x: 0, y: 0, w: 1, h: 1 }); break
      case 'table': {
        vi.stubEnv('VITE_DESIGN_EXACT_IMAGE_X_TABLE', '1')
        const image = f.driver.uploadLinear(new Float32Array([1, 1, 1, 1]), 1, 1)
        const table: ExactImageTable = { resource: {}, width: kernel.width, height: 1, bytes: 1024 }
        ;(f.driver as any).imageTables.set(table, { image, storage: { config: new Uint32Array(16) },
          pipeline: { encodeResolve: f.draws }, opaqueAlpha: true })
        f.driver.resolveImageTable(kernel, table, 0, 0); break
      }
      case 'destroy': f.driver.destroy(kernel); break
    }
    kernel.finitePixels = true
    expect(f.dispatch(kernel)).toBe(0)
    expect((f.driver as any).rationalKernelBounds.has(kernel)).toBe(false)
  },
)
