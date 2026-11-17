// Issue #525: Sketch top bar and Option-Command-R reuse the frame-template search.
// jsdom drives the mounted toolbar, Canvas key handler, and Editor. It is not Sketch 2026.3.1.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { FrameTemplateReplaceHost } from './FrameTemplateReplaceHost'
import { SketchWindowTools } from './SketchWindowTools'
import { Inspector } from './Inspector'
import { closeFrameTemplate, frameTemplateSnapshot } from './frame-template-session'
import { applyInterfaceLayout } from './interface-layout'
import { interfacePreference } from './interface-preference'
import { blank, node } from './model'
import { PendingEditContext } from './pending-edit-context'
import { dispatchEditorShortcut } from './editor-shortcuts'
import { resolveShortcut, type ShortcutKey } from './shortcut-profiles'
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

let dom: JSDOM, root: Root, mount: HTMLDivElement, editor: Editor, errors: unknown[][]
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLCanvasElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'localStorage'])
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name as 'document'])
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('devicePixelRatio', 1)
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, character => `\\${character}`) })
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => 1440 },
    clientHeight: { configurable: true, get: () => 900 },
  })
  vi.spyOn(dom.window.HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, right: 1440, bottom: 900, width: 1440, height: 900, x: 0, y: 0, toJSON() {},
  })
  dom.window.HTMLElement.prototype.setPointerCapture = () => {}
  dom.window.HTMLElement.prototype.hasPointerCapture = () => false
  dom.window.HTMLElement.prototype.releasePointerCapture = () => {}
  vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  for (const name of ['attachEvent', 'detachEvent'] as const)
    Object.defineProperty(dom.window.HTMLElement.prototype, name, { configurable: true, value: () => {} })
  errors = []
  vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args))
  localStorage.clear()
  applyInterfaceLayout('sketch')
  editor = new Editor(blank('117'))
  editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false, grid: false })
  mount = document.createElement('div')
  document.body.append(mount)
  root = createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount())
  closeFrameTemplate()
  editor.dispose()
  interfacePreference.reset()
  shortcutPreference.set('figma-like')
  dom.window.close()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  expect(errors).toEqual([])
})

function scene() {
  const doc = blank('117')
  const frame = node('frame', 40, 50, 1922, 1080)
  frame.name = '117'
  frame.clip = true
  const child = node('rectangle', 12, 16, 30, 20)
  child.name = '内容'
  const other = node('frame', 2200, 50, 100, 80)
  other.name = '其他'
  doc.nodes = { [frame.id]: frame, [child.id]: child, [other.id]: other }
  doc.pages[0].children = [frame.id, other.id]
  frame.children = [child.id]
  return { doc, frame, child, other }
}
const host = () => mount.querySelector<HTMLElement>('[data-testid="canvas"]')!
const replaceButton = () => document.querySelector<HTMLButtonElement>('button.sketch-frame-template')
const panels = () => [...document.querySelectorAll<HTMLElement>('.frame-preset-panel')]
async function render(withInspector = false) {
  const noop = () => {}
  await act(async () => {
    root.render(<PendingEditContext.Provider value={editor}>
      <SketchWindowTools editor={editor} disabled={false} onPresets={noop} onImages={noop} onSystems={noop} onShapeBuilder={noop} onSection={noop} onEditText={noop} />
      <FrameTemplateReplaceHost editor={editor} />
      {withInspector && <Inspector editor={editor} />}
      <Canvas editor={editor} />
    </PendingEditContext.Provider>)
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
  await act(async () => host().focus())
}
async function press(target: EventTarget, key: string, options: KeyboardEventInit = {}) {
  const event = new dom.window.KeyboardEvent('keydown', {
    key, code: options.code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key),
    bubbles: true, cancelable: true, ...options,
  })
  await act(async () => { target.dispatchEvent(event) })
  return event
}
function typeSearch(value: string) {
  const search = document.querySelector<HTMLInputElement>('[aria-label="搜索画板预设"],[aria-label="Search frame presets"]')!
  const prototype = search instanceof dom.window.HTMLInputElement ? dom.window.HTMLInputElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(search, value)
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  return search
}
function listed(name: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('.frame-preset-list button')].find(button => button.querySelector('span')?.textContent === name)
}

