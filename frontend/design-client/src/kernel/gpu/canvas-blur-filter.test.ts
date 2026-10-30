import { afterEach, expect, test, vi } from 'vitest'
import { canvasBlurPassEligible, canvasBlurSceneEligible } from './canvas-blur-filter'
import { WebGpuDriver } from './webgpu'
import { GpuRenderer } from './renderer'
import { parameters, type GpuScene, type Texture } from './types'

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

test('canvas arithmetic defaults on and the explicit build-time zero retains the old renderer', () => {
  vi.stubEnv('VITE_DESIGN_CANVAS_BLUR_FLOAT', undefined)
  expect((new GpuRenderer({} as any) as any).canvasBlurEnabled).toBe(true)
  vi.stubEnv('VITE_DESIGN_CANVAS_BLUR_FLOAT', '0')
  expect((new GpuRenderer({} as any) as any).canvasBlurEnabled).toBe(false)
})

test('only an SDR presentation of an integrated tent scene can select canvas arithmetic', () => {
  const scene = { integratedBlur: true }, driver = { name: 'webgpu', managed: true }
  expect(canvasBlurSceneEligible(true, scene, driver, false, true)).toBe(true)
  for (const [readback, present] of [[true, true], [true, false], [false, false]])
    expect(canvasBlurSceneEligible(true, scene, driver, readback, present)).toBe(false)
  for (const change of [{ hdr: true }, { managed: false }, { name: 'webgl2' }, { displayMath: true }])
    expect(canvasBlurSceneEligible(true, scene, { ...driver, ...change }, false, true)).toBe(false)
  for (const change of [{ softwareRaster: true }, { displayFilters: true }])
    expect(canvasBlurSceneEligible(true, { ...scene, ...change }, driver, false, true)).toBe(false)
  expect(canvasBlurSceneEligible(false, scene, driver, false, true)).toBe(false)
  expect(canvasBlurSceneEligible(true, { integratedBlur: false }, driver, false, true)).toBe(true)
})

test('pass metadata separates explicit boxes, tent kernels and unsupported work', () => {
  const u = parameters({ x: 0, y: 0, w: 8, h: 8 }); u[16] = 22; u[39] = 1
  for (const radius of [.3, 32 + 2 ** -30, 38.25948715209961, 612.1517944335938, 2048]) {
    u[36] = radius
    expect(canvasBlurPassEligible(true, u, 15, { kind: 'tent', radius })).toBe(true)
    expect(canvasBlurPassEligible(true, u, 8, { kind: 'tent', radius })).toBe(true)
  }
  for (const radius of [0, -1, Infinity, NaN, 2048 + 2 ** -30]) {
    u[36] = radius; expect(canvasBlurPassEligible(true, u, 15, { kind: 'tent', radius })).toBe(false)
  }
  u[36] = 19; u[39] = 2
  expect(canvasBlurPassEligible(true, u, 15, { kind: 'tent', radius: 19 })).toBe(false)
  expect(canvasBlurPassEligible(true, u, 15)).toBe(true)
  u[36] = 513
  expect(canvasBlurPassEligible(true, u, 15)).toBe(false)
  u[36] = 19
  u[39] = 1
  expect(canvasBlurPassEligible(true, u, 15)).toBe(false)
  expect(canvasBlurPassEligible(true, u, 15, { kind: 'tent', radius: 18 })).toBe(false)
  for (const coordinate of [1048577, -1048577]) {
    u[0] = coordinate
    expect(canvasBlurPassEligible(true, u, 15, { kind: 'tent', radius: 19 })).toBe(false)
  }
})

function fixture() {
  vi.stubGlobal('OffscreenCanvas', class {})
  const chosen: any[] = []
  const driver = new WebGpuDriver(true), raw = driver as any
  Object.assign(raw, { device: { features: new Set(), createShaderModule: (d: any) => ({ ...d, getCompilationInfo: async () => ({ messages: [] }) }),
    createPipelineLayout: () => ({}), createRenderPipelineAsync: async (d: any) => d, pushErrorScope() {}, popErrorScope: async () => null },
    layout: {}, pipelines: { prepare: async () => undefined, register() {} },
    blank: { resource: {} }, modePipelines: new Map([[12, {}]]), closeOver() {}, bind: () => ({ group: {}, offsets: [] }),
    bindingCache: { view: () => ({}) }, encoder: { beginRenderPass: () => ({ setPipeline: (p: any) => chosen.push(p), setBindGroup() {}, draw() {}, end() {} }) } })
  const scene = { nodes: {}, integratedBlur: true, canvasBlurApproximation: true } as unknown as GpuScene
  const draw = (box = false, scalar = false, radius = 38.25) => {
    const t = (): Texture => ({ width: 8, height: 8, bytes: 1024, resource: {} as GPUTexture })
    const target = t(); if (scalar) target.scalarCoverage = true; target.opaqueAlpha = true; target.finitePixels = true
    const u = parameters({ x: 0, y: 0, w: 8, h: 8 }); u[16] = 22; u.set(box ? [9, 0, 0, 2] : [radius, 0, 0, 1], 36)
    driver.pass(target, u, [t(), t()], undefined, scalar ? 8 : 15, box ? undefined : { kind: 'tent', radius })
    return target
  }
  return { driver, raw, chosen, scene, draw }
}

