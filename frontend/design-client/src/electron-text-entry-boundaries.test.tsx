// Actual mounted Canvas/event propagation + Editor/WASM. Only the render-device
// boundary is replaced; no native browser, GPU, or pixel-quality claim.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { blank, node } from './model'
import { shortcutPreference } from './shortcut-preference'
import { worldMatrix, apply } from './geometry'
import { MultiSelectionInspector } from './MultiSelectionInspector'
import { PendingEditContext } from './pending-edit-context'
import { interfacePreference } from './interface-preference'
import { nudgePreference } from './nudge-preference'
import { encodeDocumentBinary } from './kernel/binfmt'
import { TextStylePanel } from './TextStylePanel'
import { FontManagementPanel } from './FontManagementPanel'
import { defaultTextStyle, type DesignDocument } from './model'
import { emptySystem } from './design-system'
import { fontTestBytes } from './font-test-fixtures'
import { createHash } from 'node:crypto'
import { subscribePendingEdits, hasPendingEdits } from './pending-edits'

// React must detect DOM input event support before its module is evaluated.
// Match the existing real-text integration harness without suppressing errors.
const bootstrapDom = await vi.hoisted(async () => {
  // @ts-expect-error jsdom is a test-only runtime dependency.
  const { JSDOM } = await import('jsdom')
  const initial = new JSDOM('<!doctype html><html><body></body></html>')
  for (const name of ['window', 'document', 'navigator'])
    vi.stubGlobal(name, name === 'window' ? initial.window : initial.window[name])
  return initial
})
bootstrapDom.window.close()

vi.mock('./kernel/Surface', async () => {
  const { useLayoutEffect } = await import('react')
  return { KernelSurface(props: import('./kernel/Surface').SurfaceProps) {
    useLayoutEffect(() => {
      props.onPresentation?.({ ...props, epoch: props.presentationEpoch!, pixelRatio: 1, managed: false })
    }, [props.document, props.pageId, props.view, props.width, props.height, props.presentationEpoch, props.onPresentation])
    return <div data-testid="surface-boundary" />
  } }
})
let dom: any, root: Root, mount: HTMLDivElement, editor: Editor, errors: unknown[][]
let frames: Map<number, FrameRequestCallback>, frameId: number
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLCanvasElement', 'Element', 'Node', 'Event', 'MouseEvent', 'WheelEvent', 'KeyboardEvent', 'FocusEvent', 'CompositionEvent', 'HTMLSelectElement', 'localStorage'])
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('devicePixelRatio', 1)
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, character => `\\${character}`) })
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  frames = new Map(); frameId = 0
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++frameId, fn); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => 1000 }, clientHeight: { configurable: true, get: () => 800 },
  })
  vi.spyOn(dom.window.HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0, toJSON() {} })
  dom.window.HTMLElement.prototype.setPointerCapture = () => {}
  dom.window.HTMLElement.prototype.hasPointerCapture = () => false
  dom.window.HTMLElement.prototype.releasePointerCapture = () => {}
  vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  errors = []; const error = console.error.bind(console)
  vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args); error(...args) })
  localStorage.clear(); shortcutPreference.set('figma-like'); interfacePreference.reset(); nudgePreference.reset()
  editor = new Editor(blank()); editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false })
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount()); editor.dispose(); dom.window.close()
  vi.unstubAllGlobals(); vi.restoreAllMocks(); expect(errors).toEqual([])
})
const host = () => mount.querySelector<HTMLElement>('[data-testid="canvas"]')!

