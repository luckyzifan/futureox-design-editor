// Native-menu routing through real mounted controls and Editor/WASM; native OS text execution is a double.
// @ts-expect-error jsdom runtime dependency
import { JSDOM } from 'jsdom'
import React, { act, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ColorInput } from './ColorInput'
import { Editor } from './engine'
import { blank, node } from './model'
import { PendingEditContext } from './pending-edit-context'
import { dispatchEditorCommand } from './editor-commands'
const bootstrap = await vi.hoisted(async () => {
  // @ts-expect-error jsdom runtime dependency
  const { JSDOM } = await import('jsdom')
  const d = new JSDOM('<!doctype html><html><body></body></html>')
  for (const key of ['window', 'document', 'navigator']) vi.stubGlobal(key, key === 'window' ? d.window : d.window[key])
  return d
})
bootstrap.window.close()
let dom: any, root: Root, mount: HTMLDivElement, editor: Editor, id: string
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body><button id="outside">Outside</button></body></html>', { url: 'https://design.invalid/' })
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Element', 'Event', 'MouseEvent', 'KeyboardEvent', 'CompositionEvent']) vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key])
  vi.stubGlobal('PointerEvent', dom.window.MouseEvent); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const doc = blank(), n = node('rectangle', 0, 0, 80, 60); id = n.id; n.fills[0].color = '#123456'; n.fills[0].opacity = .6; n.opacity = .75
  doc.nodes[id] = n; doc.pages[0].children = [id]; editor = new Editor(doc); editor.select([id])
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount)
})
afterEach(async () => { await act(async () => root.unmount()); editor.dispose(); dom.window.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function Fixture() {
  const s = useSyncExternalStore(editor.subscribe, editor.snapshot), n = s.doc.nodes[id]
  return <PendingEditContext.Provider value={editor}>{n && <ColorInput label="Fill" value={n.fills[0].color} onChange={() => { throw new Error('Legacy authoring callback must not run') }}
    target={{ kind: 'solid-fill', nodeId: id, fillId: n.fills[0].id, fillIndex: 0 }} />}
    <button data-property-preview-undo aria-label="Undo" onClick={() => void dispatchEditorCommand(editor, 'undo')}>Undo</button>
  </PendingEditContext.Provider>
}
const field = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === label || b.getAttribute('aria-label') === label)!
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
async function type(input: HTMLInputElement, value: string) { await act(async () => { input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) }) }
async function click(element: Element) { await act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))) }
async function open() { await act(async () => root.render(<Fixture />)); await click(button('Fill')); expect(dialog()).toBeTruthy() }

