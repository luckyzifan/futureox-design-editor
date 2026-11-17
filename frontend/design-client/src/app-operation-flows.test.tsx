// Mounted production App + Canvas + Inspector and real Editor/WASM. Only the
// graphics-device and persistence/host boundaries are replaced. Platform names
// exercise policy branches, not real macOS/Windows/Linux acceptance.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from './App'
import { DesktopSession } from './desktop-session'
import { componentFixture } from './component-fixtures'
import { emptySystem } from './design-system'
import { Editor } from './engine'
import { applyInterfaceLayout } from './interface-layout'
import { interfacePreference } from './interface-preference'
import { fontTestBytes } from './font-test-fixtures'
import { export_sketch_json, forma_decode_json, forma_encode_json, import_sketch_json } from './generated/design-kernel/design_kernel'
import { worldMatrix } from './geometry'
import { selectionParentBounds } from './canvas-view'
import { screenToWorld, zoomAt } from './canvas-camera'
import { kernelFillWorld } from './kernel/picking'
import { blank, defaultLayout, defaultLayoutGrid, defaultSizing, defaultTextStyle, node, paint, stroke, uid } from './model'
import { nudgePreference } from './nudge-preference'
import * as persistence from './persistence'
import { shortcutPreference } from './shortcut-preference'
import { setPrototypeTab } from './prototype-chrome'
import { authorSketchHotspot, isSketchHotspot } from './sketch-hotspot'
import * as localStore from './local-store'
import * as startupPreview from './startup-preview'
import type { DesktopBridge } from './desktop'

vi.mock('./kernel/Surface', async () => {
  const { useLayoutEffect } = await import('react')
  return { KernelSurface(props: import('./kernel/Surface').SurfaceProps) {
    useLayoutEffect(() => { props.onPresentation?.({ ...props, epoch: props.presentationEpoch!, pixelRatio: 1, managed: false }) }, [props.document, props.pageId, props.view, props.width, props.height, props.presentationEpoch, props.onPresentation])
    return <div data-testid="surface-boundary" />
  } }
})
let dom: any, root: Root, mount: HTMLElement, editor: Editor | undefined, errors: unknown[][]
beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLCanvasElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'localStorage']) vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('devicePixelRatio', 1)
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, character => `\\${character}`) })
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {})
  dom.window.HTMLElement.prototype.scrollTo = function () {}
  Object.defineProperties(dom.window.HTMLElement.prototype, { clientWidth: { configurable: true, get: () => 1000 }, clientHeight: { configurable: true, get: () => 800 } })
  vi.spyOn(dom.window.HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0, toJSON() {} })
  vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  vi.spyOn(localStore, 'localOpen').mockResolvedValue(null)
  vi.spyOn(localStore, 'localList').mockResolvedValue([])
  vi.spyOn(localStore.SaveCoordinator.prototype, 'save').mockResolvedValue()
  vi.spyOn(localStore, 'localSelect').mockResolvedValue()
  vi.spyOn(startupPreview, 'readStartupPreview').mockResolvedValue(undefined)
  const set = Editor.prototype.set; editor = undefined
  vi.spyOn(Editor.prototype, 'set').mockImplementation(function (this: Editor, patch) { editor ??= this; return set.call(this, patch) })
  errors = []; vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args))
  nudgePreference.reset(); shortcutPreference.set('sketch-like')
  mount = document.createElement('div'); document.body.append(mount); root = (await import('react-dom/client')).createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount()); editor?.dispose(); interfacePreference.reset(); nudgePreference.reset(); shortcutPreference.set('figma-like')
  dom.window.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); expect(errors).toEqual([])
})
async function render() {
  await act(async () => { root.render(<App />); for (let i = 0; i < 30; i++) await Promise.resolve() })
  // App intentionally starts on Home. These are editor operation tests, so
  // enter through the real ready-gated route instead of clicking inert chrome.
  expect(document.querySelector('[aria-label="本机设计首页"]')).not.toBeNull()
  expect(document.querySelector('[data-testid="canvas"]')).toBeNull()
  const resume = button('继续编辑')
  expect(resume.disabled).toBe(false)
  await act(async () => resume.click())
  expect(document.querySelector('[aria-label="本机设计首页"]')).toBeNull()
  expect(canvas()).not.toBeNull()
}
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.includes(text))!
const canvas = () => document.querySelector<HTMLElement>('[data-testid="canvas"]')!
async function key(value: string, options: KeyboardEventInit = {}, type = 'keydown') { await act(async () => canvas().dispatchEvent(new KeyboardEvent(type, { key: value, code: value, bubbles: true, cancelable: true, ...options }))) }

test('Sketch component shortcuts use six local categories and preserve the canvas camera', async () => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  applyInterfaceLayout('sketch')
  await render()
  const { doc } = componentFixture()
  Object.values(doc.nodes).find(layer => layer.component)!.name = 'Local Symbol'
  const frame = { ...node('frame'), name: 'Wide Template', sketchTemplate: true }
  const graphic = { ...node('frame'), name: 'Icon Template', graphic: true, sketchTemplate: true }
  const ordinary = { ...node('frame'), name: 'Ordinary Frame' }
  doc.schemaVersion = 32
  for (const layer of [frame, graphic, ordinary]) { doc.nodes[layer.id] = layer; doc.pages[0].children.push(layer.id) }
  doc.designSystem = emptySystem()
  doc.designSystem.styles = {
    paragraph: { name: 'Paragraph Style', kind: 'text', value: defaultTextStyle() },
    surface: { name: 'Surface Style', kind: 'paint', value: [paint('#ddeeff')] },
  }
  doc.designSystem.collections.palette = { name: 'Palette', defaultMode: 'light', modes: ['light'] }
  doc.designSystem.variables.brand = { name: 'Brand Blue', collection: 'palette', kind: 'color', values: { light: '#1234ab' } }
  const view = { x: 31, y: 57, zoom: 1.375 }
  await act(async () => { editor!.load(doc) })
  await act(async () => { editor!.set({ view }); canvas().focus() })
  const original = editor!.authoredDocument
  await key('2', { code: 'Digit2', ctrlKey: true })
  const region = document.querySelector<HTMLElement>('section[aria-label="组件视图"]')!
  const search = region.querySelector<HTMLInputElement>('input[aria-label="搜索组件"]')!
  expect(document.activeElement).toBe(search)
  expect(document.querySelector('[data-testid="canvas"]')).toBeNull()
  const press = (target: EventTarget, key: string, options: KeyboardEventInit) => act(async () =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })))
  for (const [i, [label, resource]] of [
    ['符号', 'Local Symbol'], ['文本样式', 'Paragraph Style'], ['图层样式', 'Surface Style'],
    ['颜色变量', 'Brand Blue'], ['画框模板', 'Wide Template'], ['图形模板', 'Icon Template'],
  ].entries()) {
    await press(search, String(i + 1), { code: `Digit${i + 1}`, metaKey: true })
    expect(region.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(label)
    const list = region.querySelector('[role="tabpanel"]')!
    expect(list.textContent).toContain(resource)
    expect(list.textContent).not.toContain('Ordinary Frame')
    expect(editor!.state.view).toEqual(view)
  }
  const frameTab = [...region.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(tab => tab.textContent === '画框模板')!
  frameTab.focus()
  await press(frameTab, 'f', { code: 'KeyF', metaKey: true, altKey: true })
  expect(document.activeElement).toBe(search)
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(search, 'missing asset')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(region.querySelector('[role="tabpanel"]')?.textContent).toContain('暂无匹配的组件')
  await press(search, '1', { code: 'Digit1', ctrlKey: true })
  expect(canvas()).not.toBeNull()
  expect(editor!.state.view).toEqual(view)
  expect(editor!.authoredDocument).toBe(original)
})

