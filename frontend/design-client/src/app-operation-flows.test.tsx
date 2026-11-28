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
import { blank, defaultLayout, defaultLayoutGrid, defaultSizing, defaultTextStyle, effect, node, paint, stroke, uid } from './model'
import { copyProperties } from './property-clipboard'
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

test('German Figma comma reaches Quick actions and returns to Settings in the generic layout', async () => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  const setFigmaKeyboardLayout = vi.fn().mockResolvedValue({ status: 'ok' })
  Object.defineProperty(window, 'coreDesktop', { configurable: true, value: {
    version: 1, renderPolicy: { cpuOnly: true }, onCommand: () => () => {}, onCloseRequested: () => () => {},
    setDirty: async () => ({}), readRecovery: async () => ({ status: 'cancelled' }), writeRecovery: async () => ({ status: 'ok' }),
    setFigmaKeyboardLayout,
  } as unknown as DesktopBridge })
  interfacePreference.set({ uiMode: 'figma', figmaKeyboardLayout: 'de-qwertz' })
  await render()
  expect(setFigmaKeyboardLayout).toHaveBeenLastCalledWith('de-qwertz')
  const before = editor!.authoredDocument, version = editor!.state.version
  await act(async () => canvas().focus())
  await key(',', { code: 'Comma', metaKey: true })
  expect(document.querySelector('.command-search-dialog')).toBeTruthy()
  expect(document.querySelector('.settings-dialog')).toBeNull()
  expect(document.querySelector('.app-settings-button')?.getAttribute('title')).toBe('设置')
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.querySelector('.command-search-dialog')).toBeNull()
  await act(async () => interfacePreference.set({ figmaKeyboardLayout: 'us-qwerty' }))
  expect(setFigmaKeyboardLayout).toHaveBeenLastCalledWith('us-qwerty')
  await key(',', { code: 'Comma', metaKey: true })
  expect(document.querySelector('.settings-dialog')).toBeTruthy()
  expect(editor!.authoredDocument).toBe(before)
  expect(editor!.state.version).toBe(version)
  expect(editor!.canUndo).toBe(false)
})

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
    expect(document.querySelector('#design-properties-tab')?.getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector('.sketch-interaction-panel')).toBeNull()
    await key('i', { code: 'KeyI' })
    expect(editor!.state.tool).toBe('hotspot')
    expect(document.querySelector('#prototype-properties-tab')?.getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector('.sketch-interaction-panel')).not.toBeNull()
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
    const target = document.querySelector<HTMLSelectElement>('.sketch-interaction-panel [aria-label="链接到"]')!
    expect(target.value).toBe('')
    await act(async () => { target.value = frame.id; target.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(editor!.authoredDocument.prototype?.interactions[hotspot.id][0].actions).toEqual([{ kind: 'navigate', target: frame.id, transitionStyle: 'none' }])
    await act(async () => editor!.undo())
    expect(editor!.authoredDocument).toEqual(committed)
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

test('Sketch parents a drawn shape at its start point while Figma uses its center', async () => {
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank('Shape placement'), frame = node('frame', 100, 60, 200, 180)
  doc.nodes[frame.id] = frame; doc.pages[0].children = [frame.id]
  await act(async () => { editor!.load(doc) })
  const before = editor!.authoredDocument
  await act(async () => editor!.set({ view: { x: 0, y: 0, zoom: 1 } }))
  dom.window.HTMLElement.prototype.setPointerCapture = () => undefined
  dom.window.HTMLElement.prototype.hasPointerCapture = () => false
  const draw = async () => {
    await act(async () => { editor!.set({ tool: 'rectangle' }); canvas().focus() })
    for (const [type, x, y] of [['pointerdown', 275, 190], ['pointerup', 365, 220]] as const) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })
      Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: 'mouse' } })
      await act(async () => canvas().dispatchEvent(event))
    }
    return editor!.state.selection[0]
  }
  const sketch = await draw()
  expect(editor!.state.doc.nodes[frame.id].children).toEqual([sketch])
  expect(worldMatrix(editor!.state.doc, sketch).slice(4)).toEqual([275, 190])
  await act(async () => editor!.undo())
  expect(editor!.authoredDocument).toEqual(before)
  await act(async () => applyInterfaceLayout('figma'))
  const figma = await draw()
  expect(editor!.state.doc.pages[0].children).toEqual([frame.id, figma])
  expect(worldMatrix(editor!.state.doc, figma).slice(4)).toEqual([275, 190])
  await act(async () => editor!.undo())
  expect(editor!.authoredDocument).toEqual(before)
  expect(editor!.canUndo).toBe(false)
})

test('changing editor layouts retires tools missing from the target toolbar', async () => {
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank('Layout tools'), layer = node('rectangle', 90, 60, 140, 120)
  doc.nodes[layer.id] = layer; doc.pages[0].children = [layer.id]
  await act(async () => editor!.load(doc))
  const view = { x: 23, y: -67, zoom: 1.4 }
  await act(async () => { editor!.select([layer.id]); editor!.set({ view, tool: 'graphic' }) })
  const before = editor!.authoredDocument, revision = editor!.state.version
  const switchMode = (name: string) => act(async () => {
    const control = Array.from(document.querySelectorAll<HTMLButtonElement>('.ui-mode-switch button')).find(button => button.textContent === name)!
    control.click()
  })
  await switchMode('Figma')
  expect(editor!.state.tool).toBe('select')
  await act(async () => document.querySelector<HTMLButtonElement>('.figma-toolbelt-mode [aria-label="绘制"]')!.click())
  for (const tool of ['marker', 'washi-tape'] as const) {
    await act(async () => editor!.set({ tool }))
    await switchMode('Sketch')
    expect(editor!.state.tool).toBe('select')
    await switchMode('Figma')
  }
  await act(async () => editor!.set({ tool: 'rectangle' }))
  await switchMode('Sketch')
  expect(editor!.state.tool).toBe('rectangle')
  expect(editor!.state.selection).toEqual([layer.id])
  expect(editor!.state.view).toEqual(view)
  expect(editor!.state.page).toBe(doc.pages[0].id)
  expect(editor!.authoredDocument).toBe(before)
  expect(editor!.state.version).toBe(revision)
  expect(editor!.canUndo).toBe(false)
})

test('layout switch preserves the page and uses the target layout frame behavior', async () => {
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank('Frame layouts'), page = doc.pages[0], alternate = uid()
  const first = node('rectangle', 80, 70, 35, 40), second = node('rectangle', 140, 90, 45, 35)
  const locked = node('rectangle', 110, 125, 25, 25), partial = node('rectangle', 200, 180, 75, 55)
  locked.locked = true
  for (const n of [first, second, locked, partial]) doc.nodes[n.id] = n
  page.children = [first.id, second.id, locked.id, partial.id]
  doc.pages.push({ id: alternate, name: 'Second page', background: '#ffffff', children: [] })
  const view = { x: 0, y: 0, zoom: 1 }
  await act(async () => { editor!.load(doc) })
  await act(async () => { editor!.select([first.id]); editor!.set({ view, tool: 'frame' }); canvas().focus() })
  const before = editor!.authoredDocument
  const pointer = (type: string, x: number, y: number) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })
    Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: 'mouse' } })
    canvas().dispatchEvent(event)
  }
  dom.window.HTMLElement.prototype.setPointerCapture = () => undefined
  dom.window.HTMLElement.prototype.hasPointerCapture = () => false
  const draw = async (endX: number, endY: number) => {
    expect(editor!.state.tool).toBe('frame')
    const revision = editor!.state.version
    await act(async () => pointer('pointerdown', 50, 40))
    await act(async () => pointer('pointerup', endX, endY))
    expect(editor!.state.version).toBe(revision + 1)
    return editor!.state.doc.nodes[editor!.state.selection[0]]
  }
  expect(document.querySelector(`[data-layer-drop-page="${alternate}"]`)).not.toBeNull()
  const sketchFrame = await draw(235, 205)
  expect(sketchFrame.children).toEqual([first.id, second.id])
  expect(editor!.state.doc.pages[0].children).toEqual([locked.id, partial.id, sketchFrame.id])
  expect(worldMatrix(editor!.state.doc, first.id)).toEqual(worldMatrix(before, first.id))
  expect(worldMatrix(editor!.state.doc, second.id)).toEqual(worldMatrix(before, second.id))
  expect(sketchFrame.clip).toBe(true)
  await act(async () => editor!.undo())
  expect(editor!.authoredDocument).toEqual(before)
  expect(editor!.canUndo).toBe(false)

  await act(async () => editor!.set({ tool: 'frame' }))
  const inserted = await draw(50, 40)
  expect(inserted.children).toEqual([])
  expect(inserted.clip).toBe(false)
  await act(async () => editor!.undo())
  await act(async () => applyInterfaceLayout('figma'))
  expect(editor!.authoredDocument).toEqual(before)
  expect(editor!.state.page).toBe(page.id)
  expect(editor!.state.selection).toEqual([first.id])
  expect(editor!.state.view).toEqual(view)
  await act(async () => editor!.set({ tool: 'frame' }))
  const figmaFrame = await draw(235, 205)
  expect(figmaFrame.children).toEqual([])
  expect(editor!.state.doc.pages[0].children).toEqual([...page.children, figmaFrame.id])
  await act(async () => editor!.undo())
  expect(editor!.authoredDocument).toEqual(before)
  expect(editor!.canUndo).toBe(false)
})