// Tests-only candidate: actual mounted Canvas/panel events and Editor/WASM.
// Surface presentation/jsdom are doubles; no Electron GUI, physical IME, OS
// font-dialog permissions or external Figma parity claim.
type Mode = 'canvas' | 'style' | 'multi' | 'fonts'
function Harness({ mode }: { mode: Mode }) {
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot), ids = state.selection
  return <PendingEditContext.Provider value={editor}>{mode === 'canvas' ? <Canvas editor={editor} /> : mode === 'style' ? <TextStylePanel editor={editor} node={state.doc.nodes[ids[0]]} ids={ids} /> : mode === 'multi' ? <MultiSelectionInspector editor={editor} nodes={ids.map(id => state.doc.nodes[id])} /> : <FontManagementPanel editor={editor} includeNative={false} />}</PendingEditContext.Provider>
}
async function renderDoc(doc: DesignDocument, ids: string[], mode: Mode = 'canvas') {
  editor.load(doc); editor.select(ids); editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false })
  await act(async () => { root.render(<Harness mode={mode} />); for (let i=0;i<8;i++) await Promise.resolve() })
  if (mode === 'canvas') await act(async () => host().focus())
  return editor.state.doc
}
function field<T extends HTMLElement = HTMLInputElement>(name: string) {
  const element = [...mount.querySelectorAll<HTMLElement>('[aria-label]')].find(e => e.getAttribute('aria-label') === name)
  expect(element, `Missing ${name}`).toBeTruthy(); return element as T
}
function button(name: string) { const b = [...document.querySelectorAll<HTMLButtonElement>('button')].find(e => e.textContent?.trim() === name); expect(b, `Missing ${name}`).toBeTruthy(); return b! }
async function click(element: HTMLElement) { await act(async () => element.click()) }
async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => { input.focus(); const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function key(target: EventTarget, value: string, options: KeyboardEventInit = {}) { await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key:value, bubbles:true, cancelable:true, ...options }))) }
async function choose(name: string, value: string) { const select = field<HTMLSelectElement>(name); await act(async () => { select.value=value; select.dispatchEvent(new Event('change',{bubbles:true})) }) }
async function settle(check: () => boolean) { for(let i=0;i<100&&!check();i++) await act(async()=>{await new Promise(resolve=>setTimeout(resolve,5))}); expect(check()).toBe(true) }
async function oneHistory(before: DesignDocument) {
  const after=editor.state.doc; expect(editor.canUndo).toBe(true)
  await act(async()=>editor.undo()); expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false)
  await act(async()=>editor.redo()); expect(editor.state.doc).toEqual(after); expect(editor.canRedo).toBe(false)
}
function textFixture() {
  const doc=blank('Text entry'), parent=node('frame',100,100,400,200), text=node('text',20,20,240,60), sibling=node('rectangle',300,30,30,30)
  text.text='AB中文CD'; text.fontSize=20; text.textStyle=defaultTextStyle(); parent.children=[text.id,sibling.id]
  doc.nodes=Object.fromEntries([parent,text,sibling].map(n=>[n.id,n]));doc.pages[0].children=[parent.id]
  return {doc,parent,text,sibling}
}
async function openDouble(textId: string) {
  const matrix=worldMatrix(editor.state.doc,textId), point=apply(matrix,{x:5,y:10})
  await act(async()=>host().dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,clientX:point.x,clientY:point.y})))
  expect(editor.state.selection).toEqual([textId]); return field<HTMLTextAreaElement>('画布文字编辑')
}
async function openMenuText(textId: string) {
  await act(async()=>{editor.select([textId]);host().focus()});await key(host(),'ContextMenu')
  await click(button('编辑文字')); await settle(()=>!!mount.querySelector('textarea[aria-label="画布文字编辑"]'))
  return field<HTMLTextAreaElement>('画布文字编辑')
}

