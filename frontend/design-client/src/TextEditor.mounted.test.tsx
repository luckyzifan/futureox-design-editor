// Mounted React/real Editor/WASM; jsdom CSS contracts, not GUI/GPU layout evidence.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { CanvasTextEditor } from './TextEditor'
import { Editor } from './engine'
import { blank, node, type Matrix } from './model'
const bootstrapDom = await vi.hoisted(async () => {
  // @ts-expect-error jsdom is a test-only runtime dependency.
  const { JSDOM } = await import('jsdom')
  const initial = new JSDOM('<!doctype html><html><body></body></html>')
  for (const name of ['window', 'document', 'navigator']) vi.stubGlobal(name, name === 'window' ? initial.window : initial.window[name])
  return initial
})
bootstrapDom.window.close()
let dom: any, mount: HTMLDivElement, root: Root, editor: Editor, text: ReturnType<typeof node>
const close = vi.fn(), preview = vi.fn()
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'CompositionEvent']) vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const css = document.createElement('style'); css.textContent = readFileSync(new URL('./styles.css', import.meta.url), 'utf8'); document.head.append(css)
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount)
  const doc = blank(); text = node('text', 0, 0, 200, 50); text.text = 'Hello text'; doc.nodes[text.id] = text; doc.pages[0].children.push(text.id)
  editor = new Editor(doc); close.mockClear(); preview.mockClear()
})
afterEach(async () => { await act(async () => root.unmount()); editor.dispose(); dom.window.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function render(matrix: Matrix, width = 1000, height = 700) {
  await act(async () => root.render(<CanvasTextEditor node={editor.state.doc.nodes[text.id]} document={editor.state.doc} editor={editor} matrix={matrix} viewport={{ width, height }} onClose={close} onPreview={preview} />))
}
const toolbar = () => mount.querySelector<HTMLDivElement>('[role="toolbar"]')!
const input = () => mount.querySelector<HTMLTextAreaElement>('textarea')!
test('screen-space toolbar has constant CSS width at 32x and 0.025x and clamps on pan/resize', async () => {
  for (const zoom of [32, 0.025]) {
    await render([zoom, 0, 0, zoom, 100, 200])
    const bar = toolbar()
    expect(dom.window.getComputedStyle(bar).width).toBe('760px')
    expect(bar.parentElement!.style.transform).toBe(''); expect(bar.style.transform).toBe('')
    expect(mount.querySelector('svg')!.parentElement!.style.transform).toBe(`matrix(${zoom},0,0,${zoom},100,200)`)
    expect(bar.style.left).toBe('100px'); expect(bar.style.top).toBe('148px')
    await render([zoom, 0, 0, zoom, 300, 250]); expect(bar.style.left).toBe('232px'); expect(bar.style.top).toBe('198px')
    await render([zoom, 0, 0, zoom, -100000, -100000]); expect(bar.style.left).toBe('8px'); expect(bar.style.top).toBe('8px')
    await render([zoom, 0, 0, zoom, 100000, 100000], 320, 240)
    expect(bar.style.left).toBe('8px'); expect(bar.style.top).toBe('188px'); expect(bar.style.maxWidth).toBe('304px')
  }
})
test('toolbar click preserves text selection and keyboard/input focus stays in edit session', async () => {
  await render([32, 0, 0, 32, 50, 50])
  const area = input(), button = toolbar().querySelector<HTMLButtonElement>('button')!
  await act(async () => { area.setSelectionRange(1, 5); document.dispatchEvent(new Event('selectionchange', { bubbles: true })) })
  for (const kind of ['pointerdown', 'mousedown']) {
    const event = new MouseEvent(kind, { bubbles: true, cancelable: true })
    await act(async () => { button.dispatchEvent(event) }); expect(event.defaultPrevented).toBe(true)
  }
  await act(async () => button.click())
  expect(document.activeElement).toBe(area); expect([area.selectionStart, area.selectionEnd]).toEqual([1, 5]); expect(close).not.toHaveBeenCalled()
  expect(preview.mock.calls.at(-1)![0].textRuns).toEqual(expect.arrayContaining([expect.objectContaining({ start: 1, end: 5, underline: true })]))
  await act(async () => toolbar().querySelector<HTMLInputElement>('input[type=url]')!.focus()); expect(close).not.toHaveBeenCalled()
  await act(async () => area.focus()); expect(close).not.toHaveBeenCalled()
  await act(async () => area.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })))
  expect(area.selectionStart).toBe(5)
})
test('zoom preserves composition and external blur waits for composition end to commit', async () => {
  await render([0.025, 0, 0, 0.025, 100, 200]); const area = input()
  await act(async () => area.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '文' })))
  await render([32, 0, 0, 32, -200, 100]); expect(input()).toBe(area); expect(document.activeElement).toBe(area)
  await act(async () => area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true }))); expect(close).not.toHaveBeenCalled()
  const outside = document.createElement('button'); document.body.append(outside)
  await act(async () => outside.focus()); expect(close).not.toHaveBeenCalled()
  await act(async () => { area.value = 'Hello text文'; area.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '文' })) })
  expect(close).toHaveBeenCalledTimes(1); expect(editor.state.doc.nodes[text.id].text).toBe('Hello text文')
})

test('measured wrapped toolbar height reclamps via ResizeObserver and releases observer', async () => {
  let resize: () => void = () => {}; const disconnect = vi.fn()
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback } observe() {} disconnect = disconnect })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { x: 0, y: 0, left: 0, top: 0, right: 304, bottom: 96, width: 304, height: 96, toJSON() {} }
  })
  await render([1, 0, 0, 1, 500, 500], 320, 240)
  expect(toolbar().style.left).toBe('8px'); expect(toolbar().style.top).toBe('136px')
  await act(async () => resize())
  expect(toolbar().style.top).toBe('136px')
  await act(async () => root.render(null)); expect(disconnect).toHaveBeenCalledTimes(1)
})