test('Sketch layer pointer drop and context menu move a selection to another page', async () => {
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank('Page move'), source = doc.pages[0], destination = uid()
  const parent = node('frame', 0, 0, 220, 160)
  parent.transform = [0.8, 0.6, -0.4, 1.2, 140, -60]
  const child = node('rectangle', 20, 15, 50, 40), locked = node('rectangle', 190, 20, 30, 30)
  locked.locked = true
  parent.children = [child.id]
  for (const layer of [parent, child, locked]) doc.nodes[layer.id] = layer
  source.children = [parent.id, locked.id]
  doc.pages.push({ id: destination, name: 'Destination', background: '#ffffff', children: [] })
  await act(async () => { editor!.load(doc); editor!.select([child.id]) })
  const before = editor!.authoredDocument, revision = editor!.state.version
  const target = document.querySelector<HTMLElement>(`[data-layer-drop-page="${destination}"]`)!
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => target })
  dom.window.HTMLElement.prototype.setPointerCapture = () => undefined
  dom.window.HTMLElement.prototype.hasPointerCapture = () => false
  const row = () => document.querySelector<HTMLElement>(`[data-layer-id="${child.id}"]`)!
  const pointer = (type: string, x: number) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 20 })
    Object.defineProperty(event, 'pointerId', { value: 1 })
    return row().dispatchEvent(event)
  }
  const menu = () => document.querySelector<HTMLButtonElement>('[data-page-picker]')
  const openMenu = () => act(async () => row().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })))

  await act(async () => { editor!.select([child.id, locked.id]); pointer('pointerdown', 10); pointer('pointermove', 30) })
  expect(target.getAttribute('data-layer-drop-target')).toBeNull()
  await act(async () => { pointer('pointerup', 30) })
  expect(editor!.authoredDocument).toBe(before)
  await openMenu()
  expect(menu()?.disabled).toBe(true)
  await act(async () => menu()!.parentElement!.closest('[role="menu"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))

  await act(async () => { editor!.select([child.id]); pointer('pointerdown', 10); pointer('pointermove', 30) })
  expect(target.getAttribute('data-layer-drop-target')).toBe('true')
  await act(async () => { pointer('pointerup', 30) })
  expect(editor!.state.page).toBe(destination)
  expect(editor!.state.selection).toEqual([child.id])
  expect(editor!.state.version).toBe(revision + 1)
  expect(editor!.state.doc.pages[1].children).toEqual([child.id])
  expect(worldMatrix(editor!.state.doc, child.id)).toEqual(worldMatrix(before, child.id))
  await act(async () => editor!.undo())
  expect(editor!.state.page).toBe(source.id)
  expect(editor!.authoredDocument).toEqual(before)
  expect(editor!.canUndo).toBe(false)

  await openMenu()
  expect(menu()?.disabled).toBe(false)
  await act(async () => menu()!.click())
  const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(el => el.textContent === 'Destination')!
  await act(async () => item.click())
  expect(editor!.state.page).toBe(destination)
  expect(editor!.state.selection).toEqual([child.id])
})

