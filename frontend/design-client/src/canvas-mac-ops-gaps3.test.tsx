// Mounted Canvas plus the context menu. Mac desktop gaps3: group hits, Enter,
// empty arrows, Space+drag, and the rectangle menu. Not a GPU or GUI pixel claim.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { CanvasContextMenu } from './CanvasContextMenu'
import { Editor } from './engine'
import { blank, node, type DesignNode } from './model'
import { shortcutPreference } from './shortcut-preference'
import { interfacePreference } from './interface-preference'
import { OPEN_PLUGINS_EVENT } from './plugins/open-plugins'

vi.mock('./kernel/Surface', async () => {
  const { useLayoutEffect } = await import('react')
  return { KernelSurface(props: import('./kernel/Surface').SurfaceProps) {
    useLayoutEffect(() => {
      props.onPresentation?.({ ...props, epoch: props.presentationEpoch!, pixelRatio: 1, managed: false })
    }, [props.document, props.pageId, props.view, props.width, props.height, props.presentationEpoch, props.onPresentation])
    return <div data-testid="surface-boundary" />
  } }
})

let dom: any, root: Root, mount: HTMLDivElement, editor: Editor
let frames: Map<number, FrameRequestCallback>, frameId: number
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLCanvasElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'FocusEvent', 'localStorage'])
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('devicePixelRatio', 1)
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
  localStorage.clear(); shortcutPreference.set('figma-like'); interfacePreference.set({ locale: 'zh-CN' })
  editor = new Editor(blank()); editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false })
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount()); editor.dispose(); interfacePreference.set({ locale: 'zh-CN' }); dom.window.close()
  vi.unstubAllGlobals(); vi.restoreAllMocks()
})
const host = () => mount.querySelector<HTMLElement>('[data-testid="canvas"]')!
async function render(nodes: DesignNode[], roots = nodes.map(n => n.id)) {
  const doc = blank('Mac gaps3'); doc.nodes = Object.fromEntries(nodes.map(n => [n.id, n])); doc.pages[0].children = roots
  editor.load(doc); editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false, tool: 'select' })
  await act(async () => { root.render(<Canvas editor={editor} />); for (let i = 0; i < 8; i++) await Promise.resolve() })
  host().focus(); return editor.state.doc
}
function pointer(type: string, x: number, y: number, options: MouseEventInit = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...options })
  Object.defineProperties(event, { pointerId: { value: 7 }, isPrimary: { value: true }, pointerType: { value: 'mouse' } })
  host().dispatchEvent(event)
}
function key(value: string, options: KeyboardEventInit = {}, type = 'keydown') {
  const event = new KeyboardEvent(type, { key: value, code: value.length === 1 ? `Key${value.toUpperCase()}` : value, bubbles: true, cancelable: true, ...options })
  host().dispatchEvent(event)
}
const labels = () => [...document.querySelectorAll<HTMLButtonElement>('.canvas-context-menu [role="menuitem"]')].map(button =>
  (button.querySelector('.context-label, span')?.textContent || button.textContent || '').trim())

test('a group click stays on the group; Cmd and double-click reach the child; a frame does not', async () => {
  const frame = node('frame', 80, 80, 240, 180), group = node('group', 20, 20, 160, 80)
  const rect = node('rectangle', 10, 10, 30, 30), other = node('ellipse', 60, 10, 28, 28)
  group.children = [rect.id, other.id]; frame.children = [group.id]
  const before = await render([frame, group, rect, other], [frame.id])
  await act(async () => pointer('pointerdown', 120, 120))
  await act(async () => pointer('pointerup', 120, 120))
  expect(editor.state.selection).toEqual([group.id])
  await act(async () => pointer('pointerdown', 120, 120, { ctrlKey: true }))
  await act(async () => pointer('pointerup', 120, 120, { ctrlKey: true }))
  expect(editor.state.selection).toEqual([group.id])
  await act(async () => pointer('pointerdown', 120, 120, { metaKey: true }))
  await act(async () => pointer('pointerup', 120, 120, { metaKey: true }))
  expect(editor.state.selection).toEqual([rect.id])
  await act(async () => { editor.select([group.id]); host().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 120, clientY: 120 })) })
  expect(editor.state.selection).toEqual([rect.id])
  expect(editor.state.tool).toBe('select')
  await act(async () => { editor.select([]); host().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 120, clientY: 120 })) })
  expect(editor.state.selection).toEqual([rect.id])
  expect(editor.state.doc).toBe(before)
  expect(editor.canUndo).toBe(false)
})

test('a frame still selects child paint and its empty interior', async () => {
  const board = node('frame', 80, 80, 220, 160), child = node('rectangle', 20, 20, 40, 30)
  board.children = [child.id]
  const before = await render([board, child], [board.id])
  await act(async () => pointer('pointerdown', 110, 110))
  await act(async () => pointer('pointerup', 110, 110))
  expect(editor.state.selection).toEqual([child.id])
  await act(async () => pointer('pointerdown', 90, 90))
  await act(async () => pointer('pointerup', 90, 90))
  expect(editor.state.selection).toEqual([board.id])
  expect(editor.state.doc).toBe(before)
})

