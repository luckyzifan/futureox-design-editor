// Actual NumberField DOM events and Editor/WASM. No forced session mutation,
// mocked finish/commit or OS keyboard/IME claim. Native load admission stays real.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, test, expect, vi } from 'vitest'
import { NumberField } from './fields'
import { Editor } from './engine'
import { blank, node, type DesignDocument } from './model'
import { hasPendingEdits, subscribePendingEdits } from './pending-edits'
import { PendingEditContext } from './pending-edit-context'
import { interfacePreference, useInterfacePreferences } from './interface-preference'
const bootstrap = await vi.hoisted(async()=>{
  // @ts-expect-error jsdom is a test-only runtime dependency.
  const {JSDOM}=await import('jsdom');const d=new JSDOM('<html><body></body></html>')
  for(const key of ['window','document','navigator'])vi.stubGlobal(key,key==='window'?d.window:d.window[key]);return d
});bootstrap.window.close()
let dom:any,root:Root,mount:HTMLDivElement,editor:Editor,a:string,b:string,errors:unknown[][]
beforeEach(()=>{
  dom=new JSDOM('<html><body></body></html>',{url:'https://design.invalid/'})
  for(const key of ['window','document','navigator','HTMLElement','HTMLInputElement','Event','MouseEvent','KeyboardEvent','CompositionEvent','FocusEvent','localStorage'])vi.stubGlobal(key,key==='window'?dom.window:dom.window[key])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);interfacePreference.reset()
  dom.window.HTMLElement.prototype.setPointerCapture=()=>{};dom.window.HTMLElement.prototype.hasPointerCapture=()=>false;dom.window.HTMLElement.prototype.releasePointerCapture=()=>{}
  const doc=blank(),one=node('rectangle',0,0,20,20),two=node('rectangle',40,0,20,20);one.opacity=two.opacity=.625;a=one.id;b=two.id
  doc.nodes={[a]:one,[b]:two};doc.pages[0].children=[a,b];editor=new Editor(doc);editor.select([a])
  mount=document.createElement('div');document.body.append(mount);root=createRoot(mount)
  errors=[];const original=console.error.bind(console);vi.spyOn(console,'error').mockImplementation((...args)=>{errors.push(args);original(...args)})
})
afterEach(async()=>{await act(async()=>root.unmount());editor.dispose();dom.window.close();vi.unstubAllGlobals();vi.restoreAllMocks();expect(errors).toEqual([])})
function Harness(){
  const s=useSyncExternalStore(editor.subscribe,editor.snapshot),{locale}=useInterfacePreferences(),id=s.selection[0]??a
  return <PendingEditContext.Provider value={editor}><NumberField label={locale==='en'?'Opacity':'不透明度'} unit="percent" value={s.doc.nodes[id].opacity*100} min={0} max={100} onChange={value=>editor.updateProperties([id],{opacity:value/100},'测试不透明度')}/></PendingEditContext.Provider>
}
async function render(){await act(async()=>root.render(<Harness/>));return input()}
function input(){return mount.querySelector<HTMLInputElement>('input')!}
async function type(value:string){await act(async()=>{input().focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input(),value);input().dispatchEvent(new Event('input',{bubbles:true}))})}
async function key(value:string){await act(async()=>input().dispatchEvent(new KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true})))}
async function blur(){await act(async()=>input().blur())}
async function composition(kind:'compositionstart'|'compositionend',value=''){await act(async()=>input().dispatchEvent(new CompositionEvent(kind,{bubbles:true,data:value})))}
async function adopt(doc:DesignDocument){await act(async()=>{expect(editor.load(doc,true)).toBe(true)});expect(editor.canUndo).toBe(false)}
async function history(before:DesignDocument,after:DesignDocument){await act(async()=>editor.undo());expect(editor.state.doc).toEqual(before);expect(editor.canUndo).toBe(false);await act(async()=>editor.redo());expect(editor.state.doc).toEqual(after);expect(editor.canRedo).toBe(false)}
async function pointer(kind:string,x:number){const span=mount.querySelector<HTMLElement>('.number-scrub')!;await act(async()=>{const e=new MouseEvent(kind,{bubbles:true,cancelable:true,button:0,clientX:x});Object.defineProperties(e,{pointerId:{value:7},isPrimary:{value:true}});span.dispatchEvent(e)})}

