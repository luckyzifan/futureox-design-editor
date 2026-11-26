import {expect,test} from 'vitest'
import {gaussianRegionRects,unmanagedByteGaussianBox,type GaussianRegion} from './gaussian-region'
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
/** CPU-visible Gaussian working set: every planned surface is rgba32float. */
function gaussianWorkingSetBytes(plan:GaussianRegion){
  return gaussianRegionRects(plan)!.reduce((bytes,rect)=>bytes+rect.w*rect.h*16,0)
}
test('factor-8 reduction holds the CPU Gaussian working set to roughly 1/63 of exact',()=>{
  const output={x:0,y:0,w:514,h:514}
  const exact:GaussianRegion={source:{x:-2068,y:-2068,w:4650,h:4650},output,radii:[689,689,690]}
  // Radii and grid are the factor-8 plan measured in PR #1009 for the same sigma.
  const reduced:GaussianRegion={source:{x:-259,y:-259,w:583,h:583},output:{x:-2,y:-2,w:69,h:69},
    radii:[85,86,86],factor:8,fullOutput:output}
  const exactBytes=gaussianWorkingSetBytes(exact),reducedBytes=gaussianWorkingSetBytes(reduced)
  expect(exactBytes).toBe(937046400)
  expect(reducedBytes).toBe(14883856)
  expect(exactBytes/reducedBytes).toBeGreaterThan(62)
  expect(reduced.source.w*reduced.source.h).toBeLessThanOrEqual(4_194_304)
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
