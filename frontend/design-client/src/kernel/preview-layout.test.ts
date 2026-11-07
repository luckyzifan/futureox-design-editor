import { expect, test, vi } from 'vitest'
import { Editor } from '../engine'
import { blank, node, defaultLayout, defaultSizing } from '../model'
import { kernelLayout } from './picking'
import { PreviewLayout } from './preview-layout'
import { interactionTransformsOnly } from './interaction-layers'
import { documentPatch } from '../document-patch'
import { VectorEngine } from '../generated/design-kernel/design_kernel'

function fixture() {
 const doc=blank(),root=node('frame',12,10,200,150),child=node('rectangle',10,20,40,30),staticRoot=node('frame',300,0,100,100)
 root.children=[child.id];child.constraints={horizontal:'scale',vertical:'stretch',referenceWidth:200,referenceHeight:150}
 doc.nodes=Object.fromEntries([root,child,staticRoot].map(n=>[n.id,n]));doc.pages[0].children=[root.id,staticRoot.id]
 return {doc,root,child,staticRoot}
}
test.each([false,true])('resize islands preserve full Rust layout, constraints, history and unrelated identity: flow=%s',flow=>{
 const f=fixture();if(flow){f.root.layout={...defaultLayout(),mode:'vertical'};f.child.sizing={...defaultSizing(),width:'fill'}}
 const editor=new Editor(f.doc)
 try{
  const before=editor.state.doc;editor.select([f.root.id]);editor.begin('Resize')
  for(const width of [240,280,180]){
   expect(editor.preview({[f.root.id]:{width,height:170}})).toBe(true)
   const candidate={...before,nodes:{...before.nodes,[f.root.id]:{...before.nodes[f.root.id],width,height:170}}}
   expect(editor.state.doc).toEqual(kernelLayout(candidate))
   expect(editor.state.doc.nodes[f.staticRoot.id]).toBe(before.nodes[f.staticRoot.id])
  }
  const final=editor.state.doc;editor.commit();editor.undo();expect(editor.state.doc).toEqual(before);editor.redo();expect(editor.state.doc).toEqual(final)
 }finally{editor.dispose()}
})

test('dimension-changing islands use the acknowledged native delta and match full resolution after undo and other islands',()=>{
 const f=fixture(),shape=node('vector',80,20,40,40),a=node('rectangle',0,0,20,20),b=node('rectangle',10,10,20,20)
 f.doc.schemaVersion=4;shape.booleanOperation='union';shape.children=[a.id,b.id];f.root.children.push(shape.id)
 for(const n of [shape,a,b])f.doc.nodes[n.id]=n
 const editor=new Editor(f.doc),full=vi.spyOn(VectorEngine.prototype,'resolve_components_full'),patch=vi.spyOn(VectorEngine.prototype,'resolve_components_patch'),pose=vi.spyOn(VectorEngine.prototype,'resolve_components_pose_patch')
 try{
  const before=editor.state.doc;editor.select([f.child.id])
  for(const transform of [[0,1,-1,0,20,30],[.8,.6,-.6,.8,15,20]] as typeof a.transform[]){
   editor.begin('Rotate');full.mockClear();patch.mockClear();pose.mockClear()
   const width=before.nodes[f.child.id].width+5
   expect(editor.preview({[f.child.id]:{transform,width}})).toBe(true)
   expect(full).not.toHaveBeenCalled();expect(patch.mock.calls.length+pose.mock.calls.length).toBeGreaterThan(0)
   const after=editor.state.doc,calls=patch.mock.calls.length?patch.mock.calls:pose.mock.calls
   const wire=JSON.parse(calls.at(-1)![0])
   expect(Object.keys(wire.nodes).length).toBeLessThanOrEqual(3)
   const oracle=kernelLayout({...before,nodes:{...before.nodes,[f.child.id]:{...before.nodes[f.child.id],transform,width}}})
   expect(after).toEqual(oracle)
   editor.commit();editor.undo();expect(editor.state.doc).toEqual(before)
   // A different resolved island may now own the native receipt. The next
   // preview must diff that complete snapshot, not trust a document ID alone.
   kernelLayout({...before,pages:before.pages.map(p=>({...p,children:[f.staticRoot.id]})),nodes:{[f.staticRoot.id]:before.nodes[f.staticRoot.id]}})
  }
 }finally{full.mockRestore();patch.mockRestore();pose.mockRestore();editor.dispose()}
})

