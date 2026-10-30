import { afterEach, expect, test } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'
import { registerPendingEdit } from './pending-edits'
const editors:Editor[]=[]
afterEach(()=>editors.splice(0).forEach(e=>e.dispose()))
function fixture(){
 const document=blank(),first=node('text'),second=node('rectangle',100,0),third=node('rectangle',200,0)
 document.nodes={[first.id]:first,[second.id]:second,[third.id]:third};document.pages[0].children=[first.id,second.id,third.id]
 const page={...document.pages[0],id:crypto.randomUUID(),children:[] as string[]};document.pages.push(page)
 const editor=new Editor(document);editors.push(editor);editor.select([first.id]);return {editor,first,second,third,page}
}
function navigate(f:ReturnType<typeof fixture>,kind:'select'|'page'){
 if(kind==='select')f.editor.select([f.second.id]);else f.editor.set({page:f.page.id,selection:[]})
}
test.each(['select','page'] as const)('ordinary pending text commit permits legitimate %s navigation and Undo',kind=>{
 const f=fixture(),before=f.editor.state.doc;let dirty=true
 const off=registerPendingEdit(f.editor,{dirty:()=>dirty,commit:()=>{dirty=false;f.editor.update([f.first.id],{text:'draft'});return true}})
 navigate(f,kind);expect(f.editor.state.doc.nodes[f.first.id].text).toBe('draft');expect(f.editor.state.selection).toEqual(kind==='select'?[f.second.id]:[]);expect(f.editor.state.page).toBe(kind==='page'?f.page.id:before.pages[0].id)
 f.editor.undo();expect(f.editor.state.doc).toBe(before);off()
})
test.each(['select','page'] as const)('ordinary invalid/composing pending text blocks %s without losing state',kind=>{
 const f=fixture(),before=f.editor.state;const off=registerPendingEdit(f.editor,{dirty:()=>true,commit:()=>false});navigate(f,kind)
 expect(f.editor.state.doc).toBe(before.doc);expect(f.editor.state.page).toBe(before.page);expect(f.editor.state.selection).toEqual(before.selection);expect(f.editor.canUndo).toBe(false);off()
})
test.each(['select','page'] as const)('ordinary pending callback load cannot apply old %s to a replacement session',kind=>{
 const f=fixture(),replacement=blank();let dirty=true,adopted:Editor['state']|undefined
 const off=registerPendingEdit(f.editor,{dirty:()=>dirty,commit:()=>{dirty=false;expect(f.editor.load(replacement)).toBe(true);adopted=f.editor.state;return true}})
 navigate(f,kind);expect(f.editor.state).toBe(adopted);off()
})
test.each([
 {kind:'select',replacement:'same-id'}, {kind:'page',replacement:'same-id'},
 {kind:'select',replacement:'new-id'}, {kind:'page',replacement:'new-id'},
 {kind:'select',replacement:'navigation'}, {kind:'page',replacement:'navigation'},
] as const)('ordinary $kind intent cannot overwrite a synchronous $replacement subscriber during text commit',({kind,replacement})=>{
 const f=fixture(),version=f.editor.state.version;let dirty=true,entered=false,adopted:Editor['state']|undefined
 const off=registerPendingEdit(f.editor,{dirty:()=>dirty,commit:()=>{dirty=false;f.editor.update([f.first.id],{text:'draft'});return true}})
 const unsubscribe=f.editor.subscribe(()=>{
  if(entered||f.editor.state.version!==version+1)return;entered=true
  if(replacement==='navigation')f.editor.set({selection:[f.third.id]})
  else {const next=structuredClone(f.editor.state.doc);if(replacement==='new-id')next.id=crypto.randomUUID();expect(f.editor.load(next)).toBe(true);f.editor.select([f.third.id])}
  adopted=f.editor.state
 })
 navigate(f,kind);expect(entered).toBe(true);expect(f.editor.state).toBe(adopted);unsubscribe();off()
})
