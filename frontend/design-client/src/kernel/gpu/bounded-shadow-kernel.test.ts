import {afterEach,expect,test,vi} from 'vitest'
import {WebGpuDriver} from './webgpu'
import {TexturePrefix} from './texture-prefix'
import {rational_large_tent_kernel_rgba,rational_tent_kernel_rgba} from '../../generated/design-kernel/design_kernel'
import {exactFilterPacketLayout} from './exact-filter-packet-layout'
import {parameters,type Texture} from './types'
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals()})
function fixture(){
 for(const key of ['VITE_DESIGN_WIDE_RATIONAL_PREFIX','VITE_DESIGN_WIDE_RATIONAL_PREFIX_LARGE','VITE_DESIGN_LARGE_SHADOW_TENT','VITE_DESIGN_EXACT_WHOLE_TENT_2048'])vi.stubEnv(key,'0')
 vi.stubGlobal('OffscreenCanvas',class {})
 const driver=new WebGpuDriver(true) as any
 driver.device={limits:{maxTextureDimension2D:8192}}
 driver.uploadLinear=vi.fn((values:Float32Array,width:number,height:number)=>{const texture={width,height,bytes:width*height*16,resource:{width,height,format:'rgba32float'}} as Texture;driver.textures.add(texture);return texture})
 const upload=(radius:number)=>{const bytes=radius>2048?rational_large_tent_kernel_rgba(radius):rational_tent_kernel_rgba(radius),layout=exactFilterPacketLayout(bytes.length/4,8192)!;return {bytes,layout,texture:driver.uploadBoundedShadowKernel(bytes,layout.width,layout.height,radius)}}
 return {driver,upload}
}
test.each([1360.058160514733,2240,2240.125])('bounded shadow %s has private upload proof while global experimental capabilities stay off',radius=>{
 const {driver,upload}=fixture(),{bytes,layout,texture}=upload(radius)
 expect(driver.exactFilterPacketMaxDimension).toBeUndefined()
 expect(driver.shadowKernelProof(texture,radius)).toBeDefined()
 expect(driver.shadowKernelProof({...texture},radius)).toBeUndefined()
 expect(driver.shadowKernelProof(texture,radius+.125)).toBeUndefined()
 const physical=driver.uploadLinear.mock.calls[0][0] as Float32Array
 expect(Uint8Array.from(physical,value=>Math.round(value*255)).subarray(0,bytes.length)).toEqual(bytes)
 expect(texture.bytes).toBe(layout.bytes)
 const resource=texture.resource;texture.resource={...resource}
 expect(driver.shadowKernelProof(texture,radius)).toBeUndefined();texture.resource=resource
 driver.invalidateTextureCertificates(texture)
 expect(driver.shadowKernelProof(texture,radius)).toBeUndefined()
})
test('malformed bytes, disabled policy and wrong physical shapes never grant a shadow upload',()=>{
 const {driver}=fixture(),bytes=rational_large_tent_kernel_rgba(2240.125),layout=exactFilterPacketLayout(bytes.length/4,8192)!
 expect(()=>driver.uploadBoundedShadowKernel(bytes,layout.width+1,layout.height,2240.125)).toThrow('packet')
 const bad=bytes.slice();new DataView(bad.buffer).setUint32(12,1,true)
 expect(()=>driver.uploadBoundedShadowKernel(bad,layout.width,layout.height,2240.125)).toThrow('packet')
 vi.stubEnv('VITE_DESIGN_BOUNDED_SHADOW_TENT','0')
 expect(driver.boundedShadowPacketMaxDimension).toBeUndefined()
 expect(()=>driver.uploadBoundedShadowKernel(bytes,layout.width,layout.height,2240.125)).toThrow('packet')
 expect(driver.uploadLinear).not.toHaveBeenCalled()
})
test('only the uploaded coefficient proof can admit a 2240-radius prefix when all experimental flags are off',()=>{
 const {driver,upload}=fixture(),radius=2240,{texture}=upload(radius),proof=driver.shadowKernelProof(texture,radius)
 const prefix=Object.create(TexturePrefix.prototype) as TexturePrefix
 const source={width:5000,height:8,format:'rgba32float'} as GPUTexture,target={width:514,height:8,format:'rgba32float'} as GPUTexture
 const rect={x:2240,y:0,w:514,h:8},u=parameters(rect,{x:0,y:0,w:5000,h:8});u[16]=22;u[36]=radius;u[37]=0
 const inputs=[source,texture.resource as GPUTexture,source]
 expect(prefix.canEncode(target,inputs,u,radius,'tent',rect,8)).toBe(false)
 expect(prefix.canEncode(target,inputs,u,radius,'tent',rect,8,255,undefined,{} as any)).toBe(false)
 expect(prefix.canEncode(target,inputs,u,radius,'tent',rect,8,255,undefined,proof)).toBe(true)
})

test('bounded shader capability stays unavailable to HDR and display arithmetic',()=>{
 const {driver}=fixture()
 driver.hdr=true;expect(driver.boundedShadowPacketMaxDimension).toBeUndefined()
 driver.hdr=false;driver.displayMath=true;expect(driver.boundedShadowPacketMaxDimension).toBeUndefined()
})
