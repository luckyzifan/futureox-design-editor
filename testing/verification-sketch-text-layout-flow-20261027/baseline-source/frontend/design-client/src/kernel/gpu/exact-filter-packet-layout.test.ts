import { afterEach, expect, test, vi } from 'vitest'
import { exactFilterPacketLayout, exactFilterPacketTexels } from './exact-filter-packet-layout'
import { GpuRenderer } from './renderer'
import { WebGpuDriver } from './webgpu'
import * as prefixProof from './prefix-preflight'
import type { Driver, Texture } from './types'

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

// Synthetic framing/transport vectors, not mathematical coefficient goldens.
function packet(cw = 5, reach = 2048) {
  const bytes = new Uint8Array((4 + cw * (reach + 2)) * 4)
  for (let i = 16; i < bytes.length; i++) bytes[i] = (i * 97 + (i >>> 8)) & 255
  const view = new DataView(bytes.buffer)
  ;[cw, cw + 9, reach, 0].forEach((word, i) => view.setUint32(i * 4, word, true))
  return bytes
}
const texture = (width: number, height: number) => ({ width, height, bytes: width * height * 16, resource: {} }) as Texture

test.each([
  [8192, 8192, 8192, 1, 8192], [8193, 8192, 4097, 2, 8194],
  [10254, 8192, 5127, 2, 10254], [16384, 8192, 8192, 2, 16384],
  [7, 4, 4, 2, 8], [16, 4, 4, 4, 16],
])('N=%s limit=%s has only lossless row storage', (count, limit, width, height, physical) => {
  expect(exactFilterPacketLayout(count, limit)).toEqual({ width, height, logicalTexels: count, physicalTexels: physical, bytes: physical * 16 })
})
test.each([[0, 8192], [16385, 8192], [8192.5, 8192], [8193, undefined], [8193, NaN], [8193, 0], [8193, 8192.5], [17, 4]])(
  'invalid or insufficient storage (%s,%s) is not invented', (count, limit) => {
    expect(exactFilterPacketLayout(count, limit as number)).toBeUndefined()
  })
test('logical packet framing rejects truncation, unknown headers and shared mutable storage', () => {
  const bytes = packet()
  expect(exactFilterPacketTexels(bytes)).toBe(10254)
  expect(exactFilterPacketTexels(bytes.subarray(0, bytes.length - 4))).toBeUndefined()
  const invalid = bytes.slice(); new DataView(invalid.buffer).setUint32(12, 1, true)
  expect(exactFilterPacketTexels(invalid)).toBeUndefined()
  if (typeof SharedArrayBuffer !== 'undefined') {
    const shared = new Uint8Array(new SharedArrayBuffer(bytes.length)); shared.set(bytes)
    expect(exactFilterPacketTexels(shared)).toBeUndefined()
  }
})

function rendererFixture(limit: number | undefined = 8192) {
  vi.stubEnv('VITE_DESIGN_EXACT_WHOLE_TENT_2048', '1')
  const driver = { name: 'webgpu', managed: true, linearLight: true, certifiedFilter: false,
    resourceEpoch: 5, completedResourceEpoch: 4, exactFilterPacketMaxDimension: limit as number | undefined,
    destroy: vi.fn(), uploadRgba8: vi.fn((bytes: Uint8Array, width: number, height: number) => {
      if (width > 8192 || height > 8192) throw Error('WebGPU 纹理尺寸超限')
      return texture(width, height)
    }), uploadExactFilterPacket: vi.fn((bytes: Uint8Array, width: number, height: number) => texture(width, height)) }
  const renderer = new GpuRenderer(driver as unknown as Driver, true, false) as any
  const budget = vi.spyOn(renderer, 'overBudget').mockReturnValue(false)
  const build = vi.fn(() => packet())
  const get = (allow = true, radius = 2048 - 2 ** -42) => renderer.filterKernel('rational-tent', radius, build, undefined, allow)
  return { driver, renderer, budget, build, get }
}
test('only an explicit new-lane call folds and accounts for physical storage', () => {
  const f = rendererFixture(), original = f.build(), before = original.slice(); f.build.mockReturnValue(original)
  const output = f.get()
  expect(f.driver.uploadRgba8).not.toHaveBeenCalled()
  expect(f.driver.uploadExactFilterPacket).toHaveBeenCalledWith(original, 5127, 2)
  expect(f.budget).toHaveBeenCalledWith(164064, 5127, 2)
  expect(output.texture.bytes).toBe(164064); expect(f.renderer.kernelUploadBytes).toBe(164064)
  expect(output.texture.prefixRationalUnsupported).toBe(true)
  expect(original).toEqual(before)
  expect([...f.renderer.blurKernels.keys()][0]).toContain('packet-rows-v1:8192')
  // Old/default call must not discover the folded new-policy cache entry.
  expect(() => f.get(false)).toThrow('WebGPU 纹理尺寸超限')
  expect(f.driver.uploadRgba8).toHaveBeenCalledWith(original, 10254, 1)
})
test.each(['old', 'off', 'unset', 'unknown-limit', 'invalid-limit', 'missing-upload', 'old-radius'] as const)(
  '%s keeps the old unmodified 1D upload/refusal', mode => {
    const f = rendererFixture()
    if (mode === 'off') vi.stubEnv('VITE_DESIGN_EXACT_WHOLE_TENT_2048', '0')
    if (mode === 'unset') vi.stubEnv('VITE_DESIGN_EXACT_WHOLE_TENT_2048', undefined)
    if (mode === 'unknown-limit') f.driver.exactFilterPacketMaxDimension = undefined
    if (mode === 'invalid-limit') f.driver.exactFilterPacketMaxDimension = NaN
    if (mode === 'missing-upload') delete (f.driver as Partial<typeof f.driver>).uploadExactFilterPacket
    expect(() => f.get(mode !== 'old', mode === 'old-radius' ? 512 : undefined)).toThrow('WebGPU 纹理尺寸超限')
    expect(f.driver.uploadExactFilterPacket?.mock.calls.length || 0).toBe(0)
    expect(f.driver.uploadRgba8.mock.calls[0].slice(1)).toEqual([10254, 1])
  })
