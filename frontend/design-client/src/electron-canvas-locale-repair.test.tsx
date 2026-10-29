// Mounted React/jsdom with real Editor/WASM; mocked rectangles are not GUI layout acceptance.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'
import { CanvasContextMenu } from './CanvasContextMenu'
import { DesignToolbar, WorkspaceRail } from './EditorChrome'
import { canvasMenuItems } from './canvas-menu-model'
import { interfacePreference } from './interface-preference'
import { readFileSync } from 'node:fs'
import { boardToolNames } from './board-tools'
import { utilityToolNames } from './utility-tools'
import { useInterfacePreferences } from './interface-preference'
import { canvasText } from './canvas-interface-messages'
import * as toolRegistry from './tool-registry'

let dom: any, root: Root, editor: Editor, authoredId: string
beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="mount"></div></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'Node', 'Event', 'KeyboardEvent', 'localStorage']) vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  interfacePreference.reset()
  const doc = blank('用户文档 English'), shape = node('rectangle', 0, 0, 100, 100)
  shape.name = '用户图层 Copy'; authoredId = shape.id
  doc.nodes[shape.id] = shape; doc.pages[0].children = [shape.id]
  editor = new Editor(doc); editor.select([shape.id])
  root = (await import('react-dom/client')).createRoot(document.getElementById('mount')!)
})
afterEach(async () => { await act(async () => root.unmount()); editor.dispose(); vi.restoreAllMocks(); dom.window.close(); vi.unstubAllGlobals() })
const switchLocale = (locale: 'en' | 'zh-CN') => act(async () => { interfacePreference.set({ locale }) })
const menu = () => document.querySelector<HTMLElement>('.canvas-context-menu')!
const commandShape = (items: ReturnType<typeof canvasMenuItems>) => items.map(({ label: _label, ...item }) => item)

for (const selected of [true, false]) {
  test(`canvas menu switches all presentation labels without changing routing/availability, selected=${selected}`, async () => {
    if (!selected) editor.select([])
    const snapshot = editor.state
    const chinese = canvasMenuItems(editor)
    await switchLocale('en')
    const english = canvasMenuItems(editor)
    expect(english.find(item => item.command === 'undo')!.label).toBe('Undo')
    expect(english.every(item => !/\p{Script=Han}/u.test(item.label))).toBe(true)
    expect(commandShape(english)).toEqual(commandShape(chinese))
    expect(editor.state).toBe(snapshot)
    await switchLocale('zh-CN')
    expect(canvasMenuItems(editor)).toEqual(chinese)
  })
}

test('open menu reclamps after longer translation without resetting focus, identity or authored layer names', async () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 })
  vi.spyOn(dom.window.HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const width = this.classList.contains('canvas-context-menu') ? (interfacePreference.getSnapshot().locale === 'en' ? 400 : 220) : 0
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: 180, width, height: 180, toJSON() {} }
  })
  const close = vi.fn(), before = editor.state
  await act(async () => root.render(<CanvasContextMenu editor={editor} x={850} y={40} worldPoint={{ x: 1, y: 2 }} candidates={[{ id: authoredId, name: '用户图层 Copy', locked: false }]} onClose={close} />))
  const originalMenu = menu(), copy = [...menu().querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === '复制')!
  copy.focus(); expect(menu().style.left).toBe('772px')
  await switchLocale('en')
  expect(menu()).toBe(originalMenu); expect(document.activeElement).toBe(copy)
  expect(copy.getAttribute('aria-label')).toBe('Copy')
  expect(menu().style.left).toBe('592px'); expect(menu().getAttribute('aria-label')).toBe('Canvas context menu')
  expect(close).not.toHaveBeenCalled(); expect(editor.state).toBe(before)
  await act(async () => menu().querySelector<HTMLButtonElement>('[data-layer-picker]')!.click())
  expect(menu().textContent).toContain('用户图层 Copy')
  expect(menu().querySelector('[aria-label="Select layer 用户图层 Copy"]')).not.toBeNull()
  await switchLocale('zh-CN')
  expect(menu().textContent).toContain('用户图层 Copy')
})

