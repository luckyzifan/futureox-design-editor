// Sketch layout Insert menu and the P shortcut share one pencil tool.
// jsdom drives the real toolbar, Canvas, Editor and WASM freehand path.
// It does not open macOS Sketch or an Electron window.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { import_sketch_json } from './generated/design-kernel/design_kernel'
import { blank, type DesignDocument, type DesignNode } from './model'
import { SketchWindowTools } from './SketchWindowTools'
import { applyInterfaceLayout } from './interface-layout'
import { interfacePreference } from './interface-preference'
import { shortcutPreference } from './shortcut-preference'

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
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLCanvasElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'localStorage'])
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('devicePixelRatio', 1)
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, character => `\\${character}`) })
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++frameId, fn); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
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
  vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args))
  localStorage.clear()
  applyInterfaceLayout('sketch')
  editor = new Editor(blank('Insert pencil'))
  editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false, grid: false })
  mount = document.createElement('div')
  document.body.append(mount)
  root = createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount())
  editor.dispose()
  interfacePreference.reset()
  shortcutPreference.set('figma-like')
  dom.window.close()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  expect(errors).toEqual([])
})

const host = () => mount.querySelector<HTMLElement>('[data-testid="canvas"]')!
async function render() {
  const noop = () => {}
  await act(async () => {
    root.render(<>
      <SketchWindowTools editor={editor} disabled={false} onPresets={noop} onImages={noop} onSystems={noop} onShapeBuilder={noop} onSection={noop} onEditText={noop} />
      <Canvas editor={editor} />
    </>)
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })
  host().focus()
}
function pointer(type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })
  Object.defineProperties(event, { pointerId: { value: 7 }, isPrimary: { value: true }, pointerType: { value: 'mouse' } })
  host().dispatchEvent(event)
}
async function key(value: string) {
  const event = new KeyboardEvent('keydown', {
    key: value,
    code: value.length === 1 ? `Key${value.toUpperCase()}` : value,
    bubbles: true,
    cancelable: true,
  })
  await act(async () => { window.dispatchEvent(event) })
  return event
}
async function openInsert() {
  const trigger = mount.querySelector<HTMLButtonElement>('button[aria-label="置入"],button[aria-label="Insert"]')
  expect(trigger).not.toBeNull()
  await act(async () => trigger!.click())
  const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="置入"],[role="menu"][aria-label="Insert"]')
  expect(menu).not.toBeNull()
  return menu!
}
function itemLabels(menu: ParentNode) {
  return [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"],[role="menuitem"]')].map(item => item.textContent)
}
async function chooseInsert(label: string) {
  const menu = await openInsert()
  const item = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(entry => entry.textContent === label)
  expect(item, itemLabels(menu).join(' | ')).toBeDefined()
  await act(async () => item!.click())
  return item!
}
async function stroke(points: readonly (readonly [number, number])[]) {
  await act(async () => pointer('pointerdown', points[0][0], points[0][1]))
  for (const [x, y] of points.slice(1, -1)) await act(async () => pointer('pointermove', x, y))
  await act(async () => pointer('pointerup', points.at(-1)![0], points.at(-1)![1]))
}
function paths() {
  return editor.state.doc.pages[0].children.map(id => editor.state.doc.nodes[id])
}
function expectPencilPath(node: DesignNode, width: number, color: string) {
  expect(node.kind).toBe('vector')
  expect(node.name).toBe('铅笔路径')
  expect(node.network?.vertices.length).toBeGreaterThan(1)
  expect(node.network?.edges.length).toBeGreaterThan(0)
  expect(node.strokes[0].width).toBe(width)
  expect(node.strokes[0].paint.color).toBe(color)
  expect(node.strokes[0].widthProfile).toBeUndefined()
}

test('Sketch Insert pencil starts the same tool and stroke settings as P, then keeps two strokes and undo', async () => {
  const settings = { width: 3.5, color: '#112233', smoothing: 1.1, pressure: false }
  editor.set({ pencil: settings })
  const before = editor.state.doc
  await render()

  await act(async () => mount.querySelector<HTMLButtonElement>('button[aria-label="工具"]')!.click())
  const toolsMenu = document.querySelector<HTMLElement>('[role="menu"][aria-label="工具"]')
  expect(toolsMenu).not.toBeNull()
  expect(itemLabels(toolsMenu!)).toContain('铅笔')
  await act(async () => mount.querySelector<HTMLButtonElement>('button[aria-label="工具"]')!.click())

  const chinese = itemLabels(await openInsert())
  expect(chinese).toEqual([
    '画框', '图形', '分区', '切片', '矩形', '椭圆', '直线', '箭头', '多边形', '星形', '钢笔', '铅笔', '文本',
    '图片…', '设备与尺寸预设…',
  ])
  const pencil = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(entry => entry.textContent === '铅笔')!
  expect(pencil.getAttribute('aria-checked')).toBe('false')
  await act(async () => pencil.click())
  expect(editor.state.tool).toBe('pencil')
  expect(editor.state.pencil).toEqual(settings)
  expect(editor.state.doc).toBe(before)
  expect(editor.canUndo).toBe(false)
  const width = document.querySelector<HTMLInputElement>('.pencil-controls [aria-label="笔宽"]')
  const color = document.querySelector<HTMLInputElement>('.pencil-controls [aria-label="画笔颜色"]')
  expect(width?.getAttribute('aria-valuenow')).toBe('3.5')
  expect(color?.value).toBe('#112233')
  await act(async () => {
    width!.focus()
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(width, '6')
    width!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    width!.blur()
  })
  expect(editor.state.pencil).toEqual({ ...settings, width: 6 })

  await key('Escape')
  expect(editor.state.tool).toBe('select')
  expect(editor.state.pencil.width).toBe(6)
  expect(editor.state.doc).toBe(before)
  await key('p')
  expect(editor.state.tool).toBe('pencil')
  expect(editor.state.pencil).toEqual({ ...settings, width: 6 })
  expect(document.querySelector<HTMLInputElement>('.pencil-controls [aria-label="笔宽"]')?.getAttribute('aria-valuenow')).toBe('6')

  await key('Escape')
  await chooseInsert('铅笔')
  expect(editor.state.tool).toBe('pencil')
  expect(editor.state.pencil).toEqual({ ...settings, width: 6 })

  await stroke([[40, 50], [70, 80], [110, 60], [150, 90]])
  expect(editor.state.tool).toBe('pencil')
  expect(paths()).toHaveLength(1)
  await stroke([[200, 40], [240, 70], [280, 50], [320, 100]])
  expect(editor.state.tool).toBe('pencil')
  const drawn = paths()
  expect(drawn).toHaveLength(2)
  expect(new Set(drawn.map(node => node.id)).size).toBe(2)
  for (const node of drawn) expectPencilPath(node, 6, '#112233')
  const withPaths = editor.state.doc

  await key('Escape')
  expect(editor.state.tool).toBe('select')
  expect(paths().map(node => node.id)).toEqual(drawn.map(node => node.id))
  expect(editor.state.pencil).toEqual({ ...settings, width: 6 })
  await act(async () => editor.undo())
  expect(paths().map(node => node.id)).toEqual([drawn[0].id])
  expectPencilPath(paths()[0], 6, '#112233')
  expect(editor.state.tool).toBe('select')
  await act(async () => editor.undo())
  expect(editor.state.doc).toEqual(before)
  expect(editor.canUndo).toBe(false)
  await act(async () => editor.redo())
  await act(async () => editor.redo())
  expect(editor.state.doc).toEqual(withPaths)
  expect(editor.state.tool).toBe('select')

  await key('p')
  expect(editor.state.tool).toBe('pencil')
  expect(editor.state.pencil).toEqual({ ...settings, width: 6 })
  const checked = await openInsert()
  expect(checked.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')?.textContent).toBe('铅笔')

  await act(async () => interfacePreference.set({ locale: 'en' }))
  const englishMenu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Insert"]')
  expect(englishMenu).not.toBeNull()
  const english = itemLabels(englishMenu!)
  expect(english).toEqual([
    'Frame', 'Graphic', 'Section', 'Slice', 'Rectangle', 'Ellipse', 'Line', 'Arrow', 'Polygon', 'Star', 'Pen', 'Pencil', 'Text',
    'Image…', 'Device and size presets…',
  ])
  const pencilEn = [...englishMenu!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(entry => entry.textContent === 'Pencil')!
  await act(async () => pencilEn.click())
  expect(editor.state.tool).toBe('pencil')
  expect(editor.state.pencil).toEqual({ ...settings, width: 6 })
  expect(document.querySelector<HTMLInputElement>('.pencil-controls [aria-label="Stroke width"]')?.getAttribute('aria-valuenow')).toBe('6')
})

test('117.sketch Insert pencil matches P, draws two paths, and undo restores the opened file', async () => {
  const fixture = new URL('../../../testing/fixtures/user-regression-20261109/117.sketch', import.meta.url)
  const bytes = readFileSync(fixture)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('d494693eadf269e7fa29e4cc56e893f5890c02f4d96f4561065c851818a85d70')
  const imported = JSON.parse(import_sketch_json(bytes)) as { document: DesignDocument }
  expect(imported.document.nodes && Object.keys(imported.document.nodes).length).toBeGreaterThan(100)
  expect(editor.load(imported.document)).not.toBe(false)
  const page = editor.state.page
  const before = editor.state.doc
  const beforeIds = [...before.pages.find(entry => entry.id === page)!.children]
  const settings = { ...editor.state.pencil }
  await render()
  await chooseInsert('铅笔')
  expect(editor.state.tool).toBe('pencil')
  expect(editor.state.pencil).toEqual(settings)
  expect(editor.state.doc).toBe(before)
  await key('Escape')
  expect(editor.state.tool).toBe('select')
  await key('p')
  expect(editor.state.tool).toBe('pencil')
  expect(editor.state.pencil).toEqual(settings)
  await stroke([[80, 90], [120, 130], [160, 100], [210, 150]])
  expect(editor.state.tool).toBe('pencil')
  await stroke([[260, 80], [300, 140], [360, 110], [420, 170]])
  const children = editor.state.doc.pages.find(entry => entry.id === page)!.children
  const added = children.filter(id => !beforeIds.includes(id)).map(id => editor.state.doc.nodes[id])
  expect(added).toHaveLength(2)
  expect(new Set(added.map(node => node.id)).size).toBe(2)
  for (const node of added) expectPencilPath(node, settings.width, settings.color)
  for (const id of beforeIds) expect(editor.state.doc.nodes[id]).toEqual(before.nodes[id])
  const withPaths = editor.state.doc
  await key('Escape')
  expect(editor.state.tool).toBe('select')
  expect(editor.state.doc).toBe(withPaths)
  await act(async () => editor.undo())
  await act(async () => editor.undo())
  expect(editor.state.doc).toEqual(before)
  expect(editor.canUndo).toBe(false)
})
