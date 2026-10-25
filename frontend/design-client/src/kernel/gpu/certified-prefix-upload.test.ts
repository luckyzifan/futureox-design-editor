import {afterEach,expect,test,vi} from 'vitest'
import {WebGpuDriver} from './webgpu'
import {rational_tent_kernel_rgba,certified_tent_kernel_rgba} from '../../generated/design-kernel/design_kernel'
import {parameters,type Texture} from './types'
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();vi.restoreAllMocks()})
const radius=33.75523176884158
function fixture(){
 vi.stubEnv('VITE_DESIGN_CERTIFIED_TENT_PREFIX','1')
 vi.stubGlobal('OffscreenCanvas',class{})
 vi.stubGlobal('GPUTextureUsage',{TEXTURE_BINDING:1,RENDER_ATTACHMENT:2,COPY_SRC:4,COPY_DST:8})
 const driver=new WebGpuDriver(true),encode=vi.fn(()=>true),writeTexture=vi.fn()
 Object.assign(driver,{device:{limits:{maxTextureDimension2D:8192},createTexture:()=>({createView:()=>({}),destroy(){}}),queue:{writeTexture}},
  prefix:{encode,lastRenderPasses:1},blank:{},closeOver(){},encoder:{beginRenderPass:()=>({end(){}})},bindingCache:{view:()=>({})}})
 const upload=(operator:'rational-tent'|'certified-tent')=>{
  const bytes=operator==='rational-tent'?rational_tent_kernel_rgba(radius):certified_tent_kernel_rgba(radius)
  return {bytes,texture:driver.uploadExactTentKernel(bytes,bytes.length/4,1,operator,radius)}
 }
 const pair=(a:Texture,b:Texture,r=radius)=>(driver as any).certifiedTentPair(a,b,r)
 return {driver,encode,writeTexture,upload,pair}
}
test('actual core bytes and private uploaded resources admit only their exact f64 coefficient pair',()=>{
 const f=fixture(),a=f.upload('rational-tent'),b=f.upload('certified-tent')
 expect(f.pair(a.texture,b.texture)).toBe(true)
 expect(f.pair(a.texture,b.texture,Math.fround(radius))).toBe(false)
 expect(f.pair({...a.texture},b.texture)).toBe(false)
 expect(f.pair(b.texture,a.texture)).toBe(false)
 a.bytes.fill(0);b.bytes.fill(0);expect(f.pair(a.texture,b.texture)).toBe(true)
 const resource=a.texture.resource;a.texture.resource={};expect(f.pair(a.texture,b.texture)).toBe(false);a.texture.resource=resource
 f.driver.clear(a.texture);expect(f.pair(a.texture,b.texture)).toBe(false)
})
test('invalid bytes, operator, dimensions and radius reject before upload',()=>{
 const f=fixture(),bytes=rational_tent_kernel_rgba(radius),changed=bytes.slice();changed[changed.length-2]^=1
 expect(()=>f.driver.uploadExactTentKernel(changed,changed.length/4,1,'rational-tent',radius)).toThrow('differ')
 expect(()=>f.driver.uploadExactTentKernel(bytes,bytes.length/4,2,'rational-tent',radius)).toThrow('Invalid')
 for(const r of [7.9,512.001,NaN,Infinity])expect(()=>f.driver.uploadExactTentKernel(bytes,bytes.length/4,1,'rational-tent',r)).toThrow('Invalid')
 expect(f.writeTexture).not.toHaveBeenCalled()
})
test('existing dispatch uses certified mode under the same scratch contract and disabling policy revokes it',()=>{
 const f=fixture(),a=f.upload('rational-tent'),b=f.upload('certified-tent'),source=f.driver.create(40,40),target=f.driver.create(12,12)
 a.texture.prefixRationalUnsupported=true
 const u=parameters({x:10,y:10,w:12,h:12},{x:0,y:0,w:40,h:40});u[16]=22;u[36]=radius
 f.driver.pass(target,u,[source,a.texture,b.texture],undefined,15,{kind:'tent',radius})
 expect((f.encode.mock.calls.at(-1) as unknown as unknown[])[12]).toBe(true)
 expect(f.driver.stats().certifiedTentPasses).toBe(1)
 vi.stubEnv('VITE_DESIGN_CERTIFIED_TENT_PREFIX','0');expect(f.pair(a.texture,b.texture)).toBe(false)
})
