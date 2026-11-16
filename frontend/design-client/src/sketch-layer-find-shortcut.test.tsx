// jsdom keyboard and React state only. This does not run Electron, macOS, or a
// real Sketch window. 117.sketch and test.sketch in this checkout are Git LFS
// pointers, so the document below recreates the layer names from issue #496:
// image.png (117) and 编组 36 (test), on two pages.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { applyInterfaceLayout } from './interface-layout'
import { interfacePreference, useInterfacePreferences } from './interface-preference'
import { Layers } from './Layers'
import { applyInterfaceLayoutShortcut } from './layout-shortcut'
import { blank, node } from './model'
import { shortcutPreference } from './shortcut-preference'
import { UiModeSwitch } from './UiModeSwitch'

const bootstrap = await vi.hoisted(async () => {
  // @ts-expect-error jsdom is a test-only runtime dependency.
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<html><body></body></html>')
  for (const key of ['window', 'document', 'navigator'] as const) vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key])
  return dom
})
bootstrap.window.close()

let dom: JSDOM, root: Root, editor: Editor, canvas: HTMLDivElement
let removeLayout = () => {}
const macFind = { key: 'ƒ', code: 'KeyF', metaKey: true, altKey: true, ctrlKey: false, shiftKey: false }
const ctrlFind = { key: 'f', code: 'KeyF', metaKey: false, ctrlKey: true, altKey: true, shiftKey: false }

function documentedDocument() {
  const doc = blank('117')
  const frame = node('frame', 0, 0, 800, 600)
  frame.name = '画框'
  const image = node('rectangle', 24, 24, 96, 64)
  image.name = 'image.png'
  const group = node('group', 40, 120, 180, 80)
  group.name = '编组 36'
  const inner = node('rectangle', 0, 0, 32, 32)
  inner.name = '组内矩形'
  const other = node('rectangle', 400, 24, 40, 40)
  other.name = '其他图层'
  const elsewhere = node('rectangle', 0, 0, 20, 20)
  elsewhere.name = '第二页图层'
  group.children = [inner.id]
  frame.children = [image.id, group.id]
  doc.name = '117'
  doc.pages[0].name = '117'
  doc.pages[0].children = [frame.id, other.id]
  doc.pages.push({ id: '9c1a6d20-7b34-4e1a-9f60-2a6b0c5d1170', name: 'test', children: [elsewhere.id], background: '#ffffff' })
  for (const item of [frame, image, group, inner, other, elsewhere]) doc.nodes[item.id] = item
  return { doc, frame }
}