test('Sketch Command-E marks only the missing selection presets and opens the selected presets on repeat', async () => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank('Selection export')
  doc.schemaVersion = 8
  const first = { ...node('rectangle'), name: 'First item' }
  const second = { ...node('rectangle'), name: 'Second item' }
  const marked = { ...node('rectangle'), name: 'Already marked', exportSettings: [{ id: 'svg', format: 'svg' as const, scale: 2, suffix: '-wide' }] }
  const elsewhere = { ...node('rectangle'), name: 'Unrelated asset', exportSettings: [{ id: 'svg', format: 'svg' as const, scale: 1, suffix: '' }] }
  const ids = [first.id, second.id, marked.id]
  doc.nodes = Object.fromEntries([first, second, marked, elsewhere].map(layer => [layer.id, layer]))
  doc.pages[0].children = [...ids, elsewhere.id]
  await act(async () => { editor!.load(doc); editor!.select([]); canvas().focus() })
  const authored = () => editor!.authoredDocument
  const initial = authored()
  const exportKey = () => key('e', { code: 'KeyE', metaKey: true })
  await exportKey()
  expect(authored()).toBe(initial)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => editor!.select(ids))
  const version = editor!.state.version
  await exportKey()
  for (const layer of [first, second]) expect(authored().nodes[layer.id].exportSettings).toEqual([
    { id: expect.any(String), format: 'png', scale: 1, suffix: '' },
  ])
  expect(authored().nodes[marked.id].exportSettings).toEqual(marked.exportSettings)
  expect(authored().nodes[elsewhere.id]).toEqual(initial.nodes[elsewhere.id])
  expect(editor!.state.version).toBe(version + 1)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => editor!.undo())
  expect(authored()).toEqual(initial)
  expect(editor!.canUndo).toBe(false)

  await act(async () => editor!.select(ids))
  await exportKey()
  const configured = authored()
  await exportKey()
  await act(async () => { await vi.dynamicImportSettled() })
  await vi.waitFor(async () => {
    await act(async () => {})
    expect(document.querySelector('[aria-label="选区导出预设"]')).not.toBeNull()
  })
  const panel = document.querySelector('[aria-label="选区导出预设"]')!
  expect(panel.textContent).toContain('Already marked-wide.svg')
  expect(panel.textContent).toContain('First item.png')
  expect(panel.textContent).not.toContain('Unrelated asset')
  expect(authored()).toBe(configured)
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  })))
  await act(async () => canvas().focus())
  await key('E', { code: 'KeyE', metaKey: true, shiftKey: true })
  await vi.waitFor(async () => {
    await act(async () => {})
    expect(document.querySelector('[role="group"][aria-label="全部资产"]')?.textContent).toContain('Unrelated asset')
  })
})

test('Sketch Interaction arms the prototype tool and preserves an invisible hotspot in both file formats', async () => {
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank('Hotspot QA')
  const frame = node('frame', 30, 50, 300, 200)
  doc.nodes[frame.id] = frame
  doc.pages[0].children = [frame.id]
  await act(async () => { editor!.load(doc); canvas().focus() })
  try {
    await key('i', { code: 'KeyI' })
    expect(editor!.state.tool).toBe('hotspot')
    expect(document.querySelector('#prototype-properties-tab')?.getAttribute('aria-selected')).toBe('true')
    const authored = editor!.authoredDocument
    const hotspot = node('rectangle', 20, 30, 80, 55)
    await act(async () => editor!.change('创建热点', draft => {
      authorSketchHotspot(draft, hotspot)
      draft.nodes[hotspot.id] = hotspot
      draft.nodes[frame.id].children.push(hotspot.id)
    }, [hotspot.id]))
    const committed = editor!.authoredDocument
    expect(committed.nodes[hotspot.id].fills).toEqual([])
    expect(committed.prototype?.interactions[hotspot.id]).toEqual([{ trigger: 'click', actions: [] }])
    expect(document.querySelector<HTMLSelectElement>('[aria-label="交互触发"]')?.value).toBe('click')
    const fd = JSON.parse(forma_decode_json(forma_encode_json(JSON.stringify(committed))))
    const sketch = JSON.parse(import_sketch_json(export_sketch_json(JSON.stringify(committed)))).document
    for (const reopened of [fd, sketch]) {
      expect(isSketchHotspot(reopened, reopened.nodes[hotspot.id])).toBe(true)
      expect(reopened.nodes[hotspot.id].fills).toEqual([])
      expect(reopened.prototype.interactions[hotspot.id]).toMatchObject([{ trigger: 'click', actions: [] }])
    }
    await act(async () => editor!.undo())
    expect(editor!.authoredDocument).toEqual(authored)
  } finally {
    await act(async () => setPrototypeTab('design'))
  }
})

test('Sketch Control-T inserts a linked text style with the archived size and paragraph metrics in one undo', async () => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  applyInterfaceLayout('sketch')
  await render()
  const picker = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="置入文字样式"]')!
  const open = () => key('t', { code: 'KeyT', ctrlKey: true })
  const empty = editor!.authoredDocument
  await act(async () => canvas().focus())
  await open()
  expect(picker().textContent).toContain('没有匹配的文字样式')
  expect(picker().querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
  expect(editor!.authoredDocument).toBe(empty)
  await act(async () => picker().querySelector('button')!.click())

  const doc = blank('Text style insertion')
  doc.schemaVersion = 20
  doc.designSystem = emptySystem()
  doc.designSystem.styles.body = { kind: 'text', name: 'Body 21', value: {
    ...defaultTextStyle(), fontSize: 21, align: 'end', paragraphSpacing: 13, paragraphIndent: 4, lineHeight: 1.5,
  } }
  const restored = JSON.parse(import_sketch_json(export_sketch_json(JSON.stringify(doc)))).document
  expect(restored.designSystem.styles.body.value).toMatchObject({ fontSize: 21, paragraphSpacing: 13, paragraphIndent: 4, lineHeight: 1.5 })
  await act(async () => { editor!.load(restored); canvas().focus() })
  const before = editor!.authoredDocument
  await open()
  const revision = editor!.state.version
  expect(picker().textContent).toContain('Body 21')
  await act(async () => picker().querySelector<HTMLButtonElement>('button[type="submit"]')!.click())
  expect(picker()).toBeNull()
  const id = editor!.state.selection[0], text = editor!.state.doc.nodes[id]
  expect(text).toMatchObject({
    kind: 'text', fontSize: 21, styleRefs: { textStyle: 'body' },
    textStyle: { align: 'end', paragraphSpacing: 13, paragraphIndent: 4, lineHeight: 1.5 },
  })
  expect(text.text.length).toBeGreaterThan(0)
  expect(editor!.state.version).toBe(revision + 1)
  await act(async () => editor!.undo())
  expect(editor!.authoredDocument).toEqual(before)
  expect(editor!.canUndo).toBe(false)
})

test('Space hides Sketch canvas guides and selection feedback until release without rewriting preferences', async () => {
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank('Space pan')
  doc.schemaVersion = 12
  const frame = node('frame', 42, 54, 150, 90)
  frame.layoutGrid = { ...defaultLayoutGrid(), count: 4, gutter: 4, margin: 0 }
  doc.nodes[frame.id] = frame
  doc.pages[0].children = [frame.id]
  doc.pages[0].guides = [{ id: uid(), axis: 'y', position: 32 }]
  await act(async () => { editor!.load(doc) })
  await act(async () => {
    editor!.set({ rulers: true, grid: true, pixelGrid: true, view: { x: 20, y: 40, zoom: 4 } })
    editor!.select([frame.id])
    canvas().focus()
  })
  const authored = editor!.authoredDocument, revision = editor!.state.version
  const chrome = (selector: string) => canvas().querySelector(selector)
  const guides = '[data-testid="ruler-guide"]'
  const layoutGrid = '[data-testid="authored-layout-grid-band"]'
  const pixel = '[data-testid="pixel-grid"]'
  const marks = ['.selection', '[data-testid="resize-edge-3"]', guides, layoutGrid, pixel]
  for (const mark of marks) expect(chrome(mark)).not.toBeNull()

  await key(' ', { code: 'Space' })
  for (const mark of marks) expect(chrome(mark)).toBeNull()
  expect(chrome('[data-testid="horizontal-ruler"]')).not.toBeNull()
  expect(editor!.state).toMatchObject({ rulers: true, grid: true, pixelGrid: true })
  await key(' ', { code: 'Space' }, 'keyup')
  for (const mark of marks) expect(chrome(mark)).not.toBeNull()

  await act(async () => { applyInterfaceLayout('figma'); canvas().focus() })
  await key(' ', { code: 'Space' })
  for (const mark of ['.selection', guides, layoutGrid, pixel]) expect(chrome(mark)).not.toBeNull()
  await key(' ', { code: 'Space' }, 'keyup')
  expect(editor!.state.selection).toEqual([frame.id])
  expect(editor!.authoredDocument).toBe(authored)
  expect(editor!.state.version).toBe(revision)
})

test('Sketch held zoom uses the pointer or center and restores each page’s original camera', async () => {
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank('Temporary zoom')
  const page = doc.pages[0].id
  const otherPage = uid()
  doc.pages.push({ id: otherPage, name: 'Second', background: '#ffffff', children: [] })
  const view = { x: -45, y: 84, zoom: 3.5 }
  const point = { x: 240, y: 198 }
  await act(async () => { editor!.load(doc) })
  await act(async () => {
    editor!.setViewCoalesced(view)
    editor!.pointerScreen = point
    canvas().focus()
  })
  const before = editor!.authoredDocument, revision = editor!.state.version
  expect(editor!.effectiveView()).toEqual(view)
  const down = () => key('~', { code: 'Backquote', shiftKey: true })
  const up = () => key('`', { code: 'Backquote' }, 'keyup')
  await down()
  expect(editor!.state.view).toEqual(zoomAt(view, 1, point))
  const previewPoint = screenToWorld(editor!.state.view, point)
  const originalPoint = screenToWorld(view, point)
  expect(previewPoint.x).toBeCloseTo(originalPoint.x, 10)
  expect(previewPoint.y).toBeCloseTo(originalPoint.y, 10)
  await key('~', { code: 'Backquote', shiftKey: true, repeat: true })
  expect(editor!.state.view).toEqual(zoomAt(view, 1, point))
  await up()
  expect(editor!.state.view).toEqual(view)

  editor!.pointerScreen = null
  await key('§', { code: 'IntlBackslash' })
  expect(editor!.state.view).toEqual(zoomAt(view, 1, { x: 500, y: 400 }))
  await act(async () => window.dispatchEvent(new Event('blur')))
  expect(editor!.state.view).toEqual(view)

  await down()
  await act(async () => editor!.switchPage(otherPage))
  const second = editor!.state.view
  await up()
  expect(editor!.state.view).toEqual(second)
  await act(async () => editor!.switchPage(page))
  expect(editor!.state.view).toEqual(view)

  const input = document.createElement('input')
  document.body.append(input)
  try {
    await act(async () => {
      input.focus()
      input.dispatchEvent(new KeyboardEvent('keydown', { key: '~', code: 'Backquote', shiftKey: true, bubbles: true }))
    })
    expect(editor!.state.view).toEqual(view)
  } finally { input.remove() }
  expect(editor!.authoredDocument).toBe(before)
  expect(editor!.state.version).toBe(revision)
})

