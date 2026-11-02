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

// DRAFT_NOT_RUN. New Figma-observed partition, not replacement for pending M01.
// Matrix rows supplied by root from real Figma CUA evidence. Screen coordinates
// are NOT converted to world coordinates: below uses the observed world deltas.
// Figma UI angles use opposite sign from the affine matrix helper above.
async function observedFixture() {
 const p=node('frame',0,0,300,300),q=node('frame',0,0,300,300),a=node('rectangle',120,120,60,60),b=node('rectangle',120,120,60,60)
 p.transform=[0.9659258127212524,-0.258819043636322,0.258819043636322,0.9659258127212524,-333.71173095703125,-206.06602478027344]
 q.transform=[0.9396926164627075,0.3420201539993286,-0.3420201539993286,0.9396926164627075,160.34912109375,-292.2569274902344]
 p.children=[a.id];q.children=[b.id]
 await render([p,q,a,b],[p.id,q.id]);await act(async()=>editor.set({view:{x:500,y:450,zoom:1}}))
 const left=center(a.id),right=center(b.id),l=screen(left.x,left.y),r=screen(right.x,right.y)
 await act(async()=>{pointer('pointerdown',l[0],l[1],{metaKey:true});pointer('pointerup',l[0],l[1],{metaKey:true})})
 expect(editor.state.selection).toEqual([a.id])
 await act(async()=>{pointer('pointerdown',r[0],r[1],{metaKey:true,shiftKey:true});pointer('pointerup',r[0],r[1],{metaKey:true,shiftKey:true})})
 expect(editor.state.selection).toEqual([a.id,b.id]);expect(editor.canUndo).toBe(false)
 return {p,q,a,b}
}
function retained(before:typeof editor.state.doc,p:DesignNode,q:DesignNode,a:DesignNode,b:DesignNode){
 expect(editor.state.doc.nodes[p.id]).toEqual(before.nodes[p.id]);expect(editor.state.doc.nodes[q.id]).toEqual(before.nodes[q.id])
 expect(editor.state.doc.pages).toEqual(before.pages);expect(editor.state.selection).toEqual([a.id,b.id])
 expect(editor.state.doc.nodes[a.id].fills).toEqual(before.nodes[a.id].fills);expect(editor.state.doc.nodes[b.id].fills).toEqual(before.nodes[b.id].fills)
}
for(const scenario of [{side:'left',dx:9.742355346679688,dy:4.7423553466796875},{side:'right',dx:10.451385498046875,dy:5.4514007568359375}] as const){
 test(`Figma observed separate rotated parents: ${scenario.side}-origin small world drag retains each parent`,async()=>{
  const {p,q,a,b}=await observedFixture(),before=editor.state.doc
  await drag(scenario.side==='left'?a.id:b.id,scenario.dx,scenario.dy)
  delta(before,a.id,scenario.dx,scenario.dy);delta(before,b.id,scenario.dx,scenario.dy);retained(before,p,q,a,b);await oneHistory(before)
 })
}
test('Figma observed separate rotated parents: ten Right then five Down keys retain parents and every committed step undoes/redoes',async()=>{
 const {p,q,a,b}=await observedFixture(),before=editor.state.doc,states=[before]
 for(let i=0;i<15;i++){
  const k=i<10?'ArrowRight':'ArrowDown';await act(async()=>{key(k);key(k,{},'keyup')})
  delta(before,a.id,Math.min(i+1,10),Math.max(i-9,0));delta(before,b.id,Math.min(i+1,10),Math.max(i-9,0));retained(before,p,q,a,b);states.push(editor.state.doc)
 }
 for(let i=14;i>=0;i--){await act(async()=>editor.undo());expect(editor.state.doc).toEqual(states[i])}expect(editor.canUndo).toBe(false)
 for(let i=1;i<states.length;i++){await act(async()=>editor.redo());expect(editor.state.doc).toEqual(states[i])}expect(editor.canRedo).toBe(false)
})