test('T01 nested Canvas double-click existing text enters without mutation then Done commits one history',async()=>{
  const f=textFixture();const before=await renderDoc(f.doc,[f.text.id]);const version=editor.state.version
  const input=await openDouble(f.text.id);expect(editor.state.doc).toBe(before);expect(editor.canUndo).toBe(false)
  await type(input,'AB中文 changed CD');expect(editor.state.doc).toBe(before)
  await click(button('完成'));expect(editor.state.doc.nodes[f.text.id].text).toBe('AB中文 changed CD');expect(editor.state.version).toBe(version+1)
  expect(editor.state.doc.nodes[f.parent.id]).toEqual(before.nodes[f.parent.id]);expect(editor.state.doc.nodes[f.sibling.id]).toEqual(before.nodes[f.sibling.id]);expect(mount.querySelector('.rich-text-editor')).toBeNull();await oneHistory(before)
})
test('T02 actual Edit text context menu then Escape preserves exact resources and existing redo',async()=>{
  const f=textFixture();await renderDoc(f.doc,[f.text.id]);await act(async()=>{editor.updateProperties([f.sibling.id],{name:'Redo sibling'});editor.undo()})
  const before=editor.state.doc, bytes=encodeDocumentBinary(before);const input=await openMenuText(f.text.id)
  await type(input,'Discard this rich text');await key(input,'Escape')
  expect(encodeDocumentBinary(editor.state.doc)).toEqual(bytes);expect(editor.state.doc).toBe(before);expect(editor.canUndo).toBe(false);expect(editor.canRedo).toBe(true)
  expect(mount.querySelector('.rich-text-editor')).toBeNull();expect(document.activeElement).toBe(host())
  await act(async()=>editor.redo());expect(editor.state.doc.nodes[f.sibling.id].name).toBe('Redo sibling')
})
test('T03 actual Unicode-range toolbar weight/color preserves outside runs, commits once and cancels reopened changes',async()=>{
  const f=textFixture();f.doc.schemaVersion=4;f.text.textRuns=[{start:0,end:2,color:'#112233',weight:500},{start:2,end:4,underline:true},{start:4,end:6,color:'#445566',weight:600}]
  const before=await renderDoc(f.doc,[f.text.id]), input=await openDouble(f.text.id)
  await act(async()=>{input.setSelectionRange(2,4);input.dispatchEvent(new Event('select',{bubbles:true}));document.dispatchEvent(new Event('selectionchange',{bubbles:true}))})
  await type(field('选中文字字重'),'700');await type(field('选中文字颜色'),'#ff0000');expect(editor.state.doc).toBe(before)
  await click(button('完成'));const after=editor.state.doc,runs=after.nodes[f.text.id].textRuns!
  expect(runs).toEqual([{start:0,end:2,color:'#112233',weight:500},{start:2,end:4,underline:true,weight:700,color:'#ff0000'},{start:4,end:6,color:'#445566',weight:600}])
  expect(after.nodes[f.text.id].text).toBe(before.nodes[f.text.id].text);await oneHistory(before)
  await openMenuText(f.text.id);await type(field('选中文字字重'),'300');await click(button('取消'));expect(editor.state.doc).toEqual(after);expect(editor.canRedo).toBe(false)
})
test('T04 mounted IME vetoes same-ID load; cancel permits replacement and stale completion cannot overwrite it',async()=>{
  const f=textFixture();const before=await renderDoc(f.doc,[f.text.id]), input=await openDouble(f.text.id), generation=editor.sessionGeneration
  await type(input,'Dirty draft');await act(async()=>input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'文'})))
  const replacement=structuredClone(before);replacement.nodes[f.text.id].text='Replacement text'
  await act(async()=>expect(editor.load(replacement)).toBe(false));expect(editor.sessionGeneration).toBe(generation);expect(editor.state.doc).toBe(before)
  await act(async()=>input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'文'})));await key(input,'Escape')
  await act(async()=>expect(editor.load(replacement)).toBe(true));const adopted=editor.state.doc
  await act(async()=>{input.value='Late old draft';input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'旧'}));input.dispatchEvent(new FocusEvent('blur',{bubbles:true}))})
  expect(editor.sessionGeneration).not.toBe(generation);expect(editor.state.doc).toBe(adopted);expect(adopted.nodes[f.text.id].text).toBe('Replacement text');expect(adopted.fonts).toEqual(before.fonts);expect(editor.canUndo).toBe(false)
})
test('T05 mounted variation rows reject reserved/invalid drafts, repair custom axis, remove and undo each accepted edit',async()=>{
  const f=textFixture();const before=await renderDoc(f.doc,[f.text.id],'style')
  await click(field('添加变体轴'));await type(field('变体轴标签 1'),'wght');await type(field('变体轴数值 1'),'75');await key(field('变体轴数值 1'),'Enter')
  expect(editor.state.doc).toBe(before);expect(editor.canUndo).toBe(false);expect(mount.textContent).toContain('wght 由字重字段控制')
  await type(field('变体轴数值 1'),'bad');await type(field('变体轴标签 1'),'wdth');await key(field('变体轴标签 1'),'Enter');expect(editor.state.doc).toBe(before)
  await type(field('变体轴数值 1'),'75');await key(field('变体轴数值 1'),'Enter');expect(editor.state.doc.nodes[f.text.id].textStyle?.variations).toEqual([{tag:'wdth',value:75}]);await oneHistory(before)
  const withAxis=editor.state.doc;await click(field('删除变体轴 1'));expect(editor.state.doc.nodes[f.text.id].textStyle?.variations??[]).toEqual([])
  await act(async()=>editor.undo());expect(editor.state.doc).toEqual(withAxis);await act(async()=>editor.redo());expect(editor.state.doc.nodes[f.text.id].textStyle?.variations??[]).toEqual([])
})
test('T06 scaled multi-text actual relative font-size field clears only run sizes, explicit locked property policy and cancel',async()=>{
  const doc=blank(),p=node('frame',0,0,400,200),a=node('text',10,10,100,30),b=node('text',500,10,100,30),other=node('rectangle',700,10,30,30)
  doc.schemaVersion=4;p.transform=[2,0,0,2,0,0];p.children=[a.id];a.fontSize=10;b.fontSize=20;a.locked=true
  for(const n of [a,b]){n.text='ABC';n.textStyle=defaultTextStyle();n.textRuns=[{start:0,end:2,fontSize:30,weight:700,color:'#123456',underline:true}]}
  doc.nodes=Object.fromEntries([p,a,b,other].map(n=>[n.id,n]));doc.pages[0].children=[p.id,b.id,other.id]
  const before=await renderDoc(doc,[a.id,b.id],'multi');expect(field('字号').value).toBe('20')
  await type(field('字号'),'+=4');await key(field('字号'),'Enter')
  expect(editor.state.doc.nodes[a.id].fontSize).toBe(12);expect(editor.state.doc.nodes[b.id].fontSize).toBe(24)
  for(const n of [a,b])expect(editor.state.doc.nodes[n.id].textRuns).toEqual([{start:0,end:2,weight:700,color:'#123456',underline:true}])
  expect(editor.state.doc.nodes[a.id].locked).toBe(true);expect(editor.state.doc.nodes[other.id]).toEqual(before.nodes[other.id]);await oneHistory(before)
  await act(async()=>editor.undo());await type(field('字号'),'invalid');await key(field('字号'),'Escape');expect(editor.state.doc).toEqual(before);expect(editor.canRedo).toBe(true)
})
test('T07 actual font replacement scope/fallback/detach controls preserve locks, resources and linked style',async()=>{
  const doc=blank(),locked=node('frame',0,0,200,100),a=node('text',0,0,100,30),hidden=node('text',300,0,100,30),linked=node('text',400,0,100,30)
  doc.schemaVersion=4;const data=fontTestBytes('noto-latin').toString('base64');doc.fonts={latin:{family:'Latin',data,index:0}};locked.locked=true;locked.children=[a.id];hidden.visible=false
  for(const n of [a,hidden,linked]){n.text='ABC';n.textStyle={...defaultTextStyle(),fallbacks:['default']};n.textRuns=[{start:0,end:1,fontId:'default',weight:600,color:'#123456'}]}
  doc.designSystem=emptySystem();doc.designSystem.styles.body={name:'Body',kind:'text',value:{...defaultTextStyle(),fallbacks:['default']}};linked.styleRefs={textStyle:'body'}
  doc.nodes=Object.fromEntries([locked,a,hidden,linked].map(n=>[n.id,n]));doc.pages[0].children=[locked.id,hidden.id,linked.id]
  const before=await renderDoc(doc,[hidden.id],'fonts');await choose('目标字体','latin');await choose('字体替换范围','document');await click(button('替换匹配的字体'))
  expect(editor.state.doc.nodes[a.id]).toEqual(before.nodes[a.id]);expect(editor.state.doc.nodes[linked.id]).toEqual(before.nodes[linked.id]);expect(editor.state.doc.nodes[hidden.id].textStyle?.fontId).toBe('latin');expect(editor.state.doc.nodes[hidden.id].textStyle?.fallbacks).toEqual(['default']);expect(editor.state.doc.nodes[hidden.id].visible).toBe(false);await oneHistory(before)
  await act(async()=>editor.undo());await click(field('同时替换后备字体'))
  const detach=[...mount.querySelectorAll<HTMLLabelElement>('label')].find(l=>l.textContent?.includes('转为本地文字样式'))!.querySelector<HTMLInputElement>('input')!;await click(detach);await click(button('替换匹配的字体'))
  const after=editor.state.doc;expect(after.nodes[a.id]).toEqual(before.nodes[a.id]);for(const n of [hidden,linked]){expect(after.nodes[n.id].textStyle?.fontId).toBe('latin');expect(after.nodes[n.id].textStyle?.fallbacks).toEqual(['latin']);expect(after.nodes[n.id].textRuns).toEqual([{start:0,end:1,fontId:'latin',weight:600,color:'#123456'}])}
  expect(after.nodes[linked.id].styleRefs?.textStyle).toBeUndefined();expect(after.designSystem).toEqual(before.designSystem);expect(after.fonts).toEqual(before.fonts);await oneHistory(before)
})
test('T08 real local-font input pending bytes meets new invalid draft across locale, blocks then corrected retry commits once',async()=>{
  const f=textFixture();const before=await renderDoc(f.doc,[f.text.id],'style'),bytes=new Uint8Array(fontTestBytes('noto-latin')), id=createHash('sha256').update(bytes).digest('hex')
  let resolve!:(value:ArrayBuffer)=>void;const pending=new Promise<ArrayBuffer>(done=>{resolve=done})
  const file=mount.querySelector<HTMLInputElement>('input[type=file][accept=".ttf,.otf"]')!,read=vi.fn(()=>pending)
  Object.defineProperty(file,'files',{configurable:true,value:[{name:'local.ttf',size:bytes.length,arrayBuffer:read}]})
  await act(async()=>file.dispatchEvent(new Event('change',{bubbles:true})));expect(read).toHaveBeenCalledTimes(1)
  const notification=vi.spyOn(editor,'notify'),fallback=field('后备字体');await type(fallback,'missing-resource');await act(async()=>interfacePreference.set({locale:'en'}))
  notification.mockClear();await act(async()=>resolve(bytes.slice().buffer));await settle(()=>notification.mock.calls.length>0)
  expect(editor.state.doc).toBe(before);expect(editor.canUndo).toBe(false);expect(fallback.value).toBe('missing-resource');expect(editor.state.doc.fonts?.[id]).toBeUndefined()
  await act(async()=>interfacePreference.set({locale:'zh-CN'}));await type(field('后备字体'),'');await act(async()=>field('后备字体').blur())
  Object.defineProperty(file,'files',{configurable:true,value:[{name:'local.ttf',size:bytes.length,arrayBuffer:async()=>bytes.slice().buffer}]})
  await act(async()=>file.dispatchEvent(new Event('change',{bubbles:true})));await settle(()=>!!editor.state.doc.fonts?.[id])
  expect(Object.keys(editor.state.doc.fonts!)).toEqual([id]);expect(editor.state.doc.fonts![id].data).toBe(Buffer.from(bytes).toString('base64'));expect(editor.state.doc.nodes[f.text.id].textStyle?.fontId).toBe(id);expect(editor.state.doc.nodes[f.sibling.id]).toEqual(before.nodes[f.sibling.id]);await oneHistory(before)
})