test('Sketch Option-click aligns and previews against the common top-level frame', async () => {
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank('Align to outer frame')
  const outer = node('frame', 100, 50, 300, 200)
  const inner = node('frame', 40, 35, 160, 110)
  const child = node('rectangle', 25, 20, 40, 30)
  const sibling = node('rectangle', 190, 45, 50, 50)
  const outside = node('rectangle', 500, 80, 35, 35)
  outer.children = [inner.id, sibling.id]
  inner.children = [child.id]
  inner.clip = false
  for (const n of [outer, inner, child, sibling, outside]) doc.nodes[n.id] = n
  doc.pages[0].children = [outer.id, outside.id]
  await act(async () => { editor!.load(doc); editor!.select([child.id]); canvas().focus() })
  const before = editor!.authoredDocument
  const align = (name: string) => document.querySelector<HTMLButtonElement>(`.sketch-inspector-alignment [aria-label="${name}"]`)!
  const click = (name: string, altKey = false) => act(async () => align(name).dispatchEvent(new MouseEvent('click', { bubbles: true, altKey })))
  const option = (pressed: boolean) => key('Alt', { code: 'AltLeft', altKey: pressed }, pressed ? 'keydown' : 'keyup')
  const x = (id: string) => editor!.state.doc.nodes[id].transform[4]
  const previewX = () => Number(canvas().querySelector('[data-testid="arrangement-preview"] rect')?.getAttribute('x'))
  await act(async () => align('左对齐').dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
  expect(previewX()).toBe(140)
  await option(true)
  expect(previewX()).toBe(100)
  await click('左对齐', true)
  expect(x(child.id)).toBe(-40)
  expect(editor!.state.doc.nodes[inner.id].children).toEqual([child.id])
  await option(false)
  await act(async () => editor!.undo())
  expect(editor!.authoredDocument).toEqual(before)
  await click('左对齐')
  expect(x(child.id)).toBe(0)
  await act(async () => editor!.undo())

  await act(async () => editor!.select([child.id, sibling.id]))
  await click('右对齐', true)
  expect([x(child.id), x(sibling.id)]).toEqual([220, 250])
  await act(async () => editor!.undo())
  await act(async () => editor!.select([outside.id]))
  expect(align('左对齐').disabled).toBe(true)
  await option(true)
  expect(align('左对齐').disabled).toBe(false)
  await click('左对齐', true)
  expect(editor!.state.message).toContain('同一个顶层画框')
  expect(editor!.authoredDocument).toEqual(before)
  expect(editor!.canUndo).toBe(false)
  await option(false)
})

test('Sketch align hover uses the reference layer and leaves history untouched until clicked', async () => {
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank('Align preview')
  const first = node('rectangle', 50, 60, 40, 30)
  const middle = node('rectangle', 110, 120, 45, 35)
  const last = node('rectangle', 260, 250, 60, 40)
  for (const n of [first, middle, last]) doc.nodes[n.id] = n
  const ids = [first.id, middle.id, last.id]
  doc.pages[0].children = ids
  await act(async () => { editor!.load(doc); editor!.select(ids); editor!.set({ alignmentReference: middle.id }); canvas().focus() })
  const before = editor!.authoredDocument, revision = editor!.state.version
  const align = () => document.querySelector<HTMLButtonElement>('.sketch-inspector-alignment [aria-label="左对齐"]')!
  const preview = () => [...canvas().querySelectorAll('[data-testid="arrangement-preview"] rect')]
  const hover = () => act(async () => align().dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
  await hover()
  expect(preview().map(rect => Number(rect.getAttribute('x')))).toEqual([110, 110])
  expect(editor!.authoredDocument).toBe(before)
  expect(editor!.state.version).toBe(revision)
  await act(async () => align().dispatchEvent(new MouseEvent('pointerout', { bubbles: true })))
  expect(preview()).toHaveLength(0)
  await hover()
  await key('Escape', { code: 'Escape' })
  expect(preview()).toHaveLength(0)
  expect(editor!.state.selection).toEqual(ids)

  await act(async () => editor!.set({ busy: true }))
  await hover()
  expect(preview()).toHaveLength(0)
  await act(async () => editor!.set({ busy: false }))
  await hover()
  expect(preview()).toHaveLength(2)
  await act(async () => align().click())
  expect(ids.map(id => editor!.state.doc.nodes[id].transform[4])).toEqual([110, 110, 110])
  expect(preview()).toHaveLength(0)
  expect(editor!.state.version).toBe(revision + 1)
  await act(async () => editor!.undo())
  expect(editor!.authoredDocument).toEqual(before)
  expect(editor!.canUndo).toBe(false)
})

test('Sketch Tidy previews its destination, then commits the same arrangement in one step', async () => {
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank('Tidy selection')
  const first = node('rectangle', 0, 0, 10, 10)
  const middle = node('rectangle', 4, 30, 10, 10)
  const last = node('rectangle', 1, 50, 10, 10)
  for (const n of [first, middle, last]) doc.nodes[n.id] = n
  doc.pages[0].children = [first.id, middle.id, last.id]
  await act(async () => { editor!.load(doc); editor!.select([first.id]); canvas().focus() })
  const tidy = () => document.querySelector<HTMLButtonElement>('[aria-label="整理"]')!
  expect(tidy().disabled).toBe(true)
  await act(async () => editor!.select([first.id, middle.id, last.id]))
  expect(tidy().disabled).toBe(false)
  const before = editor!.authoredDocument, revision = editor!.state.version
  const hover = () => act(async () => tidy().dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
  const previews = () => [...canvas().querySelectorAll('[data-testid="arrangement-preview"] rect')]
  await hover()
  expect(previews().length).toBe(3)
  expect(editor!.authoredDocument).toBe(before)
  expect(editor!.state.version).toBe(revision)
  await key('Escape', { code: 'Escape' })
  expect(previews()).toHaveLength(0)
  expect(editor!.state.selection).toEqual([first.id, middle.id, last.id])
  await hover()
  const destinations = previews().map(rect => [rect.getAttribute('data-node-id')!, Number(rect.getAttribute('x')), Number(rect.getAttribute('y'))] as const)
  expect(destinations).toEqual([[first.id, 2, 0], [middle.id, 2, 25], [last.id, 2, 50]])
  await act(async () => tidy().click())
  expect(previews()).toHaveLength(0)
  for (const [id, x, y] of destinations) expect(editor!.state.doc.nodes[id].transform.slice(4)).toEqual([x, y])
  expect(editor!.state.version).toBe(revision + 1)
  await act(async () => editor!.undo())
  expect(editor!.authoredDocument).toEqual(before)
  expect(editor!.canUndo).toBe(false)
  await act(async () => applyInterfaceLayout('figma'))
  expect(tidy()).toBeNull()
})

test('Sketch Tidy exposes the uneven row spacing beside its button with one-step undo', async () => {
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank('Tidy spacing')
  const row = [0, 50, 90].map((x, index) => node('rectangle', x, [0, 2, 1][index], 20, 20))
  doc.nodes = Object.fromEntries(row.map(layer => [layer.id, layer]))
  doc.pages[0].children = row.map(layer => layer.id)
  await act(async () => { editor!.load(doc); editor!.select(row.map(layer => layer.id)); canvas().focus() })
  const tidy = document.querySelector<HTMLButtonElement>('[aria-label="整理"]')!
  expect(tidy.disabled).toBe(false)
  const alignment = document.querySelector('.sketch-inspector-alignment')!
  const spacing = alignment.querySelector<HTMLInputElement>('input[aria-label="水平间距"]')!
  expect(spacing).not.toBeNull()
  expect(document.querySelector('.inspector-scroll .selection-spacing-fields')).toBeNull()
  const before = editor!.authoredDocument
  const revision = editor!.state.version
  await act(async () => {
    spacing.focus()
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(spacing, '24')
    spacing.dispatchEvent(new Event('input', { bubbles: true }))
    spacing.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  expect(row.map(layer => editor!.state.doc.nodes[layer.id].transform[4])).toEqual([0, 44, 88])
  expect(editor!.state.version).toBe(revision + 1)
  await act(async () => editor!.undo())
  expect(editor!.authoredDocument).toEqual(before)
  expect(editor!.canUndo).toBe(false)
  await act(async () => applyInterfaceLayout('figma'))
})

test('Sketch Tidy spacing exposes an uneven column on the vertical axis', async () => {
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank('Tidy column spacing')
  const column = [0, 50, 90].map((y, index) => node('rectangle', [0, 2, 1][index], y, 20, 20))
  doc.nodes = Object.fromEntries(column.map(layer => [layer.id, layer]))
  doc.pages[0].children = column.map(layer => layer.id)
  await act(async () => { editor!.load(doc); editor!.select(column.map(layer => layer.id)); canvas().focus() })
  const alignment = document.querySelector('.sketch-inspector-alignment')!
  const spacing = alignment.querySelector<HTMLInputElement>('input[aria-label="垂直间距"]')!
  expect(spacing).not.toBeNull()
  expect(alignment.querySelector('input[aria-label="水平间距"]')).toBeNull()
  expect(document.querySelector('.inspector-scroll .selection-spacing-fields')).toBeNull()
  const before = editor!.authoredDocument
  const revision = editor!.state.version
  await act(async () => {
    spacing.focus()
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(spacing, '24')
    spacing.dispatchEvent(new Event('input', { bubbles: true }))
    spacing.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  expect(column.map(layer => editor!.state.doc.nodes[layer.id].transform.slice(4))).toEqual([[0, 0], [2, 44], [1, 88]])
  expect(editor!.state.version).toBe(revision + 1)
  expect(editor!.state.message).toBe('调整智能选区间距')
  await act(async () => editor!.undo())
  expect(editor!.authoredDocument).toEqual(before)
  expect(editor!.canUndo).toBe(false)
  await act(async () => applyInterfaceLayout('figma'))
})

test('Sketch Tidy spacing keeps an even row editable and holds the zero lower bound', async () => {
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank('Tidy even spacing')
  const row = [0, 40, 80].map(x => node('rectangle', x, 10, 20, 20))
  doc.nodes = Object.fromEntries(row.map(layer => [layer.id, layer]))
  doc.pages[0].children = row.map(layer => layer.id)
  await act(async () => { editor!.load(doc); editor!.select(row.map(layer => layer.id)); canvas().focus() })
  const alignment = document.querySelector('.sketch-inspector-alignment')!
  const spacing = alignment.querySelector<HTMLInputElement>('input[aria-label="水平间距"]')!
  expect(spacing.value).toBe('20')
  expect(spacing.getAttribute('aria-valuemin')).toBe('0')
  expect(document.querySelector('.inspector-scroll .selection-spacing-fields')).toBeNull()
  const before = editor!.authoredDocument
  const revision = editor!.state.version
  const enter = async (value: string) => act(async () => {
    spacing.focus()
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(spacing, value)
    spacing.dispatchEvent(new Event('input', { bubbles: true }))
    spacing.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  // Negative gaps stay rejected until a Mac Sketch comparison proves native
  // behavior; the field never mutates the document through the 0 lower bound.
  await enter('-5')
  expect(editor!.state.version).toBe(revision)
  expect(row.map(layer => editor!.state.doc.nodes[layer.id].transform[4])).toEqual([0, 40, 80])
  await act(async () => spacing.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  await enter('30')
  expect(row.map(layer => editor!.state.doc.nodes[layer.id].transform[4])).toEqual([0, 50, 100])
  expect(editor!.state.version).toBe(revision + 1)
  expect(editor!.state.message).toBe('调整智能选区间距')
  await act(async () => editor!.undo())
  expect(editor!.authoredDocument).toEqual(before)
  expect(editor!.canUndo).toBe(false)
  await act(async () => applyInterfaceLayout('figma'))
})

test('Sketch Shift+Command+D duplicates directly behind the original and preserves undo', async () => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank('Duplicate behind')
  const back = node('rectangle', 20, 20, 80, 80)
  const original = node('rectangle', 60, 50, 100, 100)
  const front = node('rectangle', 90, 80, 60, 60)
  front.locked = true
  for (const n of [back, original, front]) doc.nodes[n.id] = n
  doc.pages[0].children = [back.id, original.id, front.id]
  await act(async () => { editor!.load(doc); editor!.select([front.id]); canvas().focus() })
  const before = editor!.authoredDocument
  const duplicate = (shiftKey = true) => key('d', { code: 'KeyD', metaKey: true, shiftKey })
  await duplicate()
  expect(editor!.authoredDocument).toBe(before)
  await act(async () => editor!.select([original.id]))

  const input = document.createElement('input')
  await act(async () => { document.body.append(input); input.focus() })
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'D', code: 'KeyD', metaKey: true, shiftKey: true, bubbles: true,
  })))
  expect(editor!.authoredDocument).toBe(before)
  await act(async () => { input.remove(); canvas().focus() })

  await duplicate()
  const copyBehind = editor!.state.selection[0]
  expect(editor!.state.doc.pages[0].children).toEqual([back.id, copyBehind, original.id, front.id])
  await act(async () => editor!.undo())
  expect(editor!.authoredDocument).toEqual(before)
  await duplicate(false)
  expect(editor!.state.doc.pages[0].children).toEqual([back.id, original.id, editor!.state.selection[0], front.id])
})

test('Sketch Control+Option+Command+V pastes style while preserving target corners', async () => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank('Paste style')
  doc.schemaVersion = 7
  const source = node('star', 60, 40, 100, 90)
  source.fills = [paint('#ee0066')]
  source.strokes = [stroke('#113399', 4)]
  source.effects = [effect('shadow')]
  source.cornerRadius = 8
  source.radii = [12, 12, 12, 12]
  source.smoothing = 0.7
  const rectangle = node('rectangle', 230, 40, 100, 90)
  rectangle.radii = [2, 4, 6, 8]
  rectangle.smoothing = 0.2
  const polygon = node('polygon', 400, 40, 100, 90)
  polygon.cornerRadius = 3
  for (const n of [source, rectangle, polygon]) doc.nodes[n.id] = n
  doc.pages[0].children = [source.id, rectangle.id, polygon.id]
  const readText = async () => copyProperties(doc, source.id)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText } })
  await act(async () => { editor!.load(doc); editor!.select([rectangle.id, polygon.id]); canvas().focus() })
  const before = editor!.authoredDocument, revision = editor!.state.version
  const pasted = (id: string) => editor!.state.doc.nodes[id]
  await key('v', { code: 'KeyV', metaKey: true, altKey: true, ctrlKey: true })
  for (const id of [rectangle.id, polygon.id]) {
    expect(pasted(id)).toMatchObject({ fills: source.fills, strokes: source.strokes, effects: source.effects })
  }
  expect(pasted(rectangle.id)).toMatchObject({ radii: rectangle.radii, smoothing: rectangle.smoothing })
  expect(pasted(polygon.id).cornerRadius).toBe(3)
  expect(editor!.state.version).toBe(revision + 1)
  await act(async () => editor!.undo())
  expect(editor!.authoredDocument).toEqual(before)
  expect(editor!.canUndo).toBe(false)
  await key('v', { code: 'KeyV', metaKey: true, altKey: true })
  expect(pasted(rectangle.id)).toMatchObject({ radii: source.radii, smoothing: source.smoothing })
  expect(pasted(polygon.id).cornerRadius).toBe(8)
})

test('Sketch Shift+F restores mixed fill visibility and leaves input typing alone', async () => {
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank('Toggle fills')
  const painted = node('rectangle', 60, 40, 100, 90)
  const emptyFill = node('line', 230, 40, 100, 90)
  painted.fills = [paint('#ee0066'), { ...paint('#00bb77'), visible: false }]
  painted.strokes = [stroke('#113399', 4)]
  for (const n of [painted, emptyFill]) doc.nodes[n.id] = n
  doc.pages[0].children = [painted.id, emptyFill.id]
  await act(async () => { editor!.load(doc); editor!.select([painted.id, emptyFill.id]); canvas().focus() })
  const before = editor!.authoredDocument, revision = editor!.state.version
  const fillFlags = () => editor!.state.doc.nodes[painted.id].fills.map(fill => fill.visible)
  const toggle = () => key('F', { code: 'KeyF', shiftKey: true })

  const input = document.createElement('input')
  await act(async () => { document.body.append(input); input.focus() })
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', code: 'KeyF', shiftKey: true, bubbles: true })))
  expect(editor!.authoredDocument).toBe(before)
  await act(async () => { input.remove(); canvas().focus() })

  await toggle()
  expect(fillFlags()).toEqual([false, false])
  expect(editor!.state.version).toBe(revision + 1)
  expect(editor!.state.doc.nodes[painted.id].strokes).toEqual(before.nodes[painted.id].strokes)
  expect(editor!.state.doc.nodes[emptyFill.id]).toBe(before.nodes[emptyFill.id])
  await act(async () => { editor!.set({ tool: 'zoom' }) })
  await toggle()
  expect(fillFlags()).toEqual([true, false])
  expect(editor!.authoredDocument).toEqual(before)
  await act(async () => editor!.undo())
  expect(fillFlags()).toEqual([false, false])
  await act(async () => editor!.undo())
  expect(editor!.authoredDocument).toEqual(before)
  expect(editor!.canUndo).toBe(false)
})

test('Sketch Shift+B hides and restores the selection’s individual border flags', async () => {
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank('Toggle borders')
  const first = node('rectangle', 60, 40, 100, 90)
  const second = node('ellipse', 230, 40, 100, 90)
  first.strokes = [stroke('#ff0000', 6), { ...stroke('#00ff00', 3), visible: false }]
  second.strokes = [stroke('#0000ff', 4)]
  for (const n of [first, second]) doc.nodes[n.id] = n
  doc.pages[0].children = [first.id, second.id]
  await act(async () => { editor!.load(doc); editor!.select([first.id, second.id]); canvas().focus() })
  const prior = editor!.authoredDocument, revision = editor!.state.version
  const read = () => [first.id, second.id].map(id => editor!.state.doc.nodes[id].strokes.map(row => row.visible))
  const toggle = () => key('B', { code: 'KeyB', shiftKey: true })
  await toggle()
  expect(read()).toEqual([[false, false], [false]])
  expect(editor!.state.version).toBe(revision + 1)
  await act(async () => { editor!.set({ tool: 'zoom' }) })
  await toggle()
  expect(read()).toEqual([[true, false], [true]])
  expect(editor!.authoredDocument).toEqual(prior)
  await act(async () => editor!.undo())
  expect(read()).toEqual([[false, false], [false]])
  await act(async () => editor!.undo())
  expect(editor!.authoredDocument).toEqual(prior)
  expect(editor!.canUndo).toBe(false)
  await key('b', { code: 'KeyB' })
  expect(editor!.state.tool).toBe('select')
})

test('Sketch Shift+X swaps paint rows in order, preserving border geometry and one-step undo', async () => {
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank('Swap paints')
  const layer = node('rectangle', 60, 40, 100, 90)
  const fillOnly = node('rectangle', 230, 40, 100, 90)
  const unsupported = node('line', 400, 40, 100, 90)
  const gradient = { ...paint('#f02040'), kind: 'linear' as const, visible: false }
  layer.fills = [gradient, paint('#00bb90')]
  layer.strokes = [
    { ...stroke('#1030f0', 7), align: 'inside', dash: '4 2' },
    { ...stroke('#8866aa', 3), visible: false },
  ]
  for (const n of [layer, fillOnly, unsupported]) doc.nodes[n.id] = n
  doc.pages[0].children = [layer.id, fillOnly.id, unsupported.id]
  await act(async () => { editor!.load(doc); canvas().focus() })
  const before = editor!.authoredDocument, revision = editor!.state.version
  const press = () => key('X', { code: 'KeyX', shiftKey: true })
  await act(async () => editor!.select([layer.id, unsupported.id]))
  await press()
  expect(editor!.authoredDocument).toBe(before)
  expect(editor!.state.version).toBe(revision)
  await act(async () => editor!.select([layer.id, fillOnly.id]))

  const input = document.createElement('input')
  await act(async () => { document.body.append(input); input.focus() })
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'X', code: 'KeyX', shiftKey: true, bubbles: true })))
  expect(editor!.authoredDocument).toBe(before)
  await act(async () => { input.remove(); canvas().focus() })

  await press()
  const updated = editor!.state.doc.nodes[layer.id]
  expect(updated.fills.map(fill => [fill.color, fill.visible])).toEqual([['#1030f0', true], ['#8866aa', false]])
  expect(updated.strokes[0]).toMatchObject({
    width: 7, align: 'inside', dash: '4 2', visible: false,
    paint: { kind: 'linear', stops: gradient.stops },
  })
  expect(updated.strokes[1]).toMatchObject({ width: 3, visible: true, paint: { color: '#00bb90' } })
  const turnedIntoBorder = editor!.state.doc.nodes[fillOnly.id]
  expect(turnedIntoBorder.fills).toEqual([])
  expect(turnedIntoBorder.strokes).toHaveLength(1)
  expect(turnedIntoBorder.strokes[0].paint.color).toBe(fillOnly.fills[0].color)
  expect(editor!.state.version).toBe(revision + 1)
  await act(async () => editor!.undo())
  expect(editor!.authoredDocument).toEqual(before)
  expect(editor!.canUndo).toBe(false)
})

