import { readFileSync } from 'node:fs'
import { afterEach, expect, test, vi } from 'vitest'
import { initSync, rational_tent_kernel_rgba } from '../../generated/design-kernel/design_kernel'
import { allowsDisplayTentRadius, selectDisplayTentRadius } from './display-tent-radius'
import { prefixRationalUnsupported } from './prefix-preflight'
import { GpuRenderer, type Surface } from './renderer'
import type { Driver, GpuScene, Texture } from './types'

afterEach(() => vi.unstubAllEnvs())
const raw = 18.39398384094238 * 64
const lowZoomRaw = 18.39398384094238 * 2
const flags = () => {
  vi.stubEnv('VITE_DESIGN_DISPLAY_TENT_RADIUS', '1'); vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', '1')
}

test('the display radius rounds only the bounded screen tent tier and never extends its native integer halo', () => {
  expect(selectDisplayTentRadius(raw, false)).toBe(raw)
  expect(selectDisplayTentRadius(raw, true)).toBe(1177.2149658203125)
  for (const radius of [0, -0, -1, .9999999999999999, 2048.0000000000005, Infinity, -Infinity, NaN])
    expect(Object.is(selectDisplayTentRadius(radius, true), radius)).toBe(true)
  for (let i = 0; i <= 1000; i++) {
    const radius = 1 + 2047 * i / 1000, selected = selectDisplayTentRadius(radius, true)
    expect(Math.abs(selected - radius)).toBeLessThanOrEqual(.0001220703125)
    expect(Math.ceil(selected)).toBeLessThanOrEqual(Math.ceil(radius))
  }
  for (const radius of [1, 1 + 2 ** -24, 1 + 3 * 2 ** -24, 32 - 2 ** -48, 32 + 2 ** -47,
    512 - 2 ** -44, 512, 512 + 2 ** -43, 1024 - 2 ** -43, 1024 + 2 ** -42, 2048])
    expect(Math.ceil(selectDisplayTentRadius(radius, true))).toBeLessThanOrEqual(Math.ceil(radius))
})

test('the radius uses f32 ties-to-even at low zoom without changing the native halo', () => {
  expect(selectDisplayTentRadius(1 + 2 ** -24, true)).toBe(1)
  expect(selectDisplayTentRadius(1 + 3 * 2 ** -24, true)).toBe(1 + 2 ** -22)
  expect(selectDisplayTentRadius(lowZoomRaw, true)).toBe(Math.fround(lowZoomRaw))
  expect(Math.ceil(selectDisplayTentRadius(lowZoomRaw, true))).toBe(Math.ceil(lowZoomRaw))
})

test('the real binary64 radius retains its 149-bit exact packet, while the separate display packet has 62 bits', () => {
  initSync({ module: readFileSync(new URL('../../../public/kernel/design_kernel_bg.wasm', import.meta.url)) })
  const describe = (radius: number) => {
    const bytes = rational_tent_kernel_rgba(radius), words = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), count = words.getUint32(0, true)
    let denominator = 0n
    for (let word = count - 1; word >= 0; word--) denominator = denominator << 32n | BigInt(words.getUint32((4 + word) * 4, true))
    return { bits: denominator.toString(2).length, unsupported: prefixRationalUnsupported(bytes) }
  }
  expect(describe(raw)).toEqual({ bits: 149, unsupported: true })
  expect(describe(selectDisplayTentRadius(raw, true))).toEqual({ bits: 62, unsupported: false })
  expect(describe(selectDisplayTentRadius(raw, false))).toEqual({ bits: 149, unsupported: true })
  expect(lowZoomRaw).toBeLessThan(512)
  expect(describe(lowZoomRaw)).toEqual({ bits: 154, unsupported: true })
  expect(describe(selectDisplayTentRadius(lowZoomRaw, true)).bits).toBeLessThanOrEqual(128)
  expect(describe(selectDisplayTentRadius(lowZoomRaw, true)).unsupported).toBe(false)
  expect(describe(selectDisplayTentRadius(lowZoomRaw, false))).toEqual({ bits: 154, unsupported: true })
})

