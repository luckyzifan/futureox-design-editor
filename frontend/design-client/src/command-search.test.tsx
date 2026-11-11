// Real Editor/WASM admission and a jsdom command bar. Not a Mac, Electron, or native Sketch run.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { CommandSearch } from './CommandSearch'
import { commandSearchEntries, commandSearchText, filterCommandSearch, runCommandSearch } from './command-search'
import { closeCommandSearch, commandSearchSnapshot, requestCommandSearch } from './command-search-session'
import { canvasMenuItems } from './canvas-menu-model'
import { dispatchEditorShortcut } from './editor-shortcuts'
import { Editor } from './engine'
import { interfacePreference } from './interface-preference'
import { blank, node } from './model'
import { registerPendingEdit } from './pending-edits'
import { shortcutPreference } from './shortcut-preference'
import type { ShortcutContext } from './shortcut-profiles'

const editors: Editor[] = []
let dom: JSDOM, root: Root, mount: HTMLDivElement, canvas: HTMLElement
const sketch: ShortcutContext = { profile: 'sketch-like', platform: 'mac', desktop: true }
const figma: ShortcutContext = { profile: 'figma-like', platform: 'mac', desktop: true }

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'FocusEvent', 'MouseEvent', 'localStorage'])
    vi.stubGlobal(name, name === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(dom.window.navigator, 'platform', { configurable: true, value: 'MacIntel' })
  localStorage.clear()
  interfacePreference.set({ locale: 'zh-CN' })
  shortcutPreference.set('sketch-like')
  closeCommandSearch()
  mount = document.createElement('div')
  canvas = document.createElement('div')
  canvas.tabIndex = 0
  canvas.dataset.testid = 'canvas'
  document.body.append(mount, canvas)
  canvas.focus()
  root = (await import('react-dom/client')).createRoot(mount)
})
afterEach(async () => {
  closeCommandSearch()
  await act(async () => root.unmount())
  editors.splice(0).forEach(editor => editor.dispose())
  interfacePreference.reset()
  shortcutPreference.set('figma-like')
  dom.window.close()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function editorWith(ids: ReturnType<typeof node>[]) {
  const doc = blank('Command search')
  for (const shape of ids) doc.nodes[shape.id] = shape
  doc.pages[0].children = ids.map(shape => shape.id)
  const editor = new Editor(doc)
  editors.push(editor)
  return editor
}
function press(target: EventTarget, key: string, init: KeyboardEventInit & { keyCode?: number } = {}) {
  const event = new dom.window.KeyboardEvent('keydown', { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true, ...init })
  if (init.keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  target.dispatchEvent(event)
  return event
}
async function openSearch() {
  await act(async () => {
    root.render(<CommandSearch editor={editors.at(-1)!} />)
    requestCommandSearch(canvas)
  })
  return document.querySelector<HTMLInputElement>('[role="combobox"]')!
}
async function flush() {
  await act(async () => { for (let i = 0; i < 40; i++) await Promise.resolve() })
}
async function setQuery(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
const option = (id: string) => document.querySelector<HTMLButtonElement>(`[data-command="${id}"]`)!

test('entries reuse menu admission, names, aliases and profile shortcuts without a second operation model', () => {
  const a = node('rectangle', 10, 20, 30, 40), b = node('rectangle', 80, 90, 30, 40)
  const editor = editorWith([a, b])
  editor.select([a.id, b.id])
  for (const [context, locale] of [[sketch, 'zh-CN'], [figma, 'en']] as const) {
    interfacePreference.set({ locale })
    const entries = commandSearchEntries(editor, context, locale)
    expect(entries.length).toBeGreaterThan(40)
    expect(new Set(entries.map(entry => entry.id)).size).toBe(entries.length)
    for (const item of canvasMenuItems(editor, context)) {
      const entry = entries.find(candidate => candidate.id === item.command)
      expect(entry?.label, item.command).toBe(item.label)
      if (item.command === 'paste-here') {
        expect(entry?.disabled).toBe(true)
        expect(entry?.reason).toBe(locale === 'en' ? 'Paste here needs a point on the canvas' : '粘贴位置无效')
      } else {
        expect(entry?.disabled, item.command).toBe(!!item.disabled)
      }
      if (entry?.disabled) expect(entry.reason, item.command).toBeTruthy()
      expect(entry?.reason).not.toBe(commandSearchText[locale].unavailable)
    }
    const slice = entries.find(entry => entry.id === 'set-tool-slice')!
    expect(slice.shortcut).toBe(context.profile === 'figma-like' ? 'S' : 'E')
    expect(slice.aliases.join(' ')).toMatch(locale === 'en' ? /切片/ : /Slice/)
  }
  interfacePreference.set({ locale: 'zh-CN' })
  const entries = commandSearchEntries(editor, sketch, 'zh-CN')
  expect(filterCommandSearch(entries, 'group').map(entry => entry.id)[0]).toBe('group')
  expect(filterCommandSearch(entries, '编组').some(entry => entry.id === 'group')).toBe(true)
  expect(filterCommandSearch(entries, 'slice').some(entry => entry.id === 'set-tool-slice')).toBe(true)
  expect(filterCommandSearch(entries, '⌘G').some(entry => entry.id === 'group')).toBe(true)
  expect(filterCommandSearch(entries, 'no-such-command')).toEqual([])
  expect(JSON.stringify(editor.state.doc)).not.toContain('group')
  expect(editor.canUndo).toBe(false)
})

test('locked and empty commands show why they are disabled and do not edit', async () => {
  const shape = node('rectangle', 10, 20, 30, 40)
  shape.locked = true
  const editor = editorWith([shape])
  editor.select([shape.id])
  const before = editor.state.doc
  const input = await openSearch()
  await setQuery(input, '编组')
  const group = option('group')
  expect(group.getAttribute('aria-disabled')).toBe('true')
  expect(group.textContent).toContain('选区或父级已锁定')
  await act(async () => { press(input, 'Enter') })
  expect(editor.state.doc).toBe(before)
  expect(editor.canUndo).toBe(false)
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  await act(async () => { editor.select([]) })
  await setQuery(input, '编组')
  expect(option('group').textContent).toContain('没有选中图层')
  await act(async () => { press(input, 'Enter') })
  expect(editor.state.doc).toBe(before)
})

test('arrow keys, enter, escape, focus return and IME guards keep search out of history', async () => {
  const a = node('rectangle', 10, 20, 40, 50), b = node('rectangle', 90, 30, 40, 50)
  const editor = editorWith([a, b])
  editor.select([a.id, b.id])
  const before = editor.state.doc
  const version = editor.state.version
  const change = vi.spyOn(editor, 'change')
  const input = await openSearch()
  expect(document.activeElement).toBe(input)
  expect(input.placeholder).toBe('搜索命令…')
  await setQuery(input, 'command-search-token')
  expect(document.querySelector('[role="status"]')?.textContent).toBe('没有匹配的命令')
  expect(change).not.toHaveBeenCalled()
  expect(editor.state.doc).toBe(before)
  expect(editor.state.version).toBe(version)
  await setQuery(input, 'group')
  expect(option('group').getAttribute('aria-selected')).toBe('true')
  await act(async () => { press(input, 'ArrowDown') })
  expect(option('group').getAttribute('aria-selected')).toBe('false')
  await act(async () => { press(input, 'ArrowUp') })
  expect(option('group').getAttribute('aria-selected')).toBe('true')
  const composing = press(input, 'Enter', { isComposing: true, keyCode: 229 })
  expect(composing.defaultPrevented).toBe(false)
  expect(editor.state.doc).toBe(before)
  await act(async () => { press(input, 's') })
  expect(editor.state.tool).toBe('select')
  expect(editor.state.doc).toBe(before)
  await setQuery(input, '编组')
  expect(option('group').getAttribute('aria-disabled')).toBeNull()
  expect(option('group').getAttribute('aria-selected')).toBe('true')
  await act(async () => { press(input, 'Enter') })
  await flush()
  expect(Object.values(editor.state.doc.nodes).some(item => item.kind === 'group')).toBe(true)
  expect(editor.state.doc.nodes[editor.state.selection[0]].kind).toBe('group')
  expect(editor.canUndo).toBe(true)
  expect(JSON.stringify(editor.state.doc)).not.toContain('command-search-token')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  editor.undo()
  expect(editor.state.doc).toEqual(before)
  expect(editor.canUndo).toBe(false)
  await act(async () => { requestCommandSearch(canvas) })
  const reopened = document.querySelector<HTMLInputElement>('[role="combobox"]')!
  expect(reopened.value).toBe('')
  await act(async () => { press(reopened, 'Escape') })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.activeElement).toBe(canvas)
  expect(editor.state.doc).toEqual(before)
})

test('pending-draft admission blocks the shared command and alignment still uses the existing route', async () => {
  const a = node('rectangle', 10, 20, 40, 50), b = node('rectangle', 80, 20, 30, 50)
  const editor = editorWith([a, b])
  editor.select([a.id, b.id])
  const before = editor.state.doc
  const release = registerPendingEdit(editor, { dirty: () => true, commit: () => false })
  const input = await openSearch()
  await setQuery(input, '编组')
  await act(async () => { press(input, 'Enter') })
  await flush()
  expect(editor.state.doc).toBe(before)
  expect(editor.canUndo).toBe(false)
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  release()
  const entries = commandSearchEntries(editor, sketch, 'zh-CN')
  const align = filterCommandSearch(entries, '左对齐').find(entry => entry.id === 'align-x-start')!
  expect(align.disabled).toBe(false)
  await runCommandSearch(editor, align, sketch)
  expect(editor.state.doc.nodes[a.id].transform[4]).toBe(10)
  expect(editor.state.doc.nodes[b.id].transform[4]).toBe(10)
  expect(editor.canUndo).toBe(true)
  editor.undo()
  expect(editor.state.doc).toEqual(before)
})

test('sketch chords open search from the shortcut channel; figma S still selects slice', async () => {
  const shape = node('rectangle', 10, 20, 30, 40)
  const editor = editorWith([shape])
  const before = editor.state.doc
  const listener = (event: KeyboardEvent) => { void dispatchEditorShortcut(editor, event, sketch) }
  window.addEventListener('keydown', listener)
  await act(async () => { root.render(<CommandSearch editor={editor} />) })
  await act(async () => { press(canvas, 's') })
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(document.activeElement?.getAttribute('aria-label')).toBe('搜索命令')
  expect(editor.state.doc).toBe(before)
  expect(editor.state.tool).toBe('select')
  await act(async () => { press(document.activeElement!, 's') })
  expect(editor.state.tool).toBe('select')
  expect(editor.state.doc).toBe(before)
  window.removeEventListener('keydown', listener)
  closeCommandSearch()
  await act(async () => {})
  await dispatchEditorShortcut(editor, { key: 's', code: 'KeyS', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, defaultPrevented: false, target: canvas, preventDefault() {} }, figma)
  expect(editor.state.tool).toBe('slice')
  expect(editor.state.doc).toBe(before)
  expect(commandSearchSnapshot()).toBe(0)
})
