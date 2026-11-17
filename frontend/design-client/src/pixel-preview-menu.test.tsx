// Mounted ViewControls in jsdom with the real Editor. Proves the pixel-preview
// submenu, selected marks, keyboard entry/exit, dismissal and focus return.
// This is not a macOS desktop Figma or Electron GUI acceptance.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act, useSyncExternalStore } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node, type DesignDocument, type DesignNode } from './model'
import { ViewControls } from './ViewControls'
import { interfacePreference, interfaceText } from './interface-preference'

let dom: JSDOM, root: Root, mount: HTMLDivElement, editor: Editor
let layer: DesignNode, documentRef: DesignDocument, selection: string[], version: number, view: Editor['state']['view']
beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'localStorage'])
    vi.stubGlobal(name, name === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  class PointerEvent extends MouseEvent {
    relatedTarget: EventTarget | null
    constructor(type: string, init: MouseEventInit & { relatedTarget?: EventTarget | null } = {}) {
      super(type, init)
      this.relatedTarget = init.relatedTarget ?? null
    }
  }
  vi.stubGlobal('PointerEvent', PointerEvent)
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  interfacePreference.reset()
  const doc = blank('01_Dashboard')
  layer = node('rectangle', 16, 24, 120, 72)
  layer.name = 'Card'
  doc.nodes[layer.id] = layer
  doc.pages[0].children = [layer.id]
  editor = new Editor(doc)
  editor.select([layer.id])
  documentRef = editor.state.doc
  selection = editor.state.selection
  version = editor.state.version
  view = editor.state.view
  mount = document.createElement('div')
  document.body.append(mount)
  root = (await import('react-dom/client')).createRoot(mount)
  await act(async () => { root.render(<Harness />) })
})
afterEach(async () => {
  await act(async () => root.unmount())
  editor.dispose()
  interfacePreference.reset()
  dom.window.close()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function Harness() {
  useSyncExternalStore(editor.subscribe, editor.snapshot)
  return <ViewControls editor={editor} size={{ width: 1200, height: 800 }} fit={() => {}} />
}

const menu = () => mount.querySelector<HTMLDetailsElement>('details.view-menu')!
const summary = () => menu().querySelector<HTMLElement>(':scope > summary')!
const trigger = (label: string = interfaceText['zh-CN'].pixelPreview) =>
  mount.querySelector<HTMLButtonElement>(`button[aria-haspopup="menu"][aria-label="${label}"]`)!
const submenu = (label: string = interfaceText['zh-CN'].pixelPreview) =>
  document.querySelector<HTMLElement>(`[role="menu"][aria-label="${label}"]`)
const levels = (label: string = interfaceText['zh-CN'].pixelPreview) =>
  [...document.querySelectorAll<HTMLButtonElement>(`[role="menu"][aria-label="${label}"] [role="menuitemradio"]`)]
const marks = (label: string = interfaceText['zh-CN'].pixelPreview) =>
  levels(label).map(item => item.querySelector('.view-submenu-mark')?.textContent)

async function openView() {
  await act(async () => { menu().open = true })
  // jsdom queues the details toggle task. Let that initial zoom-field focus land
  // before moving the keyboard into the submenu.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(menu().open).toBe(true)
}
async function press(key: string) {
  const target = document.activeElement
  expect(target).toBeInstanceOf(HTMLElement)
  await act(async () => {
    target!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}
function preserved() {
  expect(editor.state.selection).toBe(selection)
  expect(editor.state.selection).toEqual([layer.id])
  expect(editor.state.doc).toBe(documentRef)
  expect(editor.state.doc.nodes[layer.id]).toBe(layer)
  expect(editor.state.version).toBe(version)
  expect(editor.state.view).toBe(view)
  expect(editor.canUndo).toBe(false)
  expect(editor.state.outlines).toBeFalsy()
}

test('choosing a pixel-preview level closes the view menu, marks that level, and restores the zoom button', async () => {
  expect(mount.querySelector('select[aria-label="像素预览"]')).toBeNull()
  expect(editor.state.pixelPreview).toBe(0)
  expect(editor.state.lastPixelPreview).toBe(1)
  await openView()
  let notes = 0
  const stop = editor.subscribe(() => { notes += 1 })
  await act(async () => trigger().click())
  expect(notes).toBe(0)
  expect(menu().open).toBe(true)
  expect(levels().map(item => item.getAttribute('aria-label'))).toEqual(['关闭 · 矢量', '1×', '2×'])
  expect(levels().map(item => item.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])
  expect(marks()).toEqual(['✓', '', ''])
  await act(async () => levels()[2].click())
  expect(notes).toBe(1)
  stop()
  expect(menu().open).toBe(false)
  expect(submenu()).toBeNull()
  expect(document.activeElement).toBe(summary())
  expect(summary().getAttribute('data-testid')).toBe('zoom-readout')
  expect(editor.state.pixelPreview).toBe(2)
  expect(editor.state.lastPixelPreview).toBe(2)
  expect(mount.querySelector('.pixel-preview-badge')?.textContent).toBe('像素 2×')
  preserved()

  notes = 0
  const stopAgain = editor.subscribe(() => { notes += 1 })
  await openView()
  await act(async () => trigger().click())
  expect(marks()).toEqual(['', '', '✓'])
  expect(levels()[2].getAttribute('aria-checked')).toBe('true')
  await act(async () => levels()[2].click())
  expect(notes).toBe(0)
  expect(menu().open).toBe(false)
  expect(document.activeElement).toBe(summary())
  expect(editor.state.pixelPreview).toBe(2)
  expect(editor.state.lastPixelPreview).toBe(2)
  stopAgain()

  await openView()
  await act(async () => { trigger().click() })
  await act(async () => levels()[0].click())
  expect(editor.state.pixelPreview).toBe(0)
  expect(editor.state.lastPixelPreview).toBe(2)
  expect(mount.querySelector('.pixel-preview-badge')).toBeNull()
  expect(menu().open).toBe(false)
  preserved()

  await openView()
  await act(async () => { trigger().click() })
  await act(async () => levels()[1].click())
  expect(editor.state.pixelPreview).toBe(1)
  expect(editor.state.lastPixelPreview).toBe(1)
  expect(menu().open).toBe(false)
  expect(document.activeElement).toBe(summary())
  preserved()
})

test('keyboard can enter and leave the pixel-preview submenu, and Enter chooses then restores focus', async () => {
  const seen: string[] = []
  const listener = (event: Event) => { seen.push((event as KeyboardEvent).key) }
  window.addEventListener('keydown', listener)
  await act(async () => { menu().open = true; trigger().focus() })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(document.activeElement).toBe(trigger())
  expect(menu().open).toBe(true)
  await press('ArrowRight')
  expect(submenu()).not.toBeNull()
  expect(document.activeElement).toBe(levels()[0])
  expect(menu().open).toBe(true)
  await press('ArrowDown')
  expect(document.activeElement).toBe(levels()[1])
  expect(editor.state.pixelPreview).toBe(0)
  await press('ArrowLeft')
  expect(submenu()).toBeNull()
  expect(document.activeElement).toBe(trigger())
  expect(menu().open).toBe(true)
  expect(editor.state.pixelPreview).toBe(0)

  await press('ArrowRight')
  await press('ArrowUp')
  expect(document.activeElement).toBe(levels()[2])
  await press('Enter')
  window.removeEventListener('keydown', listener)
  expect(seen).not.toContain('ArrowRight')
  expect(seen).not.toContain('ArrowDown')
  expect(seen).not.toContain('ArrowLeft')
  expect(seen).not.toContain('ArrowUp')
  expect(seen).not.toContain('Enter')
  expect(menu().open).toBe(false)
  expect(submenu()).toBeNull()
  expect(document.activeElement).toBe(summary())
  expect(editor.state.pixelPreview).toBe(2)
  expect(editor.state.lastPixelPreview).toBe(2)
  preserved()

  await openView()
  await act(async () => trigger().focus())
  await press('ArrowRight')
  expect(levels()[2].getAttribute('aria-checked')).toBe('true')
  expect(marks()).toEqual(['', '', '✓'])
  await press('Escape')
  expect(menu().open).toBe(false)
  expect(submenu()).toBeNull()
  expect(document.activeElement).toBe(summary())
  expect(editor.state.pixelPreview).toBe(2)
  preserved()
})

test('pointer leave and an outside press dismiss without changing the preview or the outlines control', async () => {
  await openView()
  const outlines = menu().querySelector('details.view-outline-options')!
  expect(outlines.querySelector('summary')?.textContent).toBe('轮廓')
  expect(outlines.querySelectorAll('input[type="checkbox"]')).toHaveLength(3)
  expect(outlines.querySelector('[role="menu"]')).toBeNull()
  await act(async () => summary().focus())
  await act(async () => trigger().dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))
  expect(submenu()).not.toBeNull()
  expect(document.activeElement).toBe(summary())
  expect(editor.state.pixelPreview).toBe(0)
  await act(async () => trigger().dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body })))
  expect(submenu()).toBeNull()
  expect(menu().open).toBe(true)

  await act(async () => trigger().click())
  expect(submenu()).not.toBeNull()
  await act(async () => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
  expect(menu().open).toBe(false)
  expect(submenu()).toBeNull()
  expect(editor.state.pixelPreview).toBe(0)

  await openView()
  const box = outlines.querySelector('input')!
  await act(async () => box.click())
  expect(menu().open).toBe(true)
  expect(editor.state.outlines).toBe(true)
  expect(editor.state.pixelPreview).toBe(0)
  expect(editor.state.doc).toBe(documentRef)
  expect(editor.canUndo).toBe(false)
})

test('english and sketch view menus use the same submenu and still restore focus', async () => {
  await act(async () => interfacePreference.set({ locale: 'en' }))
  await openView()
  await act(async () => trigger(interfaceText.en.pixelPreview).click())
  expect(levels(interfaceText.en.pixelPreview).map(item => item.getAttribute('aria-label'))).toEqual(['Off · Vector', '1×', '2×'])
  await act(async () => levels(interfaceText.en.pixelPreview)[2].click())
  expect(menu().open).toBe(false)
  expect(document.activeElement).toBe(summary())
  expect(editor.state.pixelPreview).toBe(2)
  expect(mount.querySelector('.pixel-preview-badge')?.textContent).toBe('Pixel 2×')
  preserved()

  await act(async () => interfacePreference.set({ locale: 'zh-CN', uiMode: 'sketch' }))
  expect(mount.querySelector('details.view-outline-options')).toBeNull()
  await openView()
  await act(async () => trigger().click())
  await act(async () => levels()[0].click())
  expect(menu().open).toBe(false)
  expect(document.activeElement).toBe(summary())
  expect(editor.state.pixelPreview).toBe(0)
  expect(editor.state.lastPixelPreview).toBe(2)
  preserved()
})
