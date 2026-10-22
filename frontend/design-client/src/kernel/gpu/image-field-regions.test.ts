import {expect,test,vi,afterEach} from 'vitest'
import { image_sampling_grid_placed } from '../../generated/design-kernel/design_kernel'
import {setGpuDiagnosticSink,sanitizeFields} from '../../../../design-desktop/src/render-terminal-diagnostics.mjs'
afterEach(()=>setGpuDiagnosticSink(undefined))
import {GpuRenderer} from './renderer'
import {inverse} from '../../geometry'
import type {Driver,Texture} from './types'
function fixture(width=2049,height=2048) {
 const make=(w:number,h:number)=>({width:w,height:h,bytes:w*h*16,resource:{}} as Texture)
 const fields:{width:number;height:number;bytes:number;head:number[]}[]=[],passes:any[]=[]
 const driver={name:'webgpu',managed:true,linearLight:true,scratchBytes:0,create:vi.fn(make),clear:vi.fn(),destroy:vi.fn(),
  uploadLinear:vi.fn((_values:Float32Array,w:number,h:number)=>make(w,h)),
  uploadParameters:vi.fn((values:Float32Array,w:number,h:number)=>{fields.push({width:w,height:h,bytes:values.byteLength,head:Array.from(new Uint32Array(values.buffer,values.byteOffset,Math.min(values.length,32)))});return make(w,h)}),
  pass:vi.fn((target:Texture,u:Float32Array,inputs:Texture[],region:any,_channels?:number,_filter?:unknown,clearOutside?:boolean)=>{passes.push({target,u:u.slice(),inputs:[...inputs],region,clearOutside})}),checkpoint:vi.fn(async()=>{})}
 const loader=vi.fn(()=>({width:8,height:8,pixels:new Float32Array(8*8*4).fill(.5)}))
 const r=new GpuRenderer(driver as unknown as Driver,true,false,loader as any,false,false,1024) as any
 r.scene={floatCompositing:true,coherentSamples:true,nodes:{}};r.sampleIndex=0
 const rect={x:-137,y:-59,w:width,h:height},matrix=[Math.cos(Math.PI/12),Math.sin(Math.PI/12),-Math.sin(Math.PI/12),Math.cos(Math.PI/12),0,0]
 const p={kind:'image',image:'data:image/png;base64,AA==',color:'#ffffff',opacity:1,blend:'normal',visible:true,stops:[],angle:0,fit:'stretch'}
 const n={id:'controlled-rotated-image',rect,size:[736,414],matrix,inverse:inverse(matrix as any),fills:[p],children:[],effects:[],strokes:[]}
 const mask={texture:make(width,height),rect},dst={texture:make(width,height),rect};r.busy.add(mask.texture);r.busy.add(dst.texture);r.bytes=mask.texture.bytes+dst.texture.bytes
 return {r,n,p,mask,dst,driver,fields,passes}
}
test('async rotated image paint above64MiB uses bounded exact fields rather than rejecting the full field',async()=>{
 const f=fixture()
 await expect(Promise.resolve().then(()=>f.r.paintOver(f.n,f.p,f.mask,f.dst,undefined,true))).resolves.toBeDefined()
 expect(f.fields.length).toBeGreaterThan(1)
 expect(f.fields.every(v=>v.bytes<=64*1024*1024)).toBe(true)
 const paintPasses=f.passes.filter(p=>p.u[16]===2)
 expect(paintPasses.length).toBe(f.fields.length)
 expect(paintPasses.every(p=>p.region && !p.clearOutside)).toBe(true)
 expect(paintPasses.reduce((a,p)=>a+p.region.w*p.region.h,0)).toBe(2049*2048)
 expect(new Set(paintPasses.map(p=>p.target)).size).toBe(1)
})