for (const finish of ['Escape', 'Done'] as const) test(`T02 focus contract ${finish}: next actual focused-target menu keyboard route works`,async()=>{
  const f=textFixture();const before=await renderDoc(f.doc,[f.text.id]);const input=await openMenuText(f.text.id)
  await type(input,'Updated via focused route')
  if(finish==='Escape')await key(input,'Escape');else await click(button('完成'))
  const active=document.activeElement!;await key(active,finish==='Escape'?'ContextMenu':'F10',finish==='Done'?{shiftKey:true}:{})
  expect(document.querySelector('[role="menu"]')).not.toBeNull();expect(button('编辑文字')).toBeTruthy()
  if(finish==='Escape'){expect(editor.state.doc).toBe(before);expect(editor.canUndo).toBe(false)}
  else{expect(editor.state.doc.nodes[f.text.id].text).toBe('Updated via focused route');await oneHistory(before)}
})
test('T02 external blur commits text without stealing the destination input focus',async()=>{
  const f=textFixture();const before=await renderDoc(f.doc,[f.text.id]);const input=await openDouble(f.text.id)
  await type(input,'Committed by external blur');const outside=document.createElement('input');outside.setAttribute('aria-label','External destination');document.body.append(outside)
  await act(async()=>outside.focus());expect(document.activeElement).toBe(outside);expect(mount.querySelector('.rich-text-editor')).toBeNull()
  expect(editor.state.doc.nodes[f.text.id].text).toBe('Committed by external blur');await oneHistory(before)
  expect(document.activeElement).toBe(outside);outside.remove()
})
test('T02 same-ID session adopted synchronously before old close cannot lose destination focus or content',async()=>{
  const f=textFixture();const before=await renderDoc(f.doc,[f.text.id]);const input=await openDouble(f.text.id);await type(input,'Old cancelled draft')
  const outside=document.createElement('input');document.body.append(outside);const generation=editor.sessionGeneration
  let calls=0,adopted=before
  const unsubscribe=subscribePendingEdits(editor,()=>{
    if(hasPendingEdits(editor))return
    unsubscribe();calls++
    const next=structuredClone(before);next.nodes[f.text.id].text='New same-ID session';expect(editor.load(next)).toBe(true);editor.select([f.text.id]);adopted=editor.state.doc;outside.focus()
  })
  try{
    await key(input,'Escape');expect(calls).toBe(1);expect(editor.sessionGeneration).not.toBe(generation)
    expect(editor.state.doc).toBe(adopted);expect(editor.state.doc.nodes[f.text.id].text).toBe('New same-ID session');expect(document.activeElement).toBe(outside)
    expect(editor.canUndo).toBe(false);expect(editor.canRedo).toBe(false)
  }finally{unsubscribe();outside.remove()}
})

