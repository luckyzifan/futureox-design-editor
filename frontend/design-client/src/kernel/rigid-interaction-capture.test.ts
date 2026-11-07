import { expect, test } from 'vitest'
import { blank, node, effect, type Matrix } from '../model'
import { scene, multiply, inverse, apply, boxPoints } from '../geometry'
import { buildInteractionDependencyScope } from './interaction-scene-bounds'
import { rigidInteractionCapture } from './rigid-interaction-capture'
function fixture(){
 const document=blank(),root=node('frame',0,0,1600,1200),selected=node('rectangle',300,200,60,40)
 root.blend='normal';root.children=[selected.id];document.nodes={[root.id]:root,[selected.id]:selected};document.pages[0].children=[root.id]
 const plan={document,pageId:document.pages[0].id,ids:[selected.id],layers:[]}
 const scope=buildInteractionDependencyScope(document,plan.pageId,scene(document,plan.pageId),plan.ids,{zoom:1,dpr:2,allowFixedBackdrop:false})
 return{document,root,selected,plan,scope}
}
test('rigid capture encloses old and rotated support while avoiding a full viewport',()=>{
 const f=fixture(),c=Math.cos(.7),s=Math.sin(.7),pose:Matrix=[c,s,-s,c,350,240]
 const current={...f.document,nodes:{...f.document.nodes,[f.selected.id]:{...f.selected,transform:pose}}}
 const b=rigidInteractionCapture(f.plan,current,f.scope.rootBounds,f.scope.localizedBounds,f.scope.fixedBounds,f.scope.parentMatrices,2)!
 expect(b.width*b.height).toBeLessThan(1600*1200/20)
 const source=f.scope.rootBounds.get(f.selected.id)!,delta=multiply(pose,inverse(f.selected.transform))
 for(const point of [...boxPoints(source),...boxPoints(source).map(p=>apply(delta,p))]){
  expect(point.x).toBeGreaterThanOrEqual(b.x);expect(point.y).toBeGreaterThanOrEqual(b.y)
  expect(point.x).toBeLessThanOrEqual(b.x+b.width);expect(point.y).toBeLessThanOrEqual(b.y+b.height)
 }
})
test('guarded rotation excludes both old/new support, including touching and invalid backdrop envelopes',()=>{
 const f=fixture(),pose:Matrix=[0,1,-1,0,380,260]
 const current={...f.document,nodes:{...f.document.nodes,[f.selected.id]:{...f.selected,transform:pose}}}
 const capture=(exclusions:import('../model').Bounds[])=>rigidInteractionCapture(f.plan,current,
  f.scope.rootBounds,f.scope.localizedBounds,f.scope.fixedBounds,f.scope.parentMatrices,2,exclusions)
 const far={x:900,y:800,width:100,height:100},local=capture([far])!
 expect(local).toBeDefined()
 expect(capture([{x:300,y:200,width:1,height:1}])).toBeUndefined()
 expect(capture([{x:370,y:270,width:1,height:1}])).toBeUndefined()
 expect(capture([{x:local.x+local.width,y:local.y,width:1,height:1}])).toBeUndefined()
 expect(capture([{...far,x:NaN}])).toBeUndefined()
 expect(capture([{...far,width:-1}])).toBeUndefined()
})
test.each(['scale','shear','missing','fixed','nested-effect','radial'])('unsupported %s retains the full native capture',kind=>{
 const f=fixture();let pose:Matrix=[0,1,-1,0,300,200]
 if(kind==='scale')pose=[0,2,-2,0,300,200]
 if(kind==='shear')pose=[1,.5,0,1,300,200]
 if(kind==='fixed')f.scope.fixedBounds.add(f.selected.id)
 if(kind==='radial')f.selected.effects=[effect('zoom-blur')]
 if(kind==='nested-effect'){const child=node('rectangle',0,0,10,10);child.effects=[effect('blur')];f.document.nodes[child.id]=child;f.selected.children=[child.id]}
 const current={...f.document,nodes:{...f.document.nodes,[f.selected.id]:{...f.selected,transform:pose}}}
 if(kind==='missing')delete current.nodes[f.selected.id]
 expect(rigidInteractionCapture(f.plan,current,f.scope.rootBounds,f.scope.localizedBounds,f.scope.fixedBounds,f.scope.parentMatrices,2)).toBeUndefined()
})