// Negative partitions retain existing local behavior, NOT additional Figma observations.
async function freeFixture(mode='plain'){
 const p=node('frame',0,0,300,300),q=node('frame',mode==='overlap'?250:400,0,300,300),a=node('rectangle',120,120,60,60),b=node('rectangle',120,120,60,60)
 p.children=[a.id];q.children=[b.id];const nodes=[p,q,a,b],roots=[p.id,q.id]
 let group:DesignNode|undefined
 if(mode==='nested'){group=node('group',0,0,300,300);group.children=[b.id];q.children=[group.id];nodes.push(group)}
 if(mode==='layout')q.layout={...defaultLayout(),padding:[120,120,120,120]}
 let destination:DesignNode|undefined
 if(mode==='third'){
  destination=node('frame',0,500,900,300);const locked=node('frame',0,500,900,300),hidden=node('frame',0,500,900,300);locked.locked=true;hidden.visible=false
  nodes.push(destination,locked,hidden);roots.push(destination.id,locked.id,hidden.id)
 }
 await render(nodes,roots);await act(async()=>{editor.select([a.id,b.id]);editor.set({view:{x:100,y:200,zoom:1}})})
 return {p,q,a,b,group,destination}
}
const parent=(id:string)=>allParents(editor.state.doc).get(id)
async function stagedDrag(id:string,dx:number,dy:number,options:MouseEventInit={}){
 const at=center(id),from=screen(at.x,at.y),to=screen(at.x+dx,at.y+dy)
 await act(async()=>pointer('pointerdown',from[0],from[1]));await act(async()=>pointer('pointermove',to[0],to[1],options));return {from,to}
}
test('placement negative: single child deliberate cross-frame drop still reparents with world geometry and history',async()=>{
 const {p,q,a,b}=await freeFixture();await act(async()=>editor.select([a.id]));const before=editor.state.doc
 await drag(a.id,400,0);delta(before,a.id,400,0);expect(parent(a.id)).toBe(q.id);expect(parent(b.id)).toBe(q.id);expect(editor.state.doc.nodes[p.id].children).toEqual([]);await oneHistory(before)
})
test('placement negative: both roots enter common new frame while locked and hidden overlaid targets stay ineligible',async()=>{
 const {p,q,a,b,destination}=await freeFixture('third'),before=editor.state.doc
 await drag(a.id,0,500);delta(before,a.id,0,500);delta(before,b.id,0,500);expect(parent(a.id)).toBe(destination!.id);expect(parent(b.id)).toBe(destination!.id);expect(editor.state.doc.nodes[p.id].children).toEqual([]);expect(editor.state.doc.nodes[q.id].children).toEqual([]);await oneHistory(before)
})
test('placement negative: explicit force on move retains existing common pointer target behavior',async()=>{
 const {p,a,b}=await freeFixture(),before=editor.state.doc,{to}=await stagedDrag(a.id,5,5,{metaKey:true})
 await act(async()=>pointer('pointerup',to[0],to[1],{metaKey:true}));delta(before,a.id,5,5);delta(before,b.id,5,5);expect(parent(a.id)).toBe(p.id);expect(parent(b.id)).toBe(p.id);await oneHistory(before)
})
test('placement control: Space retains each original parent even when both leave their original frames',async()=>{
 const {p,q,a,b}=await freeFixture(),before=editor.state.doc,at=center(a.id),from=screen(at.x,at.y),to=screen(at.x,at.y+400)
 await act(async()=>pointer('pointerdown',from[0],from[1]));await act(async()=>key(' ',{code:'Space'}));await act(async()=>pointer('pointermove',to[0],to[1]));await act(async()=>pointer('pointerup',to[0],to[1]));await act(async()=>key(' ',{code:'Space'},'keyup'))
 delta(before,a.id,0,400);delta(before,b.id,0,400);expect(parent(a.id)).toBe(p.id);expect(parent(b.id)).toBe(q.id);await oneHistory(before)
})
test('placement negative: center inside but one corner outside does not enter the full-containment exception',async()=>{
 const {p,a,b}=await freeFixture(),before=editor.state.doc
 await drag(a.id,130,0);delta(before,a.id,130,0);delta(before,b.id,130,0);expect(parent(a.id)).toBe(p.id);expect(parent(b.id)).toBe(p.id);await oneHistory(before)
})
test('placement negative: overlapping original frames stay on existing pointer placement path',async()=>{
 const {p,a,b}=await freeFixture('overlap'),before=editor.state.doc
 await drag(a.id,5,5);delta(before,a.id,5,5);delta(before,b.id,5,5);expect(parent(a.id)).toBe(p.id);expect(parent(b.id)).toBe(p.id);await oneHistory(before)
})
test('placement: ordinary multi-selection drag keeps a nested group member in its group',async()=>{
 const {p,a,b,group}=await freeFixture('nested'),before=editor.state.doc
 await drag(a.id,5,5);delta(before,a.id,5,5);delta(before,b.id,5,5);expect(parent(b.id)).toBe(group!.id);expect(editor.state.doc.nodes[group!.id].children).toEqual([b.id]);await oneHistory(before)
})
test('placement negative: auto-layout original parent keeps existing sizing-restoration path',async()=>{
 const {p,a,b}=await freeFixture('layout'),before=editor.state.doc,sizing=before.nodes[b.id].sizing
 await drag(a.id,5,5);delta(before,a.id,5,5);delta(before,b.id,5,5);expect(parent(b.id)).toBe(p.id);expect(editor.state.doc.nodes[b.id].sizing).toEqual(sizing);await oneHistory(before)
})
test('placement cancellation: Escape pointercancel and lost capture restore original hierarchy and existing redo',async()=>{
 for(const end of ['Escape','pointercancel','lostpointercapture']){
  const {a,b}=await freeFixture();const before=await redoSeed(a.id);await act(async()=>editor.select([a.id,b.id]));const {to}=await stagedDrag(a.id,5,5)
  await act(async()=>end==='Escape'?key('Escape'):pointer(end,to[0],to[1]))
  expect(editor.state.doc).toEqual(before);expect(editor.state.selection).toEqual([a.id,b.id]);expect(editor.canUndo).toBe(false);expect(editor.canRedo).toBe(true)
 }
})
test('placement ownership: same-ID session replacement cannot be polluted by old pointerup',async()=>{
 const {a}=await freeFixture(),{to}=await stagedDrag(a.id,5,5),replacement=structuredClone(editor.state.doc);replacement.name='Replacement owner'
 let accepted=editor.state.doc
 await act(async()=>{expect(editor.load(replacement,true)).toBe(true);accepted=editor.state.doc;pointer('pointerup',to[0],to[1])})
 expect(editor.state.doc).toBe(accepted);expect(editor.state.doc.name).toBe('Replacement owner');expect(editor.canUndo).toBe(false)
})
async function flushCapturedFrame(){await act(async()=>{const batch=[...frames.values()];frames.clear();for(const callback of batch)callback(performance.now())})}
test('placement return: leave original frames with visible reparent then return restores original parent map before commit',async()=>{
 const {p,q,a,b}=await freeFixture(),before=editor.state.doc,{from,to}=await stagedDrag(a.id,0,400)
 await flushCapturedFrame()
 console.log('placement leave diagnostic',JSON.stringify({parents:[parent(a.id),parent(b.id)],expectedPage:editor.state.page,originalParents:[p.id,q.id],worlds:[worldMatrix(editor.state.doc,a.id),worldMatrix(editor.state.doc,b.id)],point:to,queuedFrames:frames.size}));expect(parent(a.id)).toBe(editor.state.page);expect(parent(b.id)).toBe(editor.state.page)
 const back=[from[0]+5,from[1]+5];await act(async()=>pointer('pointermove',back[0],back[1]));await flushCapturedFrame();console.log('placement return diagnostic',JSON.stringify({parents:[parent(a.id),parent(b.id)],originalParents:[p.id,q.id],worlds:[worldMatrix(editor.state.doc,a.id),worldMatrix(editor.state.doc,b.id)],point:back}));expect(parent(a.id)).toBe(p.id);expect(parent(b.id)).toBe(q.id)
 await act(async()=>pointer('pointerup',back[0],back[1]));delta(before,a.id,5,5);delta(before,b.id,5,5);retained(before,p,q,a,b);await oneHistory(before)
})

