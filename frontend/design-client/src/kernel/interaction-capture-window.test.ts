import {expect,test} from 'vitest'
import {expandedInteractionCapture as expand} from './interaction-capture-window'
test('a reversal keeps both earlier and newly required output until the bounded union no longer fits',()=>{
 const first={x:0,y:0,width:300,height:220}
 const right=expand(first,{x:50,y:20,width:310,height:220},2)
 expect(right).toEqual({x:0,y:0,width:360,height:240})
 const left=expand(right,{x:-60,y:-30,width:300,height:220},2)
 expect(left).toEqual({x:-60,y:-30,width:420,height:270})
 expect(expand(left,right,2)).toEqual(left)
 const distant={x:2000,y:2000,width:310,height:220}
 expect(expand(left,distant,2)).toBe(distant)
})
test('pixel alignment, texture axes and invalid history cannot expand the existing capture policy',()=>{
 const next={x:.25,y:.25,width:512,height:512}
 expect(expand({x:0,y:0,width:512,height:512},next,2)).toBe(next)
 expect(expand({x:-8200,y:0,width:1,height:1},{x:0,y:0,width:1,height:1},1)).toEqual({x:0,y:0,width:1,height:1})
 expect(expand({x:NaN,y:0,width:1,height:1},next,2)).toBe(next)
 expect(expand(undefined,next,2)).toBe(next)
})
