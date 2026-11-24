import { afterEach, expect, test, vi } from 'vitest'
import { GpuRenderer } from './renderer'
import { multiresBlurLevels, multiresDisplayBlurEligible, MULTIRES_BLUR_REDUCED_SIGMA } from './gaussian-multires'
import type { Driver, Rect, Texture } from './types'
import type { Surface } from './renderer'

afterEach(() => vi.unstubAllEnvs())

test('level selection keeps the reduced sigma in the smooth display band', () => {
  expect(multiresBlurLevels(47)).toBeUndefined()
  expect(multiresBlurLevels(48)).toBeUndefined()
  expect(multiresBlurLevels(64)).toBe(1)
  expect(multiresBlurLevels(153)).toBe(2)
  expect(multiresBlurLevels(612)).toBe(4)
  expect(multiresBlurLevels(16384)).toBe(8)
  expect(multiresBlurLevels(16385)).toBeUndefined()
  expect(multiresBlurLevels(NaN)).toBeUndefined()
  expect(multiresBlurLevels(100, 0)).toBeUndefined()
  for (const sigma of [64, 100, 153, 300, 612, 2000, 16384]) {
    const levels = multiresBlurLevels(sigma)!
    const reduced = sigma / 2 ** levels
    expect(reduced).toBeGreaterThanOrEqual(MULTIRES_BLUR_REDUCED_SIGMA)
    if (levels < 8) expect(reduced).toBeLessThan(MULTIRES_BLUR_REDUCED_SIGMA * 2)
  }
})

test('the launch gate refuses every non-display boundary', () => {
  const scene = { softwareRaster: false }
  const driver = { name: 'webgpu', managed: true, hdr: false, displayMath: false }
  expect(multiresDisplayBlurEligible(true, scene, driver, false, true)).toBe(true)
  expect(multiresDisplayBlurEligible(false, scene, driver, false, true)).toBe(false)
  expect(multiresDisplayBlurEligible(true, scene, driver, true, true)).toBe(false)
  expect(multiresDisplayBlurEligible(true, scene, driver, false, false)).toBe(false)
  expect(multiresDisplayBlurEligible(true, { softwareRaster: true }, driver, false, true)).toBe(false)
  expect(multiresDisplayBlurEligible(true, scene, { ...driver, hdr: true }, false, true)).toBe(false)
  expect(multiresDisplayBlurEligible(true, scene, { ...driver, displayMath: true }, false, true)).toBe(false)
  expect(multiresDisplayBlurEligible(true, scene, { ...driver, managed: false }, false, true)).toBe(false)
  expect(multiresDisplayBlurEligible(true, scene, { ...driver, name: 'webgl2' }, false, true)).toBe(false)
})

type Pass = { mode: number; rect: Rect; pixels: number }
function fixture(sigma: number, flag: string | undefined) {
  vi.stubEnv('VITE_DESIGN_MULTIRES_BLUR', flag)
  const side = 1024
  const texture = { width: side, height: side, bytes: side * side * 16, resource: {} } as Texture
  const driver = { name: 'webgpu', managed: true, hdr: false, displayMath: false, scratchBytes: 0 } as unknown as Driver
  const renderer = new GpuRenderer(driver) as any
  renderer.scene = { softwareRaster: false, integratedBlur: false }
  renderer.outputFrame = { present: true, readback: false }
  const input = { texture, rect: { x: 0, y: 0, w: side, h: side } } as Surface
  const passes: Pass[] = []
  const surface = (r: Rect): Surface => ({ texture: { width: r.w, height: r.h, bytes: r.w * r.h * 16, resource: {} } as Texture, rect: r })
  renderer.run = vi.fn((mode: number, r: Rect) => {
    passes.push({ mode, rect: { ...r }, pixels: r.w * r.h })
    renderer.passPixels += r.w * r.h
    return surface(r)
  })
  renderer.filterKernel = vi.fn(() => surface({ x: 0, y: 0, w: 1, h: 1 }))
  renderer.certifiedKernel = vi.fn(() => undefined)
  renderer.reclaimForSurface = vi.fn(async () => {})
  renderer.reclaimScratch = vi.fn(async () => {})
  renderer.admitSurface = vi.fn(() => undefined)
  renderer.surfaceNeedsAdmission = vi.fn(() => false)
  renderer.release = vi.fn(() => {})
  renderer.retain = vi.fn((s: Surface) => ({ ...s }))
  const node = { id: 'n', blend: 'normal', children: [], rect: input.rect, effects: [{ kind: 'gaussian-blur', visible: true, radius: 1 }] }
  const fx = { kind: 'gaussian-blur', visible: true, radius: 1 }
  return { renderer, input, node, fx, passes, side }
}

