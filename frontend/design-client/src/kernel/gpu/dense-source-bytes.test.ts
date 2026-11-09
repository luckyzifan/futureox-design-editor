import {readFileSync} from 'node:fs'
import {afterEach,expect,test,vi} from 'vitest'
import {GpuRenderer} from './renderer'
import type {Driver,Texture} from './types'
import {inverse} from '../../geometry'
import {sampleHostedByteImage} from './source-bitmap-grid'
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs()})
function pattern(x:number,y:number){return [(x*3+y)&255,(x+y*5)&255,(x*7+11)&255,255]}
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
test('managed WebGPU samples the straight RGBA8 grid when dense bytes are enabled',()=>{
 const f=fixture()
 vi.stubGlobal('XMLHttpRequest',class{status=200;responseType='';response=new ArrayBuffer(0);open(){}send(data:Uint32Array){
  const width=data[0]*2,height=data[1]*2,bytes=new Uint8Array(width*height*4)
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)bytes.set(pattern(x,y),(y*width+x)*4)
  this.response=bytes.buffer
 }})
 const made=(w:number,h:number)=>({width:w,height:h,bytes:w*h*16,resource:{}} as Texture)
 f.driver.create=made
 f.driver.pass=vi.fn()
 f.driver.clear=vi.fn()
 f.p.stops=[];f.p.opacity=1;f.p.angle=0
 const mask={rect:{...f.n.rect},texture:{width:8,height:8,bytes:64,resource:{}} as Texture}
 f.r.paint(f.n,f.p,mask)
 expect(f.driver.managed).toBe(true)
 expect(f.driver.uploadStraightSrgb8).toHaveBeenCalledOnce()
 expect(f.driver.uploadLinear).not.toHaveBeenCalled()
 const [pixels,w,h]=f.driver.uploadStraightSrgb8.mock.calls[0]
 expect(pixels).toBeInstanceOf(Uint8Array);expect([w,h]).toEqual([256,32])
 const field=f.driver.uploadParameters.mock.calls.at(-1)[0] as Float32Array
 let at=0
 for(;at<field.length;at+=4)if(field[at+2]===1)break
 expect(field[at+2]).toBe(1);expect(field[at+3]).toBe(0)
 const ix=Math.floor(field[at]),iy=Math.floor(field[at+1]),fx=field[at]-ix,fy=field[at+1]-iy
 const texel=(x:number,y:number)=>x<0||y<0||x>=w||y>=h?[0,0,0,0]:pattern(x,y)
 const mix=(a:number[],b:number[],t:number)=>a.map((v,i)=>v+(b[i]-v)*t)
 const expected=mix(mix(texel(ix,iy),texel(ix+1,iy),fx),mix(texel(ix,iy+1),texel(ix+1,iy+1),fx),fy).map(v=>v/255)
 const sampled=sampleHostedByteImage(pixels,w,h,field[at],field[at+1])
 expect(sampled.map(v=>v.toFixed(6))).toEqual(expected.map(v=>v.toFixed(6)))
 expect(pixels[(iy*w+ix)*4]).toBe(pattern(ix,iy)[0])
 const u=f.driver.pass.mock.calls[0][1] as Float32Array
 expect(u[28]).toBe(3)
 expect(u[187]).toBe(1)
 u[240]=1
 const shader=readFileSync(new URL('../../../../../design-studio/crates/design-kernel/shaders/vector.wgsl',import.meta.url),'utf8')
 const byteAt=shader.indexOf('if(kind==3&&u(46).w>0.5){let grid=byteImageAddress(p);')
 const linearAt=shader.indexOf('else if(kind==3&&u(60).x>0.5){paint=mulRN4(linearImage(p)')
 expect(byteAt).toBeGreaterThan(-1)
 expect(linearAt).toBeGreaterThan(byteAt)
 expect(u[240]).toBe(1)
 f.r.dispose()
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
