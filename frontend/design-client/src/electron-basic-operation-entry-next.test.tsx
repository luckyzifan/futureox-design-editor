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
import { geometry_json } from './generated/design-kernel/design_kernel'

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

test('convert-section: actual dispatcher preserves frame descendants/world geometry in one reversible edit', async () => {
  const frame = node('frame', 100, 100, 200, 160), child = node('rectangle', 20, 30, 40, 50)
  frame.children = [child.id]; await render([frame, child], [frame.id]); await act(async () => editor.select([frame.id]))
  const before = editor.state.doc, world = worldMatrix(before, child.id)
  await activate('convert-section')
  expect(editor.state.doc.nodes[frame.id].kind).toBe('section'); expect(editor.state.doc.nodes[frame.id].children).toEqual([child.id])
  expect(worldMatrix(editor.state.doc, child.id)).toEqual(world); expect(editor.state.doc.nodes[child.id]).toEqual(before.nodes[child.id])
  await history(before)
})

test('outline-stroke: dispatcher uses real native geometry and retains paint in one reversible outline', async () => {
  // Worker transport is a test double; calculation is the actual initialized WASM
  // geometry_json, never a supplied success contour. Real Worker startup is unverified.
  vi.stubGlobal('Worker', class {
    onmessage: ((event: { data: unknown }) => void) | null = null
    onerror: ((event: { message: string }) => void) | null = null
    postMessage(payload: unknown) {
      queueMicrotask(() => {
        try { this.onmessage?.({ data: { results: JSON.parse(geometry_json(JSON.stringify(payload))) } }) }
        catch (error) { this.onmessage?.({ data: { error: String(error) } }) }
      })
    }
    terminate() {}
  })
  const n = node('rectangle', 100, 100, 120, 80); n.fills = []; n.strokes = [{ ...stroke(), width: 8 }]
  await render([n]); await act(async () => editor.select([n.id])); const before = editor.state.doc
  await activate('outline-stroke')
  expect(editor.state.busy).toBe(false); expect(editor.state.doc.nodes[n.id]).toBeUndefined()
  expect(editor.state.doc.pages[0].children).toHaveLength(1)
  const outlined = editor.state.doc.nodes[editor.state.doc.pages[0].children[0]]
  expect(outlined.kind).toBe('vector'); expect(outlined.strokes).toEqual([]); expect(outlined.fills).toEqual([before.nodes[n.id].strokes[0].paint])
  expect(outlined.network!.vertices.length).toBeGreaterThan(3); expect(outlined.network!.edges.length).toBeGreaterThan(3)
  expect(outlined.width).toBeGreaterThanOrEqual(120); expect(outlined.height).toBeGreaterThanOrEqual(80)
  await history(before)
})
for (const command of ['resize-height-decrease-large', 'resize-width-decrease'] as const) test(`${command}: normal dispatcher changes the intended dimension and preserves the other with history`, async () => {
  const n = node('rectangle', 100, 100, 120, 80); await render([n]); await act(async () => editor.select([n.id])); const before = editor.state.doc
  await activate(command); const result = editor.state.doc.nodes[n.id]
  expect(result.width).toBe(command === 'resize-width-decrease' ? 119 : 120)
  expect(result.height).toBe(command === 'resize-height-decrease-large' ? 70 : 80)
  expect(result.transform).toEqual(before.nodes[n.id].transform); await history(before)
})
for (const command of ['zoom-fit', 'zoom-selection'] as const) test(`${command}: dispatcher frames correct bounds with camera-only state`, async () => {
  const a = node('rectangle', 100, 100, 100, 100), b = node('rectangle', 500, 100, 100, 100)
  await render([a, b]); await act(async () => editor.select([a.id])); const before = editor.state.doc
  await activate(command)
  const zoom = command === 'zoom-fit' ? 920 / 500 : 720 / 100, cx = command === 'zoom-fit' ? 350 : 150
  expect(editor.state.view.zoom).toBeCloseTo(zoom, 10)
  expect(editor.state.view.x).toBeCloseTo(500 - cx * zoom, 10); expect(editor.state.view.y).toBeCloseTo(400 - 150 * zoom, 10)
  expect(editor.state.selection).toEqual([a.id]); unchanged(before)
})
test('set-tool-hand: actual Canvas release pans camera without document or selection changes', async () => {
  const n = node('rectangle', 100, 100, 100, 100); await render([n]); await act(async () => editor.select([n.id])); const before = editor.state.doc
  await activate('set-tool-hand'); await act(async () => pointer('pointerdown', 400, 400)); await act(async () => pointer('pointerup', 450, 430))
  expect(editor.state.view).toEqual({ x: 50, y: 30, zoom: 1 }); expect(editor.state.selection).toEqual([n.id]); unchanged(before)
})
test('set-tool-default: actual hit selects, drag commits final translation and undo/redo once', async () => {
  const n = node('rectangle', 100, 100, 100, 100); await render([n]); const before = editor.state.doc
  await activate('set-tool-default'); await clickPoint(140, 140); expect(editor.state.selection).toEqual([n.id]); unchanged(before)
  await act(async () => pointer('pointerdown', 140, 140)); await act(async () => pointer('pointermove', 160, 150)); await act(async () => pointer('pointerup', 180, 170))
  expect(editor.state.doc.nodes[n.id].transform).toEqual([1, 0, 0, 1, 140, 130]); await history(before)
})
test('set-tool-multiselect: actual sequential hits add both eligible nodes without authoring', async () => {
  const a = node('rectangle', 100, 100, 100, 100), b = node('rectangle', 300, 100, 100, 100)
  await render([a, b]); const before = editor.state.doc
  await activate('set-tool-multiselect'); await clickPoint(140, 140); await clickPoint(340, 140)
  expect([...editor.state.selection].sort()).toEqual([a.id, b.id].sort()); unchanged(before)
})
test('set-tool-zoom: actual rectangle release fits drawn world region without authoring', async () => {
  await render([]); const before = editor.state.doc
  await activate('set-tool-zoom'); await act(async () => pointer('pointerdown', 100, 100)); await act(async () => pointer('pointerup', 300, 200))
  expect(editor.state.view.zoom).toBeCloseTo(5, 10); expect(editor.state.view.x).toBeCloseTo(-500, 10); expect(editor.state.view.y).toBeCloseTo(-350, 10)
  unchanged(before)
})