test('workspace rail switches accessible labels in place and keeps section/action routing', async () => {
  const onSection = vi.fn(), onFiles = vi.fn(), onTools = vi.fn(), onVariables = vi.fn()
  await act(async () => root.render(<WorkspaceRail section="layers" onSection={onSection} onFiles={onFiles} onTools={onTools} onVariables={onVariables} toolsOpen={false} />))
  const nav = document.querySelector('nav')!, buttons = [...nav.querySelectorAll('button')]
  buttons[2].focus()
  await switchLocale('en')
  expect(document.querySelector('nav')).toBe(nav); expect(document.activeElement).toBe(buttons[2])
  expect(nav.getAttribute('aria-label')).toBe('Workspace navigation')
  expect(buttons.map(button => button.textContent)).toEqual(['Files', 'Layers', 'Assets', 'Tools', 'Variables'])
  await act(async () => { buttons[0].click(); buttons[2].click(); buttons[3].click(); buttons[4].click() })
  expect(onFiles).toHaveBeenCalledTimes(1); expect(onSection).toHaveBeenCalledWith('assets')
  expect(onTools).toHaveBeenCalledTimes(1); expect(onVariables).toHaveBeenCalledTimes(1)
})

test('tool presentation lookup preserves registry ids, shortcuts and command mapping', () => {
  const localized = (toolRegistry as unknown as { localizedToolCommands?: (locale: 'en' | 'zh-CN') => typeof toolRegistry.TOOL_COMMANDS }).localizedToolCommands
  expect(typeof localized).toBe('function')
  const chinese = localized!('zh-CN'), english = localized!('en')
  const routing = (entries: typeof toolRegistry.TOOL_COMMANDS) => entries.map(({ label: _label, ...entry }) => entry)
  expect(routing(english)).toEqual(routing(toolRegistry.TOOL_COMMANDS))
  expect(chinese).toEqual(toolRegistry.TOOL_COMMANDS)
  expect(english.every(entry => !/\p{Script=Han}/u.test(entry.label))).toBe(true)
  for (const entry of english) expect(toolRegistry.toolForCommand(entry.id)).toBe(toolRegistry.toolForCommand(chinese.find(other => other.id === entry.id)!.id))
})


test('all current board/utility display tools, including crop, have English names without changing source names', () => {
  const names = { ...boardToolNames, ...utilityToolNames, crop: '裁切' }
  const original = { ...names }
  for (const [id, chinese] of Object.entries(names)) {
    const english = toolRegistry.localizedToolLabel(id, 'en', chinese)
    expect(english).not.toBe(id)
    expect(/\p{Script=Han}/u.test(english)).toBe(false)
    expect(toolRegistry.localizedToolLabel(id, 'zh-CN', chinese)).toBe(chinese)
  }
  expect(names).toEqual(original)
})

test('visible toolbar tooltip refreshes its language without replacing the focused button', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const matches = dom.window.HTMLElement.prototype.matches
  vi.spyOn(dom.window.HTMLElement.prototype, 'matches').mockImplementation(function (this: HTMLElement, ...args: unknown[]) {
    const selector = args[0] as string
    return matches.call(this, selector.replace(':focus-visible', ''))
  })
  function Toolbar() {
    const { locale } = useInterfacePreferences()
    return <div className="canvas-workspace"><DesignToolbar><button data-tooltip={canvasText[locale].undo}>{canvasText[locale].undo}</button></DesignToolbar></div>
  }
  await act(async () => root.render(<Toolbar />))
  const button = document.querySelector<HTMLButtonElement>('.toolbar button')!
  await act(async () => button.focus())
  expect(document.querySelector('[role="tooltip"]')!.textContent).toBe('撤销')
  await switchLocale('en')
  expect(document.querySelector('[role="tooltip"]')!.textContent).toBe('Undo')
  expect(document.activeElement).toBe(button)
})

test('App source wires locale into tool-label memoization while keeping Editor initialization stable (source contract only)', () => {
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  expect(source).toContain('const { locale } = useInterfacePreferences()')
  expect(source).toContain('const toolbarText = canvasText[locale]')
  expect(source.match(/localizedToolLabel\(tool\.id, locale, tool\.label\)/g)?.length).toBe(2)
  expect(source.match(/\[shortcutContext, locale\]/g)?.length).toBe(2)
  expect(source).toContain('localizedToolCommands(locale)')
  expect(source).toContain('const [editor] = useState(() => source?.editor || new Editor(blank()))')
  expect(source).not.toMatch(/key=\{locale\}/)
})
