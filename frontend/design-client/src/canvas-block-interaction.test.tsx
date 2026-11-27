// Actual mounted Canvas/event propagation + Editor/WASM. Only the render-device
// boundary is replaced; no native browser, GPU, or pixel-quality claim.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { blank, node, uid, type DesignDocument, type DesignNode } from './model'
import { shortcutPreference } from './shortcut-preference'
import { scene, worldMatrix, inverse, multiply } from './geometry'
import { armComponentPlacement } from './component-placement'
import { interfacePreference } from './interface-preference'

const recordedOverlay = vi.hoisted(() => ({ labels: [] as string[], control: undefined as import('./kernel/interaction-layers').GpuMoveControl | undefined }))
vi.mock('./kernel/Surface', async () => {
  const { useLayoutEffect } = await import('react')
  return { KernelSurface(props: import('./kernel/Surface').SurfaceProps) {
    if(recordedOverlay.control && props.interaction) props.interaction.control.current = recordedOverlay.control
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
  recordedOverlay.control = undefined
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
  await act(async () => root.unmount()); editor.dispose(); interfacePreference.reset(); dom.window.close()
  vi.unstubAllGlobals(); vi.restoreAllMocks(); expect(errors).toEqual([])
})
const host = () => mount.querySelector<HTMLElement>('[data-testid="canvas"]')!
async function render(nodes: DesignNode[], roots = nodes.map(n => n.id), otherRoots: string[] = [], rasterProfile?: DesignDocument['rasterProfile']) {
  const doc = blank('Selection workflows'); doc.nodes = Object.fromEntries(nodes.map(n => [n.id, n])); doc.pages[0].children = roots
  if (rasterProfile) doc.rasterProfile = rasterProfile
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
async function flushFrames() {
  await act(async () => {
    const batch = [...frames.values()]
    frames.clear()
    batch.forEach(fn => fn(performance.now()))
  })
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
test.each(['pointerup', 'pointercancel'])('the original pointer can finish or cancel a drag outside the canvas after lost capture (%s)', async terminal => {
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  const shape = node('rectangle', 100, 100, 100, 90)
  const before = await render([shape])
  const outside = document.createElement('div')
  document.body.append(outside)
  await act(async () => editor.select([shape.id]))
  await act(async () => pointer('pointerdown', 135, 135, { buttons: 1 }))
  await act(async () => pointer('pointermove', 147, 153, { buttons: 1 }))
  await act(async () => pointer('lostpointercapture', 147, 153))
  const held = editor.state.doc
  await act(async () => pointer('pointermove', 157, 163, { buttons: 0 }, outside))
  expect(editor.interactionActive).toBe(true)
  expect(editor.state.doc).toBe(held)
  await act(async () => pointer('pointerup', 162, 167, {}, outside, 8))
  expect(editor.interactionActive).toBe(true)
  await act(async () => pointer('pointermove', 167, 173, { buttons: 1 }, outside))
  await act(async () => pointer(terminal, 185, 195, {}, outside))
  expect(editor.interactionActive).toBe(false)
  if (terminal === 'pointercancel') unchanged(before)
  else {
    expect(editor.state.doc.nodes[shape.id].transform.slice(4)).toEqual([150, 160])
    const after = editor.state.doc
    await act(async () => editor.undo())
    expect(editor.state.doc).toEqual(before)
    expect(editor.canUndo).toBe(false)
    await act(async () => editor.redo())
    expect(editor.state.doc).toEqual(after)
  }
})

test.each([
  ['releases after capture loss', 'pointerup', true],
  ['cancels after capture loss', 'pointercancel', true],
  ['cancels while captured', 'pointercancel', false],
] as const)('edge resize %s', async (_label, terminal, losesCapture) => {
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  const shape = node('rectangle', 100, 100, 100, 90)
  const before = await render([shape])
  await act(async () => editor.select([shape.id]))
  const revision = editor.state.version
  const edge = mount.querySelector<SVGLineElement>('[data-testid="resize-edge-1"]')!
  expect(edge).toBeTruthy()
  const outside = document.createElement('div')
  document.body.append(outside)

  await act(async () => pointer('pointerdown', 200, 145, { buttons: 1 }, edge))
  expect(editor.interactionActive).toBe(true)
  await act(async () => pointer('pointermove', 212, 145, { buttons: 1 }))
  await flushFrames()
  expect(editor.state.doc.nodes[shape.id].width).toBeCloseTo(112, 9)
  expect(editor.state.version).toBe(revision)
  expect(editor.canUndo).toBe(false)

  if (losesCapture) {
    await act(async () => pointer('lostpointercapture', 212, 145, { buttons: 1 }))
    expect(editor.interactionActive).toBe(true)
    expect(editor.state.doc.nodes[shape.id].width).toBeCloseTo(112, 9)
  }
  const target = losesCapture ? outside : host()
  await act(async () => pointer('pointermove', 224, 145, { buttons: 1 }, target))
  await flushFrames()
  expect(editor.state.doc.nodes[shape.id].width).toBeCloseTo(124, 9)
  expect(editor.state.version).toBe(revision)
  expect(editor.canUndo).toBe(false)

  await act(async () => pointer(terminal, 235, 145, { button: 0, buttons: 0 }, target))
  expect(editor.interactionActive).toBe(false)
  if (terminal === 'pointercancel') {
    unchanged(before)
    expect(editor.authoredDocument).toBe(before)
    expect(editor.state.version).toBe(revision)
  } else {
    expect(editor.authoredDocument.nodes[shape.id].width).toBeCloseTo(135, 9)
    expect(editor.authoredDocument.nodes[shape.id].height).toBe(90)
    expect(editor.state.version).toBe(revision + 1)
    expect(editor.canUndo).toBe(true)
    await act(async () => editor.undo())
    expect(editor.state.doc).toEqual(before)
    expect(editor.canUndo).toBe(false)
  }
})

test.each([
  ['space-left', true, 0, 1],
  ['middle', false, 1, 4],
] as const)('hand pan %s follows a cross-element move and the original button-up after capture loss', async (_label, space, button, buttons) => {
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  const board = node('frame', 40, 50, 240, 160)
  const before = await render([board])
  const outside = document.createElement('div')
  document.body.append(outside)
  const start = { ...editor.state.view }
  if (space) {
    await act(async () => key(' ', { code: 'Space' }))
    expect(host().classList.contains('canvas-space-held')).toBe(true)
  }
  await act(async () => pointer('pointerdown', 400, 300, { button, buttons }))
  expect(host().classList.contains('canvas-panning')).toBe(true)
  await act(async () => pointer('pointermove', 250, 160, { button, buttons }))
  await flushFrames()
  expect(editor.state.view).toEqual({ ...start, x: start.x - 150, y: start.y - 140 })
  // The last delivered move is the 2–4 CSS px residual. The real release is the original point.
  await act(async () => pointer('pointermove', 403, 304, { button, buttons }))
  await flushFrames()
  expect(editor.state.view).toEqual({ ...start, x: start.x + 3, y: start.y + 4 })
  expect(editor.effectiveView()).toEqual(editor.state.view)
  await act(async () => pointer('lostpointercapture', 403, 304, { button, buttons }))
  expect(host().classList.contains('canvas-panning')).toBe(true)
  expect(host().getAttribute('data-transform-gesture')).toBe('pan')
  expect(editor.state.view).toEqual({ ...start, x: start.x + 3, y: start.y + 4 })
  expect(editor.state.doc).toBe(before)
  // Capture loss can report no buttons before the real pointerup. That sample is not a release.
  await act(async () => pointer('pointermove', 12, 16, { button, buttons: 0 }, outside))
  await flushFrames()
  expect(editor.effectiveView()).toEqual({ ...start, x: start.x + 3, y: start.y + 4 })
  await act(async () => pointer('pointermove', 430, 280, { button, buttons }, outside))
  await flushFrames()
  expect(editor.state.view).toEqual({ ...start, x: start.x + 30, y: start.y - 20 })
  expect(editor.state.doc).toBe(before)
  expect(editor.state.doc.nodes[board.id].transform.slice(4)).toEqual([40, 50])
  await act(async () => pointer('pointerup', 400, 300, { button: button === 0 ? 1 : 0, buttons: 0 }, outside))
  expect(host().classList.contains('canvas-panning')).toBe(true)
  expect(editor.state.view).toEqual({ ...start, x: start.x + 30, y: start.y - 20 })
  await act(async () => pointer('pointerup', 400, 300, { button, buttons: 0 }, outside, 9))
  expect(host().classList.contains('canvas-panning')).toBe(true)
  await act(async () => pointer('pointerup', 400, 300, { button, buttons: 0 }, outside))
  expect(editor.state.view).toEqual(start)
  expect(editor.effectiveView()).toEqual(start)
  expect(editor.state.doc).toBe(before)
  expect(editor.state.doc.nodes[board.id].transform.slice(4)).toEqual([40, 50])
  expect(editor.canUndo).toBe(false)
  expect(editor.canRedo).toBe(false)
  expect(host().classList.contains('canvas-panning')).toBe(false)
  expect(host().getAttribute('data-transform-gesture')).toBeNull()
})

test('asset placement inserts at the next canvas point and Escape clears a pending placement', async () => {
  interfacePreference.set({ uiMode: 'figma' })
  const frame = node('frame', 90, 90, 120, 75)
  await render([frame])
  await act(async () => { editor.select([frame.id]); editor.createComponent() })
  const source = editor.state.selection[0], before = editor.state.doc
  expect(before.nodes[source].component).toBeDefined()
  expect(armComponentPlacement(editor, source)).toBe(true)
  await act(async () => pointer('pointerdown', 420, 210, { buttons: 1 }))
  const instance = editor.state.doc.nodes[editor.state.selection[0]]
  expect(instance.instance?.componentId).toBe(source)
  expect(instance.transform.slice(4)).toEqual([420, 210])
  await act(async () => editor.undo())
  expect(editor.state.doc).toBe(before)

  expect(armComponentPlacement(editor, source)).toBe(true)
  await act(async () => key('Escape'))
  await act(async () => pointer('pointerdown', 460, 260, { buttons: 1 }))
  await act(async () => pointer('pointerup', 460, 260))
  expect(editor.state.doc).toBe(before)
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
test('a continuing cross-frame drag does not end its GPU owner before the replacement preview',async()=>{
 const a=node('frame',0,0,200,200),b=node('frame',300,0,200,200),child=node('rectangle',20,20,40,40)
 a.children=[child.id];await render([a,b,child],[a.id,b.id]);await act(async()=>editor.select([child.id]))
 const end=vi.fn(),apply=vi.fn(()=>({x:10,y:0}))
 recordedOverlay.control={apply,end,isActive:()=>true,covers:()=>true,feedbackPending:()=>false}
 await act(async()=>editor.set({snap:false}));end.mockClear()
 await act(async()=>pointer('pointerdown',40,40))
 end.mockClear() // Idle hover/selection notifications precede transaction start.
 await act(async()=>pointer('pointermove',50,40))
 await act(async()=>{const batch=[...frames.values()];frames.clear();batch.forEach(fn=>fn(performance.now()))})
 expect(apply).toHaveBeenCalled();expect(end).not.toHaveBeenCalled()
 await act(async()=>pointer('pointermove',350,40))
 await act(async()=>{const batch=[...frames.values()];frames.clear();batch.forEach(fn=>fn(performance.now()))})
 expect(editor.state.doc.nodes[b.id].children).toEqual([child.id]);expect(end).not.toHaveBeenCalled()
 await act(async()=>pointer('pointerup',350,40));expect(end).toHaveBeenCalled()
})
test.each(['metaKey','ctrlKey'])('a %s move with unchanged placement keeps the admitted GPU preview',async modifier=>{
 const a=node('frame',0,0,200,200),child=node('rectangle',20,20,40,40);a.children=[child.id]
 await render([a,child],[a.id]);await act(async()=>editor.select([child.id]))
 const apply=vi.fn(()=>({x:20,y:0}))
 recordedOverlay.control={apply,end:vi.fn(),isActive:()=>true,covers:()=>true,feedbackPending:()=>false}
 await act(async()=>editor.set({snap:false}));const before=editor.state.doc
 await act(async()=>pointer('pointerdown',40,40))
 await act(async()=>pointer('pointermove',60,40,{[modifier]:true}))
 await act(async()=>{const batch=[...frames.values()];frames.clear();batch.forEach(fn=>fn(performance.now()))})
 expect(apply).toHaveBeenCalled();expect(editor.state.doc).toBe(before)
 await act(async()=>pointer('pointerup',60,40,{[modifier]:true}))
 expect(editor.state.doc.nodes[a.id].children).toEqual([child.id]);expect(editor.state.doc.nodes[child.id].transform.slice(4)).toEqual([40,20])
})
test('Canvas SVG selected-size label preserves fractional dimensions after rotation without using world AABB',async()=>{
 const frame=node('frame',0,0,3000,3000),child=node('rectangle',20,20,1466.59,1049.02);frame.children=[child.id];frame.transform=[1,0,0,1,0,0];child.transform=[Math.SQRT1_2,Math.SQRT1_2,-Math.SQRT1_2,Math.SQRT1_2,20,20]
 await render([frame,child],[frame.id]);await act(async()=>editor.select([child.id]));expect([...mount.querySelectorAll('svg text')].map(n=>n.textContent)).toContain('1466.59 × 1049.02');expect(recordedOverlay.labels).toContain('1466.59 × 1049.02')
})


test('rotation uses affine pose preview and pointerup commits its final input before the render props catch up',async()=>{
 const rectangle=node('rectangle',100,100,100,80)
 const before=await render([rectangle]);await act(async()=>editor.select([rectangle.id]))
 const apply=vi.fn((_document:typeof before,patches:Record<string,Partial<DesignNode>>)=>{
   const matrix=multiply(patches[rectangle.id].transform!,inverse(before.nodes[rectangle.id].transform))
   return {x:matrix[4],y:matrix[5],matrix}
 }),end=vi.fn()
 recordedOverlay.control={apply,end,isActive:()=>true,covers:()=>true,feedbackPending:()=>false}
 await act(async()=>editor.set({snap:false}))
 const handle=mount.querySelector<HTMLElement>('[data-testid="rotate-corner-0"]')!
 const x=Number(handle.dataset.anchorX),y=Number(handle.dataset.anchorY)
 await act(async()=>pointer('pointerdown',x,y,{},handle))
 await act(async()=>{pointer('pointermove',220,140);const queued=[...frames.values()];frames.clear();queued.forEach(fn=>fn(performance.now()))})
 // Own paint follows. The GPU pose is not asked to reconvert this rectangle on the sample.
 expect(apply).not.toHaveBeenCalled();expect(editor.state.doc).toBe(before)
 const sourcePaint=mount.querySelector<HTMLElement>('[data-testid="rotation-source-paint"]')
 expect(sourcePaint).not.toBeNull()
 expect(mount.querySelector('[data-testid="rotation-source-preview"] canvas')).toBeNull()
 expect(sourcePaint!.style.transform).toContain('matrix(')
 expect(mount.querySelector('[data-testid="canvas-selection-outline"]')?.getAttribute('opacity')).toBe('0')
 end.mockClear()
 await act(async()=>pointer('pointerup',150,220))
 expect(apply).not.toHaveBeenCalled()
 expect(editor.state.doc.nodes[rectangle.id].transform).not.toEqual(before.nodes[rectangle.id].transform)
 expect(end).toHaveBeenCalledWith(editor.state.doc);expect(editor.interactionActive).toBe(false)
 expect(mount.querySelector<HTMLElement>('[data-testid="canvas-selection-outline"]')!.style.transform).toBe('')
 await act(async()=>editor.undo());expect(editor.state.doc).toEqual(before);expect(editor.canUndo).toBe(false)
})
test.each(['figma', 'figmaSoftware'] as const)('rotation uses the document renderer during a %s drag', async rasterProfile => {
 const shape = node('rectangle', 100, 100, 100, 80)
 const before = await render([shape], [shape.id], [], rasterProfile)
 await act(async () => { editor.select([shape.id]); editor.set({ snap: false }) })
 const handle = mount.querySelector<HTMLElement>('[data-testid="rotate-corner-0"]')!
 const x = Number(handle.dataset.anchorX), y = Number(handle.dataset.anchorY)

 await act(async () => pointer('pointerdown', x, y, {}, handle))
 await act(async () => pointer('pointermove', 220, 140))
 await flushFrames()
 expect(mount.querySelector('[data-testid="rotation-source-paint"]')).toBeNull()
 const preview = editor.state.doc.nodes[shape.id].transform
 expect(preview).not.toEqual(before.nodes[shape.id].transform)
 expect(editor.canUndo).toBe(false)

 await act(async () => pointer('pointerup', 220, 140))
 expect(editor.state.doc.nodes[shape.id].transform).toEqual(preview)
 expect(editor.canUndo).toBe(true)
 await act(async () => editor.undo())
 expect(editor.state.doc).toEqual(before)
 expect(editor.canUndo).toBe(false)
})
test('repeated camera changes and document replacement retire queued stale pointer ownership and permit the next edit',async()=>{
 const rectangle=node('rectangle',100,100,100,80);const before=await render([rectangle])
 await act(async()=>editor.select([rectangle.id]))
 for(const zoom of [0.5,1.9,0.025,1,0.25,1])await act(async()=>editor.set({view:{x:0,y:0,zoom}}))
 await act(async()=>pointer('pointerdown',150,140))
 await act(async()=>pointer('pointermove',180,160))
 const reopened=structuredClone(before);reopened.name='Replacement owner'
 await act(async()=>{editor.load(reopened);editor.set({view:{x:0,y:0,zoom:1}});editor.select([rectangle.id])})
 await act(async()=>editor.set({view:{x:0,y:0,zoom:1}})) // Session-open fit has completed.
 await act(async()=>{editor.begin('Replacement transaction');pointer('pointercancel',180,160)})
 expect(editor.interactionActive).toBe(true) // The retired pointer cannot cancel a replacement owner.
 await act(async()=>editor.cancel())
 await act(async()=>pointer('pointerup',180,160))
 expect(editor.state.doc.nodes[rectangle.id].transform).toEqual(before.nodes[rectangle.id].transform)
 await act(async()=>pointer('pointerdown',150,140,{},host(),8))
 await act(async()=>pointer('pointerup',190,170,{},host(),8))
 expect(editor.state.doc.nodes[rectangle.id].transform.slice(4)).toEqual([140,130])
 expect(editor.interactionActive).toBe(false);expect(editor.canUndo).toBe(true)
})

test('GPU-ineligible translation reuses retained SVG content and selection without changing the layer tree',async()=>{
 const rectangle=node('rectangle',100,100,100,80)
 const before=await render([rectangle]);await act(async()=>editor.select([rectangle.id]))
 const preview=vi.spyOn(editor,'preview')
 recordedOverlay.control={apply:vi.fn(()=>null),end:vi.fn(),isActive:()=>false,covers:()=>false}
 await act(async()=>editor.set({snap:false}))
 await act(async()=>pointer('pointerdown',150,150))
 await act(async()=>{pointer('pointermove',180,170);const queued=[...frames.values()];frames.clear();queued.forEach(fn=>fn(performance.now()))})
 expect(mount.querySelector('[data-testid="canvas-edit-preview"]')).not.toBeNull()
 expect(editor.state.doc).toBe(before)
 expect(preview).not.toHaveBeenCalled()
 const definition=mount.querySelector(`[data-edit-node="${rectangle.id}"]`)!
 expect(definition.getAttribute('transform')).toBe('matrix(1 0 0 1 130 120)')
 expect(mount.querySelector<HTMLElement>('[data-testid="canvas-selection-outline"]')!.style.transform).toBe('translate(30px,20px)')
 await act(async()=>pointer('pointerup',180,170))
 expect(editor.state.doc.nodes[rectangle.id].transform.slice(4)).toEqual([130,120])
 expect(editor.state.doc.pages[0].children).toEqual(before.pages[0].children)
})


test('dragging inside an already selected child outline never promotes an ancestor hit to the moved target',async()=>{
 const frame=node('frame',0,0,400,300),child=node('ellipse',80,80,100,100),sibling=node('rectangle',240,80,40,40)
 frame.children=[child.id,sibling.id]
 const before=await render([frame,child,sibling],[frame.id]);await act(async()=>editor.select([child.id]))
 // The point is inside the selected outline but outside the ellipse's paint.
 expect(editor.selectionHit({x:85,y:95})).toBe(frame.id)
 await act(async()=>pointer('pointerdown',85,95));await act(async()=>pointer('pointermove',120,125));await act(async()=>pointer('pointerup',125,135))
 expect(editor.state.selection).toEqual([child.id])
 expect(editor.state.doc.nodes[frame.id]).toEqual(before.nodes[frame.id])
 expect(editor.state.doc.nodes[sibling.id]).toEqual(before.nodes[sibling.id])
 expect(editor.state.doc.nodes[child.id].transform.slice(4)).toEqual([120,120])
 await act(async()=>editor.undo());expect(editor.state.doc).toEqual(before)
})

test('retained child movement yields to a live tree change when crossing frames before release',async()=>{
 const a=node('frame',0,0,240,240),b=node('frame',320,0,240,240),child=node('rectangle',40,40,60,60)
 a.children=[child.id]
 const before=await render([a,b,child],[a.id,b.id]);await act(async()=>editor.select([child.id]));const version=editor.state.version
 const apply=vi.fn(()=>({x:20,y:10,matrix:[1,0,0,1,20,10] as import('./model').Matrix})),end=vi.fn()
 recordedOverlay.control={apply,end,isActive:()=>true,covers:()=>true,feedbackPending:()=>false}
 await act(async()=>editor.set({snap:false}))
 await act(async()=>pointer('pointerdown',70,70))
 await act(async()=>{pointer('pointermove',90,80);const queued=[...frames.values()];frames.clear();queued.forEach(fn=>fn(performance.now()))})
 expect(apply).toHaveBeenCalled();expect(editor.state.doc).toBe(before)
 apply.mockClear()
 await act(async()=>{pointer('pointermove',390,90);const queued=[...frames.values()];frames.clear();queued.forEach(fn=>fn(performance.now()))})
 expect(apply).not.toHaveBeenCalled()
 expect(editor.state.doc.nodes[a.id].children).toEqual([])
 expect(editor.state.doc.nodes[b.id].children).toEqual([child.id])
 expect(worldMatrix(editor.state.doc,child.id).slice(4)).toEqual([360,60])
 expect(editor.interactionActive).toBe(true);expect(editor.state.version).toBe(version)
 await act(async()=>pointer('pointermove',410,110));await act(async()=>pointer('pointerup',410,110))
 expect(worldMatrix(editor.state.doc,child.id).slice(4)).toEqual([380,80])
 await act(async()=>editor.undo());expect(editor.state.doc).toEqual(before);expect(editor.canUndo).toBe(false)
})

test('a rectangle corner drag sets every radius, and alt keeps the other corners', async () => {
  const rect = node('rectangle', 100, 100, 80, 60)
  await render([rect])
  await act(async () => editor.select([rect.id]))
  const handle = () => mount.querySelector<SVGCircleElement>('[data-testid="corner-radius-0"]')!
  expect(mount.querySelector('[data-testid="corner-radius-1"]')).toBeNull()
  const first = handle()
  const x = Number(first.getAttribute('cx')), y = Number(first.getAttribute('cy'))
  await act(async () => pointer('pointerdown', x, y, {}, first))
  await act(async () => pointer('pointermove', x + 20, y, {}, first))
  await act(async () => pointer('pointerup', x + 20, y, {}, first))
  expect(editor.state.doc.nodes[rect.id].radii).toEqual([20, 20, 20, 20])
  const next = handle()
  const nx = Number(next.getAttribute('cx')), ny = Number(next.getAttribute('cy'))
  await act(async () => pointer('pointerdown', nx, ny, { altKey: true }, next))
  await act(async () => pointer('pointermove', nx + 10, ny, { altKey: true }, next))
  await act(async () => pointer('pointerup', nx + 10, ny, { altKey: true }, next))
  expect(editor.state.doc.nodes[rect.id].radii).toEqual([30, 20, 20, 20])
  expect(mount.querySelector('[data-testid="corner-radius-2"]')).not.toBeNull()
})

test('layout containers stay transparent until their selection feedback is requested', async () => {
  const frame = node('frame', 0, 0, 400, 300)
  const child = node('frame', 40, 40, 80, 60)
  child.name = 'Inner'
  child.fills = [{ ...child.fills[0], opacity: 0 }]
  frame.children = [child.id]
  const section = node('section', 420, 0, 160, 80)
  interfacePreference.set({ uiMode: 'figma' })
  await render([frame, child, section], [frame.id, section.id])
  expect(mount.querySelector(`[data-frame-title="${child.id}"]`)).toBeNull()
  expect(mount.querySelector(`[data-testid="frame-hairline"][data-node-id="${child.id}"]`)).toBeNull()
  expect(mount.querySelector(`[data-section-chip="${section.id}"]`)?.getAttribute('fill')).toBe('#e7e8ef')
  const childTitle = () => mount.querySelector(`[data-frame-title="${child.id}"]`)
  await act(async () => editor.select([frame.id]))
  expect(childTitle()).toBeNull()
  await act(async () => editor.select([child.id]))
  expect(childTitle()?.textContent).toBe('Inner')
  await act(async () => {
    interfacePreference.set({ uiMode: 'sketch' })
    editor.select([frame.id])
  })
  expect(childTitle()?.textContent).toBe('Inner')
  await act(async () => editor.select([section.id]))
  expect(mount.querySelector(`[data-frame-title="${section.id}"]`)?.getAttribute('fill')).toBe('#4597f7')
})
