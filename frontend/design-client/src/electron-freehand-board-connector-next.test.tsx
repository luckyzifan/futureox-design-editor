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
import { scene, worldMatrix, apply } from './geometry'
import { dispatchEditorCommand } from './editor-commands'
import { AlignmentControls } from './AlignmentControls'

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



for (const tool of ['pencil', 'brush', 'marker', 'washi-tape'] as const) test(`set-tool-${tool}: real Canvas freehand commits editable geometry once, cancels and protects unrelated lock`, async () => {
  const locked = node('rectangle', 500, 500, 40, 40); locked.locked = true
  await render([locked]); const before = editor.state.doc
  await act(async () => { await dispatchEditorCommand(editor, `set-tool-${tool}`) })
  expect(editor.state.tool).toBe(tool)
  await act(async () => pointer('pointerdown', 100, 100))
  await act(async () => pointer('pointermove', 120, 110))
  await act(async () => pointer('pointercancel', 120, 110)); unchanged(before)
  await act(async () => pointer('pointerdown', 100, 100))
  for (const [x, y] of [[115, 105], [130, 120], [145, 110], [160, 125]]) await act(async () => pointer('pointermove', x, y))
  await act(async () => pointer('pointerup', 180, 130))
  expect(editor.state.doc.pages[0].children).toHaveLength(2)
  const id = editor.state.selection[0], n = editor.state.doc.nodes[id]
  expect(id).not.toBe(locked.id); expect(n.kind).toBe('vector')
  expect(n.network!.vertices.length).toBeGreaterThan(1); expect(n.network!.edges.length).toBeGreaterThan(0)
  expect(n.width).toBeGreaterThan(0); expect(n.height).toBeGreaterThan(0)
  if (tool === 'marker') expect(n.opacity).toBe(.4)
  if (tool === 'washi-tape') expect(n.effects.some(e => e.kind === 'noise')).toBe(true)
  expect(editor.state.doc.nodes[locked.id]).toEqual(before.nodes[locked.id])
  const after = editor.state.doc; await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false)
  await act(async () => editor.redo()); expect(editor.state.doc).toEqual(after)
})
for (const shape of ['square', 'ellipse', 'rounded-rectangle', 'triangle-up', 'triangle-down', 'diamond'] as const) test(`set-tool-shape-whiteboard-${shape}: actual Canvas final release, cancel, hierarchy and history`, async () => {
  await render([]); const before = editor.state.doc, tool = `shape-whiteboard-${shape}` as const
  await act(async () => { await dispatchEditorCommand(editor, `set-tool-${tool}`) })
  expect(editor.state.tool).toBe(tool)
  await act(async () => pointer('pointerdown', 100, 100))
  await act(async () => pointer('pointermove', 130, 120))
  await act(async () => pointer('pointercancel', 130, 120)); unchanged(before)
  await act(async () => pointer('pointerdown', 100, 100))
  await act(async () => pointer('pointerup', 260, 220))
  expect(editor.state.doc.pages[0].children).toHaveLength(1)
  const id = editor.state.doc.pages[0].children[0], n = editor.state.doc.nodes[id]
  expect(n.board?.kind).toBe(tool); expect(editor.state.selection).toEqual([id]); expect(editor.state.tool).toBe(tool)
  expect(n.transform.slice(4)).toEqual([100, 100]); expect(n.width).toBeCloseTo(160, 8); expect(n.height).toBeCloseTo(120, 8)
  expect(n.children.length).toBeGreaterThan(0)
  for (const child of n.children) expect(editor.state.doc.nodes[child]).toBeDefined()
  const after = editor.state.doc; await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false)
  await act(async () => editor.redo()); expect(editor.state.doc).toEqual(after)
})
for (const tool of ['connector-straight', 'connector-elbowed'] as const) for (const anchored of [false, true]) test(`set-tool-${tool}: ${anchored ? 'bound' : 'free'} endpoints use actual hit-test and final release, cancel/history`, async () => {
  const a = node('rectangle', 100, 100, 80, 80), b = node('rectangle', 300, 100, 80, 80)
  await render(anchored ? [a, b] : []); const before = editor.state.doc
  await act(async () => { await dispatchEditorCommand(editor, `set-tool-${tool}`) })
  expect(editor.state.tool).toBe(tool)
  const start = anchored ? [179, 140] : [100, 100], end = anchored ? [301, 140] : [300, 200]
  await act(async () => pointer('pointerdown', start[0], start[1]))
  await act(async () => pointer('pointermove', 220, 160))
  await act(async () => pointer('pointercancel', 220, 160)); unchanged(before)
  await act(async () => pointer('pointerdown', start[0], start[1]))
  await act(async () => pointer('pointerup', end[0], end[1]))
  expect(editor.state.doc.pages[0].children).toHaveLength(anchored ? 3 : 1)
  const n = editor.state.doc.nodes[editor.state.selection[0]], link = n.connector!
  expect(link).toBeDefined(); expect(link.style).toBe(tool === 'connector-straight' ? 'straight' : 'elbow')
  expect(n.strokes[0].endMarker).toBe('arrow'); expect(n.network!.edges.length).toBeGreaterThan(0)
  if (anchored) {
    expect(link.from.nodeId).toBe(a.id); expect(link.to.nodeId).toBe(b.id)
    expect(link.from.anchor).toEqual({ x: 1, y: .5 }); expect(link.to.anchor).toEqual({ x: 0, y: .5 })
    expect(editor.state.doc.nodes[a.id]).toEqual(before.nodes[a.id]); expect(editor.state.doc.nodes[b.id]).toEqual(before.nodes[b.id])
  } else {
    expect(link.from.nodeId).toBeUndefined(); expect(link.to.nodeId).toBeUndefined()
    expect(link.from.point).toEqual({ x: start[0], y: start[1] }); expect(link.to.point).toEqual({ x: end[0], y: end[1] })
  }
  const after = editor.state.doc; await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false)
  await act(async () => editor.redo()); expect(editor.state.doc).toEqual(after)
})
