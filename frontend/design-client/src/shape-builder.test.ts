import { afterEach, expect, test } from 'vitest'
import { Editor } from './engine'
import { blank, node, type DesignDocument } from './model'
import { applyShapeBuilder, previewShapeBuilder } from './shape-builder'
import { createEditorDesignAutomation } from './automation'
import { encodeDocumentBinary, decodeDocumentBinary } from './kernel/binfmt'
const editors: Editor[]=[]
afterEach(()=>editors.splice(0).forEach(e=>e.dispose()))
function fixture() {
  const d=blank('Shape Builder'), a=node('rectangle',0,0,100,100), b=node('rectangle',50,0,100,100)
  d.nodes[a.id]=a; d.nodes[b.id]=b; d.pages[0].children=[a.id,b.id]
  const editor=new Editor(d);editors.push(editor);editor.select([a.id,b.id]);return {editor,a,b}
}
test('connected overlap regions are genuine independently selectable curve networks',()=>{
  const {editor,a,b}=fixture(), p=previewShapeBuilder(editor.state.doc,[a.id,b.id])
  expect(p.regions.map(r=>r.id)).toEqual(['1:0','2:0','3:0'])
  expect(p.regions.every(r=>r.network.edges.length>0)).toBe(true)
})
test('region gesture is one undo, redo and FD save/reopen retains authored vectors',()=>{
  const {editor,a,b}=fixture(), before=editor.state.doc, p=previewShapeBuilder(before,[a.id,b.id]), ids:string[]=[]
  const result=editor.change('Shape Builder',draft=>{ids.push(...applyShapeBuilder(draft,p,['1:0','3:0'],'merge'))},ids)
  expect(result.status).toBe('committed');expect(ids).toHaveLength(2)
  const after=editor.state.doc
  expect(after.nodes[a.id]).toBeUndefined();expect(after.nodes[b.id]).toBeUndefined()
  expect(after.pages[0].children).toEqual(ids);expect(editor.state.selection).toEqual(ids)
  const reopened=decodeDocumentBinary(encodeDocumentBinary(after)) as DesignDocument
  for(const id of ids)expect(reopened.nodes[id].network).toEqual(after.nodes[id].network)
  editor.undo();expect(editor.state.doc).toBe(before);expect(editor.canUndo).toBe(false)
  editor.redo();expect(editor.state.doc).toBe(after)
})
test('typed MCP batch uses identical region operation and rolls back a later failure',()=>{
  const {editor,a,b}=fixture(), api=createEditorDesignAutomation(editor)
  const preview=api.execute({method:'vector.shapeBuilder.preview',params:{ids:[a.id,b.id]}})
  expect(preview.ok).toBe(true);if(!preview.ok)throw Error(preview.error.message)
  const {fingerprint}=preview.result as {fingerprint:string}
  const action={method:'vector.shapeBuilder.apply',params:{ids:[a.id,b.id],regionIds:['3:0'],mode:'erase',fingerprint}}
  const call=(operations:unknown[])=>api.execute({method:'batch.apply',params:{operations},documentId:editor.state.doc.id,session:editor.sessionGeneration,expectedRevision:editor.state.version})
  const before=editor.state.doc
  expect(call([action,{method:'node.move',params:{ids:['missing'],parentId:'missing'}}]).ok).toBe(false)
  expect(editor.state.doc).toBe(before);expect(editor.canUndo).toBe(false)
  const result=call([action]);expect(result.ok,JSON.stringify(result)).toBe(true)
  expect(editor.state.doc.pages[0].children).toHaveLength(2)
  editor.undo();expect(editor.state.doc).toBe(before)
})
test('locked ancestors, masks, strokes and stale previews preserve originals',()=>{
  const {editor,a,b}=fixture(), before=editor.state.doc,p=previewShapeBuilder(before,[a.id,b.id])
  const stale=structuredClone(before);stale.nodes[a.id].width++
  expect(()=>applyShapeBuilder(stale,p,['3:0'],'erase')).toThrow(/过期/)
  for(const patch of [{locked:true},{mask:true},{strokes:[{...a.strokes[0],visible:true,width:2}]}]) {
    const d=structuredClone(before);Object.assign(d.nodes[a.id],patch)
    expect(()=>previewShapeBuilder(d,[a.id,b.id])).toThrow()
  }
  expect(editor.state.doc).toBe(before)
})
test('transformed parent keeps result curves in correct local space',()=>{
  const {editor,a,b}=fixture(), d=structuredClone(editor.state.doc), g=node('group',30,40,300,300)
  g.transform=[0,2,-2,0,30,40];g.children=[a.id,b.id];g.fills=[];d.nodes[g.id]=g;d.pages[0].children=[g.id]
  const p=previewShapeBuilder(d,[a.id,b.id]);const ids=applyShapeBuilder(d,p,['3:0'],'erase')
  expect(d.nodes[g.id].children).toEqual(ids)
  expect(ids.map(id=>d.nodes[id].transform[4]).sort((a,b)=>a-b)).toEqual([0,100])
})
