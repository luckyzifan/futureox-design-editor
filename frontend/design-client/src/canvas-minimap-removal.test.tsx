// Production Canvas, its real children/events, and Editor/WASM in React/jsdom.
// Only the rendering-device boundary is replaced: no browser/GPU/pixel claim.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { blank, node } from './model'
import { screenToWorld } from './canvas-camera'

// Present the actual Canvas camera/document back through its production
// presentation callback. No Canvas, control, geometry, or event handler is mocked.
vi.mock('./kernel/Surface', async () => {
  const { useLayoutEffect } = await import('react')
  return {
    KernelSurface(props: import('./kernel/Surface').SurfaceProps) {
      useLayoutEffect(() => {
        props.onPresentation?.({ ...props, epoch: props.presentationEpoch!, pixelRatio: 1, managed: false })
      }, [props.document, props.pageId, props.view, props.width, props.height, props.presentationEpoch, props.onPresentation])
      return <div data-testid="surface-boundary" data-view={JSON.stringify(props.view)} />
    },
  }
})

let dom: any, root: Root, mount: HTMLDivElement, editor: Editor
let frames: Map<number, FrameRequestCallback>, frameId: number
let contextCalls: ReturnType<typeof vi.spyOn>, errors: unknown[][]
let visibleId: string, distantId: string
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLCanvasElement', 'Element', 'Node', 'Event', 'MouseEvent', 'WheelEvent', 'KeyboardEvent', 'localStorage'])
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('devicePixelRatio', 1)
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
  // A hidden/reintroduced minimap still asks for a 2D context and draws.
  // Record that work even if CSS/ARIA/test IDs are removed or hidden.
  const context = { setTransform: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn() }
  contextCalls = vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
  errors = []
  const originalError = console.error.bind(console)
  vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args); originalError(...args) })
  const doc = blank('Canvas without small overview'), visible = node('rectangle', 100, 100, 200, 150), distant = node('rectangle', 5000, 3000, 300, 200)
  visibleId = visible.id; distantId = distant.id
  doc.nodes = { [visible.id]: visible, [distant.id]: distant }; doc.pages[0].children = [visible.id, distant.id]
  editor = new Editor(doc); editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false })
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount())
  editor.dispose(); dom.window.close(); vi.unstubAllGlobals(); vi.restoreAllMocks()
  expect(errors).toEqual([])
})
const host = () => mount.querySelector<HTMLElement>('[data-testid="canvas"]')!
async function render() {
  await act(async () => { root.render(<Canvas editor={editor} />); for (let i = 0; i < 6; i++) await Promise.resolve() })
  expect(host()).not.toBeNull()
  expect(mount.querySelector('[data-testid="surface-boundary"]')).not.toBeNull()
}
async function frame() {
  await act(async () => { for (const [id, fn] of [...frames]) { frames.delete(id); fn(performance.now()) } })
}
function pointer(type: string, x: number, y: number, target: Element = host(), button = 0) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button })
  Object.defineProperties(event, { pointerId: { value: 7 }, isPrimary: { value: true }, pointerType: { value: 'mouse' } })
  target.dispatchEvent(event)
}
function absent() {
  expect(contextCalls).not.toHaveBeenCalled()
  expect(mount.querySelector('.canvas-minimap,[data-testid="canvas-minimap"],[aria-label="画布缩略导航"]')).toBeNull()
  expect([...mount.querySelectorAll('label')].some(label => label.textContent?.includes('显示缩略导航'))).toBe(false)
  expect(mount.querySelector('canvas')).toBeNull()
}
function unchanged(document: typeof editor.state.doc) {
  expect(editor.state.doc).toBe(document)
  expect(editor.canUndo).toBe(false)
  expect(editor.canRedo).toBe(false)
}

