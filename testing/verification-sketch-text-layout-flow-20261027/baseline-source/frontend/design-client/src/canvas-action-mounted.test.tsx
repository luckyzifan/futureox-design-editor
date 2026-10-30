import { canvasActions, CanvasAction, ActionOutcome, ActionReason } from './canvas-action-diagnostics'
import { bindNavigationInput } from './kernel/navigation-input'
// Actual mounted Canvas/event propagation + Editor/WASM. The render-device
// boundary alone is replaced. Deterministic 60 Hz delivery does not claim
// browser/GPU FPS, compositor latency, or pixel quality.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { PageList } from './PageList'
import { Layers } from './Layers'
import { Editor } from './engine'
import { blank, node, uid, type DesignNode } from './model'
import { shortcutPreference } from './shortcut-preference'
import { apply, inverse, worldMatrix } from './geometry'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { paint, stroke } from './model'
import { PencilInput } from './freehand'
import * as handles from './selection-handles'

const presentationControl = vi.hoisted(() => ({ hold: false, lastDocument: undefined as object | undefined }))
vi.mock('./kernel/Surface', async () => {
  const { useLayoutEffect } = await import('react')
  return { KernelSurface(props: import('./kernel/Surface').SurfaceProps) {
    useLayoutEffect(() => {
      if (presentationControl.hold) return
      presentationControl.lastDocument = props.document
      props.onPresentation?.({ ...props, epoch: props.presentationEpoch!, pixelRatio: 1, managed: false })
    }, [props.document, props.pageId, props.view, props.width, props.height, props.presentationEpoch, props.onPresentation])
    return <div data-testid="surface-boundary" />
  } }
})
let dom: any, root: Root, mount: HTMLDivElement, editor: Editor, errors: unknown[][]
let frames: Map<number, FrameRequestCallback>, frameId: number
const baseline = process.env.CANVAS_EVENT_BASELINE === '1'
beforeEach(() => {
  presentationControl.hold = false; presentationControl.lastDocument = undefined
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
  await act(async () => { root.render(<><Canvas editor={editor} />{withPages && <PageList editor={editor} onRename={() => {}} />}</>); for (let i = 0; i < 6; i++) await Promise.resolve() })
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
function vector() {
  const n = node('vector', 100, 100, 180, 120); n.id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  n.network = { fillRule: 'nonzero', vertices: [
    { id: 'a', x: 0, y: 0 }, { id: 'b', x: 180, y: 0 }, { id: 'c', x: 180, y: 120 }, { id: 'd', x: 0, y: 120 },
  ], edges: [
    { id: 'ab', from: 'a', to: 'b', c1: { x: 60, y: 30 }, c2: { x: 120, y: 30 } },
    { id: 'bc', from: 'b', to: 'c' }, { id: 'cd', from: 'c', to: 'd' }, { id: 'da', from: 'd', to: 'a' },
  ] }
  n.strokes = [{ ...stroke('#123456', 12), widthProfile: [
    { position: 0, left: 1, right: 1 }, { position: .5, left: 1, right: 1 }, { position: 1, left: 1, right: 1 },
  ] }]
  n.strokes[0].id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  n.strokes[0].paint.id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  return n
}
type EditKind = 'vertex' | 'handle' | 'width'
async function begin(kind: EditKind, withPages = false) {
  const n = vector(), before = await render([n], [n.id], [], withPages)
  await act(async () => { editor.select([n.id]); editor.set({ tool: kind === 'width' ? 'width' : 'vector' }) })
  const target = kind === 'vertex' ? mount.querySelector('[data-testid="vector-anchor"]')! :
    kind === 'width' ? mount.querySelector('[data-testid^="width-"]')! :
    [...mount.querySelectorAll('circle')].find(e => e.getAttribute('r') === '3.5')!
  expect(target).toBeDefined()
  const start = kind === 'vertex' ? { x: 100, y: 100 } :
    { x: 100 + Number(target.getAttribute('cx')), y: 100 + Number(target.getAttribute('cy')) }
  // Width handles already have world coordinates, unlike local path controls.
  if (kind === 'width') { start.x -= 100; start.y -= 100 }
  await act(async () => pointer('pointerdown', start.x, start.y, {}, target))
  expect(editor.interactionActive).toBe(true)
  return { n, before, start }
}
async function verifyHistory(before: typeof editor.state.doc) {
  const after = editor.state.doc
  await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before)
  await act(async () => editor.redo()); expect(editor.state.doc).toEqual(after)
  await flushFrames(); expect(editor.state.doc).toBe(after)
}
function digest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function report(data: Record<string, unknown>) {
  const row = { runtime: 'mounted React/jsdom Canvas + real Editor/WASM; renderer boundary stub', baseline, ...data }
  console.info('CANVAS_EVENT_METRIC', JSON.stringify(row))
  if (process.env.CANVAS_EVENT_METRICS) appendFileSync(process.env.CANVAS_EVENT_METRICS, JSON.stringify(row) + '\n')
}


const finished = (code: number) => canvasActions(editor).snapshot().rows.filter(row => row.actionPhase === 2 && row.actionCode === code)
test('fresh canvas select/grab below-threshold move is cancelled, not a failed commit', async () => {
  const n=node('rectangle',100,100,100,100); await render([n])
  const version=editor.state.version
  await act(async()=>pointer('pointerdown',150,150))
  await act(async()=>pointer('pointermove',151,150)); await flushFrames()
  await act(async()=>pointer('pointerup',151,150))
  expect(editor.state.selection).toEqual([n.id]); expect(editor.state.version).toBe(version)
  expect(finished(CanvasAction.selection).at(-1)).toMatchObject({selectionAfter:1,selectionChanged:1})
  expect(finished(CanvasAction.grab).at(-1)).toMatchObject({actionOutcome:ActionOutcome.observed})
  expect(finished(CanvasAction.move).at(-1)).toMatchObject({actionOutcome:ActionOutcome.cancelled,actionReason:ActionReason.belowThreshold,committedChanged:0,thresholdPassed:0})
})
test('fresh canvas committed drag compares resolved and committed geometry without exposing it', async () => {
  const n=node('rectangle',100,100,100,100); n.name='PRIVATE LAYER'; await render([n])
  await act(async()=>pointer('pointerdown',150,150))
  for(let x=151;x<=170;x++)await act(async()=>pointer('pointermove',x,160))
  await flushFrames(); await act(async()=>pointer('pointerup',170,160))
  expect(editor.state.doc.nodes[n.id].transform[4]).toBe(120)
  expect(finished(CanvasAction.move).at(-1)).toMatchObject({actionOutcome:ActionOutcome.committed,thresholdPassed:1,committedChanged:1,proposalResolvedComparison:1,resolvedCommittedComparison:1,geometrySupported:1})
  const encoded=JSON.stringify(canvasActions(editor).snapshot())
  expect(encoded).not.toContain('PRIVATE');expect(encoded).not.toContain(n.id);expect(encoded).not.toContain('transform')
})
test('fresh canvas locked selection reports locked count without falsely reporting a commit', async () => {
  const n=node('rectangle',100,100,100,100); n.locked=true; await render([n])
  await act(async()=>editor.select([n.id])); const version=editor.state.version
  await act(async()=>pointer('pointerdown',150,150));await act(async()=>pointer('pointerup',150,150))
  expect(editor.state.version).toBe(version)
  expect(finished(CanvasAction.grab).at(-1)).toMatchObject({lockedCount:1})
  expect(canvasActions(editor).snapshot().rows.some(row=>row.actionOutcome===ActionOutcome.committed)).toBe(false)
})
test('fresh canvas frame creation records authored commit rather than preview cancellation', async () => {
  await render([]); await act(async()=>editor.set({tool:'frame'}))
  await act(async()=>pointer('pointerdown',100,100)); await act(async()=>pointer('pointermove',200,180)); await flushFrames();await act(async()=>pointer('pointerup',200,180))
  expect(Object.values(editor.state.doc.nodes).some(n=>n.kind==='frame')).toBe(true)
  expect(finished(CanvasAction.create).at(-1)).toMatchObject({actionOutcome:ActionOutcome.committed,committedChanged:1,geometrySupported:0})
})
test('blue box snapped resize logs expected constraint and unchanged without claiming failure', async () => {
  const n=node('rectangle',100,100,100,100);await render([n]);await act(async()=>{editor.select([n.id]);editor.set({snapPixels:true})})
  const edge=mount.querySelector('[data-testid="resize-edge-1"]')!;expect(edge).toBeTruthy()
  await act(async()=>pointer('pointerdown',200,150,{},edge));await act(async()=>pointer('pointermove',200.2,150));await flushFrames();await act(async()=>pointer('pointerup',200.2,150))
  expect(editor.state.doc.nodes[n.id].width).toBe(100)
  expect(finished(CanvasAction.resize).at(-1)).toMatchObject({actionOutcome:ActionOutcome.unchanged,snapChanged:1,proposalChanged:0,proposalResolvedComparison:1,resolvedCommittedComparison:1})
})
test('blue box rotation commits with verified proposal/resolve/commit comparisons', async () => {
  const n=node('rectangle',100,100,100,100);await render([n]);await act(async()=>editor.select([n.id]))
  const handle=mount.querySelector('[data-testid="rotate-corner-1"]')!;expect(handle).toBeTruthy()
  const x=Number(handle.getAttribute('data-anchor-x')),y=Number(handle.getAttribute('data-anchor-y'))
  await act(async()=>pointer('pointerdown',x,y,{},handle));await act(async()=>pointer('pointermove',x+20,y+20));await flushFrames();await act(async()=>pointer('pointerup',x+20,y+20))
  expect(finished(CanvasAction.rotate).at(-1)).toMatchObject({actionOutcome:ActionOutcome.committed,proposalResolvedComparison:1,resolvedCommittedComparison:1,geometrySupported:1})
})

test('blue outline follows authored width and height while old content presentation is deliberately held', async () => {
  const n=node('rectangle',100,100,100,100);await render([n]);await act(async()=>editor.select([n.id]))
  const outline=()=>mount.querySelector('[data-testid="canvas-selection-outline"]')!
  const before=outline().getAttribute('points'), oldPresented=presentationControl.lastDocument
  presentationControl.hold=true
  await act(async()=>editor.update([n.id],{width:160,height:120}))
  expect(editor.state.doc.nodes[n.id]).toMatchObject({width:160,height:120})
  expect(outline().getAttribute('points')).not.toBe(before)
  const points=outline().getAttribute('points')!.split(' ').map(p=>p.split(',').map(Number))
  expect(Math.max(...points.map(p=>p[0]))-Math.min(...points.map(p=>p[0]))).toBe(160)
  expect(Math.max(...points.map(p=>p[1]))-Math.min(...points.map(p=>p[1]))).toBe(120)
  expect(presentationControl.lastDocument).toBe(oldPresented)
  expect(presentationControl.lastDocument).not.toBe(editor.state.doc)
})