test('Sketch Shift-Command-P rounds coordinates and dimensions independently while preserving rotation', async () => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank('Round to Pixel')
  const plain = node('rectangle', -10.5, 21.51, 45.5, 18.5)
  const rotated = node('rectangle', 120.43, 78.71, 61.24, 32.59)
  rotated.transform = [.8, .6, -.6, .8, 120.43, 78.71]
  const integer = node('rectangle', 240, 86, 60, 48)
  const text = node('text', 310.27, 110.42, 128, 36)
  doc.nodes = Object.fromEntries([plain, rotated, integer, text].map(layer => [layer.id, layer]))
  doc.pages[0].children = [plain.id, rotated.id, integer.id, text.id]
  const ids = [plain.id, rotated.id, integer.id]
  await act(async () => { editor!.load(doc); editor!.select(ids); canvas().focus() })
  const before = editor!.authoredDocument, revision = editor!.state.version
  const round = () => key('P', { code: 'KeyP', shiftKey: true, metaKey: true })
  await act(async () => editor!.set({ tool: 'vector' }))
  await round()
  expect(editor!.authoredDocument).toBe(before)
  await act(async () => { editor!.set({ tool: 'select' }); editor!.select([text.id]) })
  await key('Enter')
  const textarea = document.querySelector<HTMLTextAreaElement>('.rich-text-editor textarea')!
  expect(textarea).toBeTruthy()
  await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'P', code: 'KeyP', shiftKey: true, metaKey: true, bubbles: true, cancelable: true,
  })))
  expect(editor!.authoredDocument).toBe(before)
  await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  })))
  await act(async () => { editor!.select(ids); canvas().focus() })
  await round()
  const after = editor!.authoredDocument
  expect(after.nodes[plain.id]).toMatchObject({ transform: [1, 0, 0, 1, -11, 22], width: 46, height: 19 })
  expect(after.nodes[integer.id]).toBe(before.nodes[integer.id])
  const layer = after.nodes[rotated.id], box = selectionParentBounds(after, rotated.id), old = selectionParentBounds(before, rotated.id)
  expect(layer.width).toBeCloseTo(61, 8)
  expect(layer.height).toBeCloseTo(33, 8)
  expect(box.x).toBeCloseTo(Math.round(old.x), 8)
  expect(box.y).toBeCloseTo(Math.round(old.y), 8)
  for (const [i,value] of layer.transform.slice(0, 4).entries()) expect(value).toBeCloseTo(rotated.transform[i], 8)
  expect(editor!.state.version).toBe(revision + 1)
  await round()
  expect(editor!.authoredDocument).toBe(after)
  await act(async () => editor!.undo())
  expect(editor!.authoredDocument).toEqual(before)
})

test('Sketch Control-Command-X fits each selected bounds outward and undoes the change together', async () => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank('Pixel fitting')
  const plain = node('rectangle', -12.22, -21.68, 20.38, 10.45)
  const parent = node('frame', 90.3, 75.7, 300, 200)
  const rotated = node('rectangle', 22.2, 16.8, 61.5, 33.4)
  rotated.transform = [.8, .6, -.6, .8, 22.2, 16.8]
  parent.children = [rotated.id]
  doc.nodes = Object.fromEntries([plain, parent, rotated].map(layer => [layer.id, layer]))
  doc.pages[0].children = [plain.id, parent.id]
  const ids = [plain.id, rotated.id]
  await act(async () => { editor!.load(doc); editor!.select(ids); canvas().focus() })
  const before = editor!.authoredDocument, version = editor!.state.version, snap = editor!.state.snapPixels
  const edges = (document: typeof doc, id: string) => {
    const box = selectionParentBounds(document, id, worldMatrix(document, id))
    return [box.x, box.y, box.x + box.width, box.y + box.height]
  }
  const fit = () => key('x', { code: 'KeyX', ctrlKey: true, metaKey: true })
  await fit()
  const after = editor!.authoredDocument
  for (const [index, edge] of edges(after, plain.id).entries()) {
    expect(edge).toBeCloseTo([-13, -22, 9, -11][index], 8)
  }
  for (const [index, edge] of edges(after, rotated.id).entries()) {
    const original = edges(before, rotated.id)[index]
    expect(edge).toBeCloseTo(index < 2 ? Math.floor(original) : Math.ceil(original), 8)
  }
  expect(after.nodes[parent.id]).toBe(before.nodes[parent.id])
  expect(editor!.state.snapPixels).toBe(snap)
  expect(editor!.state.version).toBe(version + 1)
  await fit()
  expect(editor!.authoredDocument).toBe(after)
  expect(editor!.state.version).toBe(version + 1)
  await act(async () => editor!.undo())
  expect(editor!.authoredDocument).toEqual(before)
})

