// Mounted production App. Graphics and native dialogs are replaced. This proves
// which persistent control opens which library, not a window-manager layout.
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
import type { DesktopBridge, DesktopCommand } from './desktop'

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
const location = () => document.querySelector<HTMLButtonElement>('.document-location')!
const railFiles = () => document.querySelector<HTMLButtonElement>('.workspace-rail button[title="本机设计文件"]')
const shell = () => document.querySelector<HTMLElement>('.app-shell')!

async function render(bridge?: DesktopBridge) {
  if (bridge) Object.defineProperty(window, 'coreDesktop', { configurable: true, value: bridge })
  await act(async () => { root.render(<App />); for (let i = 0; i < 40; i++) await Promise.resolve() })
  const resume = button('继续编辑')
  expect(resume.disabled).toBe(false)
  await act(async () => resume.click())
  expect(document.querySelector('[aria-label="本机设计首页"]')).toBeNull()
}

function host(extra: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    version: 1, renderPolicy: { cpuOnly: true },
    onCommand: () => () => {}, onCloseRequested: () => () => {}, setDirty: async () => {},
    readRecovery: async () => ({ status: 'cancelled' }), writeRecovery: async () => ({ status: 'ok' }),
    openDocument: async () => ({ status: 'cancelled' }),
    ...extra,
  } as DesktopBridge
}

test('Figma workspace keeps one persistent library entry and Sketch, the file shortcut, history and trash still open', async () => {
  const openDocument = vi.fn(async () => ({ status: 'cancelled' as const }))
  let command: ((name: DesktopCommand) => void) | undefined
  await render(host({
    openDocument,
    onCommand: (callback) => { command = callback; return () => {} },
    workspace: {
      list: async () => ({ status: 'ok', documents: [] }),
      open: async () => ({ status: 'cancelled' }),
      commit: async () => ({ status: 'cancelled' }),
      trash: async () => ({ status: 'cancelled' }),
      revisions: async () => ({ status: 'ok', revisions: [] }),
      restore: async () => ({ status: 'cancelled' }),
    },
  }))
  const before = editor!.state.doc
  expect(shell().getAttribute('data-ui-mode')).toBe('figma')
  expect(location().textContent).toBe('本机设计')
  expect(location().title).toBe('打开本机文档库')
  expect(railFiles()).toBeNull()
  expect(document.querySelector('.workspace-rail-divider')).toBeNull()
  expect(document.querySelector('.workspace-rail [title="页面与图层"]')).not.toBeNull()
  const assets = document.querySelector<HTMLButtonElement>('.workspace-rail [title="组件与资源"]')!
  await act(async () => assets.click())
  expect(assets.getAttribute('aria-pressed')).toBe('true')
  await act(async () => { location().focus(); location().click() })
  const library = document.querySelector<HTMLElement>('.workspace-library')!
  expect(library.getAttribute('role')).toBe('dialog')
  expect(library.textContent).toContain('本机文档库')
  expect(library.textContent).toContain('回收站')
  expect(library.querySelector('[aria-label="搜索本机设计"]')).not.toBeNull()
  expect(editor!.state.doc).toBe(before)
  expect(openDocument).not.toHaveBeenCalled()
  const closeLibrary = document.querySelector<HTMLButtonElement>('[aria-label="关闭本机文档库"]')!
  await act(async () => { closeLibrary.focus(); closeLibrary.click() })
  expect(document.querySelector('.workspace-library')).toBeNull()
  expect(document.activeElement).toBe(location())
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="文件菜单"]')!.click())
  expect(button('打开本机设计文件').textContent).toContain('Ctrl+O')
  await act(async () => { document.querySelector<HTMLButtonElement>('.menu-scrim')!.click() })
  await act(async () => { command!('open'); for (let i = 0; i < 20; i++) await Promise.resolve() })
  expect(openDocument).toHaveBeenCalledOnce()
  expect(document.querySelector('.workspace-library')).toBeNull()
  expect(editor!.state.doc).toBe(before)
  await act(async () => button('Sketch').click())
  expect(shell().getAttribute('data-ui-mode')).toBe('sketch')
  expect(location().textContent).toBe('本机设计')
  expect(railFiles()).not.toBeNull()
  await act(async () => location().click())
  expect(document.querySelector('.workspace-library')).not.toBeNull()
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="关闭本机文档库"]')!.click())
  await act(async () => button('Figma').click())
  expect(shell().getAttribute('data-ui-mode')).toBe('figma')
  expect(railFiles()).toBeNull()
  expect(location().textContent).toBe('本机设计')
})

test('desktop files keep both persistent entries on the project catalog, not the workspace library', async () => {
  const listCatalog = vi.fn(async () => ({ status: 'ok' as const, projects: [], directories: [], files: [] }))
  await render(host({ listCatalog }))
  expect(shell().getAttribute('data-ui-mode')).toBe('figma')
  expect(location().textContent).toBe('本机设计')
  expect(location().title).toBe('')
  expect(railFiles()).not.toBeNull()
  await act(async () => location().click())
  expect(document.querySelector('.desktop-catalog')).not.toBeNull()
  expect(document.querySelector('.workspace-library')).toBeNull()
  expect(listCatalog).toHaveBeenCalled()
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="关闭项目目录"]')!.click())
  await act(async () => railFiles()!.click())
  expect(document.querySelector('.desktop-catalog')).not.toBeNull()
  expect(document.querySelector('[role="dialog"][aria-label="本机文件"]')).toBeNull()
})

test('the browser keeps the header, rail and local-files button on the browser library', async () => {
  await render()
  expect(location().textContent).toBe('我的设计')
  expect(railFiles()).not.toBeNull()
  const localFiles = button('本机文件')
  expect(localFiles).not.toBeNull()
  await act(async () => location().click())
  expect(document.querySelector('[aria-label="本机文件"]')).not.toBeNull()
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="关闭本机文件"]')!.click())
  await act(async () => railFiles()!.click())
  expect(document.querySelector('[aria-label="本机文件"]')).not.toBeNull()
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="关闭本机文件"]')!.click())
  await act(async () => localFiles.click())
  expect(document.querySelector('[aria-label="本机文件"]')).not.toBeNull()
  expect(document.querySelector('.desktop-catalog')).toBeNull()
})
