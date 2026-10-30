import { afterEach, expect, test } from 'vitest'
import { blank, node, defaultLayout } from './model'
import { Editor } from './engine'
import { allParents, apply, multiply, translate, worldMatrix } from './geometry'
import { canvasDropFrame, createCanvasDropIndex } from './canvas-drop'
const editors:Editor[]=[]
afterEach(()=>editors.splice(0).forEach(e=>e.dispose()))
function fixture() {
 const d=blank(),a=node('frame',0,0,200,200),b=node('frame',350,0,200,200),n=node('rectangle',20.125,30.375,30,20)
 a.children=[n.id];d.nodes=Object.fromEntries([a,b,n].map(n=>[n.id,n]));d.pages[0].children=[a.id,b.id]
 const e=new Editor(d);editors.push(e);e.select([n.id]);return {e,a,b,n}
}
test('dropping into an affine frame preserves world geometry and is one undo with the move',()=>{
 const {e,a,b,n}=fixture();e.update([b.id],{transform:[1,.125,-.25,1,350,0]});const before=e.state.doc
 e.begin('Drag');e.preview({[n.id]:{transform:multiply(translate(360,40),n.transform)}})
 const world=worldMatrix(e.state.doc,n.id),point=apply(world,{x:15,y:10})
 expect(canvasDropFrame(e.state.doc,e.state.page,[n.id],point)).toBe(b.id)
 e.finishCanvasMove(point);e.commit();expect(allParents(e.state.doc).get(n.id)).toBe(b.id)
 worldMatrix(e.state.doc,n.id).forEach((v,i)=>expect(v).toBeCloseTo(world[i],11))
 e.undo();expect(e.state.doc).toEqual(before);expect(e.state.doc.nodes[a.id].children).toEqual([n.id])
})
test('a locked ancestor, an instance, a descendant and a clipped-out frame cannot receive the drop',()=>{
 const {e,a,b,n}=fixture();e.update([b.id],{locked:true});expect(canvasDropFrame(e.state.doc,e.state.page,[n.id],{x:380,y:40})).toBeUndefined()
 expect(canvasDropFrame(e.state.doc,e.state.page,[a.id],{x:40,y:40})).toBeUndefined()
 const hidden=node('frame',300,0,80,80);e.change('Clipped frame',d=>{d.nodes[hidden.id]=hidden;d.nodes[a.id].children.push(hidden.id)})
 expect(canvasDropFrame(e.state.doc,e.state.page,[n.id],{x:310,y:30})).toBeUndefined()
 e.update([b.id],{locked:false});e.select([b.id]);e.createComponent();e.duplicate();const instance=e.state.selection[0]
 e.update([instance],{transform:[1,0,0,1,700,0]});expect(canvasDropFrame(e.state.doc,e.state.page,[n.id],{x:730,y:40})).toBeUndefined()
})
test('dragging out of auto layout restores authored sizing and keeps the final world point',()=>{
 const {e,a,n}=fixture();e.update([a.id],{layout:{...defaultLayout(),mode:'horizontal'}});const before=e.state.doc
 e.begin('Drag out');e.previewFreeMove([n.id],true);expect(e.state.doc.nodes[n.id].sizing?.absolute).toBe(true)
 e.preview({[n.id]:{transform:[1,0,0,1,240.125,280.375]}})
 const world=worldMatrix(e.state.doc,n.id);e.finishCanvasMove({x:250,y:290});e.commit()
 expect(allParents(e.state.doc).get(n.id)).toBe(e.state.page);expect(worldMatrix(e.state.doc,n.id)).toEqual(world)
 expect(e.state.doc.nodes[n.id].sizing).toEqual(before.nodes[n.id].sizing)
 e.undo();expect(e.state.doc).toEqual(before)
})

test('a held drag reparents only its visible draft; every sample uses the original basis and cancel restores clipping',()=>{
 const {e,a,b,n}=fixture(),before=e.state.doc
 e.begin('Held drag');e.preview({[n.id]:{transform:[1,0,0,1,380.125,40.375]}})
 e.previewMoveParent([n.id],{x:395,y:50});expect(allParents(e.state.doc).get(n.id)).toBe(b.id)
 const world=worldMatrix(e.state.doc,n.id)
 e.preview({[n.id]:{transform:[1,0,0,1,380.125,40.375]}});e.previewMoveParent([n.id],{x:395,y:50})
 expect(worldMatrix(e.state.doc,n.id)).toEqual(world);expect(e.state.version).toBe(0)
 e.cancel();expect(e.state.doc).toBe(before);expect(e.state.doc.nodes[a.id].clip).toBe(true)
})

test('gesture index uses current frame geometry and visibility rather than cached pixels',()=>{
 const {e,b,n}=fixture(),index=createCanvasDropIndex(e.state.doc,e.state.page)
 e.update([b.id],{transform:[1,0,0,1,700.125,0]})
 expect(canvasDropFrame(e.state.doc,e.state.page,[n.id],{x:730,y:40},false,index)).toBe(b.id)
 expect(canvasDropFrame(e.state.doc,e.state.page,[n.id],{x:380,y:40},false,index)).toBeUndefined()
 e.update([b.id],{visible:false});expect(canvasDropFrame(e.state.doc,e.state.page,[n.id],{x:730,y:40},false,index)).toBeUndefined()
})
