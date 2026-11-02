import { afterEach, expect, test } from 'vitest'
import { Editor } from './engine'
import { blank, node, defaultSizing, defaultLayout } from './model'
import { allParents, worldMatrix } from './geometry'
const editors:Editor[]=[]
afterEach(()=>editors.splice(0).forEach(e=>e.dispose()))
function fixture() {
 const d=blank(),a=node('frame',100.125,50.375,300,300),b=node('frame',500,50,100,100),c=node('frame',700,50,300,300),n=node('rectangle',30.125,180.375,40.25,20.5)
 a.children=[n.id];d.nodes=Object.fromEntries([a,b,c,n].map(n=>[n.id,n]));d.pages[0].children=[a.id,b.id,c.id]
 const e=new Editor(d);editors.push(e);return {e,a,b,c,n}
}
test('OS clipboard paste into a frame keeps the source parent position plus 10',()=>{
 const {e,b,n}=fixture();e.select([n.id]);const packet=e.exportClipboard()!;e.importClipboard(packet);e.select([b.id]);const before=e.state.doc
 e.pasteToSelection();const pasted=e.state.doc.nodes[e.state.selection[0]]
 expect(allParents(e.state.doc).get(pasted.id)).toBe(b.id);expect(pasted.transform[4]).toBeCloseTo(40.125,8);expect(pasted.transform[5]).toBeCloseTo(190.375,8)
 e.undo();expect(e.state.doc).toEqual(before)
})
test('multiple selected frames get independent graphs in a single history action',()=>{
 const {e,b,c,n}=fixture();e.select([n.id]);e.copy();e.select([b.id,c.id]);const before=e.state.doc
 e.pasteToSelection();expect(e.state.selection).toHaveLength(2)
 expect(e.state.doc.nodes[b.id].children).toHaveLength(1);expect(e.state.doc.nodes[c.id].children).toHaveLength(1)
 const ids=e.state.selection;expect(ids[0]).not.toBe(ids[1]);expect(e.state.doc.nodes[ids[1]].transform[5]).toBeCloseTo(190.375,8)
 e.undo();expect(e.state.doc).toEqual(before)
})
test('paste replace adopts constraints, sizing and layer order and undoes atomically',()=>{
 const {e,b,n}=fixture(),target=node('rectangle',10.375,20.125,80,60)
 target.constraints={horizontal:'end',vertical:'end',referenceWidth:100,referenceHeight:100};target.sizing={...defaultSizing(),absolute:true}
 e.change('Target',d=>{d.nodes[target.id]=target;d.nodes[b.id].children.push(target.id)})
 e.select([n.id]);e.copy();e.select([target.id]);const before=e.state.doc;e.pasteToSelection(true)
 const copied=e.state.doc.nodes[e.state.selection[0]];expect(e.state.doc.nodes[target.id]).toBeUndefined();expect(copied.constraints).toEqual(target.constraints)
 expect(copied.sizing).toEqual(target.sizing);expect(copied.transform[4]).toBe(10.375);expect(copied.transform[5]).toBe(20.125);expect(copied.width).toBe(n.width)
 expect(e.state.doc.nodes[b.id].children).toEqual([copied.id]);e.undo();expect(e.state.doc).toEqual(before)
})
test('original out-of-frame coordinates survive clipboard roundtrip into a clipped frame',()=>{
 const {e,b,n}=fixture();e.update([n.id],{transform:[1,0,0,1,-20.125,-10.375]});e.select([n.id]);e.importClipboard(e.exportClipboard()!);e.select([b.id]);e.pasteToSelection()
 expect(e.state.doc.nodes[e.state.selection[0]].transform[4]).toBeCloseTo(-10.125,8)
 expect(e.state.doc.nodes[e.state.selection[0]].transform[5]).toBeCloseTo(-0.375,8)
})
test('invalid clipboard placement is rejected before replacing existing clipboard or document',()=>{
 const {e,n}=fixture();e.select([n.id]);const packet=JSON.parse(e.exportClipboard()!);packet.placements[n.id].transform=[1,0,0,0,0,0]
 const before=e.state.doc;expect(()=>e.importClipboard(JSON.stringify(packet))).toThrow();expect(e.state.doc).toBe(before)
})