test.each(['input','arrow','composition'] as const)('same DOM same-value new session accepts first %s draft and exactly one undo',async(kind)=>{
  const field=await render(),replacement=structuredClone(editor.state.doc);replacement.name='Adopted'
  await adopt(replacement);expect(input()).toBe(field);const before=editor.state.doc
  if(kind==='input')await type('25')
  if(kind==='arrow'){await act(async()=>input().focus());await key('ArrowUp')}
  if(kind==='composition'){await composition('compositionstart');await type('25');await composition('compositionend','25')}
  await key('Enter');expect(editor.state.doc.nodes[a].opacity).toBe(kind==='arrow'?.635:.25);expect(editor.state.doc.nodes[b]).toEqual(before.nodes[b]);await history(before,editor.state.doc)
})
test('old valid draft settles in old session before load; late blur cannot reapply to destination',async()=>{
  const field=await render(),replacement=structuredClone(editor.state.doc);replacement.nodes[a].opacity=.75
  await type('25');await adopt(replacement);expect(input()).toBe(field);const adopted=editor.state.doc,version=editor.state.version
  await blur();expect(editor.state.doc).toBe(adopted);expect(editor.state.version).toBe(version);expect(editor.canUndo).toBe(false)
  await type('50');await key('Enter');expect(editor.state.doc.nodes[a].opacity).toBe(.5);await history(adopted,editor.state.doc)
})
test('IME vetoes load; after cancel and adoption a late composition end/blur cannot write old content',async()=>{
  await render();const replacement=structuredClone(editor.state.doc);replacement.name='IME destination'
  await composition('compositionstart');await type('25');await act(async()=>expect(editor.load(replacement,true)).toBe(false))
  await composition('compositionend','25');await key('Escape');await adopt(replacement);const adopted=editor.state.doc
  // A queued completion event has no matching current composition owner.
  await act(async()=>{input().value='25'});await composition('compositionend','25');await blur()
  expect(editor.state.doc).toBe(adopted);expect(editor.canUndo).toBe(false)
  await type('50');await key('Enter');expect(editor.state.doc.nodes[a].opacity).toBe(.5);await history(adopted,editor.state.doc)
})
test('same-value navigation commits valid old target draft before selecting new target; new edit has its own undo',async()=>{
  await render();const before=editor.state.doc;await type('25');await act(async()=>editor.select([b]));await blur()
  const first=editor.state.doc
  expect(first.nodes[a].opacity).toBe(.25);expect(first.nodes[b]).toEqual(before.nodes[b]);expect(editor.state.selection).toEqual([b]);expect(editor.canUndo).toBe(true)
  await key('Escape');await type('50');await key('Enter');const second=editor.state.doc
  expect(second.nodes[a]).toEqual(first.nodes[a]);expect(second.nodes[b].opacity).toBe(.5)
  await act(async()=>editor.undo());expect(editor.state.doc).toEqual(first);await act(async()=>editor.undo());expect(editor.state.doc).toEqual(before);expect(editor.canUndo).toBe(false)
  await act(async()=>editor.redo());expect(editor.state.doc).toEqual(first);await act(async()=>editor.redo());expect(editor.state.doc).toEqual(second);expect(editor.canRedo).toBe(false)
})
test('locale preserves focused draft/range, invalid Escape preserves existing redo, then valid edit replaces redo once',async()=>{
  const field=await render();await act(async()=>{editor.updateProperties([b],{name:'Redo'});editor.undo()});const before=editor.state.doc
  await type('invalid');await act(async()=>{field.setSelectionRange(1,3);interfacePreference.set({locale:'en'})})
  expect(input()).toBe(field);expect(document.activeElement).toBe(field);expect(field.value).toBe('invalid');expect([field.selectionStart,field.selectionEnd]).toEqual([1,3])
  await key('Enter');expect(editor.state.doc).toBe(before);await key('Escape');expect(field.value).toBe('62.5');expect(editor.canRedo).toBe(true)
  await type('25');await key('Enter');expect(editor.state.doc.nodes[a].opacity).toBe(.25);await history(before,editor.state.doc)
})
test('old scrub pointer after adoption cannot mutate destination, new scrub still commits once',async()=>{
  await render();const replacement=structuredClone(editor.state.doc);replacement.nodes[a].opacity=.75
  await pointer('pointerdown',10);await pointer('pointermove',15);expect(editor.state.doc.nodes[a].opacity).toBe(.675)
  await adopt(replacement);const adopted=editor.state.doc;await pointer('pointermove',30);await pointer('pointerup',30)
  expect(editor.state.doc).toBe(adopted);expect(editor.canUndo).toBe(false)
  await pointer('pointerdown',10);await pointer('pointermove',15);await pointer('pointerup',15);expect(editor.state.doc.nodes[a].opacity).toBe(.8);await history(adopted,editor.state.doc)
})