test.each(['default', 'clamp-default', 'wrong-flag', 'readback', 'no-present', 'hdr', 'software', 'byte', 'webgl', 'display-math', 'display-filters', 'display-material', 'not-integrated', 'no-intent'] as const)(
  '%s cannot enable the screen radius approximation', mode => {
    flags()
    const scene = { displayTentRadius: true, integratedBlur: true, softwareRaster: false, displayFilters: false, displayMaterialSource: false }, driver = { name: 'webgpu', managed: true, hdr: false, displayMath: false }
    if (mode === 'default') vi.stubEnv('VITE_DESIGN_DISPLAY_TENT_RADIUS', undefined)
    if (mode === 'clamp-default') vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', undefined)
    if (mode === 'wrong-flag') vi.stubEnv('VITE_DESIGN_DISPLAY_TENT_RADIUS', 'true')
    if (mode === 'hdr') driver.hdr = true
    if (mode === 'software') scene.softwareRaster = true
    if (mode === 'byte') driver.managed = false
    if (mode === 'webgl') driver.name = 'webgl2'
    if (mode === 'display-math') driver.displayMath = true
    if (mode === 'display-filters') scene.displayFilters = true
    if (mode === 'display-material') scene.displayMaterialSource = true
    if (mode === 'not-integrated') scene.integratedBlur = false
    if (mode === 'no-intent') scene.displayTentRadius = false
    expect(allowsDisplayTentRadius(scene, driver, mode === 'readback', mode !== 'no-present')).toBe(false)
  })

function axisFixture() {
  flags()
  const texture = { width: 8, height: 8, bytes: 8 * 8 * 16, resource: {} } as Texture
  const driver = { name: 'webgpu', managed: true, hdr: false, displayMath: false }
  const renderer = new GpuRenderer(driver as unknown as Driver) as any
  renderer.scene = { displayTentRadius: true, integratedBlur: true }
  const source = { texture, rect: { x: -4.8828125, y: 964.162109375, w: 8, h: 8 } } as Surface
  renderer.filterKernel = vi.fn(() => source); renderer.certifiedKernel = vi.fn(() => source)
  renderer.run = vi.fn(() => source)
  return { renderer, driver, source }
}

test.each([raw, lowZoomRaw])('both axis requests use one selected radius %s for the rational packet, certified packet, uniform and filter contract', radius => {
  const f = axisFixture()
  for (const axis of [0, 1]) f.renderer.exactTentAxis(f.source, radius, axis, f.source.rect, undefined, true, true)
  expect(f.renderer.filterKernel.mock.calls.map((call: any[]) => call[1])).toEqual([Math.fround(radius), Math.fround(radius)])
  expect(f.renderer.certifiedKernel.mock.calls.map((call: any[]) => call[0])).toEqual([Math.fround(radius), Math.fround(radius)])
  for (const [mode, output, _inputs, configure, channels, contract] of f.renderer.run.mock.calls) {
    const u = new Float32Array(256); configure(u)
    expect(mode).toBe(22); expect(output).toBe(f.source.rect); expect(channels).toBe(15)
    expect(u[36]).toBe(Math.fround(radius)); expect(u[38]).toBe(1)
    expect(contract).toEqual({ kind: 'tent', radius: Math.fround(radius) })
  }
  expect(f.renderer.displayTentRadiusPasses).toBe(2); expect(f.renderer.displayTentRadiusPixels).toBe(128)
})

