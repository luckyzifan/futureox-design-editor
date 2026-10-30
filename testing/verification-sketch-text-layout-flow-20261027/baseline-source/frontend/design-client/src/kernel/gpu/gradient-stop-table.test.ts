import {test,expect} from 'vitest'
import {GpuRenderer} from './renderer'
import type {Driver,GpuPaint,GpuNode,Texture} from './types'

test('large gradients preserve every stop and HDR/alpha in bounded parameter textures',()=>{
  const uploads:{values:Float32Array;width:number;height:number}[]=[]
  const driver={name:'webgpu',managed:true,scratchBytes:0,destroy(){},uploadParameters(values:Float32Array,width:number,height:number){uploads.push({values:values.slice(),width,height});return {width,height,bytes:values.byteLength,resource:{}} as Texture}} as unknown as Driver
  const r=new GpuRenderer(driver) as any;r.scene={colors:{'#123456':[3.5,-.125,.25,.625]}}
  const p={kind:'radial',color:'#123456',opacity:.75,angle:0,fit:'cover',stops:Array.from({length:36},(_,i)=>({offset:i/35,color:'#123456'}))} as GpuPaint
  const surface=r.gradientStopTable(p)
  expect(uploads).toHaveLength(1);expect([surface.rect.w,surface.rect.h]).toEqual([36,2])
  for(let i=0;i<36;i++){expect([...uploads[0].values.slice(i*4,i*4+4)]).toEqual([Math.fround(i/35),3.5,-.125,.25]);expect(uploads[0].values[144+i*4]).toBe(.625)}
  expect(r.gradientStopTable(p).texture).toBe(surface.texture)
  r.scene.colors['#123456']=[1,2,3,.5]
  expect(r.gradientStopTable(p).texture).not.toBe(surface.texture)
  expect(()=>r.gradientStopTable({...p,stops:Array(65).fill(p.stops[0])})).toThrow()
})
test('large-stop uniforms preserve the transform slots and use the texture path',()=>{
 const r=new GpuRenderer({name:'webgpu',managed:true,scratchBytes:0} as Driver) as any;r.scene={}
 const p={kind:'radial',color:'#123456',opacity:1,angle:0,fit:'cover',stops:Array.from({length:36},(_,i)=>({offset:i/35,color:'#123456'}))} as GpuPaint
 const n={rect:{x:0,y:0,w:10,h:10},matrix:[1,0,0,1,0,0],inverse:[1,0,0,1,0,0],size:[10,10]} as unknown as GpuNode
 const uniforms=new Float32Array(256);r.configurePaint(uniforms,n,p)
 expect(uniforms[35]).toBe(36);expect(uniforms[184]).toBe(0);expect([...uniforms.slice(52,180)]).toEqual(Array(128).fill(0))
})