test('Sketch Command-Y creates an in-place instance and a source in one undo step', async () => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank('Create Symbol')
  const parent = node('frame', 30, 60, 600, 340)
  const beforeSibling = node('rectangle', 1, 1, 16, 16)
  const selected = node('frame', 90, 80, 120, 75)
  const child = node('rectangle', 10, 13, 30, 26)
  const afterSibling = node('rectangle', 230, 85, 16, 16)
  selected.name = 'QA Symbol'
  selected.transform = [0.8, 0.6, -0.6, 0.8, 90, 80]
  selected.children = [child.id]
  parent.children = [beforeSibling.id, selected.id, afterSibling.id]
  doc.nodes = Object.fromEntries([parent, beforeSibling, selected, child, afterSibling].map(layer => [layer.id, layer]))
  doc.pages[0].children = [parent.id]
  await act(async () => { editor!.load(doc); editor!.select([selected.id]); canvas().focus() })
  const initial = editor!.authoredDocument
  const open = () => key('y', { code: 'KeyY', metaKey: true })
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="创建控件"]')!
  await open()
  expect(dialog()).toBeTruthy()
  expect(editor!.authoredDocument).toBe(initial)
  await act(async () => dialog().querySelector('header button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(editor!.authoredDocument).toBe(initial)
  for (const send of [false, true]) {
    await act(async () => { editor!.select([selected.id]); canvas().focus() })
    await open()
    if (send) await act(async () => dialog().querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    const version = editor!.state.version
    await act(async () => dialog().querySelector<HTMLButtonElement>('button[type="submit"]')!.click())
    expect(dialog()).toBeNull()
    expect(editor!.state.version).toBe(version + 1)
    const result = editor!.authoredDocument, instance = result.nodes[editor!.state.selection[0]]
    expect(instance.instance?.componentId).toBe(selected.id)
    expect(instance.transform).toEqual(selected.transform)
    expect(result.nodes[parent.id].children).toEqual([beforeSibling.id, instance.id, afterSibling.id])
    expect(result.nodes[selected.id].component).toBeDefined()
    expect(result.nodes[selected.id].children).toEqual([child.id])
    expect(result.pages.find(page => page.children.includes(selected.id))?.name).toBe(send ? 'Symbols' : initial.pages[0].name)
    const displayed = editor!.state.doc
    const instanceChild = displayed.nodes[instance.id].children[0]
    expect(worldMatrix(displayed, instanceChild)).toEqual(worldMatrix(initial, child.id))
    await act(async () => editor!.undo())
    expect(editor!.authoredDocument).toEqual(initial)
    expect(editor!.canUndo).toBe(false)
  }
})

test('Sketch Y opens the symbol picker and inserts an existing source only after confirmation', async () => {
  applyInterfaceLayout('sketch')
  await render()
  const picker = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="置入控件"]')!
  const open = () => key('y', { code: 'KeyY' })
  const cancel = () => act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  })))
  const empty = editor!.authoredDocument
  await act(async () => canvas().focus())
  await open()
  expect(picker().textContent).toContain('没有可置入的控件')
  expect(picker().querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
  await cancel()
  expect(picker()).toBeNull()
  expect(editor!.authoredDocument).toBe(empty)

  const { doc } = componentFixture()
  const source = Object.values(doc.nodes).find(layer => layer.component)!
  source.name = 'Source of the inserted symbol'
  await act(async () => { editor!.load(doc); canvas().focus() })
  const initial = editor!.authoredDocument
  await open()
  expect(picker().textContent).toContain(source.name)
  expect(editor!.authoredDocument).toBe(initial)
  await cancel()
  expect(editor!.authoredDocument).toBe(initial)
  await open()
  await act(async () => {
    const list = picker().querySelector<HTMLSelectElement>('select')!
    list.value = source.id
    list.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const version = editor!.state.version
  await act(async () => picker().querySelector<HTMLButtonElement>('button[type="submit"]')!.click())
  const selected = editor!.state.selection[0]
  expect(picker()).toBeNull()
  expect(editor!.authoredDocument.nodes[selected].instance?.componentId).toBe(source.id)
  expect(editor!.authoredDocument.nodes[source.id]).toEqual(initial.nodes[source.id])
  expect(editor!.state.version).toBe(version + 1)
  await act(async () => editor!.undo())
  expect(editor!.authoredDocument).toEqual(initial)
})

test('Sketch Option-Command-R replaces the chosen instance or shared style in one undo', async () => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  applyInterfaceLayout('sketch')
  await render()
  const { doc, ids } = componentFixture()
  const shape = node('rectangle'), text = node('text'), frame = node('frame', 0, 0, 300, 200)
  const fill = paint('#d92454'), newFill = paint('#4180f2')
  doc.schemaVersion = 12
  doc.designSystem = emptySystem()
  doc.designSystem.styles = {
    accent: { name: 'Accent', kind: 'paint', value: [fill] },
    neutral: { name: 'Neutral', kind: 'paint', value: [newFill] },
    label: { name: 'Label', kind: 'text', value: defaultTextStyle() },
    caption: { name: 'Caption', kind: 'text', value: { ...defaultTextStyle(), letterSpacing: 2 } },
  }
  shape.fills = [fill]
  shape.styleRefs = { fills: 'accent' }
  text.text = 'Keep this text'
  text.textStyle = defaultTextStyle()
  text.styleRefs = { textStyle: 'label' }
  frame.styleRefs = { fills: 'accent' }
  for (const n of [shape, text, frame]) {
    doc.nodes[n.id] = n
    doc.pages[0].children.push(n.id)
  }
  await act(async () => { editor!.load(doc); canvas().focus() })
  const replace = () => key('®', { code: 'KeyR', altKey: true, metaKey: true })
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
  const select = (id: string) => act(async () => editor!.select([id]))
  const choose = async (id: string) => {
    const list = dialog()!.querySelector<HTMLSelectElement>('select[size]')!
    await act(async () => {
      list.value = id
      list.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => dialog()!.querySelector<HTMLButtonElement>('button[type=submit]')!.click())
    expect(dialog()).toBeNull()
  }

  await replace()
  expect(dialog()).toBeNull()
  await select(ids.a)
  const before = editor!.authoredDocument
  await replace()
  expect(dialog()?.getAttribute('aria-label')).toBe('替换组件')
  expect(document.activeElement?.getAttribute('type')).toBe('search')
  expect(editor!.authoredDocument).toBe(before)
  await choose(ids.iconB)
  expect(editor!.authoredDocument.nodes[ids.a].instance?.componentId).toBe(ids.iconB)
  expect(editor!.authoredDocument.nodes[ids.b].instance?.componentId).toBe(ids.button)
  expect(document.activeElement).toBe(canvas())
  await act(async () => editor!.undo())
  expect(editor!.authoredDocument).toEqual(before)
  expect(editor!.canUndo).toBe(false)

  await select(shape.id)
  await replace()
  expect(dialog()?.getAttribute('aria-label')).toBe('替换图层样式')
  await choose('neutral')
  expect(editor!.state.doc.nodes[shape.id].styleRefs?.fills).toBe('neutral')
  await act(async () => editor!.undo())
  expect(editor!.state.doc.nodes[shape.id].styleRefs?.fills).toBe('accent')

  await select(text.id)
  await replace()
  expect(dialog()?.getAttribute('aria-label')).toBe('替换文字样式')
  await choose('caption')
  expect(editor!.state.doc.nodes[text.id]).toMatchObject({ text: 'Keep this text', styleRefs: { textStyle: 'caption' } })
  await act(async () => editor!.undo())
  expect(editor!.authoredDocument).toEqual(before)

  await select(frame.id)
  await replace()
  expect(dialog()?.getAttribute('aria-label')).toBe('选择模板')
  await act(async () => dialog()!.querySelector('button')!.click())
  await act(async () => applyInterfaceLayout('figma'))
  await select(ids.a)
  await replace()
  expect(dialog()).toBeNull()
})

test('Sketch Control-Option-S restores the linked appearance and leaves a single undo', async () => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank(), shape = node('rectangle'), other = node('rectangle', 200)
  const shared = paint('#214989'), override = paint('#d14021')
  doc.schemaVersion = 12
  doc.designSystem = emptySystem()
  doc.designSystem.styles.calendar = { kind: 'paint', name: 'Calendar', value: [shared] }
  for (const layer of [shape, other]) {
    layer.styleRefs = { fills: 'calendar' }
    layer.fills = [shared]
    doc.nodes[layer.id] = layer
    doc.pages[0].children.push(layer.id)
  }
  await act(async () => { editor!.load(doc); editor!.select([shape.id]); canvas().focus() })
  const reset = () => key('ß', { code: 'KeyS', ctrlKey: true, altKey: true })
  const selected = () => editor!.state.doc.nodes[shape.id]
  await reset()
  expect(editor!.canUndo).toBe(false)
  await act(async () => editor!.updateProperties([shape.id], { fills: [override], strokes: [stroke('#144e52', 3)] }))
  expect(selected()).toMatchObject({ fills: [override], styleRefs: { fills: 'calendar' }, sketchLayerStyleOverridden: true })
  const reopened = JSON.parse(forma_decode_json(forma_encode_json(JSON.stringify(editor!.authoredDocument))))
  await act(async () => { expect(editor!.load(reopened)).toBe(true); editor!.select([shape.id]) })
  expect(selected().fills[0].color).toBe(override.color)
  const before = editor!.authoredDocument
  await reset()
  expect(selected().styleRefs?.fills).toBe('calendar')
  expect(selected().fills[0].color).toBe(shared.color)
  expect(selected().strokes).toEqual([])
  expect(selected().sketchLayerStyleOverridden).toBeUndefined()
  expect(editor!.state.doc.nodes[other.id]).toEqual(before.nodes[other.id])
  const version = editor!.state.version
  await reset()
  expect(editor!.state.version).toBe(version)
  await act(async () => editor!.undo())
  expect(editor!.authoredDocument).toEqual(before)
  expect(editor!.canUndo).toBe(false)
})

test('Sketch Control-S and Inspector Update sync the selected style without relinking other styles', async () => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank(), source = node('rectangle'), linked = node('rectangle', 200), unlinked = node('rectangle', 400)
  const originalFill = paint('#214989'), newFill = paint('#d14021'), border = stroke('#70879a', 4)
  doc.schemaVersion = 12
  doc.designSystem = emptySystem()
  doc.designSystem.styles.calendar = { kind: 'paint', name: 'Calendar', value: [originalFill], strokes: [border] }
  for (const layer of [source, linked, unlinked]) {
    if (layer !== unlinked) layer.styleRefs = { fills: 'calendar' }
    doc.nodes[layer.id] = layer
    doc.pages[0].children.push(layer.id)
  }
  const sync = () => key('s', { code: 'KeyS', ctrlKey: true })
  await act(async () => { editor!.load(doc); editor!.select([unlinked.id]); canvas().focus() })
  const original = editor!.authoredDocument
  await sync()
  expect(editor!.authoredDocument).toBe(original)
  await act(async () => {
    editor!.select([source.id])
    editor!.updateProperties([source.id], { fills: [newFill], strokes: [] })
  })
  const beforeSync = editor!.authoredDocument
  const revision = editor!.state.version
  await sync()
  const afterSync = editor!.authoredDocument
  expect(editor!.state.version).toBe(revision + 1)
  expect(afterSync.designSystem?.styles.calendar).toMatchObject({ value: [newFill], strokes: [] })
  expect(afterSync.nodes[linked.id]).toMatchObject({ fills: [newFill], strokes: [], styleRefs: { fills: 'calendar' } })
  expect(afterSync.nodes[source.id].sketchLayerStyleOverridden).toBeUndefined()
  expect(afterSync.nodes[unlinked.id]).toBe(beforeSync.nodes[unlinked.id])
  await act(async () => editor!.undo())
  expect(editor!.authoredDocument).toEqual(beforeSync)
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="更新图层样式"]')!.click())
  expect(editor!.authoredDocument).toEqual(afterSync)
})