test('new lane small packets keep the original 1D bytes and never use the row uploader', () => {
  const f = rendererFixture(), small = packet(1, 513); f.build.mockReturnValue(small)
  f.get()
  expect(f.driver.uploadRgba8).toHaveBeenCalledWith(small, small.length / 4, 1)
  expect(f.driver.uploadExactFilterPacket).not.toHaveBeenCalled()
})
test('padding bytes are admitted before any padded upload allocation', () => {
  const f = rendererFixture(), odd = packet(5, 2047); f.build.mockReturnValue(odd)
  // 10249 logical words need 5125x2 physical texels. The spare texel counts.
  f.budget.mockImplementation((bytes: unknown) => typeof bytes === 'number' && bytes > odd.length * 4)
  expect(() => f.get()).toThrow('GPU 表面内存预算超限')
  expect(f.budget).toHaveBeenCalledWith(164000, 5125, 2)
  expect(f.driver.uploadExactFilterPacket).not.toHaveBeenCalled(); expect(f.driver.uploadRgba8).not.toHaveBeenCalled()
  expect(f.renderer.kernelUploadBytes).toBe(0); expect(f.renderer.bytes).toBe(0)
})
test('resident row packets retain original epoch protection and physical cache accounting', () => {
  vi.stubEnv('VITE_DESIGN_KERNEL_CACHE', '1')
  const f = rendererFixture(), first = f.get()
  expect(f.renderer.kernelCache.bytes).toBe(164064)
  f.renderer.blurKernels.clear(); f.driver.resourceEpoch = 6
  expect(f.get().texture).toBe(first.texture)
  expect(f.build).toHaveBeenCalledOnce(); expect(f.renderer.kernelResidentHits).toBe(1)
  expect(f.renderer.kernelCache.evictCompleted(164064, 5)).toBe(0)
  expect(f.driver.destroy).not.toHaveBeenCalled()
  expect(f.renderer.kernelCache.evictCompleted(164064, 6)).toBe(164064)
  expect(f.driver.destroy).toHaveBeenCalledWith(first.texture)
})

function driverFixture(limit = 8192) {
  vi.stubEnv('VITE_DESIGN_EXACT_WHOLE_TENT_2048', '1')
  vi.stubGlobal('OffscreenCanvas', class {})
  const driver = new WebGpuDriver(true) as any
  driver.device = { limits: { maxTextureDimension2D: limit } }
  driver.uploadLinear = vi.fn((values: Float32Array, width: number, height: number) => texture(width, height))
  return driver
}
test('driver keeps original logical proof input and byte order across the row boundary', () => {
  vi.stubEnv('VITE_DESIGN_PREFIX_TIGHT_BOUND', '1')
  const proof = vi.spyOn(prefixProof, 'certifyPrefixRationalBound').mockReturnValue(undefined)
  const driver = driverFixture(), logical = packet(5, 2047), before = logical.slice()
  const result = driver.uploadExactFilterPacket(logical, 5125, 2)
  expect(proof).toHaveBeenCalledWith(logical)
  expect(logical).toEqual(before); expect(result.bytes).toBe(164000)
  const physical = driver.uploadLinear.mock.calls[0][0] as Float32Array
  expect(physical.length).toBe(5125 * 2 * 4)
  const recovered = Uint8Array.from(physical, value => Math.round(value * 255))
  expect(recovered.subarray(0, logical.length)).toEqual(logical)
  expect(Array.from(recovered.subarray(logical.length))).toEqual([0, 0, 0, 0])
  const view = new DataView(recovered.buffer), original = new DataView(logical.buffer)
  for (const index of [0, 5124, 5125, 5126, logical.length / 4 - 1]) {
    const x = index % 5125, y = Math.floor(index / 5125)
    expect(view.getUint32((y * 5125 + x) * 4, true)).toBe(original.getUint32(index * 4, true))
  }
})
test.each(['off', 'unknown', 'invalid', 'disposed', 'lost', 'unmanaged', 'display-math'] as const)(
  'driver %s cannot supply folded upload capability', mode => {
    const driver = driverFixture()
    if (mode === 'off') vi.stubEnv('VITE_DESIGN_EXACT_WHOLE_TENT_2048', '0')
    if (mode === 'unknown') driver.device = undefined
    if (mode === 'invalid') driver.device.limits.maxTextureDimension2D = 0
    if (mode === 'disposed') driver.disposed = true
    if (mode === 'lost') driver.lost = true
    if (mode === 'unmanaged') driver.managed = false
    if (mode === 'display-math') driver.displayMath = true
    expect(driver.exactFilterPacketMaxDimension).toBeUndefined()
    expect(() => driver.uploadExactFilterPacket(packet(), 5127, 2)).toThrow('row layout')
    expect(driver.uploadLinear).not.toHaveBeenCalled()
  })
test('driver rejects invented dimensions and cannot fold a packet that already fits', () => {
  const driver = driverFixture()
  expect(() => driver.uploadExactFilterPacket(packet(), 8192, 2)).toThrow('row layout')
  expect(() => driver.uploadExactFilterPacket(packet(1, 513), 260, 2)).toThrow('row layout')
  expect(driver.uploadLinear).not.toHaveBeenCalled()
})
