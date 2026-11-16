// Mounted React / Editor. jsdom is not the macOS Figma or Electron GUI.
// @ts-expect-error jsdom runtime dependency
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Layers } from './Layers'
import { Editor } from './engine'
import { applyInterfaceLayout } from './interface-layout'
import { interfacePreference } from './interface-preference'
import { topPerformanceFindDocument } from './layer-find-fixture'
import { closeLayerFind, layerFindSnapshot } from './layer-find-session'
import { shortcutPreference } from './shortcut-preference'

vi.mock('./kernel/Surface', async () => {
  const { useLayoutEffect } = await import('react')
  return { KernelSurface(props: import('./kernel/Surface').SurfaceProps) {
    useLayoutEffect(() => { props.onPresentation?.({ ...props, epoch: props.presentationEpoch!, pixelRatio: 1, managed: false }) }, [props.document, props.pageId, props.view, props.width, props.height, props.presentationEpoch, props.onPresentation])
    return <div data-testid="surface-boundary" />
  } }
})

let dom: JSDOM, root: Root, editor: Editor
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://design.invalid/' })
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLButtonElement', 'HTMLCanvasElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'localStorage'])
    vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key])
  Object.defineProperty(dom.window.navigator, 'platform', { configurable: true, value: 'MacIntel' })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('devicePixelRatio', 1)
  vi.stubGlobal('CSS', { escape: (value: string) => value })
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => 1000 }, clientHeight: { configurable: true, get: () => 800 },
  })
  vi.spyOn(dom.window.HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0, toJSON() {} })
  vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  for (const name of ['attachEvent', 'detachEvent'] as const) {
    Object.defineProperty(dom.window.HTMLElement.prototype, name, { configurable: true, value: () => {} })
  }
  localStorage.clear()
  interfacePreference.reset()
  shortcutPreference.set('figma-like')
  closeLayerFind()
  const fixture = topPerformanceFindDocument()
  editor = new Editor(fixture.doc)
  editor.select([fixture.frameId])
  root = createRoot(document.getElementById('root')!)
})
afterEach(async () => {
  await act(async () => { closeLayerFind(); root.unmount() })
  editor.dispose()
  interfacePreference.reset()
  shortcutPreference.set('figma-like')
  dom.window.close()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
function ids() {
  const frame = editor.state.doc.nodes[editor.state.doc.pages[0].children[0]]
  const group = editor.state.doc.nodes[frame.children[1]]
  const pageText = editor.state.doc.nodes[group.children[0]]
  const other = editor.state.doc.nodes[editor.state.doc.pages[1].children[0]]
  return { frame, group, pageText, other }
}
async function renderLayers() {
  await act(async () => { root.render(<Layers editor={editor} showPages={false} />); await Promise.resolve() })
}
async function typeQuery(value: string) {
  const input = document.querySelector<HTMLInputElement>('.layer-find input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'p', bubbles: true }))
  })
}
async function key(target: EventTarget, value: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init })
  await act(async () => { target.dispatchEvent(event); await Promise.resolve() })
  return event
}
const hits = () => [...document.querySelectorAll<HTMLElement>('[data-find-type]')]
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!

test('find lists the group before the text, filters, and moves selection without history', async () => {
  const before = editor.state.doc
  const version = editor.state.version
  await renderLayers()
  expect(document.querySelector('[role="tree"]')).not.toBeNull()
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="搜索图层"]')!.click())
  const input = document.querySelector<HTMLInputElement>('.layer-find input')!
  expect(document.activeElement).toBe(input)
  expect(document.querySelector('[role="tree"]')).toBeNull()
  await typeQuery('Top Performance')
  expect(hits().map(hit => hit.dataset.findType)).toEqual(['group', 'text'])
  expect(hits().map(hit => hit.querySelector('.layer-find-kind')!.textContent)).toEqual(['编组', '文本'])
  expect(document.querySelector('.layer-find-page')!.textContent).toBe('此页面')
  expect(editor.state.selection).toEqual([ids().frame.id])
  await key(input, 'Enter', { code: 'Enter' })
  expect(editor.state.selection.map(id => `${editor.state.doc.nodes[id]?.kind}:${editor.state.doc.nodes[id]?.name}`)).toEqual(['group:Top Performance'])
  await key(input, 'Enter', { code: 'Enter' })
  expect(editor.state.selection).toEqual([ids().pageText.id])
  await key(input, 'Enter', { code: 'Enter', shiftKey: true })
  expect(editor.state.selection).toEqual([ids().group.id])
  await act(async () => button('全部页面').click())
  expect(hits().map(hit => hit.dataset.findType)).toEqual(['group', 'text', 'text'])
  expect([...document.querySelectorAll('.layer-find-page')].map(item => item.textContent)).toEqual(['Meher Admin Dashboard Ui Kit Light', 'Campaigns'])
  await key(input, 'ArrowDown', { code: 'ArrowDown' })
  await key(input, 'ArrowDown', { code: 'ArrowDown' })
  expect(editor.state.page).toBe(editor.state.doc.pages[1].id)
  expect(editor.state.selection).toEqual([ids().other.id])
  await key(input, 'ArrowUp', { code: 'ArrowUp' })
  expect(editor.state.page).toBe(editor.state.doc.pages[0].id)
  expect(editor.state.selection).toEqual([ids().pageText.id])
  await act(async () => button('类型').click())
  const textFilter = [...document.querySelectorAll<HTMLLabelElement>('.layer-find-options label')].find(label => label.textContent === '文本')!
  await act(async () => textFilter.querySelector('input')!.click())
  expect(hits().map(hit => hit.dataset.findType)).toEqual(['text', 'text'])
  await act(async () => button('设置').click())
  const matchCase = [...document.querySelectorAll<HTMLLabelElement>('.layer-find-options label')].find(label => label.textContent === '匹配大小写')!
  await typeQuery('top performance')
  expect(hits().length).toBeGreaterThan(0)
  await act(async () => matchCase.querySelector('input')!.click())
  expect(hits()).toEqual([])
  expect(document.querySelector('[role="status"]')!.textContent).toBe('没有匹配图层')
  const wholeWords = [...document.querySelectorAll<HTMLLabelElement>('.layer-find-options label')].find(label => label.textContent === '全词匹配')!
  await act(async () => matchCase.querySelector('input')!.click())
  await typeQuery('Perf')
  expect(hits().length).toBeGreaterThan(0)
  await act(async () => wholeWords.querySelector('input')!.click())
  expect(hits()).toEqual([])
  await typeQuery('Top')
  expect(hits().length).toBeGreaterThan(0)
  await key(input, 'Escape', { code: 'Escape' })
  expect(document.querySelector('.layer-find')).not.toBeNull()
  expect(document.querySelector('.layer-find-options')).toBeNull()
  await key(input, 'Escape', { code: 'Escape' })
  expect(document.querySelector('.layer-find')).toBeNull()
  expect(document.querySelector('[role="tree"]')).not.toBeNull()
  expect(document.activeElement).toBe(document.querySelector('[aria-label="搜索图层"]'))
  expect(editor.state.doc).toBe(before)
  expect(editor.state.version).toBe(version)
  expect(editor.canUndo).toBe(false)
  expect(layerFindSnapshot()).toBe(0)
})