test('Sketch inspector resolves frame distances and anchored dimensions before writing numbers', async () => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank('Geometry anchor QA'), frame = node('frame', 50, 60, 300, 220)
  const group = node('group', 40, 25, 180, 160), shape = node('rectangle', 5, 7, 60, 50), free = node('rectangle', 385, 90, 180, 160)
  frame.children = [group.id]; group.children = [shape.id]
  doc.nodes = Object.fromEntries([frame, group, shape, free].map(node => [node.id, node]))
  doc.pages[0].children = [frame.id, free.id]
  await act(async () => { editor!.load(doc); editor!.select([shape.id]); canvas().focus() })
  const before = editor!.authoredDocument
  const field = (label: string) => document.querySelector<HTMLInputElement>(`input[role="spinbutton"][aria-label="${label}"]`)!
  const enter = async (label: string, value: string) => {
    const input = field(label)
    expect(input).not.toBeNull()
    await act(async () => {
      input.focus()
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    return input
  }
  for (const [label, input, x, y, width, height] of [
    ['X', '20r', 180, 7, 60, 50], ['X', '30L', -10, 7, 60, 50], ['X', '0c', 80, 7, 60, 50],
    ['Y', '15b', 5, 130, 60, 50], ['Y', '9T', 5, -16, 60, 50], ['Y', '12m', 5, 72, 60, 50],
    ['W', '(40 * 2)R', -15, 7, 80, 50], ['W', '80l', 5, 7, 80, 50],
    ['H', '100M', 5, -18, 60, 100], ['H', '100b', 5, -43, 60, 100],
  ] as const) {
    const revision = editor!.state.version
    const changedField = await enter(label, input)
    expect(changedField.validity.customError).toBe(false)
    const layer = editor!.authoredDocument.nodes[shape.id]
    expect(layer.transform[4]).toBeCloseTo(x, 8)
    expect(layer.transform[5]).toBeCloseTo(y, 8)
    expect(layer.width).toBe(width)
    expect(layer.height).toBe(height)
    expect(editor!.state.version).toBe(revision + 1)
    expect(changedField.value).toMatch(/^-?\d+(\.\d+)?$/)
    await act(async () => editor!.undo())
    expect(editor!.authoredDocument).toEqual(before)
    expect(editor!.canUndo).toBe(false)
  }
  await act(async () => editor!.select([free.id]))
  const bad = await enter('X', '20r')
  expect(bad.validationMessage).toBe('该图层没有可换算的画框坐标')
  expect(editor!.authoredDocument).toEqual(before)
  await act(async () => bad.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(bad.value).toBe('385')
})

test('Sketch stack percentage modes persist, reflow with the parent and undo with their dimensions', async () => {
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank('Relative stack QA')
  const frame = node('frame', 50, 60, 300, 200)
  const fixed = node('rectangle', 0, 0, 50, 80)
  const child = node('rectangle', 0, 0, 40, 35)
  const fill = node('rectangle', 0, 0, 20, 20)
  frame.layout = { ...defaultLayout(), padding: [10, 30, 20, 20], gap: 10 }
  frame.children = [fixed.id, child.id, fill.id]
  fill.sizing = { ...defaultSizing(), width: 'fill' }
  doc.nodes = Object.fromEntries([frame, fixed, child, fill].map(layer => [layer.id, layer]))
  doc.pages[0].children = [frame.id]
  const patch = () => editor!.authoredDocument.nodes[child.id]
  const choose = (label: string, value: string) => act(async () => {
    const select = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!
    expect(select.querySelector(`option[value="${value}"]`)).not.toBeNull()
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const enter = (label: string, value: string) => act(async () => {
    const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
    input.focus()
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(input.validity.customError).toBe(false)
  })
  await act(async () => { editor!.load(doc); editor!.select([child.id]) })
  const initial = editor!.authoredDocument
  await choose('宽度模式', 'relative')
  expect(patch().sizing).toMatchObject({ width: 'relative', widthRatio: 1 })
  expect(patch().width).toBeCloseTo(179.99, 8)
  await act(async () => editor!.undo())
  expect(editor!.authoredDocument).toEqual(initial)
  expect(editor!.canUndo).toBe(false)

  await choose('宽度模式', 'relative')
  await enter('相对宽度 %', '50%')
  await choose('高度模式', 'relative')
  await enter('相对高度 %', '40')
  expect(patch()).toMatchObject({
    width: 125, height: 68, sizing: { width: 'relative', widthRatio: 0.5, height: 'relative', heightRatio: 0.4 },
  })
  const proportional = editor!.authoredDocument
  expect(proportional.schemaVersion).toBe(29)
  expect(proportional.nodes[fill.id].width).toBeCloseTo(55, 8)
  expect(JSON.parse(forma_decode_json(forma_encode_json(JSON.stringify(proportional))))).toEqual(proportional)
  await choose('宽度模式', 'fill')
  expect(patch().sizing?.width).toBe('fill')
  await act(async () => editor!.undo())
  expect(editor!.authoredDocument).toEqual(proportional)

  await act(async () => editor!.select([frame.id]))
  await enter('W', '400')
  expect(patch().width).toBe(175)
  expect(editor!.authoredDocument.nodes[fill.id].width).toBeCloseTo(105, 8)
  await enter('H', '260')
  expect(patch().height).toBe(92)
  await act(async () => { editor!.undo(); editor!.undo() })
  expect(editor!.authoredDocument).toEqual(proportional)
})

test('Sketch stack border option reflows rendered stroke extents and undoes the layout change', async () => {
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank('Stack border layout QA')
  const frame = node('frame', 50, 60, 300, 200)
  const outside = node('rectangle', 0, 0, 55, 80)
  const center = node('rectangle', 0, 0, 40, 60)
  const clean = node('frame', 350, 60, 200, 120)
  const plain = node('rectangle', 0, 0, 60, 40)
  frame.layout = { ...defaultLayout(), padding: [10, 10, 10, 10], gap: 10 }
  frame.sizing = { ...defaultSizing(), width: 'hug', height: 'hug' }
  frame.children = [outside.id, center.id]
  clean.layout = frame.layout
  clean.sizing = frame.sizing
  clean.children = [plain.id]
  outside.strokes = [{ ...stroke('#222222', 10), align: 'outside' }]
  center.strokes = [{ ...stroke('#333333', 10), align: 'center' }]
  doc.nodes = Object.fromEntries([frame, outside, center, clean, plain].map(layer => [layer.id, layer]))
  doc.pages[0].children = [frame.id, clean.id]
  await act(async () => { editor!.load(doc); editor!.select([frame.id]) })
  const authored = () => editor!.authoredDocument
  const boxes = (ids: string[]) => ids.map(id => {
    const layer = authored().nodes[id]
    return [layer.transform[4], layer.transform[5], layer.width, layer.height]
  })
  const toggle = () => act(async () => {
    const label = [...document.querySelectorAll('.layout-panel label')].find(element => element.textContent === '边框计入布局')
    expect(label).toBeDefined()
    label!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()
  })
  const ids = [frame.id, outside.id, center.id]
  const initial = authored(), originalBoxes = boxes(ids)
  expect(originalBoxes).toEqual([[50, 60, 125, 100], [10, 10, 55, 80], [75, 10, 40, 60]])
  const revision = editor!.state.version
  await toggle()
  expect(editor!.state.version).toBe(revision + 1)
  expect(boxes(ids)).toEqual([[50, 60, 155, 120], [20, 20, 55, 80], [100, 15, 40, 60]])
  const enabled = authored()
  expect(enabled.schemaVersion).toBe(30)
  expect(enabled.nodes[frame.id].layout?.bordersAffectLayout).toBe(true)
  expect(JSON.parse(forma_decode_json(forma_encode_json(JSON.stringify(enabled))))).toEqual(enabled)
  await act(async () => editor!.updateProperties([outside.id], {
    strokes: [{ ...enabled.nodes[outside.id].strokes[0], width: 15 }],
  }))
  expect(boxes(ids)).toEqual([[50, 60, 165, 130], [25, 25, 55, 80], [110, 15, 40, 60]])
  await act(async () => editor!.undo())
  expect(authored()).toEqual(enabled)

  await toggle()
  expect(boxes(ids)).toEqual(originalBoxes)
  await act(async () => editor!.undo())
  expect(authored()).toEqual(enabled)
  await act(async () => editor!.undo())
  expect(authored()).toEqual(initial)
  expect(editor!.canUndo).toBe(false)
  await act(async () => editor!.select([clean.id]))
  const noStrokeBoxes = boxes([clean.id, plain.id])
  await toggle()
  expect(boxes([clean.id, plain.id])).toEqual(noStrokeBoxes)
})

test('Sketch overlap order publishes painter order to the layer tree without reversing flow', async () => {
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank('Stacking order QA')
  const frame = node('frame', 50, 60, 300, 200)
  const first = node('rectangle', 0, 0, 60, 70)
  const last = node('rectangle', 0, 0, 70, 60)
  const absolute = node('rectangle', 200, 150, 30, 30)
  frame.name = 'Stacking frame'
  first.name = 'First item'
  last.name = 'Last item'
  absolute.name = 'Absolute item'
  frame.layout = { ...defaultLayout(), padding: [10, 10, 10, 10], gap: -30 }
  frame.children = [first.id, absolute.id, last.id]
  absolute.sizing = { ...defaultSizing(), absolute: true }
  doc.nodes = Object.fromEntries([frame, first, last, absolute].map(layer => [layer.id, layer]))
  doc.pages[0].children = [frame.id]
  await act(async () => { editor!.load(doc); editor!.select([frame.id]) })
  const rootRow = document.querySelector<HTMLElement>('[role="treeitem"][aria-label="Stacking frame"]')!
  if (rootRow.getAttribute('aria-expanded') === 'false') {
    await act(async () => rootRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  }
  const layerNames = () => Array.from(document.querySelectorAll('[role="treeitem"][aria-level="2"]'), row => row.getAttribute('aria-label'))
  const order = (value: string) => act(async () => {
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="重叠顺序"]')!
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const authored = () => editor!.authoredDocument
  const initial = authored()
  const revision = editor!.state.version
  await order('first-on-top')
  expect(editor!.state.version).toBe(revision + 1)
  expect(authored().schemaVersion).toBe(31)
  expect(authored().nodes[frame.id].children).toEqual([last.id, absolute.id, first.id])
  expect(layerNames()).toEqual(['First item', 'Absolute item', 'Last item'])
  for (const item of [first, last, absolute]) expect(authored().nodes[item.id]).toEqual(initial.nodes[item.id])
  const firstOnTop = authored()
  await order('last-on-top')
  expect(layerNames()).toEqual(['Last item', 'Absolute item', 'First item'])
  for (const item of [first, last, absolute]) expect(authored().nodes[item.id]).toEqual(initial.nodes[item.id])
  expect(JSON.parse(forma_decode_json(forma_encode_json(JSON.stringify(authored()))))).toEqual(authored())
  await act(async () => editor!.undo())
  expect(authored()).toEqual(firstOnTop)
  await act(async () => editor!.undo())
  expect(authored()).toEqual(initial)
  expect(editor!.canUndo).toBe(false)
})

test('Sketch rich-text shortcuts format the selected range and later input at a collapsed caret', async () => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank('Text formatting QA'), text = node('text', 60, 80, 240, 60)
  text.text = 'Sketch ABC'
  text.textStyle = defaultTextStyle()
  doc.nodes[text.id] = text
  doc.pages[0].children = [text.id]
  await act(async () => { editor!.load(doc); editor!.select([text.id]); canvas().focus() })
  const before = editor!.authoredDocument
  await key('i', { code: 'KeyI', metaKey: true })
  expect(editor!.authoredDocument).toBe(before)
  const enter = async () => {
    await act(async () => canvas().focus())
    await key('Enter')
    const field = document.querySelector<HTMLTextAreaElement>('.rich-text-editor textarea')!
    expect(document.activeElement).toBe(field)
    return field
  }
  const send = (input: HTMLElement, value: string) => act(async () => input.dispatchEvent(new KeyboardEvent('keydown', {
    key: value, code: value.length === 1 ? `Key${value.toUpperCase()}` : value, metaKey: true, bubbles: true, cancelable: true,
  })))
  let input = await enter()
  await act(async () => input.setSelectionRange(0, 6))
  for (const letter of ['b', 'i', 'u']) await send(input, letter)
  await send(input, 'Enter')
  expect(editor!.authoredDocument.schemaVersion).toBe(27)
  expect(editor!.authoredDocument.nodes[text.id].textRuns).toEqual([{ start: 0, end: 6, weight: 700, italic: true, underline: true }])
  expect(JSON.parse(forma_decode_json(forma_encode_json(JSON.stringify(editor!.authoredDocument))))).toEqual(editor!.authoredDocument)
  await act(async () => editor!.undo())
  expect(editor!.authoredDocument).toEqual(before)
  expect(editor!.canUndo).toBe(false)

  input = await enter()
  await act(async () => input.setSelectionRange(3, 3))
  for (const letter of ['b', 'i', 'u']) await send(input, letter)
  expect(editor!.authoredDocument).toEqual(before)
  await act(async () => {
    input.dispatchEvent(new dom.window.InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: 'k' }))
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Ske' + 'k' + text.text.slice(3))
    input.setSelectionRange(4, 4)
    input.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'k' }))
  })
  await send(input, 'Enter')
  expect(editor!.authoredDocument.nodes[text.id]).toMatchObject({
    text: 'Skektch ABC', textRuns: [{ start: 3, end: 4, weight: 700, italic: true, underline: true }],
  })
  await act(async () => editor!.undo())
  expect(editor!.authoredDocument).toEqual(before)
  expect(editor!.canUndo).toBe(false)
})

