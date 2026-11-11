import {expect,test} from 'vitest'
import {WheelCameraGesture} from './wheel-camera-gesture'
import {MAX_CANVAS_ZOOM,MIN_CANVAS_ZOOM,wheelCamera,screenToWorld} from './canvas-camera'
const size={width:855,height:888},anchor={x:427.5,y:444}
const initial={x:-1332.43125,y:3.6218749999999886,zoom:.4036458333333333}
test('thousands of opposing pan samples return to the identical camera without rounding its phase',()=>{
 const gesture=new WheelCameraGesture();let view={...initial}
 for(let cycle=0;cycle<100;cycle++)for(const sign of [-1,1])for(let i=0;i<24;i++)
  view=gesture.update(view,{deltaX:sign*64,deltaY:sign*32,deltaMode:0},size,anchor)
 expect(view).toEqual(initial)
})
test('reversing wheel and pinch zoom returns the original density and fractional phase exactly',()=>{
 for(const pinch of [false,true]){
  const gesture=new WheelCameraGesture();let view={...initial}
  for(let cycle=0;cycle<20;cycle++)for(const sign of [-1,1])for(let i=0;i<16;i++)
   view=gesture.update(view,{deltaX:0,deltaY:sign*(pinch?8:35),deltaMode:0,ctrlKey:true},size,anchor,false,pinch)
  expect(view).toEqual(initial)
 }
})
test('opposing zoom and pan runs return to the original native tile phase',()=>{
 const gesture=new WheelCameraGesture()
 const dense={x:30.635252184381557,y:-1212.8690463838036,zoom:.09855276255057685}
 let view=dense
 const zoom=(factor:number,steps:number,reverse=false)=>{
  const dy=Math.fround(Math.log(factor)/(.003*steps))*(reverse?1:-1)
  for(let i=0;i<steps;i++)view=gesture.update(view,{deltaX:0,deltaY:dy,deltaMode:0,ctrlKey:true},size,anchor)
 }
 zoom(1.7,6)
 view=gesture.update(view,{deltaX:-280,deltaY:95,deltaMode:0},size,anchor)
 zoom(1.18,4);zoom(1.18,4,true)
 view=gesture.update(view,{deltaX:280,deltaY:-95,deltaMode:0},size,anchor)
 zoom(1.7,6,true)
 expect(view).toEqual(dense)
})
test('unequal batches of trusted float wheel deltas restore the native camera on reversal',()=>{
 const base={x:36.09967320261438,y:348.7826797385621,zoom:.05065359477124183}
 const zoom=(trusted:boolean,residual=0)=>{
  const gesture=new WheelCameraGesture()
  const input=(deltaY:number)=>({deltaX:0,deltaY,deltaMode:0,ctrlKey:true,isTrusted:trusted})
  let view=base
  for(let i=0;i<12;i++)view=gesture.update(view,input(-179.1244659423828),size,anchor)
  for(let i=0;i<10;i++)view=gesture.update(view,input(Math.fround(214.94937133789062+(i===9?residual:0))),size,anchor)
  return view
 }
 expect(zoom(true)).toEqual(base)
 expect(zoom(false)).not.toEqual(base)
 expect(zoom(true,.001)).not.toEqual(base)
})
test('changed anchor, pan, external camera and modifier semantics restart from the current camera',()=>{
 const gesture=new WheelCameraGesture(),event={deltaX:0,deltaY:-120,deltaMode:0,ctrlKey:true}
 let view=gesture.update(initial,event,size,anchor)
 const nextAnchor={x:45.25,y:22.5},world=screenToWorld(view,nextAnchor)
 view=gesture.update(view,event,size,nextAnchor)
 expect(screenToWorld(view,nextAnchor).x).toBeCloseTo(world.x,10)
 const external={x:12.5,y:-25.125,zoom:2.35}
 expect(gesture.update(external,event,size,anchor)).toEqual(wheelCamera(external,event,size,anchor))
 const pan={deltaX:0,deltaY:20,deltaMode:1,shiftKey:true}
 expect(gesture.update(external,pan,size,anchor,true)).toEqual(wheelCamera(external,pan,size,anchor,true))
})
test('clamped input is consumed so reversing at either limit responds immediately',()=>{
 for(const [zoom,sign] of [[MAX_CANVAS_ZOOM,-1],[MIN_CANVAS_ZOOM,1]]){
  const gesture=new WheelCameraGesture(),base={x:12,y:20,zoom};let view=base
  for(let i=0;i<30;i++)view=gesture.update(view,{deltaX:0,deltaY:sign*120,deltaMode:0,ctrlKey:true},size,anchor)
  expect(view).toEqual(base)
  const event={deltaX:0,deltaY:-sign*120,deltaMode:0,ctrlKey:true}
  expect(gesture.update(view,event,size,anchor)).toEqual(wheelCamera(base,event,size,anchor))
 }
})
