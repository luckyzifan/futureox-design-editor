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

test('set-tool-pen: open path commits exact endpoints through Enter, one undo and redo', async () => {
  await render([]); const before = editor.state.doc
  await activate('set-tool-pen'); expect(editor.state.tool).toBe('pen')
  await clickPoint(100, 100); await clickPoint(200, 160)
  expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
  await act(async () => key('Enter'))
  expect(editor.state.doc.pages[0].children).toHaveLength(1)
  const n = editor.state.doc.nodes[editor.state.selection[0]]
  expect(n.kind).toBe('vector'); expect(n.network!.edges).toHaveLength(1)
  expect(n.network!.vertices.map(v => apply(worldMatrix(editor.state.doc, n.id), v))).toEqual([{ x: 100, y: 100 }, { x: 200, y: 160 }])
  expect(n.width).toBe(100); expect(n.height).toBe(60); expect(editor.state.tool).toBe('select')
  await history(before)
})
test('set-tool-pen: Escape keeps the open path, deselects it, and stays on the pen', async () => {
  await render([]); const before = editor.state.doc
  await activate('set-tool-pen'); await clickPoint(100, 100); await clickPoint(200, 160)
  await act(async () => key('Escape'))
  expect(editor.state.tool).toBe('pen'); expect(editor.state.selection).toEqual([])
  expect(editor.state.doc.pages[0].children).toHaveLength(1)
  const n = editor.state.doc.nodes[editor.state.doc.pages[0].children[0]]
  expect(n.network!.edges).toHaveLength(1); expect(n.fills).toEqual([])
  expect(mount.querySelectorAll('[data-testid="pen-anchor"]')).toHaveLength(0)
  await history(before)
})
test('set-tool-pen: one point and Escape discards the draft and returns to select', async () => {
  await render([]); const before = editor.state.doc
  await activate('set-tool-pen'); await clickPoint(40, 40)
  await act(async () => key('Escape')); unchanged(before); expect(editor.state.tool).toBe('select')
})
test('set-tool-pen: Shift snaps to 45 degrees, Option breaks the mirror, and closing adds the shape fill', async () => {
  await render([])
  await activate('set-tool-pen')
  await clickPoint(100, 100)
  await act(async () => pointer('pointerdown', 160, 130, { shiftKey: true }))
  await act(async () => pointer('pointerup', 160, 130, { shiftKey: true }))
  await act(async () => key('Enter'))
  const angled = editor.state.doc.nodes[editor.state.selection[0]]
  const end = apply(worldMatrix(editor.state.doc, angled.id), angled.network!.vertices[1])
  const length = Math.hypot(60, 30)
  expect(end.x).toBeCloseTo(100 + length * Math.SQRT1_2, 4)
  expect(end.y).toBeCloseTo(100 + length * Math.SQRT1_2, 4)
  await act(async () => editor.undo())
  await activate('set-tool-pen')
  await act(async () => pointer('pointerdown', 100, 100))
  await act(async () => pointer('pointermove', 100, 140))
  await act(async () => pointer('pointerup', 100, 140))
  await act(async () => pointer('pointerdown', 220, 100, { altKey: true }))
  await act(async () => pointer('pointermove', 260, 70, { altKey: true }))
  await act(async () => pointer('pointerup', 260, 70, { altKey: true }))
  await act(async () => key('Enter'))
  const curved = editor.state.doc.nodes[editor.state.selection[0]]
  expect(curved.network!.edges[0].c1).toBeDefined()
  expect(curved.network!.edges[0].c2).toBeUndefined()
  await act(async () => editor.undo())
  await activate('set-tool-pen')
  await clickPoint(100, 100); await clickPoint(180, 100); await clickPoint(140, 170); await clickPoint(100, 100)
  await act(async () => key('Enter'))
  const closed = editor.state.doc.nodes[editor.state.selection[0]]
  expect(closed.network!.edges).toHaveLength(3)
  expect(closed.fills.some(fill => fill.visible && fill.color === '#818cf8')).toBe(true)
})
test('set-tool-pen: command-z drops the last point without a document edit', async () => {
  await render([]); const before = editor.state.doc
  await activate('set-tool-pen')
  await clickPoint(20, 20); await clickPoint(80, 20); await clickPoint(140, 40)
  await act(async () => key('z', { metaKey: true }))
  unchanged(before)
  expect(mount.querySelectorAll('[data-testid="pen-anchor"]')).toHaveLength(2)
  await act(async () => key('Enter'))
  expect(editor.state.doc.nodes[editor.state.selection[0]].network!.edges).toHaveLength(1)
})
test('set-tool-pen: an endpoint continues the selected vector and empty space starts a new one', async () => {
  const line = node('vector', 10, 10, 100, 1)
  line.fills = []
  line.network = { fillRule: 'evenodd', vertices: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 100, y: 0 }], edges: [{ id: 'ab', from: 'a', to: 'b' }] }
  await render([line]); await act(async () => editor.select([line.id]))
  await activate('set-tool-pen')
  await clickPoint(400, 300); await clickPoint(460, 320)
  await act(async () => key('Enter'))
  expect(editor.state.doc.pages[0].children).toHaveLength(2)
  expect(editor.state.doc.nodes[line.id].network!.edges).toHaveLength(1)
  await act(async () => editor.select([line.id]))
  await activate('set-tool-pen')
  await clickPoint(110, 10); await clickPoint(110, 80)
  await act(async () => key('Enter'))
  expect(editor.state.doc.pages[0].children).toHaveLength(2)
  expect(editor.state.doc.nodes[line.id].network!.edges).toHaveLength(2)
})