test('Sketch Command-T opens the contextual typeface picker and keeps the edit range on Escape', async () => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  applyInterfaceLayout('sketch')
  await render()
  const showPicker = vi.fn()
  Object.defineProperty(dom.window.HTMLSelectElement.prototype, 'showPicker', { value: showPicker, configurable: true })
  const doc = blank('Typeface QA'), text = node('text', 60, 80, 240, 60), shape = node('rectangle', 330, 80, 160, 60)
  text.text = 'Sketch typeface'
  text.textStyle = defaultTextStyle()
  doc.schemaVersion = 4
  doc.fonts = { latin: { family: 'Noto Latin Fixture', data: fontTestBytes('noto-latin').toString('base64'), index: 0 } }
  doc.nodes = { [text.id]: text, [shape.id]: shape }
  doc.pages[0].children = [text.id, shape.id]
  await act(async () => { editor!.load(doc); editor!.select([shape.id]); canvas().focus() })
  const before = editor!.authoredDocument
  const send = (target: HTMLElement, value: string, options: KeyboardEventInit = {}) =>
    act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options })))
  const change = (select: HTMLSelectElement, value: string) => act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const open = (target: HTMLElement) => send(target, 't', { code: 'KeyT', metaKey: true })
  await open(canvas())
  expect(showPicker).not.toHaveBeenCalled()
  await act(async () => editor!.select([text.id]))
  await open(canvas())
  const layerFont = document.querySelector<HTMLSelectElement>('select[data-layer-typeface]')!
  expect(document.activeElement).toBe(layerFont)
  expect(showPicker).toHaveBeenCalledTimes(1)
  await send(layerFont, 'Escape')
  expect(document.activeElement).toBe(canvas())
  expect(editor!.authoredDocument).toBe(before)
  await open(canvas())
  await change(layerFont, 'latin')
  expect(editor!.authoredDocument.nodes[text.id].textStyle?.fontId).toBe('latin')
  await act(async () => editor!.undo())
  expect(editor!.authoredDocument).toEqual(before)

  await send(canvas(), 'Enter')
  const input = document.querySelector<HTMLTextAreaElement>('.rich-text-editor textarea')!
  expect(document.activeElement).toBe(input)
  await act(async () => input.setSelectionRange(0, 6))
  await open(input)
  const runFont = document.querySelector<HTMLSelectElement>('.rich-text-editor select[aria-label="选中文字字体"]')!
  expect(document.activeElement).toBe(runFont)
  await send(runFont, 'Escape')
  expect(document.activeElement).toBe(input)
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 6])
  expect(editor!.authoredDocument).toEqual(before)
  await open(input)
  await change(runFont, 'latin')
  await send(input, 'Enter', { metaKey: true })
  expect(editor!.authoredDocument.nodes[text.id].textRuns).toEqual([{ start: 0, end: 6, fontId: 'latin' }])
  await act(async () => editor!.undo())
  expect(editor!.authoredDocument).toEqual(before)
  expect(editor!.canUndo).toBe(false)
})

test('Sketch combine shortcuts create the expected editable operands through the layout keyboard route', async () => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank('Keyboard booleans'), a = node('rectangle', 40, 60, 90, 80), b = node('rectangle', 80, 60, 90, 80)
  const text = node('text', 240, 60, 90, 80)
  for (const layer of [a, b, text]) { doc.nodes[layer.id] = layer; doc.pages[0].children.push(layer.id) }
  await act(async () => { editor!.load(doc); canvas().focus() })
  const before = editor!.authoredDocument
  const chord = (value: string, letter: string) => key(value, { code: `Key${letter}`, altKey: true, metaKey: true })
  for (const [glyph, letter, operation] of [
    ['å', 'A', 'compoundEvenodd'], ['Dead', 'U', 'union'], ['ß', 'S', 'subtract'],
    ['ˆ', 'I', 'intersect'], ['≈', 'X', 'exclude'],
  ] as const) {
    await act(async () => editor!.select([a.id, b.id]))
    const revision = editor!.state.version
    await chord(glyph, letter)
    const current = editor!.authoredDocument, id = editor!.state.selection[0]
    const result = current.nodes[id]
    expect(result).toMatchObject({ booleanOperation: operation, children: [a.id, b.id] })
    expect(editor!.state.version).toBe(revision + 1)
    if (letter === 'A' || letter === 'U')
      expect(kernelFillWorld(result, { x: 110, y: 80 }, worldMatrix(current, id), 1)).toBe(letter === 'U')
    await act(async () => editor!.undo())
    expect(editor!.authoredDocument).toEqual(before)
    expect(editor!.canUndo).toBe(false)
  }
  await act(async () => editor!.select([a.id, text.id]))
  await chord('ß', 'S')
  expect(editor!.authoredDocument).toEqual(before)
  expect(interfacePreference.getSnapshot().uiMode).toBe('sketch')
  const other = structuredClone(doc), left = node('frame', 0, 0, 240, 180), right = node('frame', 260, 0, 240, 180)
  left.children = [a.id]; right.children = [b.id]
  other.nodes[left.id] = left; other.nodes[right.id] = right
  other.pages[0].children = [left.id, right.id, text.id]
  await act(async () => { applyInterfaceLayout('figma'); editor!.load(other); editor!.select([a.id]) })
  const uncombined = editor!.authoredDocument
  await chord('å', 'A')
  expect(editor!.state.selection).toContain(b.id)
  expect(editor!.authoredDocument).toBe(uncombined)
})

