// Production Canvas, its real children/events, and Editor/WASM in React/jsdom.
// Only the rendering-device boundary is replaced: no browser/GPU/pixel claim.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from '../../frontend/design-client/src/Canvas'
import { Editor } from '../../frontend/design-client/src/engine'
import { blank, node } from '../../frontend/design-client/src/model'
import { shortcutPreference } from '../../frontend/design-client/src/shortcut-preference'
import { screenToWorld } from '../../frontend/design-client/src/canvas-camera'

// Present the actual Canvas camera/document back through its production
// presentation callback. No Canvas, control, geometry, or event handler is mocked.
vi.mock('../../frontend/design-client/src/kernel/Surface', async () => {
  const { useLayoutEffect } = await import('react')
  return {
    KernelSurface(props: import('../../frontend/design-client/src/kernel/Surface').SurfaceProps) {
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
  act(() => shortcutPreference.set('figma-like')); editor.dispose(); dom.window.close(); vi.unstubAllGlobals(); vi.restoreAllMocks()
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


function key(value: string, options: KeyboardEventInit = {}, target: EventTarget = host()) {
  const event = new KeyboardEvent('keydown', { key: value, code: value, bubbles: true, cancelable: true, ...options })
  target.dispatchEvent(event); return event
}
for (const platform of ['MacIntel', 'Win32']) test(`actual Canvas ${platform} routes Sketch dimension repeats and isolates profile/focus/IME`, async () => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: platform })
  const mod = platform === 'MacIntel' ? { metaKey: true } : { ctrlKey: true }
  act(() => shortcutPreference.set('sketch-like')); editor.select([visibleId]); await render(); host().focus()
  const before = editor.state.doc, transform = before.nodes[visibleId].transform
  for (const repeat of [false, true, true]) await act(async () => { key('ArrowRight', { ...mod, repeat }) })
  expect(editor.state.doc.nodes[visibleId].width).toBe(203)
  await act(async () => { key('ArrowDown', { ...mod, shiftKey: true }) })
  expect(editor.state.doc.nodes[visibleId].height).toBe(160)
  expect(editor.state.doc.nodes[visibleId].transform).toEqual(transform)
  expect(editor.state.doc.nodes[distantId]).toBe(before.nodes[distantId]); expect(editor.state.selection).toEqual([visibleId])
  const changed = editor.state.doc
  await act(async () => { for (let i=0;i<4;i++) editor.undo() }); expect(editor.state.doc).toEqual(before)
  await act(async () => { for (let i=0;i<4;i++) editor.redo() }); expect(editor.state.doc).toEqual(changed)
  const same = editor.state.doc
  act(() => shortcutPreference.set('figma-like'))
  await act(async () => { key('ArrowRight', mod) }); expect(editor.state.doc).toBe(same)
  act(() => shortcutPreference.set('sketch-like'))
  await act(async () => { key('ArrowRight', { ...mod, isComposing: true }); key('ArrowRight', { ...mod, altKey: true }) })
  expect(editor.state.doc).toBe(same)
  const input=document.createElement('input'); document.body.append(input); input.focus()
  await act(async () => { key('ArrowRight', mod, input) }); expect(editor.state.doc).toBe(same); input.remove(); host().focus()
  await act(async () => { editor.begin('Active gesture'); editor.preview({ [visibleId]: { width: 400 } }) })
  const preview=editor.state.doc
  await act(async () => { key('ArrowRight', mod) }); expect(editor.state.doc).toBe(preview)
  await act(async () => { key('Escape') }); expect(editor.state.doc).toEqual(changed)
  absent()
})
test('actual Canvas uses current Select All profile, Windows shifted ordering, and reversible remove-layout', async () => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' })
  const doc=blank('Nested actual key routes'), frame=node('frame',10,20,300,200), a=node('rectangle',10,20,30,40), b=node('rectangle',80,20,40,50), hidden=node('rectangle',150,20,10,10), outside=node('rectangle',500,20,30,40)
  hidden.visible=false; frame.children=[a.id,b.id,hidden.id]
  for(const n of [frame,a,b,hidden,outside])doc.nodes[n.id]=n
  doc.pages[0].children=[frame.id,outside.id]; editor.dispose(); editor=new Editor(doc); editor.select([a.id])
  act(() => shortcutPreference.set('sketch-like')); await render(); host().focus(); const before=editor.state.doc
  await act(async () => { key('a',{ctrlKey:true,code:'KeyA'}) }); expect(editor.state.selection).toEqual([a.id,b.id])
  act(() => shortcutPreference.set('figma-like'))
  await act(async () => { key('a',{ctrlKey:true,code:'KeyA'}) }); expect(editor.state.selection).toEqual([frame.id,outside.id])
  expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
  await act(async () => editor.select([frame.id]))
  await act(async () => { key('}',{ctrlKey:true,shiftKey:true,code:'BracketRight'}) }); expect(editor.state.doc.pages[0].children).toEqual([outside.id,frame.id])
  await act(async () => { key('{',{ctrlKey:true,shiftKey:true,code:'BracketLeft'}) }); expect(editor.state.doc.pages[0].children).toEqual([frame.id,outside.id])
  await act(async () => { editor.undo(); editor.undo() }); expect(editor.state.doc).toEqual(before)
  await act(async () => editor.autoLayout()); const layoutDoc=editor.state.doc; expect(layoutDoc.nodes[frame.id].layout).toBeDefined()
  await act(async () => { key('A',{altKey:true,shiftKey:true,code:'KeyA'}) }); expect(editor.state.doc.nodes[frame.id].layout).toBeUndefined()
  const removed=editor.state.doc
  await act(async () => editor.undo()); expect(editor.state.doc).toEqual(layoutDoc)
  await act(async () => editor.redo()); expect(editor.state.doc).toEqual(removed); absent()
})
