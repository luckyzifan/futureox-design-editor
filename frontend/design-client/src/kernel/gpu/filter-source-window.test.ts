import { afterEach, expect, test, vi } from 'vitest'
import { WebGpuDriver } from './webgpu'
import { TexturePrefix, PREFIX_SCRATCH_BYTES } from './texture-prefix'
import { exactFilterWgsl } from './exact-filter'
import prefixShader from './texture-prefix.wgsl?raw'
import { filterSourceWindowUniforms, snapshotFilterSourceWindow } from './filter-source-window'
import { parameters, type Texture } from './types'

afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.restoreAllMocks()})
const radius=38.25948715209961
function driverFixture(prefixAccepted=true) {
  vi.stubEnv('VITE_DESIGN_FILTER_SOURCE_WINDOW','1')
  vi.stubGlobal('OffscreenCanvas',class {})
  vi.stubGlobal('GPUTextureUsage',{TEXTURE_BINDING:1,RENDER_ATTACHMENT:2,COPY_SRC:4,COPY_DST:8})
  const encodes:any[][]=[],bound:Float32Array[]=[],passes:any[]=[],driver=new WebGpuDriver(true)
  const prefix={scratchBytes:0,lastRenderPasses:1,canEncode:vi.fn(()=>true),
    reserveScratch:vi.fn(()=>{prefix.scratchBytes=PREFIX_SCRATCH_BYTES}),resetCounters:vi.fn(),
    encode:vi.fn((...args:any[])=>{encodes.push(args);return prefixAccepted})}
  Object.assign(driver,{device:{limits:{maxTextureDimension2D:16384},createTexture:({size,format}:any)=>({width:size[0],height:size[1],format,createView:()=>({}),destroy(){}})},
    prefix,blank:{},filterPipelines:['filter0','filter1','filter2','filter3'],modePipelines:new Map([[12,'mode12']]),
    encoder:{beginRenderPass(descriptor:any){const record:any={descriptor,pipelines:[]};passes.push(record);return {
      setPipeline(value:unknown){record.pipelines.push(value)},setBindGroup(){},draw(){},end(){}}}},
    closeOver(){},bindingCache:{view:()=>({})},bind(u:Float32Array){bound.push(u.slice());return {group:{},offsets:[]}}})
  const source=driver.create(130,140),target=driver.create(12,12),kernel=driver.create(8,1)
  const u=parameters({x:30,y:60,w:12,h:12},{x:-10,y:20,w:100,h:100});u[16]=22;u[36]=radius;u[37]=0
  const window={x:11,y:17,w:100,h:100},inputs=[source,kernel]
  const call=()=>driver.passFilterWindow(target,u,inputs,window,15,{kind:'tent',radius},PREFIX_SCRATCH_BYTES)
  return {driver,prefix,source,target,kernel,u,window,inputs,encodes,bound,passes,call}
}

test('window geometry snapshots bounded physical coordinates without changing logical extents',()=>{
  const f=driverFixture(),window=snapshotFilterSourceWindow(f.source.resource as GPUTexture,f.u,f.window)!
  expect(window).toEqual(f.window);expect(Object.isFrozen(window)).toBe(true)
  f.window.x=999;expect(window.x).toBe(11)
  const u=filterSourceWindowUniforms(f.u,window)
  expect(u).not.toBe(f.u);expect([...u.slice(208,212)]).toEqual([11,17,1,0])
  expect([...u.slice(4,8)]).toEqual([-10,20,100,100]);expect([...f.u.slice(208,212)]).toEqual([0,0,0,0])
  expect(filterSourceWindowUniforms(f.u)).toBe(f.u)
})

test.each([true,false])('driver uses the same logical window when prefix acceptance is %s',accepted=>{
  const f=driverFixture(accepted),before=f.u.slice()
  expect(f.call()).toBe(true);expect(f.u).toEqual(before)
  expect(f.prefix.canEncode).toHaveBeenCalledOnce();expect(f.prefix.reserveScratch).toHaveBeenCalledOnce()
  expect(f.encodes).toHaveLength(1)
  expect([...f.encodes[0][3].slice(208,212)]).toEqual([11,17,1,0]);expect(f.encodes[0][11]).toEqual(f.window)
  if(accepted)expect(f.passes).toHaveLength(0)
  else {expect(f.passes[0].pipelines).toEqual(['filter0','filter1','filter2','filter3']);expect([...f.bound[0].slice(208,212)]).toEqual([11,17,1,0])}
})

test('opaque alpha is inherited only from the physical input and still uses logical support',()=>{
  const f=driverFixture();f.source.opaqueAlpha=true
  expect(f.call()).toBe(true);expect(f.encodes[0][7]).toBe(7);expect(f.encodes[0][9]).toBe(true)
  expect(f.encodes[0][11]).toEqual(f.window);expect(f.target.opaqueAlpha).toBe(true)
})

