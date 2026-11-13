// Mounted Canvas brush chrome for issue #205. jsdom + Editor/WASM.
// The GPU surface is replaced; this is not an Electron, Metal, or pixel result.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { blank, node } from './model'
import { interfacePreference, type UiMode } from './interface-preference'
import { dispatchEditorCommand } from './editor-commands'
import type { FreehandTool } from './freehand'

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

let dom: JSDOM, root: Root, editor: Editor, errors: unknown[][]
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLCanvasElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'localStorage'])
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name as 'document'])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('devicePixelRatio', 1)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => 1000 },
    clientHeight: { configurable: true, get: () => 800 },
  })
  vi.spyOn(dom.window.HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0, toJSON() {} })
  dom.window.HTMLElement.prototype.setPointerCapture = () => {}
  dom.window.HTMLElement.prototype.hasPointerCapture = () => false
  dom.window.HTMLElement.prototype.releasePointerCapture = () => {}
  vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  errors = []
  vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args) })
  interfacePreference.reset()
  const shape = node('rectangle', 10, 10, 40, 40)
  shape.name = 'Frame A'
  const doc = blank('未命名设计')
  doc.pages[0].name = '页面 1'
  doc.nodes[shape.id] = shape
  doc.pages[0].children = [shape.id]
  editor = new Editor(doc)
  editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false })
  const mount = document.createElement('div')
  document.body.append(mount)
  root = createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount())
  editor.dispose()
  interfacePreference.reset()
  dom.window.close()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  expect(errors).toEqual([])
})

const englishBrush = {
  width: 'Stroke width', smoothing: 'Smoothing', color: 'Brush color', pressure: 'Pressure',
  help: 'Draw with mouse or stylus · Esc cancels · V selects',
  caption: 'Free canvasDrop images · Double-click to edit vectors · Space to pan',
  surface: 'Design canvas',
}
const chineseBrush = {
  width: '笔宽', smoothing: '平滑', color: '画笔颜色', pressure: '笔压',
  help: '鼠标 / 触控笔绘制 · Esc 取消 · V 选择',
  caption: '自由画布拖入图片 · 双击编辑矢量 · 空格拖动画布',
  surface: '设计画布',
}

function brushSample() {
  const bar = document.querySelector('.pencil-controls')
  const width = bar?.querySelector('input[aria-label="Stroke width"], input[aria-label="笔宽"]') as HTMLInputElement | null
  const smoothing = bar?.querySelector('input[aria-label="Smoothing"], input[aria-label="平滑"]') as HTMLInputElement | null
  const color = bar?.querySelector('input[type="color"]') as HTMLInputElement | null
  const pressure = bar?.querySelector('input[type="checkbox"]') as HTMLInputElement | null
  return {
    width: width?.getAttribute('aria-label') ?? '',
    smoothing: smoothing?.getAttribute('aria-label') ?? '',
    color: color?.getAttribute('aria-label') ?? '',
    pressure: pressure?.getAttribute('aria-label') ?? '',
    help: bar?.querySelector('small')?.textContent ?? '',
    caption: document.querySelector('.canvas-caption')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    surface: document.querySelector('svg.stage')?.getAttribute('aria-label') ?? '',
    widthValue: width?.value ?? '',
    smoothingValue: smoothing?.value ?? '',
    colorValue: color?.value ?? '',
    pressureChecked: pressure?.checked ?? false,
    pressureDisabled: pressure?.disabled ?? true,
    widthInput: width,
    colorInput: color,
  }
}

async function show(uiMode: UiMode, locale: 'en' | 'zh-CN') {
  await act(async () => { interfacePreference.set({ locale, uiMode }) })
}

test('brush controls follow English and Chinese without committing or dropping tool state', async () => {
  const before = editor.state.doc
  await act(async () => { root.render(<Canvas editor={editor} />); for (let i = 0; i < 6; i++) await Promise.resolve() })
  const tools = ['pencil', 'brush', 'marker', 'washi-tape'] as const
  for (const uiMode of ['figma', 'sketch'] as const) {
    for (const tool of tools) {
      await show(uiMode, 'en')
      await act(async () => { await dispatchEditorCommand(editor, `set-tool-${tool}`) })
      expect(editor.state.tool).toBe(tool)
      const english = brushSample()
      expect(english, `${uiMode}/${tool}`).toMatchObject(englishBrush)
      expect(document.querySelector('[aria-label="设计画布编辑器"]')).toBeNull()
      expect(english.pressureDisabled).toBe(tool !== 'brush')
      const color = tool === 'brush' ? '#123456' : '#abcdef'
      await act(async () => {
        editor.set({ [tool]: { ...editor.state[tool], color, width: 3.5, smoothing: 1.25, pressure: tool === 'brush' } })
      })
      const draft = brushSample().widthInput!
      await act(async () => {
        draft.focus()
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(draft, '4px')
        draft.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
      expect(draft.value).toBe('4px')
      expect(editor.state[tool].width).toBe(3.5)
      await show(uiMode, 'zh-CN')
      const chinese = brushSample()
      expect(chinese, `${uiMode}/${tool}`).toMatchObject(chineseBrush)
      expect(chinese.widthValue).toBe('4px')
      expect(editor.state[tool]).toMatchObject({ color, width: 3.5, smoothing: 1.25, pressure: tool === 'brush' })
      expect(document.activeElement).toBe(chinese.widthInput)
      await show(uiMode, 'en')
      expect(brushSample().widthValue).toBe('4px')
      await act(async () => { brushSample().widthInput!.blur() })
      expect(editor.state[tool].width).toBe(4)
      expect(editor.state[tool].color).toBe(color)
      expect(editor.state.doc).toBe(before)
      expect(editor.state.doc.nodes[editor.state.doc.pages[0].children[0]].name).toBe('Frame A')
      expect(editor.state.doc.name).toBe('未命名设计')
      expect(editor.state.doc.pages[0].name).toBe('页面 1')
      expect(editor.canUndo).toBe(false)
    }
  }
  expect(editor.state.tool).toBe('washi-tape' satisfies FreehandTool)
})