for(const boundary of ['load','new-gesture'] as const)test(`placement finish restoration notification cannot continue into subscriber ${boundary}`,async()=>{
 const {p,q,a,b}=await freeFixture(),before=editor.state.doc,point={x:155,y:155}
 await act(async()=>{editor.begin('Forced visible preview');editor.preview({[a.id]:{transform:[1,0,0,1,125,125]},[b.id]:{transform:[1,0,0,1,125,125]}},{ids:[a.id,b.id],point,force:true,preserveParent:false})})
 expect(parent(a.id)).toBe(p.id);expect(parent(b.id)).toBe(p.id)
 let fired=false,accepted=editor.state.doc
 const stop=editor.subscribe(()=>{
  if(fired||parent(b.id)!==q.id)return
  fired=true
  if(boundary==='load'){const replacement=structuredClone(before);replacement.name='Subscriber replacement';expect(editor.load(replacement,true)).toBe(true)}
  else {editor.cancel();editor.begin('Subscriber new gesture');editor.preview({[a.id]:{transform:[1,0,0,1,140,120]}})}
  accepted=editor.state.doc
 })
 try{await act(async()=>editor.finishCanvasMove(point));expect(fired).toBe(true);expect(editor.state.doc).toBe(accepted);expect(parent(a.id)).toBe(p.id);expect(parent(b.id)).toBe(q.id);expect(editor.canUndo).toBe(false);expect(editor.interactionActive).toBe(boundary==='new-gesture')}
 finally{stop();await act(async()=>editor.cancel())}
})

