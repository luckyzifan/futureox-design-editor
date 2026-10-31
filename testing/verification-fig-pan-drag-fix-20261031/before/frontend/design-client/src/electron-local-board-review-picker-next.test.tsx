// Actual mounted Canvas/event propagation + Editor/WASM. Only the render-device
// boundary is replaced; no native browser, GPU, or pixel-quality claim.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { blank, node, uid, type DesignNode, type DesignDocument } from './model'
import { shortcutPreference } from './shortcut-preference'
import { worldMatrix, apply } from './geometry'
import { dispatchEditorCommand } from './editor-commands'
import { ReviewsPanel } from './ReviewsPanel'
import { readFileSync } from 'node:fs'

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
    return <canvas data-frame-visible="true" width={1000} height={800} style={{ opacity: 1 }} />
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
  // Bounded published-pixel transport double, not a real GPU/browser frame.
  vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return this.dataset.frameVisible === 'true' ? { getImageData: (x: number, y: number, width: number, height: number) => {
      expect(x).toBeGreaterThanOrEqual(0); expect(y).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(1000); expect(y).toBeLessThan(800)
      expect([width, height]).toEqual([1, 1]); return { data: new Uint8ClampedArray([18, 52, 86, 255]) }
    } } : null
  })
  vi.stubGlobal('getComputedStyle', () => ({ display: 'block', visibility: 'visible', opacity: '1', backgroundColor: 'rgb(255, 255, 255)' }))
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
async function render(nodes: DesignNode[], roots = nodes.map(n => n.id), otherRoots: string[] = [], fonts?: DesignDocument['fonts']) {
  const doc = blank('Local board workflows'); if (fonts) { doc.schemaVersion = 4; doc.fonts = fonts }; doc.nodes = Object.fromEntries(nodes.map(n => [n.id, n])); doc.pages[0].children = roots
  if (otherRoots.length) doc.pages.push({ ...doc.pages[0], id: uid(), name: 'Other page', children: otherRoots })
  editor.load(doc); editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false })
  await act(async () => { root.render(<><Canvas editor={editor} /><ReviewsPanel editor={editor} /></>); for (let i = 0; i < 6; i++) await Promise.resolve() })
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
function unchanged(doc: typeof editor.state.doc) {
  expect(editor.state.doc).toBe(doc); expect(editor.canUndo).toBe(false); expect(editor.canRedo).toBe(false)
}
// Four local authored objects, not remote publishing or execution.
for (const tool of ['sticky', 'table', 'code-block', 'sites-responsive-set'] as const) test(`set-tool-${tool}: dispatcher and Canvas author content/resources, cancel and one undo`, async () => {
  const fonts = tool === 'code-block' ? { mono: { family: 'DejaVu Sans Mono', data: readFileSync(process.env.FUTUREOX_MONO_FONT_FILE || '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf').toString('base64') } } : undefined
  await render([], [], [], fonts); const before = editor.state.doc
  await act(async () => { await dispatchEditorCommand(editor, `set-tool-${tool}`) })
  expect(editor.state.tool).toBe(tool); expect(editor.state.busy).toBe(false)
  await act(async () => pointer('pointerdown', 100, 100))
  await act(async () => pointer('pointermove', 180, 160))
  await act(async () => pointer('pointercancel', 180, 160)); unchanged(before)
  await act(async () => pointer('pointerdown', 100, 100))
  await act(async () => pointer('pointerup', 340, 280))
  const rootId = editor.state.selection[0], rootNode = editor.state.doc.nodes[rootId]
  expect(rootNode.board?.kind).toBe(tool); expect(editor.state.doc.pages[0].children).toEqual([rootId])
  expect(rootNode.transform.slice(4)).toEqual([100, 100]); expect(editor.state.tool).toBe('select')
  const children = rootNode.children.map(id => editor.state.doc.nodes[id])
  if (tool === 'table') {
    if (!rootNode.layout) throw new Error('Table must author a grid layout')
    expect(rootNode.board).toEqual({ kind: 'table', rows: 3, columns: 3 }); expect(children).toHaveLength(9)
    expect(rootNode.layout.mode).toBe('grid'); expect(rootNode.layout.columns).toBe(3)
    for (const cell of children) { expect(cell.kind).toBe('frame'); expect(cell.width).toBeCloseTo(80); expect(cell.height).toBeCloseTo(60); expect(cell.children).toHaveLength(1); expect(editor.state.doc.nodes[cell.children[0]].text).toBe('') }
  } else if (tool === 'sites-responsive-set') {
    if (!rootNode.layout) throw new Error('Responsive set must author a horizontal layout')
    expect(children.map(n => n.width)).toEqual([1280, 768, 390]); expect(children.map(n => n.height)).toEqual([800, 800, 800])
    expect(children.map(n => n.name)).toEqual(['桌面', '平板', '手机']); expect(rootNode.layout.mode).toBe('horizontal')
    expect(rootNode.width).toBe(2534); expect(rootNode.height).toBe(800)
  } else {
    expect(children).toHaveLength(1); expect(children[0].kind).toBe('text')
    expect(children[0].text).toBe(tool === 'sticky' ? '写下想法' : '// 在这里编写代码')
    expect(rootNode.fills[0].color).toBe(tool === 'sticky' ? '#fff3a3' : '#24292f')
    if (tool === 'code-block') { expect(rootNode.board?.language).toBe('javascript'); expect(children[0].textStyle?.fontId).toBe('mono'); expect(editor.state.doc.fonts?.mono).toEqual(fonts!.mono); expect(children[0].textStyle?.wrap).toBe(false) }
  }
  const after = editor.state.doc; await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false)
  await act(async () => editor.redo()); expect(editor.state.doc).toEqual(after)
})
for (const tool of ['comments', 'annotate'] as const) test(`set-tool-${tool}: actual anchor and ReviewsPanel submit/cancel persist only local authored review`, async () => {
  const n = node('rectangle', 100, 100, 200, 160); await render([n]); const before = editor.state.doc
  await act(async () => { await dispatchEditorCommand(editor, `set-tool-${tool}`) })
  await act(async () => pointer('pointerdown', 140, 150)); await act(async () => pointer('pointerup', 140, 150))
  expect(editor.state.commentDraft?.nodeId).toBe(n.id)
  await act(async () => { (Array.from(mount.querySelectorAll('button')).find(b => b.textContent === '取消') as HTMLButtonElement).click() })
  unchanged(before); expect(editor.state.commentDraft).toBeUndefined()
  host().focus()
  await act(async () => pointer('pointerdown', 140, 150)); await act(async () => pointer('pointerup', 140, 150))
  const input = mount.querySelector<HTMLTextAreaElement>('textarea[aria-label="评论正文"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '本地内容 only, no cloud')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const form = input.closest('form')!
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(editor.state.doc.reviews).toHaveLength(1)
  const review = editor.state.doc.reviews![0]
  expect(review.kind).toBe(tool === 'comments' ? 'comment' : 'annotation'); expect(review.nodeId).toBe(n.id)
  expect(review.pageId).toBe(editor.state.page); expect(review.position).toEqual({ x: 40, y: 50 })
  expect(apply(worldMatrix(editor.state.doc, n.id), review.position)).toEqual({ x: 140, y: 150 })
  expect(review.messages).toHaveLength(1); expect(review.messages[0].text).toBe('本地内容 only, no cloud'); expect(review.messages[0].author).toBe('本机用户')
  expect(editor.state.doc.nodes).toEqual(before.nodes); expect(editor.state.commentDraft).toBeUndefined()
  const after = editor.state.doc; await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false)
  await act(async () => editor.redo()); expect(editor.state.doc).toEqual(after)
})
test('set-tool-eyedropper: actual Canvas bounded published-pixel read applies color, cancels, and preserves history', async () => {
  const n = node('rectangle', 100, 100, 200, 160); await render([n])
  await act(async () => editor.select([n.id])); const before = editor.state.doc
  await act(async () => { await dispatchEditorCommand(editor, 'set-tool-eyedropper') })
  await act(async () => key('Escape')); unchanged(before)
  await act(async () => { await dispatchEditorCommand(editor, 'set-tool-eyedropper') })
  await act(async () => { pointer('pointerdown', 150, 150); for (let i = 0; i < 8; i++) await Promise.resolve() })
  expect(editor.state.doc.nodes[n.id].fills[0].color).toBe('#123456')
  expect(editor.state.doc.nodes[n.id].transform).toEqual(before.nodes[n.id].transform)
  const after = editor.state.doc; await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false)
  await act(async () => editor.redo()); expect(editor.state.doc).toEqual(after)
})