test('offscreen content mounts no minimap, allocates no overview canvas, and does no 2D work across camera/selection/document updates', async () => {
  await render(); absent()
  expect(editor.state).not.toHaveProperty('minimap')
  const before = editor.state.doc
  // The far-away root would force the old minimap to mount. Exercise each
  // changing dependency of its old effect: view, selection, and entries/document.
  // Initial size is the production 1000×800 canvas state.
  for (let i = 0; i < 12; i++) {
    await act(async () => host().dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 7, deltaY: 3 })))
    await frame()
    await act(async () => editor.select(i % 2 ? [visibleId] : [distantId]))
    absent()
  }
  expect(editor.state.view).toEqual({ x: -84, y: -36, zoom: 1 })
  unchanged(before)
  await act(async () => editor.change('Resize distant root', doc => { doc.nodes[distantId].width += 25 }))
  expect(editor.state.doc.nodes[distantId].width).toBe(325); absent()
  await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before); absent()
  await act(async () => editor.redo()); expect(editor.state.doc.nodes[distantId].width).toBe(325); absent()
})

test('real Canvas pointer selection, hand pan, wheel zoom, controls, and scrollbar navigation remain operational without a minimap', async () => {
  await render(); const before = editor.state.doc
  await act(async () => { pointer('pointerdown', 200, 175); pointer('pointerup', 200, 175) })
  expect(editor.state.selection).toEqual([visibleId])
  expect(mount.querySelector('[data-testid="canvas-selection-outline"]')).not.toBeNull()
  unchanged(before); absent()

  await act(async () => editor.set({ tool: 'hand' }))
  await act(async () => pointer('pointerdown', 400, 300))
  await act(async () => pointer('pointermove', 430, 320))
  // Release-only newer sample must survive coalescing.
  await act(async () => pointer('pointerup', 460, 335))
  expect(editor.state.view).toEqual({ x: 60, y: 35, zoom: 1 })
  await frame(); expect(editor.state.view).toEqual({ x: 60, y: 35, zoom: 1 })
  unchanged(before); absent()

  const anchor = { x: 320, y: 240 }, world = screenToWorld(editor.state.view, anchor)
  await act(async () => host().dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
    clientX: anchor.x, clientY: anchor.y, deltaY: -20, ctrlKey: true })))
  await frame()
  expect(editor.state.view.zoom).toBeGreaterThan(1)
  const after = screenToWorld(editor.state.view, anchor)
  expect(after.x).toBeCloseTo(world.x, 10); expect(after.y).toBeCloseTo(world.y, 10)
  const zoomed = { ...editor.state.view }
  const controls = mount.querySelector<HTMLElement>('.canvas-controls')!
  expect(controls).not.toBeNull()
  await act(async () => controls.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 50 })))
  await frame(); expect(editor.state.view).toEqual(zoomed)
  await act(async () => mount.querySelector<HTMLButtonElement>('button[title="放大"]')!.click())
  expect(editor.state.view.zoom).toBe(2)
  const beforeScroll = editor.state.view.x
  const scrollbar = mount.querySelector<HTMLElement>('[role="scrollbar"][aria-orientation="horizontal"]')!
  await act(async () => scrollbar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })))
  expect(editor.state.view.x).toBe(beforeScroll - 40)
  expect(JSON.parse(mount.querySelector('[data-testid="surface-boundary"]')!.getAttribute('data-view')!)).toEqual(editor.state.view)
  expect(editor.state.selection).toEqual([visibleId])
  unchanged(before); absent()
})

// Old in-memory state objects may contain removed keys. They must not restore
// either a background overview worker/canvas or the obsolete setting.
test('a legacy minimap=true state cannot resurrect overview work or the removed checkbox', async () => {
  await render(); absent()
  await act(async () => editor.set({ minimap: true } as unknown as Partial<typeof editor.state>))
  expect((editor.state as unknown as { minimap: boolean }).minimap).toBe(true)
  absent()
  for (let i = 0; i < 4; i++) {
    await act(async () => editor.set({ view: { x: i * 25, y: -i * 10, zoom: 1 + i / 4 }, selection: [i % 2 ? visibleId : distantId] }))
    absent()
  }
  expect(mount.querySelector('select[aria-label="像素预览"]')).not.toBeNull()
  expect(mount.querySelector('input[aria-label="棋盘格背景"]')).not.toBeNull()
  expect(mount.querySelectorAll('[role="scrollbar"]')).toHaveLength(2)
})
