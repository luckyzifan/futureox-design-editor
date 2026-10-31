// Real mounted layout panel and Editor; does not certify native GUI layout.
// @ts-expect-error jsdom runtime dependency
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, test, expect, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'
import { interfacePreference } from './interface-preference'
import { LayoutPanel } from './LayoutPanel'
import { previewLayoutSuggestion } from './layout-suggestions'
const bootstrap = await vi.hoisted(async () => {
  // @ts-expect-error jsdom runtime dependency
  const { JSDOM } = await import('jsdom')
  const d = new JSDOM('<html><body></body></html>')
  for (const k of ['window','document','navigator']) vi.stubGlobal(k,k === 'window' ? d.window : d.window[k])
  return d
})
bootstrap.window.close()
let dom:any, root:Root, editor:Editor
beforeEach(() => {
  dom = new JSDOM('<html><body><button id="trigger">Open</button><div id="mount"></div></body></html>',{url:'https://design.invalid/'})
  for(const k of ['window','document','navigator','HTMLElement','HTMLInputElement','HTMLSelectElement','Node','Event','MouseEvent','KeyboardEvent','localStorage']) vi.stubGlobal(k,k === 'window' ? dom.window : dom.window[k])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  interfacePreference.reset(); editor=new Editor(blank('作者文档'))
  root=createRoot(document.getElementById('mount')!); document.getElementById('trigger')!.focus()
})
afterEach(async()=>{await act(async()=>root.unmount());editor.dispose();dom.window.close();vi.restoreAllMocks();vi.unstubAllGlobals()})
const locale=(v:'en'|'zh-CN')=>act(async()=>{interfacePreference.set({locale:v})})
async function click(el:Element){await act(async()=>el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})))}

let frameId: string
function fixture(ambiguous = false) {
  const d=blank('作者文档'), frame=node('frame',0,0,300,100)
  frame.name='Wrapped rows: horizontal'; frameId=frame.id; d.nodes[frame.id]=frame; d.pages[0].children=[frame.id]
  for(const x of [10, ambiguous ? 20 : 60]) { const child=node('rectangle',x,10,40,30);d.nodes[child.id]=child;frame.children.push(child.id) }
  editor.dispose(); editor=new Editor(d);editor.select([frame.id])
}
const button=(label:string)=>[...document.querySelectorAll('button')].find(b=>b.textContent===label)!
const geometry=()=>Object.fromEntries(Object.values(editor.state.doc.nodes).map(n=>[n.id,[n.transform,n.width,n.height]]))
async function mountLayout(){await act(async()=>root.render(<LayoutPanel editor={editor} node={editor.state.doc.nodes[frameId]} ids={[frameId]}/>))}
test('layout locale changes existing candidate button and text without preview or mutation',async()=>{
 fixture();const before=editor.state.doc, expected=previewLayoutSuggestion(before,frameId), spy=vi.spyOn(editor,'previewSuggestedLayout')
 await mountLayout();await click(button('建议自动布局…'));const apply=button('应用此方案');expect(apply).toBeDefined();apply.focus()
 expect(document.querySelector('[role="region"] strong')!.textContent).toBe('横向布局 · 100%')
 const preview=spy.mock.results[0].value, previewJSON=JSON.stringify(preview);expect(preview.fingerprint).toBe(expected.fingerprint);expect(preview.suggestions[0].label).toBe('horizontal')
 await locale('en');expect(button('Apply proposal')).toBe(apply);expect(document.activeElement).toBe(apply)
 expect(document.querySelector('[role="region"] strong')!.textContent).toBe('Horizontal layout · 100%')
 expect(document.querySelector('[role="region"]')!.textContent).toContain('Wrapped rows: horizontal')
 expect(spy).toHaveBeenCalledTimes(1);expect(spy.mock.results[0].value).toBe(preview);expect(JSON.stringify(preview)).toBe(previewJSON);expect(editor.state.doc).toBe(before);expect(editor.canUndo).toBe(false)
 const g=geometry();await click(apply);expect(spy).toHaveBeenCalledTimes(2);expect(geometry()).toEqual(g);expect(editor.state.doc.nodes[frameId].layout?.mode).toBe('horizontal')
 await act(async()=>editor.undo());expect(editor.state.doc).toEqual(before);expect(editor.canUndo).toBe(false)
})
test('ambiguous warning preserves colon-containing author name and raw API warning',async()=>{
 fixture(true);const before=editor.state.doc, raw=previewLayoutSuggestion(before,frameId)
 expect(raw.warnings).toEqual(['Wrapped rows: horizontal: irregular spacing, overlap or ambiguous geometry; no automatic rearrangement'])
 await mountLayout();await click(button('建议自动布局…'))
 expect(document.querySelector('[role="region"]')!.textContent).toContain('Wrapped rows: horizontal：间距不规则、重叠或几何关系不明确；不会自动重新排列')
 await locale('en');expect(document.querySelector('[role="region"]')!.textContent).toContain(raw.warnings[0])
 expect(previewLayoutSuggestion(before,frameId).warnings).toEqual(raw.warnings);expect(editor.state.doc).toBe(before)
})
test('locale retains preview, apply still rejects stale revision without mutation',async()=>{
 fixture();await mountLayout();await click(button('建议自动布局…'));const apply=button('应用此方案')
 await act(async()=>editor.change('作者历史',draft=>{draft.name='用户新名称'}));const before=editor.state.doc
 await click(apply);expect(document.querySelector('[role="alert"]')!.textContent).toBe('Error: 布局预览已过期，请重新预览后应用')
 await locale('en');expect(button('Apply proposal')).toBe(apply);expect(document.querySelector('[role="alert"]')!.textContent).toBe('Error: Layout preview is stale; preview again before applying')
 expect(editor.state.doc).toBe(before)
})

