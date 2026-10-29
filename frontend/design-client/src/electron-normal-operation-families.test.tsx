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


const creations = [
  ['set-tool-rectangle', 'rectangle'], ['set-tool-ellipse', 'ellipse'], ['set-tool-regular-polygon', 'polygon'],
  ['set-tool-star', 'star'], ['set-tool-line', 'line'], ['set-tool-arrow', 'line'], ['set-tool-frame', 'frame'],
  ['set-tool-section', 'section'], ['set-tool-text', 'text'], ['set-tool-slice', 'slice'],
] as const
for (const [command, kind] of creations) test(`${command}: positive dispatch → Canvas release → exact history; cancel before commit`, async () => {
  await render([]); const before = editor.state.doc
  await act(async () => { await dispatchEditorCommand(editor, command) })
  expect(editor.state.tool).toBe(command === 'set-tool-arrow' ? 'arrow' : kind)
  await act(async () => pointer('pointerdown', 100, 100))
  await act(async () => pointer('pointermove', 130, 120))
  await act(async () => pointer('pointercancel', 130, 120))
  expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false)
  await act(async () => pointer('pointerdown', 100, 100))
  // No final pointermove: the release sample must author the actual endpoint.
  await act(async () => pointer('pointerup', 180, 160))
  const ids = editor.state.doc.pages[0].children; expect(ids).toHaveLength(1)
  const created = editor.state.doc.nodes[ids[0]]; expect(created.kind).toBe(kind)
  expect(editor.state.selection).toEqual(ids)
  if (kind === 'line') {
    expect(created.network?.vertices).toHaveLength(2)
    const points = created.network!.vertices.map(v => apply(worldMatrix(editor.state.doc, created.id), v))
    expect(points).toEqual([{ x: 100, y: 100 }, { x: 180, y: 160 }])
    if (command === 'set-tool-arrow') expect(created.strokes[0].endMarker).toBe('arrow')
  } else {
    expect(created.transform.slice(4)).toEqual([100, 100])
    expect(created.width).toBeCloseTo(80, 8); expect(created.height).toBeCloseTo(60, 8)
  }
  const after = editor.state.doc
  await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false)
  await act(async () => editor.redo()); expect(editor.state.doc).toEqual(after)
})

for (const [label, axis, mode] of [
  ['左对齐', 'x', 'start'], ['水平居中', 'x', 'center'], ['右对齐', 'x', 'end'],
  ['顶对齐', 'y', 'start'], ['垂直居中', 'y', 'center'], ['底对齐', 'y', 'end'],
  ['水平等距分布', 'x', 'distribute'], ['垂直等距分布', 'y', 'distribute'],
] as const) test(`actual Inspector button ${label} rejects a locked mixed selection, then aligns unlocked selection with undo/redo`, async () => {
  const a = node('rectangle', 100, 100, 40, 30), b = node('rectangle', 200, 180, 60, 40), c = node('rectangle', 400, 350, 80, 50), locked = node('rectangle', 900, 900, 100, 100)
  locked.locked = true
  await render([a, b, c, locked]); await act(async () => { editor.select([a.id, b.id, c.id, locked.id]); root.render(<AlignmentControls editor={editor} />) })
  const before = editor.state.doc
  const blocked = mount.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
  expect(blocked.disabled).toBe(true)
  await act(async () => blocked.click())
  expect(editor.state.doc).toBe(before)
  await act(async () => { editor.select([a.id,b.id,c.id]); root.render(<AlignmentControls editor={editor} />) })
  const button=mount.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
  expect(button.disabled).toBe(false); await act(async () => button.click())
  const boxes = scene(editor.state.doc, editor.state.page).filter(e => [a.id, b.id, c.id].includes(e.id)).map(e => e.bounds)
  const size = axis === 'x' ? 'width' : 'height'
  if (mode === 'distribute') {
    boxes.sort((a, b) => a[axis] - b[axis])
    expect(boxes[1][axis] - boxes[0][axis] - boxes[0][size]).toBeCloseTo(boxes[2][axis] - boxes[1][axis] - boxes[1][size], 8)
  } else {
    const positions = boxes.map(b => b[axis] + (mode === 'end' ? b[size] : mode === 'center' ? b[size] / 2 : 0))
    expect(positions[1]).toBeCloseTo(positions[0], 8); expect(positions[2]).toBeCloseTo(positions[0], 8)
  }
  expect(editor.state.doc.nodes[locked.id]).toEqual(before.nodes[locked.id])
  const after = editor.state.doc; await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false)
  await act(async () => editor.redo()); expect(editor.state.doc).toEqual(after)
})

test('positive delete dispatcher deduplicates selected subtree, retains independent locked node and replays history', async () => {
  const g = node('group', 100, 100, 100, 100), child = node('rectangle', 10, 10, 30, 30), locked = node('rectangle', 400, 400, 50, 50)
  g.children = [child.id]; locked.locked = true
  await render([g, child, locked], [g.id, locked.id]); await act(async () => editor.select([g.id, child.id, locked.id]))
  const before = editor.state.doc
  await act(async () => { await dispatchEditorCommand(editor, 'delete') })
  expect(editor.state.doc.nodes[g.id]).toBeUndefined(); expect(editor.state.doc.nodes[child.id]).toBeUndefined()
  expect(editor.state.doc.nodes[locked.id]).toEqual(before.nodes[locked.id]); expect(editor.state.doc.pages[0].children).toEqual([locked.id])
  const after = editor.state.doc
  await act(async () => { await dispatchEditorCommand(editor, 'undo') }); expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false)
  await act(async () => { await dispatchEditorCommand(editor, 'redo') }); expect(editor.state.doc).toEqual(after)
})