test('placement finish restoration cannot reorder subscriber replacement auto-layout or overwrite its new gesture',async()=>{
 const {p,q,a,b}=await freeFixture(),before=editor.state.doc,point={x:155,y:155}
 await act(async()=>{editor.begin('Forced visible preview');editor.preview({[a.id]:{transform:[1,0,0,1,125,125]},[b.id]:{transform:[1,0,0,1,125,125]}},{ids:[a.id,b.id],point,force:true,preserveParent:false})})
 expect(parent(b.id)).toBe(p.id)
 let fired=false,accepted=editor.state.doc,adopted=editor.state.doc
 const stop=editor.subscribe(()=>{
  if(fired||parent(b.id)!==q.id)return
  fired=true
  const replacement=structuredClone(before),sibling=node('rectangle',0,0,60,60);replacement.name='New layout owner';replacement.nodes[sibling.id]=sibling
  replacement.nodes[p.id].layout=defaultLayout();replacement.nodes[p.id].children=[a.id,sibling.id]
  expect(editor.load(replacement,true)).toBe(true);adopted=editor.state.doc
  editor.begin('New owner opacity gesture');editor.preview({[a.id]:{opacity:.6}});accepted=editor.state.doc
 })
 try{
  await act(async()=>editor.finishCanvasMove(point));expect(fired).toBe(true);expect(editor.state.doc).toBe(accepted)
  expect(editor.state.doc.nodes[p.id].children).toEqual(adopted.nodes[p.id].children);expect(parent(b.id)).toBe(q.id);expect(editor.canUndo).toBe(false);expect(editor.interactionActive).toBe(true)
  await act(async()=>editor.commit());expect(editor.state.doc).toEqual(accepted);expect(editor.state.doc.nodes[a.id].opacity).toBe(.6);expect(editor.interactionActive).toBe(false)
  await act(async()=>editor.undo());expect(editor.state.doc).toEqual(adopted);expect(editor.canUndo).toBe(false)
  await act(async()=>editor.redo());expect(editor.state.doc).toEqual(accepted);expect(editor.canRedo).toBe(false)
 }finally{stop();await act(async()=>editor.cancel())}
})
