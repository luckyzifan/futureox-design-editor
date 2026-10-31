// DRAFT NOT RUN: C05/C07 continuous actual mounted input chains.
// JSDOM/Surface/native clipboard are bounded doubles. Real Editor/WASM/FD codec.
// No OS IME, clipboard permission, GUI, or external Figma acceptance.
import { MultiStylePanel } from './MultiStylePanel'
import type { DesktopClipboard, DesktopCommand } from './desktop'
// Actual mounted Canvas/event propagation + Editor/WASM. Only the render-device
// boundary is replaced; no native browser, GPU, or pixel-quality claim.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { blank, node, paint } from './model'
import { shortcutPreference } from './shortcut-preference'
import { worldMatrix, apply } from './geometry'
import { MultiSelectionInspector } from './MultiSelectionInspector'
import { PendingEditContext } from './pending-edit-context'
import { interfacePreference } from './interface-preference'
import { nudgePreference } from './nudge-preference'
import { decodeDocumentBinary, encodeDocumentBinary } from './kernel/binfmt'
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
type Mode = 'canvas' | 'style' | 'multi' | 'fonts' | 'fills'
function Harness({ mode }: { mode: Mode }) {
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot), ids = state.selection
  return <PendingEditContext.Provider value={editor}>{mode === 'fills' ? <MultiStylePanel editor={editor} nodes={ids.map(id=>state.doc.nodes[id])} field="fills" /> : mode === 'canvas' ? <Canvas editor={editor} /> : mode === 'style' ? <TextStylePanel editor={editor} node={state.doc.nodes[ids[0]]} ids={ids} /> : mode === 'multi' ? <MultiSelectionInspector editor={editor} nodes={ids.map(id => state.doc.nodes[id])} /> : <FontManagementPanel editor={editor} includeNative={false} />}</PendingEditContext.Provider>
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


async function mode(value: Mode) { await act(async()=>root.render(<Harness mode={value}/>)) }
async function undoTo(expected: DesignDocument) { await act(async()=>editor.undo()); expect(editor.state.doc).toEqual(expected) }
async function redoTo(expected: DesignDocument) { await act(async()=>editor.redo()); expect(editor.state.doc).toEqual(expected) }
function reopenExact(expected: DesignDocument) {
  // Actual native FD encode/decode into a fresh Editor. Memory transport, not an OS save dialog.
  const bytes=encodeDocumentBinary(expected), reopened=new Editor(decodeDocumentBinary(bytes) as DesignDocument)
  try { expect(reopened.state.doc).toEqual(expected); expect(encodeDocumentBinary(reopened.state.doc)).toEqual(bytes); expect(reopened.canUndo).toBe(false); expect(reopened.canRedo).toBe(false) } finally { reopened.dispose() }
}

