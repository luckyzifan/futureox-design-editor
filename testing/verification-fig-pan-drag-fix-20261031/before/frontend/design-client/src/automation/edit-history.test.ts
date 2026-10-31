import { afterEach, expect, it, vi } from 'vitest'
import { Editor, type EditorEditEvent } from '../engine'
import { blank,node } from '../model'
import { createEditorDesignAutomation } from './index'
import { Graph } from '../kernel/graph'
const editors:Editor[]=[]
afterEach(()=>{editors.splice(0).forEach(e=>e.dispose());vi.restoreAllMocks()})
function setup(){const d=blank(),n=node('rectangle');d.nodes[n.id]=n;d.pages[0].children.push(n.id);const e=new Editor(d);editors.push(e);const events:EditorEditEvent[]=[];e.subscribeEdits(event=>events.push(event));return{e,n,events}}
it('emits manual committed edits/undo/redo exactly once and omits no-op/rejected edits',()=>{
 const {e,n,events}=setup();e.change('手动改名',d=>{d.nodes[n.id].name='新名称'});expect(events).toHaveLength(1);expect(events[0]).toMatchObject({source:'user',kind:'edit',revision:1,summary:'手动改名'})
 e.change('相同',()=>{});e.change('错误',d=>{d.nodes[n.id].width=-1});expect(events).toHaveLength(1)
 e.undo();e.redo();expect(events.map(v=>v.kind)).toEqual(['edit','undo','redo']);expect(events.map(v=>v.revision)).toEqual([1,2,3])
})
it('API batches emit one automation record without persisting caller-controlled labels',()=>{
 const {e,n,events}=setup(),api=createEditorDesignAutomation(e)
 const r=api.execute({method:'batch.apply',documentId:e.state.doc.id,session:e.sessionGeneration,expectedRevision:0,params:{label:'secret caller prompt',operations:[{method:'node.update',params:{ids:[n.id],patch:{name:'A'}}},{method:'node.update',params:{ids:[n.id],patch:{width:80}}}]}})
 expect(r.ok,JSON.stringify(r)).toBe(true);expect(events).toHaveLength(1);expect(events[0]).toMatchObject({source:'automation',kind:'edit',summary:'API 文档修改'});expect(JSON.stringify(events)).not.toContain('secret caller prompt');api.dispose()
})
it('gesture previews/cancel are not edits; one gesture commit emits one record',()=>{
 const {e,n,events}=setup();e.begin('拖动');e.change('预览',d=>{d.nodes[n.id].transform[4]=10});expect(events).toHaveLength(0);e.cancel();expect(events).toHaveLength(0)
 e.begin('拖动');e.change('预览',d=>{d.nodes[n.id].transform[4]=20});e.commit();expect(events).toHaveLength(1);expect(events[0].summary).toBe('拖动')
})
it('audit sink failures do not reject edits and listeners unsubscribe',()=>{
 const {e,n,events}=setup(),remove=e.subscribeEdits(()=>{throw Error('storage offline')});expect(()=>e.change('编辑',d=>{d.nodes[n.id].name='changed'})).not.toThrow();expect(e.state.doc.nodes[n.id].name).toBe('changed');expect(events).toHaveLength(1);remove()
 const extra:EditorEditEvent[]=[];const off=e.subscribeEdits(v=>extra.push(v));off();e.undo();expect(extra).toHaveLength(0)
})

it.each(['node.update', 'document.rename'] as const)('carries %s automation provenance into the real Rust history, separately from undo/redo initiators', method => {
 const open=Graph.open, graphs:Graph[]=[]
 vi.spyOn(Graph,'open').mockImplementation(document=>{const graph=open.call(Graph,document);graphs.push(graph);return graph})
 const {e,n,events}=setup(),api=createEditorDesignAutomation(e)
 const call=(operation:string,params:Record<string,unknown>={})=>api.execute({method:operation,documentId:e.state.doc.id,session:e.sessionGeneration,expectedRevision:e.state.version,params})
 try {
  const before=e.state.doc
  expect(call(method,method==='node.update'?{ids:[n.id],patch:{name:'API edit'}}:{name:'API document'}).ok).toBe(true)
  expect(graphs).toHaveLength(1)
  const scope=()=>JSON.parse(graphs[0].api.last_edit_scope_json())
  expect(scope()).toMatchObject({source:'ai',ignoreUndoRedo:false,writeInReadonly:false})
  expect(e.historyOperationMode).toBe(method==='node.update'?'op-batch':'document')
  const after=e.state.doc
  e.undo() // A human can undo an AI-authored edit without rewriting its source.
  expect(e.state.doc).toEqual(before);expect(events.at(-1)).toMatchObject({source:'user',kind:'undo'})
  expect(call('history.redo').ok).toBe(true)
  expect(e.state.doc).toEqual(after);expect(events.at(-1)).toMatchObject({source:'automation',kind:'redo'})
  expect(scope().source).toBe('ai') // last committed edit, not undo caller
  e.change('Manual edit',d=>{d.nodes[n.id].opacity=.5})
  expect(scope().source).toBe('user')
  const manual=e.state.doc
  expect(call('history.undo').ok).toBe(true);expect(e.state.doc).toEqual(after)
  e.redo();expect(e.state.doc).toEqual(manual)
  expect(events.slice(-2).map(v=>[v.kind,v.source])).toEqual([['undo','automation'],['redo','user']])
  expect(scope().source).toBe('user')
 } finally {api.dispose()}
})

it('gestures remain user-authored and rejected/no-op edits cannot change native provenance',()=>{
 const open=Graph.open,graphs:Graph[]=[]
 vi.spyOn(Graph,'open').mockImplementation(document=>{const graph=open.call(Graph,document);graphs.push(graph);return graph})
 const {e,n,events}=setup()
 e.begin('Drag');e.change('Preview',d=>{d.nodes[n.id].transform[4]=42});e.commit()
 expect(JSON.parse(graphs[0].api.last_edit_scope_json()).source).toBe('user')
 const revision=e.state.version
 e.change('Invalid',d=>{d.nodes[n.id].width=-1},undefined,undefined,'automation')
 e.change('No change',()=>{},undefined,undefined,'automation')
 expect(e.state.version).toBe(revision);expect(events).toHaveLength(1)
 expect(JSON.parse(graphs[0].api.last_edit_scope_json()).source).toBe('user')
})