test('Sketch Shift+A auto-pins the selection, shows its pins, and restores prior constraints', async () => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank('Auto Pin')
  const frame = node('frame', 70, 80, 300, 200)
  const child = node('rectangle', 246, 157, 40, 30)
  const sibling = node('rectangle', 10, 16, 30, 20)
  child.constraints = { horizontal: 'center', vertical: 'start' }
  frame.children = [child.id, sibling.id]
  for (const n of [frame, child, sibling]) doc.nodes[n.id] = n
  doc.pages[0].children = [frame.id]
  await act(async () => { editor!.load(doc); canvas().focus() })
  const before = editor!.authoredDocument, revision = editor!.state.version
  const read = (id: string) => editor!.state.doc.nodes[id]
  const press = (repeat = false) => key('A', { code: 'KeyA', shiftKey: true, repeat })
  const active = (edge: string) => document.querySelector(`.constraint-box .edge-${edge}`)?.getAttribute('aria-pressed')
  const expectPinned = () => {
    expect(read(child.id).constraints).toMatchObject({ horizontal: 'end', vertical: 'end' })
    expect(active('right')).toBe('true')
    expect(active('bottom')).toBe('true')
  }

  await press()
  await act(async () => editor!.select([frame.id]))
  await press()
  expect(editor!.authoredDocument).toBe(before)
  await act(async () => editor!.select([child.id]))
  await press()
  expect(editor!.state.version).toBe(revision + 1)
  expectPinned()
  expect(read(sibling.id).constraints).toBeUndefined()
  expect(read(child.id).transform).toEqual(before.nodes[child.id].transform)
  expect(read(frame.id).layout).toBeUndefined()
  await press(true)
  expect(editor!.state.version).toBe(revision + 1)
  await press()
  expect(editor!.authoredDocument).toEqual(before)
  expect(active('top')).toBe('true')
  await act(async () => editor!.undo())
  expectPinned()
  await act(async () => editor!.undo())
  expect(editor!.authoredDocument).toEqual(before)
  expect(editor!.canUndo).toBe(false)
})