test('set-tool-eraser: a brush cuts a stroked line in one undo and cancel restores it', async () => {
  const line = node('line', 100, 100, 100, 100); line.fills = []; line.strokes = [stroke()]
  const locked = node('line', 300, 100, 100, 100); locked.fills = []; locked.strokes = [stroke()]; locked.locked = true
  const filled = node('rectangle', 500, 100, 100, 100)
  await render([line, locked, filled]); const before = editor.state.doc
  await activate('set-tool-eraser'); expect(editor.state.tool).toBe('eraser')
  await act(async () => pointer('pointerdown', 140, 140)); await act(async () => pointer('pointermove', 150, 150))
  await act(async () => pointer('pointercancel', 150, 150)); unchanged(before)
  await act(async () => pointer('pointerdown', 140, 140)); await act(async () => pointer('pointerup', 150, 150))
  const cut = editor.state.doc.nodes[line.id]
  expect(cut.kind).toBe('vector'); expect(cut.network!.edges.length).toBeGreaterThan(1)
  const world = cut.network!.vertices.map(vertex => apply(worldMatrix(editor.state.doc, line.id), vertex))
  expect(world).toContainEqual({ x: 100, y: 100 }); expect(world).toContainEqual({ x: 200, y: 200 })
  expect(editor.state.doc.nodes[locked.id]).toEqual(before.nodes[locked.id])
  expect(editor.state.doc.nodes[filled.id]).toEqual(before.nodes[filled.id])
  await history(before)
})
test('set-tool-eraser: locked strokes are skipped and a filled shape subtracts the brush once', async () => {
  const locked = node('line', 100, 100, 100, 100); locked.fills = []; locked.strokes = [stroke()]; locked.locked = true
  const filled = node('rectangle', 300, 100, 100, 100)
  await render([locked, filled]); const before = editor.state.doc
  await activate('set-tool-eraser'); await clickPoint(150, 150)
  expect(editor.state.doc.nodes[locked.id]).toEqual(before.nodes[locked.id]); expect(editor.canUndo).toBe(false)
  await clickPoint(350, 150)
  expect(editor.state.doc.nodes[locked.id]).toEqual(before.nodes[locked.id])
  const shape = editor.state.doc.nodes[filled.id]
  expect(shape.kind).toBe('vector')
  expect(shape.fills[0].color).toBe(before.nodes[filled.id].fills[0].color)
  expect(shape.network!.vertices.length).toBeGreaterThan(4)
  await history(before)
})

test('set-tool-paint-bucket: selected closed outline receives an explicit filled face with one undo and redo', async () => {
  const outline = node('rectangle', 100, 100, 120, 80); outline.fills = []; outline.strokes = [stroke()]
  await render([outline]); await act(async () => editor.select([outline.id])); const before = editor.state.doc
  await activate('set-tool-paint-bucket'); expect(editor.state.tool).toBe('paint-bucket')
  // Bucket deliberately uses the selected target, then native local-region hit testing.
  await clickPoint(160, 140)
  const n = editor.state.doc.nodes[outline.id]
  expect(n.network).toBeDefined(); expect(n.network!.filledFaces!.length).toBeGreaterThan(0)
  expect(n.fills.some(p => p.visible && p.color === editor.state.pencil.color)).toBe(true)
  expect(n.transform).toEqual(before.nodes[outline.id].transform)
  expect(n.strokes).toEqual(before.nodes[outline.id].strokes)
  await history(before)
})

test('set-tool-scale: actual corner handle preserves opposite anchor, native local content, cancel and one history step', async () => {
  const n = node('rectangle', 100, 100, 100, 80); n.strokes = [stroke()]
  await render([n]); await act(async () => editor.select([n.id])); const before = editor.state.doc
  await activate('set-tool-scale'); expect(editor.state.tool).toBe('scale')
  const corner = () => { const el = mount.querySelector('[data-testid="resize-2"]'); expect(el).not.toBeNull(); return el! }
  await act(async () => pointer('pointerdown', 200, 180, {}, corner()))
  await act(async () => pointer('pointermove', 250, 220)); await act(async () => key('Escape')); unchanged(before)
  await activate('set-tool-scale'); expect(editor.state.tool).toBe('scale')
  await act(async () => pointer('pointerdown', 200, 180, {}, corner()))
  await act(async () => pointer('pointerup', 300, 260))
  const result = editor.state.doc.nodes[n.id]
  expect(result.transform).toEqual([2, 0, 0, 2, 100, 100])
  expect(result.width).toBe(100); expect(result.height).toBe(80); expect(result.strokes).toEqual(before.nodes[n.id].strokes)
  expect(apply(worldMatrix(editor.state.doc, n.id), { x: 0, y: 0 })).toEqual({ x: 100, y: 100 })
  await history(before)
})