test('default off keeps the original full-density six-pass box operator', async () => {
  const f = fixture(153, undefined)
  await f.renderer.foregroundBlur(f.input, f.node, f.fx, 153)
  expect(f.renderer.multiresBlurPasses).toBe(0)
  expect(f.passes.every(p => p.mode === 22)).toBe(true)
  expect(f.passes).toHaveLength(6)
  expect(f.passes.every(p => p.rect.w === f.side && p.rect.h === f.side)).toBe(true)
  expect(f.renderer.passPixels).toBe(6 * f.side * f.side)
})

test('flag on executes the reduced work lattice and reconstructs to device density', async () => {
  const f = fixture(153, '1')
  const result = await f.renderer.foregroundBlur(f.input, f.node, f.fx, 153)
  expect(f.renderer.multiresBlurPasses).toBe(1)
  expect(result.rect).toEqual(f.input.rect)
  const down = f.passes.filter(p => p.mode === 75)
  const blur = f.passes.filter(p => p.mode === 22)
  const up = f.passes.filter(p => p.mode === 74)
  expect(down).toHaveLength(2)
  expect(up).toHaveLength(1)
  expect(up[0].rect).toEqual(f.input.rect)
  expect(blur).toHaveLength(6)
  // factor 4: the per-tap box passes run on a 256x256 work surface, not 1024x1024.
  expect(blur.every(p => p.rect.w === 256 && p.rect.h === 256)).toBe(true)
  const blurPixels = blur.reduce((sum, p) => sum + p.pixels, 0)
  expect(blurPixels).toBe(6 * 256 * 256)
  expect(f.renderer.multiresBlurReducedPixels).toBe(256 * 256)
  // The expensive per-tap box work drops by factor^2 = 16x.
  expect(6 * f.side * f.side / blurPixels).toBe(16)
})

test('a readback frame keeps the exact operator even with the flag on', async () => {
  const f = fixture(153, '1')
  f.renderer.outputFrame = { present: true, readback: true }
  await f.renderer.foregroundBlur(f.input, f.node, f.fx, 153)
  expect(f.renderer.multiresBlurPasses).toBe(0)
  expect(f.passes.every(p => p.mode === 22)).toBe(true)
  expect(f.passes.every(p => p.rect.w === f.side)).toBe(true)
})

test('HDR and software-raster frames keep the exact operator with the flag on', async () => {
  for (const mutate of [(r: any) => { r.driver.hdr = true }, (r: any) => { r.scene.softwareRaster = true }]) {
    const f = fixture(153, '1')
    mutate(f.renderer)
    await f.renderer.foregroundBlur(f.input, f.node, f.fx, 153)
    expect(f.renderer.multiresBlurPasses).toBe(0)
    expect(f.passes.every(p => p.mode === 22)).toBe(true)
  }
})

test('high device sigma that the generic box lane cannot admit is reduced into range', async () => {
  // sigma 612 (>512) throws on the original generic lane; the prototype halves
  // it into the admitted band instead of widening any exact radius policy.
  const off = fixture(612, undefined)
  await expect(Promise.resolve().then(() => off.renderer.foregroundBlur(off.input, off.node, off.fx, 612))).rejects.toThrow()
  const on = fixture(612, '1')
  const result = await on.renderer.foregroundBlur(on.input, on.node, on.fx, 612)
  expect(result.rect).toEqual(on.input.rect)
  expect(on.renderer.multiresBlurPasses).toBe(1)
  const blur = on.passes.filter(p => p.mode === 22)
  expect(blur.every(p => p.rect.w === 64 && p.rect.h === 64)).toBe(true)
  expect(6 * on.side * on.side / blur.reduce((s, p) => s + p.pixels, 0)).toBe(256)
})