for(const finish of ['Cancel','ModEnter'] as const)test(`T02 focus contract ${finish}: actual focused-target ContextMenu entry`,async()=>{
  const f=textFixture();const before=await renderDoc(f.doc,[f.text.id]),input=await openDouble(f.text.id);await type(input,'Explicit exit draft')
  if(finish==='Cancel')await click(button('取消'));else await key(input,'Enter',{metaKey:true})
  await key(document.activeElement!,'ContextMenu');expect(document.querySelector('[role="menu"]')).not.toBeNull();expect(button('编辑文字')).toBeTruthy()
  if(finish==='Cancel'){expect(editor.state.doc).toBe(before);expect(editor.canUndo).toBe(false)}else{expect(editor.state.doc.nodes[f.text.id].text).toBe('Explicit exit draft');await oneHistory(before)}
})
test('T02 same-session restoration subscriber opens a second actual text entry; old close cannot clear or focus it away',async()=>{
  const f=textFixture(),second=node('text',20,100,180,50);second.text='Second live entry';second.textStyle=defaultTextStyle();second.fontSize=20;f.doc.nodes[second.id]=second;f.parent.children.push(second.id)
  const before=await renderDoc(f.doc,[f.text.id]),input=await openDouble(f.text.id);await type(input,'Discard first draft')
  const generation=editor.sessionGeneration;let opened=0
  const unsubscribe=subscribePendingEdits(editor,()=>{
    if(hasPendingEdits(editor))return
    unsubscribe();opened++
    const point=apply(worldMatrix(editor.state.doc,second.id),{x:5,y:10})
    host().dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,clientX:point.x,clientY:point.y}))
  })
  try{
    await key(input,'Escape');expect(opened).toBe(1);expect(editor.sessionGeneration).toBe(generation)
    const next=field<HTMLTextAreaElement>('画布文字编辑');expect(next).not.toBe(input);expect(next.value).toBe('Second live entry');expect(document.activeElement).toBe(next)
    expect(editor.state.selection).toEqual([second.id]);expect(editor.state.doc).toBe(before);expect(editor.canUndo).toBe(false)
    await type(next,'Second entry committed');await click(button('完成'));expect(editor.state.doc.nodes[second.id].text).toBe('Second entry committed');expect(editor.state.doc.nodes[f.text.id]).toEqual(before.nodes[f.text.id]);await oneHistory(before)
  }finally{unsubscribe()}
})

