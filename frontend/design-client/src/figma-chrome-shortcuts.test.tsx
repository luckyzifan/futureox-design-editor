// Mounted Figma layout. Mac modifier branches use a MacIntel platform string.
// This is not Electron receiving a real macOS key.
import { readFileSync } from 'node:fs'
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from './App'
import { Editor } from './engine'
import { applyInterfaceLayout } from './interface-layout'
import { interfacePreference } from './interface-preference'
import { blank, node } from './model'
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

const chromeCss = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
let dom: any, root: Root, editor: Editor | undefined, errors: unknown[][]
beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLCanvasElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'localStorage', 'getComputedStyle']) vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
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
  const style = document.createElement('style')
  style.textContent = chromeCss
  document.head.append(style)
  const set = Editor.prototype.set; editor = undefined
  vi.spyOn(Editor.prototype, 'set').mockImplementation(function (this: Editor, patch) { editor ??= this; return set.call(this, patch) })
  errors = []; vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args))
  interfacePreference.reset(); shortcutPreference.set('figma-like')
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  const mount = document.createElement('div'); document.body.append(mount); root = (await import('react-dom/client')).createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount()); editor?.dispose()
  interfacePreference.reset(); shortcutPreference.set('figma-like')
  dom.window.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); expect(errors).toEqual([])
})

const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.includes(text))!
const canvas = () => document.querySelector<HTMLElement>('[data-testid="canvas"]')!
const shell = () => document.querySelector<HTMLElement>('.editor-shell')!
const shown = (selector: string) => window.getComputedStyle(document.querySelector(selector)!).display !== 'none'
async function render() {
  await act(async () => { root.render(<App />); for (let i = 0; i < 40; i++) await Promise.resolve() })
  const resume = button('继续编辑')
  expect(resume.disabled).toBe(false)
  await act(async () => resume.click())
  expect(document.querySelector('[aria-label="本机设计首页"]')).toBeNull()
}
async function press(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  await act(async () => target.dispatchEvent(event))
  return event
}
const rail = (title: string) => document.querySelector<HTMLButtonElement>(`.workspace-rail [title="${title}"]`)!
const sideTab = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[aria-label="侧栏内容"] [role="tab"]')].find(tab => tab.textContent === label)!

