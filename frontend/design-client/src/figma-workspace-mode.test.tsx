// Figma Design / Draw is toolbar chrome. jsdom + Editor, not a Mac or Figma GUI result.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from './App'
import { Editor } from './engine'
import { resetFigmaWorkspaceMode } from './figma-workspace-mode'
import { interfacePreference } from './interface-preference'
import { canvasText } from './canvas-interface-messages'
import { layerPreviewSpec } from './layer-preview'
import { node, paint } from './model'
import { shortcutPreference } from './shortcut-preference'
import * as localStore from './local-store'
import * as startupPreview from './startup-preview'

vi.mock('./kernel/Surface', async () => {
  const { useLayoutEffect } = await import('react')
  return { KernelSurface(props: import('./kernel/Surface').SurfaceProps) {
    useLayoutEffect(() => { props.onPresentation?.({ ...props, epoch: props.presentationEpoch!, pixelRatio: 1, managed: false }) }, [props.document, props.pageId, props.view, props.width, props.height, props.presentationEpoch, props.onPresentation])
    return <div data-testid="surface-boundary" />
  } }
})

let dom: JSDOM, root: Root, editor: Editor | undefined, errors: unknown[][]
beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLCanvasElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'localStorage'] as const)
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('devicePixelRatio', 1)
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, character => `\\${character}`) })
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  dom.window.HTMLElement.prototype.scrollTo = function () {}
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => 1000 },
    clientHeight: { configurable: true, get: () => 800 },
  })
  vi.spyOn(dom.window.HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0, toJSON() {} })
  vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  vi.spyOn(localStore, 'localOpen').mockResolvedValue(null)
  vi.spyOn(localStore, 'localList').mockResolvedValue([])
  vi.spyOn(localStore.SaveCoordinator.prototype, 'save').mockResolvedValue()
  vi.spyOn(localStore, 'localSelect').mockResolvedValue()
  vi.spyOn(startupPreview, 'readStartupPreview').mockResolvedValue(undefined)
  const set = Editor.prototype.set
  editor = undefined
  vi.spyOn(Editor.prototype, 'set').mockImplementation(function (this: Editor, patch) { editor ??= this; return set.call(this, patch) })
  errors = []
  vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args))
  interfacePreference.reset()
  resetFigmaWorkspaceMode()
  shortcutPreference.set('figma-like')
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  const mount = document.createElement('div')
  document.body.append(mount)
  root = (await import('react-dom/client')).createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount())
  editor?.dispose()
  interfacePreference.reset()
  resetFigmaWorkspaceMode()
  shortcutPreference.set('figma-like')
  dom.window.close()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  expect(errors).toEqual([])
})

const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes(label) || item.getAttribute('aria-label') === label)
const modeButton = (mode: 'design' | 'draw') => document.querySelector<HTMLButtonElement>(`[data-workspace-mode="${mode}"]`)

async function openEditor() {
  await act(async () => { root.render(<App />); for (let i = 0; i < 40; i++) await Promise.resolve() })
  const resume = button('继续编辑')!
  expect(resume.disabled).toBe(false)
  await act(async () => resume.click())
  for (let i = 0; i < 20; i++) await Promise.resolve()
  expect(editor).toBeDefined()
}

test('layer previews use the node paint and do not invent a brush catalog', () => {
  const shape = node('rectangle', 0, 0, 40, 20)
  shape.fills = [paint('#2255aa')]
  expect(layerPreviewSpec(shape)).toEqual({ shape: 'rect', color: '#2255aa' })
  const picture = node('rectangle')
  picture.fills = [{ ...paint('#000000'), kind: 'image', image: 'data:image/png;base64,aaaa' }]
  expect(layerPreviewSpec(picture).shape).toBe('image')
  const vector = node('vector')
  vector.fills = []
  vector.strokes = [{ ...vector.strokes[0], paint: paint('#112233') }]
  expect(layerPreviewSpec(vector)).toEqual({ shape: 'vector', color: '#112233' })
  expect(layerPreviewSpec(node('frame'))).toMatchObject({ shape: 'frame' })
  expect(canvasText.en.designMode).toBe('Design. Left and right arrows switch modes.')
  expect(canvasText.en.drawMode).toBe('Draw. Left and right arrows switch modes.')
  expect(canvasText.en.pencilToolstrip).toBe('Pencil toolstrip')
  expect(canvasText['zh-CN'].pencilWidthSlider).toBe('铅笔笔宽滑块')
})

