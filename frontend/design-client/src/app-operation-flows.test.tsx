// Mounted production App + Canvas + Inspector and real Editor/WASM. Only the
// graphics-device and persistence/host boundaries are replaced. Platform names
// exercise policy branches, not real macOS/Windows/Linux acceptance.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from './App'
import { Editor } from './engine'
import { blank, node } from './model'
import { nudgePreference } from './nudge-preference'
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
  Object.defineProperties(dom.window.HTMLElement.prototype, { clientWidth: { configurable: true, get: () => 1000 }, clientHeight: { configurable: true, get: () => 800 } })
  vi.spyOn(dom.window.HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0, toJSON() {} })
  vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  vi.spyOn(localStore, 'localOpen').mockResolvedValue(null)
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
  await act(async () => root.unmount()); editor?.dispose(); nudgePreference.reset(); shortcutPreference.set('figma-like')
  dom.window.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); expect(errors).toEqual([])
})
async function render() { await act(async () => { root.render(<App />); for (let i = 0; i < 30; i++) await Promise.resolve() }) }
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.includes(text))!
const canvas = () => document.querySelector<HTMLElement>('[data-testid="canvas"]')!
async function key(value: string, options: KeyboardEventInit = {}, type = 'keydown') { await act(async () => canvas().dispatchEvent(new KeyboardEvent(type, { key: value, code: value, bubbles: true, cancelable: true, ...options }))) }

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

test.each([false, true])('mounted file menu gates native Sketch with desktop=%s and uses Windows shortcut labels', async desktop => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' })
  const inspectSketch = vi.fn(async () => ({ status: 'cancelled' as const })), save = vi.fn(async () => ({ status: 'cancelled' as const }))
  let nativeCommand: ((name: any) => void) | undefined
  if (desktop) Object.defineProperty(window, 'coreDesktop', { configurable: true, value: {
    version: 1, renderPolicy: { cpuOnly: true }, inspectSketch, saveDocument: save,
    onCommand: (callback: (name: any) => void) => { nativeCommand = callback; return () => {} }, onCloseRequested: () => () => {}, setDirty: async () => {},
    readRecovery: async () => ({ status: 'cancelled' }), writeRecovery: async () => ({ status: 'ok' }),
  } as unknown as DesktopBridge })
  await render()
  const menu = document.querySelector<HTMLButtonElement>('[aria-label="文件菜单"]')!
  await act(async () => menu.click())
  const inspect = button('预览原生 Sketch（只读）'), edit = button('编辑原生 Sketch（有限支持）')
  expect(inspect.disabled).toBe(!desktop); expect(edit.disabled).toBe(true)
  expect(button('保存设计文件').textContent).toContain('Ctrl+S')
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
