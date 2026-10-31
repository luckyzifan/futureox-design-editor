import {afterEach,expect,test,vi} from 'vitest'
import {GpuRenderer} from './renderer'
import type {Driver,Texture} from './types'
import {SurfaceAllocationSite as Site} from '../../../../design-desktop/src/render-surface-ledger.mjs'
import {setGpuDiagnosticSink} from '../../../../design-desktop/src/render-terminal-diagnostics.mjs'
import {renderFailureFields} from '../render-failure-telemetry'
// Only numerical field producers and the GPU device are controlled. Region
// iteration, cache, admission, retirement, reclaim and allocator are real code.
vi.mock('../../generated/design-kernel/design_kernel',async importOriginal=>{
 const actual=await importOriginal<Record<string,unknown>>()
 return {...actual,image_sampling_axes_placed:()=>new Float32Array(),
  image_sampling_grid_placed:(json:string,_matrix:unknown,_size:unknown,_base:unknown,_paint:unknown,sample:number)=>{
   const r=JSON.parse(json),values=new Float32Array(r.w*r.h*4)
   values.set([r.x,r.y,sample,.25]);return values
  }}
})
afterEach(()=>{setGpuDiagnosticSink(undefined);vi.unstubAllEnvs()})
const box=(w:number,h:number)=>({x:0,y:0,w,h})
function fixture(){
 const make=(w:number,h:number,bpp=16):Texture=>({width:w,height:h,bytes:w*h*bpp,resource:{} as GPUTexture})
 const uploaded:{texture:Texture;head:number[]}[]=[],reads=new Set<Texture>(),completed=new Set<Texture>(),destroyed=new Set<Texture>(),passes:any[]=[]
 const driver={name:'webgpu',managed:true,captureDisplay:true,linearLight:true,scratchBytes:0,resourceEpoch:10,completedResourceEpoch:9,
  create:vi.fn((w:number,h:number)=>make(w,h)),createBinaryCoverage:vi.fn((w:number,h:number)=>({...make(w,h,4),binaryCoverage:true})),clear:vi.fn(),
  destroy:vi.fn((texture:Texture)=>{
   if(uploaded.some(u=>u.texture===texture))expect(completed.has(texture),'parameter upload must have a completed last-read checkpoint').toBe(true)
   expect(destroyed.has(texture),'physical resource must not be destroyed twice').toBe(false);destroyed.add(texture)
  }),
  pass:vi.fn((target:Texture,u:Float32Array,inputs:Texture[],region:unknown)=>{
   expect(destroyed.has(target)).toBe(false)
   for(const texture of inputs){expect(destroyed.has(texture),'never sample a retired/destroyed field').toBe(false);reads.add(texture)}
   passes.push({target,mode:u[16],inputs,region,sample:Array.from(u.slice(184,186))})
  }),
  checkpoint:vi.fn(async()=>{await Promise.resolve();for(const t of reads)completed.add(t)}),
  uploadParameters:(_values:Float32Array,w:number,h:number)=>{const texture=make(w,h);uploaded.push({texture,head:Array.from(_values.slice(0,4))});return texture}
 } as unknown as Driver
 const r=new GpuRenderer(driver,true,false,undefined,false,false,1024) as any
 r.scene={coherentSamples:true,floatCompositing:true,compactImageFields:true,nodes:{}};r.sampleIndex=0
 r.materialFields.begin();r.coverage.begin();setGpuDiagnosticSink(()=>{})
 return {r,driver,make,uploaded,reads,completed,destroyed,passes}
}
function tiny(r:any){
 const zero=r.acquire(box(1,1),false,false,Site.transparentZero),pass=r.run(0,box(1,1),[])
 r.retain(zero);r.retain(pass)
}
function imageFixture(width=3543,height=3504,targetCount=4){
 const f=fixture(),{r,make}=f,rect=box(width,height),targets=[]
 for(let i=0;i<targetCount;i++)targets.push(r.run(47,rect,[]))
 tiny(r)
 const mask=r.acquire(rect,true,false,Site.pathCoverage);r.coverage.put('controlled-mask',new Uint32Array(),mask.texture)
 const image={texture:make(736,414),rect:box(736,414)}
 r.images.set('controlled-image',image);r.bytes+=image.texture.bytes;r.used.add(image.texture);r.touch(image.texture)
 const p={kind:'image',color:'#ffffff',opacity:1,blend:'normal',visible:true,stops:[],angle:0,fit:'stretch'}
 const n={rect,size:[736,414],matrix:[1,.25,.1,1,0,0],inverse:[1,0,0,1,0,0],fills:[p],children:[],effects:[],strokes:[]}
 return {...f,rect,targets,mask,image,p,n}
}
test.each([0,1,2,3])('req173 same-size live surfaces finish phase %i below unchanged 1GiB with completed upload retirement',async phase=>{
 const f=imageFixture(),{r,driver,uploaded,passes}=f;r.sampleIndex=phase
 const out=await r.paintImageFieldRegions(f.n,f.p,f.mask,f.image,0)
 expect(out.rect).toEqual(f.rect);expect(uploaded).toHaveLength(24)
 expect(r.materialFields.bytes).toBe(0)
 expect(r.peak).toBeLessThanOrEqual(1073741824);expect(r.frameBudget).toBe(1073741824)
 expect(driver.checkpoint).toHaveBeenCalled();expect(driver.destroy).toHaveBeenCalled()
 const paint=passes.filter(p=>p.mode===2)
 expect(paint).toHaveLength(24);expect(new Set(paint.map(p=>p.target)).size).toBe(1)
 expect(paint.reduce((sum,p)=>sum+p.region.w*p.region.h,0)).toBe(3543*3504)
 const offset=[[-.125,-.375],[.375,-.125],[-.375,.125],[.125,.375]][phase]
 expect(paint.every(p=>JSON.stringify(p.sample)===JSON.stringify(offset))).toBe(true)
 for(let i=0;i<uploaded.length;i++){
  expect(uploaded[i].texture.bytes).toBeLessThanOrEqual(8*1024*1024)
  expect(uploaded[i].head).toEqual([0,i*147,phase,.25])
 }
 expect(r.busy.has(out.texture)).toBe(true)
 expect(f.targets.every(t=>r.busy.has(t.texture)&&!f.destroyed.has(t.texture))).toBe(true)
 expect(f.destroyed.has(f.image.texture)).toBe(false);expect(f.destroyed.has(f.mask.texture)).toBe(false)
})
test('repeated ordinary regional paint rebuilds equal fields, never returns a stale private grid',async()=>{
 const f=imageFixture(512,600,1),{r}=f
 const first=await r.paintImageFieldRegions(f.n,f.p,f.mask,f.image,0)
 const firstFields=f.uploaded.map(u=>u.head);r.release(first)
 const second=await r.paintImageFieldRegions(f.n,f.p,f.mask,f.image,0)
 expect(f.uploaded.slice(firstFields.length).map(u=>u.head)).toEqual(firstFields)
 expect(r.imageGrids.size).toBe(0);expect(r.materialFields.bytes).toBe(0)
 expect(r.busy.has(second.texture)).toBe(true)
 // Logical retirement alone is not completion, even when a later paint reuses its output.
 expect(f.driver.destroy).not.toHaveBeenCalled();expect(r.retiredUploads).toHaveLength(firstFields.length*2)
})
test('cancellation retires last encoded strip without destroying until a later real checkpoint',async()=>{
 const f=imageFixture(),{r,driver}=f;let current=true;r.frameCurrent=()=>current
 const pass=driver.pass as any,original=pass.getMockImplementation()
 pass.mockImplementation((...args:any[])=>{original(...args);if(args[1][16]===2)current=false})
 await expect(r.paintImageFieldRegions(f.n,f.p,f.mask,f.image,0)).rejects.toThrow('PREVIEW_CANCELLED')
 expect(r.retiredUploads).toHaveLength(1);expect(r.materialFields.bytes).toBe(0)
 expect(driver.destroy).not.toHaveBeenCalled();expect(r.sequentialImagePins.size).toBe(0)
 expect(f.targets.every(t=>r.busy.has(t.texture))).toBe(true)
 current=true;await r.reclaimScratch(32*1024*1024)
 expect(f.destroyed.has(f.uploaded[0].texture)).toBe(true)
 expect(f.targets.every(t=>!f.destroyed.has(t.texture))).toBe(true)
})
test('a rejected checkpoint never grants upload completion or destroys a pending field',async()=>{
 const f=imageFixture();(f.driver.checkpoint as any).mockRejectedValue(Error('controlled checkpoint failure'))
 await expect(f.r.paintImageFieldRegions(f.n,f.p,f.mask,f.image,0)).rejects.toThrow('controlled checkpoint failure')
 expect(f.uploaded).toHaveLength(3);expect(f.r.retiredUploads).toHaveLength(3)
 expect(f.driver.destroy).not.toHaveBeenCalled();expect(f.r.materialFields.bytes).toBe(0)
 expect(f.r.sequentialImagePins.size).toBe(0)
})
test('default reusable dense fields still hit the parameter cache after the per-paint lookup is cleared',()=>{
 const f=imageFixture(64,32,0),{r}=f
 const first=r.imageGrid(f.n,f.p,f.image),bytes=r.materialFields.bytes
 r.imageGrids.delete(f.p)
 const again=r.imageGrid(f.n,f.p,f.image)
 expect(again.texture).toBe(first.texture);expect(f.uploaded).toHaveLength(1)
 expect(r.materialFields.bytes).toBe(bytes);expect(bytes).toBe(64*32*16)
 r.retireUpload(first.texture);expect(r.retiredUploads).toHaveLength(0)
})
test('default prepared compact fields remain reusable while regional private uploads bypass identical cache entries',()=>{
 const f=imageFixture(64,32,0),{r}=f,axes=new Float32Array(64*2*4);axes[3]=-1
 const first=r.imageGrid(f.n,f.p,f.image,0,[0,0],axes,1)
 expect(first.texture.height).toBe(2);expect(r.materialFields.has(first.texture)).toBe(true)
 r.imageGrids.delete(f.p)
 const cached=r.imageGrid(f.n,f.p,f.image,0,[0,0],axes,1)
 expect(cached.texture).toBe(first.texture);expect(f.uploaded).toHaveLength(1)
 r.imageGrids.delete(f.p)
 const privateField=r.imageGrid(f.n,f.p,f.image,0,[0,0],axes,2,false)
 expect(privateField.texture).not.toBe(first.texture);expect(r.materialFields.has(privateField.texture)).toBe(false)
 r.imageGrids.delete(f.p);r.retireUpload(privateField.texture)
 expect(r.retiredUploads).toEqual([privateField.texture]);expect(r.materialFields.has(first.texture)).toBe(true)
})
test('req183 remains an independent compose working-set limit, even after removing all parameter fields',()=>{
 const {r,driver}=fixture(),rect=box(3151,3114),planes=[]
 for(let i=0;i<5;i++)planes.push(r.run(47,rect,[]))
 tiny(r)
 const mask=r.acquire(rect,true,false,Site.pathCoverage);r.coverage.put('controlled-mask',new Uint32Array(),mask.texture)
 const source=r.acquire(rect,false,false,Site.boundedImageOutput)
 for(let i=0;i<4;i++)r.materialField(['controlled-field',i],box(3151,166),()=>new Float32Array(3151*166*4),driver.uploadParameters)
 let error:unknown;try{r.merge(source,planes[0],'normal')}catch(e){error=e}
 expect(renderFailureFields(error)).toMatchObject({failureCode:20,failureAllocationKind:1,failureAllocationCallsite:5,
  failureAllocationPassMode:4,failureRequestedBytes:156995424,failureWorkingBytes:1014697656,
  failureLedgerMaterialFieldBytes:33476224,failureSurfaceRole2Bytes:784977136,failureSurfaceRole4Bytes:156995424,
  failureSurfaceUniqueCount:13,failureSurfaceLedgerResidualBytes:0,failureSurfaceScanTruncated:0})
 // Use exact arithmetic, not unsafe destruction of current-frame cache entries.
 expect(r.workingBytes-r.materialFields.bytes+156995424).toBeGreaterThan(r.frameBudget)
 expect(r.busy.has(source.texture)).toBe(true);expect(r.busy.has(planes[0].texture)).toBe(true)
 expect(driver.destroy).not.toHaveBeenCalled()
})
