import {readFileSync} from 'node:fs'
import {afterEach,expect,test,vi} from 'vitest'
import {GpuRenderer} from './renderer'
import type {Driver,GpuScene,Texture} from './types'
import {inverse} from '../../geometry'
import type {Matrix} from '../../model'
import {hostedByteImageSource,imageCoordinateSource} from './image-coordinate-source'
import {displayImageSource} from './display-image-source'
import {imageResolveStepWgsl} from './image-resolve-step'
import {hostedDenseByteFrame,noteHostedStraightImage,sampleHostedByteImage} from './source-bitmap-grid'
import {WebGpuDriver} from './webgpu'
import {color_controls_uniforms,straight_srgb8_table} from '../../generated/design-kernel/design_kernel'
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs()})
function pattern(x:number,y:number){return [(x*3+y)&255,(x+y*5)&255,(x*7+11)&255,255]}
function lut(){
 const raw=straight_srgb8_table(),view=new DataView(raw.buffer,raw.byteOffset,raw.byteLength)
 return Float32Array.from({length:512},(_,i)=>view.getFloat32(i*4,true))
}
function fixture(){
 vi.stubEnv('VITE_DESIGN_DENSE_SOURCE_BYTES','1')
 vi.stubGlobal('XMLHttpRequest',class{status=200;responseType='';response=new ArrayBuffer(0);open(){}send(data:Uint32Array){const bytes=new Uint8Array(data[0]*data[1]*16);bytes.fill(255);this.response=bytes.buffer}})
 const texture=(w:number,h:number,bytes=w*h*16)=>({width:w,height:h,bytes,resource:{}} as Texture)
 const driver:any={name:'webgpu',managed:true,linearLight:true,hdr:false,displayMath:false,scratchBytes:0,lost:false,
  create:(w:number,h:number)=>texture(w,h),
  uploadLinear:vi.fn((_v:Float32Array,w:number,h:number)=>texture(w,h)),uploadParameters:vi.fn((_v:Float32Array,w:number,h:number)=>texture(w,h)),
  uploadStraightSrgb8:vi.fn((_v:Uint8Array,w:number,h:number)=>texture(w,h+2,w*(h+2)*4)),
  clear:vi.fn(),pass:vi.fn(),destroy:vi.fn(),dispose:vi.fn()}
 const r=new GpuRenderer(driver as Driver,true,false,undefined,false,false,1024) as any
 r.scene={colorManagement:{documentSpace:'srgb'},floatCompositing:true,nativeInteraction:true,interactionRetained:true,nodes:{}}
 r.sampleIndex=0
 const a=.27,c=Math.cos(a),s=Math.sin(a),matrix=[c,s,-s,c,0,0] as Matrix
 const n={id:'rotated-file-image',rect:{x:0,y:0,w:128,h:16},size:[512,512],matrix,inverse:inverse(matrix as any)}
 const p:any={kind:'image',image:'design-app://app/source-image/owned-1/'+ 'a'.repeat(64)+'-512x512.png?samples=1',color:'#000000',fit:'cover',visible:true,blend:'normal'}
 return{r,driver,n,p,texture}
}
function patternTransport(){
 vi.stubGlobal('XMLHttpRequest',class{status=200;responseType='';response=new ArrayBuffer(0);open(){}send(data:Uint32Array){
  const width=data[0]*2,height=data[1]*2,bytes=new Uint8Array(width*height*4)
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)bytes.set(pattern(x,y),(y*width+x)*4)
  this.response=bytes.buffer
 }})
}
test('dense source bytes stay default-off',()=>{
 expect(import.meta.env.VITE_DESIGN_DENSE_SOURCE_BYTES).not.toBe('1')
 expect(hostedDenseByteFrame({present:true,readback:false})).toBe(true)
 expect(hostedDenseByteFrame({present:true,readback:true})).toBe(false)
})
test('managed WebGPU decodes the straight grid with the linear image path',()=>{
 const f=fixture();patternTransport()
 f.p.stops=[];f.p.opacity=.65;f.p.angle=0
 const mask={rect:{...f.n.rect},texture:{width:8,height:8,bytes:64,resource:{}} as Texture}
 const painted=f.r.paint(f.n,f.p,mask)
 expect(f.driver.uploadStraightSrgb8).toHaveBeenCalledOnce()
 expect(f.driver.uploadLinear).not.toHaveBeenCalled()
 const [pixels,w,h]=f.driver.uploadStraightSrgb8.mock.calls[0] as [Uint8Array,number,number]
 expect(pixels).toBeInstanceOf(Uint8Array);expect([w,h]).toEqual([256,32])
 const field=f.driver.uploadParameters.mock.calls.at(-1)[0] as Float32Array
 const valid:number[]=[]
 for(let i=0;i<field.length;i+=4){
  if(field[i]===-2){expect(field[i+1]).toBe(-2);continue}
  expect(Number.isInteger(field[i])).toBe(true)
  expect(Number.isInteger(field[i+1])).toBe(true)
  expect(field[i+2]).toBeGreaterThanOrEqual(0);expect(field[i+2]).toBeLessThan(1)
  expect(field[i+3]).toBeGreaterThanOrEqual(0);expect(field[i+3]).toBeLessThan(1)
  valid.push(i)
 }
 expect(valid.length).toBeGreaterThan(0)
 expect(valid.every(i=>field[i+2]===1&&field[i+3]===0)).toBe(false)
 const at=valid[0],ix=field[at],iy=field[at+1]
 expect(Array.from(pixels.subarray((iy*w+ix)*4,(iy*w+ix)*4+4))).toEqual(pattern(ix,iy))
 const table=lut()
 let nonlinear=-1
 for(const i of valid){
  const px=field[i],py=field[i+1],byte=pixels[(py*w+px)*4]
  const alpha=table[256+pixels[(py*w+px)*4+3]]
  if(Math.abs(byte/255-table[byte]*alpha)>1e-4){nonlinear=i;break}
 }
 expect(nonlinear).toBeGreaterThanOrEqual(0)
 const nx=field[nonlinear],ny=field[nonlinear+1]
 const straight=sampleHostedByteImage(pixels,w,h,nx,ny)
 const decoded=table[pixels[(ny*w+nx)*4]]*table[256+pixels[(ny*w+nx)*4+3]]
 expect(Math.abs(straight[0]-decoded)).toBeGreaterThan(1e-4)
 const u=f.driver.pass.mock.calls[0][1] as Float32Array
 expect(u[16]).toBe(2);expect(u[28]).toBe(3);expect(u[32]).toBeCloseTo(.65,6);expect(u[187]).toBe(0)
 noteHostedStraightImage(u,true,false,false)
 expect([u[187],u[206],u[207]]).toEqual([0,0,1])
 u[240]=1
 const vector=readFileSync(new URL('../../../../../design-studio/crates/design-kernel/shaders/vector.wgsl',import.meta.url),'utf8')
 const addressed=imageCoordinateSource(vector+imageResolveStepWgsl)
 const hosted=hostedByteImageSource(addressed)
 const texelAt=hosted.indexOf('fn linearImageTexel(')
 const texel=hosted.slice(texelAt,hosted.indexOf('\nfn ',texelAt+1))
 const linear=hosted.indexOf('fn linearImage(')
 const exact=hosted.indexOf('return bsBilinear4(a,b,c,d,grid.zw',linear)
 const byteAt=hosted.indexOf('if(kind==3&&u(46).w>0.5)')
 const hostedCall=hosted.indexOf('paint=mulRN4(hostedStraightByteImage(p)',byteAt)
 const linearCall=hosted.indexOf('paint=mulRN4(linearImage(p)',hostedCall)
 expect(texel).toContain('if(u(51).w==1.)')
 expect(texel).toContain('textureLoad(sourceBytes,q,0)')
 expect(texel).not.toContain('round(')
 expect(hosted).toContain('@group(0) @binding(6) var sourceBytes:texture_2d<u32>')
 expect(exact).toBeGreaterThan(linear)
 expect(hostedCall).toBeGreaterThan(byteAt)
 expect(linearCall).toBeGreaterThan(hostedCall)
 expect(displayImageSource(hosted)).toContain('fn displayImageLinear(')
 expect(u[240]).toBe(1)
 const controls={brightness:.2,contrast:1.4,saturation:.4,hue:15}
 const effect=f.r.colorControls(painted,controls)
 expect(effect.texture).not.toBe(painted.texture)
 const effectPass=f.driver.pass.mock.calls.find((call:unknown[])=> (call[1] as Float32Array)[16]===60)
 expect(effectPass[2]).toEqual([painted.texture])
 expect(effectPass[2]).not.toContain(f.driver.uploadStraightSrgb8.mock.results[0].value)
 const expected=color_controls_uniforms(JSON.stringify(controls),true)
 expect(Array.from((effectPass[1] as Float32Array).slice(36,36+expected.length))).toEqual(Array.from(expected))
 f.r.dispose()
})
test('undo restores the coordinate field and an exact readback uses the float grid',()=>{
 const f=fixture();patternTransport()
 f.p.stops=[];f.p.opacity=1;f.p.angle=0
 const mask={rect:{...f.n.rect},texture:{width:8,height:8,bytes:64,resource:{}} as Texture}
 const pose=[...f.n.matrix] as Matrix,poseInverse=[...f.n.inverse] as Matrix
 f.r.paint(f.n,f.p,mask)
 const firstField=f.driver.uploadParameters.mock.results[0].value as Texture
 const firstBytes=Uint8Array.from(f.driver.uploadStraightSrgb8.mock.calls[0][0] as Uint8Array)
 const turned=.9,c=Math.cos(turned),s=Math.sin(turned)
 f.n.matrix=[c,s,-s,c,3,4];f.n.inverse=inverse(f.n.matrix)
 f.r.paint(f.n,f.p,mask)
 expect(f.driver.uploadParameters).toHaveBeenCalledTimes(2)
 expect(Array.from(f.driver.uploadParameters.mock.calls[1][0] as Float32Array)).not.toEqual(Array.from(f.driver.uploadParameters.mock.calls[0][0] as Float32Array))
 f.n.matrix=pose;f.n.inverse=poseInverse
 f.r.paint(f.n,f.p,mask)
 expect(f.driver.uploadParameters).toHaveBeenCalledTimes(2)
 expect(f.driver.pass.mock.calls.at(-1)[2][3]).toBe(firstField)
 expect(Array.from(f.driver.uploadStraightSrgb8.mock.calls.at(-1)[0] as Uint8Array)).toEqual(Array.from(firstBytes))
 expect((f.driver.pass.mock.calls.at(-1)[1] as Float32Array)[187]).toBe(0)
 f.r.outputFrame={readback:true,present:true}
 f.r.paint(f.n,f.p,mask)
 expect(f.driver.uploadStraightSrgb8).toHaveBeenCalledTimes(3)
 expect(f.driver.uploadLinear).toHaveBeenCalledOnce()
 const linear=f.driver.uploadLinear.mock.calls[0][0] as Float32Array
 const table=lut()
 expect(linear.length).toBe(firstBytes.length)
 const bits=new Uint32Array(linear.buffer,linear.byteOffset,linear.length)
 const decoded=new Float32Array(firstBytes.length)
 for(let i=0;i<firstBytes.length;i+=4){
  const alpha=table[256+firstBytes[i+3]]
  decoded[i]=table[firstBytes[i]]*alpha;decoded[i+1]=table[firstBytes[i+1]]*alpha
  decoded[i+2]=table[firstBytes[i+2]]*alpha;decoded[i+3]=alpha
 }
 expect(bits).toEqual(new Uint32Array(decoded.buffer))
 expect((f.driver.pass.mock.calls.at(-1)[1] as Float32Array)[187]).toBe(0)
 expect(f.driver.pass.mock.calls.at(-1)[2][1]).toBe(f.driver.uploadLinear.mock.results[0].value)
 f.r.dispose()
})
test('hosted pass selects table decode for a straight image and leaves other modes alone',()=>{
 const image={resource:{}}
 const u=new Float32Array(256);u[16]=2;u[28]=3;u[187]=0
 const host={sourceImageSampling:false,straightSources:new WeakSet([image]),immutableImageRange:()=>undefined,encodePass:vi.fn()}
 WebGpuDriver.prototype.pass.call(host,{} as Texture,u,[undefined as unknown as Texture,image as Texture])
 expect([u[187],u[206],u[207]]).toEqual([0,0,1])
 expect(host.encodePass).toHaveBeenCalledOnce()
 host.sourceImageSampling=true
 WebGpuDriver.prototype.pass.call(host,{} as Texture,u,[undefined as unknown as Texture,image as Texture])
 expect([u[187],u[206],u[207]]).toEqual([0,1,1])
 host.sourceImageSampling=false
 u[16]=51;u[206]=0;u[207]=0
 WebGpuDriver.prototype.pass.call(host,{} as Texture,u,[undefined as unknown as Texture,image as Texture])
 expect([u[187],u[206],u[207]]).toEqual([0,0,1])
 u[16]=22;const kept=u[207]
 WebGpuDriver.prototype.pass.call(host,{} as Texture,u,[undefined as unknown as Texture,image as Texture])
 expect(u[207]).toBe(kept)
})
test.each(['off','hdr','display-math','ordinary','source-detail','adjusted','small','no-uploader','readback','unpresented','resolve','presentation'])('dense bytes retain the float path for %s',kind=>{
 const f=fixture()
 if(kind==='off')vi.stubEnv('VITE_DESIGN_DENSE_SOURCE_BYTES','0')
 if(kind==='hdr')f.driver.hdr=true
 if(kind==='display-math')f.driver.displayMath=true
 if(kind==='ordinary')f.r.scene.nativeInteraction=false
 if(kind==='source-detail')f.r.scene.sourceDetailTile=true
 if(kind==='adjusted')f.p.adjust={exposure:.1}
 if(kind==='small')f.n.rect.w=32
 if(kind==='readback'||kind==='unpresented'||kind==='resolve'||kind==='presentation')
  f.r.outputFrame={readback:kind==='readback',present:kind!=='unpresented'}
 if(kind==='resolve')f.r.scene.resolve={width:8,height:8,offsetX:0,offsetY:0,scale:1}
 if(kind==='presentation')f.r.scene.presentation={width:8,height:8,offsetX:0,offsetY:0,scale:1}
 const upload=f.driver.uploadStraightSrgb8
 if(kind==='no-uploader')delete f.driver.uploadStraightSrgb8
 f.r.sourceBitmapGrid(f.n,f.p)
 expect(upload).not.toHaveBeenCalled();expect(f.driver.uploadLinear).toHaveBeenCalledOnce()
 f.r.dispose()
})
test('an exact readback drops a layer painted by the straight grid',async()=>{
 const f=fixture()
 const rect=f.n.rect
 const node={...f.n,fill:{rect,first:0,count:0,rule:'nonzero'},fills:[],strokes:[],children:[],effects:[],opacity:1,blend:'normal',clip:false,mask:false,textureReplay:null,maskId:null}
 const scene={version:7,width:rect.w,height:rect.h,extent:{...rect},background:'#ffffff',transparent:true,grid:false,
  view:{x:0,y:0,zoom:1},roots:[node.id],vertices:[],nodes:{[node.id]:node},floatCompositing:true,
  colorManagement:{documentSpace:'srgb'},nativeInteraction:true,interactionRetained:true} as unknown as GpuScene
 const cached={width:1,height:1,bytes:4,resource:{}} as Texture
 f.r.interactionRoots.set(node,{anchor:{...rect},planes:[{texture:cached,rect:{...rect}}]})
 await expect(f.r.render(scene,false,true)).rejects.toThrow()
 expect(f.r.interactionRoots.has(node)).toBe(true)
 expect(f.r.outputFrame).toBeUndefined()
 f.r.denseBytePainted=true
 f.r.interactionInvalid=false
 await expect(f.r.render(scene,true,true)).rejects.toThrow()
 expect(f.r.interactionRoots.size).toBe(0)
 expect(f.r.denseBytePainted).toBe(false)
 expect(f.r.outputFrame).toBeUndefined()
 f.r.dispose()
})