test('C05 continuous menu text / IME / locale / invalid draft / cancel / commit / canvas nudge / undo-redo / FD reopen', async()=>{
  const f=textFixture(); f.doc.schemaVersion=4
  f.doc.fonts={latin:{family:'Latin',data:fontTestBytes('noto-latin').toString('base64'),index:0}}
  f.text.textStyle={...defaultTextStyle(),fontId:'latin'}
  f.text.textRuns=[{start:0,end:2,weight:500,color:'#112233'},{start:2,end:4,underline:true},{start:4,end:6,weight:600,color:'#445566'}]
  await renderDoc(f.doc,[f.text.id]); await act(async()=>{editor.updateProperties([f.sibling.id],{name:'Existing redo'});editor.undo()})
  const before=editor.state.doc, generation=editor.sessionGeneration, input=await openMenuText(f.text.id)
  await act(async()=>input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'中文'})))
  await type(input,'AB中文输入CD')
  await act(async()=>input.setSelectionRange(2,6)); const range=[input.selectionStart,input.selectionEnd]
  await act(async()=>interfacePreference.set({locale:'en'}))
  expect(mount.querySelector('textarea')).toBe(input); expect(document.activeElement).toBe(input);expect(input.value).toBe('AB中文输入CD');expect([input.selectionStart,input.selectionEnd]).toEqual(range)
  await key(input,'Enter',{isComposing:true});await key(input,'Escape',{isComposing:true})
  expect(mount.querySelector('textarea')).toBe(input);expect(editor.state.doc).toBe(before);expect(editor.sessionGeneration).toBe(generation)
  await act(async()=>{input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文输入'}));interfacePreference.set({locale:'zh-CN'})})
  await act(async()=>{input.setSelectionRange(2,4);input.dispatchEvent(new Event('select',{bubbles:true}));document.dispatchEvent(new Event('selectionchange',{bubbles:true}))})
  await type(field('选中文字字重'),'700');expect(editor.state.doc).toBe(before)
  await click(button('取消'));expect(editor.state.doc).toEqual(before);expect(editor.canRedo).toBe(true);expect(editor.canUndo).toBe(false)
  // Actual draft-aware numeric field with a supported Escape cancellation contract.
  await mode('multi');await type(field('字号'),'invalid');await key(field('字号'),'Enter')
  expect(editor.state.doc).toEqual(before);await key(field('字号'),'Escape');expect(editor.canRedo).toBe(true)
  await mode('canvas');const second=await openMenuText(f.text.id)
  await act(async()=>{second.setSelectionRange(2,4);second.dispatchEvent(new Event('select',{bubbles:true}));document.dispatchEvent(new Event('selectionchange',{bubbles:true}))})
  await type(field('选中文字字重'),'700');await click(button('完成'))
  const committed=editor.state.doc
  expect(committed.nodes[f.text.id].textRuns).toEqual([{start:0,end:2,weight:500,color:'#112233'},{start:2,end:4,underline:true,weight:700},{start:4,end:6,weight:600,color:'#445566'}])
  expect(committed.fonts).toEqual(before.fonts);expect(document.activeElement).toBe(host());expect(editor.canRedo).toBe(false)
  await key(document.activeElement!,'ArrowRight')
  // A completed physical key action includes release, which commits the held-key nudge.
  await act(async()=>document.activeElement!.dispatchEvent(new KeyboardEvent('keyup',{key:'ArrowRight',bubbles:true,cancelable:true})))
  expect(editor.interactionActive).toBe(false);const moved=editor.state.doc
  expect(moved.nodes[f.text.id].transform[4]).toBe(committed.nodes[f.text.id].transform[4]+1)
  expect(moved.nodes[f.text.id].textRuns).toEqual(committed.nodes[f.text.id].textRuns);expect(moved.nodes[f.sibling.id]).toEqual(before.nodes[f.sibling.id])
  await undoTo(committed);await undoTo(before);expect(editor.canUndo).toBe(false);await redoTo(committed);await redoTo(moved);expect(editor.canRedo).toBe(false);reopenExact(moved)
})