test('T02 active rich-text SVG double-click cannot remount the same entry or discard its dirty draft',async()=>{
  const f=textFixture();const before=await renderDoc(f.doc,[f.text.id]),input=await openDouble(f.text.id)
  await type(input,'Dirty same-node draft');expect(hasPendingEdits(editor)).toBe(true)
  const surface=mount.querySelector<SVGSVGElement>('.rich-text-editor svg')!;expect(surface).not.toBeNull()
  const point=apply(worldMatrix(editor.state.doc,f.text.id),{x:5,y:10})
  await act(async()=>surface.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,clientX:point.x,clientY:point.y})))
  expect(field<HTMLTextAreaElement>('画布文字编辑')).toBe(input);expect(input.value).toBe('Dirty same-node draft');expect(hasPendingEdits(editor)).toBe(true)
  expect(editor.state.doc).toBe(before);expect(editor.canUndo).toBe(false)
  await click(button('完成'));expect(editor.state.doc.nodes[f.text.id].text).toBe('Dirty same-node draft');await oneHistory(before)
  const first=editor.state.doc,reopened=await openDouble(f.text.id);expect(reopened).not.toBe(input);expect(reopened.value).toBe('Dirty same-node draft')
  await type(reopened,'Closed then reopened draft');await click(button('完成'));const second=editor.state.doc
  expect(second.nodes[f.text.id].text).toBe('Closed then reopened draft')
  await act(async()=>editor.undo());expect(editor.state.doc).toEqual(first)
  await act(async()=>editor.undo());expect(editor.state.doc).toEqual(before);expect(editor.canUndo).toBe(false)
  await act(async()=>{editor.redo();editor.redo()});expect(editor.state.doc).toEqual(second)
})
