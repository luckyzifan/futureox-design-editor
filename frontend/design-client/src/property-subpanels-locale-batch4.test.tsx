import { FontManagementPanel } from './FontManagementPanel'
import { SystemFontPicker } from './SystemFontPicker'
import { MultiStylePanel } from './MultiStylePanel'
import { SelectionColorsPanel } from './SelectionColorsPanel'
import { ScaleInspector } from './ScaleInspector'
import { selectionScaleFrame } from './selection-scale'
import { ColorInput } from './ColorInput'
import { DraftInput } from './DraftInput'
// Third-batch regression gate: mounted locale and numeric-semantic invariants.
// Real Editor/WASM + mounted React; no native GUI/physical layout acceptance.
// @ts-expect-error jsdom runtime dependency
import { JSDOM } from 'jsdom'
import React, { act, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, defaultLayout, defaultTextStyle, node } from './model'
import { interfacePreference } from './interface-preference'
import { PendingEditContext } from './pending-edit-context'

const bootstrap = await vi.hoisted(async () => {
  // @ts-expect-error jsdom runtime dependency
  const { JSDOM } = await import('jsdom')
  const d = new JSDOM('<!doctype html><html><body></body></html>')
  for (const key of ['window', 'document', 'navigator']) vi.stubGlobal(key, key === 'window' ? d.window : d.window[key])
  return d
})
bootstrap.window.close()
let dom: any, root: Root, mount: HTMLDivElement, editor: Editor, ids: string[]
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Node', 'Element', 'Event', 'MouseEvent', 'KeyboardEvent', 'CompositionEvent', 'localStorage']) vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  ;(window as any).coreDesktop = { renderDiagnostics: true, renderDiagnosticsDetail: true }
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {})
  interfacePreference.reset()
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount)
})
afterEach(async () => { await act(async () => root.unmount()); editor?.dispose(); dom.window.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function fixture(kind: 'rectangle' | 'text' | 'frame' = 'rectangle', count = 1) {
  const doc = blank('用户文档 English'); ids = []
  for (let index = 0; index < count; index++) {
    const n = node(kind, index * 160, 0, 100 + index * 20, 100)
    n.name = `用户图层 ${index}`
    if (kind === 'text') { n.text = '作者文字 Do not translate'; n.fontSize = 14 + index; n.textStyle = { ...defaultTextStyle(), letterSpacing: 0 } }
    if (kind === 'frame') n.layout = { ...defaultLayout(), mode: 'horizontal', gap: 8 }
    doc.nodes[n.id] = n; doc.pages[0].children.push(n.id); ids.push(n.id)
  }
  editor = new Editor(doc); editor.select(ids)
}
function Panel({ kind }: { kind: 'fonts' | 'system-fonts' | 'styles' | 'colors' | 'scale' | 'color' | 'draft' }) {
  const state = useSyncExternalStore(editor.subscribe, editor.panelSnapshot), n = state.doc.nodes[ids[0]]
  return <PendingEditContext.Provider value={editor}>{kind === 'fonts' ? <FontManagementPanel editor={editor} ids={ids} includeNative={false} />
    : kind === 'system-fonts' ? <SystemFontPicker editor={editor} ids={ids} />
    : kind === 'styles' ? <MultiStylePanel editor={editor} nodes={ids.map(id => state.doc.nodes[id])} field="fills" />
    : kind === 'colors' ? <SelectionColorsPanel editor={editor} />
    : kind === 'scale' ? <ScaleInspector editor={editor} />
    : kind === 'draft' ? <DraftInput aria-label="Stable draft" value="" validate={value => value === ''} onCommit={() => { throw Error('Invalid draft must not commit') }} />
    : <ColorInput label="Authored color" value={n.fills[0].color} onChange={() => { throw Error('Legacy callback must not run') }} target={{ kind: 'solid-fill', nodeId: n.id, fillId: n.fills[0].id, fillIndex: 0 }} />}</PendingEditContext.Provider>
}
const input = (label: string) => mount.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
const locale = (value: 'en' | 'zh-CN') => act(async () => { interfacePreference.set({ locale: value }) })
async function type(field: HTMLInputElement, value: string) {
  await act(async () => { field.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
}
const key = (field: HTMLInputElement, value: string) => act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })) })


const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === name || b.getAttribute('aria-label') === name)!
async function click(element: Element) { expect(element).not.toBeNull(); await act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))) }
const portalInput = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!

test('document font search preserves query, focus and authored family across locale', async () => {
  fixture('text'); await act(async () => root.render(<Panel kind="fonts" />))
  const field = input('搜索文档字体'), before = editor.state.doc
  await type(field, 'Noto'); await locale('en')
  expect(input('Search document fonts')).toBe(field); expect(document.activeElement).toBe(field); expect(field.value).toBe('Noto')
  const target = mount.querySelector<HTMLSelectElement>('select[aria-label="Target font"]')!
  expect(target).not.toBeNull(); expect(target.value).toBe('default'); expect(target.options[0].textContent).toContain('Noto Sans SC')
  expect(editor.state.doc).toBe(before)
})

