// P01-P08/P10: mounted production panels + real Editor/WASM. Draft, not run.
// Physical Electron/Figma UI, OS dialogs and screen pixels are not certified.
// @ts-expect-error jsdom runtime dependency
import { JSDOM } from 'jsdom'
import React, { act, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Inspector } from './Inspector'
import { MultiStylePanel } from './MultiStylePanel'
import { SelectionColorsPanel } from './SelectionColorsPanel'
import { PendingEditContext } from './pending-edit-context'
import { interfacePreference } from './interface-preference'
import { Editor } from './engine'
import { blank, node, paint, stroke, effect, type DesignDocument, type DesignNode } from './model'
import { emptySystem } from './design-system'

const bootstrap = await vi.hoisted(async () => {
  // @ts-expect-error jsdom runtime dependency
  const { JSDOM } = await import('jsdom')
  const d = new JSDOM('<!doctype html><html><body></body></html>')
  for (const k of ['window', 'document', 'navigator']) vi.stubGlobal(k, k === 'window' ? d.window : d.window[k])
  return d
})
bootstrap.window.close()
let dom: any, root: Root, mount: HTMLDivElement, editor: Editor
let errors: string[]
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const k of ['window','document','navigator','HTMLElement','HTMLInputElement','HTMLSelectElement','HTMLButtonElement','Node','Element','Event','MouseEvent','KeyboardEvent','CompositionEvent','localStorage']) vi.stubGlobal(k,k==='window'?dom.window:dom.window[k])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  vi.stubGlobal('PointerEvent',dom.window.MouseEvent)
  vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){}})
  vi.stubGlobal('requestAnimationFrame',()=>1); vi.stubGlobal('cancelAnimationFrame',()=>{})
  interfacePreference.reset(); errors=[]
  window.addEventListener('error',e=> {errors.push(String(e.error?.message ?? e.message))})
  mount=document.createElement('div'); document.body.append(mount);root=createRoot(mount)
})
afterEach(async()=> {await act(async()=>root.unmount()); editor?.dispose(); dom.window.close(); vi.restoreAllMocks();vi.unstubAllGlobals();expect(errors).toEqual([])})
function start(nodes:DesignNode[],selected=nodes.map(n=>n.id),configure?:(d:DesignDocument)=>void){
  const d=blank(); d.schemaVersion=6; for(const n of nodes)d.nodes[n.id]=n;d.pages[0].children=nodes.map(n=>n.id);configure?.(d)
  editor=new Editor(d);editor.select(selected)
}
function Panel({kind}:{kind:'inspector'|'fills'|'strokes'|'colors'}){
  const s=useSyncExternalStore(editor.subscribe,editor.panelSnapshot)
  const nodes=s.selection.map(id=>s.doc.nodes[id]).filter(Boolean)
  return <PendingEditContext.Provider value={editor}>{kind==='inspector'?<Inspector editor={editor}/>:kind==='colors'?<SelectionColorsPanel editor={editor}/>:<MultiStylePanel editor={editor} nodes={nodes} field={kind}/>}</PendingEditContext.Provider>
}
const render=(kind:'inspector'|'fills'|'strokes'|'colors')=>act(async()=>root.render(<Panel kind={kind}/>))
function field(label:string,scope:ParentNode=document){const el=scope.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);expect(el,`missing input ${label}`).not.toBeNull();return el!}
function button(label:string,scope:ParentNode=document){const el=[...scope.querySelectorAll<HTMLButtonElement>('button')].find(x=>x.getAttribute('aria-label')===label||x.getAttribute('title')===label||x.textContent===label);expect(el,`missing button ${label}`).toBeTruthy();return el!}
async function click(el:Element){await act(async()=>{el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))})}
async function type(el:HTMLInputElement,value:string){await act(async()=>{el.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}))})}
async function key(el:Element,value:string){await act(async()=>{el.dispatchEvent(new KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true}))})}
async function enter(el:HTMLInputElement,value:string){await type(el,value);await key(el,'Enter')}
async function choose(label:string,value:string,scope:ParentNode=document){const el=scope.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);expect(el).not.toBeNull();await act(async()=>{el!.value=value;el!.dispatchEvent(new Event('change',{bubbles:true}))})}
function cards(){return [...mount.querySelectorAll<HTMLElement>('.property-card')].filter(x=>x.querySelector('.paint-editor'))}
async function history(before:DesignDocument,after:DesignDocument){await act(async()=>editor.undo());expect(editor.state.doc).toEqual(before);await act(async()=>editor.redo());expect(editor.state.doc).toEqual(after)}

