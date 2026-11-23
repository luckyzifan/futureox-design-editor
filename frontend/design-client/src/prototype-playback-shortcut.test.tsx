// Mounted App keyboard routing. navigator.platform selects the Mac or Windows
// chord. This is not Electron receiving a real macOS key.
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
import * as localStore from './local-store'
import { shortcutPreference } from './shortcut-preference'
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
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLCanvasElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'localStorage'])
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('devicePixelRatio', 1)
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, character => `\\${character}`) })
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  dom.window.HTMLElement.prototype.scrollTo = function () {}
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => 1000 },
    clientHeight: { configurable: true, get: () => 800 },
  })
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
  interfacePreference.reset()
  shortcutPreference.set('figma-like')
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  const mount = document.createElement('div')
  document.body.append(mount)
  root = (await import('react-dom/client')).createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount())
  editor?.dispose()
  interfacePreference.reset()
  shortcutPreference.set('figma-like')
  dom.window.close()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  expect(errors).toEqual([])
})

const canvas = () => document.querySelector<HTMLElement>('[data-testid="canvas"]')!
const player = () => document.querySelector<HTMLElement>('.prototype-player:not([data-history-preview])')
async function render() {
  await act(async () => { root.render(<App />); for (let i = 0; i < 30; i++) await Promise.resolve() })
  const resume = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('继续编辑'))!
  expect(resume.disabled).toBe(false)
  await act(async () => resume.click())
  expect(canvas()).not.toBeNull()
}
async function press(target: EventTarget, value: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options, code: options.code ?? value })
  await act(async () => {
    target.dispatchEvent(event)
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
  return event
}
async function closePlayer() {
  const active = document.activeElement
  expect(player()?.contains(active)).toBe(true)
  await press(active!, 'Escape', { code: 'Escape' })
  expect(player()).toBeNull()
  expect(document.activeElement).toBe(canvas())
}
function unchanged(before: unknown, version: number, selection: readonly string[]) {
  expect(editor!.authoredDocument).toBe(before)
  expect(editor!.state.version).toBe(version)
  expect(editor!.canUndo).toBe(false)
  expect(editor!.state.selection).toEqual(selection)
  expect(editor!.state.tool).toBe('select')
}

test('Figma Shift+Space opens the inline preview only from the focused canvas when the page has a frame', async () => {
  applyInterfaceLayout('figma')
  await render()
  const doc = blank('Inline preview')
  const frame = node('frame', 0, 0, 240, 160)
  const text = node('text', 280, 40, 120, 40)
  doc.nodes = { [frame.id]: frame, [text.id]: text }
  doc.pages[0].children = [frame.id, text.id]
  await act(async () => { editor!.load(doc); editor!.select([frame.id]); canvas().focus() })
  const before = editor!.authoredDocument
  const version = editor!.state.version
  const selection = [...editor!.state.selection]

  const space = await press(canvas(), ' ', { code: 'Space' })
  expect(space.defaultPrevented).toBe(true)
  expect(canvas().classList.contains('canvas-space-held')).toBe(true)
  expect(player()).toBeNull()
  await act(async () => canvas().dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true })))
  expect(canvas().classList.contains('canvas-space-held')).toBe(false)

  const preview = await press(canvas(), ' ', { code: 'Space', shiftKey: true })
  expect(preview.defaultPrevented).toBe(true)
  expect(player()).not.toBeNull()
  expect(canvas().classList.contains('canvas-space-held')).toBe(false)
  unchanged(before, version, selection)
  await press(canvas(), ' ', { code: 'Space', shiftKey: true, repeat: true })
  expect(document.querySelectorAll('.prototype-player:not([data-history-preview])')).toHaveLength(1)
  unchanged(before, version, selection)
  await closePlayer()
  unchanged(before, version, selection)

  const shapes = blank('No frame')
  const shape = node('rectangle', 40, 40, 80, 50)
  shapes.nodes = { [shape.id]: shape }
  shapes.pages[0].children = [shape.id]
  await act(async () => { editor!.load(shapes); canvas().focus() })
  const shapeDoc = editor!.authoredDocument
  await press(canvas(), ' ', { code: 'Space', shiftKey: true })
  expect(player()).toBeNull()
  expect(canvas().classList.contains('canvas-space-held')).toBe(true)
  expect(editor!.authoredDocument).toBe(shapeDoc)
  expect(editor!.canUndo).toBe(false)
  await act(async () => canvas().dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true, shiftKey: true })))

  await act(async () => { editor!.load(doc); editor!.select([text.id]); canvas().focus() })
  const textDoc = editor!.authoredDocument
  await press(canvas(), 'Enter', { code: 'Enter' })
  const field = document.querySelector<HTMLTextAreaElement>('.rich-text-editor textarea')!
  expect(field).not.toBeNull()
  await act(async () => field.focus())
  const typed = await press(field, ' ', { code: 'Space', shiftKey: true })
  expect(typed.defaultPrevented).toBe(false)
  expect(player()).toBeNull()
  expect(document.querySelector('.rich-text-editor')).not.toBeNull()
  expect(editor!.authoredDocument).toBe(textDoc)

  await act(async () => { applyInterfaceLayout('sketch'); canvas().focus() })
  await press(canvas(), ' ', { code: 'Space', shiftKey: true })
  expect(player()).toBeNull()
  expect(canvas().classList.contains('canvas-space-held')).toBe(true)
  expect(editor!.authoredDocument).toBe(textDoc)
  expect(editor!.canUndo).toBe(false)
})

