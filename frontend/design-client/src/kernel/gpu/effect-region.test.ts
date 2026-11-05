import { expect, test } from 'vitest'
import { backdropOverlap, exactBlendLattice, glassBackdropWindow, guardedPixelWindow, interactionEffectRegion, interactionHalo, localPoseDemand } from './effect-region'
import type { GpuScene, Rect } from './types'
test('exact regional blending rejects changes to the floating point sampling lattice', () => {
  const r={x:18000,y:-750,w:2000,h:1280}
  expect(exactBlendLattice([r,{x:18011,y:-740,w:91,h:20}])).toBe(true)
  for(const value of [.125,NaN,Infinity,1048577])expect(exactBlendLattice([r,{...r,x:value}])).toBe(false)
})
test('moving backdrop strips cover every changed filter footprint exactly once',()=>{
  const previous={x:-80,y:17,w:160,h:120},next={x:-73,y:13,w:160,h:120},support=13
  const plan=backdropOverlap(previous,next,support)!
  const inside=(r:Rect,x:number,y:number)=>x>=r.x&&x<r.x+r.w&&y>=r.y&&y<r.y+r.h
  for(let y=next.y;y<next.y+next.h;y++)for(let x=next.x;x<next.x+next.w;x++){
    expect(Number(inside(plan.reuse,x,y))+plan.dirty.filter(r=>inside(r.output,x,y)).length).toBe(1)
    if(inside(plan.reuse,x,y))for(const r of [previous,next]){
      expect(inside(r,x-support,y-support)).toBe(true)
      expect(inside(r,x+support,y+support)).toBe(true)
    }
  }
  expect(backdropOverlap(previous,{...next,x:.125},support)).toBeUndefined()
  expect(backdropOverlap(previous,{...next,x:1000},support)).toBeUndefined()
})

test('glass capture retains fractional spectral rays, their bilinear neighbours and full blur support',()=>{
 const basis={x:-512,y:-512,w:1024,h:1024},mask={x:-40,y:72,w:30,h:64},matrix=[-1.5,.25,.1,.75,7,-3]
 const input=glassBackdropWindow(basis,mask,matrix,12,.8,15)!
 for(const x of [mask.x,mask.x+mask.w-1])for(const y of [mask.y,mask.y+mask.h-1]){
  for(const dx of [-12*.8,12*.8])for(const dy of [-12*.8,12*.8])for(const factor of [.8,1,1.2]){
   const sx=x+Math.floor(factor*(matrix[0]*dx+matrix[2]*dy)-.375),sy=y+Math.floor(factor*(matrix[1]*dx+matrix[3]*dy)+.375)
   expect(sx-15).toBeGreaterThanOrEqual(input.x);expect(sy-15).toBeGreaterThanOrEqual(input.y)
   expect(sx+16).toBeLessThan(input.x+input.w);expect(sy+16).toBeLessThan(input.y+input.h)
  }
 }
 expect(glassBackdropWindow(basis,basis,matrix,12,.8,15)).toBeUndefined()
 expect(glassBackdropWindow({...basis,x:.25},mask,matrix,12,.8,15)).toBeUndefined()
})
test('effect cropping retains native lattice, dependency halo and extra read support', () => {
  const scene = { nativeInteraction:true, interactionRetained:true, width:1000,height:800,
    extent:{x:-20,y:-20,w:1040,h:840},interactionWindow:{x:200.125,y:100.875,w:100.5,h:80.25} } as GpuScene
  const source={x:-20,y:-20,w:1040,h:840}
  expect(interactionEffectRegion(scene,source,8)).toEqual({x:170,y:70,w:163,h:143})
  expect(interactionEffectRegion({...scene,coherentSamples:true},source,8)).toBe(source)
  expect(interactionEffectRegion({...scene,nativeInteraction:false},source,8)).toBe(source)
  expect(interactionEffectRegion(scene,{...source,x:.25},8)).toEqual({...source,x:.25})
})
test('world-anchored captures retain the same dependency halo and clipped region after translation',()=>{
  const source={x:-20,y:-20,w:1040,h:840}
  const base={nativeInteraction:true,interactionRetained:true,width:1000,height:800,
    output:{x:0,y:0,w:1000,h:800},extent:source,interactionWindow:{x:200.125,y:100.875,w:100.5,h:80.25}} as GpuScene
  const local=interactionEffectRegion(base,source,8)
  for(const [dx,dy] of [[18000,-750],[-23000,9200]]){
    const shift=(r:Rect)=>({...r,x:r.x+dx,y:r.y+dy})
    const moved={...base,output:shift(base.output!),extent:shift(base.extent),interactionWindow:shift(base.interactionWindow!)}
    expect(interactionHalo(moved)).toBe(interactionHalo(base))
    expect(interactionEffectRegion(moved,shift(source),8)).toEqual(shift(local))
  }
})

test('exact pose output includes fractional neighbours and declines upstream filter reads',()=>{
  const visible={x:190.3,y:424.1,w:304.7,h:301}
  const physical=guardedPixelWindow(visible)
  expect(physical).toEqual({x:188,y:422,w:309,h:306})
  const scene={nativeInteraction:true,interactionRetained:true,interactionLocalFootprint:true,
    coherentSamples:true,interactionWindow:{x:180,y:415,w:340,h:320},interactionContentWindow:physical,nodes:{}} as GpuScene
  expect(localPoseDemand(scene)).toEqual(guardedPixelWindow(physical))
  expect(localPoseDemand({...scene,interactionContentWindow:undefined})).toEqual(guardedPixelWindow(scene.interactionWindow!))
  expect(localPoseDemand({...scene,interactionRetained:false})).toBeUndefined()
  const filtered={rect:physical,children:['child'],effects:[{visible:true,kind:'blur'}]} as GpuScene['nodes'][string]
  expect(localPoseDemand({...scene,nodes:{group:filtered}})).toBeUndefined()
})
