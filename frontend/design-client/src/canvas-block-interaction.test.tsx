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
import { scene, worldMatrix } from './geometry'

const recordedOverlay = vi.hoisted(() => ({ labels: [] as string[] }))
vi.mock('./kernel/Surface', async () => {
  const { useLayoutEffect } = await import('react')
  return { KernelSurface(props: import('./kernel/Surface').SurfaceProps) {
    recordedOverlay.labels = props.overlay?.commands.labels?.map(label => label.text) || []
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
  localStorage.clear(); shortcutPreference.set('sketch-like')
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


test('Hand tool pans the viewport without moving content, changing selection, or adding document history',async()=>{
 const frame=node('frame',100,100,400,300),child=node('rectangle',40,40,100,75);frame.children=[child.id]
 const before=await render([frame,child],[frame.id]);await act(async()=>{editor.select([child.id]);editor.set({tool:'hand'})})
 await act(async()=>pointer('pointerdown',150,150));await act(async()=>pointer('pointermove',175,180));await act(async()=>pointer('pointerup',195,215))
 expect(editor.state.doc).toBe(before);expect(editor.state.selection).toEqual([child.id]);expect(editor.state.view.x).toBeGreaterThan(0);expect(editor.state.view.y).toBeGreaterThan(0);expect(editor.canUndo).toBe(false);expect(editor.interactionActive).toBe(false)
})
test.each(['group','frame'] as const)('dragging whole selected %s moves descendants once through parent transform and undoes once',async kind=>{
 const block=node(kind,100,100,400,300),child=node('rectangle',40,40,100,75),sibling=node('rectangle',600,100,50,50);block.children=[child.id]
 const before=await render([block,child,sibling],[block.id,sibling.id]);await act(async()=>editor.select([block.id]));const childBefore=worldMatrix(before,child.id)
 const target=kind==='frame'?mount.querySelector(`[data-frame-title="${block.id}"]`)!:host()
 await act(async()=>pointer('pointerdown',150,150,{},target));await act(async()=>pointer('pointermove',165,170));await act(async()=>pointer('pointerup',185,195))
 expect(editor.state.selection).toEqual([block.id]);expect(editor.state.doc.nodes[block.id].transform.slice(4)).toEqual([135,145]);expect(editor.state.doc.nodes[child.id]).toEqual(before.nodes[child.id]);expect(editor.state.doc.nodes[sibling.id]).toEqual(before.nodes[sibling.id])
 const childAfter=worldMatrix(editor.state.doc,child.id);expect(childAfter[4]-childBefore[4]).toBe(35);expect(childAfter[5]-childBefore[5]).toBe(45)
 const after=editor.state.doc;await act(async()=>editor.undo());expect(editor.state.doc).toEqual(before);expect(editor.canUndo).toBe(false);await act(async()=>editor.redo());expect(editor.state.doc).toEqual(after)
})
test('entered nested child drag edits only child; copied frame descendants get independent IDs and undo',async()=>{
 const frame=node('frame',100,100,400,300),group=node('group',20,20,180,100),child=node('rectangle',20,20,100,75);frame.children=[group.id];group.children=[child.id]
 const before=await render([frame,group,child],[frame.id]);await act(async()=>editor.select([child.id]))
 await act(async()=>pointer('pointerdown',150,150));await act(async()=>pointer('pointermove',160,165));await act(async()=>pointer('pointerup',175,185))
 expect(editor.state.selection).toEqual([child.id]);expect(editor.state.doc.nodes[child.id].transform.slice(4)).toEqual([45,55]);expect(editor.state.doc.nodes[group.id]).toEqual(before.nodes[group.id]);expect(editor.state.doc.nodes[frame.id]).toEqual(before.nodes[frame.id]);await act(async()=>editor.undo());expect(editor.state.doc).toEqual(before)
 await act(async()=>{editor.select([frame.id]);editor.copy();editor.paste(false,{x:650,y:100})})
 const copied=editor.state.selection[0],copiedGroup=editor.state.doc.nodes[copied].children[0],copiedChild=editor.state.doc.nodes[copiedGroup].children[0]
 expect(new Set([frame.id,group.id,child.id,copied,copiedGroup,copiedChild]).size).toBe(6)
 expect(editor.state.doc.nodes[copiedChild]).toMatchObject({kind:'rectangle',width:100,height:75})
 const pasted=editor.state.doc;await act(async()=>editor.update([copiedChild],{width:120.5,name:'Independent'},'Edit pasted child'));expect(editor.state.doc.nodes[child.id]).toEqual(before.nodes[child.id]);await act(async()=>editor.undo());expect(editor.state.doc).toEqual(pasted);await act(async()=>editor.undo());expect(editor.state.doc).toEqual(before);expect(editor.canUndo).toBe(false)
})
test('Canvas SVG selected-size label preserves fractional dimensions after rotation without using world AABB',async()=>{
 const frame=node('frame',0,0,3000,3000),child=node('rectangle',20,20,1466.59,1049.02);frame.children=[child.id];frame.transform=[1,0,0,1,0,0];child.transform=[Math.SQRT1_2,Math.SQRT1_2,-Math.SQRT1_2,Math.SQRT1_2,20,20]
 await render([frame,child],[frame.id]);await act(async()=>editor.select([child.id]));expect([...mount.querySelectorAll('svg text')].map(n=>n.textContent)).toContain('1466.59 × 1049.02');expect(recordedOverlay.labels).toContain('1466.59 × 1049.02')
})