test('english labels use the native type names and sketch find stays on its own entry', async () => {
  await act(async () => { interfacePreference.set({ locale: 'en' }) })
  await renderLayers()
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Search layers"]')!.click())
  await typeQuery('Top Performance')
  expect(hits().map(hit => hit.querySelector('.layer-find-kind')!.textContent)).toEqual(['Group', 'Text'])
  expect(button('This page').getAttribute('aria-pressed')).toBe('true')
  expect(button('All pages')).not.toBeUndefined()
  await act(async () => button('Settings').click())
  expect([...document.querySelectorAll('.layer-find-options label')].map(label => label.textContent)).toEqual(['Match case', 'Whole words'])
  await act(async () => { closeLayerFind() })
  await act(async () => { applyInterfaceLayout('sketch') })
  expect(document.querySelector('.layer-find')).toBeNull()
  expect(document.querySelector('.sketch-layer-search [aria-label="Search layers"]')).not.toBeNull()
  const related = document.querySelector<HTMLButtonElement>('[aria-keyshortcuts="Control+F"]')!
  expect(related.getAttribute('aria-pressed')).toBe('false')
  const event = await key(window, 'f', { code: 'KeyF', ctrlKey: true })
  expect(event.defaultPrevented).toBe(true)
  expect(related.getAttribute('aria-pressed')).toBe('true')
  expect(layerFindSnapshot()).toBe(0)
  expect(document.querySelector('[role="tree"]')).not.toBeNull()
  expect(editor.canUndo).toBe(false)
})

test('canvas Mod+F opens find and text editing keeps the shortcut', async () => {
  const desktop = { version: 1, onCommand: () => () => {} }
  Object.assign(window, { coreDesktop: desktop })
  const before = editor.state.doc
  const version = editor.state.version
  await act(async () => { root.render(<><Canvas editor={editor} /><Layers editor={editor} showPages={false} /></>); for (let i = 0; i < 8; i++) await Promise.resolve() })
  const canvas = document.querySelector<HTMLElement>('[data-testid="canvas"]')!
  canvas.focus()
  const chord = await key(canvas, 'f', { code: 'KeyF', metaKey: true })
  expect(chord.defaultPrevented).toBe(true)
  const input = document.querySelector<HTMLInputElement>('.layer-find input')!
  expect(document.activeElement).toBe(input)
  await typeQuery('Top Performance')
  await key(input, 'Enter', { code: 'Enter' })
  expect(editor.state.selection.map(id => `${editor.state.doc.nodes[id]?.kind}:${editor.state.doc.nodes[id]?.name}`)).toEqual(['group:Top Performance'])
  expect(editor.state.doc).toBe(before)
  expect(editor.state.version).toBe(version)
  expect(editor.canUndo).toBe(false)
  await key(input, 'Escape', { code: 'Escape' })
  expect(document.querySelector('.layer-find')).toBeNull()
  expect(document.activeElement).toBe(canvas)
  const held = await key(canvas, 'f', { code: 'KeyF', metaKey: true, altKey: true })
  expect(layerFindSnapshot()).toBe(0)
  expect(held.defaultPrevented).toBe(false)
  expect(interfacePreference.getSnapshot().uiMode).toBe('figma')
  await act(async () => { editor.select([ids().pageText.id]) })
  canvas.focus()
  await key(canvas, 'Enter', { code: 'Enter' })
  const text = document.querySelector<HTMLTextAreaElement>('[aria-label="画布文字编辑"]')
  expect(text).not.toBeNull()
  expect(document.activeElement).toBe(text)
  const duringEdit = await key(text!, 'f', { code: 'KeyF', metaKey: true })
  expect(duringEdit.defaultPrevented).toBe(false)
  expect(layerFindSnapshot()).toBe(0)
  expect(document.activeElement).toBe(text)
  expect(editor.state.doc).toBe(before)
  expect(editor.state.version).toBe(version)
  expect(editor.canUndo).toBe(false)
  delete (window as { coreDesktop?: unknown }).coreDesktop
})