test('large separable image keeps one compact field instead of forcing dense regions',async()=>{
 const f=fixture(); f.n.matrix=[1,0,0,1,0,0];f.n.inverse=[1,0,0,1,0,0]
 await expect(Promise.resolve().then(()=>f.r.paintOver(f.n,f.p,f.mask,f.dst,undefined,true))).resolves.toBeDefined()
 expect(f.fields).toHaveLength(1);expect(f.fields[0].height).toBe(2)
 expect(f.fields[0].bytes).toBeLessThan(64*1024*1024)
})
test('preview placement changes destination origins but retains original source mapping',async()=>{
 const f=fixture(), original={...f.n,rect:{...f.n.rect}}, offset=[19,-31]
 f.n={...f.n,rect:{...f.n.rect,x:f.n.rect.x+offset[0],y:f.n.rect.y+offset[1]},previewSource:original} as any
 f.mask.rect=f.n.rect;f.dst.rect=f.n.rect
 await f.r.paintOver(f.n,f.p,f.mask,f.dst,undefined,true)
 const passes=f.passes.filter(p=>p.u[16]===2)
 for(let i=0;i<passes.length;i++){
  const region=passes[i].region, sourceRect={x:original.rect.x+region.x,y:original.rect.y+region.y,w:region.w,h:region.h}
  const expected=image_sampling_grid_placed(JSON.stringify(sourceRect),new Float64Array(original.matrix),new Float64Array(f.n.size),new Uint32Array([8,8]),JSON.stringify(f.p),0,0,new Int32Array([0,0]))
  expect(f.fields[i].head).toEqual(Array.from(new Uint32Array(expected.buffer,expected.byteOffset,32)))
  expect(Array.from(passes[i].u.slice(204,206))).toEqual([f.n.rect.x+region.x,f.n.rect.y+region.y])
 }
})
test.each([0,1,2,3,undefined])('original sample phase%s survives all regional passes',async sample=>{
 const f=fixture();f.r.sampleIndex=sample
 await f.r.paintOver(f.n,f.p,f.mask,f.dst,undefined,true)
 const passes=f.passes.filter(p=>p.u[16]===2)
 const offsets=sample===undefined?[0,0]:[[-.125,-.375],[.375,-.125],[-.375,.125],[.125,.375]][sample]
 expect(passes.every(p=>Array.from(p.u.slice(184,186)).every((v,i)=>v===offsets[i]))).toBe(true)
 expect(f.r.sampleIndex).toBe(sample)
})
test('pressure completion keeps the image pinned and mask/destination busy',async()=>{
 const f=fixture(),bytes=f.n.rect.w*f.n.rect.h*16
 const pooled={width:4096,height:4096,bytes:256*1024*1024,resource:{}} as Texture
 f.r.free.set('4096:4096',[pooled]);f.r.used.add(pooled);f.r.bytes=f.r.frameBudget-Math.floor(bytes/2)
 f.driver.checkpoint.mockImplementation(async()=>{
  expect(f.r.sequentialImagePins.size).toBe(1)
  expect(f.r.busy.has(f.mask.texture)).toBe(true);expect(f.r.busy.has(f.dst.texture)).toBe(true)
 })
 await f.r.paintOver(f.n,f.p,f.mask,f.dst,undefined,true)
 expect(f.driver.checkpoint).toHaveBeenCalled();expect(f.r.sequentialImagePins.size).toBe(0)
 expect(f.driver.destroy).toHaveBeenCalledWith(pooled)
})
test('failed regional encoding releases its new output and pin, not caller masks or destination',async()=>{
 const f=fixture();f.driver.pass.mockImplementation(()=>{throw Error('encode failed')})
 await expect(f.r.paintOver(f.n,f.p,f.mask,f.dst,undefined,true)).rejects.toThrow('encode failed')
 expect(f.r.sequentialImagePins.size).toBe(0)
 expect(f.r.busy.has(f.mask.texture)).toBe(true);expect(f.r.busy.has(f.dst.texture)).toBe(true)
 expect(f.r.busy.size).toBeLessThanOrEqual(3) // possible retained exact coordinate-cache entry
})
test('region telemetry contains only bounded scalar metadata',async()=>{
 const records:any[]=[];setGpuDiagnosticSink((event,fields)=>records.push({event,...sanitizeFields(fields)}))
 const f=fixture();await f.r.paintOver(f.n,f.p,f.mask,f.dst,undefined,true)
 const record=records.find(r=>r.imageFieldRegionPath===1)
 expect(record).toMatchObject({imageFieldRegionOutcome:1,imageFieldRegionSample:0})
 expect(record.imageFieldRegionCount).toBe(f.fields.length)
 expect(record.imageFieldRegionMaxBytes).toBeLessThanOrEqual(8*1024*1024)
 expect(sanitizeFields({imageFieldRegionMaxBytes:Infinity,imageFieldRegionCount:'text',image:'secret'})).toEqual({})
})
test('existing streamImageLeaf uses band-sized image fields for all four phases',async()=>{
 vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX','1')
 try {
 const f=fixture(),d=f.driver as any, n=f.n as any
 Object.assign(d,{constantTextureSampling:true,zeroTextureSampling:true,copyColorRegion:vi.fn(),
  createBinaryCoverage:(w:number,h:number)=>({width:w,height:h,bytes:w*h*4,resource:{},binaryCoverage:true}),
  imageTableRange:()=>({opaqueAlpha:true,nonnegativeRgb:true,maximum:[1,1,1,1]})})
 Object.assign(n,{opacity:1,blend:'normal',fill:{sampleCount:4,rect:n.rect,opaqueRect:n.rect,count:0}})
 Object.assign(f.r.scene,{rootInputBox:[n.rect.x,n.rect.y,n.rect.x+n.rect.w,n.rect.y+n.rect.h],extent:n.rect})
 const targets=Array.from({length:4},()=>({texture:d.create(n.rect.w,n.rect.h),rect:n.rect}))
 for(const t of targets){f.r.busy.add(t.texture);f.r.aliases.set(t.texture,1)}
 await expect(f.r.streamImageLeaf(n,targets)).resolves.toBeDefined()
 const paintPasses=f.passes.filter(p=>p.u[16]===2)
 expect(paintPasses.length).toBeGreaterThan(4)
 expect(f.fields.every(v=>v.bytes<=64*1024*1024)).toBe(true)
 expect(new Set(paintPasses.map(p=>Array.from(p.u.slice(184,186)).join(','))).size).toBe(4)
 expect(f.r.sequentialImagePins.size).toBe(0)
 } finally {vi.unstubAllEnvs()}
})
test('cancelled completed regional source is discarded before composition and does not consume destination',async()=>{
 const f=fixture();const original=f.driver.pass.getMockImplementation()!
 f.driver.pass.mockImplementation((...args:any[])=>{
  (original as any)(...args)
  if(args[1][16]===2 && args[3].y+args[3].h===f.n.rect.h) f.r.checkFrameCurrent=()=>{throw Error('cancel before compose')}
 })
 await expect(f.r.paintOver(f.n,f.p,f.mask,f.dst,undefined,true)).rejects.toThrow('cancel before compose')
 expect(f.r.busy.has(f.mask.texture)).toBe(true);expect(f.r.busy.has(f.dst.texture)).toBe(true)
 expect(f.r.sequentialImagePins.size).toBe(0)
 expect(f.passes.some(p=>p.u[16]===3)).toBe(false)
})
test.each([{x:100,y:100,w:1800,h:1700},{x:0,y:0,w:0,h:0}])('regional paint honors partial or empty interaction scissor %j',async clip=>{
 const f=fixture();f.r.drawRegion=()=>clip
 await f.r.paintOver(f.n,f.p,f.mask,f.dst,undefined,true)
 const passes=f.passes.filter(p=>p.u[16]===2)
 expect(f.driver.clear).toHaveBeenCalled()
 expect(new Set(f.driver.clear.mock.calls.map(call=>call[0])).size).toBe(f.driver.clear.mock.calls.length) // Each output is cleared once; empty merge also clears its separate result.
 expect(passes.reduce((sum,p)=>sum+p.region.w*p.region.h,0)).toBe(clip.w*clip.h)
 expect(passes.every(p=>!p.clearOutside && p.region.x>=clip.x && p.region.y>=clip.y && p.region.x+p.region.w<=clip.x+clip.w && p.region.y+p.region.h<=clip.y+clip.h)).toBe(true)
})
test('multi-column fields cover wide output exactly with original mapping',async()=>{
 const f=fixture(4097,1024);await f.r.paintOver(f.n,f.p,f.mask,f.dst,undefined,true)
 const passes=f.passes.filter(p=>p.u[16]===2)
 expect(new Set(passes.map(p=>p.region.x))).toEqual(new Set([0,4096]))
 expect(passes.reduce((sum,p)=>sum+p.region.w*p.region.h,0)).toBe(4097*1024)
 expect(f.fields.every(field=>field.bytes<=8*1024*1024)).toBe(true)
 for(const pass of passes)expect(Array.from(pass.u.slice(204,206))).toEqual([f.n.rect.x+pass.region.x,f.n.rect.y+pass.region.y])
})
test('checkpoint rejection preserves source and caller-owned destinations',async()=>{
 const f=fixture(),bytes=f.n.rect.w*f.n.rect.h*16,pooled={width:4096,height:4096,bytes:256*1024*1024,resource:{}} as Texture
 f.r.free.set('4096:4096',[pooled]);f.r.used.add(pooled);f.r.bytes=f.r.frameBudget-Math.floor(bytes/2)
 f.driver.checkpoint.mockRejectedValue(Error('checkpoint rejected'))
 await expect(f.r.paintOver(f.n,f.p,f.mask,f.dst,undefined,true)).rejects.toThrow('checkpoint rejected')
 expect(f.driver.destroy).not.toHaveBeenCalled();expect(f.r.sequentialImagePins.size).toBe(0)
 expect(f.r.busy.has(f.mask.texture)).toBe(true);expect(f.r.busy.has(f.dst.texture)).toBe(true)
 expect(f.passes.some(p=>p.u[16]===3)).toBe(false)
})
test('mid-region cancellation releases new output and stops further passes',async()=>{
 const f=fixture(),original=f.driver.pass.getMockImplementation()!
 f.driver.pass.mockImplementation((...args:any[])=>{(original as any)(...args);if(args[1][16]===2)f.r.checkFrameCurrent=()=>{throw Error('mid-region cancelled')}})
 await expect(f.r.paintOver(f.n,f.p,f.mask,f.dst,undefined,true)).rejects.toThrow('mid-region cancelled')
 expect(f.passes.filter(p=>p.u[16]===2)).toHaveLength(1);expect(f.passes.some(p=>p.u[16]===3)).toBe(false)
 expect(f.r.sequentialImagePins.size).toBe(0);expect(f.r.busy.has(f.mask.texture)).toBe(true);expect(f.r.busy.has(f.dst.texture)).toBe(true)
 expect(f.r.busy.has(f.passes[0].target)).toBe(false)
})
