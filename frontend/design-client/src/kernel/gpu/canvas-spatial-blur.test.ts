import { afterEach, expect, test, vi } from 'vitest'
import { WebGpuDriver } from './webgpu'
import { parameters, type GpuScene, type Texture } from './types'
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })
function fixture() {
  vi.stubGlobal('OffscreenCanvas', class {})
  const chosen: any[] = [], descriptors: any[] = []
  const driver = new WebGpuDriver(true), raw = driver as any
  Object.assign(raw, { displayImageBaseSource: 'test-only source placeholder; WGSL is separately checked on Metal',
    device: { features: new Set(), createShaderModule: (d: any) => d, createPipelineLayout: () => ({}),
      createRenderPipelineAsync: vi.fn(async (d: any) => { descriptors.push(d); return d }),
      pushErrorScope: vi.fn(), popErrorScope: vi.fn(async () => null) },
    layout: {}, pipelines: { prepare: async () => undefined, register() {} }, blank: { resource: {} },
    modePipelines: new Map([[12, {}], [61, { exact: 61 }], [62, { exact: 62 }]]),
    closeOver() {}, bind: () => ({ group: {}, offsets: [] }), bindingCache: { view: () => ({}) },
    encoder: { beginRenderPass: () => ({ setPipeline: (p: any) => chosen.push(p), setBindGroup() {}, draw() {}, end() {} }) },
  })
  const scene = { nodes: {}, integratedBlur: false, canvasBlurApproximation: true } as unknown as GpuScene
  const draw = (mode: number) => {
    const t = (): Texture => ({ width: 8, height: 8, bytes: 1024, resource: {} as GPUTexture })
    const u = parameters({ x: 0, y: 0, w: 8, h: 8 }); u[16] = mode
    driver.pass(t(), u, [t(), t()])
  }
  return { driver, raw, scene, draw, chosen, descriptors }
}
test('spatial preparation is lazy, separately keyed by motion/zoom and reuses completed pipelines', async () => {
  const f = fixture()
  await f.raw.prepareCanvasSpatialBlur(new Set([61])); await f.raw.prepareCanvasSpatialBlur(new Set([61]))
  expect(f.descriptors.map(p => p.fragment.entryPoint)).toEqual(['canvasMotionBlur'])
  await f.raw.prepareCanvasSpatialBlur(new Set([62]))
  expect(f.descriptors.map(p => p.fragment.entryPoint)).toEqual(['canvasMotionBlur', 'canvasZoomBlur'])
  expect(f.raw.device.pushErrorScope.mock.calls.length).toBe(f.raw.device.popErrorScope.mock.calls.length)
})
test('production encode selects spatial display only and returns to exact on the next export/HDR preparation', async () => {
  const f = fixture(); await f.raw.prepareCanvasSpatialBlur(new Set([61, 62]))
  await f.driver.prepareScene(f.scene, true); f.draw(61); f.draw(62)
  expect(f.chosen.map(p => p.fragment.entryPoint)).toEqual(['canvasMotionBlur', 'canvasZoomBlur'])
  expect(f.driver.canvasMotionBlurPasses).toBe(1); expect(f.driver.canvasZoomBlurPasses).toBe(1)
  await f.driver.prepareScene(f.scene, false); f.draw(61); f.draw(62)
  expect(f.chosen.slice(-2)).toEqual([{ exact: 61 }, { exact: 62 }])
  f.driver.hdr = true; await f.driver.prepareScene(f.scene, true); f.draw(61)
  expect(f.chosen.at(-1)).toEqual({ exact: 61 })
})
test('a rejected spatial pipeline keeps the original and does not retry each frame', async () => {
  const f = fixture(); vi.spyOn(console, 'warn').mockImplementation(() => {})
  f.raw.device.createRenderPipelineAsync.mockRejectedValue(Error('fixture'))
  await f.raw.prepareCanvasSpatialBlur(new Set([61])); await f.raw.prepareCanvasSpatialBlur(new Set([61]))
  expect(f.raw.device.createRenderPipelineAsync).toHaveBeenCalledOnce()
  await f.driver.prepareScene(f.scene, true); f.draw(61)
  expect(f.chosen).toEqual([{ exact: 61 }])
})
test('late spatial compilation cannot publish into a terminated device owner', async () => {
  const f = fixture(); vi.spyOn(console, 'warn').mockImplementation(() => {})
  let release!: (v: any) => void
  f.raw.device.createRenderPipelineAsync.mockImplementation(() => new Promise(resolve => { release = resolve }))
  const pending = f.raw.prepareCanvasSpatialBlur(new Set([62]))
  f.raw.terminal = true; release({}); await pending
  expect(f.raw.canvasSpatialPipelines.size).toBe(0)
})
test('Gaussian reconstruction is prepared even when the parallel prefix compiler finishes later',async()=>{
 vi.stubEnv('VITE_DESIGN_GAUSSIAN_PREFIX','1');vi.stubEnv('VITE_DESIGN_GAUSSIAN_REDUCTION','4')
 const f=fixture(),builds=new Map<string,()=>Promise<void>>()
 f.raw.pipelines={register:(key:string,build:()=>Promise<void>)=>builds.set(key,build),
   prepare:async(keys:Iterable<string>)=>{for(const key of keys)await builds.get(key)?.()}}
 const scene={...f.scene,nodes:{g:{id:'g',fill:{count:0},fills:[],strokes:[],effects:[],children:[],gaussianRegion:{factor:4}}}} as unknown as GpuScene
 expect(f.driver.supportsGaussianReduction()).toBe(false)
 await f.driver.prepareScene(scene,true)
 // prepareFilters can publish this after prepareScene has drained. It may
 // enable the operator, but must not leave its reconstruction shader absent.
 f.raw.boxPrefix={}
 expect(f.driver.supportsGaussianReduction()).toBe(true)
 expect(f.raw.modePipelines.has(74)).toBe(true)
 expect(f.descriptors.filter(p=>p.fragment.module?.label==='Reduced Gaussian display reconstruction')).toHaveLength(1)
})
