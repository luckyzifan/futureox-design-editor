// Mounted canvas and zoom menu. Proves Shift+G hides authored layout bands
// without a document edit. Not a Mac Figma, Electron, or GPU pixel claim.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { blank, defaultLayoutGrid, node } from './model'
import { interfacePreference } from './interface-preference'
import { shortcutPreference } from './shortcut-preference'

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
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLCanvasElement', 'HTMLDetailsElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'FocusEvent', 'localStorage'])
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('devicePixelRatio', 1)
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, character => `\\${character}`) })
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => 1000 }, clientHeight: { configurable: true, get: () => 800 },
  })
  vi.spyOn(dom.window.HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0, toJSON() {} })
  dom.window.HTMLElement.prototype.setPointerCapture = () => {}
  dom.window.HTMLElement.prototype.hasPointerCapture = () => false
  dom.window.HTMLElement.prototype.releasePointerCapture = () => {}
  vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  localStorage.clear()
  interfacePreference.reset()
  shortcutPreference.set('figma-like')
  editor = new Editor(blank('Layout guides'))
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
})

const host = () => mount.querySelector<HTMLElement>('[data-testid="canvas"]')!
const bands = () => mount.querySelectorAll('[data-testid="authored-layout-grid-band"]')
const guideLabel = () => [...mount.querySelectorAll('label')].find(label => label.textContent?.includes('布局参考线') || label.textContent?.includes('显示布局'))
async function renderScene() {
  const frame = node('frame', 40, 30, 360, 240)
  frame.layoutGrid = defaultLayoutGrid()
  const left = node('rectangle', 80, 80, 40, 30)
  const right = node('rectangle', 180, 90, 50, 40)
  const doc = blank('Layout guides')
  doc.schemaVersion = 12
  doc.nodes = { [frame.id]: frame, [left.id]: left, [right.id]: right }
  doc.pages[0].children = [frame.id, left.id, right.id]
  editor.load(doc)
  editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false, tool: 'select' })
  await act(async () => { root.render(<Canvas editor={editor} />); for (let i = 0; i < 8; i++) await Promise.resolve() })
  host().focus()
  await act(async () => editor.select([frame.id]))
  return { frame, left, right }
}
function press(value: string, options: KeyboardEventInit = {}, target: EventTarget = host()) {
  const event = new KeyboardEvent('keydown', {
    key: value, code: value.length === 1 ? `Key${value.toUpperCase()}` : value,
    bubbles: true, cancelable: true, ...options,
  })
  return act(async () => { target.dispatchEvent(event) })
}

test('Figma layout Shift+G hides every authored layout band and the zoom menu shows that chord', async () => {
  const { frame } = await renderScene()
  const doc = editor.state.doc
  const version = editor.state.version
  expect(bands().length).toBeGreaterThan(0)
  expect(guideLabel()?.textContent).toContain('布局参考线　⇧ G')
  expect(guideLabel()?.querySelector('input')?.checked).toBe(true)

  await press('G', { shiftKey: true })
  expect(editor.state.showAuthoredLayout).toBe(false)
  expect(bands().length).toBe(0)
  expect(guideLabel()?.querySelector('input')?.checked).toBe(false)
  expect(editor.state.doc).toBe(doc)
  expect(editor.state.version).toBe(version)
  expect(editor.canUndo).toBe(false)

  await press('G', { shiftKey: true, repeat: true })
  expect(editor.state.showAuthoredLayout).toBe(false)
  expect(bands().length).toBe(0)
  await press('g', { ctrlKey: true })
  expect(editor.state.showAuthoredLayout).toBe(false)
  expect(editor.state.doc).toBe(doc)

  const originalName = editor.state.doc.nodes[frame.id].name
  editor.change('rename', draft => { draft.nodes[frame.id].name = 'Renamed frame' })
  const renamed = editor.state.doc
  await press('G', { shiftKey: true })
  expect(editor.state.showAuthoredLayout).toBe(true)
  expect(bands().length).toBeGreaterThan(0)
  expect(editor.state.doc).toBe(renamed)
  editor.undo()
  expect(editor.state.doc.nodes[frame.id].name).toBe(originalName)
  expect(editor.state.showAuthoredLayout).toBe(true)
  expect(bands().length).toBeGreaterThan(0)

  const field = document.createElement('input')
  document.body.append(field)
  field.focus()
  await press('G', { shiftKey: true }, field)
  expect(editor.state.showAuthoredLayout).toBe(true)
  expect(editor.state.doc.nodes[frame.id].name).toBe(originalName)
})

test('Sketch keeps Ctrl+L, and Shift+G does not group or replace Cmd+G', async () => {
  const { left, right } = await renderScene()
  await act(async () => { shortcutPreference.set('sketch-like'); interfacePreference.set({ uiMode: 'sketch' }) })
  expect(guideLabel()?.textContent).toContain('显示布局　⌃ L')
  expect(mount.textContent).not.toContain('布局参考线')
  await press('G', { shiftKey: true })
  expect(editor.state.showAuthoredLayout !== false).toBe(true)
  await press('l', { ctrlKey: true })
  expect(editor.state.showAuthoredLayout).toBe(false)
  await press('l', { ctrlKey: true })
  expect(editor.state.showAuthoredLayout).toBe(true)
  expect(editor.canUndo).toBe(false)

  await act(async () => { shortcutPreference.set('figma-like'); interfacePreference.set({ uiMode: 'figma' }) })
  await act(async () => editor.select([left.id, right.id]))
  const nodes = Object.keys(editor.state.doc.nodes).length
  const guides = editor.state.showAuthoredLayout
  await press('G', { shiftKey: true })
  expect(editor.state.showAuthoredLayout).toBe(guides === false)
  expect(Object.keys(editor.state.doc.nodes)).toHaveLength(nodes)
  await press('g', { metaKey: true })
  expect(Object.values(editor.state.doc.nodes).some(node => node.kind === 'group')).toBe(true)
  expect(editor.state.showAuthoredLayout).toBe(guides === false)
})
