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
import { nudgePreference } from './nudge-preference'
import { selectionMetric } from './selection-properties'
import { hasPendingEdits } from './pending-edits'
import { Editor } from './engine'
import { blank, node, uid, type DesignNode } from './model'
import { shortcutPreference } from './shortcut-preference'

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
  localStorage.clear(); nudgePreference.reset(); shortcutPreference.set('sketch-like')
  editor = new Editor(blank()); editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false })
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount()); editor.dispose(); nudgePreference.reset(); shortcutPreference.set('figma-like'); dom.window.close()
  vi.unstubAllGlobals(); vi.restoreAllMocks(); expect(errors).toEqual([])
})
const host = () => mount.querySelector<HTMLElement>('[data-testid="canvas"]')!
async function render(nodes: DesignNode[], roots = nodes.map(n => n.id), otherRoots: string[] = [], withPages = false) {
  const doc = blank('Canvas event batching'); doc.nodes = Object.fromEntries(nodes.map(n => [n.id, n])); doc.pages[0].children = roots
  doc.id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'; doc.pages[0].id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  doc.pages.push({ ...doc.pages[0], id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', name: 'Empty page', children: [] })
  if (otherRoots.length) doc.pages.push({ ...doc.pages[0], id: uid(), name: 'Other page', children: otherRoots })
  await act(async () => { editor.load(doc); editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false }) })
  await act(async () => { root.render(<><Canvas editor={editor} />{withPages && <PageList editor={editor} onRename={() => {}} />}</>); for (let i = 0; i < 6; i++) await Promise.resolve() })
  host().focus(); return editor.state.doc
}
function key(value: string, options: KeyboardEventInit = {}, type = 'keydown', target: EventTarget = host()) {
  const event = new KeyboardEvent(type, { key: value, code: value.length === 1 ? `Key${value.toUpperCase()}` : value, bubbles: true, cancelable: true, ...options })
  target.dispatchEvent(event); return event
}

for (const platform of ['MacIntel', 'Win32', 'Linux']) for (const desktop of [false, true]) {
  test(`${platform} desktop=${desktop}: configured position/dimension repeats commit once, independent taps remain distinct`, async () => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: platform })
    if (desktop) Object.defineProperty(window, 'coreDesktop', { configurable: true, value: { version: 1, onCommand: () => () => {} } })
    const n = node('rectangle', 20, 40, 100, 80), before = await render([n])
    await act(async () => { editor.select([n.id]); nudgePreference.set({ small: .25, big: 2.5 }) })
    for (const repeat of [false, true, true]) await act(async () => { key('ArrowRight', { repeat }) })
    expect(editor.state.doc.nodes[n.id].transform[4]).toBe(20.75)
    expect(editor.state.version).toBe(1); expect(editor.interactionActive).toBe(true); expect(hasPendingEdits(editor)).toBe(true)
    await act(async () => { key('ArrowRight', {}, 'keyup') })
    expect(editor.interactionActive).toBe(false); expect(hasPendingEdits(editor)).toBe(false)
    const moved = editor.state.doc
    await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false)
    await act(async () => editor.redo()); expect(editor.state.doc).toEqual(moved)
    const modifier = platform === 'MacIntel' ? { metaKey: true } : { ctrlKey: true }
    for (const repeat of [false, true, true]) await act(async () => { key('ArrowDown', { ...modifier, repeat, shiftKey: true }) })
    await act(async () => { key('ArrowDown', {}, 'keyup') })
    expect(selectionMetric(editor.state.doc.nodes[n.id], 'height', editor.state.doc)).toBe(87.5)
    await act(async () => editor.undo()); expect(editor.state.doc).toEqual(moved)
    for (let i = 0; i < 2; i++) await act(async () => { key('ArrowLeft'); key('ArrowLeft', {}, 'keyup') })
    expect(editor.state.doc.nodes[n.id].transform[4]).toBe(20.25)
    await act(async () => editor.undo()); expect(editor.state.doc.nodes[n.id].transform[4]).toBe(20.5)
    await act(async () => editor.undo()); expect(editor.state.doc).toEqual(moved)
  })
}

