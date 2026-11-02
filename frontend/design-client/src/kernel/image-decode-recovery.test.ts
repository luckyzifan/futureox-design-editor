import {expect,test,vi} from 'vitest'
import {canRebuildImageDecoder} from './image-decode-recovery'
import {RenderKernel} from './render-kernel'
import {defaultColorSettings} from '../color'
import {VectorEngine,encode_png_rgba} from '../generated/design-kernel/design_kernel'

test('recovery accepts only the original canonical base64 encoding and the exact decode failure',()=>{
 for(let length=1;length<130;length++){
  const data=Buffer.from(Array.from({length},(_,i)=>(i*53+length)%256)).toString('base64'),uri='data:image/png;base64,'+data
  expect(canRebuildImageDecoder('Invalid image data',uri)).toBe(true)
  expect(canRebuildImageDecoder(Error('Invalid ICC profile'),uri)).toBe(false)
 }
 for(const body of ['', 'A','AAA','AB==','AAB=','AAA===','AA=A','AAAA\n','AA?=','____'])
  expect(canRebuildImageDecoder('Invalid image data','data:image/png;base64,'+body),body).toBe(false)
 expect(canRebuildImageDecoder('Invalid image data','https://invalid/image.png')).toBe(false)
})

test.each(['image_info','image_info_at_level','image_linear','image_linear_at_level','image_rgba8','image_rgba8_at_level'] as const)(
 'one transient %s error rebuilds only the owning image decoder with exact pixels and mip policy',async method=>{
 const preparation={request:async()=>({settings:'null'})}as any
 const source=new RenderKernel(new VectorEngine(),'canvas',preparation),target=new RenderKernel(new VectorEngine(),'interaction',preparation)
 await source.initialize(true);await target.initialize(true);expect(target.shareImageDecoder(source)).toBe(true)
 const uri='data:image/png;base64,'+Buffer.from(encode_png_rgba(1,1,new Uint8Array([128,64,200,191]))).toString('base64')
 const run=(k:RenderKernel)=>(k[method] as (uri:string,level:number)=>unknown)(uri,1)
 const expected=run(source),decoder=(source as any).assets,identity=target.contentIdentity
 const fail=vi.spyOn(decoder,method).mockImplementationOnce(()=>{throw 'Invalid image data'})
 try{
  expect(run(target)).toEqual(expected);expect(target.imageDecodeRecoveries).toBe(1)
  expect(target.contentIdentity).toBe(identity);expect((target as any).assets).not.toBe(decoder)
  expect((source as any).assets).toBe(decoder);expect(run(source)).toEqual(expected)
 }finally{fail.mockRestore();(source as any).assets.free();(target as any).assets.free()}
})

test('a real malformed URI is rejected without resetting the decoder; persistent failures retry at most once',async()=>{
 const k=new RenderKernel(new VectorEngine(),'canvas',{request:async()=>({settings:'null'})}as any);await k.initialize(false)
 const original=(k as any).assets
 expect(()=>k.image_info('data:image/png;base64,not-an-image')).toThrow('Invalid image data')
 expect((k as any).assets).toBe(original);expect(k.imageDecodeRecoveries).toBe(0)
 const failure=vi.spyOn(VectorEngine.prototype,'image_info').mockImplementation(()=>{throw 'Invalid image data'})
 try{expect(()=>k.image_info('data:image/png;base64,AAAA')).toThrow('Invalid image data');expect(failure).toHaveBeenCalledTimes(2);expect(k.imageDecodeRecoveries).toBe(0)}
 finally{failure.mockRestore();(k as any).assets.free()}
})

test('CPU document engines are never replaced by image-only recovery',()=>{
 const k=new RenderKernel(new VectorEngine(),'canvas'),original=(k as any).assets
 const failure=vi.spyOn(original,'image_info').mockImplementation(()=>{throw 'Invalid image data'})
 try{expect(()=>k.image_info('data:image/png;base64,AAAA')).toThrow('Invalid image data');expect(failure).toHaveBeenCalledOnce();expect((k as any).assets).toBe(original)}
 finally{failure.mockRestore();original.free()}
})

 test('recovery retains the working colour settings while recreating the image-only engine',async()=>{
 const settings=JSON.stringify({...defaultColorSettings(),documentSpace:'display-p3'})
 const k=new RenderKernel(new VectorEngine(),'canvas',{request:async()=>({settings})}as any);await k.initialize(false)
 const uri='data:image/png;base64,'+Buffer.from(encode_png_rgba(1,1,new Uint8Array([31,190,241,199]))).toString('base64')
 const expected=k.image_linear(uri),old=(k as any).assets,fail=vi.spyOn(old,'image_linear').mockImplementationOnce(()=>{throw 'Invalid image data'})
 try{expect(k.image_linear(uri)).toEqual(expected);expect(k.color_settings()).toBe(settings);expect(k.imageDecodeRecoveries).toBe(1)}
 finally{fail.mockRestore();(k as any).assets.free()}
 })
