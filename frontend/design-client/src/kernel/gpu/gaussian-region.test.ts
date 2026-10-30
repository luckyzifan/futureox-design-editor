import {expect,test} from 'vitest'
import {gaussianRegionRects} from './gaussian-region'
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
test('uniform prefix accepts actual canonical coefficient words and refuses altered operators',()=>{
 for(const r of [1,32,256,512,690,1024])expect(uniformBoxRadius(packet(r))).toBe(r)
 for(const word of [0,1,2,3,4,5,37]){
  const bytes=packet(64);new DataView(bytes.buffer).setUint32(word*4,42,true);expect(uniformBoxRadius(bytes)).toBeUndefined()
 }
 expect(uniformBoxRadius(packet(1025))).toBeUndefined()
 expect(uniformBoxRadius(packet(0))).toBeUndefined()
 const shared=new Uint8Array(new SharedArrayBuffer(packet(64).length));shared.set(packet(64));expect(uniformBoxRadius(shared)).toBeUndefined()
})