test('Escape cancels only the active nudge; focus loss/selection change commit and stale held repeats do not restart', async () => {
  const a = node('rectangle', 20, 40, 100, 80), b = node('rectangle', 200, 40, 100, 80), before = await render([a, b])
  await act(async () => { editor.select([a.id]); key('ArrowRight'); key('ArrowRight', { repeat: true }); key('Escape') })
  expect(editor.state.doc).toEqual(before); expect(editor.state.selection).toEqual([a.id]); expect(editor.canUndo).toBe(false)
  await act(async () => { key('ArrowRight', { repeat: true }); key('ArrowRight', {}, 'keyup') })
  expect(editor.state.doc).toEqual(before)
  await act(async () => { key('ArrowDown'); window.dispatchEvent(new Event('blur')) })
  expect(editor.interactionActive).toBe(false); expect(editor.state.doc.nodes[a.id].transform[5]).toBe(41)
  await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before)
  await act(async () => { key('ArrowLeft'); editor.select([b.id]) })
  expect(editor.interactionActive).toBe(false); expect(editor.state.doc.nodes[a.id].transform[4]).toBe(19)
  await act(async () => { key('ArrowLeft', { repeat: true }) }); expect(editor.state.doc.nodes[b.id].transform[4]).toBe(200)
  await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before)
})

test('input focus, IME, AltGraph, busy state and pointer transactions retain keyboard ownership', async () => {
  const n = node('rectangle', 20, 40, 100, 80), before = await render([n])
  await act(async () => editor.select([n.id]))
  const input = document.createElement('input'); document.body.append(input)
  await act(async () => { input.focus(); key('ArrowRight', {}, 'keydown', input) })
  expect(editor.state.doc).toEqual(before)
  await act(async () => {
    host().focus(); key('ArrowRight', { isComposing: true }); key('ArrowRight', { keyCode: 229 })
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }); Object.defineProperty(event, 'getModifierState', { value: (key: string) => key === 'AltGraph' }); host().dispatchEvent(event)
    editor.set({ busy: true }); key('ArrowRight'); editor.set({ busy: false })
    editor.begin('Pointer edit'); editor.preview({ [n.id]: { width: 125 } }); key('ArrowRight'); editor.cancel()
  })
  expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false)
  await act(async () => { key('ArrowRight'); input.focus() })
  expect(editor.interactionActive).toBe(false); expect(editor.state.doc.nodes[n.id].transform[4]).toBe(21)
  await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before)
})

test('fractional movement under scaled/rotated parents, vector movement and dimension clamping remain reversible', async () => {
  const frame = node('frame', 10, 20, 400, 300), n = node('rectangle', 10, 20, 50, 40)
  frame.transform = [0, 2, -2, 0, 10, 20]; frame.children = [n.id]
  const before = await render([frame, n], [frame.id])
  await act(async () => { editor.select([n.id]); nudgePreference.set({ small: .25, big: 2.5 }); key('ArrowRight'); key('ArrowRight', {}, 'keyup') })
  expect(editor.state.doc.nodes[n.id].transform[4]).toBeCloseTo(10); expect(editor.state.doc.nodes[n.id].transform[5]).toBeCloseTo(19.875)
  await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before)
  await act(async () => { editor.update([n.id], { width: .01 }); key('ArrowLeft', { metaKey: true }); key('ArrowLeft', {}, 'keyup') })
  // The dimension field is in the same world-scaled units as the Inspector:
  // a 0.01 minimum under a 2x parent is 0.005 local units.
  expect(editor.state.doc.nodes[n.id].width).toBe(.005)
  await act(async () => editor.undo()); expect(editor.state.doc.nodes[n.id].width).toBe(.01)
  await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before)
  const v = node('vector', 100, 100, 20, 20); v.network = { fillRule: 'nonzero', vertices: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 20, y: 20 }], edges: [{ id: 'ab', from: 'a', to: 'b' }] }
  const vectorBefore = await render([v])
  await act(async () => { editor.select([v.id]); editor.set({ tool: 'vector', editingVertex: 'a' }); key('ArrowRight'); key('ArrowRight', { repeat: true }); key('ArrowRight', {}, 'keyup') })
  expect(editor.state.doc.nodes[v.id].network!.vertices[0].x).toBe(.5)
  await act(async () => editor.undo()); expect(editor.state.doc).toEqual(vectorBefore)
})

