import { afterEach, expect, test } from 'vitest'
import { Editor } from './engine'
import { blank, node, validateDocument } from './model'
import { pose } from './animation'
import { kernelSvgPaths, kernelBounds } from './kernel/picking'
import { resizeNodeDimension } from './selection-properties'
import { setNodeVariableMode } from './design-system'
import { editableNetwork } from './editable-network'
const editors:Editor[]=[]
afterEach(()=>editors.splice(0).forEach(e=>e.dispose()))
function fixture(kind:'ellipse'|'polygon'|'star'='ellipse') {
 const doc=blank(),n=node(kind,10.125,20.375,100.25,60.5);doc.nodes={[n.id]:n};doc.pages[0].children=[n.id]
 const editor=new Editor(doc);editors.push(editor);editor.select([n.id]);return {editor,n}
}
test('arc preview promotes native schema atomically; cancel restores old document, commit and undo preserve parameters',()=>{
 const {editor,n}=fixture(),before=editor.state.doc,arc={startAngle:.123456789,sweepAngle:Math.PI*1.5,innerRadius:.625}
 editor.begin('Arc');editor.preview({[n.id]:{arc}})
 expect(editor.state.doc.schemaVersion).toBe(7);expect(editor.state.doc.nodes[n.id].arc).toEqual(arc)
 editor.cancel();expect(editor.state.doc).toBe(before)
 editor.begin('Arc');editor.preview({[n.id]:{arc}});editor.commit()
 expect(validateDocument(JSON.parse(JSON.stringify(editor.state.doc)))).toEqual(editor.state.doc)
 editor.undo();expect(editor.state.doc).toEqual(before);editor.redo();expect(editor.state.doc.nodes[n.id].arc).toEqual(arc)
})
test('rounded polygon remains native through duplication, animation poses and SVG output',()=>{
 const {editor,n}=fixture('polygon');editor.update([n.id],{cornerRadius:7.125,constrainProportions:true});editor.duplicate()
 const copied=editor.state.doc.nodes[editor.state.selection[0]]
 expect(copied.cornerRadius).toBe(7.125);expect(copied.constrainProportions).toBe(true)
 expect(pose(copied).cornerRadius).toBe(7.125)
 expect(kernelSvgPaths(copied)!.fill).toContain('A')
 const draft=editableNetwork(copied);expect(draft.edges.some(e=>e.c1)).toBe(true)
 expect(editor.state.doc.nodes[copied.id].network).toBeUndefined()
})
test('arc geometry cache changes bounds and editable outline keeps the hole',()=>{
 const {editor,n}=fixture();editor.update([n.id],{arc:{startAngle:0,sweepAngle:Math.PI/2,innerRadius:.5}})
 const changed=editor.state.doc.nodes[n.id],box=kernelBounds(changed)!
 expect(box.x).toBeCloseTo(n.width/2,12);expect(box.y).toBe(n.height/2)
 expect(kernelSvgPaths(changed)!.fill.match(/A/g)?.length).toBe(2)
 expect(editableNetwork(changed)).toEqual(editableNetwork(changed))
 editor.update([n.id],{arc:{startAngle:0,sweepAngle:Math.PI*2,innerRadius:.5}})
 const ring=editor.state.doc.nodes[n.id];expect(kernelBounds(ring)!.width).toBe(n.width)
 expect(pose(ring).arc).toEqual(ring.arc)
})
test('aspect lock changes both dimensions in the same affine basis and remains optional',()=>{
 const {n}=fixture();n.constrainProportions=true;n.transform=[2,.5,.25,3,10.125,20.375]
 const before={w:n.width,h:n.height};resizeNodeDimension(n,'width',n.width*Math.hypot(2,.5)*2)
 expect(n.width).toBe(before.w*2);expect(n.height).toBe(before.h*2)
 n.constrainProportions=false;const height=n.height;resizeNodeDimension(n,'width',200);expect(n.height).toBe(height)
})
test('variable modes never downgrade schema 7 authored geometry',()=>{
 const {editor,n}=fixture();editor.update([n.id],{arc:{startAngle:0,sweepAngle:Math.PI,innerRadius:0}})
 editor.change('Mode',d=>{d.designSystem={collections:{c:{name:'C',modes:['default'],defaultMode:'default'}},variables:{},styles:{},activeModes:{},libraries:{}};setNodeVariableMode(d,n.id,'c','default')})
 expect(editor.state.doc.schemaVersion).toBe(7);expect(editor.state.doc.nodes[n.id].variableModes).toEqual({c:'default'})
})
test('invalid schema and shape parameters are rejected before native file admission',()=>{
 const {editor,n}=fixture();const d=structuredClone(editor.state.doc);d.nodes[n.id].arc={startAngle:0,sweepAngle:Math.PI,innerRadius:.5}
 expect(()=>validateDocument(d)).toThrow();d.schemaVersion=7;expect(()=>validateDocument(d)).not.toThrow()
 d.nodes[n.id].arc!.innerRadius=1.01;expect(()=>validateDocument(d)).toThrow()
})
