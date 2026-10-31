// Actual mounted Canvas/event propagation + Editor/WASM. Only the render-device
// boundary is replaced; no native browser, GPU, or pixel-quality claim.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { blank, node, uid, paint, defaultLayout, type DesignNode } from './model'
import { shortcutPreference } from './shortcut-preference'
import { shortcutBindings, resolveShortcut, type ShortcutProfile } from './shortcut-profiles'
import { worldMatrix, apply, allParents } from './geometry'
import { MultiSelectionInspector } from './MultiSelectionInspector'
import { PendingEditContext } from './pending-edit-context'
import { interfacePreference } from './interface-preference'
import { nudgePreference } from './nudge-preference'
import { encodeDocumentBinary, decodeDocumentBinary } from './kernel/binfmt'

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
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLCanvasElement', 'Element', 'Node', 'Event', 'MouseEvent', 'WheelEvent', 'KeyboardEvent', 'FocusEvent', 'localStorage'])
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
async function render(nodes: DesignNode[], roots = nodes.map(n => n.id), otherRoots: string[] = []) {
  const doc = blank('Selection workflows'); doc.nodes = Object.fromEntries(nodes.map(n => [n.id, n])); doc.pages[0].children = roots
  if (otherRoots.length) doc.pages.push({ ...doc.pages[0], id: uid(), name: 'Other page', children: otherRoots })
  await act(async () => { editor.load(doc); editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false }) })
  await act(async () => { root.render(<Harness />); for (let i = 0; i < 6; i++) await Promise.resolve() })
  host().focus(); return editor.state.doc
}
function pointer(type: string, x: number, y: number, options: MouseEventInit = {}, target: Element = host(), pointerId = 7) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...options })
  Object.defineProperties(event, { pointerId: { value: pointerId }, isPrimary: { value: true }, pointerType: { value: 'mouse' } })
  target.dispatchEvent(event); return event
}
function key(value: string, options: KeyboardEventInit = {}, type = 'keydown', target: EventTarget = host()) {
  const event = new KeyboardEvent(type, { key: value, code: value.length === 1 ? `Key${value.toUpperCase()}` : value, bubbles: true, cancelable: true, ...options })
  target.dispatchEvent(event); return event
}
async function marquee(from: number[], to: number[], options: MouseEventInit = {}, downOptions = options) {
  await act(async () => pointer('pointerdown', from[0], from[1], downOptions))
  await act(async () => pointer('pointermove', to[0] - 20, to[1] - 20, downOptions))
  await act(async () => pointer('pointerup', to[0], to[1], options))
}
function unchanged(doc: typeof editor.state.doc) {
  expect(editor.state.doc).toBe(doc); expect(editor.canUndo).toBe(false); expect(editor.canRedo).toBe(false)
}
const ordered = (values: string[]) => [...values].sort()

// Native event routing and real Editor/WASM; Surface presentation only is doubled.
// These are not OS GUI or independent Figma-observed claims.
function Harness() {
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot)
  return <><Canvas editor={editor} /><PendingEditContext.Provider value={editor}>
    <MultiSelectionInspector editor={editor} nodes={state.selection.map(id => state.doc.nodes[id])} />
  </PendingEditContext.Provider></>
}
function screen(x: number, y: number) { const v = editor.state.view; return [x * v.zoom + v.x, y * v.zoom + v.y] }
function center(id: string) { const n = editor.state.doc.nodes[id]; return apply(worldMatrix(editor.state.doc, id), { x: n.width / 2, y: n.height / 2 }) }
async function drag(id: string, dx: number, dy: number, end: 'pointerup' | 'pointercancel' | 'Escape' = 'pointerup') {
  const p = center(id), from = screen(p.x, p.y), to = screen(p.x + dx, p.y + dy)
  await act(async () => pointer('pointerdown', from[0], from[1]))
  await act(async () => pointer('pointermove', to[0], to[1]))
  await act(async () => end === 'Escape' ? key('Escape') : pointer(end, to[0], to[1]))
}
function delta(before: typeof editor.state.doc, id: string, x: number, y: number) {
  const a = worldMatrix(before, id), b = worldMatrix(editor.state.doc, id)
  for (let i = 0; i < 4; i++) expect(b[i]).toBeCloseTo(a[i], 8)
  expect(b[4]).toBeCloseTo(a[4] + x, 7); expect(b[5]).toBeCloseTo(a[5] + y, 7)
}
function rotate(n: DesignNode, degrees: number) { const r = degrees * Math.PI / 180; n.transform = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), n.transform[4], n.transform[5]] }
async function oneHistory(before: typeof editor.state.doc) {
  const after = editor.state.doc
  await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false)
  await act(async () => editor.redo()); expect(editor.state.doc).toEqual(after); expect(editor.canRedo).toBe(false)
}
async function redoSeed(id: string) {
  await act(async () => { editor.updateProperties([id], { name: 'Redo survives navigation' }); editor.undo() })
  expect(editor.canRedo).toBe(true); return editor.state.doc
}
async function menuAction(label: string) {
  await act(async () => { host().focus(); key('ContextMenu') })
  if (label === '反选') {
    const submenu = document.querySelector<HTMLButtonElement>('[role="menuitem"][data-menu-group="selection"]')
    expect(submenu).not.toBeNull(); await act(async () => submenu!.click())
  }
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item =>
    item.getAttribute('aria-label') === label || item.querySelector('.context-label')?.textContent === label)
  expect(button).toBeDefined(); expect(button!.disabled).toBe(false)
  await act(async () => button!.click()); expect(document.querySelector('[role="menu"]')).toBeNull()
}


