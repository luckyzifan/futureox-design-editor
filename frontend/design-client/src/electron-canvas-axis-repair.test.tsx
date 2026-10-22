// Actual mounted Canvas/event propagation + Editor/WASM. Only the render-device
// boundary is replaced; no native browser, GPU, or pixel-quality claim.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { blank, node, uid, defaultSizing, defaultLayout, type DesignNode } from './model'
import { shortcutPreference } from './shortcut-preference'
import { scene } from './geometry'

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

test.each(['hug', 'fill'] as const)('right edge resize preserves untouched %s height and history', async mode => {
  const n = node('frame', 100, 100, 100, 80), content = node('rectangle', 0, 0, 100, 80); n.layout = { ...defaultLayout(), padding: [0, 0, 0, 0] }; n.children = [content.id]; n.sizing = { ...defaultSizing(), width: 'fixed', height: mode }
  await render([n, content], [n.id]); await act(async () => editor.select([n.id])); const before = editor.state.doc
  const edge = mount.querySelector('[data-testid="resize-edge-1"]')!; expect(edge).not.toBeNull()
  await act(async () => pointer('pointerdown', 200, 140, {}, edge))
  await act(async () => pointer('pointerup', 250, 140))
  expect(editor.state.doc.nodes[n.id].width).toBeCloseTo(150, 8)
  expect(editor.state.doc.nodes[n.id].sizing).toMatchObject({ width: 'fixed', height: mode })
  const after = editor.state.doc; await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false)
  await act(async () => editor.redo()); expect(editor.state.doc).toEqual(after)
})
test('bottom edge fixes only height; cancellation restores both authored modes', async () => {
  const n = node('frame', 100, 100, 100, 80), content = node('rectangle', 0, 0, 100, 80); n.layout = { ...defaultLayout(), padding: [0, 0, 0, 0] }; n.children = [content.id]; n.sizing = { ...defaultSizing(), width: 'hug', height: 'fill' }
  await render([n, content], [n.id]); await act(async () => editor.select([n.id])); const before = editor.state.doc
  const edge = mount.querySelector('[data-testid="resize-edge-2"]')!
  await act(async () => pointer('pointerdown', 150, 180, {}, edge))
  await act(async () => pointer('pointerup', 150, 220))
  expect(editor.state.doc.nodes[n.id].sizing).toMatchObject({ width: 'hug', height: 'fixed' })
  await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before)
  await act(async () => pointer('pointerdown', 150, 180, {}, mount.querySelector('[data-testid="resize-edge-2"]')!))
  await act(async () => pointer('pointermove', 150, 230))
  await act(async () => pointer('pointercancel', 150, 230)); expect(editor.state.doc).toEqual(before)
})
test.each([false, true])('corner/Shift-edge explicitly fixes both axes (edge=%s)', async edge => {
  const n = node('frame', 100, 100, 100, 80), content = node('rectangle', 0, 0, 100, 80); n.layout = { ...defaultLayout(), padding: [0, 0, 0, 0] }; n.children = [content.id]; n.sizing = { ...defaultSizing(), width: 'hug', height: 'fill' }
  await render([n, content], [n.id]); await act(async () => editor.select([n.id]))
  const target = mount.querySelector(edge ? '[data-testid="resize-edge-1"]' : '[data-testid="resize-2"]')!
  await act(async () => pointer('pointerdown', 200, edge ? 140 : 180, { shiftKey: edge }, target))
  await act(async () => pointer('pointerup', 250, edge ? 140 : 220, { shiftKey: edge }))
  expect(editor.state.doc.nodes[n.id].sizing).toMatchObject({ width: 'fixed', height: 'fixed' })
})

test.each([false, true])('proportion lock uses both axes unless Ctrl explicitly disables it (ctrl=%s)', async ctrl => {
  const n = node('frame', 100, 100, 100, 80), content = node('rectangle', 0, 0, 100, 80)
  n.layout = { ...defaultLayout(), padding: [0, 0, 0, 0] }; n.children = [content.id]
  n.sizing = { ...defaultSizing(), width: 'fixed', height: 'hug' }; n.constrainProportions = true
  await render([n, content], [n.id]); await act(async () => editor.select([n.id]))
  await act(async () => pointer('pointerdown', 200, 140, { ctrlKey: ctrl }, mount.querySelector('[data-testid="resize-edge-1"]')!))
  await act(async () => pointer('pointerup', 250, 140, { ctrlKey: ctrl }))
  expect(editor.state.doc.nodes[n.id].sizing?.height).toBe(ctrl ? 'hug' : 'fixed')
  expect(editor.state.doc.nodes[n.id].height).toBeCloseTo(ctrl ? 80 : 120, 8)
})
test('Option symmetric edge still preserves untouched axis; no-motion corner click stays history-free', async () => {
  const n = node('frame', 100, 100, 100, 80), content = node('rectangle', 0, 0, 100, 80)
  n.layout = { ...defaultLayout(), padding: [0, 0, 0, 0] }; n.children = [content.id]; n.sizing = { ...defaultSizing(), width: 'fixed', height: 'hug' }
  await render([n, content], [n.id]); await act(async () => editor.select([n.id])); const before = editor.state.doc
  await act(async () => pointer('pointerdown', 200, 180, {}, mount.querySelector('[data-testid="resize-2"]')!))
  await act(async () => pointer('pointerup', 200, 180)); unchanged(before)
  await act(async () => pointer('pointerdown', 200, 140, { altKey: true }, mount.querySelector('[data-testid="resize-edge-1"]')!))
  await act(async () => pointer('pointerup', 225, 140, { altKey: true }))
  expect(editor.state.doc.nodes[n.id].sizing?.height).toBe('hug')
  expect(editor.state.doc.nodes[n.id].width).toBeCloseTo(150, 8)
  expect(editor.state.doc.nodes[n.id].transform[4]).toBeCloseTo(75, 8)
})