for (const [kind, expected] of [
 ['locked', 'Wrapped rows: horizontal：锁定、隐藏或组件子树保持不变'],
 ['responsive', 'Wrapped rows: horizontal：锁定、变换或响应式子项需要显式编辑布局'],
 ['ancestor', '锁定、隐藏或组件祖先：子树保持不变'],
] as const) {
 test(`structured ${kind} warning translates without changing raw warning or document`,async()=>{
  fixture();const d=structuredClone(editor.state.doc),frame=d.nodes[frameId]
  if(kind==='locked'){const nested=node('frame',150,10,40,40);nested.name=frame.name;nested.locked=true;d.nodes[nested.id]=nested;frame.children.push(nested.id)}
  if(kind==='responsive') d.nodes[frame.children[0]].locked=true
  if(kind==='ancestor'){const parent=node('frame',0,0,400,400);parent.locked=true;parent.children=[frameId];d.nodes[parent.id]=parent;d.pages[0].children=[parent.id]}
  editor.dispose();editor=new Editor(d);editor.select([frameId]);const before=editor.state.doc, raw=previewLayoutSuggestion(before,frameId)
  const spy=vi.spyOn(editor,'previewSuggestedLayout').mockReturnValue({...raw,revision:editor.state.version})
  await mountLayout();const trigger=button('建议自动布局…');expect(trigger).toBeDefined()
  await click(trigger);expect(document.querySelector('[role="region"]')!.textContent).toContain(expected)
  await locale('en');for(const warning of raw.warnings)expect(document.querySelector('[role="region"]')!.textContent).toContain(warning)
  expect(spy).toHaveBeenCalledTimes(1);expect(previewLayoutSuggestion(before,frameId).warnings).toEqual(raw.warnings);expect(editor.state.doc).toBe(before)
 })
}
for(const diagnostic of ['constructor','toString','__proto__']) {
 test(`unknown layout error ${diagnostic} remains exact across locales`,async()=>{
  fixture();vi.spyOn(editor,'previewSuggestedLayout').mockImplementation(()=>{throw diagnostic})
  await mountLayout();await click(button('建议自动布局…'));expect(document.querySelector('[role="alert"]')!.textContent).toBe(diagnostic)
  await locale('en');expect(document.querySelector('[role="alert"]')!.textContent).toBe(diagnostic)
  expect(editor.canUndo).toBe(false)
 })
}
test('legacy preview lacking display metadata keeps every raw string instead of guessing author names',async()=>{
 fixture();const raw=previewLayoutSuggestion(editor.state.doc,frameId)
 const legacy={frameId:raw.frameId,fingerprint:raw.fingerprint,revision:editor.state.version,inspectedNodes:raw.inspectedNodes,
  suggestions:raw.suggestions.map(c=>({id:c.id,label:'constructor',confidence:c.confidence,changes:c.changes,explanation:['作者: horizontal','__proto__']})),warnings:['toString']}
 vi.spyOn(editor,'previewSuggestedLayout').mockReturnValue(legacy)
 await mountLayout();await click(button('建议自动布局…'));await locale('en')
 const region=document.querySelector('[role="region"]')!;for(const value of ['constructor','作者: horizontal','__proto__','toString'])expect(region.textContent).toContain(value)
 expect(editor.canUndo).toBe(false)
})


