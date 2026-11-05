import { afterEach, expect, test, vi } from 'vitest'
import { WebGpuDriver } from './webgpu'
import * as imageRange from './exact-image-x-table'
import type { Texture } from './types'

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })
function fixture() {
  vi.stubGlobal('OffscreenCanvas', class {})
  const writes: Uint32Array[] = []
  const driver = new WebGpuDriver(true)
  Object.assign(driver, {
    device: { queue: { writeTexture(_target: unknown, data: Float32Array) {
      writes.push(new Uint32Array(data.buffer, data.byteOffset, data.length).slice())
    } } },
    createFormat(width: number, height: number): Texture {
      const texture = { width, height, bytes: width * height * 16, resource: {} as GPUTexture }
      ;(driver as any).textures.add(texture)
      return texture
    },
  })
  return { driver, writes }
}
const raw = [0, 0x80000000, 1, 0x3f800000, 0x7f7fffff, 0xff7fffff, 0x007fffff, 0x3f800000]
const pixels = () => new Float32Array(new Uint32Array(raw).buffer)

test('only a complete private gradient proof skips a second parameter scan', () => {
  const f = fixture(), fallback = vi.spyOn(f.driver, 'uploadParameters')
  const field = new Float32Array([0, 1, 0.25, -0, -1, -1, 0, 0])
  const result = f.driver.uploadGradientParameters(field, 2, 1)
  expect(result.maximumStop).toBe(1)
  expect(fallback).not.toHaveBeenCalled()
  expect(f.writes[0]).toEqual(new Uint32Array(field.buffer))
  const shared = new Float32Array(new SharedArrayBuffer(32))
  shared.set(field)
  expect(f.driver.uploadGradientParameters(shared, 2, 1).maximumStop).toBeUndefined()
  expect(fallback).toHaveBeenCalledTimes(1)
  field[0] = 64
  expect(f.driver.uploadGradientParameters(field, 2, 1).maximumStop).toBeUndefined()
  field[7] = NaN
  expect(() => f.driver.uploadGradientParameters(field, 2, 1)).toThrow('材质参数')
  expect(f.writes).toHaveLength(3)
})

test('one actual image range proof replaces the repeated finite scan without changing uploaded bits', () => {
  vi.stubEnv('VITE_DESIGN_EXACT_IMAGE_X_TABLE', '1')
  const f = fixture(), data = pixels(), proof = vi.spyOn(imageRange, 'certifyExactImageRange')
  const finite = vi.spyOn(Number, 'isFinite')
  const texture = f.driver.uploadLinear(data, 2, 1), finiteChecks = finite.mock.calls.length
  finite.mockRestore()
  expect(proof).toHaveBeenCalledExactlyOnceWith(data)
  expect(finiteChecks).toBe(0)
  expect(f.writes).toEqual([new Uint32Array(raw)])
  expect(texture.finitePixels).toBe(true)
  expect(f.driver.imageTableRange(texture)).toMatchObject({ pixels: 2, opaqueAlpha: true, nonnegativeRgb: false })
  data.fill(NaN)
  expect(f.writes[0]).toEqual(new Uint32Array(raw))
})

test('public parameter uploads keep complete validation even while image table proofs are enabled', () => {
  vi.stubEnv('VITE_DESIGN_EXACT_IMAGE_X_TABLE', '1')
  const f = fixture(), data = pixels(), proof = vi.spyOn(imageRange, 'certifyExactImageRange')
  const finite = vi.spyOn(Number, 'isFinite')
  const texture = f.driver.uploadParameters(data, 2, 1), finiteChecks = finite.mock.calls.length
  finite.mockRestore()
  expect(finiteChecks).toBe(data.length); expect(proof).not.toHaveBeenCalled()
  expect(texture.finitePixels).toBe(true); expect(f.driver.imageTableRange(texture)).toBeUndefined()
  const bad = new Float32Array([0, 0, 0, NaN])
  expect(() => (f.driver.uploadParameters as any)(bad, 1, 1, true)).toThrow('材质参数')
  expect(f.writes).toHaveLength(1)
})

test('disabled, absent and shared range proofs retain public validation and shared arrays gain no certificate', () => {
  for (const kind of ['disabled', 'absent', 'shared'] as const) {
    vi.stubEnv('VITE_DESIGN_EXACT_IMAGE_X_TABLE', kind === 'disabled' ? '0' : '1')
    const f = fixture(), data = kind === 'shared' ? new Float32Array(new SharedArrayBuffer(32)) : pixels()
    if (kind === 'shared') data.set(pixels())
    const proof = vi.spyOn(imageRange, 'certifyExactImageRange')
    if (kind === 'absent') proof.mockReturnValueOnce(undefined)
    const finite = vi.spyOn(Number, 'isFinite')
    const texture = f.driver.uploadLinear(data, 2, 1), finiteChecks = finite.mock.calls.length
    finite.mockRestore()
    expect(finiteChecks).toBe(data.length)
    expect(proof).toHaveBeenCalledTimes(kind === 'absent' ? 1 : 0)
    expect(texture.finitePixels).toBe(kind === 'shared' ? undefined : true)
    expect(f.driver.imageTableRange(texture)).toBeUndefined()
    expect(f.writes).toEqual([new Uint32Array(raw)])
    proof.mockRestore()
  }
})

test('nonfinite image proof failures retain the original error before any upload', () => {
  vi.stubEnv('VITE_DESIGN_EXACT_IMAGE_X_TABLE', '1')
  const f = fixture()
  for (const bad of [NaN, Infinity, -Infinity]) {
    const data = new Float32Array([1, 2, 3, bad]), finite = vi.spyOn(Number, 'isFinite')
    expect(() => f.driver.uploadLinear(data, 1, 1)).toThrow('材质参数')
    expect(finite).toHaveBeenCalledWith(bad)
    finite.mockRestore()
  }
  const proof = vi.spyOn(imageRange, 'certifyExactImageRange')
  expect(() => f.driver.uploadLinear(new Float32Array(4), 2, 1)).toThrow('浮点纹理')
  expect(proof).not.toHaveBeenCalled(); expect(f.writes).toHaveLength(0)
})

test('the validated image upload keeps axis metadata ownership and writer revocation', () => {
  vi.stubEnv('VITE_DESIGN_EXACT_IMAGE_X_TABLE', '1')
  const f = fixture(), data = new Float32Array([0, .25, 1, -1, 1, .5, 1, -1])
  const texture = f.driver.uploadLinear(data, 1, 2)
  expect(f.driver.imageTableAxes(texture)).toEqual(data)
  const exposed = f.driver.imageTableAxes(texture)!
  exposed.fill(0)
  expect(f.driver.imageTableAxes(texture)).toEqual(data)
  f.driver.uploadAtlasLinear(texture, 0, 0, 1, 1, new Float32Array(4))
  expect(texture.finitePixels).toBeUndefined()
  expect(f.driver.imageTableRange(texture)).toBeUndefined(); expect(f.driver.imageTableAxes(texture)).toBeUndefined()
})