test('P01 actual Inspector second solid fill preview owns only its paint alpha/color, one history',async()=>{
  const n=node('rectangle');n.fills=[paint('#112233'),paint('#445566')];n.fills[0].opacity=.8;n.fills[1].opacity=.6;n.opacity=.75;n.strokes=[stroke()];n.strokes[0].paint.opacity=.4
  start([n]);await render('inspector');const before=editor.state.doc
  await click(button('颜色',cards()[1]));await type(field('填充颜色值'),'#abcdef');await type(field('填充不透明度 %'),'25')
  const preview=editor.state.doc.nodes[n.id];expect(editor.authoredDocument).toBe(before);expect(editor.state.version).toBe(0)
  expect(preview.fills[0]).toEqual(before.nodes[n.id].fills[0]);expect(preview.fills[1]).toMatchObject({id:n.fills[1].id,color:'#abcdef',opacity:.25});expect(preview.strokes).toEqual(n.strokes);expect(preview.opacity).toBe(.75)
  await click(button('应用'));const after=editor.state.doc;expect(editor.state.version).toBe(1);await history(before,after)
})
test('P02 actual keyed Inspector retires old color input after external paint reorder, no redirected late write',async()=>{
  const n=node('rectangle');n.fills=[paint('#112233'),paint('#445566')];start([n]);await render('inspector');const before=editor.state.doc
  await click(button('颜色',cards()[1]));const old=field('填充颜色值');await type(old,'#abcdef')
  await act(async()=>editor.updateProperties([n.id],x=>{x.fills.reverse()},'Explicit stack reorder'))
  const after=editor.state.doc;expect(editor.propertyPreviewActive).toBe(false);expect(after.nodes[n.id].fills.map(p=>[p.id,p.color])).toEqual([[n.fills[1].id,'#abcdef'],[n.fills[0].id,'#112233']])
  expect(document.contains(old)).toBe(false);await type(old,'#ffffff');await key(old,'Enter');expect(editor.state.doc).toBe(after)
  await act(async()=>editor.undo());expect(editor.state.doc.nodes[n.id].fills.map(p=>p.id)).toEqual(n.fills.map(p=>p.id));expect(editor.state.doc.nodes[n.id].fills[1].color).toBe('#abcdef')
  await act(async()=>editor.undo());expect(editor.state.doc).toEqual(before);await act(async()=>{editor.redo();editor.redo()});expect(editor.state.doc).toEqual(after)
})
test('P03 actual mixed fill slots change matching kind/index only; invalid Escape preserves redo',async()=>{
  const a=node('rectangle'),b=node('rectangle'),c=node('rectangle');a.fills=[paint('#ff0000'),paint('#111111')];b.fills=[{...paint(),kind:'linear'}];c.fills=[paint('#0000ff')]
  start([a,b,c]);await render('fills');const before=editor.state.doc
  await enter(field('填充 1颜色'),'#00ff00');const after=editor.state.doc
  expect(after.nodes[a.id].fills[0].color).toBe('#00ff00');expect(after.nodes[c.id].fills[0].color).toBe('#00ff00');expect(after.nodes[b.id]).toEqual(before.nodes[b.id]);expect(after.nodes[a.id].fills[1]).toEqual(a.fills[1]);expect(editor.state.version).toBe(1)
  await act(async()=>editor.undo());expect(editor.state.doc).toEqual(before);expect(editor.canRedo).toBe(true)
  const f=field('填充 1颜色');await type(f,'#zz');await key(f,'Enter');expect(editor.state.doc).toEqual(before);await key(f,'Escape');expect(editor.canRedo).toBe(true);await act(async()=>editor.redo());expect(editor.state.doc).toEqual(after)
})
test('P04 actual SelectionColors deduplicates selected parent/child across five uses with exact history',async()=>{
  const frame=node('frame'),child=node('text');frame.fills=[];frame.children=[child.id];child.text='abc';child.fills=[paint('#ff0000'),{...paint(),kind:'linear',stops:[{offset:0,color:'#FF0000'},{offset:1,color:'#0000ff'}]}];child.strokes=[stroke()];child.strokes[0].paint.color='#ff0000';child.effects=[effect('shadow')];child.effects[0].color='#ff0000';child.textRuns=[{start:0,end:2,color:'#ff0000',weight:700}]
  start([frame,child],[frame.id,child.id],d=>{d.pages[0].children=[frame.id]});await render('colors');const before=editor.state.doc
  expect(mount.textContent).toContain('5 处');await type(field('选区颜色 1'),'#112233');const after=editor.state.doc,n=after.nodes[child.id]
  expect(n.fills[0].color).toBe('#112233');expect(n.fills[1].stops[0].color).toBe('#112233');expect(n.fills[1].stops[1].color).toBe('#0000ff');expect(n.strokes[0].paint.color).toBe('#112233');expect(n.effects[0].color).toBe('#112233');expect(n.textRuns).toEqual([{start:0,end:2,color:'#112233',weight:700}]);expect(editor.state.version).toBe(1);await history(before,after)
})
test('P05 actual SelectionColors explicit local override preserves unrelated variable binding and history',async()=>{
  const n=node('rectangle');n.fills=[paint('#ff0000')];n.bindings={'fills.0.color':'brand',width:'width'}
  start([n],[n.id],d=>{d.schemaVersion=6;const s=d.designSystem=emptySystem();s.collections.theme={name:'Theme',modes:['Default'],defaultMode:'Default'};s.activeModes.theme='Default';s.variables.brand={name:'Brand',kind:'color',collection:'theme',values:{Default:'#ff0000'}};s.variables.width={name:'Width',kind:'number',collection:'theme',values:{Default:n.width}}})
  await render('colors');const before=editor.state.doc;expect(mount.querySelector('input[aria-label="选区颜色 1"]')).toBeNull()
  await click(button('转为本地颜色'));const detached=editor.state.doc;expect(detached.nodes[n.id].bindings).toEqual({width:'width'});expect(detached.nodes[n.id].fills[0].color).toBe('#ff0000')
  await type(field('选区颜色 1'),'#00ff00');const after=editor.state.doc;expect(after.nodes[n.id].fills[0].color).toBe('#00ff00');expect(after.nodes[n.id].bindings).toEqual({width:'width'});expect(after.designSystem).toEqual(before.designSystem)
  await act(async()=>editor.undo());expect(editor.state.doc).toEqual(detached);await act(async()=>editor.undo());expect(editor.state.doc).toEqual(before);await act(async()=>{editor.redo();editor.redo()});expect(editor.state.doc).toEqual(after)
})
test('P06 actual Inspector gradient kind/stops sort positions, enforce two-stop minimum and undo each edit',async()=>{
  const n=node('rectangle');start([n]);await render('inspector');const before=editor.state.doc
  await choose('填充类型','linear',cards()[0]);const gradient=editor.state.doc;expect(gradient.nodes[n.id].fills[0].kind).toBe('linear');expect(gradient.nodes[n.id].fills[0].stops).toHaveLength(2)
  await click(button('＋ 添加色标',cards()[0]));expect(editor.state.doc.nodes[n.id].fills[0].stops.map(s=>s.offset)).toEqual([0,.5,1]);const added=editor.state.doc
  const fields=cards()[0].querySelectorAll<HTMLInputElement>('input[aria-label="位置 %"]');await enter(fields[1],'75');expect(editor.state.doc.nodes[n.id].fills[0].stops.map(s=>s.offset)).toEqual([0,.75,1]);const moved=editor.state.doc
  await type(field('位置 %',cards()[0]),'NaN');await key(field('位置 %',cards()[0]),'Enter');expect(editor.state.doc).toEqual(moved);await key(field('位置 %',cards()[0]),'Escape')
  await click(cards()[0].querySelectorAll<HTMLButtonElement>('button[title="删除色标"]')[1]);expect(editor.state.doc.nodes[n.id].fills[0].stops).toHaveLength(2);expect([...cards()[0].querySelectorAll<HTMLButtonElement>('button[title="删除色标"]')].every(b=>b.disabled)).toBe(true)
  await act(async()=>editor.undo());expect(editor.state.doc).toEqual(moved);await act(async()=>editor.undo());expect(editor.state.doc).toEqual(added);await act(async()=>editor.undo());expect(editor.state.doc).toEqual(gradient);await act(async()=>editor.undo());expect(editor.state.doc).toEqual(before)
})
test('P07 actual mixed stroke fields use each inherited scale, retain opacity isolation and exact undo',async()=>{
  const pa=node('frame'),pb=node('frame'),a=node('rectangle'),b=node('rectangle');pa.transform=[2,0,0,2,0,0];pb.transform=[3,0,0,3,200,0];pa.children=[a.id];pb.children=[b.id];a.strokes=[stroke()];b.strokes=[stroke()];a.strokes[0].width=2;b.strokes[0].width=3;a.opacity=.6;b.opacity=.8
  start([pa,pb,a,b],[a.id,b.id],d=>{d.pages[0].children=[pa.id,pb.id]});await render('strokes');const before=editor.state.doc
  expect(field('描边 1粗细').value).toBe('');await enter(field('描边 1粗细'),'12');const widths=editor.state.doc;expect(widths.nodes[a.id].strokes[0].width).toBe(6);expect(widths.nodes[b.id].strokes[0].width).toBe(4)
  await enter(field('描边 1不透明度 %'),'25');const alpha=editor.state.doc;for(const id of [a.id,b.id])expect(alpha.nodes[id].strokes[0].paint.opacity).toBe(.25);expect(alpha.nodes[a.id].opacity).toBe(.6);expect(alpha.nodes[b.id].opacity).toBe(.8)
  await choose('描边 1位置','outside');const after=editor.state.doc;for(const id of[a.id,b.id])expect(after.nodes[id].strokes[0].align).toBe('outside')
  await type(field('描边 1粗细'),'invalid');await key(field('描边 1粗细'),'Escape');expect(editor.state.doc).toEqual(after)
  await act(async()=>editor.undo());expect(editor.state.doc).toEqual(alpha);await act(async()=>editor.undo());expect(editor.state.doc).toEqual(widths);await act(async()=>editor.undo());expect(editor.state.doc).toEqual(before);await act(async()=>{editor.redo();editor.redo();editor.redo()});expect(editor.state.doc).toEqual(after)
})
test('P08 actual multi stack controls preserve short lists and reject 16-limit addition atomically',async()=>{
  const a=node('rectangle'),b=node('rectangle');a.fills=Array.from({length:16},(_,i)=>paint(i%2?'#112233':'#445566'));b.fills=[paint('#abcdef')]
  // Short list is first: its tentative push must be rolled back when the later full list rejects.
  start([b,a]);await render('fills');const before=editor.state.doc
  await click(button('批量添加填充'));expect(editor.state.message).toContain('每层最多支持 16 项样式');expect(editor.state.doc).toEqual(before);expect(editor.canUndo).toBe(false)
  await click(button('隐藏填充 2'));const hidden=editor.state.doc;expect(hidden.nodes[a.id].fills[1].visible).toBe(false);expect(hidden.nodes[b.id]).toEqual(before.nodes[b.id])
  await click(button('下移填充 2'));const moved=editor.state.doc;expect(moved.nodes[a.id].fills[2].id).toBe(a.fills[1].id);expect(moved.nodes[b.id]).toEqual(before.nodes[b.id])
  await click(button('删除填充 2'));expect(editor.state.doc.nodes[a.id].fills).toHaveLength(15);expect(editor.state.doc.nodes[b.id]).toEqual(before.nodes[b.id])
  await act(async()=>editor.undo());expect(editor.state.doc).toEqual(moved);await act(async()=>editor.undo());expect(editor.state.doc).toEqual(hidden);await act(async()=>editor.undo());expect(editor.state.doc).toEqual(before)
})
test('P10 explicitly selected locked and hidden property targets retain flags and isolate sibling paints',async()=>{
  // Internal explicit-property policy, not a statement about Figma canvas hit eligibility.
  const locked=node('rectangle'),hidden=node('rectangle'),other=node('rectangle');locked.locked=true;hidden.visible=false;locked.fills=[paint('#ff0000')];hidden.fills=[paint('#0000ff')]
  start([locked,hidden,other],[locked.id,hidden.id]);await render('fills');const before=editor.state.doc
  await enter(field('填充 1颜色'),'#abcdef');const after=editor.state.doc
  for(const id of[locked.id,hidden.id])expect(after.nodes[id].fills[0].color).toBe('#abcdef');expect(after.nodes[locked.id].locked).toBe(true);expect(after.nodes[hidden.id].visible).toBe(false);expect(after.nodes[other.id]).toEqual(before.nodes[other.id]);expect(editor.state.version).toBe(1);await history(before,after)
})