test('Sketch Command-period, the canvas menu and the header toggle the same interface', async () => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  applyInterfaceLayout('sketch')
  await render()
  const minimized = () => document.querySelector('.editor-workspace')!.classList.contains('ui-minimized')
  const toggle = () => key('.', { code: 'Period', metaKey: true })
  const before = editor!.authoredDocument
  await act(async () => { editor!.select([]); canvas().focus() })
  expect(minimized()).toBe(false)
  await toggle()
  expect(minimized()).toBe(true)
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="展开界面"]')!.click())
  expect(minimized()).toBe(false)
  await act(async () => canvas().focus())
  await key('ContextMenu')
  const menuItem = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === '显示/隐藏界面')
  expect(menuItem).toBeDefined()
  await act(async () => menuItem!.click())
  expect(minimized()).toBe(true)
  await act(async () => applyInterfaceLayout('figma'))
  await toggle()
  expect(minimized()).toBe(true)
  await key('\\', { code: 'Backslash', metaKey: true, shiftKey: true })
  expect(minimized()).toBe(false)
  expect(editor!.authoredDocument).toBe(before)
})

test('mounted App capture preserves held-key one-undo and both toolbar/Inspector allow parent alignment', async () => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' })
  await render(); expect(editor).toBeDefined()
  const doc = blank(), frame = node('frame', 0, 0, 300, 200), child = node('rectangle', 30, 40, 50, 60)
  frame.children = [child.id]; doc.nodes = { [frame.id]: frame, [child.id]: child }; doc.pages[0].children = [frame.id]
  await act(async () => { editor!.load(doc); editor!.select([child.id]); nudgePreference.set({ small: .5, big: 5 }); canvas().focus() })
  const before = editor!.state.doc
  for (const repeat of [false, true, true]) await key('ArrowRight', { repeat })
  expect(editor!.interactionActive).toBe(true); expect(editor!.state.doc.nodes[child.id].transform[4]).toBe(31.5)
  await key('ArrowRight', {}, 'keyup'); await act(async () => editor!.undo())
  expect(editor!.state.doc).toEqual(before); expect(editor!.canUndo).toBe(false)
  for (const repeat of [false, true]) await key('ArrowDown', { ctrlKey: true, repeat })
  await key('ArrowDown', {}, 'keyup'); expect(editor!.state.doc.nodes[child.id].height).toBe(61)
  await act(async () => editor!.undo()); expect(editor!.state.doc).toEqual(before); expect(editor!.canUndo).toBe(false)
  expect(document.querySelector<HTMLButtonElement>('.alignment-controls [aria-label="左对齐"]')!.disabled).toBe(false)
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="排列与编辑"]')!.click())
  const align = document.querySelector<HTMLButtonElement>('[role="menu"] [aria-label="左对齐"]')!
  expect(align.disabled).toBe(false); await act(async () => align.click())
  expect(editor!.state.doc.nodes[child.id].transform[4]).toBe(0)
  await act(async () => editor!.undo()); expect(editor!.state.doc).toEqual(before)
})

test.each([
  { desktop: false, layout: 'figma' }, { desktop: true, layout: 'figma' },
  { desktop: false, layout: 'sketch' }, { desktop: true, layout: 'sketch' },
] as const)('mounted $layout menu gates native Sketch with desktop=$desktop and uses Windows shortcuts', async ({ desktop, layout }) => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' })
  applyInterfaceLayout(layout)
  const inspectSketch = vi.fn(async () => ({ status: 'cancelled' as const })), save = vi.fn(async () => ({ status: 'cancelled' as const }))
  const exportFd = vi.spyOn(persistence, 'exportDocument').mockImplementation(() => {})
  let nativeCommand: ((name: any) => void) | undefined
  if (desktop) Object.defineProperty(window, 'coreDesktop', { configurable: true, value: {
    version: 1, renderPolicy: { cpuOnly: true }, inspectSketch, saveDocument: save,
    onCommand: (callback: (name: any) => void) => { nativeCommand = callback; return () => {} }, onCloseRequested: () => () => {}, setDirty: async () => {},
    readRecovery: async () => ({ status: 'cancelled' }), writeRecovery: async () => ({ status: 'ok' }),
  } as unknown as DesktopBridge })
  await render()
  await act(async () => canvas().focus())
  await key('s', { code: 'KeyS', ctrlKey: true })
  if (desktop) {
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ saveAs: false }))
    expect(exportFd).not.toHaveBeenCalled()
    save.mockClear()
  } else {
    expect(exportFd).toHaveBeenCalledExactlyOnceWith(editor!.authoredDocument)
    expect(save).not.toHaveBeenCalled()
  }
  const menu = document.querySelector<HTMLButtonElement>('[aria-label="文件菜单"]')!
  await act(async () => menu.click())
  const manualSave = button('保存设计文件')
  if (layout === 'sketch') {
    expect(manualSave.textContent).toContain('Ctrl+S')
    exportFd.mockClear()
    await act(async () => manualSave.click())
    if (desktop) {
      expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ saveAs: false }))
      save.mockClear()
    } else {
      expect(exportFd).toHaveBeenCalledExactlyOnceWith(editor!.authoredDocument)
    }
    await act(async () => menu.click())
  } else {
    expect(manualSave).toBeUndefined()
    expect(button('导出副本…')).toBeDefined()
  }
  const inspect = button('预览原生 Sketch（只读）'), edit = button('编辑原生 Sketch（有限支持）')
  expect(inspect.disabled).toBe(!desktop); expect(edit.disabled).toBe(true)
  if (!desktop) { expect(inspect.title).toContain('当前宿主未提供'); return }
  expect(button('打开本机设计文件').textContent).toContain('Ctrl+O')
  await act(async () => inspect.click()); expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(inspectSketch).not.toHaveBeenCalled()
  await act(async () => nativeCommand?.('save')); expect(save).not.toHaveBeenCalled()
  await act(async () => { await vi.dynamicImportSettled() })
  await act(async () => button('选择 Sketch 文件…').click()); expect(inspectSketch).toHaveBeenCalledOnce()
  await act(async () => button('取消').click()); expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(menu)
})

test('native undo finalizes only the owned keyboard nudge, while modal text commands retain native input ownership', async () => {
  let command!: (name: any) => void
  const performTextCommand = vi.fn(async (_name: string) => ({ status: 'ok' as const })), save = vi.fn(async () => ({ status: 'cancelled' as const }))
  Object.defineProperty(window, 'coreDesktop', { configurable: true, value: {
    version: 1, renderPolicy: { cpuOnly: true }, performTextCommand, saveDocument: save,
    onCommand: (callback: (name: any) => void) => { command = callback; return () => {} }, onCloseRequested: () => () => {}, setDirty: async () => {},
    readRecovery: async () => ({ status: 'cancelled' }), writeRecovery: async () => ({ status: 'ok' }),
  } as unknown as DesktopBridge })
  await render()
  const doc = blank(), shape = node('rectangle', 20, 30, 100, 80); doc.nodes[shape.id] = shape; doc.pages[0].children = [shape.id]
  await act(async () => { editor!.load(doc); editor!.select([shape.id]); canvas().focus() })
  const before = editor!.state.doc
  await key('ArrowRight'); expect(editor!.interactionActive).toBe(true)
  await act(async () => command('undo')); expect(editor!.state.doc).toEqual(before); expect(editor!.interactionActive).toBe(false)
  await act(async () => { editor!.begin('Unrelated pointer gesture'); editor!.preview({ [shape.id]: { width: 125 } }) })
  const pointerPreview = editor!.state.doc
  await act(async () => command('undo')); expect(editor!.state.doc).toBe(pointerPreview); expect(editor!.interactionActive).toBe(true)
  await act(async () => { editor!.cancel(); document.querySelector<HTMLButtonElement>('[aria-label="文件菜单"]')!.click() })
  await act(async () => button('设置').click())
  const input = document.querySelector<HTMLInputElement>('.nudge-settings input')!
  await act(async () => input.focus())
  for (const name of ['copy', 'cut', 'paste', 'select-all', 'undo', 'redo']) await act(async () => command(name))
  expect(performTextCommand.mock.calls.map(args => args[0])).toEqual(['copy', 'cut', 'paste', 'selectAll', 'undo', 'redo'])
  await act(async () => command('save')); expect(save).not.toHaveBeenCalled(); expect(editor!.state.doc).toEqual(before)
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')!.focus())
  await act(async () => { command('delete'); command('copy') }); expect(editor!.state.doc).toEqual(before)
  expect(performTextCommand).toHaveBeenCalledTimes(6)
})

