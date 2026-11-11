import {afterEach,expect,test,vi} from 'vitest'
import {gaussianPrefixDemand,gaussianPrefixWorthwhile} from './gaussian-selection'
import {WebGpuDriver} from './webgpu'
import {BoxPrefix,BOX_PREFIX_BYTES,boxPrefixBandLines} from './box-prefix'
import {parameters} from './types'

afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();vi.restoreAllMocks()})

test('automatic selection stays within ordinary Gaussian support and avoids tiny or narrow crops',()=>{
  expect(gaussianPrefixWorthwhile(32,256,256,65536)).toBe(true)
  expect(gaussianPrefixWorthwhile(512,16384,16384,65536)).toBe(true)
  for(const r of [0,31,32.5,513,NaN,Infinity])expect(gaussianPrefixWorthwhile(r,256,256,65536)).toBe(false)
  expect(gaussianPrefixWorthwhile(32,16384,8,65536)).toBe(false)
  expect(gaussianPrefixWorthwhile(32,32,32,1024)).toBe(false)
  expect(gaussianPrefixWorthwhile(32,16385,16385,65536)).toBe(false)
})

test('the original 4 MiB prefix scratch fits 62 rows of the wide 117 Gaussian input',()=>{
  expect(boxPrefixBandLines(4188)).toBe(62)
  expect(boxPrefixBandLines(4093)).toBe(64)
})

test('pipeline preparation uses transformed Gaussian demand without treating tent or small effects as Gaussian',()=>{
  const node={rect:{w:256,h:256},matrix:[4,0,0,4,0,0],effects:[{kind:'gaussian-blur',radius:10,visible:true}]}
  expect(gaussianPrefixDemand(node)).toBe(true)
  expect(gaussianPrefixDemand({...node,matrix:[1,0,0,1,0,0]})).toBe(false)
  expect(gaussianPrefixDemand({...node,effects:[{...node.effects[0],kind:'blur'}]})).toBe(false)
  expect(gaussianPrefixDemand({...node,effects:[{...node.effects[0],visible:false}]})).toBe(false)
  expect(gaussianPrefixDemand({...node,matrix:[Infinity,0,0,1,0,0]})).toBe(false)
  expect(gaussianPrefixDemand({effects:[]} as any)).toBe(false)
})

function fixture(){
  vi.stubGlobal('OffscreenCanvas',class {})
  const driver=new WebGpuDriver(true),raw=driver as any
  const texture=(format='rgba32float')=>({width:64,height:64,bytes:64*64*16,resource:{format,width:64,height:64}})
  const source=texture(),target=texture(),kernel=texture('rgba8unorm')
  for(const t of [source,target,kernel])raw.textures.add(t)
  raw.boxKernels.set(kernel,{radius:32,resource:kernel.resource,width:kernel.width,height:kernel.height})
  const reserve=vi.fn(()=>{raw.boxPrefix.scratchBytes=BOX_PREFIX_BYTES})
  Object.assign(raw,{canvasBlurRequested:true,boxPrefix:{scratchBytes:0,reserve},gaussianPrefixRequested:true,
    filterPipelines:[{},{},{},{}],canvasBlurRgbaPipeline:{},device:{pushErrorScope:vi.fn(),popErrorScope:vi.fn(async()=>null)}})
  const u=parameters({x:0,y:0,w:64,h:64});u[16]=22;u.set([32,0,0,2],36)
  return {driver,raw,source,target,kernel,u,reserve}
}

test('the direct small box requires the live uniform kernel and an integral transparent lattice',()=>{
  const f=fixture()
  f.u[36]=9
  f.raw.boxKernels.set(f.kernel,{radius:9,resource:f.kernel.resource,width:f.kernel.width,height:f.kernel.height})
  const eligible=()=>f.raw.canvasUniformBoxEligible(f.target,f.u,[f.source,f.kernel])
  expect(eligible()).toBe(true)
  f.u[0]=0.25
  expect(eligible()).toBe(false)
  f.u[0]=0
  f.u[38]=1
  expect(eligible()).toBe(false)
  f.u[38]=0
  f.raw.boxKernels.delete(f.kernel)
  expect(eligible()).toBe(false)
})

