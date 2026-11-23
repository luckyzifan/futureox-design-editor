// The mounted workspace uses the native layouts' view and insert entry points.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from './App'
import { Editor } from './engine'
import { interfacePreference } from './interface-preference'
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

let dom: any, root: Root, editor: Editor | undefined, errors: unknown[][]
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
  interfacePreference.reset(); shortcutPreference.set('figma-like')
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' })
  const mount = document.createElement('div'); document.body.append(mount); root = (await import('react-dom/client')).createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount()); editor?.dispose()
  interfacePreference.reset(); shortcutPreference.set('figma-like')
  dom.window.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); expect(errors).toEqual([])
})

const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.includes(text))!
const group = () => document.querySelector<HTMLElement>('[data-testid="figma-view-tools"]')
const readout = () => document.querySelector<HTMLElement>('[data-testid="zoom-readout"]')

async function openEditor() {
  await act(async () => { root.render(<App />); for (let i = 0; i < 40; i++) await Promise.resolve() })
  const resume = button('继续编辑')
  expect(resume.disabled).toBe(false)
  await act(async () => resume.click())
  expect(document.querySelector('[aria-label="本机设计首页"]')).toBeNull()
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

test('Figma zoom follows the inspector and Sketch insert opens the top tool menu', async () => {
  await openEditor()
  expect(document.querySelector('.editor-shell')?.getAttribute('data-ui-mode')).toBe('figma')
  expect(readout()?.textContent).toMatch(/%$/)
  expect(group()?.closest('.properties-tabs')).not.toBeNull()
  expect(readout()?.closest('[data-testid="figma-view-tools"]')).toBe(group())
  expect(document.querySelector('.canvas-workspace .floating-toolbar')).not.toBeNull()

  const toggle = document.querySelector<HTMLButtonElement>('.canvas-panel-toggle.right')!
  await act(async () => toggle.click())
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(readout()?.closest('.editor-header')).not.toBeNull()
  await act(async () => toggle.click())
  expect(readout()?.closest('.properties-tabs')).not.toBeNull()

  await act(async () => button('Sketch').click())
  expect(document.querySelector('.editor-shell')?.getAttribute('data-ui-mode')).toBe('sketch')
  expect(group()).toBeNull()
  expect(readout()?.closest('.sketch-window-zoom')).not.toBeNull()
  const title = document.querySelector('.document-title')!, tools = document.querySelector('.sketch-window-tools')!
  expect(title.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  const insert = tools.querySelector<HTMLButtonElement>('button[aria-label="置入"]')!
  const preview = tools.querySelector<HTMLButtonElement>('button[aria-label="预览"]')
  expect(preview).not.toBeNull()
  expect(preview?.classList.contains('prototype-preview-button')).toBe(false)
  expect(preview?.classList.contains('sketch-preview-tool')).toBe(true)
  expect(document.querySelector('.prototype-preview-button')).toBeNull()
  expect(document.querySelector('.properties-tabs')).toBeNull()
  expect(tools.querySelector('button[aria-label="编辑"]')?.classList.contains('sketch-edit-tool')).toBe(true)
  expect(insert.classList.contains('sketch-insert-tool')).toBe(true)
  expect(tools.querySelector('button[aria-label="画框"]')?.classList.contains('sketch-main-tool')).toBe(true)
  await act(async () => insert.click())
  const menu = document.querySelector('[role="menu"][aria-label="置入"]')!
  const rect = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(item => item.textContent === '矩形')!
  await act(async () => rect.click())
  expect(editor?.state.tool).toBe('rectangle')

  await act(async () => button('Figma').click())
  expect(readout()?.closest('.properties-tabs')).not.toBeNull()
  expect(document.querySelector('.sketch-window-tools')).toBeNull()
  expect(document.querySelector('button[aria-label="预览"]')).toBeNull()
  expect(document.querySelector('.prototype-preview-button')).not.toBeNull()
  expect(document.querySelector('#design-properties-tab, .properties-tabs button')).not.toBeNull()
})
