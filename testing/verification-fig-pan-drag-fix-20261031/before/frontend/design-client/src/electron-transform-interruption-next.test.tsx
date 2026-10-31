// Actual mounted Canvas/event propagation + Editor/WASM. Only the render-device
// boundary is replaced; no native browser, GPU, or pixel-quality claim.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { blank, node, uid, defaultSizing, defaultLayout, validateDocument, type DesignNode } from './model'
import { shortcutPreference } from './shortcut-preference'
import { scene, apply } from './geometry'
import { dispatchEditorCommand } from './editor-commands'
import { selectionMetric } from './selection-properties'
import { selectionLocalBounds } from './canvas-view'
import { interfacePreference } from './interface-preference'
import { nudgePreference } from './nudge-preference'
import { MultiSelectionInspector } from './MultiSelectionInspector'
import { PendingEditContext } from './pending-edit-context'
import { encodeDocumentBinary, decodeDocumentBinary } from './kernel/binfmt'

vi.mock('./kernel/Surface', async () => {
  const { useLayoutEffect } = await import('react')
  return { KernelSurface(props: import('./kernel/Surface').SurfaceProps) {
    useLayoutEffect(() => {
      props.onPresentation?.({ ...props, epoch: props.presentationEpoch!, pixelRatio: 1, managed: false })
    }, [props.document, props.pageId, props.view, props.width, props.height, props.presentationEpoch, props.onPresentation])
    return <div data-testid="surface-boundary" />
  } }
})
const bootstrap = await vi.hoisted(async () => {
  // @ts-expect-error jsdom is a test-only runtime dependency.
  const { JSDOM } = await import('jsdom')
  const d = new JSDOM('<!doctype html><html><body></body></html>')
  for (const key of ['window', 'document', 'navigator']) vi.stubGlobal(key, key === 'window' ? d.window : d.window[key])
  return d
})
bootstrap.window.close()
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
  localStorage.clear(); interfacePreference.reset(); nudgePreference.reset(); shortcutPreference.set('sketch-like')
  editor = new Editor(blank()); editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false })
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount()); editor.dispose(); dom.window.close()
  vi.unstubAllGlobals(); vi.restoreAllMocks(); expect(errors).toEqual([])
})
const host = () => mount.querySelector<HTMLElement>('[data-testid="canvas"]')!
async function render(nodes: DesignNode[], roots = nodes.map(n => n.id), otherRoots: string[] = []) {
  const doc = blank('Selection workflows'); if (nodes.some(n => n.constrainProportions)) doc.schemaVersion = 7; doc.nodes = Object.fromEntries(nodes.map(n => [n.id, n])); doc.pages[0].children = roots
  if (otherRoots.length) doc.pages.push({ ...doc.pages[0], id: uid(), name: 'Other page', children: otherRoots })
  editor.load(doc); editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false })
  await act(async () => { root.render(<Canvas editor={editor} />); for (let i = 0; i < 6; i++) await Promise.resolve() })
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