test('Option-Command-R is the Sketch template chord and does not belong to the Figma profile', () => {
  const mac = { profile: 'sketch-like' as const, platform: 'mac' as const, desktop: true }
  const chord = (key: string, extra: Partial<ShortcutKey> = {}) => resolveShortcut({
    key, code: 'KeyR', ctrlKey: false, metaKey: true, altKey: true, shiftKey: false, repeat: false, isComposing: false, defaultPrevented: false, ...extra,
  }, mac)
  expect(chord('r')?.command).toBe('open-frame-template')
  expect(chord('®')?.command).toBe('open-frame-template')
  expect(chord('r', { shiftKey: true })).toBeNull()
  expect(chord('r', { getModifierState: value => value === 'AltGraph' })).toBeNull()
  expect(resolveShortcut({
    key: 'r', code: 'KeyR', ctrlKey: true, metaKey: false, altKey: true, shiftKey: false, repeat: false, isComposing: false, defaultPrevented: false,
  }, { profile: 'sketch-like', platform: 'linux', desktop: false })?.command).toBe('open-frame-template')
  expect(resolveShortcut({
    key: 'r', code: 'KeyR', ctrlKey: false, metaKey: true, altKey: true, shiftKey: false, repeat: false, isComposing: false, defaultPrevented: false,
  }, { profile: 'figma-like', platform: 'mac', desktop: true })).toBeNull()
})

test('the top bar and Option-Command-R open iPhone 17 search, Escape keeps the frame, and apply undoes', async () => {
  const built = scene()
  expect(editor.load(built.doc)).toBe(true)
  editor.select([built.frame.id])
  await render(true)
  const before = editor.state.doc
  expect(replaceButton()?.textContent).toBe('替换画框模板…')
  expect(replaceButton()?.getAttribute('data-tooltip')).toContain('⌘ ⌥ R')
  expect(document.querySelector('button.frame-size-preset')?.textContent).toBe('选择模板')

  await act(async () => replaceButton()!.focus())
  expect(document.activeElement).toBe(replaceButton())
  await act(async () => replaceButton()!.click())
  expect(panels()).toHaveLength(1)
  expect(panels()[0].querySelector('strong')?.textContent).toBe('选择模板')
  expect(panels()[0].querySelector('form')).toBeNull()
  const search = typeSearch('')
  expect(document.activeElement).toBe(search)
  await act(async () => { typeSearch('iPhone 17') })
  expect(listed('iPhone 17')?.textContent).toContain('402 × 874')
  expect(editor.state.doc).toBe(before)
  await press(search, 'Escape')
  expect(panels()).toHaveLength(0)
  expect(frameTemplateSnapshot()).toBe(0)
  expect(editor.state.doc).toBe(before)
  expect(editor.canUndo).toBe(false)
  expect(editor.state.doc.nodes[built.frame.id]).toMatchObject({ name: '117', width: 1922, height: 1080, clip: true })
  expect(document.activeElement).toBe(replaceButton())

  await act(async () => host().focus())
  const opened = await press(host(), 'r', { metaKey: true, altKey: true })
  expect(opened.defaultPrevented).toBe(true)
  expect(panels()).toHaveLength(1)
  expect(editor.state.doc).toBe(before)
  await act(async () => { typeSearch('iPhone 17') })
  const ids = Object.keys(editor.state.doc.nodes)
  await act(async () => listed('iPhone 17')!.click())
  expect(panels()).toHaveLength(0)
  expect(Object.keys(editor.state.doc.nodes)).toEqual(ids)
  expect(editor.state.selection).toEqual([built.frame.id])
  expect(editor.state.doc.nodes[built.frame.id]).toMatchObject({ name: '117', width: 402, height: 874, clip: true, transform: before.nodes[built.frame.id].transform })
  expect(editor.state.doc.nodes[built.child.id]).toEqual(before.nodes[built.child.id])
  expect(editor.state.doc.nodes[built.other.id]).toEqual(before.nodes[built.other.id])
  const applied = editor.state.doc
  await act(async () => editor.undo())
  expect(editor.state.doc).toEqual(before)
  expect(editor.state.doc.nodes[built.frame.id]).toMatchObject({ width: 1922, height: 1080 })
  await act(async () => editor.redo())
  expect(editor.state.doc).toEqual(applied)
  await act(async () => editor.undo())
  expect(editor.state.doc.nodes[built.frame.id]).toMatchObject({ width: 1922, height: 1080 })

  const symbol = await press(host(), '®', { code: 'KeyR', metaKey: true, altKey: true })
  expect(symbol.defaultPrevented).toBe(true)
  expect(panels()).toHaveLength(1)
  expect(editor.state.doc.nodes[built.frame.id]).toMatchObject({ width: 1922, height: 1080 })
  await press(document.querySelector('[aria-label="搜索画板预设"]')!, 'Escape')
  expect(panels()).toHaveLength(0)
  expect(editor.state.doc.nodes[built.frame.id]).toMatchObject({ width: 1922, height: 1080 })
})

