import {afterEach,expect,test,vi} from 'vitest'
import {GpuRenderer} from './renderer'
import {paint} from '../../model'
import type {GpuNode,Texture} from './types'

afterEach(()=>vi.unstubAllEnvs())
function fixture(){
 const bounds={x:12,y:24,w:64,h:64},create=(width:number,height:number)=>({width,height,bytes:width*height*16,resource:{}}) as Texture
 const driver:any={name:'webgpu',managed:true,constantTextureSampling:true,create,clear:vi.fn(),pass:vi.fn(),destroy:vi.fn()}
 const renderer=new GpuRenderer(driver,true,false) as any
 renderer.scene={coherentSamples:true,extent:bounds,view:{x:0,y:0,zoom:1},nodes:{},roots:[]}
 const mask=renderer.acquire(bounds),clip=renderer.acquire(bounds);mask.opaqueInterior=bounds;clip.opaqueInterior=bounds
 const node={id:'solid',rect:bounds,opaqueCoverage:false} as GpuNode
 return{renderer,driver,bounds,mask,clip,node}
}
test('a full constant color and a live full-coverage clip use one texel without releasing the ancestor mask',()=>{
 vi.stubEnv('VITE_DESIGN_UNIFORM_COLOR_SURFACES','1');vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX','0')
 const f=fixture(),p=paint('#ffffff'),outputs=[]
 f.renderer.scene.interactionWindow={x:12,y:24,w:64,h:64}
 for(let sample=0;sample<4;sample++){
  f.renderer.sampleIndex=sample
  const dst=f.renderer.acquire(f.bounds)
  outputs.push(f.renderer.paintOver(f.node,p,f.mask,dst,f.clip))
 }
 expect(new Set(outputs.map(s=>s.texture)).size).toBe(1)
 expect(outputs[0].texture).toMatchObject({width:1,height:1,bytes:16,uniformColor:true})
 expect(outputs.every(s=>s.rect===f.bounds)).toBe(true)
 expect(f.renderer.busy.has(f.clip.texture)).toBe(true)
 expect(f.driver.pass).toHaveBeenCalledTimes(1)
 // World-space capture scissoring must not clear the physical (0,0) texel.
 expect(f.driver.pass.mock.calls[0][3]).toBeUndefined()
 const other=f.renderer.acquire(f.bounds);other.opaqueInterior=f.bounds
 expect(f.renderer.equivalentClips(f.clip,other,f.bounds)).toBe(true)
 expect(f.renderer.equivalentClips(f.clip,undefined,f.bounds)).toBe(false)
 other.opaqueInterior={...f.bounds,w:63}
 expect(f.renderer.equivalentClips(f.clip,other,f.bounds)).toBe(false)
})
test.each(['disabled','partial','fractional','released','unmanaged'])('%s clip keeps the existing compositor path',reason=>{
 vi.stubEnv('VITE_DESIGN_UNIFORM_COLOR_SURFACES',reason==='disabled'?'0':'1')
 const f=fixture()
 if(reason==='partial')f.clip.opaqueInterior={...f.bounds,w:63}
 if(reason==='fractional')f.clip.rect={...f.bounds,x:11.5,w:65}
 if(reason==='released')f.renderer.release(f.clip)
 if(reason==='unmanaged')f.driver.managed=false
 expect(f.renderer.constantPaintOver(f.node,paint('#ffffff'),f.mask,{rect:f.bounds},f.clip)).toBeUndefined()
})
