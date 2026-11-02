// Real DOM events, React components and Editor/WASM. No Chromium/OS/GPU claim.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'
import { KeyboardProfileSettings } from './KeyboardProfileSettings'
import { DesignToolbar } from './EditorChrome'
import { CanvasContextMenu } from './CanvasContextMenu'
import { dispatchEditorCommand } from './editor-commands'
import { dispatchEditorShortcut } from './editor-shortcuts'
import { shortcutPreference, SHORTCUT_PROFILE_KEY } from './shortcut-preference'
let root: Root, mount: HTMLDivElement, editor: Editor, canvas: HTMLDivElement, dom: any
const cleanups: (() => void)[] = []
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'Node', 'Event', 'KeyboardEvent', 'StorageEvent', 'localStorage']) vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear(); shortcutPreference.set('figma-like')
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount)
  canvas = document.createElement('div'); canvas.dataset.testid = 'canvas'; canvas.tabIndex = 0; document.body.append(canvas)
  const doc = blank('DOM shortcut test'), shape = node('rectangle', 10, 20, 30, 40)
  doc.nodes[shape.id] = shape; doc.pages[0].children = [shape.id]
  editor = new Editor(doc); editor.select([shape.id]); canvas.focus()
})
afterEach(async () => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  await act(async () => root.unmount()); editor.dispose(); document.body.replaceChildren(); dom.window.close(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})
function key(target: EventTarget, value: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: value, code: value.length === 1 ? `Key${value.toUpperCase()}` : value, bubbles: true, cancelable: true, ...options })
  target.dispatchEvent(event); return event
}
function listen() {
  const listener = (event: KeyboardEvent) => { void dispatchEditorShortcut(editor, event, { profile: shortcutPreference.getSnapshot(), platform: 'windows' }) }
  window.addEventListener('keydown', listener); cleanups.push(() => window.removeEventListener('keydown', listener))
}
test('accessible profile select persists and immediately changes real DOM keyboard dispatch', async () => {
  listen(); await act(async () => root.render(<KeyboardProfileSettings />))
  const select = mount.querySelector('select')!
  expect([...mount.querySelectorAll('label')].find(label => label.htmlFor === select.id)?.textContent).toBe('快捷键方案')
  expect(document.getElementById(select.getAttribute('aria-describedby')!)?.textContent).toContain('非完整兼容')
  await act(async () => { key(canvas, 'p') }); expect(editor.state.tool).toBe('pen')
  await act(async () => { select.value = 'sketch-like'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(localStorage.getItem(SHORTCUT_PROFILE_KEY)).toBe('sketch-like')
  await act(async () => { key(canvas, 'p') }); expect(editor.state.tool).toBe('pencil')
  await act(async () => { key(canvas, 'e') }); expect(editor.state.tool).toBe('slice')
  await act(async () => root.unmount()); root = createRoot(mount)
  await act(async () => root.render(<KeyboardProfileSettings />))
  expect(mount.querySelector('select')?.value).toBe('sketch-like')
})
test('real input, contenteditable children, IME, menus and held chords cannot mutate the graph', async () => {
  listen(); const before = editor.state.doc
  for (const tag of ['input', 'textarea', 'select', 'div']) {
    const target = document.createElement(tag)
    if (tag === 'div') target.setAttribute('contenteditable', 'true')
    document.body.append(target); target.focus()
    let child: HTMLElement = target
    if (tag === 'div') { child = document.createElement('span'); target.append(child) }
    await act(async () => { key(child, 'd', { ctrlKey: true }) }); expect(editor.state.doc).toBe(before)
    target.remove()
  }
  canvas.focus()
  await act(async () => { key(canvas, 'd', { ctrlKey: true, isComposing: true }) }); expect(editor.state.doc).toBe(before)
  const modal = document.createElement('div'); modal.setAttribute('aria-modal', 'true'); document.body.append(modal)
  await act(async () => { key(canvas, 'd', { ctrlKey: true }) }); expect(editor.state.doc).toBe(before); modal.remove()
  await act(async () => { key(canvas, 'd', { ctrlKey: true }) }); expect(Object.keys(editor.state.doc.nodes)).toHaveLength(2)
  const duplicated = editor.state.doc
  await act(async () => { key(canvas, 'd', { ctrlKey: true, repeat: true }) }); expect(editor.state.doc).toBe(duplicated)
})
function Menu() {
  const [open, setOpen] = useState(true)
  return <><button onClick={() => setOpen(true)}>Reopen</button>{open && <CanvasContextMenu editor={editor} x={10} y={10} worldPoint={{ x: 0, y: 0 }} candidates={[]} onClose={() => setOpen(false)} />}</>
}
test('actual React context menu performs one flip and Undo; composition and repeat Enter never click', async () => {
  const before = editor.state.doc
  await act(async () => root.render(<Menu />))
  const flip = document.querySelector<HTMLButtonElement>('button[aria-label="水平翻转"]')!
  expect(flip.querySelector('kbd')?.textContent).toBe('Shift+H')
  flip.focus()
  await act(async () => { key(flip, 'Enter', { isComposing: true }) }); expect(editor.state.doc).toBe(before)
  await act(async () => { key(flip, 'Enter', { repeat: true }) }); expect(editor.state.doc).toBe(before)
  await act(async () => { key(flip, 'Enter') })
  expect(editor.state.doc).not.toBe(before)
  expect(document.querySelector('[role="menu"]')).toBeNull(); expect(document.activeElement).toBe(canvas)
  await act(async () => { editor.undo() }); expect(editor.state.doc).toEqual(before)
})
test('context Escape restores focus and cross-window preference storage changes update the selector', async () => {
  await act(async () => root.render(<Menu />))
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!
  await act(async () => { key(menu, 'Escape') }); expect(document.querySelector('[role="menu"]')).toBeNull(); expect(document.activeElement).toBe(canvas)
  await act(async () => root.render(<KeyboardProfileSettings />))
  await act(async () => {
    localStorage.setItem(SHORTCUT_PROFILE_KEY, 'sketch-like')
    window.dispatchEvent(new StorageEvent('storage', { key: SHORTCUT_PROFILE_KEY, newValue: 'sketch-like' }))
  })
  expect(mount.querySelector('select')?.value).toBe('sketch-like')
})


test('native command entry cannot mutate through text controls or modal dialogs', async () => {
  const before = editor.state.doc, originalTool = editor.state.tool
  for (const kind of ['input', 'textarea', 'div']) {
    const target = document.createElement(kind)
    if (kind === 'div') { target.setAttribute('contenteditable', ''); target.tabIndex = 0 }
    document.body.append(target); target.focus()
    await act(async () => { await dispatchEditorCommand(editor, 'duplicate'); await dispatchEditorCommand(editor, 'set-tool-rectangle') })
    expect(editor.state.doc).toBe(before); expect(editor.state.tool).toBe(originalTool); target.remove()
  }
  const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); dialog.tabIndex = 0; document.body.append(dialog); dialog.focus()
  await act(async () => { await dispatchEditorCommand(editor, 'delete'); await dispatchEditorCommand(editor, 'set-tool-pen') })
  expect(editor.state.doc).toBe(before); expect(editor.state.tool).toBe(originalTool)
})


test('native text commands remain scoped to a focused field inside a dialog', async () => {
  const before = editor.state.doc, performed: string[] = []
  Object.defineProperty(window, 'coreDesktop', { configurable: true, value: { version: 1, performTextCommand: async (command: string) => { performed.push(command) } } })
  const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog')
  const field = document.createElement('input'); dialog.append(field); document.body.append(dialog); field.focus()
  await act(async () => { await dispatchEditorCommand(editor, 'copy'); await dispatchEditorCommand(editor, 'undo'); await dispatchEditorCommand(editor, 'duplicate') })
  expect(performed).toEqual(['copy', 'undo']); expect(editor.state.doc).toBe(before)
})


test('toolbar ignores repeated and composing Enter before invoking its real command', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const before = editor.state.doc
  await act(async () => root.render(<div className="canvas-workspace"><DesignToolbar><button onClick={() => { void dispatchEditorCommand(editor, 'duplicate') }}>Duplicate</button></DesignToolbar></div>))
  const duplicate = mount.querySelector('button')!; duplicate.focus()
  await act(async () => { key(duplicate, 'Enter', { isComposing: true }); key(duplicate, 'Enter', { repeat: true }) })
  expect(editor.state.doc).toBe(before)
  await act(async () => { key(duplicate, 'Enter') }); expect(Object.keys(editor.state.doc.nodes)).toHaveLength(2)
})
