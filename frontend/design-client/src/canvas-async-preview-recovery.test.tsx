import { canvasActions } from './canvas-action-diagnostics'
// Actual mounted Canvas/event propagation + Editor/WASM. The render-device
// boundary alone is replaced. Deterministic 60 Hz delivery does not claim
// browser/GPU FPS, compositor latency, or pixel quality.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { InteractionRenderer } from './kernel/interaction-renderer'
import { KernelClient } from './kernel/client'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { blank, node, uid, type DesignNode } from './model'
import { shortcutPreference } from './shortcut-preference'

const worker = vi.hoisted(() => ({ recoveries: 0, syncThrow: false, jobs: [] as any[], stops: [] as number[], owner: null as InteractionRenderer | null }))
vi.mock('./kernel/client', async importOriginal => {
 const actual = await importOriginal<typeof import('./kernel/client')>()
 return {...actual, KernelClient: class {
  cancelPreview() {} dispose() {} moveResidentInteraction() {} releasePresented() {}
  stopResidentInteraction(id:number) { worker.stops.push(id) }
  render(document:unknown,options:any) {if(worker.syncThrow)throw Error('Sampling coordinate field exceeds 64 MiB');return new Promise((resolve,reject)=>worker.jobs.push({document,options,reject,
   resolve:(result={})=>resolve({bytes:new Uint8Array(options.width*options.height*4),...result})}))}
 }}
})
const previewControl=vi.hoisted(()=>({supported:false}))
vi.mock('./edit-preview',()=>({supportsEditPreview:()=>previewControl.supported}))
vi.mock('./CanvasEditPreview',()=>({CanvasEditPreview:()=>null}))
const presentationControl = vi.hoisted(() => ({ hold: false, lastDocument: undefined as object | undefined, requests: [] as any[] }))
vi.mock('./kernel/Surface', async () => {
  const { useLayoutEffect, useRef } = await import('react')
  return { KernelSurface(props: import('./kernel/Surface').SurfaceProps) {
    const owner = useRef<InteractionRenderer | null>(null)
    if (!owner.current) worker.owner = owner.current = new InteractionRenderer(()=>{}, new KernelClient())
    useLayoutEffect(()=>()=>owner.current!.dispose(),[])
    useLayoutEffect(()=>{owner.current!.prepare(props.interaction && {...props.interaction,onPreviewFailed: failure=>{worker.recoveries++;props.interaction!.onPreviewFailed?.(failure)}}, props.pageId, props.view, 1, 'figmaSubpixel','webgpu',undefined,{width:1000,height:800})},[props.interaction,props.pageId,props.view])
    useLayoutEffect(() => {
      presentationControl.requests.push({document:props.document,pageId:props.pageId,overview:props.overview})
      if (presentationControl.hold) return
      presentationControl.lastDocument = props.document
      props.onPresentation?.({ ...props, epoch: props.presentationEpoch!, pixelRatio: 1, managed: false })
    }, [props.document, props.pageId, props.view, props.width, props.height, props.presentationEpoch, props.onPresentation])
    return <div data-testid="surface-boundary" />
  } }
})
let dom: any, root: Root, mount: HTMLDivElement, editor: Editor, errors: unknown[][]
let frames: Map<number, FrameRequestCallback>, frameId: number
beforeEach(() => {
  worker.recoveries=0;worker.syncThrow=false;worker.jobs=[];worker.stops=[];worker.owner=null
  previewControl.supported=false
  presentationControl.hold = false; presentationControl.lastDocument = undefined;presentationControl.requests=[]
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
  localStorage.clear(); shortcutPreference.set('sketch-like')
  Object.assign(window, { coreDesktop: { renderDiagnostics: true, renderDiagnosticsDetail: true } })
  editor = new Editor(blank()); editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false })
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount()); canvasActions(editor).close(); editor.dispose(); dom.window.close()
  vi.unstubAllGlobals(); vi.restoreAllMocks(); expect(errors).toEqual([])
})
const host = () => mount.querySelector<HTMLElement>('[data-testid="canvas"]')!
async function render(nodes: DesignNode[], roots = nodes.map(n => n.id), otherRoots: string[] = [], withPages = false) {
  const doc = blank('Canvas event batching'); doc.nodes = Object.fromEntries(nodes.map(n => [n.id, n])); doc.pages[0].children = roots
  doc.id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'; doc.pages[0].id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  doc.pages.push({ ...doc.pages[0], id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', name: 'Empty page', children: [] })
  if (otherRoots.length) doc.pages.push({ ...doc.pages[0], id: uid(), name: 'Other page', children: otherRoots })
  editor.load(doc); editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false })
  await act(async () => { root.render(<><Canvas editor={editor} /></>); for (let i = 0; i < 6; i++) await Promise.resolve() })
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

async function flushFrames(at = 0) {
  await act(async () => { for (const [id, fn] of [...frames]) { frames.delete(id); fn(at) } })
}
test.each(['commit','cancel','sync-throw'] as const)('mounted Canvas transfers stopped pointer fatal once and %s',async finish=>{
 const parent=node('frame',0,0,400,300),child=node('rectangle',100,100,100,100)
 parent.blend='normal';parent.children=[child.id]
 await render([parent,child],[parent.id]);await act(async()=>editor.select([child.id]))
 const preview=vi.spyOn(editor,'preview')
 if(finish==='sync-throw'){
  await act(async()=>{pointer('pointerdown',150,150);pointer('pointermove',170,150)})
  await flushFrames(8)
  await act(async()=>{for(let job=0;job<worker.jobs.length;job++){worker.jobs[job].resolve({gpuTile:990,residentInteraction:false});for(let i=0;i<10;i++)await Promise.resolve()}})
  worker.syncThrow=true
  await act(async()=>pointer('pointermove',190,150))
 }else await act(async()=>{pointer('pointerdown',150,150);pointer('pointermove',170,150);pointer('pointermove',190,150)})
 await flushFrames(16)
 expect(editor.interactionActive).toBe(true)
 if(finish!=='sync-throw')expect(worker.owner!.control.inputSequence!()).toBeGreaterThan(0)
 if(finish!=='sync-throw'){expect(preview).not.toHaveBeenCalled();await act(async()=>{worker.jobs.at(-1).reject(Error('Sampling coordinate field exceeds 64 MiB'));for(let i=0;i<10;i++)await Promise.resolve()})}
 expect(worker.recoveries).toBe(1)
 expect(preview).toHaveBeenCalledOnce()
 expect(editor.state.doc.nodes[child.id].transform[4]).toBe(140)
 if(finish!=='sync-throw')expect(worker.stops).toHaveLength(0)
 if(finish!=='cancel'){
  await act(async()=>pointer('pointerup',190,150))
  expect(editor.state.doc.nodes[child.id].transform[4]).toBe(140)
  await act(async()=>editor.undo());expect(editor.state.doc.nodes[child.id].transform[4]).toBe(100)
  expect(editor.canUndo).toBe(false)
  await act(async()=>editor.redo());expect(editor.state.doc.nodes[child.id].transform[4]).toBe(140)
 }else{
  await act(async()=>{key('Escape')});expect(editor.state.doc.nodes[child.id].transform[4]).toBe(100)
  expect(editor.canUndo).toBe(false)
 }
})