test('Figma Option-1/2 open the layers and assets pages and Option-3 opens the design-system dialog', async () => {
  await render()
  const doc = blank('Sidebar shortcuts'), shape = node('rectangle', 40, 50, 80, 60)
  doc.nodes[shape.id] = shape
  doc.pages[0].children = [shape.id]
  await act(async () => { editor!.load(doc); editor!.select([shape.id]); canvas().focus() })
  const before = editor!.authoredDocument, version = editor!.state.version
  expect(rail('页面与图层').getAttribute('aria-pressed')).toBe('true')
  expect(rail('组件与资源').getAttribute('aria-pressed')).toBe('false')
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="图层面板"]')!.click())
  expect(shell().classList.contains('chrome-hide-layers')).toBe(true)

  await press(canvas(), '¡', { code: 'Digit1', altKey: true })
  expect(shell().classList.contains('chrome-hide-layers')).toBe(false)
  expect(rail('页面与图层').getAttribute('aria-pressed')).toBe('true')
  expect(sideTab('图层').getAttribute('aria-pressed')).toBe('true')
  expect(document.querySelector('.layers-panel')!.getAttribute('aria-label')).toBe('页面与图层')
  expect(shown('.adaptive-layers-shell')).toBe(true)
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="图层面板"]')!.click())
  expect(shell().classList.contains('chrome-hide-layers')).toBe(true)

  await press(canvas(), '™', { code: 'Digit2', altKey: true })
  expect(rail('组件与资源').getAttribute('aria-pressed')).toBe('true')
  expect(sideTab('组件').getAttribute('aria-pressed')).toBe('true')
  expect(document.querySelector('.layers-panel')!.getAttribute('aria-label')).toBe('组件资源')
  expect(shell().classList.contains('chrome-hide-layers')).toBe(false)
  expect(editor!.state.selection).toEqual([shape.id])

  const name = document.querySelector<HTMLInputElement>('[aria-label="文档名称"]')!
  await act(async () => name.focus())
  await press(name, '™', { code: 'Digit2', altKey: true })
  expect(rail('组件与资源').getAttribute('aria-pressed')).toBe('true')
  await press(name, '¡', { code: 'Digit1', altKey: true })
  expect(rail('页面与图层').getAttribute('aria-pressed')).toBe('false')
  await press(name, '£', { code: 'Digit3', altKey: true })
  expect(document.querySelector('[role="dialog"]')).toBeNull()

  await act(async () => canvas().focus())
  await press(canvas(), '£', { code: 'Digit3', altKey: true, repeat: true })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await press(canvas(), '£', { code: 'Digit3', altKey: true, metaKey: true })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  const opened = await press(canvas(), '£', { code: 'Digit3', altKey: true })
  const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="设计系统与交互"]')!
  expect(dialog).not.toBeNull()
  expect(dialog.textContent).toContain('组件库')
  expect(opened.defaultPrevented).toBe(true)
  expect(document.activeElement?.closest('[role="dialog"]')).toBe(dialog)
  await press(document.activeElement!, 'Escape')
  expect(document.querySelector('[role="dialog"][aria-label="设计系统与交互"]')).toBeNull()
  expect(document.activeElement).toBe(canvas())

  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' })
  await press(canvas(), '1', { code: 'Digit1', altKey: true })
  expect(rail('页面与图层').getAttribute('aria-pressed')).toBe('true')
  expect(shell().classList.contains('chrome-hide-layers')).toBe(false)
  await press(canvas(), '2', { code: 'Digit2', ctrlKey: true })
  expect(rail('页面与图层').getAttribute('aria-pressed')).toBe('true')
  const { registerPendingEdit } = await import('./pending-edits')
  const commit = vi.fn(() => false)
  const unregister = registerPendingEdit(editor!, { dirty: () => true, commit })
  try {
    await press(canvas(), '2', { code: 'Digit2', altKey: true })
    expect(rail('页面与图层').getAttribute('aria-pressed')).toBe('true')
    expect(editor!.authoredDocument).toBe(before)
  } finally { unregister() }
  expect(editor!.authoredDocument).toBe(before)
  expect(editor!.state.version).toBe(version)
  expect(editor!.canUndo).toBe(false)
  expect(editor!.state.selection).toEqual([shape.id])
})