test('Enter selects both children of a group and Shift+Enter returns to the group', async () => {
  const group = node('group', 40, 40, 200, 80), a = node('rectangle', 10, 10, 40, 40), b = node('ellipse', 80, 10, 36, 36)
  group.children = [a.id, b.id]
  const before = await render([group, a, b], [group.id])
  await act(async () => editor.select([group.id]))
  await act(async () => key('Enter'))
  expect(new Set(editor.state.selection)).toEqual(new Set([a.id, b.id]))
  await act(async () => key('Enter', { shiftKey: true }))
  expect(editor.state.selection).toEqual([group.id])
  await act(async () => editor.select([a.id, b.id]))
  await act(async () => key('Enter', { shiftKey: true }))
  expect(editor.state.selection).toEqual([group.id])
  expect(editor.state.doc).toBe(before)
  expect(editor.canUndo).toBe(false)
})

test('empty-selection Arrow and Shift+Arrow leave the camera where it is', async () => {
  await render([])
  await act(async () => editor.set({ selection: [], view: { x: 12, y: -4, zoom: 2 } }))
  const view = { ...editor.state.view }
  await act(async () => {
    key('ArrowRight'); key('ArrowLeft'); key('ArrowUp'); key('ArrowDown', { shiftKey: true })
    key('ArrowRight', { shiftKey: true }); key('ArrowDown', { shiftKey: true })
  })
  expect(editor.state.view).toEqual(view)
  expect(editor.state.selection).toEqual([])
  expect(editor.canUndo).toBe(false)
})

test('Space held while an object is selected pans and does not move it', async () => {
  const rect = node('rectangle', 100, 100, 40, 40)
  const before = await render([rect])
  await act(async () => editor.select([rect.id]))
  await act(async () => key(' ', { code: 'Space' }))
  expect(host().className).toContain('canvas-space-held')
  await act(async () => pointer('pointerdown', 120, 120))
  await act(async () => pointer('pointermove', 180, 150))
  await act(async () => pointer('pointerup', 180, 150))
  await act(async () => key(' ', { code: 'Space' }, 'keyup'))
  expect(editor.state.doc.nodes[rect.id]).toEqual(before.nodes[rect.id])
  expect(editor.state.view.x).toBe(60)
  expect(editor.state.view.y).toBe(30)
  expect(editor.canUndo).toBe(false)
})

test('the selected rectangle menu follows the Mac order and opens plugins without Design API', async () => {
  const rect = node('rectangle', 20, 30, 80, 50)
  const doc = blank('menu'); doc.nodes[rect.id] = rect; doc.pages[0].children = [rect.id]
  editor.load(doc); editor.select([rect.id])
  const grant = '11111111-1111-4111-8111-111111111111'
  Object.defineProperty(window, 'coreDesktop', { configurable: true, value: {
    version: 1,
    renderPolicy: { cpuOnly: true },
    plugins: { list: async () => ({ status: 'ok' as const, plugins: [{ grant, manifestText: '{}', displayName: 'Layout kit', id: 'local.kit', name: 'Layout kit' }] }) },
  } })
  const opened: unknown[] = []
  const hear = (event: Event) => opened.push((event as CustomEvent).detail)
  window.addEventListener(OPEN_PLUGINS_EVENT, hear)
  await act(async () => root.render(<CanvasContextMenu editor={editor} x={40} y={40} worldPoint={{ x: 30, y: 40 }} candidates={[{ id: rect.id, name: rect.name, locked: false }]} onClose={() => {}} />))
  expect(labels()).toEqual([
    '复制', '粘贴到此处', '粘贴替换', '复制／粘贴为', '移动到页面',
    '置于顶层', '置于底层', '编组', '创建选区画板', '展平', '轮廓化描边', '用作蒙版',
    '添加自动布局', '创建组件', '插件', '显示/隐藏', '锁定/解锁', '水平翻转', '垂直翻转', '选择图层',
  ])
  const outline = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.getAttribute('aria-label') === '轮廓化描边')
  expect(outline?.disabled).toBe(true)
  expect(document.body.textContent).not.toContain('设计 API')
  expect(document.body.textContent).not.toContain('Design API')
  expect(document.body.textContent).not.toContain('Figma Make')
  expect(document.body.textContent).not.toContain('Widgets')
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[data-plugin-picker]')!.click()
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
  expect(labels()).toContain('打开插件…')
  expect(labels()).toContain('Layout kit')
  await act(async () => {
    [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent?.includes('Layout kit'))!.click()
    await Promise.resolve()
  })
  expect(opened.at(-1)).toEqual({ grant })
  window.removeEventListener(OPEN_PLUGINS_EVENT, hear)
})