test('Sketch Auto Pin Contents pins only direct children and is a single undoable edit', async () => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank('Auto Pin Contents')
  const frame = node('frame', 70, 80, 300, 200)
  const bottomRight = node('rectangle', 246, 157, 40, 30)
  const centered = node('ellipse', 130, 85, 40, 30)
  const strip = node('rectangle', 0, 0, 300, 20)
  const group = node('group', 12, 65, 70, 20)
  const grandchild = node('rectangle', 0, 0, 70, 20)
  group.children = [grandchild.id]
  frame.children = [bottomRight.id, centered.id, strip.id, group.id]
  for (const n of [frame, bottomRight, centered, strip, group, grandchild]) doc.nodes[n.id] = n
  doc.pages[0].children = [frame.id]
  await act(async () => { editor!.load(doc) })
  const n = (id: string) => editor!.state.doc.nodes[id]
  const revision = editor!.state.version, before = editor!.authoredDocument
  const press = () => key('Å', { code: 'KeyA', altKey: true, shiftKey: true })

  await act(async () => { editor!.select([bottomRight.id]); canvas().focus() })
  await press()
  expect(editor!.authoredDocument).toBe(before)
  await act(async () => editor!.select([frame.id]))
  await press()
  expect(editor!.state.version).toBe(revision + 1)
  expect(n(bottomRight.id).constraints).toMatchObject({ horizontal: 'end', vertical: 'end' })
  expect(n(centered.id).constraints).toMatchObject({ horizontal: 'center', vertical: 'center' })
  expect(n(strip.id).constraints).toMatchObject({ horizontal: 'stretch', vertical: 'start' })
  expect(n(group.id).constraints).toMatchObject({ horizontal: 'start', vertical: 'start' })
  expect(n(grandchild.id).constraints).toBeUndefined()
  expect(n(frame.id).constraints).toBeUndefined()
  for (const id of frame.children) expect(n(id).transform).toEqual(before.nodes[id].transform)
  await press()
  expect(editor!.state.version).toBe(revision + 1)

  await act(async () => { editor!.change('Resize fixture', draft => { draft.nodes[frame.id].width = 400; draft.nodes[frame.id].height = 260 }) })
  expect(n(bottomRight.id).transform.slice(4)).toEqual([346, 217])
  expect(n(centered.id).transform.slice(4)).toEqual([180, 115])
  expect(n(strip.id).width).toBe(400)
  await act(async () => editor!.undo())
  await act(async () => editor!.undo())
  expect(editor!.authoredDocument).toEqual(before)
  expect(editor!.canUndo).toBe(false)
})