test('Figma Command-backslash hides the whole interface and Shift-Command-backslash still minimizes', async () => {
  await render()
  const doc = blank('Hide interface'), shape = node('rectangle', 30, 40, 70, 50)
  doc.nodes[shape.id] = shape
  doc.pages[0].children = [shape.id]
  await act(async () => { editor!.load(doc); editor!.select([shape.id]); editor!.set({ pixelGrid: false }); canvas().focus() })
  const before = editor!.authoredDocument, version = editor!.state.version
  const hidden = () => shell().classList.contains('chrome-hidden')
  const minimized = () => document.querySelector('.editor-workspace')!.classList.contains('ui-minimized')
  expect(shown('.editor-header')).toBe(true)
  expect(shown('.floating-toolbar')).toBe(true)
  expect(shown('.properties-workspace')).toBe(true)
  expect(hidden()).toBe(false)

  await act(async () => interfacePreference.set({ figmaKeyboardLayout: 'de-qwertz' }))
  await act(async () => canvas().focus())
  await press(canvas(), '#', { code: 'Backslash', metaKey: true })
  expect(editor!.state.pixelGrid).toBe(true)
  expect(hidden()).toBe(false)
  await act(async () => { editor!.set({ pixelGrid: false }); interfacePreference.set({ figmaKeyboardLayout: 'us-qwerty' }); canvas().focus() })

  const name = document.querySelector<HTMLInputElement>('[aria-label="文档名称"]')!
  await act(async () => name.focus())
  await press(name, '\\', { code: 'Backslash', metaKey: true })
  expect(hidden()).toBe(false)
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="文件菜单"]')!.click())
  expect(document.querySelector('.file-menu')).not.toBeNull()
  await press(canvas(), '\\', { code: 'Backslash', metaKey: true })
  expect(hidden()).toBe(false)
  await act(async () => document.querySelector<HTMLButtonElement>('.menu-scrim')!.click())
  expect(document.querySelector('.file-menu')).toBeNull()

  await act(async () => canvas().focus())
  await press(canvas(), '\\', { code: 'Backslash', ctrlKey: true })
  expect(hidden()).toBe(false)
  await press(canvas(), '\\', { code: 'Backslash', metaKey: true, shiftKey: true })
  expect(hidden()).toBe(false)
  expect(minimized()).toBe(true)
  expect(shown('.editor-header')).toBe(true)
  expect(shown('.floating-toolbar')).toBe(true)
  expect(shell().classList.contains('chrome-hide-inspector')).toBe(false)
  expect(shown('.properties-workspace')).toBe(true)
  expect(shell().classList.contains('chrome-hide-layers')).toBe(true)

  await press(canvas(), '\\', { code: 'Backslash', metaKey: true })
  expect(hidden()).toBe(true)
  expect(shell().classList.contains('chrome-hide-layers')).toBe(true)
  expect(shell().classList.contains('chrome-hide-inspector')).toBe(true)
  expect(shown('.editor-header')).toBe(false)
  expect(shown('.floating-toolbar')).toBe(false)
  expect(shown('.properties-workspace')).toBe(false)
  expect(shown('.adaptive-layers-shell')).toBe(false)
  expect(document.querySelector('.canvas-panel-toggles')).toBeNull()
  expect(editor!.state.selection).toEqual([shape.id])

  await press(canvas(), '\\', { code: 'Backslash', metaKey: true })
  expect(hidden()).toBe(false)
  expect(minimized()).toBe(true)
  expect(shown('.editor-header')).toBe(true)
  expect(shown('.floating-toolbar')).toBe(true)
  expect(shown('.properties-workspace')).toBe(true)
  await press(canvas(), '\\', { code: 'Backslash', metaKey: true, shiftKey: true })
  expect(minimized()).toBe(false)
  expect(shown('.adaptive-layers-shell')).toBe(true)
  expect(shown('.properties-workspace')).toBe(true)

  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' })
  await press(canvas(), '\\', { code: 'Backslash', metaKey: true })
  expect(hidden()).toBe(false)
  await press(canvas(), '\\', { code: 'Backslash', ctrlKey: true })
  expect(hidden()).toBe(true)
  expect(shown('.editor-header')).toBe(false)
  expect(shown('.floating-toolbar')).toBe(false)
  expect(shown('.properties-workspace')).toBe(false)
  await press(canvas(), '\\', { code: 'Backslash', ctrlKey: true, shiftKey: true })
  expect(hidden()).toBe(true)
  expect(minimized()).toBe(true)
  await press(canvas(), '\\', { code: 'Backslash', ctrlKey: true })
  expect(hidden()).toBe(false)
  await press(canvas(), '\\', { code: 'Backslash', ctrlKey: true, shiftKey: true })
  expect(minimized()).toBe(false)

  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  await act(async () => applyInterfaceLayout('sketch'))
  await act(async () => canvas().focus())
  await press(canvas(), '\\', { code: 'Backslash', metaKey: true })
  expect(document.querySelector('.editor-shell')!.classList.contains('chrome-hidden')).toBe(false)
  await press(canvas(), '.', { code: 'Period', metaKey: true })
  expect(document.querySelector('.editor-workspace')!.classList.contains('ui-minimized')).toBe(true)
  expect(editor!.authoredDocument).toBe(before)
  expect(editor!.state.version).toBe(version)
  expect(editor!.canUndo).toBe(false)
  expect(editor!.state.selection).toEqual([shape.id])
})
