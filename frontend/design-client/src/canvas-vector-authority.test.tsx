// Actual mounted Canvas/event propagation + Editor/WASM. Only the render-device
// boundary is replaced; no native browser, GPU, or pixel-quality claim.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { blank, node, paint } from './model'
import { shortcutPreference } from './shortcut-preference'
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
async function renderPreciseShape() {
  const doc = blank('Canvas precise editing'), shape = node('vector', 100, 100, 100, 80)
  doc.schemaVersion = 16; shape.strokes = []; shape.fills = [paint('#426bdf')]
  shape.vectorGeometry = { fillRule: 'nonzero', fill: [
    { move: [0, 0] }, { cubic: [25, 0, 75, 0, 100, 0] },
    { line: [100, 80] }, { line: [0, 80] }, { line: [0, 0] }, 'close',
  ] }
  doc.nodes = { [shape.id]: shape }; doc.pages[0].children = [shape.id]
  editor.load(doc); editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false })
  await act(async () => { root.render(<Canvas editor={editor} />); for (let i = 0; i < 6; i++) await Promise.resolve() })
  await act(async () => { editor.select([shape.id]); editor.set({ tool: 'vector' }) })
  host().focus(); return shape.id
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
async function moveTo(x: number, y: number) {
  await act(async () => {
    pointer('pointermove', x, y)
    // Drain one actual RAF batch so assertions inspect the preview, not only release.
    const pending = [...frames.values()]; frames.clear()
    for (const frame of pending) frame(performance.now())
  })
}
function target(kind: 'vertex' | 'handle') {
  const element = mount.querySelector(kind === 'vertex' ? '[data-testid="vector-anchor"]' : 'circle[r="3.5"]')
  expect(element).not.toBeNull(); return element!
}
const cases = [
  { kind: 'vertex' as const, start: [100, 100], finish: [112, 107] },
  { kind: 'handle' as const, start: [125, 100], finish: [137, 107] },
]
function untouched(before: typeof editor.state.doc, id: string, canRedo = false) {
  expect(editor.state.doc).toEqual(before)
  expect(editor.state.doc.nodes[id].vectorGeometry).toEqual(before.nodes[id].vectorGeometry)
  expect(editor.state.doc.nodes[id].network).toBeUndefined()
  expect(editor.canUndo).toBe(false); expect(editor.canRedo).toBe(canRedo)
}
test.each(cases)('$kind drag replaces precise authority and commits one undo/redo transaction', async ({ kind, start, finish }) => {
  const id = await renderPreciseShape(), before = editor.state.doc, originalNetwork = editableNetwork(before.nodes[id])
  await act(async () => pointer('pointerdown', start[0], start[1], {}, target(kind)))
  await moveTo(finish[0], finish[1])
  const preview = editor.state.doc.nodes[id]
  expect(preview.network, editor.state.message).toBeDefined(); expect(preview.vectorGeometry).toBeUndefined()
  expect(editor.canUndo).toBe(false)
  await act(async () => pointer('pointerup', finish[0], finish[1]))
  const after = editor.state.doc, edited = after.nodes[id]
  expect(edited.vectorGeometry).toBeUndefined(); expect(editor.canUndo).toBe(true)
  expect(edited.transform).toEqual(before.nodes[id].transform); expect(edited.fills).toEqual(before.nodes[id].fills)
  if (kind === 'vertex') {
    expect(edited.network!.vertices[0]).toEqual({ ...originalNetwork.vertices[0], x: 12, y: 7 })
    expect(edited.network!.vertices.slice(1)).toEqual(originalNetwork.vertices.slice(1))
  } else {
    expect(edited.network!.vertices).toEqual(originalNetwork.vertices)
    expect(edited.network!.edges[0].c1).toEqual({ x: 37, y: 7 })
    expect(edited.network!.edges[0].c2).toEqual(originalNetwork.edges[0].c2)
  }
  expect(before.nodes[id].vectorGeometry).toBeDefined(); expect(before.nodes[id].network).toBeUndefined()
  await act(async () => editor.undo()); untouched(before, id, true)
  await act(async () => editor.redo()); expect(editor.state.doc).toEqual(after)
})
test.each(cases)('$kind no-motion and return-to-origin preserve authored curves without history', async ({ kind, start, finish }) => {
  const id = await renderPreciseShape(), before = editor.state.doc
  await act(async () => pointer('pointerdown', start[0], start[1], {}, target(kind)))
  await act(async () => pointer('pointerup', start[0], start[1])); untouched(before, id)
  await act(async () => pointer('pointerdown', start[0], start[1], {}, target(kind)))
  await moveTo(finish[0], finish[1]); expect(editor.state.doc.nodes[id].vectorGeometry).toBeUndefined()
  await moveTo(start[0], start[1])
  await act(async () => pointer('pointerup', start[0], start[1])); untouched(before, id)
})
test.each(cases)('$kind pointer cancellation discards converted previews and ignores late release', async ({ kind, start, finish }) => {
  const id = await renderPreciseShape(), before = editor.state.doc
  await act(async () => pointer('pointerdown', start[0], start[1], {}, target(kind)))
  await moveTo(finish[0], finish[1]); expect(editor.state.doc.nodes[id].vectorGeometry).toBeUndefined()
  await act(async () => pointer('pointercancel', finish[0], finish[1])); untouched(before, id)
  await act(async () => pointer('pointerup', finish[0] + 5, finish[1] + 5)); untouched(before, id)
})
test.each(cases)('$kind Escape cancellation restores authored curves before a late pointer release', async ({ kind, start, finish }) => {
  const id = await renderPreciseShape(), before = editor.state.doc
  await act(async () => pointer('pointerdown', start[0], start[1], {}, target(kind)))
  await moveTo(finish[0], finish[1]); expect(editor.state.doc.nodes[id].vectorGeometry).toBeUndefined()
  await act(async () => key('Escape')); untouched(before, id)
  await act(async () => pointer('pointerup', finish[0], finish[1])); untouched(before, id)
})