test('local font metadata search relabels without another native request or translating family', async () => {
  fixture('text')
  const list = vi.fn(async () => ({ status: 'ok', fonts: [{ id: 'source-face', family: '作者字体 Author Sans', style: 'Regular', postscript: 'AuthorSans-Regular', index: 0 }] })), read = vi.fn()
  ;(window as any).coreDesktop = { version: 1, fonts: { list, read } }
  await act(async () => root.render(<Panel kind="system-fonts" />)); await click(button('选择本机字体'))
  const field = input('搜索本机字体'), before = editor.state.doc
  expect(field).not.toBeNull(); await type(field, '作者字体'); await locale('en')
  expect(input('Search local fonts')).toBe(field); expect(document.activeElement).toBe(field); expect(field.value).toBe('作者字体')
  expect(mount.textContent).toContain('作者字体 Author Sans'); expect(list).toHaveBeenCalledTimes(1); expect(read).not.toHaveBeenCalled(); expect(editor.state.doc).toBe(before)
})

test('mixed style opacity draft retains units, original history and one undo in English', async () => {
  fixture('rectangle', 2); editor.updateProperties([ids[1]], n => { n.fills[0].opacity = .5 })
  await act(async () => root.render(<Panel kind="styles" />))
  const field = input('填充 1不透明度 %'), before = editor.state.doc
  expect(field).not.toBeNull(); await type(field, '25%'); await locale('en')
  expect(input('Fill 1 opacity %')).toBe(field); expect(document.activeElement).toBe(field); expect(field.value).toBe('25%'); expect(editor.state.doc).toBe(before)
  await key(field, 'Enter'); for (const id of ids) expect(editor.state.doc.nodes[id].fills[0].opacity).toBe(.25)
  expect(editor.state.message).toBe('批量修改填充 1')
  await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before)
})

test('selection color labels change without rewriting authored color', async () => {
  fixture(); await act(async () => root.render(<Panel kind="colors" />)); const before = editor.state.doc
  const field = input('选区颜色 1'); expect(field).not.toBeNull(); field.focus(); await locale('en')
  expect(input('Selection color 1')).toBe(field); expect(document.activeElement).toBe(field)
  expect(field.value).toBe(before.nodes[ids[0]].fills[0].color.toLowerCase()); expect(editor.state.doc).toBe(before)
})

test('scale ratio draft and anchor identity survive locale, then scale once and undo', async () => {
  fixture(); editor.set({ tool: 'scale' }); await act(async () => root.render(<Panel kind="scale" />))
  const field = input('缩放倍率'), anchor = mount.querySelector('button[aria-label="中心"]'), before = editor.state.doc
  await type(field, '1.5x'); await locale('en')
  expect(input('Scale factor')).toBe(field); expect(document.activeElement).toBe(field); expect(field.value).toBe('1.5x')
  expect(mount.querySelector('button[aria-label="Center"]')).toBe(anchor); expect(editor.state.doc).toBe(before)
  await key(field, 'Enter'); expect(selectionScaleFrame(editor.state.doc, editor.state.page, ids).width).toBe(150)
  await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before)
})

test('invalid color preview survives locale with same session, input and focus then cancels', async () => {
  fixture(); const before = editor.state.doc
  await act(async () => root.render(<Panel kind="color" />)); await click(button('Authored color'))
  const dialog = document.querySelector('[role="dialog"]'), field = portalInput('填充颜色值')
  await type(field, '#zz'); await locale('en')
  expect(document.querySelector('[role="dialog"][aria-label="Fill color and opacity"]')).toBe(dialog)
  expect(portalInput('Fill color value')).toBe(field); expect(field.value).toBe('#zz'); expect(document.activeElement).toBe(field)
  expect(dialog!.querySelector('[role="alert"]')!.textContent).toBe('Enter a valid color and fill opacity from 0 to 100')
  expect(editor.authoredDocument).toBe(before)
  await key(field, 'Escape'); expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
})

test('invalid generic draft keeps validation state and focus while message changes language', async () => {
  fixture(); await act(async () => root.render(<Panel kind="draft" />))
  const field = input('Stable draft'), before = editor.state.doc
  await type(field, 'invalid'); await key(field, 'Enter')
  expect(field.validationMessage).toBe('输入无效或属性已变化；输入已保留，请修正或按 Esc 取消')
  await locale('en')
  expect(input('Stable draft')).toBe(field); expect(document.activeElement).toBe(field); expect(field.value).toBe('invalid')
  expect(field.validationMessage).toBe('The input is invalid or the property changed. Your draft is retained; correct it or press Esc to cancel.')
  expect(editor.state.doc).toBe(before); await key(field, 'Escape'); expect(field.value).toBe('')
})
