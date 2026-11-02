import {afterEach,expect,test,vi} from 'vitest'
import {GradientPhaseFieldBuilder,gradient_sampling_axes} from '../../generated/design-kernel/design_kernel'
import {gradientPhaseFieldLayout} from './gradient-phase-field'
import {GpuRenderer} from './renderer'
import type {Driver,Texture} from './types'
import {paint} from '../../model'

afterEach(()=>vi.unstubAllEnvs())
function fixture(){
 const driver={name:'webgpu',managed:true,hdr:false,captureDisplay:true,gradientPhaseFields:true,
  drawCalls:0,scratchBytes:0,resourceEpoch:2,completedResourceEpoch:1,
  create:vi.fn((w:number,h:number)=>({width:w,height:h,bytes:w*h*16,resource:{}} as Texture)),
  uploadGradientPhaseField:vi.fn((words:Uint32Array)=>{const layout=gradientPhaseFieldLayout(words);return{width:layout.width,height:layout.height,bytes:words.byteLength,resource:{}} as Texture}),
  uploadLinear:vi.fn((values:Float32Array,w:number,h:number)=>({width:w,height:h,bytes:values.byteLength,resource:{}} as Texture)),
  clear:vi.fn(),pass:vi.fn(),begin:vi.fn(),checkpoint:vi.fn(async()=>{}),dispose:vi.fn(),destroy:vi.fn(),abortFrameAndReleaseFilterScratch:vi.fn(async()=>{}),
 }
 const renderer=new GpuRenderer(driver as unknown as Driver) as any
 renderer.scene={version:8,nodes:{},roots:[],width:32,height:32,extent:{x:0,y:0,w:32,h:32},output:{x:0,y:0,w:32,h:32},view:{x:0,y:0,zoom:1},background:'#ffffff',vertices:[],floatCompositing:true,coherentSamples:true,nativeInteraction:true,interactionRetained:true}
 renderer.gradientPhaseRequest=true;renderer.sampleIndex=0
 const p={...paint('#123456'),kind:'radial'},n={rect:{x:-12,y:20,w:289,h:291},matrix:[1,0,0,1,0,0],size:[250,300]}
 return{driver,renderer,p,n}
}
test('all four phases and unchanged next inputs reuse one uploaded field; only changed parameters rebuild',async()=>{
 const f=fixture(),r=f.renderer
 try{
  await r.prepareGradientPhase(f.n,f.p)
  const first=r.imageGrids.get(f.p).get(0)
  expect(f.driver.uploadGradientPhaseField).toHaveBeenCalledOnce()
  for(let phase=0;phase<4;phase++)expect(r.imageGrids.get(f.p).get(phase).texture).toBe(first.texture)
  const bytes=r.bytes;expect(bytes).toBeLessThan(32*1024*1024)
  r.imageGrids.clear();r.materialFields.begin();await r.prepareGradientPhase(f.n,{...f.p})
  expect(f.driver.uploadGradientPhaseField).toHaveBeenCalledOnce();expect(r.bytes).toBe(bytes)
  r.imageGrids.clear();r.materialFields.begin();await r.prepareGradientPhase({...f.n,matrix:[1,0,0,1,.125,0]},{...f.p})
  expect(f.driver.uploadGradientPhaseField).toHaveBeenCalledTimes(2)
  r.retireUpload(first.texture);expect(r.retiredUploads).toHaveLength(0)
 }finally{r.dispose()}
})
test('late cancellation during bounded native construction never uploads or publishes a partial field',async()=>{
 const f=fixture(),r=f.renderer;let current=true
 r.frameCurrent=()=>current
 const check=vi.spyOn(r,'yieldEncoding').mockImplementation(()=>Promise.resolve().then(()=>{current=false}))
 try{await expect(r.prepareGradientPhase(f.n,f.p)).rejects.toThrow('PREVIEW_CANCELLED')
  expect(f.driver.uploadGradientPhaseField).not.toHaveBeenCalled();expect(r.materialFields.bytes).toBe(0);expect(r.imageGrids.size).toBe(0)
 }finally{check.mockRestore();r.dispose()}
})
test('compact linear axes retain all four original phases in one cache entry',async()=>{
 const f=fixture(),r=f.renderer,p={...f.p,kind:'linear',angle:90}
 try{
  await r.prepareGradientPhase(f.n,p)
  expect(f.driver.uploadGradientPhaseField).not.toHaveBeenCalled();expect(f.driver.uploadLinear).toHaveBeenCalledOnce()
  const values=f.driver.uploadLinear.mock.calls[0][0],field=r.imageGrids.get(p).get(0),proof=r.gradientPhaseResources.get(field.texture)
  const [w,h]=proof.axis
  for(let phase=0;phase<4;phase++){
   const expected=gradient_sampling_axes(JSON.stringify(f.n.rect),new Float64Array(f.n.matrix),new Float64Array(f.n.size),JSON.stringify(p),phase).subarray(4)
   const stored=values.subarray(phase*w*h*4,(phase+1)*w*h*4)
   expect(new Uint32Array(stored.buffer,stored.byteOffset,stored.length)).toEqual(new Uint32Array(expected.buffer,expected.byteOffset,expected.length))
   r.sampleIndex=phase;const u=new Float32Array(256);r.configureGradientPhase(u,field.texture)
   expect(Array.from(u.subarray(189,192))).toEqual([w,h,-phase-1])
  }
  r.imageGrids.clear();r.materialFields.begin();await r.prepareGradientPhase(f.n,{...p})
  expect(f.driver.uploadLinear).toHaveBeenCalledOnce()
 }finally{r.dispose()}
})
test('field containers reject foreign dimensions, shared buffers and invalid block pointers',()=>{
 const p={...paint('#123456'),kind:'radial'},builder=new GradientPhaseFieldBuilder(JSON.stringify({x:0,y:0,w:17,h:19}),new Float64Array([1,0,0,1,0,0]),new Float64Array([20,20]),JSON.stringify(p))
 let words:Uint32Array
 try{while(!builder.advance()){}words=builder.finish()}finally{builder.free()}
 expect(gradientPhaseFieldLayout(words!)).toMatchObject({sourceWidth:17,sourceHeight:19})
 for(const [index,value] of [[0,0],[3,999],[6,1],[8,0]]){const broken=words!.slice();broken[index]=value;expect(()=>gradientPhaseFieldLayout(broken)).toThrow()}
 const shared=new Uint32Array(new SharedArrayBuffer(words!.byteLength));shared.set(words!);expect(()=>gradientPhaseFieldLayout(shared)).toThrow()
})
test('warm pool trimming waits for completion and preserves busy, pinned and immutable storage under the same budget',async()=>{
 const f=fixture(),r=f.renderer,MiB=1024*1024;r.frameBudget=256*MiB;r.frameImageReuse=true;r.interactionWarm=true
 const busy=Array.from({length:12},()=>r.acquire({x:0,y:0,w:512,h:512}))
 const pooled=Array.from({length:32},()=>r.acquire({x:0,y:0,w:512,h:512}));pooled.forEach(s=>r.release(s))
 const image={width:2048,height:2048,bytes:64*MiB,resource:{}} as Texture;r.images.set('owned',{texture:image,rect:{x:0,y:0,w:2048,h:2048}});r.bytes+=image.bytes
 const field={width:1024,height:2048,bytes:8*MiB,resource:{}} as Texture;r.materialFields.put('cached',new Uint32Array(),field);r.bytes+=field.bytes
 r.admissionPins.set(pooled[0].texture,1)
 let complete!:()=>void;f.driver.checkpoint.mockImplementationOnce(()=>new Promise<void>(resolve=>{complete=resolve}))
 try{const pending=r.reclaimScratch();expect(f.driver.checkpoint).toHaveBeenCalledOnce();expect(f.driver.destroy).not.toHaveBeenCalled()
  complete();await pending
  expect(r.frameBudget).toBe(256*MiB);expect(r.bytes).toBeLessThan(224*MiB)
  expect(r.materialFields.has(field)).toBe(true);expect(r.images.has('owned')).toBe(true)
  expect(busy.every(s=>r.busy.has(s.texture))).toBe(true)
  expect(f.driver.destroy.mock.calls.some(([texture])=>texture===pooled[0].texture||texture===image||texture===field)).toBe(false)
 }finally{r.admissionPins.clear();r.dispose()}
})
test.each([false,true])('cancelled uploaded fields survive only a successful completion boundary (failure=%s)',async failure=>{
 const f=fixture(),r=f.renderer
 const field=r.materialField(['seed'],{x:0,y:0,w:2,h:2},()=>new Float32Array(16),f.driver.uploadLinear)
 const mask={width:2,height:2,bytes:64,resource:{}} as Texture;r.coverage.put('unsubmitted',new Uint32Array(),mask);r.bytes+=mask.bytes
 f.driver.pass.mockImplementation(()=>{throw Error('PREVIEW_CANCELLED')})
 if(failure)f.driver.abortFrameAndReleaseFilterScratch.mockRejectedValue(Error('validation after queue completion'))
 try{await expect(r.render(r.scene,false,true,()=>true)).rejects.toThrow(failure?'validation after queue completion':'PREVIEW_CANCELLED')
  expect(f.driver.abortFrameAndReleaseFilterScratch).toHaveBeenCalledOnce();expect(r.coverage.has(mask)).toBe(false)
  expect(r.materialFields.has(field.texture)).toBe(!failure)
 }finally{r.dispose()}
})