test('driver captures uniforms, window and input array before preparation can yield through a rollover hook',()=>{
  const f=driverFixture(),source=f.source.resource
  f.prefix.canEncode.mockImplementationOnce(()=>{f.u.fill(0);f.window.x=999;f.inputs.length=0;return true})
  expect(f.call()).toBe(true)
  expect(f.encodes[0][2][0]).toBe(source)
  expect([...f.encodes[0][3].slice(4,8)]).toEqual([-10,20,100,100])
  expect([...f.encodes[0][3].slice(208,212)]).toEqual([11,17,1,0])
  expect(f.encodes[0][11]).toEqual({x:11,y:17,w:100,h:100})
})

test('invalid or disabled windows encode nothing and do not revoke target certificates',()=>{
  const changes:((f:ReturnType<typeof driverFixture>)=>void)[]=[
    f=>{vi.stubEnv('VITE_DESIGN_FILTER_SOURCE_WINDOW','0')},f=>{vi.stubEnv('VITE_DESIGN_FILTER_SOURCE_WINDOW','true')},
    f=>{f.window.x=-1},f=>{f.window.y=.5},f=>{f.window.w=0},f=>{f.window.x=31},f=>{f.window.h=NaN},
    f=>{f.u[6]=99},f=>{f.u[0]=Infinity},f=>{f.u[16]=3},f=>{f.u[37]=2},
    f=>{f.inputs[0]={...f.source}},f=>{f.target.resource=f.source.resource},f=>{f.source.scalarCoverage=true},
    f=>{(f.source.resource as any).format='rgba8unorm'},f=>{(f.driver as any).disposed=true},
    f=>{(f.driver as any).filterPipelines=[]},f=>{f.source.width=129},
    f=>{(f.source as any).resource=undefined},f=>{(f.target as any).resource=undefined},
  ]
  for(const mutate of changes){const f=driverFixture();f.target.finitePixels=true;mutate(f)
    expect(f.call()).toBe(false);expect(f.prefix.canEncode).not.toHaveBeenCalled();expect(f.encodes).toHaveLength(0)
    expect(f.passes).toHaveLength(0);expect(f.target.finitePixels).toBe(true)}
  const f=driverFixture(),shared=new Float32Array(new SharedArrayBuffer(1024));shared.set(f.u);f.target.finitePixels=true
  expect(f.driver.passFilterWindow(f.target,shared,f.inputs,f.window,15,{kind:'tent',radius},PREFIX_SCRATCH_BYTES)).toBe(false)
  expect(f.target.finitePixels).toBe(true);expect(f.encodes).toHaveLength(0)
  expect(snapshotFilterSourceWindow(f.source.resource as GPUTexture,shared,f.window)).toBeUndefined()
})

test('ordinary mode22 clears untrusted addressing but leaves caller storage and other modes alone',()=>{
  const f=driverFixture(false);f.u.set([11,17,1,99],208)
  f.driver.pass(f.target,f.u,f.inputs,undefined,15,{kind:'tent',radius})
  expect([...f.encodes[0][3].slice(208,212)]).toEqual([0,0,0,0])
  expect([...f.bound[0].slice(208,212)]).toEqual([0,0,0,0]);expect([...f.u.slice(208,212)]).toEqual([11,17,1,99])
  f.u[16]=12;f.driver.pass(f.target,f.u,[])
  expect([...f.bound.at(-1)!.slice(208,212)]).toEqual([11,17,1,99])
})

test('window target writes permanently revoke private source certificates',()=>{
  const f=driverFixture(),raw=f.driver as any
  f.target.finitePixels=true;raw.imageRanges.set(f.target,{});raw.imageAxisPrograms.set(f.target,new Float32Array(8))
  expect(f.call()).toBe(true);f.target.finitePixels=true
  expect(f.driver.imageTableRange(f.target)).toBeUndefined();expect(f.driver.imageTableAxes(f.target)).toBeUndefined()
})