test.each(['normal', 'non-normal', 'gradient', 'glass', 'unknown'] as const)(
  '%s backdrop fallback qualifies only the normal non-gradient caller at low zoom', async mode => {
    const f = axisFixture()
    const effects = mode === 'unknown' ? [] : [{ kind: mode === 'glass' ? 'glass' : 'background-blur', visible: true,
      radius: lowZoomRaw, ...(mode === 'gradient' ? { gradientBlur: { fixture: true } } : {}) }]
    const node = { blend: mode === 'non-normal' ? 'multiply' : 'normal', effects, rect: f.source.rect }
    const authored = JSON.stringify(node), selected = mode === 'normal' ? Math.fround(lowZoomRaw) : lowZoomRaw
    await f.renderer.blurBackdropRegion(f.source, lowZoomRaw / 2, node)
    expect(f.renderer.run).toHaveBeenCalledTimes(2)
    expect(f.renderer.filterKernel.mock.calls[0][1]).toBe(selected)
    expect(f.renderer.certifiedKernel.mock.calls[0][0]).toBe(selected)
    for (const [mode, output, _inputs, configure, channels, contract] of f.renderer.run.mock.calls) {
      const u = new Float32Array(256); configure(u)
      expect(mode).toBe(22); expect(output).toBe(f.source.rect); expect(channels).toBe(15)
      expect(u[36]).toBe(Math.fround(selected)); expect(u[38]).toBe(1)
      expect(contract).toEqual({ kind: 'tent', radius: selected })
    }
    expect(f.renderer.displayTentRadiusPasses).toBe(mode === 'normal' ? 2 : 0)
    expect(f.renderer.displayTentRadiusPixels).toBe(mode === 'normal' ? 128 : 0)
    expect(JSON.stringify(node)).toBe(authored)
  })

test.each(['unknown-caller', 'alpha-only', 'display-filters', 'display-material', 'no-intent'] as const)(
  '%s keeps the original low-zoom whole-filter packet', mode => {
    const f = axisFixture()
    if (mode === 'display-filters') f.renderer.scene.displayFilters = true
    if (mode === 'display-material') f.renderer.scene.displayMaterialSource = true
    if (mode === 'no-intent') f.renderer.scene.displayTentRadius = false
    f.renderer.blur(f.source, lowZoomRaw / 2, true, mode === 'alpha-only', mode !== 'unknown-caller')
    expect(f.renderer.filterKernel.mock.calls[0][1]).toBe(lowZoomRaw)
    expect(f.renderer.certifiedKernel.mock.calls[0][0]).toBe(lowZoomRaw)
    expect(f.renderer.run.mock.calls.every((call: any[]) => call[5].radius === lowZoomRaw)).toBe(true)
    expect(f.renderer.displayTentRadiusPasses).toBe(0)
  })

test('the original whole-filter guard rejects the unrounded >512 radius even when f32 rounding would select512', async () => {
  const f = axisFixture(), radius = 512 + 2 ** -43
  expect(Math.fround(radius)).toBe(512)
  expect(() => f.renderer.blur(f.source, radius / 2, true, false, true)).toThrow('GPU 积分模糊半径超过 512 像素')
  const node = { blend: 'normal', effects: [{ kind: 'background-blur', visible: true, radius }], rect: f.source.rect }
  await expect(f.renderer.blurBackdropRegion(f.source, radius / 2, node)).rejects.toThrow('GPU 积分模糊半径超过 512 像素')
  expect(f.renderer.filterKernel).not.toHaveBeenCalled(); expect(f.renderer.run).not.toHaveBeenCalled()
  expect(f.renderer.displayTentRadiusPasses).toBe(0)
})

test('constant expansion preserves explicit display eligibility and only successful encoded axes are counted', () => {
  const f = axisFixture(), expanded = { ...f.source, texture: { ...f.source.texture } }
  f.source.texture.uniformColor = true
  f.renderer.copy = vi.fn(() => expanded)
  f.renderer.run.mockImplementationOnce(() => expanded).mockImplementationOnce(() => { throw Error('vertical encode failed') })
  expect(() => f.renderer.blur(f.source, lowZoomRaw / 2, true, false, true)).toThrow('vertical encode failed')
  expect(f.renderer.copy).toHaveBeenCalledTimes(1)
  expect(f.renderer.filterKernel.mock.calls[0][1]).toBe(Math.fround(lowZoomRaw))
  expect(f.renderer.displayTentRadiusPasses).toBe(1); expect(f.renderer.displayTentRadiusPixels).toBe(64)
})

