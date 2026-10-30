import {expect,test} from 'vitest'
import {animatePrototypeScroll} from './prototype-scroll'
test('authored duration/easing use absolute time and cancellation cannot land an old request',()=>{
  let next:FrameRequestCallback=()=>{}, cancelled=0
  const clock={now:()=>100,request:(f:FrameRequestCallback)=>{next=f;return 1},cancel:()=>{cancelled++}}
  const element={scrollLeft:0,scrollTop:0,scrollWidth:600,scrollHeight:600,clientWidth:100,clientHeight:100,
    scrollTo(p:ScrollToOptions){this.scrollLeft=p.left!;this.scrollTop=p.top!}}
  const cancel=animatePrototypeScroll(element as any,{left:200,top:400},1000,'ease-in-quad',clock)
  next(600);expect(element.scrollLeft).toBe(50);expect(element.scrollTop).toBe(100)
  next(1100);expect(element.scrollLeft).toBe(200)
  cancel();expect(cancelled).toBe(1)
  const stop=animatePrototypeScroll(element as any,{left:0,top:0},1000,'linear',clock)
  stop();next(5000);expect(element.scrollLeft).toBe(200)
  animatePrototypeScroll(element as any,{left:900,top:-50},0,'linear',clock)
  expect([element.scrollLeft,element.scrollTop]).toEqual([500,0])
})
