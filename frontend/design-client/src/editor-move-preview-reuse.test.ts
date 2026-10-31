import {expect,test,vi} from 'vitest'
import {Editor} from './engine'
import {blank,node} from './model'
import {allParents,worldMatrix,multiply,inverse,apply} from './geometry'
import {VectorEngine} from './generated/design-kernel/design_kernel'

function fixture(affine=false){
 const d=blank(),board=node('frame',0,0,600,400),frame=node('frame',20,30,90,20),child=node('rectangle',23,0,67,20),master=node('frame',900,0,80,40)
 if(affine)board.transform=[.9,.1,-.2,1.1,5.125,-3.375]
 board.clip=true;frame.clip=true;child.constraints={horizontal:'scale',vertical:'center',referenceWidth:90,referenceHeight:20}
 frame.children=[child.id];board.children=[frame.id];master.component={variants:{},properties:{}}
 d.schemaVersion=16;d.nodes=Object.fromEntries([board,frame,child,master].map(n=>[n.id,n]));d.pages[0].children=[board.id,master.id]
 return {d,board,frame,child}
}

test.each([false,true])('same-parent placement reuses its resolved base and matches the uncached native path (affine=%s)',affine=>{
 const f=fixture(affine),a=new Editor(f.d),b=new Editor(f.d),id=f.child.id
 const calls=vi.spyOn(VectorEngine.prototype,'resolve_components_patch')
 try{
  for(const e of [a,b]){e.select([id]);e.begin('Move')}
  const original=a.state.doc,parents=allParents(original),parent=worldMatrix(original,f.frame.id,parents),start=worldMatrix(original,id,parents)
  let settled=false,afterFirst=0
  for(const [dx,dy] of [[0,22],[3,24],[8,29],[15,31],[4,0],[1,25],[8,28]]){
   const world=multiply([1,0,0,1,dx,dy],start),transform=multiply(inverse(parent),world)
   const point=apply(world,{x:33.5,y:10}),move={ids:[id],point,force:false,preserveParent:false},patch={[id]:{transform}}
   const converted=a.canvasMovePreview(patch,move)
   expect(a.preview(patch,move)).toBe(true)
   const aCalls=calls.mock.calls.length
   if(settled&&dy>20&&dx!==1)expect(aCalls).toBe(afterFirst)
   // Independent oracle: force the old complete placement/layout route.
   delete (b as any).transaction.movePreview
   expect(b.preview(patch,move)).toBe(true)
   expect(a.state.doc).toEqual(b.state.doc)
   if(settled&&dy>20&&dx!==1)expect(converted.retainsParents).toBe(true)
   afterFirst=calls.mock.calls.length;settled=dy>20
  }
  a.commit();b.commit();expect(a.state.doc).toEqual(b.state.doc)
  const final=a.state.doc;a.undo();expect(a.state.doc).toEqual(original);a.redo();expect(a.state.doc).toEqual(final)
 }finally{calls.mockRestore();a.dispose();b.dispose()}
})

test('instance-owned children cannot request a reparent fallback that will not happen',()=>{
 const f=fixture(),instance=node('frame',700,200,90,20)
 f.frame.component={variants:{},properties:{}}
 instance.instance={componentId:f.frame.id,overrides:{},propertyValues:{}}
 f.d.nodes[instance.id]=instance;f.d.pages[0].children.push(instance.id)
 const editor=new Editor(f.d)
 try{
  const child=Object.values(editor.state.doc.nodes).find(n=>n.instanceOrigin?.owner===instance.id&&n.instanceOrigin.source===f.child.id)!
  expect(child).toBeDefined();editor.select([child.id]);editor.begin('Move')
  expect(editor.canvasMovePreservesParents([child.id],{x:300,y:200})).toBe(true)
 }finally{editor.dispose()}
})

test('undo followed by another ordinary reparent uses a complete resident delta',()=>{
 const f=fixture(),e=new Editor(f.d),full=vi.spyOn(VectorEngine.prototype,'resolve_components_full')
 try{
  e.select([f.child.id]);const original=e.state.doc
  const move={ids:[f.child.id],point:{x:100,y:90},force:false,preserveParent:false}
  e.begin('First move');e.preview({[f.child.id]:{transform:[1,0,0,1,40,50]}},move);e.commit();e.undo()
  expect(e.state.doc).toEqual(original);full.mockClear()
  e.begin('Second move');expect(e.preview({[f.child.id]:{transform:[1,0,0,1,45,55]}},move)).toBe(true)
  expect(full).not.toHaveBeenCalled();e.cancel();expect(e.state.doc).toEqual(original)
 }finally{full.mockRestore();e.dispose()}
})
