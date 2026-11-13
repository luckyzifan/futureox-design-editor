// Mounted production App. Proves Figma hand/zoom live on the bottom pill,
// and that Sketch keeps zoom in the window toolbar.
import { readFileSync } from 'node:fs'
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
const hand = () => group()?.querySelector<HTMLButtonElement>('button[aria-label="平移"]') ?? null

async function openEditor() {
  await act(async () => { root.render(<App />); for (let i = 0; i < 40; i++) await Promise.resolve() })
  const resume = button('继续编辑')
  expect(resume.disabled).toBe(false)
  await act(async () => resume.click())
  expect(document.querySelector('[aria-label="本机设计首页"]')).toBeNull()
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

test('Figma places hand and zoom above the pill and leaves the inspector tab row', async () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
  const placed = css.match(/\.editor-shell\[data-ui-mode="figma"\] \.figma-view-tools \{[^}]+\}/)?.[0]
  expect(placed).toContain('position: absolute')
  expect(placed).toContain('bottom: calc(100% + 8px)')
  expect(placed).toContain('width: max-content')
  expect(placed).not.toContain('width: 100%')
  const pill = css.match(/\.editor-shell\[data-ui-mode="figma"\] \.floating-toolbar \{[^}]+\}/)?.[0]
  expect(pill).toContain('bottom: 12px')
  expect(pill).toContain('transform: translateX(-50%)')
  expect(css).toContain('.editor-shell[data-ui-mode="figma"] .figma-view-tools .view-menu-body')
  expect(css).toMatch(/\.editor-shell\[data-ui-mode="figma"\] \.figma-view-tools \.view-menu-body \{[^}]*top: auto;/)
  const sketch = css.match(/\.editor-shell\[data-ui-mode="sketch"\] \.floating-toolbar \{\s*position:[^}]+\}/)?.[0]
  expect(sketch).toContain('position: relative')
  expect(sketch).not.toContain('figma-view-tools')

  await openEditor()
  expect(document.querySelector('.editor-shell')!.getAttribute('data-ui-mode')).toBe('figma')
  const tools = group()
  expect(tools).not.toBeNull()
  expect(tools!.closest('.floating-toolbar')).not.toBeNull()
  expect(tools!.closest('.properties-tabs')).toBeNull()
  expect(hand()).not.toBeNull()
  expect(hand()!.getAttribute('aria-pressed')).toBe('false')
  const zoom = readout()
  expect(zoom).not.toBeNull()
  expect(zoom!.textContent).toMatch(/%$/)
  expect(zoom!.closest('[data-testid="figma-view-tools"]')).toBe(tools)
  expect(zoom!.closest('.properties-tabs,.properties-zoom')).toBeNull()
  expect(document.querySelector('.properties-tabs [data-testid="zoom-readout"]')).toBeNull()

  await act(async () => { hand()!.click(); for (let i = 0; i < 10; i++) await Promise.resolve() })
  expect(editor!.state.tool).toBe('hand')
  expect(hand()!.getAttribute('aria-pressed')).toBe('true')
  expect(readout()!.closest('[data-testid="figma-view-tools"]')).toBe(group())

  const toggle = document.querySelector<HTMLButtonElement>('.canvas-panel-toggle.right')!
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  await act(async () => toggle.click())
  expect(document.querySelector('.editor-shell')!.classList.contains('chrome-hide-inspector')).toBe(true)
  expect(readout()!.closest('[data-testid="figma-view-tools"]')).not.toBeNull()
  expect(readout()!.closest('.properties-zoom')).toBeNull()
  await act(async () => toggle.click())
  expect(document.querySelector('.editor-shell')!.classList.contains('chrome-hide-inspector')).toBe(false)
  expect(readout()!.closest('.properties-zoom')).toBeNull()

  await act(async () => button('Sketch').click())
  expect(document.querySelector('.editor-shell')!.getAttribute('data-ui-mode')).toBe('sketch')
  expect(group()).toBeNull()
  expect(readout()!.closest('.editor-header')).not.toBeNull()
  expect(document.querySelector('.floating-toolbar')).not.toBeNull()

  await act(async () => button('Figma').click())
  expect(document.querySelector('.editor-shell')!.getAttribute('data-ui-mode')).toBe('figma')
  expect(group()?.closest('.floating-toolbar')).not.toBeNull()
  expect(readout()!.closest('[data-testid="figma-view-tools"]')).not.toBeNull()
  expect(readout()!.closest('.properties-tabs')).toBeNull()
})