// These are risk partitions R02–R04/T02–T04, not every possible modifier/UI/device combination.
const world = (id: string) => scene(editor.state.doc, editor.state.page).find(entry => entry.id === id)!.matrix
const screen = (p: {x:number;y:number}) => ({x:p.x*editor.state.view.zoom+editor.state.view.x,y:p.y*editor.state.view.zoom+editor.state.view.y})
async function at(type: string, p: {x:number;y:number}, target?: Element) { const s=screen(p); await act(async()=>pointer(type,s.x,s.y,{},target)) }
async function history(before: typeof editor.state.doc) {
  const after=editor.state.doc; expect(after).not.toEqual(before)
  await act(async()=>editor.undo()); expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false)
  await act(async()=>editor.redo()); expect(editor.state.doc).toEqual(after)
}
async function camera(zoom: number) { await act(async()=>editor.set({view:{x:37,y:29,zoom}})) }
function autoFrame(x=100,y=100) {
  const n=node('frame',x,y,100,80), child=node('rectangle',0,0,100,80)
  n.children=[child.id]; n.layout={...defaultLayout(),padding:[0,0,0,0]}; n.sizing={...defaultSizing(),width:'hug',height:'hug'}
  return {n,child}
}
async function field(label: string, value: string, finish='Enter') {
  const container=document.createElement('div'); document.body.append(container); const r=createRoot(container)
  try {
    await act(async()=>r.render(<PendingEditContext.Provider value={editor}><MultiSelectionInspector editor={editor} nodes={editor.state.selection.map(id=>editor.state.doc.nodes[id])}/></PendingEditContext.Provider>))
    const input=container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!; expect(input).not.toBeNull()
    await act(async()=>{input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))})
    await act(async()=>key(finish,{},'keydown',input))
  } finally {await act(async()=>r.unmount());container.remove();host().focus()}
}
function turn(p:{x:number;y:number},center:{x:number;y:number},degrees:number){const t=degrees*Math.PI/180,c=Math.cos(t),s=Math.sin(t);return{x:center.x+(p.x-center.x)*c-(p.y-center.y)*s,y:center.y+(p.x-center.x)*s+(p.y-center.y)*c}}
async function rotateGesture(center:{x:number;y:number},degrees:number,finish='pointerup') {
 const h=mount.querySelector('[data-testid="rotate-corner-1"]')!;expect(h).not.toBeNull()
 const start={x:Number(h.getAttribute('data-anchor-x')),y:Number(h.getAttribute('data-anchor-y'))},end=turn(start,center,degrees)
 await at('pointerdown',start,h);await at('pointermove',end)
 if(finish==='Escape') await act(async()=>key('Escape'));else await at(finish,end)
 return {start,end,screenStart:screen(start),screenEnd:screen(end)}
}
// DRAFT_NOT_RUN. Tests internal admission separately from unverified Figma behavior.
async function beginTransform(kind:'resize'|'rotate') {
 const selector=kind==='resize'?'resize-edge-1':'rotate-corner-1',h=mount.querySelector(`[data-testid="${selector}"]`)!
 expect(h).not.toBeNull()
 const start=kind==='resize'?{x:200,y:140}:{x:Number(h.getAttribute('data-anchor-x')),y:Number(h.getAttribute('data-anchor-y'))}
 const end=kind==='resize'?{x:250,y:140}:turn(start,{x:150,y:140},-30)
 await at('pointerdown',start,h);await at('pointermove',end)
 // Canvas coalesces pointer moves into rAF; flush the actual pending queue before checking preview.
 await act(async()=>{const pending=[...frames.values()];frames.clear();for(const fn of pending)fn(0)})
 expect(editor.interactionActive).toBe(true)
 return {start,end}
}
for(const kind of ['resize','rotate'] as const) {
 test(`RT-next ${kind}: internal tool admission blocks during gesture, Escape restores document without history`,async()=>{
  const n=node('rectangle',100,100,100,80);await render([n]);await act(async()=>editor.select([n.id]));const before=editor.state.doc
  const {end}=await beginTransform(kind);expect(editor.state.doc).not.toEqual(before)
  const preview=editor.state.doc,tool=editor.state.tool
  await act(async()=>dispatchEditorCommand(editor,'set-tool-ellipse'))
  expect(editor.state.tool).toBe(tool);expect(editor.state.doc).toEqual(preview);expect(editor.interactionActive).toBe(true)
  await act(async()=>key('Escape'));await at('pointerup',end)
  expect(editor.state.doc).toEqual(before);expect(editor.canUndo).toBe(false);expect(editor.interactionActive).toBe(false)
 })
 test(`RT-next ${kind}: document replacement invalidates preview and late pointerup cannot mutate new document`,async()=>{
  const n=node('rectangle',100,100,100,80);await render([n]);await act(async()=>editor.select([n.id]));const oldId=editor.state.doc.id
  const {end}=await beginTransform(kind),replacement=blank('New document'),fresh=node('rectangle',15,20,45,60)
  replacement.nodes={[fresh.id]:fresh};replacement.pages[0].children=[fresh.id]
  await act(async()=>editor.load(replacement));const admitted=editor.state.doc;expect(admitted.id).not.toBe(oldId)
  await at('pointerup',end);await at('pointercancel',end)
  expect(editor.state.doc).toEqual(admitted);expect(editor.state.doc.nodes[fresh.id]).toEqual(fresh);expect(editor.state.doc.nodes[n.id]).toBeUndefined()
  expect(editor.interactionActive).toBe(false);expect(editor.canUndo).toBe(false)
 })
}
async function fieldLifecycle(label:string,value:string,inspect:(input:HTMLInputElement)=>Promise<void>) {
 const container=document.createElement('div');document.body.append(container);const r=createRoot(container)
 try {
  await act(async()=>r.render(<PendingEditContext.Provider value={editor}><MultiSelectionInspector editor={editor} nodes={editor.state.selection.map(id=>editor.state.doc.nodes[id])}/></PendingEditContext.Provider>))
  const input=container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;expect(input).not.toBeNull()
  await act(async()=>{input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))})
  await inspect(input)
 }finally{await act(async()=>r.unmount());container.remove();host().focus()}
}
for(const [label,value] of [['W','150'],['H','120'],['旋转 °','30']]) {
 test(`RT-next ${label}: Enter followed by blur commits exactly once and undo/redo restores exact document`,async()=>{
  const a=node('rectangle',100,100,100,80),b=node('rectangle',300,100,120,90);await render([a,b]);await act(async()=>editor.select([a.id,b.id]));const before=editor.state.doc
  await fieldLifecycle(label,value,async input=>{
   await act(async()=>key('Enter',{},'keydown',input));const afterEnter=editor.state.doc,version=editor.state.version
   expect(afterEnter).not.toEqual(before)
   for(const id of [a.id,b.id])expect(selectionMetric(afterEnter.nodes[id],label==='W'?'width':label==='H'?'height':'rotation',afterEnter)).toBeCloseTo(Number(value),8)
   await act(async()=>{input.blur();input.dispatchEvent(new FocusEvent('focusout',{bubbles:true}))})
   expect(editor.state.doc).toEqual(afterEnter);expect(editor.state.version).toBe(version)
  });await history(before)
 })
 test(`RT-next ${label}: invalid Enter remains rejected and Escape preserves existing redo`,async()=>{
  const a=node('rectangle',100,100,100,80),b=node('rectangle',300,100,120,90);await render([a,b]);await act(async()=>{editor.select([a.id,b.id]);editor.update([a.id],{width:140});editor.undo()});const before=editor.state.doc
  await fieldLifecycle(label,'not-a-number',async input=>{
   await act(async()=>key('Enter',{},'keydown',input));expect(editor.state.doc).toEqual(before);expect(editor.canRedo).toBe(true)
   expect(input.validationMessage.length).toBeGreaterThan(0);expect(input.value).toBe('not-a-number')
   await act(async()=>key('Escape',{},'keydown',input));expect(editor.state.doc).toEqual(before)
  });await act(async()=>editor.redo());expect(editor.state.doc.nodes[a.id].width).toBe(140)
 })
}
test('RT-next non-orthogonal invertible parent corner resize preserves opposite world point and local geometry',async()=>{
 const parent=node('frame',200,100,400,400),n=node('rectangle',40,50,100,80);parent.transform=[1,.25,.3,1,200,100];parent.children=[n.id]
 await render([parent,n],[parent.id]);await act(async()=>editor.select([n.id]));await camera(.5)
 const before=editor.state.doc,m=world(n.id),anchor=apply(m,{x:0,y:0}),start=apply(m,{x:100,y:80}),end=apply(m,{x:150,y:120})
 const h=mount.querySelector('[data-testid="resize-2"]')!;expect(h).not.toBeNull();await at('pointerdown',start,h);await at('pointerup',end)
 const actual=editor.state.doc.nodes[n.id];expect(actual.width).toBeCloseTo(150,8);expect(actual.height).toBeCloseTo(120,8)
 const opposite=apply(world(n.id),{x:0,y:0});expect(opposite.x).toBeCloseTo(anchor.x,8);expect(opposite.y).toBeCloseTo(anchor.y,8)
 const corner=apply(world(n.id),{x:actual.width,y:actual.height});expect(corner.x).toBeCloseTo(end.x,8);expect(corner.y).toBeCloseTo(end.y,8)
 expect(editor.state.doc.nodes[parent.id]).toEqual(before.nodes[parent.id]);await history(before)
})
test('RT-next cross-parent rotation applies one world delta without reparenting or moving unrelated parents',async()=>{
 const pa=node('frame',150,100,300,300),pb=node('frame',600,100,300,300),a=node('rectangle',40,50,100,80),b=node('rectangle',30,60,100,80)
 pa.transform=[1,.25,.3,1,150,100];pb.transform=[0,1,-1,0,600,100];pa.children=[a.id];pb.children=[b.id]
 await render([pa,pb,a,b],[pa.id,pb.id]);await act(async()=>editor.select([a.id,b.id]));await camera(2)
 const before=editor.state.doc,matrices=[world(a.id),world(b.id)],points=matrices.flatMap(m=>[{x:0,y:0},{x:100,y:0},{x:100,y:80},{x:0,y:80}].map(p=>apply(m,p)))
 const xs=points.map(p=>p.x),ys=points.map(p=>p.y),center={x:(Math.min(...xs)+Math.max(...xs))/2,y:(Math.min(...ys)+Math.max(...ys))/2}
 await rotateGesture(center,-30)
 const c=Math.cos(Math.PI/6),s=-.5
 for(const [index,id] of [a.id,b.id].entries()){
  const m=matrices[index],actual=world(id),position=turn({x:m[4],y:m[5]},center,-30),expected=[c*m[0]-s*m[1],s*m[0]+c*m[1],c*m[2]-s*m[3],s*m[2]+c*m[3],position.x,position.y]
  for(let i=0;i<6;i++)expect(actual[i]).toBeCloseTo(expected[i],8)
  expect(editor.state.doc.nodes[id].width).toBe(100);expect(editor.state.doc.nodes[id].height).toBe(80)
 }
 expect(editor.state.doc.nodes[pa.id]).toEqual(before.nodes[pa.id]);expect(editor.state.doc.nodes[pb.id]).toEqual(before.nodes[pb.id]);await history(before)
})