test.each([false, true])('Sketch zooms a nested selection to its top-level frame (desktop: %s)', async desktop => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  if (desktop) Object.defineProperty(window, 'coreDesktop', { configurable: true, value: {
    version: 1, renderPolicy: { cpuOnly: true }, onCommand: () => () => {}, onCloseRequested: () => () => {},
    setDirty: async () => ({}), readRecovery: async () => ({ status: 'cancelled' }), writeRecovery: async () => ({ status: 'ok' }),
  } as unknown as DesktopBridge })
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank('Frame zoom')
  const frame = node('frame', 430, 190, 340, 240)
  const nested = node('frame', 15, 30, 170, 120)
  const child = node('rectangle', 8, 19, 25, 30)
  const outside = node('rectangle', 45, 60, 60, 40)
  frame.children = [nested.id]; nested.children = [child.id]
  for (const n of [frame, nested, child, outside]) doc.nodes[n.id] = n
  doc.pages[0].children = [frame.id, outside.id]
  await act(async () => { editor!.load(doc) })
  const view = { x: -38, y: 72, zoom: 1.25 }
  await act(async () => { editor!.select([frame.id]); canvas().focus() })
  await key('2', { code: 'Digit2', shiftKey: true })
  const fitted = editor!.state.view
  expect(fitted).not.toEqual(view)
  const before = editor!.authoredDocument, revision = editor!.state.version
  await act(async () => { editor!.select([child.id]); editor!.set({ view }) })
  const cmd4 = async () => {
    const event = new KeyboardEvent('keydown', { key: '4', code: 'Digit4', metaKey: true, bubbles: true, cancelable: true })
    await act(async () => canvas().dispatchEvent(event))
    return event.defaultPrevented
  }
  expect(await cmd4()).toBe(desktop)
  expect(editor!.state.view).toEqual(desktop ? fitted : view)
  if (!desktop) {
    const zoom = document.querySelector<HTMLDetailsElement>('.view-menu')!
    await act(async () => { zoom.open = true; button('缩放到顶层画框').click() })
    expect(editor!.state.view).toEqual(fitted)
  }
  expect(editor!.state.selection).toEqual([child.id])

  await act(async () => { editor!.select([outside.id]); editor!.set({ view }); canvas().focus() })
  if (desktop) await cmd4()
  else await act(async () => button('缩放到顶层画框').click())
  expect(editor!.state.view).toEqual(view)
  expect(editor!.authoredDocument).toBe(before)
  expect(editor!.state.version).toBe(revision)
  expect(editor!.canUndo).toBe(false)
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

test.each([
  { source: 'Sketch', figma: false, mode: 'sketch' },
  { source: 'FIG', figma: true, mode: 'sketch' },
  { source: 'FIG', figma: true, mode: 'figma' },
] as const)('stacking controls preserve authored flow for $source in $mode mode', async ({ figma, mode }) => {
  applyInterfaceLayout(mode)
  await render()
  const doc = blank('Stacking order QA')
  if (figma) {
    doc.schemaVersion = 4
    doc.designSystem = {
      collections: {}, variables: {}, activeModes: {}, styles: {}, libraries: {},
      sketchContainers: { figDocument: { source: 'figma' } },
    }
  }
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
  expect(layerNames()).toEqual(figma
    ? ['First item', 'Absolute item', 'Last item']
    : ['Last item', 'Absolute item', 'First item'])
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
  applyInterfaceLayout('figma')
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  await render(); expect(editor).toBeDefined()
  const doc = blank(), frame = node('frame', 0, 0, 300, 200), child = node('rectangle', 30, 40, 50, 60)
  frame.children = [child.id]; doc.nodes = { [frame.id]: frame, [child.id]: child }; doc.pages[0].children = [frame.id]
  await act(async () => { editor!.load(doc); editor!.select([child.id]); nudgePreference.set({ small: .5, big: 5 }); canvas().focus() })
  const before = editor!.state.doc
  for (const repeat of [false, true, true]) await key('ArrowRight', { repeat })
  expect(editor!.interactionActive).toBe(true); expect(editor!.state.doc.nodes[child.id].transform[4]).toBe(31.5)
  await key('ArrowRight', {}, 'keyup'); await act(async () => editor!.undo())
  expect(editor!.state.doc).toEqual(before); expect(editor!.canUndo).toBe(false)
  for (const repeat of [false, true]) await key('ArrowDown', { metaKey: true, repeat })
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
  if (layout === 'figma') {
    expect(inspect).toBeUndefined(); expect(edit).toBeUndefined()
    expect(button('导出 SVG（保留视觉效果')).toBeDefined()
    return
  }
  expect(button('导出所选图层…')).toBeDefined()
  expect(button('导出 SVG（保留视觉效果')).toBeUndefined()
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
  await act(async () => applyInterfaceLayout('sketch'))
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

test('layout switch keeps style ownership while Sketch and Figma edit it through their own controls', async () => {
  applyInterfaceLayout('sketch')
  await render()
  const doc = blank(), layer = node('rectangle'), text = node('text')
  layer.fills = [paint('#113355'), paint('#446688')]
  layer.strokes = [stroke()]
  layer.effects = [effect('shadow')]
  text.text = 'Alignment'
  for (const item of [layer, text]) { doc.nodes[item.id] = item; doc.pages[0].children.push(item.id) }
  const editorInstance = editor!
  await act(async () => { expect(editorInstance.load(doc)).toBe(true); editorInstance.select([layer.id]) })
  const before = editorInstance.authoredDocument
  const current = () => editorInstance.authoredDocument.nodes[layer.id]
  const undo = async () => {
    expect(editorInstance.canUndo).toBe(true)
    await act(async () => editorInstance.undo())
    expect(editorInstance.authoredDocument).toEqual(before)
    expect(editorInstance.canUndo).toBe(false)
    expect(editorInstance.state.selection).toEqual([layer.id])
  }
  const rows = () => [...document.querySelectorAll<HTMLElement>('.sketch-style-row')]
  expect(rows()).toHaveLength(4)
  const disclosure = rows()[0].querySelector<HTMLButtonElement>('[aria-controls]')!
  await act(async () => disclosure.click())
  expect(disclosure.getAttribute('aria-expanded')).toBe('false')
  expect(document.getElementById(disclosure.getAttribute('aria-controls')!)!.hidden).toBe(true)
  expect(editorInstance.canUndo).toBe(false)
  await act(async () => disclosure.click())

  for (const [index, field, label] of [[0, 'fills', '填充'], [2, 'strokes', '描边'], [3, 'effects', '效果']] as const) {
    const checkbox = rows()[index].querySelector<HTMLInputElement>('.sketch-style-check')!
    expect(checkbox.checked).toBe(true)
    await act(async () => checkbox.click())
    expect(current()[field][0].visible).toBe(false)
    await undo()

    await key('Alt', { altKey: true })
    const remove = document.querySelector<HTMLButtonElement>(`button[aria-label="移除全部${label}"]`)!
    expect(remove.disabled).toBe(false)
    await act(async () => remove.click())
    await key('Alt', {}, 'keyup')
    expect(current()[field]).toHaveLength(0)
    await undo()
  }
  await act(async () => applyInterfaceLayout('figma'))
  expect(rows()).toHaveLength(0)
  expect(editorInstance.authoredDocument).toEqual(before)
  expect(editorInstance.state.selection).toEqual([layer.id])
  const cards = [...document.querySelectorAll('.property-card')]
  for (const [index, field] of [[0, 'fills'], [2, 'strokes'], [3, 'effects']] as const) {
    await act(async () => cards[index].querySelector<HTMLButtonElement>('button[title="切换可见性"]')!.click())
    expect(current()[field][0].visible).toBe(false)
    await undo()
  }
  await act(async () => { applyInterfaceLayout('sketch'); editorInstance.select([text.id]) })
  const align = document.querySelector<HTMLButtonElement>('.sketch-text-alignment button[aria-label="居中"]')!
  await act(async () => align.click())
  expect(editorInstance.authoredDocument.nodes[text.id].textStyle?.align).toBe('center')
  await act(async () => applyInterfaceLayout('figma'))
  expect(document.querySelector<HTMLSelectElement>('select[aria-label="文字对齐"]')!.value).toBe('center')
  await act(async () => editorInstance.undo())
  expect(editorInstance.authoredDocument).toEqual(before)
  expect(editorInstance.state.selection).toEqual([text.id])
})


test('Sketch keeps a separate prototype inspector and restores Figma controls on return', async () => {
  applyInterfaceLayout('figma')
  setPrototypeTab('design')
  await render()
  const doc = blank(), frame = node('frame'), next = node('frame')
  for (const layer of [frame, next]) { doc.nodes[layer.id] = layer; doc.pages[0].children.push(layer.id) }
  doc.schemaVersion = 4
  doc.prototype = { interactions: { [frame.id]: [{ trigger: 'click', actions: [{ kind: 'navigate', target: next.id }] }] } }
  const editorInstance = editor!, view = { x: 30, y: 40, zoom: 1.25 }
  await act(async () => { editorInstance.load(doc); editorInstance.select([frame.id]) })
  await act(async () => { editorInstance.set({ view }) })
  const before = editorInstance.authoredDocument
  const preview = () => document.querySelector('.prototype-preview-button')
  const prototype = () => document.querySelector<HTMLButtonElement>('#prototype-properties-tab')
  await act(async () => prototype()!.click())
  expect(document.querySelector('.embedded-design-tools')).not.toBeNull()
  expect(preview()).not.toBeNull()

  await act(async () => applyInterfaceLayout('sketch'))
  expect(document.querySelector('#design-properties-tab')?.getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.embedded-design-tools')).toBeNull()
  expect(document.querySelector('[data-testid="prototype-link"]')).toBeNull()
  expect(document.querySelector('.properties-content .inspector')).not.toBeNull()
  expect(preview()).toBeNull()
  await act(async () => prototype()!.click())
  expect(prototype()?.getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.sketch-prototype-inspector .sketch-interaction-panel')).not.toBeNull()
  expect(document.querySelector('.embedded-design-tools')).toBeNull()
  await act(async () => shortcutPreference.set('figma-like'))
  await key('End')
  await key('E', { code: 'KeyE', shiftKey: true })
  expect(document.querySelector('.embedded-design-tools')).toBeNull()
  expect(editorInstance.authoredDocument).toBe(before)
  expect(editorInstance.state.selection).toEqual([frame.id])
  expect(editorInstance.state.view).toEqual(view)
  expect(editorInstance.canUndo).toBe(false)

  await act(async () => applyInterfaceLayout('figma'))
  expect(prototype()?.getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.embedded-design-tools')).not.toBeNull()
  expect(preview()).not.toBeNull()
  await act(async () => setPrototypeTab('design'))
})


test('Sketch releases Figma-only key events before dispatch, even with a shape selected', async () => {
  applyInterfaceLayout('sketch')
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  await render()
  const doc = blank(), shape = node('rectangle')
  doc.nodes[shape.id] = shape
  doc.pages[0].children = [shape.id]
  const editorInstance = editor!
  await act(async () => { editorInstance.load(doc); editorInstance.select([shape.id]); canvas().focus() })
  const before = [editorInstance.authoredDocument, editorInstance.state.selection, editorInstance.state.view]
  const press = async (key: string, code: string, modifiers: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...modifiers })
    await act(async () => canvas().dispatchEvent(event))
    return event.defaultPrevented
  }
  const modifiers = { metaKey: true, shiftKey: true }
  expect(await press('O', 'KeyO', modifiers)).toBe(false)
  expect(await press('b', 'KeyB')).toBe(false)
  expect(await press('C', 'KeyC', modifiers)).toBe(false)
  expect(editorInstance.state.tool).toBe('select')
  expect(editorInstance.state.outlines).toBeFalsy()
  expect([editorInstance.authoredDocument, editorInstance.state.selection, editorInstance.state.view]).toEqual(before)
  expect(editorInstance.canUndo).toBe(false)

  await act(async () => applyInterfaceLayout('figma'))
  expect(await press('O', 'KeyO', modifiers)).toBe(true)
  expect(editorInstance.state.outlines).toBe(true)
  expect(await press('b', 'KeyB')).toBe(true)
  expect(editorInstance.state.tool).toBe('brush')
  expect(editorInstance.authoredDocument).toBe(before[0])
})


test('a mismatched saved shortcut profile cannot override the active layout keyboard and pointer rules', async () => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  applyInterfaceLayout('figma')
  await render()
  const doc = blank(), shape = node('rectangle')
  doc.nodes[shape.id] = shape; doc.pages[0].children = [shape.id]
  const current = editor!
  await act(async () => { current.load(doc); current.select([shape.id]); canvas().focus() })
  const before = () => [current.authoredDocument, current.state.selection, current.state.view, current.state.showAuthoredLayout, current.state.showOverview]
  const press = async (key: string, code: string, modifiers: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...modifiers })
    await act(async () => canvas().dispatchEvent(event))
    return event.defaultPrevented
  }
  await act(async () => shortcutPreference.set('sketch-like'))
  const original = before()
  expect(await press('g','KeyG')).toBe(false)
  expect(await press('x','KeyX')).toBe(false)
  expect(await press('l','KeyL',{ ctrlKey: true })).toBe(false)
  expect(await press('m','KeyM',{ ctrlKey: true })).toBe(false)
  expect(canvas().style.cursor).not.toBe('crosshair')
  expect(current.state.tool).toBe('select')
  expect(before()).toEqual(original)
  expect(await press('s','KeyS')).toBe(true)
  expect(current.state.tool).toBe('slice')
  expect(document.querySelector('.command-search-dialog')).toBeNull()

  await act(async () => { applyInterfaceLayout('sketch'); shortcutPreference.set('figma-like') })
  expect(await press('E','KeyE',{ shiftKey: true })).toBe(false)
  expect(await press('π','KeyP',{ altKey: true })).toBe(false)
  expect(document.querySelector('.embedded-design-tools')).toBeNull()
  expect(await press('s','KeyS')).toBe(true)
  expect(document.querySelector('.command-search-dialog')).not.toBeNull()
  await act(async () => document.querySelector<HTMLButtonElement>('.command-search-dialog button[aria-label="关闭命令搜索"]')!.click())
  expect(await press('p','KeyP')).toBe(true)
  expect(current.state.tool).toBe('pencil')
  expect(before()).toEqual(original)
  expect(current.canUndo).toBe(false)
})


test('layout round trip replaces the chrome hosts while keeping the canvas, page and history', async () => {
  applyInterfaceLayout('figma')
  setPrototypeTab('design')
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  await render()
  const doc = blank(), next = blank().pages[0], frame = node('frame'), shape = node('rectangle', 34, 36)
  frame.children = [shape.id]; next.children = [frame.id]
  doc.pages.push(next); doc.nodes = { [frame.id]: frame, [shape.id]: shape }
  const current = editor!
  await act(async () => { current.load(doc); current.switchPage(next.id); current.select([shape.id]) })
  await act(async () => {
    current.update([shape.id], { name: 'Changed before switching' }, 'Rename')
    current.update([shape.id], { opacity: .5 }, 'Opacity')
    current.undo()
    current.set({ view: { x: 34, y: 62, zoom: 1.2 } })
  })
  const initial = current.authoredDocument, session = current.sessionGeneration, version = current.state.version
  const view = { ...current.state.view }, originalCanvas = canvas()
  const hosts = () => [...document.querySelectorAll('[data-workspace-host], .figma-workspace-tools, .sketch-window-tools')]
  const file = () => document.querySelector<HTMLButtonElement>('button[aria-label="文件菜单"]')!
  await act(async () => file().click())
  expect(document.querySelector('.figma-file-menu')).not.toBeNull()
  const before = hosts()
  expect(before).toHaveLength(3)
  await key('ß', { code: 'KeyS', altKey: true, metaKey: true })
  expect(document.querySelector('.figma-file-menu')).toBeNull()
  expect(document.querySelector('.workspace-rail')).toBeNull()
  expect(document.querySelector('[data-workspace-host="sketch-layers"]')).not.toBeNull()
  expect(document.querySelector('[data-workspace-host="sketch-inspector"]')).not.toBeNull()
  expect(before.every(host => !host.isConnected)).toBe(true)
  expect(canvas()).toBe(originalCanvas)

  await act(async () => file().click())
  expect(document.querySelector('.sketch-file-menu')).not.toBeNull()
  const sketch = hosts()
  await act(async () => document.querySelector<HTMLButtonElement>('.ui-mode-switch button:first-child')!.click())
  expect(sketch).toHaveLength(3)
  expect(sketch.every(host => !host.isConnected)).toBe(true)
  expect(document.querySelector('.sketch-file-menu')).toBeNull()
  expect(document.querySelector('[data-workspace-host="figma-layers"]')).not.toBeNull()
  expect(document.querySelector('[data-workspace-host="figma-inspector"]')).not.toBeNull()
  expect(document.querySelector('.workspace-rail')).not.toBeNull()
  expect(canvas()).toBe(originalCanvas)
  expect(current.authoredDocument).toBe(initial)
  expect(current.state.version).toBe(version)
  expect(current.sessionGeneration).toBe(session)
  expect(current.state.page).toBe(next.id)
  expect(current.state.selection).toEqual([shape.id])
  expect(current.state.view).toEqual(view)
  expect(current.canUndo).toBe(true)
  expect(current.canRedo).toBe(true)
  await act(async () => current.redo())
  expect(current.authoredDocument.nodes[shape.id].opacity).toBe(.5)
  await act(async () => current.undo())
  expect(current.authoredDocument).toEqual(initial)
})


test('Figma Backslash selects the same parent as Shift+Enter without authoring', async () => {
  applyInterfaceLayout('figma')
  await render()
  const doc = blank(), frame = node('frame'), group = node('group'), shape = node('rectangle')
  frame.children = [group.id]; group.children = [shape.id]
  doc.nodes = { [frame.id]: frame, [group.id]: group, [shape.id]: shape }; doc.pages[0].children = [frame.id]
  const current = editor!
  await act(async () => { current.load(doc); current.select([shape.id]); canvas().focus() })
  const before = current.authoredDocument, view = { ...current.state.view }
  await key('Enter', { shiftKey: true })
  expect(current.state.selection).toEqual([group.id])
  await act(async () => current.select([shape.id]))
  const original = '\\'
  const send = async (target: HTMLElement) => {
    const event = new KeyboardEvent('keydown', { key: original, code: 'Backslash', bubbles: true, cancelable: true })
    await act(async () => target.dispatchEvent(event))
    return event.defaultPrevented
  }
  const name = document.querySelector<HTMLInputElement>('input[aria-label="文档名称"]')!
  await act(async () => name.focus())
  expect(await send(name)).toBe(false)
  expect(current.state.selection).toEqual([shape.id])
  await act(async () => canvas().focus())
  expect(await send(canvas())).toBe(true)
  expect(current.state.selection).toEqual([group.id])
  expect(await send(canvas())).toBe(true)
  expect(current.state.selection).toEqual([frame.id])
  await send(canvas())
  expect(current.state.selection).toEqual([frame.id])
  expect(current.authoredDocument).toBe(before)
  expect(current.state.view).toEqual(view)
  expect(current.canUndo).toBe(false)
  await act(async () => { applyInterfaceLayout('sketch'); current.select([shape.id]); canvas().focus() })
  expect(await send(canvas())).toBe(false)
  expect(current.state.selection).toEqual([shape.id])
})


test('Figma Shift+Quote toggles pixel grid while Command+Shift+Quote only toggles snapping', async () => {
  applyInterfaceLayout('figma')
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  await render()
  const current = editor!, press = async (key: string, modifiers: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key, code: 'Quote', bubbles: true, cancelable: true, ...modifiers })
    await act(async () => canvas().dispatchEvent(event))
    return event.defaultPrevented
  }
  await act(async () => { current.set({ pixelGrid: false, snapPixels: false }); canvas().focus() })
  const before = current.authoredDocument, view = { ...current.state.view }
  expect(await press("'", { metaKey: true })).toBe(false)
  expect(current.state.pixelGrid).toBe(false)
  expect(await press('"', { shiftKey: true })).toBe(true)
  expect(current.state.pixelGrid).toBe(true)
  expect(current.state.snapPixels).toBe(false)
  expect(await press('"', { shiftKey: true, metaKey: true })).toBe(true)
  expect(current.state.pixelGrid).toBe(true)
  expect(current.state.snapPixels).toBe(true)
  await act(async () => applyInterfaceLayout('sketch'))
  expect(await press('"', { shiftKey: true })).toBe(false)
  expect(await press("'", { metaKey: true })).toBe(true)
  expect(current.state.pixelGrid).toBe(false)
  expect(current.state.snapPixels).toBe(true)
  expect(current.authoredDocument).toBe(before)
  expect(current.state.view).toEqual(view)
  expect(current.canUndo).toBe(false)
})