test('C07 continuous mixed paint / locale-invalid-cancel / font scope-detach-fallback / clipboard collision / FD reopen',async()=>{
  const doc=blank(),locked=node('frame'),blocked=node('text'),a=node('text',300,0,150,40),linked=node('text',500,0,150,40),gradient=node('rectangle',700,0,100,40)
  doc.schemaVersion=4;doc.fonts={latin:{family:'Latin',data:fontTestBytes('noto-latin').toString('base64'),index:0}}
  locked.locked=true;locked.children=[blocked.id]
  for(const n of [blocked,a,linked]){n.text='ABC';n.textStyle={...defaultTextStyle(),fallbacks:['default']};n.textRuns=[{start:0,end:1,fontId:'default',weight:600}]}
  a.fills=[paint('#112233')];gradient.fills=[{...paint('#445566'),kind:'linear'}]
  doc.designSystem=emptySystem();doc.designSystem.styles.body={name:'Body',kind:'text',value:{...defaultTextStyle(),fallbacks:['default']}};linked.styleRefs={textStyle:'body'}
  doc.nodes=Object.fromEntries([locked,blocked,a,linked,gradient].map(n=>[n.id,n]));doc.pages[0].children=[locked.id,a.id,linked.id,gradient.id]
  const before=await renderDoc(doc,[a.id,gradient.id],'fills')
  await type(field('填充 1颜色'),'#abcdef');await key(field('填充 1颜色'),'Enter');const colored=editor.state.doc
  expect(colored.nodes[a.id].fills[0].color).toBe('#abcdef');expect(colored.nodes[gradient.id]).toEqual(before.nodes[gradient.id])
  // Kind-specific cards each own their opacity; edit the solid card only.
  const solidCard=field('填充 1颜色').closest('.property-card')!;const alpha=solidCard.querySelector<HTMLInputElement>('input[aria-label="填充 1不透明度 %"]')!
  await type(alpha,'25');await key(alpha,'Enter');const painted=editor.state.doc
  expect(painted.nodes[a.id].fills[0].opacity).toBe(.25);expect(painted.nodes[gradient.id]).toEqual(before.nodes[gradient.id])
  await undoTo(colored);const invalid=field('填充 1颜色');await type(invalid,'not-a-color');await act(async()=>interfacePreference.set({locale:'en'}));expect(invalid.value).toBe('not-a-color');await key(invalid,'Escape');expect(editor.state.doc).toEqual(colored);expect(editor.canRedo).toBe(true)
  await redoTo(painted);await act(async()=>{interfacePreference.set({locale:'zh-CN'});editor.select([a.id])});await mode('fonts')
  await choose('目标字体','latin');await choose('字体替换范围','document');await click(field('同时替换后备字体'))
  const detach=[...mount.querySelectorAll<HTMLLabelElement>('label')].find(l=>l.textContent?.includes('转为本地文字样式'))!.querySelector<HTMLInputElement>('input')!;await click(detach);await click(button('替换匹配的字体'))
  const replaced=editor.state.doc
  expect(replaced.nodes[blocked.id]).toEqual(painted.nodes[blocked.id]);expect(replaced.designSystem).toEqual(before.designSystem);expect(replaced.fonts).toEqual(before.fonts)
  for(const n of[a,linked]){expect(replaced.nodes[n.id].textStyle?.fontId).toBe('latin');expect(replaced.nodes[n.id].textStyle?.fallbacks).toEqual(['latin']);expect(replaced.nodes[n.id].textRuns).toEqual([{start:0,end:1,fontId:'latin',weight:600}])}
  expect(replaced.nodes[linked.id].styleRefs?.textStyle).toBeUndefined()
  await undoTo(painted);await undoTo(colored);await undoTo(before);expect(editor.canUndo).toBe(false);await redoTo(colored);await redoTo(painted);await redoTo(replaced)
  let stored:DesktopClipboard={};const listeners=new Set<(command:DesktopCommand)=>void>()
  const write=vi.fn(async(value:DesktopClipboard)=>{stored=structuredClone(value);return {status:'ok' as const}}),read=vi.fn(async()=>({status:'ok' as const,...structuredClone(stored)}))
  Object.defineProperty(window,'coreDesktop',{configurable:true,value:{version:1,onCommand:(fn:(command:DesktopCommand)=>void)=>{listeners.add(fn);return()=>{expect(listeners.delete(fn)).toBe(true)}},clipboard:{write,read}}})
  await mode('canvas');await act(async()=>host().focus());expect(listeners.size).toBe(1)
  await key(host(),'c',{metaKey:true});await settle(()=>write.mock.calls.length===1)
  expect(stored.forma).toBeTypeOf('string');const payload=JSON.parse(stored.forma!);expect(payload.roots).toEqual([a.id]);expect(payload.document.fonts.latin).toEqual(replaced.fonts!.latin)
  const source=editor,destination=blank('Conflicting font'),keep=node('text',100,100,100,40);keep.text='ABC';keep.textStyle={...defaultTextStyle(),fontId:'latin'}
  destination.fonts={latin:{family:'Different',data:fontTestBytes('noto-cjk').toString('base64'),index:0}};destination.nodes={[keep.id]:keep};destination.pages[0].children=[keep.id]
  await act(async()=>{root.render(null)});expect(listeners.size).toBe(0);editor=new Editor(destination);await mode('canvas');await act(async()=>host().focus());expect(listeners.size).toBe(1)
  const target=editor.state.doc,version=editor.state.version;await key(host(),'v',{metaKey:true});await settle(()=>editor.state.message.includes('字体标识冲突'))
  expect(read).toHaveBeenCalledTimes(1);expect(editor.state.doc).toBe(target);expect(editor.state.version).toBe(version);expect(editor.state.selection).toEqual([]);expect(editor.canUndo).toBe(false);expect(editor.canRedo).toBe(false)
  expect(source.state.doc).toEqual(replaced);reopenExact(replaced);reopenExact(target);source.dispose()
})
