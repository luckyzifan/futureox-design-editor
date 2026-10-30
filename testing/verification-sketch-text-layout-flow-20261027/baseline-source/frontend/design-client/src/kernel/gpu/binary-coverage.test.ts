import { expect, test, vi } from 'vitest'
import { GpuRenderer, type Surface } from './renderer'
import { rect, type Driver, type GpuNode, type PathMesh, type Rect, type Texture } from './types'

type State = {
  sampleIndex: number | undefined
  curveBits: Uint32Array
  mask(path: PathMesh): Surface
  nodeMask(node: GpuNode): Surface
  acquire(rect: Rect, binary?: boolean): Surface
  release(...surfaces: Surface[]): void
}
function fixture(optimized = true) {
  let sequence = 0
  const make = (width: number, height: number, binary = false): Texture => ({
    width,
    height,
    bytes: width * height * (binary ? 4 : 16),
    ...(binary ? { binaryCoverage: true as const } : {}),
    resource: { sequence: sequence++ } as unknown as GPUTexture,
  })
  const driver = {
    managed: true,
    create: vi.fn((w: number, h: number) => make(w, h)),
    createBinaryCoverage: vi.fn((w: number, h: number) => make(w, h, true)),
    clear: vi.fn(),
    mask: vi.fn(),
    pass: vi.fn(),
    destroy: vi.fn(),
  }
  const state = new GpuRenderer(driver as unknown as Driver, optimized) as unknown as State
  const path: PathMesh = {
    rect: rect(0, 0, 32, 24),
    first: 0,
    count: 1,
    rule: 'nonzero',
    area: { first: 0, count: 1 },
  }
  return { state, driver, path }
}
for (const header of [3, 4])
  for (const sample of [0, 1, 2, 3])
    test(`Figma program ${header}, sample ${sample} uses lossless binary storage`, () => {
      const { state, driver, path } = fixture()
      state.sampleIndex = sample
      state.curveBits = new Uint32Array(new Float32Array([header, 0, 0, 0]).buffer)
      const result = state.mask(path)
      expect(result.texture.binaryCoverage).toBe(true)
      expect(result.texture.bytes).toBe(32 * 24 * 4)
      expect(driver.mask).toHaveBeenCalledWith(path, result.texture, sample)
    })
for (const header of [0, 1, 2, 3, 4])
  test(`resolved or continuous coverage ${header} preserves float storage`, () => {
    for (const sample of header >= 3 ? [undefined] : [undefined, 0]) {
      const { state, path } = fixture()
      state.sampleIndex = sample
      state.curveBits = new Uint32Array(new Float32Array([header, 0, 0, 0]).buffer)
      expect(state.mask(path).texture.binaryCoverage).toBeUndefined()
    }
  })
test('analytic winding is binary only for a selected sample; unoptimized reference stays float', () => {
  for (const optimized of [true, false])
    for (const sample of [undefined, 0]) {
      const { state, path } = fixture(optimized)
      state.sampleIndex = sample
      delete path.area
      path.analytic = { first: 0, count: 0 }
      expect(!!state.mask(path).texture.binaryCoverage).toBe(optimized && sample === 0)
    }
})
test('binary masks never enter the RGBA32F color pool', () => {
  const { state, driver, path } = fixture()
  const mask = state.acquire(path.rect, true)
  state.release(mask)
  const color = state.acquire(path.rect)
  expect(color.texture).not.toBe(mask.texture)
  expect(color.texture.bytes).toBe(32 * 24 * 16)
  expect(state.acquire(path.rect, true).texture).toBe(mask.texture)
  expect(driver.createBinaryCoverage).toHaveBeenCalledTimes(1)
})
test('continuous coherent samples retain f32 precision in scalar storage and never alias color targets', () => {
  for (const optimized of [true, false]) {
    const { state, driver, path } = fixture(optimized)
    Object.assign(driver, { createScalarCoverage: (width: number, height: number) => ({
      width, height, bytes: width * height * 4, scalarCoverage: true, resource: {} as GPUTexture,
    }) })
    state.curveBits = new Uint32Array(new Float32Array([1, 0, 0, 0]).buffer)
    for (const sample of [undefined, 0, 1, 2, 3]) {
      state.sampleIndex = sample
      const mask = state.mask(path)
      expect(!!mask.texture.scalarCoverage).toBe(optimized)
      expect(mask.texture.bytes).toBe(32 * 24 * (optimized ? 4 : 16))
      expect(driver.mask).toHaveBeenLastCalledWith(path, mask.texture, sample)
      state.release(mask)
      expect(state.acquire(path.rect).texture === mask.texture).toBe(!optimized)
    }
  }
})
test('proven opaque coverage stores exactly one in all four channels', () => {
  const { state, driver, path } = fixture()
  const node = {
    id: 'opaque',
    children: [],
    opaqueCoverage: true,
    rect: path.rect,
    fill: path,
  } as unknown as GpuNode
  const result = state.nodeMask(node)
  expect(result.texture.binaryCoverage).toBe(true)
  expect(driver.pass.mock.calls[0][1][16]).toBe(12)
  expect(Array.from(driver.pass.mock.calls[0][1].slice(48, 52))).toEqual([1, 1, 1, 1])
})

test('shared immutable float targets stay owned until every distinct consumer releases them', () => {
  const { state, path } = fixture()
  const renderer = state as State & { retain(surface: Surface): Surface }
  const original = state.acquire(path.rect)
  const aliases = [
    original,
    renderer.retain(original),
    renderer.retain(original),
    renderer.retain(original),
  ]
  for (const surface of aliases.slice(0, 3)) state.release(surface, surface)
  const other = state.acquire(path.rect)
  expect(other.texture).not.toBe(original.texture)
  state.release(aliases[3])
  // An already-consumed logical reference cannot release the recycled target.
  const recycled = state.acquire(path.rect)
  expect(recycled.texture).toBe(original.texture)
  state.release(aliases[0])
  expect(state.acquire(path.rect).texture).not.toBe(recycled.texture)
})

test('continuous area coverage wins over an analytic field, matching driver dispatch priority', () => {
  const { state, path } = fixture()
  state.sampleIndex = 0
  state.curveBits = new Uint32Array(new Float32Array([1, 0, 0, 0]).buffer)
  path.analytic = { first: 0, count: 0 }
  expect(state.mask(path).texture.binaryCoverage).toBeUndefined()
})

test('a repeated consumed surface cannot release a texture since reused for another output', () => {
  const { state, path } = fixture()
  const first = state.acquire(path.rect)
  state.release(first)
  const second = state.acquire(path.rect)
  expect(second.texture).toBe(first.texture)
  state.release(first)
  expect(state.acquire(path.rect).texture).not.toBe(second.texture)
})
