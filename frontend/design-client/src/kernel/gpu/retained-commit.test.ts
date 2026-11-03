import { expect, test } from 'vitest'
import { blank, node, effect } from '../../model'
import { canCommitResidentFrame } from './retained-commit'
import type { GpuScene } from './types'
import type { ResidentFrame } from './resident-presenter'
function fixture() {
 const doc=blank(),n=node('rectangle',0,0,10,10);doc.nodes[n.id]=n;doc.pages[0].children=[n.id]
 const scene={view:{x:0,y:0,zoom:2},nodes:{[n.id]:{id:n.id,matrix:[1,0,0,1,2,0],
  previewSource:{matrix:[1,0,0,1,0,0]},effects:[]}}} as unknown as GpuScene
 const input={sequence:5,at:100,owner:'gesture'}
 const frame:ResidentFrame={view:{x:0,y:0,zoom:1},width:10,height:10,dpr:2,interaction:true,input,
  items:[{active:true,layer:0,gutter:0,tile:{key:'whole',serial:1,gpuTile:1,x:0,y:0,width:20,height:20,zoom:2}}]}
 return{doc,scene,frame,input,n}
}
test('only complete matching native integer poses can become a committed viewport',()=>{
 const {doc,scene,frame,input}=fixture()
 expect(canCommitResidentFrame(scene,doc,doc,frame,input)).toBe(true)
 expect(canCommitResidentFrame({...scene,interactionLocalFootprint:true},doc,doc,frame,input)).toBe(false)
 expect(canCommitResidentFrame({...scene,gestureSoftEffects:true},doc,doc,frame,input)).toBe(false)
 expect(canCommitResidentFrame(scene,doc,{...doc,name:'changed'},frame,input)).toBe(false)
 expect(canCommitResidentFrame(scene,doc,doc,frame,{...input,sequence:6})).toBe(false)
 expect(canCommitResidentFrame(scene,doc,doc,{...frame,interaction:false},input)).toBe(false)
 const half={...frame,items:frame.items.map(item=>({...item,tile:{...item.tile,zoom:1}}))}
 expect(canCommitResidentFrame(scene,doc,doc,half,input)).toBe(false)
 const hole={...frame,items:frame.items.map(item=>({...item,clip:{left:0,top:0,width:5,height:10}}))}
 expect(canCommitResidentFrame(scene,doc,doc,hole,input)).toBe(false)
})
test('fractional masks and preview-only blur changes keep normal refinement',()=>{
 const {doc,scene,frame,input,n}=fixture()
 scene.nodes[n.id].matrix[4]=2.25
 expect(canCommitResidentFrame(scene,doc,doc,frame,input)).toBe(false)
 scene.nodes[n.id].matrix[4]=2
 const blur=effect('blur');blur.radius=.2;n.effects=[blur]
 scene.nodes[n.id].effects=[{...blur,radius:0}]
 expect(canCommitResidentFrame(scene,doc,doc,frame,input)).toBe(false)
})