test('Design and Draw switch the Figma toolstrip, layer previews, and pencil controls without touching the document', async () => {
  await openEditor()
  const shape = node('ellipse', 80, 60, 120, 72)
  shape.name = 'Dashboard card'
  shape.fills = [paint('#2255aa')]
  await act(async () => {
    editor!.change('add card', document => {
      document.nodes[shape.id] = shape
      document.pages.find(page => page.id === editor!.state.page)!.children.push(shape.id)
    })
    editor!.select([shape.id])
    editor!.set({ view: { x: 12, y: 34, zoom: 1.5 } })
  })
  const kept = () => ({ doc: editor!.state.doc, selection: editor!.state.selection, view: editor!.state.view, version: editor!.state.version, tool: editor!.state.tool })
  const before = kept()
  expect(document.querySelector('.editor-shell')?.getAttribute('data-figma-workspace')).toBe('design')
  expect(modeButton('design')?.getAttribute('aria-checked')).toBe('true')
  expect(modeButton('design')?.querySelector('svg')).not.toBeNull()
  expect(modeButton('draw')?.querySelector('svg')).not.toBeNull()
  expect(modeButton('design')?.getAttribute('data-tooltip')).toContain('方向键')
  expect(modeButton('draw')?.title).toContain('Draw')
  expect(button('绘图工具')).toBeDefined()
  expect(document.querySelector('[data-layer-preview]')).toBeNull()
  expect(document.querySelector('[data-draw-toolstrip]')).toBeNull()

  const sets = vi.mocked(editor!.set).mock.calls.length
  await act(async () => modeButton('draw')!.click())
  expect(vi.mocked(editor!.set).mock.calls.length).toBe(sets)
  expect(kept()).toEqual(before)
  expect(modeButton('draw')?.getAttribute('aria-checked')).toBe('true')
  expect(modeButton('design')?.getAttribute('aria-checked')).toBe('false')
  expect(button('绘图工具')).toBeUndefined()
  expect(button('钢笔')).toBeDefined()
  expect(button('铅笔')).toBeDefined()
  expect(button('画笔')).toBeDefined()
  expect(document.querySelector('[data-layer-preview="ellipse"]')).not.toBeNull()

  await act(async () => button('铅笔')!.click())
  expect(editor!.state.tool).toBe('pencil')
  expect(editor!.state.doc).toBe(before.doc)
  expect(editor!.state.selection).toBe(before.selection)
  expect(editor!.state.view).toBe(before.view)
  const strip = document.querySelector<HTMLElement>('[data-draw-toolstrip="pencil"]')!
  expect(strip.getAttribute('aria-label')).toBe('铅笔工具带')
  expect(strip.querySelector('input[aria-label="铅笔笔宽滑块"]')).not.toBeNull()
  expect(strip.querySelector('select')).toBeNull()
  expect(strip.textContent).not.toMatch(/Stretch|Scatter|Heist|Bubblegum/)
  expect(document.querySelector('.canvas-workspace > .pencil-controls, .canvas-workspace .pencil-controls:not(.draw-tool-controls)')).toBeNull()

  const slider = strip.querySelector<HTMLInputElement>('input[aria-label="铅笔笔宽滑块"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(slider, '6')
    slider.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  expect(editor!.state.pencil.width).toBe(6)
  expect(editor!.state.doc).toBe(before.doc)
  expect(editor!.state.view).toBe(before.view)

  const viewBeforeZoom = editor!.state.view
  const thumb = document.querySelector<HTMLButtonElement>('[data-layer-preview="ellipse"]')!
  await act(async () => thumb.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })))
  expect(editor!.state.view).not.toEqual(viewBeforeZoom)
  expect(editor!.state.selection).toEqual([shape.id])
  expect(editor!.state.doc).toBe(before.doc)
  const zoomed = editor!.state.view

  await act(async () => modeButton('draw')!.focus())
  await act(async () => modeButton('draw')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })))
  expect(document.querySelector('.editor-shell')?.getAttribute('data-figma-workspace')).toBe('design')
  expect(button('绘图工具')).toBeDefined()
  expect(document.querySelector('[data-layer-preview]')).toBeNull()
  expect(document.querySelector('[data-draw-toolstrip]')).toBeNull()
  expect(document.querySelector('.pencil-controls')).not.toBeNull()
  expect(editor!.state.doc).toBe(before.doc)
  expect(editor!.state.selection).toEqual([shape.id])
  expect(editor!.state.view).toBe(zoomed)
  expect(editor!.state.version).toBe(before.version)

  await act(async () => modeButton('design')!.focus())
  await act(async () => modeButton('design')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })))
  expect(modeButton('draw')?.getAttribute('aria-checked')).toBe('true')
  await act(async () => modeButton('draw')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })))
  expect(modeButton('design')?.getAttribute('aria-checked')).toBe('true')
  expect(editor!.state.view).toBe(zoomed)
})

test('Sketch layout ignores the Figma Design / Draw mode', async () => {
  await openEditor()
  await act(async () => modeButton('draw')!.click())
  const sketch = [...document.querySelectorAll<HTMLButtonElement>('.ui-mode-switch button')].find(item => item.textContent === 'Sketch')!
  await act(async () => sketch.click())
  expect(document.querySelector('.editor-shell')?.getAttribute('data-ui-mode')).toBe('sketch')
  expect(document.querySelector('.editor-shell')?.hasAttribute('data-figma-workspace')).toBe(false)
  expect(document.querySelector('[data-workspace-mode]')).toBeNull()
  expect(document.querySelector('[data-layer-preview]')).toBeNull()
  expect(document.querySelector('[data-draw-tools]')).toBeNull()
  await act(async () => { editor!.set({ tool: 'pencil' }) })
  expect(document.querySelector('.pencil-controls')).not.toBeNull()
  expect(document.querySelector('[data-draw-toolstrip]')).toBeNull()
})
