// Mounted React/jsdom + real Editor/current WASM; no browser/GPU/native OS claim.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node, paint } from './model'
import { Inspector } from './Inspector'
import { Layers } from './Layers'
import { PendingEditContext } from './pending-edit-context'
import { commitPendingEdits } from './pending-edits'
// React chooses its DOM input/composition event implementation at import time.
// Initialize a real DOM before importing it, while retaining the Node test
// environment used by the shared WASM setup's file URLs.
const bootstrapDom = await vi.hoisted(async () => {
  // @ts-expect-error jsdom is a test-only runtime dependency.
  const { JSDOM } = await import('jsdom')
  const initial = new JSDOM('<!doctype html><html><body></body></html>')
  for (const name of ['window', 'document', 'navigator'])
    vi.stubGlobal(name, name === 'window' ? initial.window : initial.window[name])
  return initial
})
bootstrapDom.window.close()

let dom: any, mount: HTMLDivElement, root: Root
let consoleErrors: unknown[][]
const disposals: (() => void)[] = []
beforeEach(() => {
  consoleErrors = []
  const originalError = console.error.bind(console)
  vi.spyOn(console, 'error').mockImplementation((...args) => { consoleErrors.push(args); originalError(...args) })
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Node', 'Event', 'KeyboardEvent', 'localStorage'])
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount())
  disposals.splice(0).forEach(dispose => dispose())
  dom.window.close(); vi.unstubAllGlobals(); vi.restoreAllMocks()
  expect(consoleErrors).toEqual([])
})