test('a whole-page resize island does not invalidate native global state with unchanged page fields',()=>{
 const f=fixture(),shape=node('vector',80,20,40,40),a=node('rectangle',0,0,20,20)
 f.doc.schemaVersion=4;shape.booleanOperation='union';shape.children=[a.id];f.root.children.push(shape.id)
 delete f.doc.nodes[f.staticRoot.id];f.doc.pages[0].children=[f.root.id]
 for(const n of [shape,a])f.doc.nodes[n.id]=n
 const editor=new Editor(f.doc),patch=vi.spyOn(VectorEngine.prototype,'resolve_components_patch')
 try{
  editor.select([f.child.id]);editor.begin('Rotate');patch.mockClear()
  expect(editor.preview({[f.child.id]:{transform:[0,1,-1,0,20,30],width:45}})).toBe(true)
  expect(patch).toHaveBeenCalledOnce()
  const wire=JSON.parse(patch.mock.calls[0][0])
  expect(wire.fields).toEqual({});expect(Object.keys(wire.nodes)).toEqual([f.child.id])
 }finally{patch.mockRestore();editor.dispose()}
})
test('unsupported topology and external dependencies cannot use an island proof',()=>{
 const f=fixture();const editor=new Editor(f.doc)
 try{const plan=new PreviewLayout(editor.state.doc);expect(plan.prepare({[f.root.id]:{children:[]}})).toBeUndefined()
  const before=editor.state.doc;editor.begin('Resize');expect(editor.preview({[f.root.id]:{width:240}})).toBe(true);editor.cancel();expect(editor.state.doc).toBe(before)
 }finally{editor.dispose()}
 const linked=fixture();linked.child.textPath={pathId:linked.staticRoot.id} as any
 expect(new PreviewLayout(linked.doc).prepare({[linked.root.id]:{width:300}})).toBeUndefined()
})

test.each([false,true])('an imported null optional survives affine layout and exact history: components=%s',components=>{
 const f=fixture(),group=node('group',20,30,50,50),leaf=node('rectangle',0,0,50,50)
 f.doc.schemaVersion=4
 group.children=[leaf.id];group.fills=[];Object.assign(group,{network:null})
 f.root.children.push(group.id);f.doc.nodes[group.id]=group;f.doc.nodes[leaf.id]=leaf
 if(components){
  const boolean=node('vector',80,20,40,40),a=node('rectangle',0,0,20,20),b=node('rectangle',10,10,20,20)
  boolean.booleanOperation='union';boolean.children=[a.id,b.id];f.root.children.push(boolean.id)
  for(const n of [boolean,a,b])f.doc.nodes[n.id]=n
 }
 const editor=new Editor(f.doc)
 try{
  const before=editor.state.doc,plan={document:before,pageId:before.pages[0].id,ids:[group.id],layers:[]}
  expect(before.nodes[group.id].network).toBeNull()
  editor.select([group.id]);editor.begin('Rotate')
  expect(editor.preview({[group.id]:{transform:[0,1,-1,0,60,25]}})).toBe(true)
  const after=editor.state.doc
  expect(after.nodes[group.id].network).toBeNull()
  expect(documentPatch(before,after).nodes).toEqual({[group.id]:after.nodes[group.id]})
  expect(interactionTransformsOnly(plan,after)).toBe(true)
  editor.commit();expect(interactionTransformsOnly(plan,editor.state.doc)).toBe(true)
  editor.undo();expect(editor.state.doc).toEqual(before)
  editor.redo();expect(editor.state.doc).toEqual(after)
 }finally{editor.dispose()}
})