test('Figma Option-Command-Return presents the existing prototype and Escape returns focus', async () => {
  applyInterfaceLayout('figma')
  await render()
  const doc = blank('Present')
  const frame = node('frame', 0, 0, 240, 160)
  const child = node('rectangle', 20, 20, 40, 30)
  const text = node('text', 280, 20, 100, 40)
  frame.children = [child.id]
  doc.nodes = { [frame.id]: frame, [child.id]: child, [text.id]: text }
  doc.pages[0].children = [frame.id, text.id]
  await act(async () => { editor!.load(doc); editor!.select([frame.id]); canvas().focus() })
  const before = editor!.authoredDocument
  const version = editor!.state.version
  const selection = [...editor!.state.selection]

  const mac = await press(canvas(), 'Enter', { code: 'Enter', metaKey: true, altKey: true })
  expect(mac.defaultPrevented).toBe(true)
  expect(player()).not.toBeNull()
  unchanged(before, version, selection)
  await closePlayer()
  unchanged(before, version, selection)

  await act(async () => { editor!.select([]); canvas().focus() })
  await press(canvas(), 'Enter', { code: 'Enter', ctrlKey: true, altKey: true })
  expect(player()).toBeNull()
  expect(editor!.authoredDocument).toBe(before)
  expect(editor!.state.selection).toEqual([])
  expect(editor!.canUndo).toBe(false)
  await act(async () => { editor!.select([frame.id]); canvas().focus() })

  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' })
  const windows = await press(canvas(), 'Enter', { code: 'Enter', ctrlKey: true, altKey: true })
  expect(windows.defaultPrevented).toBe(true)
  expect(player()).not.toBeNull()
  unchanged(before, version, selection)
  await closePlayer()
  await act(async () => { editor!.select([]); canvas().focus() })
  await press(canvas(), 'Enter', { code: 'Enter', metaKey: true, altKey: true })
  expect(player()).toBeNull()
  expect(editor!.authoredDocument).toBe(before)
  expect(editor!.canUndo).toBe(false)
  await act(async () => { editor!.select([frame.id]); canvas().focus() })

  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux x86_64' })
  const linux = await press(canvas(), 'Enter', { code: 'Enter', ctrlKey: true, altKey: true })
  expect(linux.defaultPrevented).toBe(true)
  expect(player()).not.toBeNull()
  unchanged(before, version, selection)
  await closePlayer()

  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  await act(async () => { editor!.select([text.id]); canvas().focus() })
  await press(canvas(), 'Enter', { code: 'Enter' })
  const field = document.querySelector<HTMLTextAreaElement>('.rich-text-editor textarea')!
  expect(field).not.toBeNull()
  await act(async () => field.focus())
  const textDoc = editor!.authoredDocument
  const edited = await press(field, 'Enter', { code: 'Enter', metaKey: true, altKey: true })
  expect(player()).toBeNull()
  expect(document.querySelector('.rich-text-editor')).toBeNull()
  expect(editor!.authoredDocument).toBe(textDoc)
  expect(editor!.canUndo).toBe(false)
  expect(edited.defaultPrevented).toBe(true)

  await act(async () => { applyInterfaceLayout('sketch'); canvas().focus() })
  await press(canvas(), 'Enter', { code: 'Enter', metaKey: true, altKey: true })
  expect(player()).toBeNull()
  expect(editor!.authoredDocument).toBe(textDoc)
  expect(editor!.canUndo).toBe(false)
})