test('empty-selection arrows pan in screen pixels while a tool is armed, including at zoom 2', async () => {
  shortcutPreference.set('figma-like')
  const before = await render([])
  await act(async () => { editor.set({ tool: 'frame', view: { x: 0, y: 0, zoom: 2 } }); nudgePreference.set({ small: 1, big: 10 }) })
  await act(async () => { key('ArrowRight'); key('ArrowRight', {}, 'keyup') })
  expect(editor.state.view).toEqual({ x: -20, y: 0, zoom: 2 })
  await act(async () => { key('ArrowDown', { shiftKey: true }); key('ArrowDown', { shiftKey: true }, 'keyup') })
  expect(editor.state.view).toEqual({ x: -20, y: -100, zoom: 2 })
  expect(editor.state.doc).toBe(before)
  expect(editor.canUndo).toBe(false)
})

test('camera arrows keep the existing pan units and no document undo history', async () => {
  const before = await render([])
  await act(async () => { nudgePreference.set({ small: .25, big: 2.5 }); key('ArrowLeft'); key('ArrowDown', { shiftKey: true }) })
  expect(editor.state.view).toEqual({ x: 20, y: -100, zoom: 1 }); expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
})

test('Figma defaults nudge 1px and Shift+arrow 10px as one undo each', async () => {
  shortcutPreference.set('figma-like')
  const n = node('rectangle', 20, 40, 100, 80), before = await render([n])
  await act(async () => editor.select([n.id]))
  await act(async () => { key('ArrowRight'); key('ArrowRight', {}, 'keyup') })
  expect(editor.state.doc.nodes[n.id].transform[4]).toBe(21)
  await act(async () => { key('ArrowDown', { shiftKey: true }); key('ArrowDown', { shiftKey: true }, 'keyup') })
  expect(editor.state.doc.nodes[n.id].transform[5]).toBe(50)
  await act(async () => editor.undo()); await act(async () => editor.undo())
  expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false)
})

test('Delete and Backspace remove the selection and undo restores it', async () => {
  shortcutPreference.set('figma-like')
  const n = node('rectangle', 20, 40, 40, 40), before = await render([n])
  await act(async () => editor.select([n.id]))
  await act(async () => key('Backspace'))
  expect(editor.state.doc.nodes[n.id]).toBeUndefined()
  await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before)
  await act(async () => { editor.select([n.id]); key('Delete') })
  expect(editor.state.doc.nodes[n.id]).toBeUndefined()
  await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before)
})

test('Cmd+A selects entered siblings, and bracket keys reorder inside the parent', async () => {
  shortcutPreference.set('figma-like')
  const frame = node('frame', 0, 0, 400, 300), a = node('rectangle', 20, 30, 40, 40), b = node('rectangle', 80, 30, 40, 40), outside = node('rectangle', 500, 30, 40, 40)
  frame.children = [a.id, b.id]
  await render([frame, a, b, outside], [frame.id, outside.id])
  await act(async () => editor.select([a.id]))
  await act(async () => key('a', { metaKey: true }))
  expect(editor.state.selection).toEqual([a.id, b.id])
  await act(async () => editor.select([frame.id]))
  await act(async () => key('a', { metaKey: true }))
  expect(editor.state.selection).toEqual([frame.id, outside.id])
  await act(async () => editor.select([a.id]))
  await act(async () => key(']', { code: 'BracketRight' }))
  expect(editor.state.doc.nodes[frame.id].children).toEqual([b.id, a.id])
  await act(async () => key('[', { code: 'BracketLeft' }))
  expect(editor.state.doc.nodes[frame.id].children).toEqual([a.id, b.id])
})
