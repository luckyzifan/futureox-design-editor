// Actual mounted Canvas/event propagation + Editor/WASM. Only the render-device
// boundary is replaced; no native browser, GPU, or pixel-quality claim.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { blank, node, uid, stroke, type DesignNode } from './model'
import { shortcutPreference } from './shortcut-preference'
import { scene, worldMatrix, apply } from './geometry'
import { dispatchEditorCommand } from './editor-commands'
import { editableNetwork } from './editable-network'

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



async function activate(command: Parameters<typeof dispatchEditorCommand>[1]) {
  host().focus(); await act(async () => { await dispatchEditorCommand(editor, command) })
}
async function clickPoint(x: number, y: number) {
  await act(async () => pointer('pointerdown', x, y))
  await act(async () => pointer('pointerup', x, y))
}
async function history(before: typeof editor.state.doc) {
  const after = editor.state.doc; expect(after).not.toEqual(before)
  await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false)
  await act(async () => editor.redo()); expect(editor.state.doc).toEqual(after)
}

function diagonal() { const n = node('line', 100, 100, 100, 100); n.fills = []; n.strokes = [stroke()]; return n }
async function cancelDrag(x: number, y: number, endX: number, endY: number) {
  await act(async () => pointer('pointerdown', x, y)); await act(async () => pointer('pointermove', endX, endY)); await act(async () => pointer('pointercancel', endX, endY))
}
test('set-tool-bend: real edge hit changes cubic shape while preserving endpoints, cancel and history', async () => {
  const n = diagonal(); await render([n]); const before = editor.state.doc
  await activate('set-tool-bend'); await cancelDrag(150, 150, 170, 130); unchanged(before)
  await act(async () => pointer('pointerdown', 150, 150)); await act(async () => pointer('pointerup', 170, 130))
  const result = editor.state.doc.nodes[n.id], net = result.network!
  expect(net).toBeDefined(); expect(net.edges).toHaveLength(1); expect(net.edges[0].c1).toBeDefined(); expect(net.edges[0].c2).toBeDefined()
  const points = net.vertices.map(v => apply(worldMatrix(editor.state.doc, n.id), v))
  expect(points).toEqual([{ x: 100, y: 100 }, { x: 200, y: 200 }])
  const controls = [net.edges[0].c1!, net.edges[0].c2!].map(p => apply(worldMatrix(editor.state.doc, n.id), p))
  expect(controls.some(p => Math.abs(p.x - p.y) > 1)).toBe(true)
  await history(before)
})
test('set-tool-cut: actual midpoint click splits a path into independent endpoints without moving it', async () => {
  const n = diagonal(); await render([n]); const before = editor.state.doc
  await activate('set-tool-cut'); await clickPoint(150, 150)
  const result = editor.state.doc.nodes[n.id], net = result.network!
  expect(net.vertices).toHaveLength(4); expect(net.edges).toHaveLength(2)
  const points = net.vertices.map(v => apply(worldMatrix(editor.state.doc, n.id), v))
  // Rust vector_tools::nearest uses 64 samples then 32 ternary refinements.
  // For this 100-unit diagonal the half-interval bound is 3.622e-6 per axis;
  // recorded actual world split is 150.0000017671581. This 5e-6 tolerance
  // covers solver precision, not topology, endpoint movement, or history loss.
  const split = net.vertices.filter((_, i) => Math.abs(points[i].x - 150) < 5e-6 && Math.abs(points[i].y - 150) < 5e-6)
  expect(split).toHaveLength(2)
  expect(split[0].id).not.toBe(split[1].id)
  expect({ x: split[0].x, y: split[0].y }).toEqual({ x: split[1].x, y: split[1].y })
  for (const point of points) { expect(point.x).toBe(point.y); expect(point.x).toBeGreaterThanOrEqual(100); expect(point.x).toBeLessThanOrEqual(200) }
  const start = net.vertices.find((_, i) => points[i].x === 100 && points[i].y === 100)!
  const end = net.vertices.find((_, i) => points[i].x === 200 && points[i].y === 200)!
  expect(start).toBeDefined(); expect(end).toBeDefined()
  const first = net.edges.find(edge => edge.from === start.id)!, last = net.edges.find(edge => edge.to === end.id)!
  expect(first).toBeDefined(); expect(last).toBeDefined(); expect(first.id).not.toBe(last.id)
  expect(split.map(v => v.id)).toContain(first.to); expect(split.map(v => v.id)).toContain(last.from)
  expect(first.to).not.toBe(last.from)
  expect(new Set(net.edges.flatMap(edge => [edge.from, edge.to])).size).toBe(4)
  for (const edge of net.edges) { expect(edge.c1 ?? null).toBeNull(); expect(edge.c2 ?? null).toBeNull() }
  expect(points).toContainEqual({ x: 100, y: 100 }); expect(points).toContainEqual({ x: 200, y: 200 })
  expect(new Set(net.vertices.map(v => v.id)).size).toBe(4); expect(editor.state.selection).toEqual([n.id])
  await history(before)
})
test('set-tool-measure: actual Canvas final release reports distance and deltas without authored history', async () => {
  await render([]); const before = editor.state.doc
  await activate('set-tool-measure'); await cancelDrag(100, 100, 120, 120); unchanged(before)
  await act(async () => pointer('pointerdown', 100, 100)); await act(async () => pointer('pointerup', 160, 180))
  const overlay = mount.querySelector('[data-testid="utility-gesture"]')!
  expect(overlay).not.toBeNull(); expect(overlay.querySelector('text')!.textContent).toBe('100.00 · ΔX 60.00 · ΔY 80.00')
  expect(overlay.querySelector('polyline')!.getAttribute('points')).toBe('100,100 160,180'); unchanged(before)
})
test('set-tool-offset-path: selected vector receives exact release offset, cancel and one undo/redo', async () => {
  const n = node('rectangle', 100, 100, 100, 80); await render([n]); await act(async () => editor.select([n.id])); const before = editor.state.doc
  await activate('set-tool-offset-path'); await cancelDrag(150, 140, 170, 140); unchanged(before)
  await act(async () => pointer('pointerdown', 150, 140)); await act(async () => pointer('pointerup', 175, 140))
  const result = editor.state.doc.nodes[n.id]; expect(result.pathOffset).toBe(25)
  expect(result.transform).toEqual(before.nodes[n.id].transform); expect(result.width).toBe(100); expect(result.height).toBe(80)
  await history(before)
})
test('set-tool-text-path: actual selected path creates linked text geometry and preserves source with history', async () => {
  const n = diagonal(); await render([n]); await act(async () => editor.select([n.id])); const before = editor.state.doc
  const network = editableNetwork(before.nodes[n.id])
  await activate('set-tool-text-path'); await clickPoint(150, 150)
  expect(editor.state.doc.pages[0].children).toHaveLength(2)
  const text = editor.state.doc.nodes[editor.state.selection[0]]
  expect(text.kind).toBe('text'); expect(text.text).toBe('沿路径输入文字')
  expect(text.textPath).toEqual({ network, offset: 0, normal: 0, reverse: false })
  expect(text.transform).toEqual(worldMatrix(before, n.id)); expect(editor.state.doc.nodes[n.id]).toEqual(before.nodes[n.id])
  await history(before)
})
test('set-tool-type: FigJam alias actually draws a text node, cancels then commits exact geometry/history', async () => {
  await render([]); const before = editor.state.doc
  await activate('set-tool-type'); expect(editor.state.tool).toBe('text'); await cancelDrag(100, 100, 130, 120); unchanged(before)
  await act(async () => pointer('pointerdown', 100, 100)); await act(async () => pointer('pointerup', 180, 160))
  const ids = editor.state.doc.pages[0].children; expect(ids).toHaveLength(1)
  const n = editor.state.doc.nodes[ids[0]]; expect(n.kind).toBe('text'); expect(n.transform.slice(4)).toEqual([100, 100]); expect(n.width).toBeCloseTo(80, 8); expect(n.height).toBeCloseTo(60, 8)
  await history(before)
})
async function lasso() {
  await act(async () => pointer('pointerdown', 80, 80))
  for (const [x,y] of [[170,80],[170,170],[80,170]]) await act(async () => pointer('pointermove', x, y))
  await act(async () => pointer('pointerup', 80, 80))
}
test('set-tool-vector-lasso: actual polygon selects eligible root centers without document/history', async () => {
  const a = node('rectangle', 100, 100, 40, 40), outside = node('rectangle', 300, 100, 40, 40), locked = node('rectangle', 110, 110, 20, 20); locked.locked = true
  await render([a, outside, locked]); const before = editor.state.doc
  await activate('set-tool-vector-lasso'); await cancelDrag(80, 80, 170, 80); unchanged(before); expect(editor.state.selection).toEqual([])
  await lasso(); expect(editor.state.selection).toEqual([a.id]); unchanged(before)
})
test('set-tool-vector-lasso: selected path uses vertex selection instead of root selection and leaves history untouched', async () => {
  const n = diagonal(); await render([n]); await act(async () => editor.select([n.id])); const before = editor.state.doc, network = editableNetwork(before.nodes[n.id])
  await activate('set-tool-vector-lasso'); await lasso()
  expect(editor.state.tool).toBe('vector'); expect(editor.state.selection).toEqual([n.id]); expect(editor.state.editingVertices).toEqual([network.vertices[0].id]); unchanged(before)
})
