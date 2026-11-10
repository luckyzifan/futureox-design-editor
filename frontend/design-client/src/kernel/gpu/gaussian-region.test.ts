import {expect,test} from 'vitest'
import {gaussianRegionRects,unmanagedByteGaussianBox,verticalPlaneReuse} from './gaussian-region'
import {uniformBoxRadius} from './box-prefix'
const plan={source:{x:-2070,y:-2070,w:4654,h:4654},output:{x:0,y:0,w:514,h:514},radii:[690,690,690] as [number,number,number]}
test('large Gaussian keeps every original tap while the virtual input exceeds a stored-surface budget',()=>{
 const rects=gaussianRegionRects(plan)!
 expect(plan.source.w*plan.source.h).toBeGreaterThan(16777216)
 expect(rects).toHaveLength(7);expect(rects.at(-1)).toEqual(plan.output)
 expect(rects.slice(1).every(r=>r.w*r.h<=16777216)).toBe(true)
 expect(gaussianRegionRects({...plan,source:{...plan.source,x:-2069}})).toBeUndefined()
 expect(gaussianRegionRects({...plan,source:{x:-3072,y:-3072,w:6658,h:6658},radii:[1024,1024,1024]})).toBeUndefined()
 expect(gaussianRegionRects({...plan,radii:[690,690,691]})).toBeUndefined()
})
function packet(r:number){
 const data=new Uint32Array(r+6);data.set([1,Math.ceil((Math.floor(Math.log2(2*r+1))+1+278)/32),r,0,2*r+1]);data.fill(1,5)
 return new Uint8Array(data.buffer)
}
test('unmanaged byte boxes above 512 stay on the regional cap and off the managed prefix',()=>{
  const allow=(radius:number,format='rgba8unorm')=>unmanagedByteGaussianBox(false,false,false,15,radius,format,false,false)
  expect(allow(513)).toBe(true)
  expect(allow(611)).toBe(true)
  expect(allow(1024)).toBe(true)
  for(const radius of [512,1025,611.5,NaN])expect(allow(radius)).toBe(false)
  expect(unmanagedByteGaussianBox(true,false,false,15,611,'rgba8unorm',false,false)).toBe(false)
  expect(unmanagedByteGaussianBox(false,true,false,15,611,'rgba8unorm',false,false)).toBe(false)
  expect(unmanagedByteGaussianBox(false,false,true,15,611,'rgba8unorm',false,false)).toBe(false)
  expect(allow(611,'rgba32float')).toBe(false)
  expect(unmanagedByteGaussianBox(false,false,false,8,611,'rgba8unorm',false,false)).toBe(false)
  expect(unmanagedByteGaussianBox(false,false,false,15,611,'rgba8unorm',true,false)).toBe(false)
})
test('uniform prefix accepts actual canonical coefficient words and refuses altered operators',()=>{
 for(const r of [1,32,256,512,690,1024])expect(uniformBoxRadius(packet(r))).toBe(r)
 for(const word of [0,1,2,3,4,5,37]){
  const bytes=packet(64);new DataView(bytes.buffer).setUint32(word*4,42,true);expect(uniformBoxRadius(bytes)).toBeUndefined()
 }
 expect(uniformBoxRadius(packet(1025))).toBeUndefined()
 expect(uniformBoxRadius(packet(0))).toBeUndefined()
 const shared=new Uint8Array(new SharedArrayBuffer(packet(64).length));shared.set(packet(64));expect(uniformBoxRadius(shared)).toBeUndefined()
})
test('117 zoom-64 Gaussian planes reuse the vertical overlap and recompute one strip',()=>{
  // First stored plane of sigma 612.1517944335938 on a 514 tile: 2962×4184.
  const anchor={x:-1835,y:-1836,w:2962,h:4184}
  const below={...anchor,y:anchor.y+512}
  const reuse=verticalPlaneReuse(anchor,below)
  expect(reuse).toEqual({
    source:{x:0,y:512,w:2962,h:3672},
    origin:[0,0],
    fresh:{x:anchor.x,y:anchor.y+anchor.h,w:2962,h:512},
  })
  const above=verticalPlaneReuse(below,anchor)
  expect(above?.fresh).toEqual({x:anchor.x,y:anchor.y,w:2962,h:512})
  expect(above?.origin).toEqual([0,512])
  expect(above?.source.h).toBe(3672)
  const step=verticalPlaneReuse(anchor,{...anchor,y:anchor.y+1024})
  expect(step?.fresh.h).toBe(1024)
  expect(step?.source.h).toBe(3160)
  expect(verticalPlaneReuse(anchor,anchor)).toBeUndefined()
  expect(verticalPlaneReuse(anchor,{...anchor,y:anchor.y+4184})).toBeUndefined()
  expect(verticalPlaneReuse(anchor,{...anchor,x:anchor.x+512})).toBeUndefined()
  expect(verticalPlaneReuse(anchor,{...anchor,h:4183})).toBeUndefined()
  expect(verticalPlaneReuse(anchor,{...anchor,y:anchor.y+0.5})).toBeUndefined()
})
