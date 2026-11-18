// Actual mounted Canvas/event propagation + Editor/WASM. Only the render-device
// boundary is replaced; no native browser, GPU, or pixel-quality claim.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { blank, node, uid, paint, defaultLayout, defaultSizing, type DesignNode } from './model'
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
  if (nodes.some(node => node.graphic)) doc.schemaVersion = 23
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
test('Mac Sketch quick crop handles held and single arrows while retaining the child box', async () => {
  shortcutPreference.set('sketch-like')
  interfacePreference.set({ uiMode: 'sketch' })
  const frame = node('frame', 100, 100, 120, 80)
  const child = node('rectangle', 16, 12, 40, 24)
  child.constraints = { horizontal: 'scale', vertical: 'scale', referenceWidth: 120, referenceHeight: 80 }
  frame.children = [child.id]
  const before = await render([frame, child], [frame.id])
  await act(async () => editor.select([frame.id]))
  const chord = { metaKey: true, altKey: true }
  await act(async () => {
    key('ArrowRight', chord)
    key('ArrowRight', { ...chord, repeat: true })
    key('ArrowRight', { ...chord, repeat: true })
  })
  expect(editor.state.doc.nodes[frame.id].width).toBe(123)
  expect(editor.interactionActive).toBe(true)
  expect(editor.state.frameCrop).toBeNull()
  await act(async () => key('ArrowRight', chord, 'keyup'))
  expect(editor.state.doc.nodes[child.id]).toMatchObject({ width: 40, height: 24 })
  delta(before, child.id, 0, 0)
  await oneHistory(before)

  for (const [arrow, width, height] of [
    ['ArrowLeft', 122, 80], ['ArrowDown', 122, 81], ['ArrowUp', 122, 80],
  ] as const) {
    await act(async () => { key(arrow, chord); key(arrow, chord, 'keyup') })
    expect(editor.state.doc.nodes[frame.id]).toMatchObject({ width, height })
    expect(editor.state.doc.nodes[child.id]).toMatchObject({ width: 40, height: 24 })
    delta(before, child.id, 0, 0)
  }
  const after = editor.state.doc
  await act(async () => interfacePreference.set({ uiMode: 'figma' }))
  await act(async () => { key('ArrowRight', chord); key('ArrowRight', chord, 'keyup') })
  expect(editor.state.doc).toBe(after)
})

