import {expect,test} from 'vitest'
import {liveInteractionStack} from './resident-layer-stack'
import {compositeDrawPlan} from './gpu/composite-draw-plan'
import {progressiveTileLayer} from './progressive-quality'
import type {CompositeItem} from './gpu/tile-compositor'
const view={x:0,y:0,zoom:1}
const item=(id:number,layer:number,clip?:CompositeItem['clip']):CompositeItem=>({active:true,layer,gutter:0,clip,
 tile:{serial:id,key:String(id),gpuTile:id,x:0,y:0,width:100,height:100,zoom:1,bytes:new Uint8Array()},
 placement:{left:0,top:0,width:100,height:100}})
const area=(p:ReturnType<typeof compositeDrawPlan>[number])=>(p.clip.right-p.clip.left)*(p.clip.bottom-p.clip.top)
test('actual native page layer cannot occlude a newer live pose',()=>{
 const layer=progressiveTileLayer({fine:true,cached:false,coarse:false,sameContent:true,refining:false,cameraDependent:false,nativeDensity:true,nativePhase:true})
 const page=item(1,layer),live=item(2,0,{left:20,top:30,width:40,height:50})
 const negative=compositeDrawPlan([page,{...live,layer:4}],view,100,100)
 expect(negative.every(draw=>draw.item.tile.gpuTile===1)).toBe(true)
 const plan=compositeDrawPlan(liveInteractionStack([page],[live]),view,100,100)
 expect(plan.filter(draw=>draw.item.tile.gpuTile===2).reduce((sum,draw)=>sum+area(draw),0)).toBe(2000)
 expect(plan.filter(draw=>draw.item.tile.gpuTile===1).reduce((sum,draw)=>sum+area(draw),0)).toBe(8000)
 expect(page.layer).toBe(layer);expect(live.layer).toBe(0)
})
test('several live intervals keep painter order above arbitrary page quality bands',()=>{
 const page=item(1,11),back=item(2,3),front=item(3,7,{left:0,top:0,width:25,height:100})
 const stack=liveInteractionStack([page],[back,front])
 expect(stack.map(row=>row.layer)).toEqual([11,12,16])
 const plan=compositeDrawPlan(stack,view,100,100)
 expect(plan.map(row=>row.item.tile.gpuTile)).toEqual([2,3])
 expect(plan.map(area)).toEqual([7500,2500])
})
