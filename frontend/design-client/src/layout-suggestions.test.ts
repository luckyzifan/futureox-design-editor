import { afterEach, expect, test } from 'vitest'
import { blank, node, defaultSizing, type DesignDocument } from './model'
import { Editor } from './engine'
import { previewLayoutSuggestion, applyLayoutSuggestion } from './layout-suggestions'
import { createDesignAutomation } from './automation/core'
import { encodeDocumentBinary, decodeDocumentBinary } from './kernel/binfmt'
const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach(e => e.dispose()))
function fixture(coords: number[][], width = 300, height = 300) {
  const doc = blank(), frame = node('frame', 100, 200, width, height)
  doc.nodes[frame.id] = frame; doc.pages[0].children = [frame.id]
  for (const [x,y,w=40,h=30] of coords) { const n = node('rectangle', x,y,w,h); frame.children.push(n.id); doc.nodes[n.id] = n }
  return { doc, frame }
}
function editor(doc: DesignDocument) { const e = new Editor(doc); editors.push(e); return e }
function geometry(doc: DesignDocument) { return Object.fromEntries(Object.values(doc.nodes).map(n => [n.id, [n.transform, n.width, n.height]])) }
test.each([['horizontal', [[10,20],[60,20],[110,20]]], ['vertical', [[10,20],[10,60],[10,100]]]] as const)('exact %s preview does not mutate; one native undo and redo preserve geometry', (mode, coords) => {
  const {doc,frame} = fixture(coords.map(c => [...c])), e=editor(doc), before=e.state.doc, version=e.state.version
  e.select([frame.id]); const selected=[...e.state.selection], preview=e.previewSuggestedLayout()
  expect(preview.suggestions[0].changes[0].layout.mode).toBe(mode)
  expect(e.state.doc).toBe(before); expect(e.state.version).toBe(version); expect(e.state.selection).toEqual(selected)
  e.applySuggestedLayout(preview,'preserve-geometry')
  expect(e.state.version).toBe(version+1); expect(geometry(e.state.doc)).toEqual(geometry(before))
  const after=e.state.doc; e.undo(); expect(e.state.doc).toEqual(before); e.redo(); expect(e.state.doc).toEqual(after)
  const decoded=decodeDocumentBinary(encodeDocumentBinary(after)) as DesignDocument; expect(decoded.nodes[frame.id].layout).toEqual(after.nodes[frame.id].layout)
})
test('grid and wrap are explicit alternatives, both preserve original grid', () => {
  for (const choice of ['preserve-geometry','wrapped-rows']) {
    const {doc,frame}=fixture([[10,20],[60,20],[10,60],[60,60]]),e=editor(doc),before=e.state.doc,p=e.previewSuggestedLayout(frame.id)
    expect(p.suggestions.map(s=>s.id)).toEqual(['preserve-geometry','wrapped-rows'])
    e.applySuggestedLayout(p,choice); expect(geometry(e.state.doc)).toEqual(geometry(before))
    expect(e.state.doc.nodes[frame.id].layout?.mode).toBe(choice==='preserve-geometry'?'grid':'horizontal')
  }
})
test('center alignment, reversed order, hidden and absolute children retain geometry and slots', () => {
  const {doc,frame}=fixture([[10,20,40,30],[60,10,40,50],[110,20,40,30]])
  frame.children.reverse(); const hidden=node('rectangle',-20,-30,100,90),absolute=node('rectangle',-50,-50,100,90)
  hidden.visible=false; absolute.sizing={...defaultSizing(),absolute:true};doc.nodes[hidden.id]=hidden;doc.nodes[absolute.id]=absolute
  frame.children.splice(1,0,hidden.id,absolute.id)
  const e=editor(doc),before=e.state.doc,p=e.previewSuggestedLayout(frame.id)
  expect(p.suggestions[0].changes[0].layout.align).toBe('center')
  e.applySuggestedLayout(p,'preserve-geometry');expect(geometry(e.state.doc)).toEqual(geometry(before))
  expect(e.state.doc.nodes[frame.id].children.slice(1,3)).toEqual([hidden.id,absolute.id])
  expect(e.state.doc.nodes[hidden.id]).toEqual(before.nodes[hidden.id]);expect(e.state.doc.nodes[absolute.id]).toEqual(before.nodes[absolute.id])
})
test('existing nested rows inferred atomically, retaining text, fonts and constraints', () => {
  const {doc,frame}=fixture([])
  for (const y of [10,70]) { const row=node('frame',10,y,200,50);doc.nodes[row.id]=row;frame.children.push(row.id)
    for (const x of [10,70]) { const t=node('text',x,10,40,30);t.text='Hello';t.constraints={horizontal:'center',vertical:'end'};doc.nodes[t.id]=t;row.children.push(t.id) }
  }
  const e=editor(doc),before=e.state.doc,p=e.previewSuggestedLayout(frame.id)
  expect(p.suggestions[0].changes).toHaveLength(3);e.applySuggestedLayout(p,'preserve-geometry')
  expect(geometry(e.state.doc)).toEqual(geometry(before));for(const n of Object.values(before.nodes).filter(n=>n.kind==='text'))expect(e.state.doc.nodes[n.id]).toEqual(n)
  e.undo();expect(e.state.doc).toEqual(before)
})
test('locked ancestors prevent nested mutations; locked visible children decline parent', () => {
  const {doc,frame}=fixture([[10,10],[60,10]])
  doc.nodes[frame.children[0]].locked=true;expect(previewLayoutSuggestion(doc,frame.id).suggestions).toEqual([])
  frame.locked=true;const nested=node('frame',10,100,100,50);nested.children=frame.children.splice(0);doc.nodes[nested.id]=nested;frame.children=[nested.id]
  expect(previewLayoutSuggestion(doc,frame.id).suggestions).toEqual([])
})
for(const coords of [[[10,10],[65,10],[110,10]],[[10,10],[20,20]],[[10,10],[60,60]],[[10,10],[60,10],[10,60]]])test(`irregular geometry declines ${JSON.stringify(coords)}`,()=>{
  const {doc,frame}=fixture(coords);expect(previewLayoutSuggestion(doc,frame.id).suggestions).toEqual([])
})
test('invalid, cyclic geometry and stale/forged candidates reject',()=>{
  const {doc,frame}=fixture([[10,10],[60,10]]),e=editor(doc),p=e.previewSuggestedLayout(frame.id)
  expect(()=>e.applySuggestedLayout(p,'forged')).toThrow();const before=e.state.doc;expect(e.state.doc).toBe(before)
  e.change('rename',d=>{d.nodes[frame.id].name='New'});expect(()=>e.applySuggestedLayout(p,'preserve-geometry')).toThrow(/stale/)
  const copy=structuredClone(doc);copy.nodes[frame.children[0]].transform[4]=NaN;expect(()=>previewLayoutSuggestion(copy,frame.id)).toThrow(/Invalid/)
  copy.nodes[frame.children[0]]=structuredClone(doc.nodes[frame.children[0]]);copy.nodes[frame.id].children.push(frame.id);expect(()=>previewLayoutSuggestion(copy,frame.id)).toThrow(/cyclic/)
  expect(()=>applyLayoutSuggestion(structuredClone(doc),frame.id,'forged','preserve-geometry')).toThrow(/stale/)
})
test('MCP preview is read-only and apply is one guarded transaction',()=>{
  const {doc,frame}=fixture([[10,10],[60,10]]),e=editor(doc),api=createDesignAutomation(e),before=e.state.doc,version=e.state.version
  const read=api.execute({method:'layout.suggest',params:{frameId:frame.id}});expect(read.ok).toBe(true);if(!read.ok)throw Error(read.error.message)
  const p=read.result as ReturnType<typeof previewLayoutSuggestion>;expect(e.state.doc).toBe(before);expect(e.state.version).toBe(version)
  const applied=api.execute({method:'layout.applySuggestion',params:{frameId:frame.id,fingerprint:p.fingerprint,suggestionId:'preserve-geometry'},documentId:doc.id,session:e.sessionGeneration,expectedRevision:version})
  expect(applied.ok,JSON.stringify(applied)).toBe(true);expect(geometry(e.state.doc)).toEqual(geometry(before));e.undo();expect(e.state.doc).toEqual(before)
})
test('100/1000-node preview is bounded; record CPU timings without renderer',()=>{
  for(const count of [100,1000]){
    const {doc,frame}=fixture(Array.from({length:count-1},(_,i)=>[10+i*50,10]),50050,100)
    const start=performance.now();const p=previewLayoutSuggestion(doc,frame.id);const elapsed=performance.now()-start
    console.info(JSON.stringify({benchmark:'layout-suggest',nodes:count,elapsedMs:elapsed}));expect(p.fingerprint).toMatch(/^[a-f0-9]{64}$/);expect(p.inspectedNodes).toBe(count);expect(p.suggestions).toHaveLength(1);expect(elapsed).toBeLessThan(2000)
    if(count===1000){const n=node('rectangle',0,0,1,1);doc.nodes[n.id]=n;frame.children.push(n.id);expect(()=>previewLayoutSuggestion(doc,frame.id)).toThrow(/limited/)}
  }
})
test('MCP missing revision, read-only permission and stale or atomic batch proposals fail closed',()=>{
  const {doc,frame}=fixture([[10,10],[60,10]]),e=editor(doc),api=createDesignAutomation(e),p=e.previewSuggestedLayout(frame.id),before=e.state.doc
  const params={frameId:frame.id,fingerprint:p.fingerprint,suggestionId:'preserve-geometry'}
  expect(api.execute({method:'layout.applySuggestion',params})).toMatchObject({ok:false,error:{code:'missing_revision'}})
  const scoped=createDesignAutomation(e,[],[],{grants:[{resource:{documentId:doc.id,session:e.sessionGeneration},operations:['layout.suggest','layout.applySuggestion'],access:'read'}]})
  expect(scoped.execute({method:'layout.suggest',params:{frameId:frame.id}}).ok).toBe(true)
  expect(scoped.execute({method:'layout.applySuggestion',params,expectedRevision:e.state.version,documentId:doc.id,session:e.sessionGeneration})).toMatchObject({ok:false,error:{code:'permission_denied'}})
  const batch=api.execute({method:'batch.apply',expectedRevision:e.state.version,documentId:doc.id,session:e.sessionGeneration,params:{operations:[{method:'layout.applySuggestion',params},{method:'layout.applySuggestion',params:{...params,fingerprint:'0'.repeat(64)}}]}})
  expect(batch.ok).toBe(false);expect(e.state.doc).toBe(before);expect(e.canUndo).toBe(false)
})