function Shell() {
  const { uiMode } = useInterfacePreferences()
  return <div className="editor-shell" data-ui-mode={uiMode}><UiModeSwitch /><Layers editor={editor} /></div>
}
const mode = () => document.querySelector('.editor-shell')?.getAttribute('data-ui-mode')
const search = () => document.querySelector<HTMLInputElement>('.sketch-layer-search input[aria-label="搜索图层"]')
const tree = () => document.querySelector('[role="tree"]')?.textContent ?? ''
const kept = () => ({ page: editor.state.page, selection: [...editor.state.selection], doc: editor.state.doc, undo: editor.canUndo })
function press(target: EventTarget, init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}
async function typeQuery(value: string) {
  const field = search()
  expect(field).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'localStorage'])
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name as 'document'])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  interfacePreference.reset()
  applyInterfaceLayout('sketch')
  const { doc, frame } = documentedDocument()
  editor = new Editor(doc)
  editor.select([frame.id])
  canvas = document.createElement('div')
  canvas.tabIndex = 0
  canvas.dataset.testid = 'canvas'
  document.body.append(canvas)
  root = createRoot(document.getElementById('root')!)
  await act(async () => { root.render(<Shell />) })
  const layout = (event: KeyboardEvent) => { applyInterfaceLayoutShortcut(event) }
  window.addEventListener('keydown', layout)
  removeLayout = () => window.removeEventListener('keydown', layout)
  canvas.focus()
})
afterEach(async () => {
  removeLayout()
  await act(async () => root.unmount())
  editor.dispose()
  dom.window.close()
  interfacePreference.reset()
  shortcutPreference.set('figma-like')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test('Option+Command+F from the canvas focuses find and keeps layout, page, selection, and the document', async () => {
  const before = kept()
  expect(mode()).toBe('sketch')
  expect(shortcutPreference.getSnapshot()).toBe('sketch-like')
  expect(search()).not.toBeNull()
  const untouched = new KeyboardEvent('keydown', { ...macFind, bubbles: true, cancelable: true })
  expect(applyInterfaceLayoutShortcut(untouched)).toBe(false)
  expect(untouched.defaultPrevented).toBe(true)
  expect(mode()).toBe('sketch')
  expect(kept()).toEqual(before)

  await act(async () => { press(canvas, { ...macFind, repeat: true }) })
  expect(document.activeElement).toBe(canvas)
  expect(mode()).toBe('sketch')
  await act(async () => {
    press(canvas, { key: 'f', code: 'KeyF', metaKey: true, ctrlKey: true, altKey: true })
    press(canvas, { ...macFind, shiftKey: true })
    press(canvas, { ...macFind, isComposing: true })
  })
  expect(document.activeElement).toBe(canvas)
  expect(kept()).toEqual(before)

  const chord = await act(async () => press(canvas, macFind))
  expect(chord.defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(search())
  expect(mode()).toBe('sketch')
  expect(shortcutPreference.getSnapshot()).toBe('sketch-like')
  expect(kept()).toEqual(before)

  canvas.focus()
  await act(async () => { press(canvas, ctrlFind) })
  expect(document.activeElement).toBe(search())
  expect(mode()).toBe('sketch')
  expect(kept()).toEqual(before)

  await typeQuery('编组 36')
  expect(tree()).toContain('编组 36')
  expect(tree()).not.toContain('其他图层')
  expect(tree()).not.toContain('第二页图层')
  expect(search()!.value).toBe('编组 36')
  expect(kept()).toEqual(before)

  await typeQuery('image.png')
  expect(tree()).toContain('image.png')
  expect(tree()).not.toContain('其他图层')
  expect(tree()).not.toContain('第二页图层')
  expect(tree()).not.toContain('编组 36')
  expect(editor.state.page).toBe(before.page)
  expect(editor.state.selection).toEqual(before.selection)
  expect(mode()).toBe('sketch')
  canvas.focus()
  await act(async () => { press(canvas, macFind) })
  expect(document.activeElement).toBe(search())
  expect(search()!.value).toBe('image.png')
  expect(mode()).toBe('sketch')
  expect(kept()).toEqual(before)
})

test('Ctrl+F still filters related layers and text editing keeps Option+Command+F', async () => {
  const before = kept()
  const related = document.querySelector<HTMLButtonElement>('[aria-keyshortcuts="Control+F"]')!
  expect(related.getAttribute('aria-pressed')).toBe('false')
  await act(async () => { press(canvas, { key: 'f', code: 'KeyF', ctrlKey: true }) })
  expect(related.getAttribute('aria-pressed')).toBe('true')
  expect(document.activeElement).toBe(canvas)
  expect(mode()).toBe('sketch')
  expect(tree()).toContain('画框')
  expect(tree()).not.toContain('其他图层')
  expect(kept()).toEqual(before)
  await act(async () => { press(canvas, { key: 'f', code: 'KeyF', ctrlKey: true }) })
  expect(related.getAttribute('aria-pressed')).toBe('false')
  expect(tree()).toContain('其他图层')
  expect(kept()).toEqual(before)

  await act(async () => { press(canvas, macFind) })
  expect(document.activeElement).toBe(search())
  await act(async () => { press(search()!, { key: 'f', code: 'KeyF', ctrlKey: true }) })
  expect(document.querySelector('[aria-keyshortcuts="Control+F"]')?.getAttribute('aria-pressed')).toBe('true')
  expect(document.activeElement).toBe(search())
  expect(mode()).toBe('sketch')
  expect(kept()).toEqual(before)
  await act(async () => { press(search()!, macFind) })
  expect(document.activeElement).toBe(search())
  expect(mode()).toBe('sketch')
  expect(kept()).toEqual(before)

  for (const tag of ['textarea', 'input']) {
    const field = document.createElement(tag)
    document.body.append(field)
    field.focus()
    await act(async () => { press(field, macFind) })
    expect(document.activeElement, tag).toBe(field)
    expect(mode()).toBe('sketch')
    expect(kept()).toEqual(before)
    field.remove()
  }
  const editable = document.createElement('div')
  editable.setAttribute('contenteditable', 'true')
  document.body.append(editable)
  editable.focus()
  await act(async () => { press(editable, ctrlFind) })
  expect(document.activeElement).toBe(editable)
  expect(mode()).toBe('sketch')
  expect(kept()).toEqual(before)
})

test('layout buttons, Mod+Alt+S, and a Figma-like profile still own layout switching', async () => {
  const before = kept()
  const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('.ui-mode-switch button')]
  const figma = () => buttons().find(button => button.textContent === 'Figma')!
  const sketch = () => buttons().find(button => button.textContent === 'Sketch')!
  expect(figma().getAttribute('aria-keyshortcuts')).toBeNull()
  expect(sketch().getAttribute('aria-keyshortcuts')).toBe('Mod+Alt+S')

  shortcutPreference.set('figma-like')
  await act(async () => { press(canvas, macFind) })
  expect(mode()).toBe('figma')
  expect(shortcutPreference.getSnapshot()).toBe('figma-like')
  expect(search()).toBeNull()
  expect(document.querySelector('input[aria-label="搜索图层"]')).toBeNull()
  expect(kept()).toEqual(before)
  expect(figma().getAttribute('aria-keyshortcuts')).toBe('Mod+Alt+F')

  await act(async () => { press(canvas, { key: 'f', code: 'KeyF', metaKey: true }) })
  expect(mode()).toBe('figma')
  expect(document.querySelector('input[aria-label="搜索图层"]')).toBeNull()
  expect(kept()).toEqual(before)

  await act(async () => { press(canvas, { key: 'ß', code: 'KeyS', metaKey: true, altKey: true }) })
  expect(mode()).toBe('sketch')
  expect(shortcutPreference.getSnapshot()).toBe('sketch-like')
  expect(kept()).toEqual(before)
  canvas.focus()
  await act(async () => { press(canvas, macFind) })
  expect(document.activeElement).toBe(search())
  expect(mode()).toBe('sketch')

  canvas.focus()
  await act(async () => { figma().click() })
  expect(mode()).toBe('figma')
  expect(shortcutPreference.getSnapshot()).toBe('figma-like')
  await act(async () => { sketch().click() })
  expect(mode()).toBe('sketch')
  expect(shortcutPreference.getSnapshot()).toBe('sketch-like')
  expect(kept()).toEqual(before)
})

test('a busy editor and the assets tab do not switch layout; assets returns to the find field', async () => {
  const before = kept()
  editor.set({ busy: true })
  await act(async () => { press(canvas, macFind) })
  expect(document.activeElement).toBe(canvas)
  expect(mode()).toBe('sketch')
  expect(kept()).toEqual(before)
  editor.set({ busy: false })

  const assets = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent === '组件')!
  await act(async () => { assets.click() })
  expect(assets.getAttribute('aria-selected')).toBe('true')
  expect(search()).toBeNull()
  canvas.focus()
  await act(async () => { press(canvas, macFind) })
  expect(mode()).toBe('sketch')
  expect(document.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.textContent).toBe('图层')
  expect(document.activeElement).toBe(search())
  expect(kept()).toEqual(before)
})
