import { expect, test, vi } from 'vitest'
import { GpuRenderer, type Surface } from './renderer'
import { rect, type Driver, type Rect, type Texture } from './types'

type State = {
  empty(r: Rect): Surface
  acquire(r: Rect): Surface
  retain(s: Surface): Surface
  release(...s: Surface[]): void
  blur(s: Surface, sigma: number): Surface
  constantTargets: Map<string, Surface>
  aliases: Map<Texture, number>
}
function fixture(capability = true, optimized = true, solidBatch = false) {
  const driver = {
    managed: true, zeroTextureSampling: capability,
    create: vi.fn((width: number, height: number): Texture => ({width, height,
      bytes: width * height * 16, resource: {} as GPUTexture})),
    clear: vi.fn(), destroy: vi.fn(),
  }
  return { driver, state: new GpuRenderer(driver as unknown as Driver, optimized, solidBatch) as unknown as State }
}
test('large isolated zero planes share an immutable input and keep separate logical bounds', () => {
  const { state, driver } = fixture()
  const a = state.empty(rect(-300, -200, 4096, 2048)), b = state.empty(rect(25, 30, 512, 512))
  expect(a.texture).toBe(b.texture)
  expect(a.rect).toEqual(rect(-300, -200, 4096, 2048))
  expect(b.rect).toEqual(rect(25, 30, 512, 512))
  expect(a.texture.bytes).toBe(16)
  expect(a.texture.transparentZero).toBe(true)
  expect(driver.clear).toHaveBeenCalledTimes(1)
  expect(state.blur(a, 100)).toBe(a)
  state.release(a, b)
  expect(state.aliases.get(a.texture)).toBe(1) // cache still excludes in-place writes
  const owner = state.constantTargets.get('transparent-zero')!
  state.constantTargets.delete('transparent-zero'); state.release(owner)
  const reused = state.acquire(rect(0, 0, 1, 1))
  expect(reused.texture).toBe(a.texture)
  expect(reused.texture.transparentZero).toBeUndefined()
})
test('drivers without virtual sampling, reference renders and mutable batches retain physical targets', () => {
  for (const flags of [[false, true, false], [true, false, false], [true, true, true]]) {
    const { state } = fixture(...flags)
    const surface = state.empty(rect(20, 30, 100, 200))
    expect(surface.texture.transparentZero).toBeUndefined()
    expect(surface.texture.bytes).toBe(100 * 200 * 16)
  }
})