function fixture() {
  const doc = blank('Sidebar workflows'), a = node('text', 10, 20, 120, 32), b = node('text', 40, 60, 140, 40)
  a.text = 'First'; b.text = 'Second'; a.opacity = .2; b.opacity = .7
  a.fontSize = 12; b.fontSize = 18
  a.fills = [paint('color(srgb 1 0 0 / 0.5)')]; b.fills = [paint('color(srgb 1 0 0 / 0.5)')]
  doc.nodes = { [a.id]: a, [b.id]: b }; doc.pages[0].children = [a.id, b.id]
  const editor = new Editor(doc); editor.select([a.id, b.id]); disposals.push(() => editor.dispose())
  return { editor, a, b }
}
async function render(editor: Editor) {
  await act(async () => root.render(<PendingEditContext.Provider value={editor}><Layers editor={editor} /><Inspector editor={editor} /></PendingEditContext.Provider>))
}
function field(label: string) { return mount.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)! }
function key(element: HTMLElement, key: string) { act(() => element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }))) }
function type(input: HTMLInputElement, value: string) {
  act(() => input.focus())
  act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
function tabs() { return [...mount.querySelectorAll<HTMLButtonElement>('[role="tab"]')] }

test('left tabs have roving focus, arrows wrap, Home/End navigate, panel linkage stays valid', async () => {
  const { editor } = fixture(); await render(editor)
  const [layers, assets] = tabs()
  expect(layers.tabIndex).toBe(0); expect(assets.tabIndex).toBe(-1)
  for (const tab of tabs()) expect(document.getElementById(tab.getAttribute('aria-controls')!)?.getAttribute('aria-labelledby')).toBe(tab.id)
  act(() => layers.focus()); key(layers, 'ArrowRight')
  expect(document.activeElement).toBe(assets); expect(assets.getAttribute('aria-selected')).toBe('true')
  expect(layers.tabIndex).toBe(-1); expect(assets.tabIndex).toBe(0)
  key(assets, 'ArrowRight'); expect(document.activeElement).toBe(layers)
  key(layers, 'End'); expect(document.activeElement).toBe(assets)
  key(assets, 'Home'); expect(document.activeElement).toBe(layers)
  key(layers, 'ArrowLeft'); expect(document.activeElement).toBe(assets)
  expect(editor.canUndo).toBe(false)
})

test('invalid mixed draft vetoes tab switch; Escape restores navigation without a document edit', async () => {
  const { editor } = fixture(); await render(editor)
  const input = field('透明度 %'); type(input, '101'); key(input, 'Enter')
  expect(input.getAttribute('aria-invalid')).toBe('true')
  act(() => tabs()[1].click())
  expect(tabs()[0].getAttribute('aria-selected')).toBe('true')
  expect(input.value).toBe('101'); expect(editor.canUndo).toBe(false)
  key(input, 'Escape'); act(() => tabs()[1].click())
  expect(tabs()[1].getAttribute('aria-selected')).toBe('true')
  expect(editor.canUndo).toBe(false)
})

test('valid mixed opacity commits once at tab boundary and undo restores both distinct values', async () => {
  const { editor, a, b } = fixture(); await render(editor)
  type(field('透明度 %'), '40'); act(() => tabs()[1].click())
  expect(tabs()[1].getAttribute('aria-selected')).toBe('true')
  expect(editor.state.doc.nodes[a.id].opacity).toBe(.4); expect(editor.state.doc.nodes[b.id].opacity).toBe(.4)
  act(() => editor.undo())
  expect(editor.state.doc.nodes[a.id].opacity).toBe(.2); expect(editor.state.doc.nodes[b.id].opacity).toBe(.7)
  expect(editor.canUndo).toBe(false)
})

test('mixed relative opacity preserves offsets, rejects non-finite input, and cancels cleanly', async () => {
  const { editor, a, b } = fixture(); await render(editor)
  type(field('透明度 %'), '+=10'); key(field('透明度 %'), 'Enter')
  expect(editor.state.doc.nodes[a.id].opacity).toBe(.3); expect(editor.state.doc.nodes[b.id].opacity).toBe(.8)
  type(field('透明度 %'), '1/0'); key(field('透明度 %'), 'Enter')
  let committed = true
  act(() => { committed = commitPendingEdits(editor) })
  expect(committed).toBe(false)
  key(field('透明度 %'), 'Escape')
  act(() => { committed = commitPendingEdits(editor) })
  expect(committed).toBe(true)
})

test('mixed font size commits to both texts as one undoable edit', async () => {
  const { editor, a, b } = fixture(); await render(editor)
  expect(field('字号').placeholder).toBe('混合')
  type(field('字号'), '24'); key(field('字号'), 'Enter')
  expect(editor.state.doc.nodes[a.id].fontSize).toBe(24); expect(editor.state.doc.nodes[b.id].fontSize).toBe(24)
  act(() => editor.undo())
  expect(editor.state.doc.nodes[a.id].fontSize).toBe(12); expect(editor.state.doc.nodes[b.id].fontSize).toBe(18)
  expect(editor.canUndo).toBe(false)
})

test('selection color alpha batch edit preserves layer opacity and is undoable', async () => {
  const { editor, a, b } = fixture(); await render(editor)
  type(field('选区颜色 1'), 'color(srgb 0 0 1 / 0.25)'); key(field('选区颜色 1'), 'Enter')
  for (const id of [a.id, b.id]) expect(editor.state.doc.nodes[id].fills[0].color).toBe('color(srgb 0 0 1 / 0.25)')
  expect(editor.state.doc.nodes[a.id].opacity).toBe(.2); expect(editor.state.doc.nodes[b.id].opacity).toBe(.7)
  act(() => editor.undo())
  for (const id of [a.id, b.id]) expect(editor.state.doc.nodes[id].fills[0].color).toBe('color(srgb 1 0 0 / 0.5)')
  expect(editor.canUndo).toBe(false)
})

test('busy editors and live gestures veto tab activation without moving focus', async () => {
  const { editor } = fixture(); await render(editor)
  act(() => { editor.set({ busy: true }); tabs()[0].focus() })
  key(tabs()[0], 'ArrowRight')
  expect(tabs()[0].getAttribute('aria-selected')).toBe('true'); expect(document.activeElement).toBe(tabs()[0])
  act(() => { editor.set({ busy: false }); editor.begin('Live gesture') })
  key(tabs()[0], 'End')
  expect(tabs()[0].getAttribute('aria-selected')).toBe('true')
  act(() => editor.cancel())
  key(tabs()[0], 'End'); expect(tabs()[1].getAttribute('aria-selected')).toBe('true')
})

test('unmount releases draft registration and native layer listeners; remount starts clean', async () => {
  const { editor } = fixture()
  const added = vi.spyOn(window, 'addEventListener'), removed = vi.spyOn(window, 'removeEventListener')
  await render(editor)
  const owned = added.mock.calls.filter(([type]) => type === 'keydown' || type === 'blur')
  expect(owned.length).toBeGreaterThan(0)
  type(field('透明度 %'), 'invalid')
  await act(async () => root.render(null))
  for (const [type, listener, options] of owned)
    expect(removed.mock.calls.some(call => call[0] === type && call[1] === listener && call[2] === options)).toBe(true)
  expect(commitPendingEdits(editor)).toBe(true)
  await render(editor)
  expect(field('透明度 %').value).toBe(''); expect(editor.canUndo).toBe(false)
})
