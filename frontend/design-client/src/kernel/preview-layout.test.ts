import { expect, test } from 'vitest'
import { Editor } from '../engine'
import { blank, node, defaultLayout, defaultSizing } from '../model'
import { kernelLayout } from './picking'
import { PreviewLayout } from './preview-layout'

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
test('unsupported topology and external dependencies cannot use an island proof',()=>{
 const f=fixture();const editor=new Editor(f.doc)
 try{const plan=new PreviewLayout(editor.state.doc);expect(plan.prepare({[f.root.id]:{children:[]}})).toBeUndefined()
  const before=editor.state.doc;editor.begin('Resize');expect(editor.preview({[f.root.id]:{width:240}})).toBe(true);editor.cancel();expect(editor.state.doc).toBe(before)
 }finally{editor.dispose()}
 const linked=fixture();linked.child.textPath={pathId:linked.staticRoot.id} as any
 expect(new PreviewLayout(linked.doc).prepare({[linked.root.id]:{width:300}})).toBeUndefined()
})
