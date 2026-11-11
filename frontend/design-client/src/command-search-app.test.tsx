// Mounted App + Canvas. Proves the Sketch command bar, the static arrange menu,
// and the existing design-system dialog stay separate. jsdom is not macOS or native Sketch.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from './App'
import { closeCommandSearch } from './command-search-session'
import { Editor } from './engine'
import { applyInterfaceLayout } from './interface-layout'
import { interfacePreference } from './interface-preference'
import * as localStore from './local-store'
import { nudgePreference } from './nudge-preference'
import { shortcutPreference } from './shortcut-preference'
import * as startupPreview from './startup-preview'

vi.mock('./kernel/Surface', async () => {
  const { useLayoutEffect } = await import('react')
  return { KernelSurface(props: import('./kernel/Surface').SurfaceProps) {
    useLayoutEffect(() => { props.onPresentation?.({ ...props, epoch: props.presentationEpoch!, pixelRatio: 1, managed: false }) }, [props.document, props.pageId, props.view, props.width, props.height, props.presentationEpoch, props.onPresentation])
    return <div data-testid="surface-boundary" />
  } }
})
let dom: JSDOM, root: Root, mount: HTMLElement, editor: Editor | undefined, errors: unknown[][]
beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLCanvasElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'localStorage'])
    vi.stubGlobal(name, name === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('devicePixelRatio', 1)
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, character => `\\${character}`) })
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  dom.window.HTMLElement.prototype.scrollTo = function () {}
  Object.defineProperties(dom.window.HTMLElement.prototype, { clientWidth: { configurable: true, get: () => 1000 }, clientHeight: { configurable: true, get: () => 800 } })
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
  localStorage.clear()
  nudgePreference.reset()
  interfacePreference.reset()
  applyInterfaceLayout('sketch')
  closeCommandSearch()
  mount = document.createElement('div')
  document.body.append(mount)
  root = (await import('react-dom/client')).createRoot(mount)
})
afterEach(async () => {
  closeCommandSearch()
  await act(async () => root.unmount())
  editor?.dispose()
  nudgePreference.reset()
  shortcutPreference.set('figma-like')
  interfacePreference.reset()
  dom.window.close()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  expect(errors).toEqual([])
})
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.includes(text))!
async function render() {
  await act(async () => { root.render(<App />); for (let i = 0; i < 40; i++) await Promise.resolve() })
  await act(async () => button('继续编辑').click())
  expect(document.querySelector('[data-testid="canvas"]')).not.toBeNull()
}
async function key(target: EventTarget, value: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: value, code: value.length === 1 ? `Key${value.toUpperCase()}` : value, bubbles: true, cancelable: true, ...init }))
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

test('sketch layout opens command search from S without editing, and keeps the static menu and design system', async () => {
  await render()
  expect(editor).toBeDefined()
  const before = editor!.state.doc
  const version = editor!.state.version
  expect(editor!.state.tool).toBe('select')
  expect(document.querySelector('[aria-label="搜索图层"]')).not.toBeNull()
  expect(document.querySelector('[aria-label="运行命令"]')).not.toBeNull()
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="文件菜单"]')!.click())
  expect(button('运行…').textContent).toContain('S')
  await act(async () => button('运行…').click())
  expect(document.querySelector('[role="combobox"]')?.getAttribute('placeholder')).toBe('搜索命令…')
  await act(async () => { document.querySelector<HTMLElement>('[aria-label="关闭命令搜索"]')!.click() })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="排列与编辑"]')!.click())
  const arrange = document.querySelector<HTMLElement>('[role="menu"][aria-label="排列与编辑"]')!
  expect(arrange.querySelector('input')).toBeNull()
  expect(arrange.textContent).toContain('编组')
  expect(arrange.textContent).toContain('变量 · 组件库 · 原型')
  await act(async () => button('变量 · 组件库 · 原型').click())
  const design = document.querySelector<HTMLElement>('[aria-label="设计系统与交互"]')!
  expect(design).not.toBeNull()
  expect(document.querySelector('[role="combobox"]')).toBeNull()
  await act(async () => [...design.querySelectorAll('button')].find(item => item.textContent === '关闭')!.click())
  expect(document.querySelector('[aria-label="设计系统与交互"]')).toBeNull()
  const canvas = document.querySelector<HTMLElement>('[data-testid="canvas"]')!
  canvas.focus()
  await key(canvas, 's')
  const search = document.querySelector<HTMLInputElement>('[role="combobox"]')!
  expect(search.placeholder).toBe('搜索命令…')
  expect(editor!.state.doc).toBe(before)
  expect(editor!.state.version).toBe(version)
  expect(editor!.canUndo).toBe(false)
  expect(editor!.state.tool).toBe('select')
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(search, 'command-search-token')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await key(search, 's')
  expect(editor!.state.doc).toBe(before)
  expect(editor!.state.version).toBe(version)
  expect(editor!.canUndo).toBe(false)
  expect(editor!.state.tool).toBe('select')
  expect(JSON.stringify(editor!.state.doc)).not.toContain('command-search-token')
  await key(search, 'Escape')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.activeElement).toBe(canvas)
  await act(async () => { applyInterfaceLayout('figma') })
  await key(canvas, 's')
  expect(editor!.state.tool).toBe('slice')
  expect(editor!.state.doc).toBe(before)
  expect(document.querySelector('[role="combobox"]')).toBeNull()
  expect(document.querySelector('[aria-label="排列与编辑"]')).not.toBeNull()
  expect(document.querySelector('[aria-label="搜索图层"]')).not.toBeNull()
})
