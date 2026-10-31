import { afterEach, expect, test } from 'vitest'
import { createShapeSeed, resolveShapeCreation } from './shape-creation'
import { blank, validateDocument } from './model'
import { Editor } from './engine'
import { kernelHit, kernelStrokePaths } from './kernel/picking'
const editors:Editor[]=[]
afterEach(()=>editors.splice(0).forEach(e=>e.dispose()))
test('Shift-constrained arrow uses a native line and editable stroke endpoints',()=>{
 const seed=createShapeSeed('arrow'),result=resolveShapeCreation(seed,{anchor:{x:10.125,y:15.375},pointer:{x:89,y:46},screenDistance:80,shift:true})
 expect(result.node.kind).toBe('line');expect(result.node.strokes[0].endMarker).toBe('arrow')
 expect(result.start.x).toBe(10.125);expect(result.node.network!.edges).toHaveLength(1)
 expect(result.node.network!.edges[0].id).toBe(seed.id+':edge')
})
test('native marker survives save, duplicate, undo and a later schema 7 geometry edit',()=>{
 const doc=blank(),n=resolveShapeCreation(createShapeSeed('arrow'),{anchor:{x:20,y:20},pointer:{x:120,y:20},screenDistance:100}).node
 doc.schemaVersion=8;doc.nodes={[n.id]:n};doc.pages[0].children=[n.id];const e=new Editor(doc);editors.push(e);e.select([n.id]);e.duplicate()
 expect(e.state.doc.nodes[e.state.selection[0]].strokes[0].endMarker).toBe('arrow')
 e.update([n.id],{constrainProportions:true});expect(e.state.doc.schemaVersion).toBe(8)
 expect(validateDocument(JSON.parse(JSON.stringify(e.state.doc)))).toEqual(e.state.doc)
 e.undo();expect(e.state.doc.nodes[n.id].constrainProportions).toBeUndefined()
})
test('marker outline and hit geometry include the end triangle wing',()=>{
 const n=resolveShapeCreation(createShapeSeed('arrow'),{anchor:{x:0,y:0},pointer:{x:60,y:0},screenDistance:60}).node
 n.strokes[0].width=4;n.strokes[0].endMarker='triangle'
 expect(kernelHit(n,{x:50,y:4},0)).toBe(true)
 expect(kernelHit(n,{x:64,y:0},0)).toBe(false)
 expect(kernelStrokePaths(n)[0]).toContain('50')
 const doc=blank();doc.nodes={[n.id]:n};doc.pages[0].children=[n.id];doc.schemaVersion=7
 expect(()=>validateDocument(doc)).toThrow('版本 8')
})
