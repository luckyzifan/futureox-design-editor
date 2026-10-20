// Real React/DOM input, modal, Editor transaction and WASM admission tests.
// jsdom is not evidence of real browser layout or native clipboard access.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act, StrictMode } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'
import { BatchRenameDialog } from './BatchRenameDialog'
import { batchRenameSnapshot, closeBatchRename } from './batch-rename-session'
import { dispatchEditorCommand } from './editor-commands'
let root: Root, mount: HTMLDivElement, canvas: HTMLDivElement, dom: any, editor: Editor, a: string, b: string
beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'KeyboardEvent']) vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const { createRoot } = await import('react-dom/client')
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount)
  canvas = document.createElement('div'); canvas.tabIndex = 0; canvas.dataset.testid = 'canvas'; document.body.append(canvas); canvas.focus()
  const doc = blank('Rename DOM'), first = node('rectangle'), second = node('rectangle')
  a = first.id; b = second.id; first.name = 'Item A'; second.name = 'Item B'; doc.nodes = { [a]: first, [b]: second }; doc.pages[0].children = [a, b]
  editor = new Editor(doc); editor.select([a, b])
})
afterEach(async () => {
  await act(async () => root.unmount()); closeBatchRename(editor); editor.dispose(); vi.restoreAllMocks(); dom.window.close(); vi.unstubAllGlobals()
})
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!
const button = (value: string) => [...document.querySelectorAll<HTMLButtonElement>('.batch-rename-dialog button')].find(item => item.textContent === value)!
const input = (value: string) => [...document.querySelectorAll<HTMLLabelElement>('.batch-rename-dialog label')].find(item => item.firstChild?.textContent === value)!.querySelector<HTMLInputElement>('input')!
async function open(strict = false) {
  await act(async () => root.render(strict ? <StrictMode><BatchRenameDialog editor={editor} /></StrictMode> : <BatchRenameDialog editor={editor} />))
  await act(async () => dispatchEditorCommand(editor, 'rename'))
  expect(dialog()).not.toBeNull()
}
async function fill(label: string, value: string) {
  await act(async () => {
    const element = input(label)
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
function key(target: HTMLElement, value: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options }); target.dispatchEvent(event); return event
}
test('real inputs preview every rule and apply exactly one undoable Editor transaction', async () => {
  const before = editor.state.doc, version = editor.state.version
  await open(); await fill('前缀', 'UI/'); await fill('后缀', '!'); await fill('查找文字', 'Item'); await fill('替换为', 'Card')
  await act(async () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
  await fill('起始编号', '3'); await fill('编号步长', '2'); await fill('最少位数', '3'); await fill('编号分隔符', '-')
  expect([...dialog().querySelectorAll('tbody tr')].map(row => row.textContent)).toEqual(['Item BUI/Card B!-003', 'Item AUI/Card A!-005'])
  expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
  await act(async () => button('应用重命名').click())
  expect(dialog()).toBeNull(); expect(editor.state.doc.nodes[b].name).toBe('UI/Card B!-003'); expect(editor.state.doc.nodes[a].name).toBe('UI/Card A!-005')
  expect(editor.state.version).toBe(version + 1); expect(document.activeElement).toBe(canvas)
  editor.undo(); expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
})
test('cancel and reopen reset drafts, while Escape restores focus, inert and scroll ownership', async () => {
  const before = editor.state.doc; document.body.style.overflow = 'clip'; mount.setAttribute('inert', 'prior')
  await open(true); await fill('前缀', 'discard ')
  expect(document.body.style.overflow).toBe('hidden'); expect(canvas.hasAttribute('inert')).toBe(true)
  const close = document.querySelector<HTMLButtonElement>('[aria-label="关闭批量重命名"]')!
  await act(async () => { key(input('前缀'), 'Tab', { shiftKey: true }) }); expect(document.activeElement).toBe(input('前缀')) // prior header button remains reachable by native Tab
  close.focus(); await act(async () => { key(close, 'Tab', { shiftKey: true }) }); expect(document.activeElement).toBe(button('应用重命名'))
  await act(async () => { key(button('应用重命名'), 'Tab') }); expect(document.activeElement).toBe(close)
  canvas.focus(); expect(document.activeElement).toBe(input('前缀'))
  await act(async () => { key(input('前缀'), 'Escape') })
  expect(dialog()).toBeNull(); expect(editor.state.doc).toBe(before); expect(document.body.style.overflow).toBe('clip'); expect(mount.getAttribute('inert')).toBe('prior'); expect(canvas.hasAttribute('inert')).toBe(false); expect(document.activeElement).toBe(canvas)
  await act(async () => dispatchEditorCommand(editor, 'rename')); expect(input('前缀').value).toBe(''); expect(button('应用重命名').disabled).toBe(true)
  await act(async () => button('取消').click()); expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
})
test('selection away and back permanently invalidates the current preview and blocks submit', async () => {
  await open(); await fill('前缀', 'New '); const before = editor.state.doc
  await act(async () => { editor.select([a]); editor.select([a, b]) })
  expect(batchRenameSnapshot(editor)?.stale).toBe(true); expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('已变化'); expect(button('应用重命名').disabled).toBe(true)
  await act(async () => dialog().querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
  await act(async () => button('取消').click()); await act(async () => dispatchEditorCommand(editor, 'rename'))
  expect(batchRenameSnapshot(editor)?.stale).toBe(false); expect(input('前缀').value).toBe('')
})
test('invalid numbering and oversized results are shown and rejected before mutation', async () => {
  await open(); await fill('前缀', 'x'.repeat(200))
  expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('200'); expect(button('应用重命名').disabled).toBe(true)
  await fill('前缀', 'New '); await act(async () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()); await fill('编号步长', '0')
  expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('编号'); expect(button('应用重命名').disabled).toBe(true)
  await fill('编号步长', '1'); expect(button('应用重命名').disabled).toBe(false); expect(editor.canUndo).toBe(false)
})
test('repeated submit cannot create duplicate transactions and reopening reads renamed values', async () => {
  await open(); await fill('前缀', 'New '); const submit = button('应用重命名'), version = editor.state.version
  await act(async () => { submit.click(); submit.click() })
  expect(editor.state.version).toBe(version + 1); expect(editor.state.doc.nodes[a].name).toBe('New Item A')
  await act(async () => dispatchEditorCommand(editor, 'rename'))
  expect([...dialog().querySelectorAll('tbody td')].map(cell => cell.textContent)).toEqual(['New Item B', 'New Item B', 'New Item A', 'New Item A'])
  expect(button('应用重命名').disabled).toBe(true)
})
test('unmount dismisses pending request and leaves no inert background', async () => {
  await open(); await act(async () => root.render(null))
  expect(batchRenameSnapshot(editor)).toBeNull(); expect(document.querySelector('[aria-modal="true"]')).toBeNull(); expect(canvas.hasAttribute('inert')).toBe(false)
})
