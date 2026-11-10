// Actual mounted Canvas/event propagation + Editor/WASM. Only the render-device
// boundary is replaced; no native browser, GPU, or pixel-quality claim.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Inspector } from './Inspector'
import { formatAngleDegrees } from './selection-handles'
import { Editor } from './engine'
import { blank, node, uid, defaultSizing, defaultLayout, validateDocument, type DesignNode } from './model'
import { shortcutPreference } from './shortcut-preference'
import { scene, apply } from './geometry'
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
for(const zoom of [.5,2]) for(const axis of ['left','top'] as const) {
 test(`R02 ${axis} edge at zoom ${zoom}: fixed opposite anchor, untouched Hug, release coordinate and history`,async()=>{
  const {n,child}=autoFrame();await render([n,child],[n.id]);await act(async()=>editor.select([n.id]));await camera(zoom)
  const before=editor.state.doc, left=axis==='left', edge=mount.querySelector(`[data-testid="resize-edge-${left?3:0}"]`)!
  expect(edge).not.toBeNull();const start=left?{x:100,y:140}:{x:150,y:100}, end=left?{x:50,y:140}:{x:150,y:60}
  await at('pointerdown',start,edge);await at('pointermove',left?{x:80,y:140}:{x:150,y:80});await at('pointerup',end)
  const next=editor.state.doc.nodes[n.id];expect(next.width).toBeCloseTo(left?150:100,8);expect(next.height).toBeCloseTo(left?80:120,8)
  expect(next.sizing).toMatchObject(left?{width:'fixed',height:'hug'}:{width:'hug',height:'fixed'})
  expect(apply(world(n.id),{x:next.width,y:next.height})).toEqual({x:200,y:180})
  await history(before)
 })
}
test('R03 mirrored child in 90-degree parent: actual corner resizes local axes and preserves opposite world anchor',async()=>{
 const parent=node('frame',400,200,300,300),{n,child}=autoFrame();parent.transform=[0,1,-1,0,400,200];parent.children=[n.id];n.transform=[-1,0,0,1,200,50]
 await render([parent,n,child],[parent.id]);await act(async()=>editor.select([n.id]));await camera(.5)
 const before=editor.state.doc, anchor=apply(world(n.id),{x:0,y:0}),start=apply(world(n.id),{x:100,y:80})
 const end={x:start.x-40,y:start.y-50},handle=mount.querySelector('[data-testid="resize-2"]')!;expect(handle).not.toBeNull()
 await at('pointerdown',start,handle);await at('pointerup',end)
 const next=editor.state.doc.nodes[n.id];expect(next.width).toBeCloseTo(150,8);expect(next.height).toBeCloseTo(120,8)
 expect(next.sizing).toMatchObject({width:'fixed',height:'fixed'});expect(apply(world(n.id),{x:0,y:0})).toEqual(anchor)
 expect(editor.state.doc.nodes[parent.id]).toEqual(before.nodes[parent.id]);await history(before)
})
for(const keyName of ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown']) for(const large of [false,true]) {
 test(`R04 sketch keyboard ${keyName} large=${large}: multi-selection skips locked/hidden and only fixes target axis`,async()=>{
  const {n,child}=autoFrame(),locked=node('rectangle',350,100,70,60),hidden=node('rectangle',450,100,70,60);locked.locked=true;hidden.visible=false
  await render([n,child,locked,hidden],[n.id,locked.id,hidden.id]);await act(async()=>editor.select([n.id,locked.id,hidden.id]));const before=editor.state.doc
  await act(async()=>key(keyName,{metaKey:true,shiftKey:large}));await act(async()=>key(keyName,{},'keyup'))
  const width=keyName==='ArrowLeft'||keyName==='ArrowRight',delta=(keyName==='ArrowLeft'||keyName==='ArrowUp'?-1:1)*(large?10:1),next=editor.state.doc.nodes[n.id]
  expect(selectionMetric(next,width?'width':'height',editor.state.doc)).toBeCloseTo((width?100:80)+delta,8)
  expect(next.sizing).toMatchObject(width?{width:'fixed',height:'hug'}:{width:'hug',height:'fixed'})
  expect(editor.state.doc.nodes[locked.id]).toEqual(before.nodes[locked.id]);expect(editor.state.doc.nodes[hidden.id]).toEqual(before.nodes[hidden.id]);await history(before)
 })
}
for(const label of ['W','H']) {
 test(`R04 mounted mixed ${label} property commits one history and preserves other Hug axis`,async()=>{
  const a=autoFrame(),b=autoFrame(350,100);b.n.width=120;b.child.width=120
  await render([a.n,a.child,b.n,b.child],[a.n.id,b.n.id]);await act(async()=>editor.select([a.n.id,b.n.id]));const before=editor.state.doc
  await field(label,'150')
  for(const id of [a.n.id,b.n.id]){const n=editor.state.doc.nodes[id];expect(selectionMetric(n,label==='W'?'width':'height',editor.state.doc)).toBeCloseTo(150,8);expect(n.sizing).toMatchObject(label==='W'?{width:'fixed',height:'hug'}:{width:'hug',height:'fixed'})}
  await history(before)
 })
}
function turn(p:{x:number;y:number},center:{x:number;y:number},degrees:number){const t=degrees*Math.PI/180,c=Math.cos(t),s=Math.sin(t);return{x:center.x+(p.x-center.x)*c-(p.y-center.y)*s,y:center.y+(p.x-center.x)*s+(p.y-center.y)*c}}
async function rotateGesture(center:{x:number;y:number},degrees:number,finish='pointerup') {
 const h=mount.querySelector('[data-testid="rotate-corner-1"]')!;expect(h).not.toBeNull()
 const start={x:Number(h.getAttribute('data-anchor-x')),y:Number(h.getAttribute('data-anchor-y'))},end=turn(start,center,degrees)
 await at('pointerdown',start,h);await at('pointermove',end)
 if(finish==='Escape') await act(async()=>key('Escape'));else await at(finish,end)
 return {start,end,screenStart:screen(start),screenEnd:screen(end)}
}
for(const zoom of [.5,2]) {
 test(`T02 actual group rotation handle 30 degrees at zoom ${zoom}: live center, local bounds and one history`,async()=>{
  const group=node('group',100,100,250,50),a=node('rectangle',0,0,100,50),b=node('rectangle',250,50,100,50);group.children=[a.id,b.id]
  await render([group,a,b],[group.id]);await act(async()=>editor.select([group.id]));await camera(zoom);const before=editor.state.doc
  // Mac Figma: positive angles are clockwise. Screen y-down turn(+30) is clockwise.
  const center={x:275,y:150};await rotateGesture(center,30)
  const n=editor.state.doc.nodes[group.id],bounds=selectionLocalBounds(editor.state.doc,group.id)
  expect(n.transform[0]).toBeCloseTo(Math.cos(Math.PI/6),10);expect(n.transform[1]).toBeCloseTo(.5,10);expect(n.transform[2]).toBeCloseTo(-.5,10);expect(n.transform[3]).toBeCloseTo(Math.cos(Math.PI/6),10)
  expect(selectionMetric(n,'rotation',editor.state.doc)).toBeCloseTo(30,8);expect(bounds.width).toBeCloseTo(350,8);expect(bounds.height).toBeCloseTo(100,8)
  const actual=apply(world(group.id),{x:175,y:50});expect(actual.x).toBeCloseTo(center.x,8);expect(actual.y).toBeCloseTo(center.y,8)
  expect(editor.state.doc.nodes[a.id]).toEqual(before.nodes[a.id]);expect(editor.state.doc.nodes[b.id]).toEqual(before.nodes[b.id]);await history(before)
 })
}
test('T02 right-hand angle is clockwise-positive and shows two decimals before pointerup', async () => {
  const n = node('rectangle', 80, 60, 105.126, 21.204)
  await render([n], [n.id])
  await act(async () => editor.select([n.id]))
  await act(async () => {
    root.render(<PendingEditContext.Provider value={editor}><Canvas editor={editor} /><Inspector editor={editor} /></PendingEditContext.Provider>)
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
  host().focus()
  const center = { x: 80 + 105.126 / 2, y: 60 + 21.204 / 2 }
  const handle = mount.querySelector('[data-testid="rotate-corner-1"]')!
  const start = { x: Number(handle.getAttribute('data-anchor-x')), y: Number(handle.getAttribute('data-anchor-y')) }
  const end = turn(start, center, 30)
  await at('pointerdown', start, handle)
  await at('pointermove', end)
  const field = mount.querySelector<HTMLInputElement>('input[aria-label="旋转 °"]')!
  expect(field.value).toBe(formatAngleDegrees(30))
  expect(field.value).toBe('30.00')
  const hint = mount.querySelector('[data-testid="rotation-feedback"]')
  expect(hint?.textContent).toBe(field.value)
  // Own paint shows the angle immediately. The document transform is written
  // on release, so this sample does not reconvert the rectangle.
  expect(selectionMetric(editor.state.doc.nodes[n.id], 'rotation', editor.state.doc)).toBeCloseTo(0, 6)
  const chip = [...mount.querySelectorAll('text')].map(node => node.textContent).find(text => text?.includes('×'))
  expect(chip).toBe('105.13 × 21.2')
  await at('pointerup', end)
  expect(mount.querySelector<HTMLInputElement>('input[aria-label="旋转 °"]')!.value).toBe('30.00')
  expect(selectionMetric(editor.state.doc.nodes[n.id], 'rotation', editor.state.doc)).toBeCloseTo(30, 6)
})
for(const finish of ['Escape','pointercancel']) {
 test(`T03 mirrored nested rotation ${finish}: exact document rollback and no history`,async()=>{
  const parent=node('frame',400,200,300,300),n=node('rectangle',100,50,100,80),sibling=node('rectangle',220,10,20,20);parent.transform=[-1,0,0,1,400,200];parent.children=[n.id,sibling.id]
  await render([parent,n,sibling],[parent.id]);await act(async()=>editor.select([n.id]));await camera(2);const before=editor.state.doc,center=apply(world(n.id),{x:50,y:40})
  await rotateGesture(center,30,finish);expect(editor.state.doc).toEqual(before);expect(editor.canUndo).toBe(false);expect(editor.interactionActive).toBe(false)
 })
}
test('T03 invalid mounted rotation and Escape cannot commit or consume existing redo',async()=>{
 const a=node('rectangle',100,100,100,50),b=node('rectangle',300,100,100,50);await render([a,b]);await act(async()=>{editor.select([a.id,b.id]);editor.update([a.id],{width:120});editor.undo()});const before=editor.state.doc
 await field('旋转 °','not-a-number','Escape');expect(editor.state.doc).toEqual(before);expect(editor.canRedo).toBe(true)
 await act(async()=>editor.redo());expect(editor.state.doc.nodes[a.id].width).toBe(120)
})
for(const locale of ['zh-CN','en'] as const) {
 test(`T04 ${locale} rotation property persists through FD binary codec and new Editor admission`,async()=>{
  const group=node('group',100,100,250,50),a=node('rectangle',0,0,100,50),b=node('rectangle',250,50,100,50);group.children=[a.id,b.id]
  await render([group,a,b],[group.id]);await act(async()=>{editor.select([a.id,b.id]);interfacePreference.set({locale})})
  const before=editor.state.doc;await field(locale==='en'?'Rotation °':'旋转 °','30');const committed=editor.state.doc
  const box=selectionLocalBounds(committed,group.id);expect(box.width).toBeCloseTo(361.6025403784439,8);expect(box.height).toBeCloseTo(143.30127018922192,8)
  // Real production FD codec + Editor admission, not JSON clone, OS file dialog or GUI persistence claim.
  const restored=new Editor(validateDocument(decodeDocumentBinary(encodeDocumentBinary(committed))))
  try {for(const id of [group.id,a.id,b.id]){expect(restored.state.doc.nodes[id].children).toEqual(committed.nodes[id].children);expect(restored.state.doc.nodes[id]).toEqual(committed.nodes[id])}
   const reopened=selectionLocalBounds(restored.state.doc,group.id);expect(reopened).toEqual(box)
  }finally{restored.dispose()}
  await history(before)
 })
}
test('R03 multiselect world right edge under 90-degree parent fixes only local heights and preserves local Hug widths',async()=>{
 const parent=node('frame',400,200,400,400),a=autoFrame(0,0),b=autoFrame(150,100);parent.transform=[0,1,-1,0,400,200];parent.children=[a.n.id,b.n.id]
 await render([parent,a.n,a.child,b.n,b.child],[parent.id]);await act(async()=>editor.select([a.n.id,b.n.id]));await camera(2);const before=editor.state.doc
 const edge=mount.querySelector('[data-testid="resize-edge-1"]')!;expect(edge).not.toBeNull()
 await at('pointerdown',{x:400,y:325},edge);await at('pointerup',{x:490,y:325})
 for(const id of [a.n.id,b.n.id]){const n=editor.state.doc.nodes[id];expect(n.width).toBeCloseTo(100,8);expect(n.height).toBeCloseTo(120,8);expect(n.sizing).toMatchObject({width:'hug',height:'fixed'})}
 const ea=scene(editor.state.doc,editor.state.page).find(e=>e.id===a.n.id)!,eb=scene(editor.state.doc,editor.state.page).find(e=>e.id===b.n.id)!
 expect(ea.bounds).toMatchObject({x:370,y:200,width:120,height:100});expect(eb.bounds).toMatchObject({x:220,y:350,width:120,height:100})
 expect(editor.state.doc.nodes[parent.id]).toEqual(before.nodes[parent.id]);await history(before)
})
test('T02 multiselect actual rotation handle turns child centers around selection center, not individual property pivots',async()=>{
 const group=node('group',100,100,250,50),a=node('rectangle',0,0,100,50),b=node('rectangle',250,50,100,50);group.children=[a.id,b.id]
 await render([group,a,b],[group.id]);await act(async()=>editor.select([a.id,b.id]));await camera(.5);const before=editor.state.doc,center={x:275,y:150}
 const oldCenters=[a.id,b.id].map(id=>apply(world(id),{x:50,y:25}));await rotateGesture(center,30)
 for(const [index,id] of [a.id,b.id].entries()){
  const n=editor.state.doc.nodes[id],actual=apply(world(id),{x:50,y:25}),expected=turn(oldCenters[index],center,30)
  expect(selectionMetric(n,'rotation',editor.state.doc)).toBeCloseTo(30,8);expect(actual.x).toBeCloseTo(expected.x,8);expect(actual.y).toBeCloseTo(expected.y,8)
  expect(actual).not.toEqual(oldCenters[index]);expect(n.width).toBeCloseTo(100,8);expect(n.height).toBeCloseTo(50,8)
 }
 expect(editor.state.doc.nodes[group.id]).toEqual(before.nodes[group.id]);await history(before)
})
