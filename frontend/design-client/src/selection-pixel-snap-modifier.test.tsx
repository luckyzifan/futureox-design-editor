// Mounted Canvas pointer gestures. jsdom only; Electron, macOS, and Metal are not run.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { kernelSnapPoint } from './kernel/picking'
import { blank, node, type DesignNode } from './model'
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

let dom: JSDOM, root: Root, mount: HTMLDivElement, editor: Editor, errors: unknown[][]
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLCanvasElement', 'Element', 'Node', 'Event', 'MouseEvent', 'WheelEvent', 'KeyboardEvent', 'FocusEvent', 'localStorage'])
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux' })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('devicePixelRatio', 1)
  vi.stubGlobal('CSS', { escape: (value: string) => value })
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => 1000 },
    clientHeight: { configurable: true, get: () => 800 },
  })
  vi.spyOn(dom.window.HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0, toJSON() {},
  })
  dom.window.HTMLElement.prototype.setPointerCapture = () => {}
  dom.window.HTMLElement.prototype.hasPointerCapture = () => false
  dom.window.HTMLElement.prototype.releasePointerCapture = () => {}
  vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  errors = []
  vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args) })
  localStorage.clear()
  shortcutPreference.set('figma-like')
  editor = new Editor(blank())
  mount = document.createElement('div')
  document.body.append(mount)
  root = createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount())
  editor.dispose()
  dom.window.close()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  expect(errors).toEqual([])
})

const host = () => mount.querySelector<HTMLElement>('[data-testid="canvas"]')!
async function render(nodes: DesignNode[], options: { snap?: boolean; snapPixels?: boolean }) {
  const doc = blank('Pixel snap modifier')
  doc.nodes = Object.fromEntries(nodes.map(item => [item.id, item]))
  doc.pages[0].children = nodes.map(item => item.id)
  editor.load(doc)
  editor.set({ view: { x: 0, y: 0, zoom: 1 }, tool: 'select', snap: !!options.snap, snapPixels: !!options.snapPixels })
  await act(async () => {
    root.render(<Canvas editor={editor} />)
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
  host().focus()
}
function pointer(type: string, x: number, y: number, options: MouseEventInit = {}, target: Element = host()) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...options })
  Object.defineProperties(event, { pointerId: { value: 7 }, isPrimary: { value: true }, pointerType: { value: 'mouse' } })
  target.dispatchEvent(event)
}

test('Control keeps pixel-grid snap while resizing a layer', async () => {
  const shape = node('rectangle', 0, 0, 100, 80)
  await render([shape], { snapPixels: true })
  await act(async () => editor.select([shape.id]))
  const edge = mount.querySelector('[data-testid="resize-edge-1"]')!
  expect(edge).not.toBeNull()
  await act(async () => pointer('pointerdown', 100, 40, { ctrlKey: true }, edge))
  await act(async () => pointer('pointerup', 130.4, 40, { ctrlKey: true }))
  expect(editor.state.doc.nodes[shape.id].width).toBeCloseTo(kernelSnapPoint({ x: 130.4, y: 80 }).x, 6)
  expect(editor.state.doc.nodes[shape.id].height).toBeCloseTo(80, 6)
  await act(async () => editor.undo())
  expect(editor.state.doc.nodes[shape.id].width).toBeCloseTo(100, 6)
})

test('Control keeps pixel-grid snap while moving a layer', async () => {
  const moved = node('rectangle', 8.125, 8.125, 80, 60)
  await render([moved], { snapPixels: true })
  await act(async () => editor.select([moved.id]))
  await act(async () => pointer('pointerdown', 48.125, 38.125, { ctrlKey: true }))
  await act(async () => pointer('pointermove', 53.125, 38.125, { ctrlKey: true }))
  await act(async () => pointer('pointerup', 53.125, 38.125, { ctrlKey: true }))
  expect(editor.state.doc.nodes[moved.id].transform[4]).toBeCloseTo(13, 6)
  expect(editor.state.doc.nodes[moved.id].transform[5]).toBeCloseTo(8, 6)
})

test('a frame follows the pixel-grid preference while moving', async () => {
  const board = node('frame', 8.125, 8.125, 80, 60)
  await render([board], { snapPixels: false })
  await act(async () => editor.select([board.id]))
  const drag = async () => {
    await act(async () => pointer('pointerdown', 48.125, 38.125))
    await act(async () => pointer('pointermove', 53.125, 38.125))
    await act(async () => pointer('pointerup', 53.125, 38.125))
  }
  await drag()
  expect(editor.state.doc.nodes[board.id].transform[4]).toBeCloseTo(13.125, 6)
  expect(editor.state.doc.nodes[board.id].transform[5]).toBeCloseTo(8.125, 6)
  await act(async () => editor.undo())
  expect(editor.state.doc.nodes[board.id].transform[4]).toBeCloseTo(8.125, 6)
  await act(async () => editor.set({ snapPixels: true }))
  await act(async () => editor.select([board.id]))
  await drag()
  expect(editor.state.doc.nodes[board.id].transform[4]).toBeCloseTo(13, 6)
  expect(editor.state.doc.nodes[board.id].transform[5]).toBeCloseTo(8, 6)
})