test('grid and wrapped alternatives retain preview, wrapped button and geometry across locale round-trip',async()=>{
 fixture();const d=structuredClone(editor.state.doc),frame=d.nodes[frameId];frame.height=200
 for(const x of [10,60]){const child=node('rectangle',x,50,40,30);d.nodes[child.id]=child;frame.children.push(child.id)}
 editor.dispose();editor=new Editor(d);editor.select([frameId]);const before=editor.state.doc, g=geometry(), spy=vi.spyOn(editor,'previewSuggestedLayout')
 await mountLayout();await click(button('建议自动布局…'))
 const region=document.querySelector('[role="region"]')!, candidates=[...region.querySelectorAll('strong')], applies=[...region.querySelectorAll('button')].filter(b=>b.textContent==='应用此方案'), wrapped=applies[1]
 expect(candidates.map(el=>el.textContent)).toEqual(['网格布局 · 100%','换行排列 · 85%']);expect(wrapped).toBeDefined();wrapped.focus()
 const preview=spy.mock.results[0].value, snapshot=JSON.stringify(preview)
 expect(preview.suggestions.map((c:any)=>c.id)).toEqual(['preserve-geometry','wrapped-rows']);expect(preview.suggestions.map((c:any)=>c.label)).toEqual(['grid','Wrapped rows'])
 await locale('en');expect([...region.querySelectorAll('strong')].map(el=>el.textContent)).toEqual(['Grid layout · 100%','Wrapped rows · 85%']);expect([...region.querySelectorAll('button')].filter(b=>b.textContent==='Apply proposal')[1]).toBe(wrapped);expect(document.activeElement).toBe(wrapped)
 await locale('zh-CN');expect([...region.querySelectorAll('button')].filter(b=>b.textContent==='应用此方案')[1]).toBe(wrapped);expect(document.activeElement).toBe(wrapped)
 expect(spy).toHaveBeenCalledTimes(1);expect(spy.mock.results[0].value).toBe(preview);expect(JSON.stringify(preview)).toBe(snapshot);expect(editor.state.doc).toBe(before)
 await click(wrapped);expect(spy).toHaveBeenCalledTimes(2);expect(editor.state.doc.nodes[frameId].layout).toMatchObject({mode:'horizontal',wrap:true});expect(geometry()).toEqual(g)
 const after=editor.state.doc;await act(async()=>editor.undo());expect(editor.state.doc).toEqual(before);expect(editor.canUndo).toBe(false);await act(async()=>editor.redo());expect(editor.state.doc).toEqual(after);expect(geometry()).toEqual(g)
})

test('nested explanation order and frame parameters remain authored through locale round-trip',async()=>{
 fixture();const d=blank('Nested 作者'),outer=node('frame',0,0,300,180);outer.name='外层: horizontal';frameId=outer.id;d.nodes[outer.id]=outer;d.pages[0].children=[outer.id]
 for(const [index,x] of [10,120].entries()) {const inner=node('frame',x,10,100,100);inner.name=`作者 ${index}: Nested layouts`;d.nodes[inner.id]=inner;outer.children.push(inner.id);for(const y of [10,50]){const child=node('rectangle',10,y,20,30);d.nodes[child.id]=child;inner.children.push(child.id)}}
 editor.dispose();editor=new Editor(d);editor.select([frameId]);const before=editor.state.doc,spy=vi.spyOn(editor,'previewSuggestedLayout')
 await mountLayout();await click(button('建议自动布局…'));const region=document.querySelector('[role="region"]')!,preview=spy.mock.results[0].value,snapshot=JSON.stringify(preview)
 expect(region.querySelector('strong')!.textContent).toBe('嵌套布局 · 100%');expect(preview.suggestions[0].changes).toHaveLength(3)
 const summaries=preview.suggestions[0].changes.map((c:any)=>`${before.nodes[c.frameId].name}：${c.layout.mode==='horizontal'?'横向布局':'纵向布局'}，间距 ${c.layout.gap}，对齐 起点`)
 const chinese=[...region.querySelectorAll('p')].map(p=>p.textContent);expect(chinese.slice(3)).toEqual(summaries)
 await locale('en');expect(region.querySelector('strong')!.textContent).toBe('Nested layouts · 100%');expect([...region.querySelectorAll('p')].map(p=>p.textContent).slice(1)).toEqual(preview.suggestions[0].explanation)
 await locale('zh-CN');expect([...region.querySelectorAll('p')].map(p=>p.textContent).slice(3)).toEqual(summaries)
 expect(spy).toHaveBeenCalledTimes(1);expect(JSON.stringify(preview)).toBe(snapshot);expect(editor.state.doc).toBe(before);expect(editor.canUndo).toBe(false)
})