test('synchronous select before React rerender cannot bind new target owner to old onChange callback',async()=>{
  const field=await render(),before=editor.state.doc
  await act(async()=>{
    editor.select([b])
    field.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,'25');field.dispatchEvent(new Event('input',{bubbles:true}))
    field.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))
  })
  expect(editor.state.selection).toEqual([b]);expect(editor.state.doc).toBe(before);expect(editor.canUndo).toBe(false)
  await key('Escape');await type('50');await key('Enter');expect(editor.state.doc.nodes[a]).toEqual(before.nodes[a]);expect(editor.state.doc.nodes[b].opacity).toBe(.5);await history(before,editor.state.doc)
})
test('synchronous commit subscriber fresh draft is not erased by previous finish cleanup',async()=>{
  const field=await render(),before=editor.state.doc;let reentered=false
  const unsubscribe=editor.subscribe(()=>{
    if(reentered||editor.state.doc.nodes[a].opacity!==.25)return
    reentered=true
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,'50');field.dispatchEvent(new Event('input',{bubbles:true}))
  })
  try {
    await type('25');await key('Enter');expect(reentered).toBe(true);expect(input()).toBe(field)
    expect(field.value).toBe('50');expect(hasPendingEdits(editor)).toBe(true);expect(editor.state.doc.nodes[a].opacity).toBe(.25)
    const first=editor.state.doc;await key('Enter');expect(editor.state.doc.nodes[a].opacity).toBe(.5);const second=editor.state.doc
    await act(async()=>editor.undo());expect(editor.state.doc).toEqual(first);await act(async()=>editor.undo());expect(editor.state.doc).toEqual(before)
    await act(async()=>editor.redo());expect(editor.state.doc).toEqual(first);await act(async()=>editor.redo());expect(editor.state.doc).toEqual(second)
  } finally {unsubscribe()}
})

test('pending-edit completion subscriber new draft keeps focus and is not auto-committed by old Enter blur',async()=>{
  const field=await render(),before=editor.state.doc;let reentered=false
  const unsubscribe=subscribePendingEdits(editor,()=>{
    if(reentered||editor.state.doc.nodes[a].opacity!==.25||hasPendingEdits(editor))return
    reentered=true
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,'50');field.dispatchEvent(new Event('input',{bubbles:true}))
  })
  try {
    await type('25');await key('Enter');expect(reentered).toBe(true);expect(input()).toBe(field)
    expect(field.value).toBe('50');expect(hasPendingEdits(editor)).toBe(true);expect(document.activeElement).toBe(field);expect(editor.state.doc.nodes[a].opacity).toBe(.25)
    const first=editor.state.doc;await key('Enter');expect(editor.state.doc.nodes[a].opacity).toBe(.5);const second=editor.state.doc
    await act(async()=>editor.undo());expect(editor.state.doc).toEqual(first);await act(async()=>editor.undo());expect(editor.state.doc).toEqual(before)
    await act(async()=>editor.redo());expect(editor.state.doc).toEqual(first);await act(async()=>editor.redo());expect(editor.state.doc).toEqual(second)
  } finally {unsubscribe()}
})
