import {afterEach,expect,test,vi} from 'vitest'
import {GpuRenderer} from './renderer'
import type {Driver,Texture} from './types'
import {inverse} from '../../geometry'
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs()})
function fixture(){
 vi.stubEnv('VITE_DESIGN_DENSE_SOURCE_BYTES','1')
 vi.stubGlobal('XMLHttpRequest',class{status=200;responseType='';response=new ArrayBuffer(0);open(){}send(data:Uint32Array){const bytes=new Uint8Array(data[0]*data[1]*16);bytes.fill(255);this.response=bytes.buffer}})
 const texture=(w:number,h:number,bytes=w*h*16)=>({width:w,height:h,bytes,resource:{}} as Texture)
 const driver:any={name:'webgpu',managed:true,linearLight:true,hdr:false,displayMath:false,scratchBytes:0,
  uploadLinear:vi.fn((_v:Float32Array,w:number,h:number)=>texture(w,h)),uploadParameters:vi.fn((_v:Float32Array,w:number,h:number)=>texture(w,h)),
  uploadStraightSrgb8:vi.fn((_v:Uint8Array,w:number,h:number)=>texture(w,h+2,w*(h+2)*4)),destroy:vi.fn(),dispose:vi.fn()}
 const r=new GpuRenderer(driver as Driver,true,false,undefined,false,false,1024) as any
 r.scene={colorManagement:{documentSpace:'srgb'},floatCompositing:true,nativeInteraction:true,interactionRetained:true,nodes:{}}
 r.sampleIndex=0
 const a=.27,c=Math.cos(a),s=Math.sin(a),matrix=[c,s,-s,c,0,0]
 const n={id:'rotated-file-image',rect:{x:0,y:0,w:128,h:16},size:[512,512],matrix,inverse:inverse(matrix as any)}
 const p:any={kind:'image',image:'design-app://app/source-image/owned-1/'+ 'a'.repeat(64)+'-512x512.png?samples=1',color:'#000000',fit:'cover'}
 return{r,driver,n,p}
}
test('managed WebGPU ignores the dense-bytes flag and keeps float sampling',()=>{
 const f=fixture();const result=f.r.sourceBitmapGrid(f.n,f.p)
 expect(f.driver.managed).toBe(true)
 expect(f.driver.uploadStraightSrgb8).not.toHaveBeenCalled()
 expect(f.driver.uploadLinear).toHaveBeenCalledOnce()
 const [pixels,w,h]=f.driver.uploadLinear.mock.calls[0]
 expect(pixels).toBeInstanceOf(Float32Array);expect([w,h]).toEqual([256,32])
 expect(result.image.rect).toEqual({x:0,y:0,w:256,h:32});expect(result.image.texture.height).toBe(32)
 expect(f.r.bytes).toBe(result.image.texture.bytes+result.field.texture.bytes)
 f.r.scene.coherentSamples=true
 f.r.sampleIndex=0
 f.p.stops=[]
 f.p.opacity=1
 f.p.angle=0
 const u=new Float32Array(256)
 f.r.configurePaint(u,f.n,f.p)
 expect(u[187]).toBe(0)
 f.r.dispose();expect(f.driver.dispose).toHaveBeenCalledOnce();expect(f.r.coordinateMaps.size).toBe(0)
 expect(f.driver.destroy).toHaveBeenCalledWith(result.field.texture);expect(f.r.bytes).toBe(0)
})
test.each(['off','hdr','display-math','ordinary','source-detail','adjusted','small','no-uploader'])('dense bytes retain the original path for %s',kind=>{
 const f=fixture()
 if(kind==='off')vi.stubEnv('VITE_DESIGN_DENSE_SOURCE_BYTES','0')
 if(kind==='hdr')f.driver.hdr=true
 if(kind==='display-math')f.driver.displayMath=true
 if(kind==='ordinary')f.r.scene.nativeInteraction=false
 if(kind==='source-detail')f.r.scene.sourceDetailTile=true
 if(kind==='adjusted')f.p.adjust={exposure:.1}
 if(kind==='small')f.n.rect.w=32
 const upload=f.driver.uploadStraightSrgb8
 if(kind==='no-uploader')delete f.driver.uploadStraightSrgb8
 f.r.sourceBitmapGrid(f.n,f.p)
 expect(upload).not.toHaveBeenCalled();expect(f.driver.uploadLinear).toHaveBeenCalledOnce()
 f.r.dispose()
})