test('Figma shortcut reference stays interactive, reflects used keys and remaps a selected keyboard layout', async () => {
  applyInterfaceLayout('figma')
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  await render()
  const current = editor!, doc = blank(), frame = node('frame'), child = node('rectangle')
  frame.children = [child.id]; doc.nodes = { [frame.id]: frame, [child.id]: child }; doc.pages[0].children = [frame.id]
  await act(async () => { current.load(doc); current.select([child.id]); canvas().focus() })
  const before = current.authoredDocument
  const dock = () => document.querySelector<HTMLElement>('.shortcut-reference')
  const tab = (title: string) => [...dock()!.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(tab => tab.textContent === title)!
  await key('?', { code: 'Slash', ctrlKey: true, shiftKey: true })
  expect(dock()).not.toBeNull()
  expect(dock()!.getAttribute('aria-modal')).toBeNull()
  const arrow = () => dock()!.querySelector('[data-shortcut-command="set-tool-arrow"] kbd')
  expect(arrow()?.getAttribute('data-used')).toBe('false')
  await key('L', { code: 'KeyL', shiftKey: true })
  expect(current.state.tool).toBe('arrow')
  expect(arrow()?.getAttribute('data-used')).toBe('true')

  await act(async () => tab('布局').click())
  const select = dock()!.querySelector('select')!
  await act(async () => { select.value = 'de-qwertz'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(interfacePreference.getSnapshot().figmaKeyboardLayout).toBe('de-qwertz')
  await act(async () => tab('编辑与选区').click())
  const parent = () => dock()!.querySelector('[data-shortcut-command="select-parent"] kbd')
  expect(parent()?.textContent).toBe('#')
  await act(async () => canvas().focus())
  await key('#', { code: 'Backslash' })
  expect(current.state.selection).toEqual([frame.id])
  expect(parent()?.getAttribute('data-used')).toBe('true')
  await key('Escape')
  expect(dock()).toBeNull()
  expect(document.activeElement).toBe(canvas())
  expect(current.authoredDocument).toBe(before)
  expect(current.canUndo).toBe(false)
  await act(async () => applyInterfaceLayout('sketch'))
  await key('?', { code: 'Slash', ctrlKey: true, shiftKey: true })
  expect(dock()).toBeNull()
})

test('Figma property labels reveal only icon captions and preserve document and layout options', async () => {
  applyInterfaceLayout('figma')
  await render()
  const current = editor!, doc = blank(), frame = node('frame'), child = node('rectangle')
  frame.children = [child.id]; doc.nodes = { [frame.id]: frame, [child.id]: child }; doc.pages[0].children = [frame.id]
  await act(async () => { current.load(doc); current.select([child.id]) })
  const before = current.authoredDocument, view = { ...current.state.view }
  const icon = (label: string) => document.querySelector<HTMLButtonElement>(`.inspector button[aria-label="${label}"]`)!
  const caption = (label: string) => icon(label).querySelector('.property-control-caption')?.textContent
  const readout = () => document.querySelector<HTMLElement>('[data-testid="zoom-readout"]')!
  const toggle = () => [...document.querySelectorAll('label')].find(label => label.textContent?.trim() === '属性标签')?.querySelector<HTMLInputElement>('input')
  expect(caption('左对齐')).toBeUndefined()
  await act(async () => readout().click())
  await act(async () => toggle()!.click())
  expect(toggle()?.checked).toBe(true)
  expect(caption('左对齐')).toBe('左对齐')
  expect(caption('水平翻转')).toBe('水平翻转')
  expect(caption('顺时针旋转 90°')).toBe('顺时针旋转 90°')
  expect(document.querySelectorAll('.geometry-position .property-control-caption')).toHaveLength(0)
  expect(JSON.parse(localStorage.getItem('forma.interface-preferences.v1')!).figmaPropertyLabels).toBe(true)

  await act(async () => applyInterfaceLayout('sketch'))
  expect(toggle()).toBeUndefined()
  expect(document.querySelector('.property-control-caption')).toBeNull()
  await act(async () => applyInterfaceLayout('figma'))
  expect(caption('左对齐')).toBe('左对齐')
  await act(async () => readout().click())
  await act(async () => toggle()!.click())
  expect(caption('左对齐')).toBeUndefined()
  expect(current.authoredDocument).toBe(before)
  expect(current.state.view).toEqual(view)
  expect(current.state.selection).toEqual([child.id])
  expect(current.canUndo).toBe(false)
})


test('Figma Command+K opens Quick Actions without taking keys from Find, text or menus', async () => {
  applyInterfaceLayout('figma')
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  await render()
  const current = editor!, doc = blank(), layer = node('rectangle')
  doc.nodes[layer.id] = layer; doc.pages[0].children = [layer.id]
  await act(async () => { current.load(doc); current.select([layer.id]); canvas().focus() })
  const before = current.authoredDocument, view = { ...current.state.view }
  const dock = () => document.querySelector('.command-search-dialog')
  const shortcut = (target: HTMLElement) => act(async () => target.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'k', code: 'KeyK', metaKey: true, bubbles: true, cancelable: true,
  })))
  await shortcut(canvas())
  expect(dock()?.querySelector('h2')?.textContent).toBe('快速操作')
  expect(dock()?.querySelector('[data-command="convert-section"]')).not.toBeNull()
  expect(dock()?.querySelector('[data-command="set-tool-graphic"]')).toBeNull()
  const search = dock()!.querySelector('input')!
  expect(document.activeElement).toBe(search)
  await act(async () => search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(dock()).toBeNull()
  expect(document.activeElement).toBe(canvas())

  const name = document.querySelector<HTMLInputElement>('input[aria-label="文档名称"]')!
  await act(async () => name.focus())
  await shortcut(name)
  expect(dock()).toBeNull()
  await act(async () => canvas().focus())
  await key('ContextMenu')
  const menu = document.querySelector<HTMLElement>('.canvas-context-menu')!
  await shortcut(menu)
  expect(dock()).toBeNull()
  await act(async () => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  await act(async () => canvas().focus())
  await key('s', { code: 'KeyS' })
  expect(current.state.tool).toBe('slice')
  expect(current.authoredDocument).toBe(before)
  expect(current.state.view).toEqual(view)
  expect(current.canUndo).toBe(false)
})


test('Figma A and F arm the frame tool and display both keys without intercepting text', async () => {
  applyInterfaceLayout('figma')
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  await render()
  const current = editor!, doc = blank(), shape = node('rectangle')
  doc.nodes[shape.id] = shape; doc.pages[0].children = [shape.id]
  await act(async () => { current.load(doc); canvas().focus() })
  const before = current.authoredDocument
  await key('a', { code: 'KeyA' })
  expect(current.state.tool).toBe('frame')
  const frame = document.querySelector('.figma-workspace-tools button[aria-label="画板"][aria-pressed="true"]')!
  expect(frame.getAttribute('data-tooltip')).toContain('F / A')
  await key('Escape')
  await key('f', { code: 'KeyF' })
  expect(current.state.tool).toBe('frame')
  await key('Escape')
  const name = document.querySelector<HTMLInputElement>('input[aria-label="文档名称"]')!
  await act(async () => name.focus())
  const textKey = new KeyboardEvent('keydown',{ key: 'a', code: 'KeyA', bubbles: true, cancelable: true })
  await act(async () => name.dispatchEvent(textKey))
  expect(textKey.defaultPrevented).toBe(false)
  expect(current.state.tool).toBe('select')
  await act(async () => canvas().focus())
  await key('a', { code: 'KeyA', metaKey: true })
  expect(current.state.selection).toEqual([shape.id])
  expect(current.state.tool).toBe('select')
  await act(async () => applyInterfaceLayout('sketch'))
  await key('a', { code: 'KeyA' })
  expect(current.state.tool).toBe('select')
  expect(current.authoredDocument).toBe(before)
  expect(current.canUndo).toBe(false)
})