// DRAFT_NOT_RUN. Mac keyboard dimensions observed in actual Figma AX snapshots.
// Affine scale arithmetic was observed as 70.00000000000001/59.99999999999999;
// 10 decimal places allow only sub-1e-10 dimension roundoff, not changed geometry.
// Only size deltas are externally observed. Local position/history/lock semantics
// below are internal regression contracts, not claims about the Figma experiment.
const observedKeys=[
 {key:'ArrowRight',large:false,before:[60,60],after:[61,60]},
 {key:'ArrowLeft',large:false,before:[61,60],after:[60,60]},
 {key:'ArrowDown',large:false,before:[60,60],after:[60,61]},
 {key:'ArrowUp',large:false,before:[60,61],after:[60,60]},
 {key:'ArrowRight',large:true,before:[60,60],after:[70,60]},
 {key:'ArrowLeft',large:true,before:[70,60],after:[60,60]},
 {key:'ArrowDown',large:true,before:[60,60],after:[60,70]},
 {key:'ArrowUp',large:true,before:[60,70],after:[60,60]},
] as const
async function dimensionFixture(profile:ShortcutProfile,width=60,height=60){
 shortcutPreference.set(profile)
 const p=node('frame',100,100,300,300),a=node('rectangle',120,120,width,height),locked=node('rectangle',500,100,60,60),hidden=node('rectangle',600,100,60,60)
 rotate(p,-15);p.children=[a.id];locked.locked=true;hidden.visible=false
 await render([p,a,locked,hidden],[p.id,locked.id,hidden.id]);await act(async()=>editor.select([a.id]));host().focus();return {p,a,locked,hidden}
}
for(const profile of ['figma-like','sketch-like'] as const)for(const item of observedKeys){
 test(`mac ${profile} actual canvas Cmd${item.large?'Shift':''}${item.key} observed dimensions ${item.before.join('x')} to ${item.after.join('x')}`,async()=>{
  const {p,a}=await dimensionFixture(profile,item.before[0],item.before[1]),before=editor.state.doc
  let event:KeyboardEvent;await act(async()=>{event=key(item.key,{metaKey:true,shiftKey:item.large})});expect(event!.defaultPrevented).toBe(true)
  await act(async()=>key(item.key,{metaKey:true,shiftKey:item.large},'keyup'))
  expect(editor.state.doc.nodes[a.id].width).toBeCloseTo(item.after[0],10);expect(editor.state.doc.nodes[a.id].height).toBeCloseTo(item.after[1],10);expect(editor.state.doc.nodes[p.id]).toEqual(before.nodes[p.id]);expect(editor.state.selection).toEqual([a.id]);expect(document.activeElement).toBe(host());expect(editor.interactionActive).toBe(false)
  await oneHistory(before)
 })
}
for(const profile of ['figma-like','sketch-like'] as const){
 test(`mac ${profile} dimension repeat keydown is one transaction, keyup commits, orphan repeat ignored`,async()=>{
  const {a}=await dimensionFixture(profile),before=editor.state.doc
  await act(async()=>key('ArrowRight',{metaKey:true,repeat:true}));expect(editor.state.doc).toBe(before);expect(editor.canUndo).toBe(false)
  await act(async()=>{key('ArrowRight',{metaKey:true});key('ArrowRight',{metaKey:true,repeat:true});key('ArrowRight',{metaKey:true,repeat:true})})
  expect(editor.state.doc.nodes[a.id].width).toBeCloseTo(63,10);expect(editor.interactionActive).toBe(true);expect(editor.canUndo).toBe(false)
  await act(async()=>key('ArrowRight',{metaKey:true},'keyup'));expect(editor.interactionActive).toBe(false);await oneHistory(before)
 })
 test(`mac ${profile} dimension Escape cancels held repeats and preserves prior redo`,async()=>{
  const {a}=await dimensionFixture(profile),before=await redoSeed(a.id)
  await act(async()=>{key('ArrowDown',{metaKey:true,shiftKey:true});key('ArrowDown',{metaKey:true,shiftKey:true,repeat:true})});expect(editor.state.doc.nodes[a.id].height).toBeCloseTo(80,10)
  await act(async()=>key('Escape'));await act(async()=>key('ArrowDown',{metaKey:true,shiftKey:true},'keyup'))
  expect(editor.state.doc).toEqual(before);expect(editor.canUndo).toBe(false);expect(editor.canRedo).toBe(true);expect(editor.interactionActive).toBe(false)
 })
 test(`mac ${profile} input focus and IME do not route dimension shortcuts into Canvas`,async()=>{
  await dimensionFixture(profile);const before=editor.state.doc,input=document.createElement('input');host().append(input);input.value='native draft'
  await act(async()=>input.focus());await act(async()=>{key('ArrowRight',{metaKey:true},'keydown',input);key('ArrowRight',{metaKey:true},'keyup',input)})
  expect(input.value).toBe('native draft');expect(document.activeElement).toBe(input);expect(editor.state.doc).toBe(before)
  await act(async()=>{input.remove();host().focus();key('ArrowRight',{metaKey:true,isComposing:true});key('ArrowRight',{metaKey:true},'keyup')})
  expect(editor.state.doc).toBe(before)
  const ime=new KeyboardEvent('keydown',{key:'ArrowDown',code:'ArrowDown',metaKey:true,bubbles:true,cancelable:true});Object.defineProperty(ime,'keyCode',{value:229})
  await act(async()=>{host().dispatchEvent(ime);key('ArrowDown',{metaKey:true},'keyup')});expect(editor.state.doc).toBe(before);expect(editor.canUndo).toBe(false)
 })
 test(`mac ${profile} dimension multi-selection filters locked hidden paths without moving their data`,async()=>{
  const {a,locked,hidden}=await dimensionFixture(profile);await act(async()=>editor.select([a.id,locked.id,hidden.id]));const before=editor.state.doc
  await act(async()=>{key('ArrowRight',{metaKey:true,shiftKey:true});key('ArrowRight',{metaKey:true,shiftKey:true},'keyup')})
  expect(editor.state.doc.nodes[a.id].width).toBeCloseTo(70,10);expect(editor.state.doc.nodes[locked.id]).toEqual(before.nodes[locked.id]);expect(editor.state.doc.nodes[hidden.id]).toEqual(before.nodes[hidden.id]);await oneHistory(before)
 })
 test(`mac ${profile} ordinary arrows still move rather than resize and exact extra modifiers do not resize`,async()=>{
  const {a}=await dimensionFixture(profile),before=editor.state.doc
  await act(async()=>{key('ArrowRight');key('ArrowRight',{},'keyup')});delta(before,a.id,1,0);expect(editor.state.doc.nodes[a.id].width).toBe(60);await oneHistory(before)
  await act(async()=>editor.undo());const reset=editor.state.doc
  await act(async()=>{key('ArrowRight',{metaKey:true,altKey:true});key('ArrowRight',{metaKey:true,altKey:true},'keyup')});expect(editor.state.doc).toBe(reset)
 })
}
test('dimension chord registry has no duplicate mac chord and does not expand unobserved non-mac Figma bindings',()=>{
 for(const profile of ['figma-like','sketch-like'] as const)for(const desktop of [false,true]){
  const bindings=shortcutBindings({profile,platform:'mac',desktop})
  for(const item of observedKeys){const combo=`Mod+${item.large?'Shift+':''}${item.key}`,hits=bindings.filter(binding=>binding.combo===combo);expect(hits).toHaveLength(1);expect(hits[0].command).toMatch(/^resize-/);expect(hits[0].repeat).toBe(true)}
  const group=resolveShortcut({key:'g',code:'KeyG',metaKey:true,ctrlKey:false,altKey:false,shiftKey:false,repeat:false,isComposing:false,defaultPrevented:false},{profile,platform:'mac',desktop});expect(group?.command).toBe('group')
 }
 for(const platform of ['windows','linux'] as const){
  expect(shortcutBindings({profile:'figma-like',platform}).filter(b=>b.command.startsWith('resize-'))).toEqual([])
  expect(shortcutBindings({profile:'sketch-like',platform}).filter(b=>b.command.startsWith('resize-'))).toHaveLength(8)
 }
})