test('Mac Sketch Shift+Command+Option arrows resize only the container by the current large nudge', async () => {
  shortcutPreference.set('sketch-like')
  interfacePreference.set({ uiMode: 'sketch' })
  const frame = node('frame', 100, 80, 120, 80)
  const scaled = node('rectangle', 16, 12, 40, 24)
  const pinned = node('rectangle', 70, 40, 20, 16)
  scaled.constraints = { horizontal: 'scale', vertical: 'scale', referenceWidth: 120, referenceHeight: 80 }
  pinned.constraints = { horizontal: 'end', vertical: 'start', referenceWidth: 120, referenceHeight: 80 }
  frame.children = [scaled.id, pinned.id]
  const before = await render([frame, scaled, pinned], [frame.id])
  await act(async () => editor.select([frame.id]))
  const chord = { metaKey: true, altKey: true, shiftKey: true }
  const childStable = () => {
    for (const id of [scaled.id, pinned.id]) {
      expect(editor.state.doc.nodes[id].width).toBe(before.nodes[id].width)
      expect(editor.state.doc.nodes[id].height).toBe(before.nodes[id].height)
      expect(editor.state.doc.nodes[id].transform).toEqual(before.nodes[id].transform)
      delta(before, id, 0, 0)
    }
  }
  await act(async () => {
    key('ArrowRight', chord)
    key('ArrowRight', { ...chord, repeat: true })
    key('ArrowRight', { ...chord, repeat: true })
  })
  expect(editor.state.doc.nodes[frame.id].width).toBeCloseTo(150, 8)
  expect(editor.state.doc.nodes[frame.id].height).toBe(80)
  expect(editor.interactionActive).toBe(true)
  expect(editor.canUndo).toBe(false)
  expect(editor.state.frameCrop).toBeNull()
  childStable()
  await act(async () => key('ArrowRight', chord, 'keyup'))
  expect(editor.interactionActive).toBe(false)
  childStable()
  expect(editor.state.doc.nodes[scaled.id].constraints).toMatchObject({ referenceWidth: editor.state.doc.nodes[frame.id].width, referenceHeight: 80 })
  expect(editor.state.doc.nodes[pinned.id].constraints).toMatchObject({ horizontal: 'end', vertical: 'start', referenceWidth: editor.state.doc.nodes[frame.id].width, referenceHeight: 80 })
  await oneHistory(before)
  await act(async () => editor.undo())
  expect(editor.state.doc).toEqual(before)

  for (const [arrow, width, height] of [
    ['ArrowLeft', 110, 80], ['ArrowDown', 110, 90], ['ArrowUp', 110, 80], ['ArrowRight', 120, 80],
  ] as const) {
    await act(async () => { key(arrow, chord); key(arrow, chord, 'keyup') })
    expect(editor.state.doc.nodes[frame.id].width).toBeCloseTo(width, 8)
    expect(editor.state.doc.nodes[frame.id].height).toBeCloseTo(height, 8)
    childStable()
  }
  await act(async () => editor.undo())
  await act(async () => editor.undo())
  await act(async () => editor.undo())
  await act(async () => editor.undo())
  expect(editor.state.doc).toEqual(before)

  nudgePreference.set({ small: 1, big: 25 })
  await act(async () => { key('ArrowDown', chord); key('ArrowDown', chord, 'keyup') })
  expect(editor.state.doc.nodes[frame.id]).toMatchObject({ width: 120, height: 105 })
  childStable()
  await oneHistory(before)
  await act(async () => editor.undo())
  expect(editor.state.doc).toEqual(before)
  nudgePreference.reset()

  await act(async () => {
    key('ArrowRight', chord)
    key('ArrowRight', { ...chord, repeat: true })
  })
  expect(editor.state.doc.nodes[frame.id].width).toBeCloseTo(140, 8)
  await act(async () => key('Escape'))
  await act(async () => key('ArrowRight', chord, 'keyup'))
  expect(editor.state.doc).toEqual(before)
  expect(editor.canUndo).toBe(false)
  expect(editor.interactionActive).toBe(false)

  await act(async () => editor.update([frame.id], { transform: [0, 1, -1, 0, 100, 80] }))
  const rotated = editor.state.doc
  await act(async () => { key('ArrowRight', chord); key('ArrowRight', chord, 'keyup') })
  expect(editor.state.doc.nodes[frame.id].width).toBeCloseTo(130, 8)
  expect(editor.state.doc.nodes[frame.id].transform).toEqual(rotated.nodes[frame.id].transform)
  for (const id of [scaled.id, pinned.id]) delta(rotated, id, 0, 0)
  await act(async () => editor.undo())
  await act(async () => editor.undo())
  expect(editor.state.doc).toEqual(before)

  await act(async () => { key('ArrowRight', { metaKey: true, shiftKey: true }); key('ArrowRight', { metaKey: true, shiftKey: true }, 'keyup') })
  expect(editor.state.doc.nodes[frame.id].width).toBeCloseTo(130, 8)
  expect(editor.state.doc.nodes[scaled.id].width).toBeCloseTo(40 * 130 / 120, 6)
  expect(editor.state.doc.nodes[pinned.id].transform[4]).toBeCloseTo(80, 6)
  expect(editor.state.doc.nodes[pinned.id].width).toBe(20)
})

test('Mac Sketch large container nudges preserve the content of a Graphic under a rotated scaled frame', async () => {
  shortcutPreference.set('sketch-like')
  interfacePreference.set({ uiMode: 'sketch' })
  nudgePreference.set({ small: 1, big: 12.5 })
  const outer = node('frame', 0, 0, 600, 500)
  outer.transform = [0, 1.25, -1.25, 0, 660, 80]
  const graphic = node('frame', 90, 80, 120, 80)
  graphic.graphic = true
  const child = node('rectangle', 14, 15, 40, 24)
  graphic.children = [child.id]
  outer.children = [graphic.id]
  const before = await render([outer, graphic, child], [outer.id])
  await act(async () => editor.select([graphic.id]))
  const chord = { metaKey: true, shiftKey: true, altKey: true }
  await act(async () => key('ArrowRight', chord))
  expect(editor.state.doc.nodes[graphic.id].width).toBeCloseTo(130, 8)
  await act(async () => key('ArrowRight', { ...chord, repeat: true }))
  expect(editor.state.doc.nodes[graphic.id].width).toBeCloseTo(140, 8)
  expect(editor.canUndo).toBe(false)
  await act(async () => key('ArrowRight', chord, 'keyup'))
  expect(editor.state.doc.nodes[child.id]).toMatchObject({ width: 40, height: 24 })
  delta(before, child.id, 0, 0)
  await oneHistory(before)
})