function nativeBridge() {
  const performTextCommand = vi.fn().mockResolvedValue({ status: 'ok' })
  const read = vi.fn().mockResolvedValue({ status: 'ok', text: 'Pasted canvas text' })
  Object.defineProperty(window, 'coreDesktop', { value: { version: 1, performTextCommand, clipboard: { read } }, configurable: true })
  return { performTextCommand, read }
}
const textCommands = ['copy', 'cut', 'paste', 'select-all'] as const
for (const value of ['#invalid', '#abcdef']) {
  test.each(textCommands)(`native %s preserves the focused local draft ${value}`, async command => {
    const base = editor.authoredDocument; await open(); await type(field('填充颜色值'), value)
    const { performTextCommand, read } = nativeBridge()
    await act(async () => dispatchEditorCommand(editor, command))
    expect(performTextCommand).toHaveBeenCalledWith(command === 'select-all' ? 'selectAll' : command)
    expect(read).not.toHaveBeenCalled(); expect(editor.propertyPreviewActive).toBe(true)
    expect(editor.authoredDocument).toBe(base); expect(editor.state.version).toBe(0)
    expect(dialog()).toBeTruthy(); expect(field('填充颜色值').value).toBe(value)
  })
}
test.each(textCommands)('native %s preserves read-only text ownership instead of falling back to the document', async command => {
  await open(); await type(field('填充颜色值'), '#invalid'); field('填充颜色值').readOnly = true
  const { performTextCommand, read } = nativeBridge(), base = editor.state.doc
  await act(async () => dispatchEditorCommand(editor, command))
  expect(performTextCommand).toHaveBeenCalledWith(command === 'select-all' ? 'selectAll' : command)
  expect(read).not.toHaveBeenCalled(); expect(editor.state.doc).toBe(base)
  expect(editor.propertyPreviewActive).toBe(true); expect(field('填充颜色值').value).toBe('#invalid')
})
test.each(textCommands)('native %s does not commit or end an IME composition', async command => {
  const base = editor.authoredDocument; await open(); const input = field('填充颜色值')
  await act(async () => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
  await type(input, '#abcdef'); const { performTextCommand, read } = nativeBridge()
  await act(async () => dispatchEditorCommand(editor, command))
  expect(performTextCommand).toHaveBeenCalledWith(command === 'select-all' ? 'selectAll' : command)
  expect(read).not.toHaveBeenCalled(); expect(editor.state.doc).toBe(base)
  expect(editor.propertyPreviewActive).toBe(true); expect(editor.settleOwnedPropertyPreview('save')).toBe(false)
  await act(async () => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
  expect(editor.state.doc.nodes[id].fills[0].color).toBe('#abcdef'); expect(editor.state.version).toBe(0)
})
test('canvas-owned Paste settles a valid draft once before applying the separate paste', async () => {
  await open(); await type(field('填充颜色值'), '#abcdef'); const { performTextCommand, read } = nativeBridge()
  await act(async () => { document.getElementById('outside')!.focus(); await dispatchEditorCommand(editor, 'paste') })
  expect(performTextCommand).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledTimes(1)
  expect(editor.propertyPreviewActive).toBe(false); expect(editor.state.version).toBe(2)
  expect(editor.state.doc.nodes[id].fills[0].color).toBe('#abcdef')
  expect(Object.values(editor.state.doc.nodes).some(n => n.text === 'Pasted canvas text')).toBe(true)
  await act(async () => editor.undo()); expect(editor.state.doc.nodes[id].fills[0].color).toBe('#abcdef')
  await act(async () => editor.undo()); expect(editor.state.doc.nodes[id].fills[0].color).toBe('#123456')
})
test('canvas-owned Paste vetoes an invalid draft without reading the document clipboard', async () => {
  await open(); await type(field('填充颜色值'), '#invalid'); const base = editor.state.doc, { performTextCommand, read } = nativeBridge()
  await act(async () => { document.getElementById('outside')!.focus(); await dispatchEditorCommand(editor, 'paste') })
  expect(performTextCommand).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled()
  expect(editor.state.doc).toBe(base); expect(editor.propertyPreviewActive).toBe(true); expect(editor.state.version).toBe(0)
})
test('native Undo in an unrelated dialog input is local, not a property cancellation', async () => {
  await open(); await type(field('填充颜色值'), '#abcdef'); const preview = editor.state.doc, { performTextCommand } = nativeBridge()
  const other = document.createElement('div'); other.setAttribute('role', 'dialog'); other.innerHTML = '<input aria-label="Unrelated input" />'; document.body.append(other)
  await act(async () => { other.querySelector('input')!.focus(); await dispatchEditorCommand(editor, 'undo') })
  expect(performTextCommand).toHaveBeenCalledWith('undo'); expect(editor.state.doc).toBe(preview)
  expect(editor.propertyPreviewActive).toBe(true); expect(editor.state.version).toBe(0)
})
test.each(['undo', 'set-tool-rectangle'] as const)('%s cannot settle a property draft behind an unrelated modal button', async command => {
  await open(); await type(field('填充颜色值'), '#abcdef'); const preview = editor.state.doc
  const other = document.createElement('div'); other.setAttribute('role', 'dialog'); other.innerHTML = '<button>Other action</button>'; document.body.append(other)
  await act(async () => { other.querySelector('button')!.focus(); await dispatchEditorCommand(editor, command) })
  expect(editor.state.doc).toBe(preview); expect(editor.propertyPreviewActive).toBe(true)
  expect(editor.state.version).toBe(0); expect(editor.state.tool).toBe('select')
})
