import {expect,test} from 'vitest'
import {paint} from '../../model'
import {batchableSolid,solidInstances} from './solid-batch'
import type {GpuNode} from './types'
function item(color:string,x=0):GpuNode{
 return {id:color,rect:{x,y:0,w:12,h:12},matrix:[1,0,0,1,0,0],inverse:[1,0,0,1,0,0],size:[12,12],fill:{rect:{x,y:0,w:12,h:12},first:0,count:6,rule:'evenodd',analytic:{first:12,count:4},analyticRect:[x+0.125,0.375,x+11.75,11.625]},fills:[paint(color)],strokes:[],children:[],effects:[],blend:'normal',opacity:1,mask:false,clip:false}
}
test('batching retains painter order and clips the quad without moving the sample origin',()=>{
 const a=item('#ff0000',-4),b=item('#0000ff',2),data=solidInstances([a,b],{x:0,y:0,w:16,h:16})
 expect(Array.from(data.slice(0,4))).toEqual([-4,0,12,12])
 expect(Array.from(data.slice(8,12))).toEqual([0.125,0.375,11.75,11.625])
 expect(Array.from(data.slice(12,16))).toEqual([1,0,0,1])
 expect(Array.from(data.slice(16,20))).toEqual([0,0,8,12])
 expect(Array.from(data.slice(32,36))).toEqual([0,0,1,1])
})
test('effects, mixed fills, group opacity and blend modes are batch barriers',()=>{
 const a=item('#ffffff');expect(batchableSolid(a)).toBe(true)
 for(const patch of [{opacity:0.5},{blend:'multiply'},{children:['child']},{fills:[paint('#ffffff','linear')]},{fills:[{...paint('#ffffff'),opacity:0.5}]},{effects:[{kind:'blur'}]}])expect(batchableSolid({...a,...patch} as GpuNode)).toBe(false)
})
test('offscreen items are culled while analytic bands retain their original address',()=>{
 const a=item('#ffffff',200),b=item('#223344');delete b.fill.analyticRect;b.fill.analytic!.bands=120
 const data=solidInstances([a,b],{x:0,y:0,w:16,h:16})
 expect(data.length).toBe(20);expect(Array.from(data.slice(4,8))).toEqual([12,4,120,1])
})