test('Mac Sketch Shift+Command+Option does not fall back to a content resize when the frame cannot crop', async () => {
  shortcutPreference.set('sketch-like')
  interfacePreference.set({ uiMode: 'sketch' })
  const frame = node('frame', 100, 80, 120, 80)
  const child = node('rectangle', 16, 12, 40, 24)
  child.constraints = { horizontal: 'scale', vertical: 'scale', referenceWidth: 120, referenceHeight: 80 }
  frame.children = [child.id]
  const flow = node('frame', 400, 40, 180, 100)
  flow.layout = defaultLayout()
  const flowChild = node('rectangle', 10, 10, 30, 20)
  flow.children = [flowChild.id]
  const outer = node('frame', 40, 240, 400, 300)
  outer.layout = defaultLayout()
  const nested = node('frame', 20, 20, 120, 80)
  const leaf = node('rectangle', 8, 8, 30, 20)
  leaf.constraints = { horizontal: 'end', vertical: 'start', referenceWidth: 120, referenceHeight: 80 }
  nested.children = [leaf.id]
  outer.children = [nested.id]
  const loose = node('rectangle', 640, 40, 50, 40)
  await render([frame, child, flow, flowChild, outer, nested, leaf, loose], [frame.id, flow.id, outer.id, loose.id])
  const chord = { metaKey: true, altKey: true, shiftKey: true }
  await act(async () => editor.select([child.id]))
  const childBefore = editor.state.doc
  await act(async () => { key('ArrowRight', chord); key('ArrowRight', { ...chord, repeat: true }); key('ArrowRight', chord, 'keyup') })
  expect(editor.state.doc).toBe(childBefore)
  await act(async () => { key('ArrowRight', { metaKey: true, shiftKey: true }); key('ArrowRight', { metaKey: true, shiftKey: true }, 'keyup') })
  expect(editor.state.doc.nodes[child.id].width).toBeCloseTo(50, 8)
  expect(editor.state.doc.nodes[frame.id].width).toBe(120)
  await act(async () => editor.undo())

  await act(async () => editor.select([frame.id, loose.id]))
  const multi = editor.state.doc
  await act(async () => { key('ArrowRight', chord); key('ArrowRight', chord, 'keyup') })
  expect(editor.state.doc).toBe(multi)

  await act(async () => { editor.select([frame.id]); editor.update([frame.id], { locked: true }) })
  const locked = editor.state.doc
  await act(async () => { key('ArrowRight', chord); key('ArrowRight', chord, 'keyup') })
  expect(editor.state.doc).toBe(locked)
  await act(async () => editor.updateProperties([frame.id], { locked: false }))

  await act(async () => editor.select([flow.id]))
  const flowing = editor.state.doc
  await act(async () => { key('ArrowDown', chord); key('ArrowDown', chord, 'keyup') })
  expect(editor.state.doc).toBe(flowing)

  await act(async () => editor.select([nested.id]))
  const nestedBefore = editor.state.doc
  await act(async () => { key('ArrowRight', chord); key('ArrowRight', chord, 'keyup') })
  expect(editor.state.doc).toBe(nestedBefore)
  await act(async () => editor.update([nested.id], { sizing: { ...defaultSizing(), absolute: true } }))
  const absoluteBefore = editor.state.doc
  const leafWorld = worldMatrix(absoluteBefore, leaf.id)
  await act(async () => { key('ArrowRight', chord); key('ArrowRight', chord, 'keyup') })
  expect(editor.state.doc.nodes[nested.id].width).toBeCloseTo(130, 8)
  expect(editor.state.doc.nodes[leaf.id].transform).toEqual(absoluteBefore.nodes[leaf.id].transform)
  expect(worldMatrix(editor.state.doc, leaf.id)).toEqual(leafWorld)
  await act(async () => editor.undo())

  await act(async () => { interfacePreference.set({ uiMode: 'figma' }); editor.select([frame.id]) })
  const figma = editor.state.doc
  await act(async () => { key('ArrowRight', chord); key('ArrowRight', chord, 'keyup') })
  expect(editor.state.doc).toBe(figma)

  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' })
  await act(async () => interfacePreference.set({ uiMode: 'sketch' }))
  const windows = editor.state.doc
  await act(async () => { key('ArrowRight', { ctrlKey: true, altKey: true, shiftKey: true }); key('ArrowRight', { ctrlKey: true, altKey: true, shiftKey: true }, 'keyup') })
  expect(editor.state.doc).toBe(windows)
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux' })
  await act(async () => { key('ArrowRight', { ctrlKey: true, altKey: true, shiftKey: true }); key('ArrowRight', { ctrlKey: true, altKey: true, shiftKey: true }, 'keyup') })
  expect(editor.state.doc).toBe(windows)

  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  await act(async () => { editor.select([frame.id]); key('ArrowRight', chord); key('ArrowRight', chord, 'keyup') })
  expect(editor.state.doc.nodes[frame.id].width).toBeCloseTo(130, 8)
  expect(editor.state.doc.nodes[child.id].width).toBe(40)
  delta(windows, child.id, 0, 0)
})