function prefixFixture(axis:0|1,opaque:boolean){
  vi.stubEnv('VITE_DESIGN_FILTER_SOURCE_WINDOW','1');vi.stubEnv('VITE_DESIGN_PREFIX_RGB_RESOLVE',opaque?'1':'0')
  const uniforms:Float32Array[]=[],events:any[]=[];let epoch=0,count=0
  const encoder=(id:number)=>({beginComputePass(){expect(id).toBe(epoch);return pass()},beginRenderPass(){expect(id).toBe(epoch);return pass()}})
  let active=encoder(epoch)
  const pass=()=>{const event:any={};events.push(event);return {setPipeline(p:unknown){event.pipeline=p},setBindGroup(){},dispatchWorkgroups(...v:number[]){event.dispatch=v},setScissorRect(){},draw(){},end(){}}}
  const texture=(width:number,height:number)=>({width,height,format:'rgba32float',createView:()=>({})}) as unknown as GPUTexture
  const source=texture(4000,6556),target=texture(axis===0?1032:59,axis===0?59:1032)
  const logical={x:-15,y:23,w:axis===0?3484:59,h:axis===0?59:3484}
  const output={x:logical.x+(axis===0?1226:0),y:logical.y+(axis===1?1226:0),w:target.width,h:target.height}
  const base=parameters(output,logical);base[16]=22;base[36]=1224.3035888671875;base[37]=axis
  const window={x:13,y:1024,w:logical.w,h:logical.h},prefix=Object.create(TexturePrefix.prototype) as TexturePrefix
  Object.assign(prefix,{device:{createBindGroup:()=>({})},sourceLayout:{},scratchGroup:{},scan:'scan',solve:'solve',solveRgb:'rgbSolve',resolve:['r0','r1','r2','r3'],resolveRgb:'rgbResolve',
    uniform(u:Float32Array){if(count++%2===1)active=encoder(++epoch);uniforms.push(u.slice());return {buffer:{},offset:0,size:1024}}})
  const inputs=[source,texture(1,1),texture(1,1)],run=(physical=window)=>prefix.encode(()=>active as unknown as GPUCommandEncoder,target,inputs,base,1224.3035888671875,'tent',output,opaque?7:15,255,opaque,0,physical)
  return {prefix,uniforms,events,run,source,target,inputs,base,window,output,get epoch(){return epoch}}
}
test.each([[0,false],[1,false],[0,true],[1,true]] as const)('prefix axis %s opaque %s scans only the logical window through encoder rollovers',(axis,opaque)=>{
  const f=prefixFixture(axis,opaque),original=f.base.slice()
  expect(f.run()).toBe(true);expect(f.base).toEqual(original);expect(f.epoch).toBeGreaterThan(0)
  expect(f.uniforms.every(u=>u[192]===3484)).toBe(true)
  expect(f.uniforms.every(u=>u[6]===f.window.w&&u[7]===f.window.h)).toBe(true)
  expect(f.uniforms.every(u=>[...u.slice(208,212)].join(',')==='13,1024,1,0')).toBe(true)
  expect(f.prefix.lastRenderPasses).toBe(opaque?3:12)
  expect(f.uniforms.some(u=>u[192]===6556||u[192]===4000)).toBe(false)
})

test('direct prefix entry rejects unknown/disabled/shared windows and larger physical textures without a window',()=>{
  const f=prefixFixture(1,false)
  expect(f.prefix.encode({} as GPUCommandEncoder,f.target,f.inputs,f.base,1224.3035888671875,'tent',f.output)).toBe(false)
  expect(f.run({...f.window,y:4000})).toBe(false)
  vi.stubEnv('VITE_DESIGN_FILTER_SOURCE_WINDOW','0');expect(f.run()).toBe(false)
  expect(f.uniforms).toHaveLength(0)
})

test('prefix window/base snapshots survive caller mutation during real uniform allocation hooks',()=>{
  const f=prefixFixture(1,true),uniform=(f.prefix as any).uniform
  ;(f.prefix as any).uniform=(u:Float32Array)=>{const result=uniform(u);f.base[7]=1;f.window.y=6000;return result}
  expect(f.run()).toBe(true)
  expect(f.uniforms.every(u=>u[7]===3484&&u[192]===3484&&u[209]===1024)).toBe(true)
})

test('prefix and both scalar reducers map only after their unchanged logical bounds and clamp',()=>{
  vi.stubEnv('VITE_DESIGN_FILTER_SOURCE_WINDOW','1')
  const shader=exactFilterWgsl(true)
  expect(shader.match(/textureLoad\(sourceA,filterSourcePixel\(q\),0\)/g)).toHaveLength(2)
  for(const name of ['rfSource','rfCertifiedSource']){
    const start=shader.indexOf(`fn ${name}(`),end=shader.indexOf('\n}',start),body=shader.slice(start,end)
    expect(body.indexOf('p=clamp')).toBeLessThan(body.indexOf('filterSourcePixel(q)'))
    expect(body.indexOf('q>=vec2<i32>(u(1).zw)')).toBeLessThan(body.indexOf('filterSourcePixel(q)'))
  }
  expect(prefixShader).toContain('var along=i32(x)')
  expect(prefixShader).toContain('return filterSourcePixel(vec2<i32>(along,i32(line)))')
  expect(prefixShader).toContain('return filterSourcePixel(vec2<i32>(i32(line),along))')
  expect(prefixShader.indexOf('along=clamp')).toBeLessThan(prefixShader.indexOf('return filterSourcePixel'))
  vi.stubEnv('VITE_DESIGN_FILTER_SOURCE_WINDOW','0')
  expect(exactFilterWgsl(true)).toContain('const FILTER_SOURCE_WINDOWS:bool=false;')
})