test.each(['not-eligible', 'no-intent', 'unchanged', 'failed-encode'] as const)('%s does not report a changed display pass', mode => {
  const f = axisFixture(), radius = mode === 'unchanged' ? Math.fround(raw) : raw
  if (mode === 'no-intent') f.renderer.scene.displayTentRadius = false
  if (mode === 'failed-encode') f.renderer.run.mockImplementation(() => { throw Error('encode failed') })
  const run = () => f.renderer.exactTentAxis(f.source, radius, 0, f.source.rect, undefined, true, mode !== 'not-eligible')
  if (mode === 'failed-encode') expect(run).toThrow('encode failed'); else run()
  expect(f.renderer.displayTentRadiusPasses).toBe(0)
  if (mode !== 'failed-encode' && mode !== 'unchanged') expect(f.renderer.run.mock.calls[0][5].radius).toBe(raw)
})

test.each(['readback', 'not-present', 'hdr', 'software', 'default'] as const)('%s clears a reused display scene before actual preparation and leaves the caller object unchanged', async mode => {
  flags()
  if (mode === 'default') vi.stubEnv('VITE_DESIGN_DISPLAY_TENT_RADIUS', undefined)
  const driver = { name: 'webgpu', managed: true, hdr: mode === 'hdr', prepareScene: vi.fn(async (_scene: GpuScene) => { throw Error('prepared') }) }
  const renderer = new GpuRenderer(driver as unknown as Driver) as any
  const r = { x: 0, y: 0, w: 1, h: 1 }, scene = { version: 8, width: 1, height: 1, extent: r, output: r,
    view: { x: 0, y: 0, zoom: 1 }, roots: [], nodes: {}, vertices: [], curves: [], floatCompositing: true,
    integratedBlur: true, displayTentRadius: true, softwareRaster: mode === 'software' } as unknown as GpuScene
  await expect(renderer.renderAttempt(scene, mode === 'readback', mode !== 'not-present')).rejects.toThrow('prepared')
  expect(driver.prepareScene.mock.calls[0][0].displayTentRadius).toBe(false)
  expect(scene.displayTentRadius).toBe(true); expect(renderer.scene.displayTentRadius).toBe(false)
})

test.each(['normal', 'non-normal', 'gradient', 'glass'] as const)('%s backdrop preserves authored radius and explicitly qualifies only the normal non-gradient tent', async mode => {
  const f = axisFixture()
  const create = (width: number, height: number) => ({ width, height, bytes: width * height * 16, resource: {} }) as Texture
  Object.assign(f.driver, { create, copyRegion: vi.fn() })
  f.renderer.reclaimScratch = vi.fn(async () => {})
  f.renderer.exactTentAxis = vi.fn((_input: Surface, _radius: number, _axis: number, output: any) => f.renderer.acquire(output))
  const effects = [{ kind: mode === 'glass' ? 'glass' : 'background-blur', visible: true, radius: raw / 64,
    ...(mode === 'gradient' ? { gradientBlur: { fixture: true } } : {}) }]
  const node = { blend: mode === 'non-normal' ? 'multiply' : 'normal', effects,
    backdropOutputBox: [0, 0, 8, 8], rect: { x: -8, y: 0, w: 40, h: 32 } }
  const authored = JSON.stringify(node), input = f.renderer.acquire(node.rect)
  await f.renderer.blurBackdropRegion(input, raw / 2, node)
  expect(f.renderer.exactTentAxis).toHaveBeenCalledTimes(2)
  expect(f.renderer.exactTentAxis.mock.calls.every((call: any[]) => call[1] === raw && call[5] === true && call[6] === (mode === 'normal'))).toBe(true)
  expect(JSON.stringify(node)).toBe(authored)
})

test('retained nested-source policy separates display tents from exact filters even with the same authored scene and lease', () => {
  const f = axisFixture(), targets = [f.source]
  f.renderer.scene.displayTentRadius = false
  const exact = f.renderer.nestedPrefixPolicy('group', targets)
  f.renderer.scene.displayTentRadius = true
  expect(f.renderer.nestedPrefixPolicy('group', targets)).not.toBe(exact)
  f.renderer.scene.displayTentRadius = false
  expect(f.renderer.nestedPrefixPolicy('group', targets)).toBe(exact)
  delete f.renderer.scene.displayTentRadius
  expect(f.renderer.nestedPrefixPolicy('group', targets)).toBe(exact)
})
