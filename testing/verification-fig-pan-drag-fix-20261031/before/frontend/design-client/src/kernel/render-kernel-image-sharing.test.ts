import {expect,test} from 'vitest'
import {RenderKernel} from './render-kernel'
import {VectorEngine,encode_png_rgba} from '../generated/design-kernel/design_kernel'
import {defaultColorSettings} from '../color'

function fixture(){
 const settings=new Map<string,string>([['canvas','null'],['interaction','null']])
 const preparation={request:async(lane:string)=>({settings:settings.get(lane)})} as any
 const source=new RenderKernel(new VectorEngine(),'canvas',preparation)
 const target=new RenderKernel(new VectorEngine(),'interaction',preparation)
 const uri='data:image/png;base64,'+Buffer.from(encode_png_rgba(1,1,new Uint8Array([128,64,200,191]))).toString('base64')
 return {source,target,settings,preparation,uri}
}
test('same-policy preparation lanes share only their synchronous image decoder and copy on colour change',async()=>{
 const {source,target,settings,preparation,uri}=fixture()
 await source.initialize(false);await target.initialize(false)
 const before=source.image_linear(uri),decoder=(source as any).assets,owner=source.contentIdentity
 expect(target.shareImageDecoder(source)).toBe(true)
 expect((target as any).assets).toBe(decoder)
 expect(target.contentIdentity).not.toBe(owner)
 expect(target.image_linear(uri)).toEqual(before)
 settings.set('interaction',JSON.stringify({...defaultColorSettings(),documentSpace:'display-p3'}))
 await target.load_document('{}')
 expect((target as any).assets).not.toBe(decoder)
 expect((source as any).assets).toBe(decoder)
 expect(source.color_settings()).toBe('null')
 expect(source.image_linear(uri)).toEqual(before)
 const independent=new RenderKernel(new VectorEngine(),'interaction',preparation)
 await independent.initialize(false)
 expect(target.image_linear(uri)).toEqual(independent.image_linear(uri))
 expect(target.shareImageDecoder(source)).toBe(false)
})
test('mip reconfiguration detaches and preserves the current colour policy; CPU engines never share documents',async()=>{
 const {source,target,settings,uri}=fixture()
 const color=JSON.stringify({...defaultColorSettings(),documentSpace:'display-p3'})
 settings.set('canvas',color);settings.set('interaction',color)
 await source.initialize(false);await target.initialize(false)
 const pixels=source.image_linear(uri)
 expect(target.shareImageDecoder(source)).toBe(true)
 await target.initialize(true)
 expect((target as any).assets).not.toBe((source as any).assets)
 expect(target.color_settings()).toBe(color)
 expect(target.image_linear(uri)).toEqual(pixels)
 expect(source.image_linear(uri)).toEqual(pixels)
 expect(target.shareImageDecoder(source)).toBe(false)
 const cpu=new RenderKernel(new VectorEngine(),'canvas')
 expect(cpu.shareImageDecoder(source)).toBe(false)
 expect(source.shareImageDecoder(cpu)).toBe(false)
 expect(target.shareImageDecoder(new RenderKernel(new VectorEngine(),'canvas',{} as any))).toBe(false)
})
