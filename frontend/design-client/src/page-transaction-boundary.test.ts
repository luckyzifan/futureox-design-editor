import { afterEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'
import { registerPendingEdit } from './pending-edits'
import { canvasActions, closeCanvasActions, ActionOutcome, ActionReason } from './canvas-action-diagnostics'
const editors: Editor[]=[]
afterEach(()=>{ for(const e of editors.splice(0)){closeCanvasActions(e);e.dispose()} vi.unstubAllGlobals() })
function fixture(){
 vi.stubGlobal('window',{coreDesktop:{renderDiagnostics:true,renderDiagnosticsDetail:true}})
 const doc=blank(), n=node('rectangle',0,0,100,100);doc.nodes[n.id]=n;doc.pages[0].children.push(n.id);doc.pages.push(blank().pages[0])
 const editor=new Editor(doc);editors.push(editor);editor.select([n.id]);return {editor,id:n.id,first:editor.state.page,second:doc.pages[1].id}
}
test.each(['add','duplicate','remove','reorder'] as const)('direct %s page rejects captured draft without changing history, then works after commit',kind=>{
 const {editor,id,first,second}=fixture();editor.begin('drag');editor.preview({[id]:{width:120}})
 const doc=editor.state.doc,version=editor.state.version
 const command=()=>kind==='add'?editor.addPage():kind==='duplicate'?editor.duplicatePage(first):kind==='remove'?editor.removePage():editor.reorderPage(second,first)
 expect(command()).toBe(false);expect(editor.state.doc).toBe(doc);expect(editor.state.page).toBe(first);expect(editor.interactionActive).toBe(true);expect(editor.state.version).toBe(version);expect(editor.canUndo).toBe(false)
 expect(canvasActions(editor).snapshot().rows.at(-1)).toMatchObject({actionOutcome:ActionOutcome.blocked,actionReason:ActionReason.busy})
 editor.commit();expect(editor.state.doc.nodes[id].width).toBe(120);expect(command()).toBe(true)
 expect(editor.state.doc.pages.some(p=>p.id===editor.state.page)).toBe(true)
 editor.undo();expect(editor.state.page).toBe(first);expect(editor.state.doc.nodes[id].width).toBe(120)
 editor.undo();expect(editor.state.doc.nodes[id].width).toBe(100)
 editor.redo();expect(editor.state.doc.nodes[id].width).toBe(120)
 editor.redo();expect(editor.state.doc.pages.some(p=>p.id===editor.state.page)).toBe(true)
})
test('blocked page creation preserves cancellable draft; later new page has independent undo',()=>{
 const {editor,id,first}=fixture(),before=editor.state.doc;editor.begin('drag');editor.preview({[id]:{width:120}})
 expect(editor.addPage()).toBe(false);editor.cancel();expect(editor.state.doc).toBe(before);expect(editor.state.page).toBe(first);expect(editor.canUndo).toBe(false)
 expect(editor.addPage()).toBe(true);const page=editor.state.page;editor.undo();expect(editor.state.page).toBe(first);editor.redo();expect(editor.state.page).toBe(page)
})
test('pending input and nonexistent target reject navigation before cancelling the live draft',()=>{
 const {editor,id,first,second}=fixture();editor.begin('drag');editor.preview({[id]:{width:120}});const preview=editor.state.doc
 const unregister=registerPendingEdit(editor,{dirty:()=>true,commit:()=>false})
 expect(editor.switchPage(second)).toBe(false);expect(editor.state.doc).toBe(preview);expect(editor.interactionActive).toBe(true);expect(editor.state.page).toBe(first)
 unregister();expect(editor.switchPage('missing')).toBe(false);expect(editor.state.doc).toBe(preview);expect(editor.interactionActive).toBe(true)
 expect(editor.switchPage(second)).toBe(true);expect(editor.interactionActive).toBe(false);expect(editor.state.doc.nodes[id].width).toBe(100);expect(editor.state.page).toBe(second);expect(editor.canUndo).toBe(false)
})
test('pending input blocks direct topology and busy state does not report success',()=>{
 const {editor}=fixture(),before=editor.state.doc;const unregister=registerPendingEdit(editor,{dirty:()=>true,commit:()=>false})
 expect(editor.addPage()).toBe(false);expect(editor.state.doc).toBe(before);unregister();editor.set({busy:true});expect(editor.addPage()).toBe(false);expect(editor.state.doc).toBe(before)
})
test('automation page topology reports interaction_active, preserving gesture until explicit cancellation',async()=>{
 const {createDesignAutomation}=await import('./automation/core')
 const {editor,id,first}=fixture();const api=createDesignAutomation(editor);editor.begin('drag');editor.preview({[id]:{width:120}});const draft=editor.state.doc
 for(const [method,params] of [['page.create',{makeCurrent:true}],['page.duplicate',{id:first}],['page.delete',{id:first}],['page.reorder',{id:first,index:1}]] as const){
  const response=api.execute({method,params,expectedRevision:editor.state.version,documentId:editor.state.doc.id,session:editor.sessionGeneration})
  expect(response.ok).toBe(false);if(!response.ok)expect(response.error.code).toBe('interaction_active')
  expect(editor.state.doc).toBe(draft);expect(editor.interactionActive).toBe(true)
 }
 editor.cancel();const response=api.execute({method:'page.create',params:{makeCurrent:true},expectedRevision:editor.state.version,documentId:editor.state.doc.id,session:editor.sessionGeneration});expect(response.ok).toBe(true);expect(editor.state.page).not.toBe(first)
})
test('pending-input adoption invalidates old navigation target before any cancellation',()=>{
 const {editor,second}=fixture();const replacement=blank();let dirty=true
 const unregister=registerPendingEdit(editor,{dirty:()=>dirty,commit:()=>{dirty=false;editor.load(replacement);return true}})
 expect(editor.switchPage(second)).toBe(false);expect(editor.state.doc.id).toBe(replacement.id);expect(editor.state.page).toBe(replacement.pages[0].id);expect(editor.interactionActive).toBe(false);unregister()
})
test.each(['add','duplicate'] as const)('%s does not select a stale page after a synchronous subscriber adopts a same-id document',kind=>{
 const {editor,first}=fixture(),replacement=blank();replacement.id=editor.state.doc.id
 let fired=false
 const unsubscribe=editor.subscribe(()=>{if(!fired&&editor.state.doc.pages.length===3){fired=true;editor.load(replacement)}})
 expect(kind==='add'?editor.addPage():editor.duplicatePage(first)).toBe(false)
 expect(fired).toBe(true);expect(editor.state.doc.id).toBe(replacement.id);expect(editor.state.page).toBe(replacement.pages[0].id);expect(editor.state.doc.pages.some(p=>p.id===editor.state.page)).toBe(true);unsubscribe()
})
test.each(['add','duplicate'] as const)('%s rechecks existence when subscriber removes newly committed page in the same session',kind=>{
 const {editor,first}=fixture();const originals=new Set(editor.state.doc.pages.map(p=>p.id)),session=editor.sessionGeneration;let fired=false
 const unsubscribe=editor.subscribe(()=>{const added=editor.state.doc.pages.find(p=>!originals.has(p.id));if(!fired&&added){fired=true;editor.change('subscriber removes new page',d=>{const remove=(id:string)=>{d.nodes[id].children.forEach(remove);delete d.nodes[id]};added.children.forEach(remove);d.pages=d.pages.filter(p=>p.id!==added.id)})}})
 expect(kind==='add'?editor.addPage():editor.duplicatePage(first)).toBe(false)
 expect(fired).toBe(true);expect(editor.sessionGeneration).toBe(session);expect(editor.state.page).toBe(first);expect(editor.state.doc.pages.some(p=>p.id===editor.state.page)).toBe(true);unsubscribe()
})
test.each(['adopt','remove'] as const)('switchPage revalidates after cancellation subscriber can %s the target scope',mode=>{
 const {editor,id,first,second}=fixture();editor.begin('drag');editor.preview({[id]:{width:120}});let fired=false
 const replacement=blank();replacement.id=editor.state.doc.id;replacement.pages.push({...blank().pages[0],id:second})
 const unsubscribe=editor.subscribe(()=>{if(!fired&&!editor.interactionActive){fired=true;if(mode==='adopt')editor.load(replacement);else editor.change('subscriber removes target',d=>{d.pages=d.pages.filter(p=>p.id!==second)})}})
 expect(editor.switchPage(second)).toBe(false);expect(fired).toBe(true);expect(editor.state.page).toBe(mode==='adopt'?replacement.pages[0].id:first);expect(editor.state.doc.pages.some(p=>p.id===editor.state.page)).toBe(true);unsubscribe()
})