test('actual allocation requires private live coefficient proof and remaining original scratch budget',()=>{
  const f=fixture(),inputs=[f.source,f.kernel]
  f.driver.prepareCanvasBoxPass(f.target,f.u,inputs,15,BOX_PREFIX_BYTES-1);expect(f.reserve).not.toHaveBeenCalled()
  f.driver.prepareCanvasBoxPass(f.target,f.u,inputs,15,BOX_PREFIX_BYTES);expect(f.reserve).toHaveBeenCalledOnce()
  f.raw.boxPrefix.scratchBytes=0;f.reserve.mockClear()
  f.raw.invalidateTextureCertificates(f.kernel)
  f.driver.prepareCanvasBoxPass(f.target,f.u,inputs,15,BOX_PREFIX_BYTES);expect(f.reserve).not.toHaveBeenCalled()
})

test('unknown physical resource, fractional phase, HDR, exact and small work retain direct execution',()=>{
  for(const mutate of [
    (f:any)=>{f.source.resource={...f.source.resource,format:'rgba16float'}},
    (f:any)=>{f.kernel.resource={...f.kernel.resource}},
    (f:any)=>{f.u[0]=.25},(f:any)=>{f.driver.hdr=true},
    (f:any)=>{f.raw.canvasBlurRequested=false},(f:any)=>{f.raw.gaussianAutoEnabled=false},
    (f:any)=>{f.u[39]=1},(f:any)=>{f.u[36]=513},
    (f:any)=>{f.target.width=f.target.height=16;f.u[2]=f.u[3]=16},
  ]){const f=fixture();mutate(f);f.driver.prepareCanvasBoxPass(f.target,f.u,[f.source,f.kernel],15,BOX_PREFIX_BYTES);expect(f.reserve).not.toHaveBeenCalled()}
})

test('automatic box execution does not enable regional or reduced geometry policies',()=>{
  const f=fixture();expect(f.driver.supportsGaussianRegions()).toBe(false);expect(f.driver.supportsGaussianReduction()).toBe(false)
  vi.stubEnv('VITE_DESIGN_GAUSSIAN_PREFIX','1');expect(f.driver.supportsGaussianRegions()).toBe(true)
  vi.stubEnv('VITE_DESIGN_GAUSSIAN_REDUCTION','2');expect(f.driver.supportsGaussianReduction()).toBe(true)
})

test('full-density recovery can stream an SDR tile without enabling spatial reduction', () => {
  const {driver, raw} = fixture()
  raw.fullDensityRegionalGaussian = true
  vi.stubEnv('VITE_DESIGN_GAUSSIAN_REDUCTION', '2')
  expect(driver.supportsGaussianRegions()).toBe(true)
  expect(driver.supportsGaussianReduction()).toBe(false)
  raw.canvasBlurRequested = false
  expect(driver.supportsGaussianRegions()).toBe(false)
  raw.canvasBlurRequested = true
  driver.hdr = true
  expect(driver.supportsGaussianRegions()).toBe(false)
})

test('pipeline rejection falls back once, and a completed pipeline cannot publish after disposal',async()=>{
  for(const disposed of [false,true]){
    const f=fixture();f.raw.boxPrefix=undefined
    vi.spyOn(console,'warn').mockImplementation(()=>{})
    const create=vi.spyOn(BoxPrefix,'create').mockImplementation(async()=>{if(disposed){f.raw.disposed=true;f.raw.terminal=true;return {} as BoxPrefix}throw Error('compile rejected')})
    await f.driver.prepareFilters();expect(f.raw.boxPrefix).toBeUndefined();expect(f.raw.boxPrefixFailed).toBe(true)
    await f.driver.prepareFilters();expect(create).toHaveBeenCalledOnce()
    expect(f.raw.device.pushErrorScope).toHaveBeenCalledOnce();expect(f.raw.device.popErrorScope).toHaveBeenCalledOnce()
    create.mockRestore()
  }
})