test('mounted App workspace rail preserves section on pending-input veto, busy state and active interaction', async () => {
  const { registerPendingEdit } = await import('./pending-edits')
  await render(); expect(editor).toBeDefined()
  const assets = () => document.querySelector<HTMLButtonElement>('.workspace-rail [title="组件与资源"]')!
  const layers = () => document.querySelector<HTMLButtonElement>('.workspace-rail [title="页面与图层"]')!
  let valid = false, dirty = true
  const commit = vi.fn(() => { if (valid) dirty = false; return valid })
  const unregister = registerPendingEdit(editor!, { dirty: () => dirty, commit })
  try {
    await act(async () => assets().click())
    expect(commit).toHaveBeenCalledOnce(); expect(layers().getAttribute('aria-pressed')).toBe('true')
    expect(dirty).toBe(true)
    await act(async () => editor!.set({ busy: true }))
    await act(async () => assets().click())
    expect(commit).toHaveBeenCalledOnce(); expect(layers().getAttribute('aria-pressed')).toBe('true')
    await act(async () => { editor!.set({ busy: false }); editor!.begin('Active pointer input') })
    await act(async () => assets().click())
    expect(commit).toHaveBeenCalledOnce(); expect(layers().getAttribute('aria-pressed')).toBe('true')
    await act(async () => editor!.cancel())
    valid = true
    await act(async () => assets().click())
    expect(commit).toHaveBeenCalledTimes(2); expect(assets().getAttribute('aria-pressed')).toBe('true')
    expect(dirty).toBe(false); expect(editor!.canUndo).toBe(false)
  } finally { unregister() }
})

test.each([false, true])('Shift+Mod+N never becomes new-document; Sketch page shortcut is desktop-only (%s)', async desktop => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  let nativeCommand: ((name: any) => void) | undefined
  if (desktop) Object.defineProperty(window, 'coreDesktop', { configurable: true, value: {
    version: 1, renderPolicy: { cpuOnly: true },
    onCommand: (callback: (name: any) => void) => { nativeCommand = callback; return () => {} },
    onCloseRequested: () => () => {}, setDirty: async () => {},
    readRecovery: async () => ({ status: 'cancelled' }), writeRecovery: async () => ({ status: 'ok' }),
  } as unknown as DesktopBridge })
  await render(); await act(async () => canvas().focus())
  const replace = vi.spyOn(DesktopSession.prototype, 'replace').mockResolvedValue(false)
  const open = vi.spyOn(DesktopSession.prototype, 'open').mockResolvedValue(false)
  const before = editor!.state.doc
  await act(async () => shortcutPreference.set('figma-like'))
  await key('N', { code: 'KeyN', metaKey: true, shiftKey: true })
  expect(editor!.state.doc).toBe(before)
  await key('N', { code: 'KeyN', metaKey: true, altKey: true })
  expect(editor!.state.doc).toBe(before)
  await key('O', { code: 'KeyO', metaKey: true, shiftKey: true })
  expect(open).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled()
  await act(async () => shortcutPreference.set('sketch-like'))
  const pageEvent = new KeyboardEvent('keydown', { key: 'N', code: 'KeyN', metaKey: true, shiftKey: true, bubbles: true, cancelable: true })
  await act(async () => canvas().dispatchEvent(pageEvent))
  expect(pageEvent.defaultPrevented).toBe(desktop)
  expect(replace).not.toHaveBeenCalled()
  expect(editor!.state.doc.id).toBe(before.id)
  expect(editor!.state.doc.pages).toHaveLength(before.pages.length + (desktop ? 1 : 0))
  if (!desktop) { expect(editor!.state.doc).toBe(before); return }
  const added = editor!.state.doc
  await key('N', { code: 'KeyN', metaKey: true, shiftKey: true, repeat: true })
  expect(editor!.state.doc).toBe(added)
  await act(async () => editor!.undo()); expect(editor!.state.doc).toEqual(before)
  // The accelerator-free native menu enters the same guarded editor command.
  await act(async () => nativeCommand?.('new-page'))
  expect(editor!.state.doc.id).toBe(before.id); expect(editor!.state.doc.pages).toHaveLength(2)
  const input = document.createElement('input'); document.body.append(input); await act(async () => input.focus())
  const afterMenu = editor!.state.doc
  await act(async () => nativeCommand?.('new-page'))
  expect(editor!.state.doc).toBe(afterMenu)
  await act(async () => { input.remove(); canvas().focus() })
  await key('n', { code: 'KeyN', metaKey: true }); expect(replace).toHaveBeenCalledOnce()
})

test('a pending native FD opened at startup enters its editor directly', async () => {
  const incoming = blank('Queued native design')
  const shape = node('rectangle', 20, 30, 80, 50)
  incoming.nodes[shape.id] = shape
  incoming.pages[0].children = [shape.id]
  const acceptDocument = vi.fn(async () => ({ status: 'ok' as const }))
  const openPendingDocument = vi.fn()
    .mockResolvedValue({ status: 'cancelled' })
    .mockResolvedValueOnce({
      status: 'ok', handle: 'opaque:queued', displayName: 'queued.fd', documentJson: JSON.stringify(incoming),
    })
  Object.defineProperty(window, 'coreDesktop', { configurable: true, value: {
    version: 1, renderPolicy: { cpuOnly: true }, openPendingDocument, acceptDocument,
    onCommand: () => () => {}, onCloseRequested: () => () => {}, setDirty: async () => {},
    readRecovery: async () => ({ status: 'cancelled' }), clearRecovery: async () => ({ status: 'ok' }),
  } as unknown as DesktopBridge })
  await act(async () => { root.render(<App />); for (let i = 0; i < 30; i++) await Promise.resolve() })
  expect(acceptDocument).toHaveBeenCalledExactlyOnceWith({ handle: 'opaque:queued' })
  expect(editor!.authoredDocument.id).toBe(incoming.id)
  expect(document.querySelector('.local-home')).toBeNull()
  expect(canvas()).not.toBeNull()
})

test('source workset uses normal App panels and never enters FD recovery or browser autosave',async()=>{
 const sourceEditor=new Editor(blank('Loaded board')),layer=node('rectangle',0,0,80,80)
 sourceEditor.change('fixture',doc=>{doc.nodes[layer.id]=layer;doc.pages[0].children=[layer.id]})
 editor=sourceEditor
 const start=vi.spyOn(DesktopSession.prototype,'start'),save=vi.fn(async()=>{}),exportFile=vi.fn(async()=>{})
 Object.defineProperty(window,'coreDesktop',{configurable:true,value:{version:1,renderPolicy:{cpuOnly:true},
  onCommand:()=>()=>{},onCloseRequested:()=>()=>{},setDirty:async()=>({status:'ok'})}as unknown as DesktopBridge})
 const source:import('./LargeDocumentWorkspace').SourceWorkspace={prepareExport:open=>open(),editor:sourceEditor,ready:true,busy:false,locked:false,dirty:false,
  name:'Full source.sketch',notice:'Loaded board',error:'',canvas:{current:null},navigation:<nav>Source pages</nav>,showLayers:true,warnings:[],
  dismissWarnings(){},cancel(){},save,exportFile,leave:async()=>{},openFile:async()=>{}}
 await act(async()=>{root.render(<App sourceWorkspace={source}/>);for(let i=0;i<30;i++)await Promise.resolve()})
 expect(document.querySelector('.app-shell[data-source-document="true"]')).not.toBeNull()
 expect(document.querySelector('.editor-workspace .layers-panel')).not.toBeNull()
 expect(document.querySelector('.layers-panel .pages')).toBeNull()
 expect(document.querySelector('.layers-panel .pages-actions')).toBeNull()
 expect(canvas()).not.toBeNull();expect(document.querySelector('.source-workspace')).toBeNull()
 expect(document.querySelector<HTMLInputElement>('[aria-label="文档名称"]')!.value).toBe('Full source.sketch')
 await act(async()=>sourceEditor.updateProperties([layer.id],n=>{n.width=90}))
 await act(async()=>new Promise(resolve=>setTimeout(resolve,450)))
 expect(start).not.toHaveBeenCalled();expect(localStore.localOpen).not.toHaveBeenCalled()
 expect(localStore.SaveCoordinator.prototype.save).not.toHaveBeenCalled();expect(startupPreview.readStartupPreview).not.toHaveBeenCalled()
 expect(document.querySelector('.header-right .save-status')).not.toBeNull()
 const menu=document.querySelector<HTMLButtonElement>('[aria-label="文件菜单"]')!
 await act(async()=>menu.click())
 await act(async()=>button('保存修改').click());expect(save).toHaveBeenCalledOnce()
 await act(async()=>menu.click())
 await act(async()=>button('导出完整文件…').click());expect(exportFile).toHaveBeenCalledOnce()
 expect(localStore.SaveCoordinator.prototype.save).not.toHaveBeenCalled()
})