test('a frame follows the pixel-grid preference while resizing', async () => {
  const board = node('frame', 0, 0, 100, 80)
  await render([board], { snapPixels: false })
  await act(async () => editor.select([board.id]))
  const edge = () => mount.querySelector('[data-testid="resize-edge-1"]')!
  expect(edge()).not.toBeNull()
  await act(async () => pointer('pointerdown', 100, 40, {}, edge()))
  await act(async () => pointer('pointerup', 130.4, 40))
  expect(editor.state.doc.nodes[board.id].width).toBeCloseTo(130.4, 6)
  await act(async () => editor.undo())
  expect(editor.state.doc.nodes[board.id].width).toBeCloseTo(100, 6)
  await act(async () => editor.set({ snapPixels: true }))
  await act(async () => editor.select([board.id]))
  await act(async () => pointer('pointerdown', 100, 40, {}, edge()))
  await act(async () => pointer('pointerup', 130.4, 40))
  expect(editor.state.doc.nodes[board.id].width).toBeCloseTo(kernelSnapPoint({ x: 130.4, y: 80 }).x, 6)
})

test('dragging a handle past the opposite edge flips the layer and undo restores it', async () => {
  const shape = node('rectangle', 0, 0, 100, 50)
  await render([shape], { snap: false, snapPixels: false })
  await act(async () => editor.select([shape.id]))
  const edge = mount.querySelector('[data-testid="resize-edge-1"]')!
  const before = editor.state.doc
  await act(async () => pointer('pointerdown', 100, 25, {}, edge))
  await act(async () => pointer('pointerup', -20, 25))
  const layer = editor.state.doc.nodes[shape.id]
  expect(layer.width).toBeCloseTo(20, 6)
  expect(layer.height).toBeCloseTo(50, 6)
  expect(layer.transform[0] * layer.transform[3] - layer.transform[1] * layer.transform[2]).toBeLessThan(0)
  const bounds = editor.selectionBounds()
  expect(bounds.x).toBeCloseTo(-20, 6)
  expect(bounds.y).toBeCloseTo(0, 6)
  expect(bounds.width).toBeCloseTo(20, 6)
  expect(bounds.height).toBeCloseTo(50, 6)
  await act(async () => editor.undo())
  expect(editor.state.doc).toEqual(before)
})

test('resizing a handle snaps its moving edge to another object and draws the guide', async () => {
  const moving = node('rectangle', 0, 0, 50, 40)
  const target = node('rectangle', 100, 0, 40, 40)
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.push(fn); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  await render([moving, target], { snap: true, snapPixels: false })
  await act(async () => editor.select([moving.id]))
  const edge = () => mount.querySelector('[data-testid="resize-edge-1"]')!
  const before = editor.state.doc
  await act(async () => pointer('pointerdown', 50, 20, {}, edge()))
  await act(async () => pointer('pointermove', 96, 20))
  await act(async () => { for (const fn of frames.splice(0)) fn(0) })
  expect(editor.state.doc.nodes[moving.id].width).toBeCloseTo(100, 6)
  expect(editor.state.doc.nodes[moving.id].transform[4]).toBeCloseTo(0, 6)
  const guide = mount.querySelector('[data-testid="canvas-alignment-guide"]')
  expect(guide?.getAttribute('data-axis')).toBe('x')
  expect(Number(guide?.getAttribute('data-position'))).toBeCloseTo(100, 6)
  await act(async () => pointer('pointerup', 96, 20))
  expect(editor.state.doc.nodes[moving.id].width).toBeCloseTo(100, 6)
  expect(editor.state.doc.nodes[target.id].transform[4]).toBeCloseTo(100, 6)
  expect(mount.querySelector('[data-testid="canvas-alignment-guide"]')).toBeNull()
  await act(async () => editor.undo())
  expect(editor.state.doc).toEqual(before)
  await act(async () => pointer('pointerdown', 50, 20, { ctrlKey: true }, edge()))
  await act(async () => pointer('pointerup', 96, 20, { ctrlKey: true }))
  expect(editor.state.doc.nodes[moving.id].width).toBeCloseTo(96, 6)
  expect(editor.state.doc.nodes[moving.id].transform[4]).toBeCloseTo(0, 6)
})

test('shift-resize snap keeps aspect while the dragged edge meets the target', async () => {
  const moving = node('rectangle', 0, 0, 50, 40)
  const target = node('rectangle', 100, 0, 40, 40)
  await render([moving, target], { snap: true, snapPixels: false })
  await act(async () => editor.select([moving.id]))
  const edge = mount.querySelector('[data-testid="resize-edge-1"]')!
  await act(async () => pointer('pointerdown', 50, 20, { shiftKey: true }, edge))
  await act(async () => pointer('pointerup', 96, 20, { shiftKey: true }))
  const layer = editor.state.doc.nodes[moving.id]
  expect(layer.width).toBeCloseTo(100, 6)
  expect(layer.height).toBeCloseTo(80, 6)
  expect(layer.transform[4]).toBeCloseTo(0, 6)
})

test('Control still suspends object snap while pixel snap is off', async () => {
  const moving = node('rectangle', 0, 0, 50, 40)
  const target = node('rectangle', 100, 0, 40, 40)
  await render([moving, target], { snap: true, snapPixels: false })
  await act(async () => editor.select([moving.id]))
  const drag = async (ctrl: boolean) => {
    await act(async () => pointer('pointerdown', 25, 20, { ctrlKey: ctrl }))
    await act(async () => pointer('pointermove', 71, 20, { ctrlKey: ctrl }))
    await act(async () => pointer('pointerup', 71, 20, { ctrlKey: ctrl }))
  }
  await drag(false)
  expect(editor.state.doc.nodes[moving.id].transform[4]).toBeCloseTo(50, 6)
  await act(async () => editor.undo())
  await drag(true)
  expect(editor.state.doc.nodes[moving.id].transform[4]).toBeCloseTo(46, 6)
  expect(editor.state.doc.nodes[target.id].transform[4]).toBeCloseTo(100, 6)
})
