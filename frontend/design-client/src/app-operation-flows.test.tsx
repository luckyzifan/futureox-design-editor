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
import { forma_decode_json, forma_encode_json } from './generated/design-kernel/design_kernel'
import { worldMatrix } from './geometry'
import { kernelFillWorld } from './kernel/picking'
import { blank, defaultTextStyle, node, paint, stroke } from './model'
import { nudgePreference } from './nudge-preference'
import * as persistence from './persistence'
import { shortcutPreference } from './shortcut-preference'
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