test('dimension chord registry has no duplicate mac chord and does not expand unobserved non-mac Figma bindings',()=>{
 for(const profile of ['figma-like','sketch-like'] as const)for(const desktop of [false,true]){
  const bindings=shortcutBindings({profile,platform:'mac',desktop})
  for(const item of observedKeys){const combo=`Mod+${item.large?'Shift+':''}${item.key}`,hits=bindings.filter(binding=>binding.combo===combo);expect(hits).toHaveLength(1);expect(hits[0].command).toMatch(/^resize-/);expect(hits[0].repeat).toBe(true)}
  const group=resolveShortcut({key:'g',code:'KeyG',metaKey:true,ctrlKey:false,altKey:false,shiftKey:false,repeat:false,isComposing:false,defaultPrevented:false},{profile,platform:'mac',desktop});expect(group?.command).toBe('group')
 }
 for(const platform of ['windows','linux'] as const){
  expect(shortcutBindings({profile:'figma-like',platform}).filter(b=>b.command.startsWith('resize-'))).toEqual([])
  expect(shortcutBindings({profile:'sketch-like',platform}).filter(b=>b.command.startsWith('resize-'))).toHaveLength(8)
  for(const key of ['ArrowRight','ArrowLeft','ArrowDown','ArrowUp']){
   const event={key,code:key,metaKey:false,ctrlKey:true,altKey:true,shiftKey:true,repeat:false,isComposing:false,defaultPrevented:false}
   expect(resolveShortcut(event,{profile:'sketch-like',platform})).toBeNull()
   expect(resolveShortcut(event,{profile:'figma-like',platform})).toBeNull()
  }
 }
 const macSketch=shortcutBindings({profile:'sketch-like',platform:'mac',desktop:true})
 expect(macSketch.filter(b=>b.command.startsWith('resize-'))).toHaveLength(16)
 for(const [key,command] of [['ArrowRight','resize-width-increase-large'],['ArrowLeft','resize-width-decrease-large'],['ArrowDown','resize-height-increase-large'],['ArrowUp','resize-height-decrease-large']] as const){
  const combo=`Mod+Shift+Alt+${key}`
  const hits=macSketch.filter(b=>b.combo===combo)
  expect(hits).toEqual([{command,combo,repeat:true,preserveFrameContents:true}])
  const resolved=resolveShortcut({key,code:key,metaKey:true,ctrlKey:false,altKey:true,shiftKey:true,repeat:true,isComposing:false,defaultPrevented:false},{profile:'sketch-like',platform:'mac',desktop:false})
  expect(resolved).toEqual({command,combo,repeat:true,preserveFrameContents:true})
  expect(resolveShortcut({key,code:key,metaKey:true,ctrlKey:false,altKey:true,shiftKey:true,repeat:false,isComposing:false,defaultPrevented:false},{profile:'figma-like',platform:'mac'})).toBeNull()
  const contentResize=resolveShortcut({key,code:key,metaKey:true,ctrlKey:false,altKey:false,shiftKey:true,repeat:false,isComposing:false,defaultPrevented:false},{profile:'sketch-like',platform:'mac'})
  expect(contentResize?.command).toBe(command)
  expect(contentResize?.combo).toBe(`Mod+Shift+${key}`)
  expect(contentResize?.preserveFrameContents).toBeUndefined()
 }
})
