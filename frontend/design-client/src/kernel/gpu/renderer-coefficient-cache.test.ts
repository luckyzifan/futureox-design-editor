import { test, expect, vi } from 'vitest'
import { GpuRenderer } from './renderer'
function fixture() {
 const uploaded: Uint8Array[] = []
 const driver:any={managed:true,linearLight:true,hdr:false,certifiedFilter:true,scratchBytes:0,
  uploadRgba8:(v:Uint8Array,w:number,h:number)=>{uploaded.push(v.slice());return {width:w,height:h,bytes:w*h*16,resource:{}}},destroy:vi.fn()}
 const renderer:any=new GpuRenderer(driver)
 const frame=()=>{renderer.certifiedKernels.clear();renderer.blurKernels.clear()}
 return {renderer,driver,uploaded,frame}
}
test('certified tent CPU hits retain exact upload bytes without enabling GPU reuse',()=>{
 const {renderer,uploaded,frame}=fixture(), original=new Uint8Array([1,2,3,4]), build=vi.fn(()=>original)
 const first=renderer.filterKernel('certified-tent',2,build)
 frame();original.fill(99)
 const second=renderer.filterKernel('certified-tent',2,build)
 expect(build).toHaveBeenCalledOnce();expect(uploaded.map(a=>[...a])).toEqual([[1,2,3,4],[1,2,3,4]])
 expect(second.texture).not.toBe(first.texture);expect(renderer.retainKernels).toBeFalsy()
 expect(renderer.kernelBuilds).toBe(2);expect(renderer.kernelUploadBytes).toBe(32)
})
test('exact radius, negative zero and all current profile inputs separate coefficient entries',()=>{
 const {renderer,driver,frame}=fixture(),build=vi.fn(()=>new Uint8Array([1,2,3,4]))
 for(const radius of [0,-0,2,2+2**-50,2048]){frame();renderer.filterKernel('certified-tent',radius,build)}
 expect(build).toHaveBeenCalledTimes(5)
 for(const key of ['managed','linearLight','hdr','certifiedFilter']) {
  frame();driver[key]=!driver[key];renderer.filterKernel('certified-tent',2,build)
 }
 expect(build).toHaveBeenCalledTimes(9)
})
test('other operator families keep uncached CPU path',()=>{
 const {renderer,frame}=fixture(), build=vi.fn(()=>new Uint8Array([1,2,3,4]))
 for(const operator of ['certified-box','rational-tent','rational-box','display-tent','quantized-tent']) {
  for(let i=0;i<2;i++){frame();renderer.filterKernel(operator,2,build)}
 }
 expect(build).toHaveBeenCalledTimes(10);expect(renderer.coefficientBytes.size).toBe(0)
})

test('a different constructor result type cannot populate the Uint8 cache',()=>{
 const {renderer,driver,frame}=fixture(),build=vi.fn(()=>new Float32Array([1,2,3,4]))
 driver.uploadLinear=(_v:Float32Array,w:number,h:number)=>({width:w,height:h,bytes:w*h*16,resource:{}})
 for(let i=0;i<2;i++){frame();renderer.filterKernel('certified-tent',2,build)}
 expect(build).toHaveBeenCalledTimes(2);expect(renderer.coefficientBytes.size).toBe(0)
})