test('empty selection and unsupported layers do not open the template search', async () => {
  const built = scene()
  expect(editor.load(built.doc)).toBe(true)
  await render()
  const before = editor.state.doc
  expect(replaceButton()).toBeNull()
  const empty = await press(host(), 'r', { metaKey: true, altKey: true })
  expect(empty.defaultPrevented).toBe(false)
  expect(panels()).toHaveLength(0)
  expect(editor.state.doc).toBe(before)

  const rectangle = node('rectangle', 0, 0, 20, 20)
  const graphic = node('frame', 0, 0, 64, 64)
  graphic.graphic = true
  const locked = node('frame', 0, 0, 1922, 1080)
  locked.locked = true
  locked.name = '锁定'
  const editable = node('frame', 40, 50, 1922, 1080)
  editable.name = '117'
  const fresh = blank('边界')
  fresh.schemaVersion = 23
  fresh.nodes = { [rectangle.id]: rectangle, [graphic.id]: graphic, [locked.id]: locked, [editable.id]: editable }
  fresh.pages[0].children = [rectangle.id, graphic.id, locked.id, editable.id]
  await act(async () => { expect(editor.load(fresh)).toBe(true) })
  const reloaded = editor.state.doc
  for (const id of [rectangle.id, graphic.id, locked.id]) {
    await act(async () => editor.select([id]))
    expect(replaceButton()).toBeNull()
    const event = await press(host(), 'r', { metaKey: true, altKey: true })
    expect(event.defaultPrevented).toBe(false)
    expect(panels()).toHaveLength(0)
    expect(editor.state.doc).toBe(reloaded)
  }
  await act(async () => editor.select([editable.id, locked.id]))
  expect(replaceButton()).toBeNull()
  expect((await press(host(), 'r', { metaKey: true, altKey: true })).defaultPrevented).toBe(false)
  expect(editor.canUndo).toBe(false)
  expect(editor.state.doc).toBe(reloaded)

  await act(async () => editor.select([editable.id]))
  const input = document.createElement('input')
  document.body.append(input)
  await act(async () => input.focus())
  const typed = await press(input, 'r', { metaKey: true, altKey: true })
  expect(typed.defaultPrevented).toBe(false)
  expect(panels()).toHaveLength(0)

  await act(async () => editor.set({ busy: true }))
  expect(replaceButton()).toBeNull()
  expect((await press(host(), 'r', { metaKey: true, altKey: true })).defaultPrevented).toBe(false)
  await act(async () => { editor.set({ busy: false }); applyInterfaceLayout('figma') })
  expect(replaceButton()).toBeNull()
  expect((await press(host(), 'r', { metaKey: true, altKey: true })).defaultPrevented).toBe(false)
  expect(panels()).toHaveLength(0)
  expect(editor.state.doc.nodes[editable.id]).toMatchObject({ name: '117', width: 1922, height: 1080 })
})

test('changing selection closes the search without resizing either frame', async () => {
  const built = scene()
  expect(editor.load(built.doc)).toBe(true)
  editor.select([built.frame.id])
  await render()
  const before = editor.state.doc
  const opened = await press(host(), 'r', { metaKey: true, altKey: true })
  expect(opened.defaultPrevented).toBe(true)
  expect(panels()).toHaveLength(1)
  await act(async () => editor.select([built.other.id]))
  expect(panels()).toHaveLength(0)
  expect(frameTemplateSnapshot()).toBe(0)
  expect(editor.state.doc).toBe(before)
  expect(editor.state.doc.nodes[built.frame.id]).toMatchObject({ width: 1922, height: 1080 })
  expect(editor.state.doc.nodes[built.other.id]).toMatchObject({ name: '其他', width: 100, height: 80 })
  expect(replaceButton()).not.toBeNull()
})

test('the dispatcher opens the same search and leaves an ineligible frame untouched', async () => {
  const built = scene()
  expect(editor.load(built.doc)).toBe(true)
  editor.select([built.frame.id])
  await render()
  const before = editor.state.doc
  const context = { profile: 'sketch-like' as const, platform: 'windows' as const, desktop: true }
  const event = {
    key: 'r', code: 'KeyR', ctrlKey: true, metaKey: false, altKey: true, shiftKey: false, repeat: false,
    isComposing: false, defaultPrevented: false, target: host(), preventDefault: vi.fn(),
  }
  await act(async () => { expect(await dispatchEditorShortcut(editor, event, context)).toBe(true) })
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(panels()).toHaveLength(1)
  expect(editor.state.doc).toBe(before)
  const held = { ...event, repeat: true, preventDefault: vi.fn() }
  await act(async () => { expect(await dispatchEditorShortcut(editor, held, context)).toBe(false) })
  expect(held.preventDefault).not.toHaveBeenCalled()
  expect(panels()).toHaveLength(1)
  await press(document.querySelector('[aria-label="搜索画板预设"]')!, 'Escape')
  expect(editor.state.doc).toBe(before)
  await act(async () => editor.select([]))
  const missed = { ...event, preventDefault: vi.fn() }
  await act(async () => { expect(await dispatchEditorShortcut(editor, missed, context)).toBe(false) })
  expect(missed.preventDefault).not.toHaveBeenCalled()
  expect(panels()).toHaveLength(0)
})