test('production pass selects the candidate, revokes certificates, and returns to exact on the next non-display scene', async () => {
  const f = fixture()
  await f.driver.prepareScene(f.scene, true); await f.driver.prepareFilters()
  const output = f.draw()
  expect(f.chosen).toHaveLength(1)
  expect(f.chosen.every(p => p.fragment.entryPoint === 'fragmentRgba')).toBe(true)
  expect(output.finitePixels).toBeUndefined(); expect(output.opaqueAlpha).toBeUndefined()
  expect(f.driver.canvasBlurPasses).toBe(1)
  f.draw(true)
  expect(f.chosen.at(-1).fragment.entryPoint).toBe('fragmentRgba')
  expect(f.driver.canvasBlurPasses).toBe(2)
  f.draw(false, true)
  expect(f.chosen.at(-1).fragment.targets[0].format).toBe('r32float')
  expect(f.chosen.at(-1).fragment.module.label).toBe('Canvas rational-coefficient blur')
  // A rounded uniform cannot grant the private >2048 shadow coefficient lane.
  f.draw(false, true, 2048 + 2 ** -30)
  expect(f.chosen.at(-1).fragment.module.label).toBe('Exact rational filter')
  f.chosen.length = 0
  await f.driver.prepareScene(f.scene, false); await f.driver.prepareFilters(); f.draw()
  expect(f.chosen.every(p => p.fragment.module.label === 'Exact rational filter')).toBe(true)
})

test('optional pipeline rejection retains exact rendering without repeated preparation', async () => {
  const f = fixture(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const create = f.raw.device.createRenderPipelineAsync
  f.raw.device.createRenderPipelineAsync = vi.fn((d: any) => d.fragment.module.label.startsWith('Canvas') ? Promise.reject(Error('fixture')) : create(d))
  await f.driver.prepareScene(f.scene, true); await f.driver.prepareFilters(); f.draw()
  expect(f.chosen.every(p => p.fragment.module.label === 'Exact rational filter')).toBe(true)
  const calls = f.raw.device.createRenderPipelineAsync.mock.calls.length
  await f.driver.prepareScene(f.scene, true); await f.driver.prepareFilters()
  expect(f.raw.device.createRenderPipelineAsync).toHaveBeenCalledTimes(calls)
  expect(warn).toHaveBeenCalledOnce()
})

test('a synchronous shader exception balances its error scope before exact fallback', async () => {
  const f = fixture(), create = f.raw.device.createShaderModule
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  f.raw.device.pushErrorScope = vi.fn(); f.raw.device.popErrorScope = vi.fn(async () => null)
  f.raw.device.createShaderModule = (d: any) => { if (d.label.startsWith('Canvas')) throw Error('fixture'); return create(d) }
  await f.driver.prepareScene(f.scene, true); await f.driver.prepareFilters(); f.draw()
  expect(f.raw.device.pushErrorScope.mock.calls.length).toBe(f.raw.device.popErrorScope.mock.calls.length)
  expect(f.chosen.every(p => p.fragment.module.label === 'Exact rational filter')).toBe(true)
})


test('RGBA preparation failure and explicit zero keep the channel reducers',async()=>{
 for(const disabled of [true,false]){
  vi.stubEnv('VITE_DESIGN_CANVAS_BLUR_RGBA',disabled?'0':undefined)
  const f=fixture(),create=f.raw.device.createRenderPipelineAsync
  vi.spyOn(console,'warn').mockImplementation(()=>{})
  f.raw.device.createRenderPipelineAsync=(d:any)=>d.fragment.entryPoint==='fragmentRgba'?Promise.reject(Error('RGBA-only fixture')):create(d)
  await f.driver.prepareScene(f.scene,true);await f.driver.prepareFilters();f.draw()
  expect(f.chosen).toHaveLength(4)
  expect(f.chosen.every(p=>p.fragment.module.label==='Canvas rational-coefficient blur')).toBe(true)
 }
})
