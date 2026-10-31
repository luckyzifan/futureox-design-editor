import {expect,test} from 'vitest'
import {disjointNeutralGroup} from './neutral-group'
import type {GpuScene,GpuNode} from './types'
function fixture(){
  const n={id:'group',rect:{x:0,y:0,w:100,h:100},opacity:1,blend:'normal',fills:[],strokes:[],effects:[],children:['a','b']} as unknown as GpuNode
  const child=(id:string,x:number)=>({...n,id,rect:{x,y:10,w:20,h:20},children:[]})
  return {n,scene:{nodes:{group:n,a:child('a',10),b:child('b',60)}} as unknown as GpuScene}
}
test('only disjoint independent children within a fully opaque ancestor clip can bypass isolation',()=>{
  const {n,scene}=fixture();expect(disjointNeutralGroup(scene,n,{opaqueInterior:n.rect})).toBe(true)
  expect(disjointNeutralGroup(scene,{...n,clip:true},{opaqueInterior:n.rect})).toBe(true)
  expect(disjointNeutralGroup(scene,n,{})).toBe(false)
  expect(disjointNeutralGroup(scene,n,{opaqueInterior:{x:1,y:0,w:99,h:100}})).toBe(false)
  for(const patch of [{rect:{x:12,y:12,w:20,h:20}},{blend:'multiply'},{passthrough:true},{mask:true},
    {effects:[{kind:'glass',visible:true}]},{effects:[{kind:'background-blur',visible:true}]}]) {
    expect(disjointNeutralGroup({...scene,nodes:{...scene.nodes,b:{...scene.nodes.b,...patch}}} as GpuScene,n)).toBe(false)
  }
  expect(disjointNeutralGroup(scene,{...n,opacity:.5})).toBe(false)
  expect(disjointNeutralGroup(scene,{...n,effects:[{kind:'blur',visible:true}]} as GpuNode)).toBe(false)
})
