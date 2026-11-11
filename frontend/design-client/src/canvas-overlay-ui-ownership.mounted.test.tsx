// Actual mounted Canvas/event propagation + Editor/WASM. Only the render-device
// boundary is replaced; no native browser, GPU, or pixel-quality claim.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { blank, node, uid, type DesignNode } from './model'
import { shortcutPreference } from './shortcut-preference'
import { scene } from './geometry'

const boundary=vi.hoisted(()=>({props:null as any,initial:false}))
vi.mock('./kernel/Surface', async () => {
 const {useLayoutEffect}=await import('react')
 return {KernelSurface(props:import('./kernel/Surface').SurfaceProps){
  boundary.props=props
  useLayoutEffect(()=>{
   if(boundary.initial)return
   boundary.initial=true
   props.onPresentation?.({...props,epoch:props.presentationEpoch!,pixelRatio:1,managed:false})
  },[props])
  return <div data-testid="surface-boundary" />
 }}
})

let dom: any, root: Root, mount: HTMLDivElement, editor: Editor, errors: unknown[][]
let frames: Map<number, FrameRequestCallback>, frameId: number
beforeEach(() => {
  boundary.props=null;boundary.initial=false
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
  editor = new Editor(blank()); editor.set({ view: { x: 0, y: 0, zoom: 4 }, pixelGrid:false,snap: false, snapPixels: false })
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
  editor.load(doc); editor.set({ view: { x: 0, y: 0, zoom: 4 }, pixelGrid:false,snap: false, snapPixels: false })
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

async function flushFrames(){await act(async()=>{for(const [id,fn] of [...frames]){frames.delete(id);fn(performance.now())}})}
async function present(overlay=boundary.props.overlay,document=overlay.document,gpuOverlay=true,gpuSelection=gpuOverlay&&!!overlay.commands.selection){
 const p=boundary.props
 await act(async()=>p.onPresentation({...p,document,epoch:p.presentationEpoch,pixelRatio:1,managed:true,
  gpuOverlay,gpuSelectionIdentity:gpuSelection?overlay.selectionIdentity:undefined,
  gpuOverlayIdentity:gpuOverlay?overlay.uiIdentity:undefined,preview:true}))
}
async function retained(){
 const selected=node('frame',20,20,40,40),target=node('rectangle',100,20,30,40),other=node('rectangle',180,20,30,40)
 await render([selected,target,other]);await act(async()=>editor.select([selected.id]))
 const original=editor.state.doc,overlay=boundary.props.overlay
 await present(overlay)
 await act(async()=>editor.update([selected.id],{transform:[1,0,0,1,24,20]},'Move'))
 const committed=editor.state.doc
 expect(committed).not.toBe(original)
 expect(boundary.props.overlay.uiIdentity).toBe(overlay.uiIdentity)
 expect(mount.querySelector('[data-frame-title]')?.getAttribute('opacity')).toBe('0')
 return {original,committed,overlay,selected,target,other}
}

test('actual Canvas shows enabled zoom>=4 pixel grid immediately despite stale same-UI GPU ACK',async()=>{
 const h=await retained()
 await act(async()=>editor.set({pixelGrid:true}))
 expect(editor.state.doc).toBe(h.committed)
 expect(mount.querySelector('[data-testid="pixel-grid"]')).not.toBeNull()
 await present(h.overlay,h.original)
 expect(mount.querySelector('[data-testid="pixel-grid"]')).not.toBeNull()
 expect(mount.querySelector('[data-frame-title]')?.getAttribute('opacity')).toBe('1')
 const current=boundary.props.overlay
 await present(current,h.original)
 expect(mount.querySelector('[data-testid="pixel-grid"]')).toBeNull()
 expect(editor.canUndo).toBe(true)
 await act(async()=>editor.undo())
 expect(editor.state.doc).toEqual(h.original);expect(editor.canUndo).toBe(false);expect(editor.canRedo).toBe(true)
 await act(async()=>editor.redo())
 expect(editor.state.doc).toEqual(h.committed)
})

test('actual Canvas Space changes handles identity while B stays committed and cannot hide current DOM',async()=>{
 const h=await retained()
 expect(h.overlay.commands.selection.handles).toBe(true)
 await act(async()=>key(' ',{code:'Space'}))
 expect(editor.state.doc).toBe(h.committed)
 expect(boundary.props.overlay.commands.selection.handles).toBe(false)
 await present(h.overlay,h.original)
 expect(mount.querySelector('[data-frame-title]')?.getAttribute('opacity')).toBe('1')
 expect(mount.querySelector('[data-testid="resize-0"]')).toBeNull()
 await act(async()=>key(' ',{code:'Space'},'keyup'))
 expect(boundary.props.overlay.commands.selection.handles).toBe(true)
 expect(boundary.props.overlay.uiIdentity).toBe(h.overlay.uiIdentity)
})

test('actual Canvas Alt hover target changes identity and stale measurement ACK cannot hide fresh guides',async()=>{
 const h=await retained()
 await act(async()=>pointer('pointermove',440,120,{altKey:true}));await flushFrames()
 const first=boundary.props.overlay
 expect(first.commands.measurements.length).toBeGreaterThan(0)
 await present(first,h.original)
 expect([...mount.querySelectorAll('[data-testid="canvas-measurement"]')].every(e=>e.getAttribute('opacity')==='0')).toBe(true)
 await act(async()=>pointer('pointermove',760,120,{altKey:true}));await flushFrames()
 const second=boundary.props.overlay
 expect(editor.state.doc).toBe(h.committed)
 expect(second.commands.measurements).not.toEqual(first.commands.measurements)
 await present(first,h.original)
 const visible=[...mount.querySelectorAll('[data-testid="canvas-measurement"]')]
 expect(visible.length).toBeGreaterThan(0)
 expect(visible.every(e=>e.getAttribute('opacity')==='1')).toBe(true)
 expect(second.uiIdentity).not.toBe(first.uiIdentity)
 await act(async()=>key('Alt',{altKey:false},'keyup'))
 expect(boundary.props.overlay.commands.measurements).toHaveLength(0)
 expect(mount.querySelector('[data-testid="canvas-measurement"]')).toBeNull()
})

test('actual Canvas does not trust a legacy GPU overlay ACK lacking UI identity',async()=>{
 await retained()
 const p=boundary.props
 await act(async()=>p.onPresentation({...p,epoch:p.presentationEpoch,pixelRatio:1,managed:true,gpuOverlay:true,preview:true}))
 expect(mount.querySelector('[data-frame-title]')?.getAttribute('opacity')).toBe('1')
})

test('the acknowledged outline keeps its owner when a transform begins or a frame has only other chrome', async () => {
  const selected = node('frame', 20, 20, 40, 40)
  const original = await render([selected])
  await act(async () => editor.select([selected.id]))
  await present()

  const opacity = (testId: string) => mount.querySelector(`[data-testid="${testId}"]`)?.getAttribute('opacity')
  expect(opacity('canvas-selection-outline')).toBe('0')
  const rotate = mount.querySelector('[data-testid="rotate-corner-0"]')!
  await act(async () => pointer('pointerdown', 76, 76, {}, rotate))
  expect(editor.interactionActive).toBe(true)
  expect(opacity('canvas-selection-outline')).toBe('0')
  expect(opacity('resize-0')).toBe('0')

  await present(boundary.props.overlay, original, true, false)
  expect(opacity('canvas-selection-outline')).toBe('1')
  expect(opacity('resize-0')).toBe('1')
  expect(mount.querySelector('[data-frame-title]')?.getAttribute('opacity')).toBe('0')
  await present()
  expect(opacity('canvas-selection-outline')).toBe('0')

  await act(async () => pointer('pointercancel', 76, 76))
  expect(editor.interactionActive).toBe(false)
  unchanged(original)
  expect(opacity('canvas-selection-outline')).toBe('0')
})

test('an angle change keeps the acknowledged outline until its pixels are replaced', async () => {
  const selected = node('frame', 20, 20, 40, 40)
  const original = await render([selected])
  await act(async () => editor.select([selected.id]))
  const before = boundary.props.overlay
  await present()

  await act(async () => editor.update([selected.id], { transform: [0, 1, -1, 0, 60, 20] }, 'Rotate'))
  expect(boundary.props.overlay.uiIdentity).not.toBe(before.uiIdentity)
  expect(boundary.props.overlay.selectionIdentity).toBe(before.selectionIdentity)
  const outline = () => mount.querySelector('[data-testid="canvas-selection-outline"]')?.getAttribute('opacity')
  expect(outline()).toBe('0')

  await present(before, original, true, false)
  expect(outline()).toBe('1')
  await present()
  expect(outline()).toBe('0')

  await act(async () => key(' ', { code: 'Space' }))
  expect(boundary.props.overlay.selectionIdentity).not.toBe(before.selectionIdentity)
  expect(outline()).toBe('1')
})

test('local rotation keeps its outline through the exact frame handoff', async () => {
  const selected = node('rectangle', 20, 20, 40, 40)
  await render([selected])
  await act(async () => editor.select([selected.id]))
  const rotate = mount.querySelector('[data-testid="rotate-corner-0"]')!
  await act(async () => pointer('pointerdown', 76, 76, {}, rotate))
  await act(async () => pointer('pointermove', 111, 61))

  const local = mount.querySelector('[data-testid="rotation-source-preview"] svg polygon')
  const outline = () => mount.querySelector<SVGElement>('[data-testid="canvas-selection-outline"]')!
  expect(local).not.toBeNull()
  expect(outline().style.visibility).toBe('hidden')
  await act(async () => pointer('pointerup', 111, 61))
  expect(editor.interactionActive).toBe(false)
  expect(editor.canUndo).toBe(true)
  expect(local?.isConnected).toBe(true)
  expect(outline().style.visibility).toBe('hidden')

  const p = boundary.props
  await act(async () => p.onPresentation({
    ...p, document: editor.state.doc, epoch: p.presentationEpoch, pixelRatio: 1, managed: true,
  }))
  expect(local?.isConnected).toBe(false)
  expect(outline().style.visibility).toBe('')
})
