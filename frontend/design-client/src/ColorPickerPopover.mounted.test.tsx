// Real React events and real Editor/WASM. No pixel/rendering claim is made here.
// @ts-expect-error jsdom runtime dependency
import { JSDOM } from 'jsdom'
import React, { act, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ColorInput } from './ColorInput'
import { Editor } from './engine'
import { blank, node } from './model'
import { defaultColorSettings } from './color'
import { PendingEditContext } from './pending-edit-context'
import { dispatchEditorCommand } from './editor-commands'
import { ownedPropertyPreviewTarget } from './property-preview'
import { modalOwnsKeyboard } from './modal-keyboard'
import { DesktopSession } from './desktop-session'
import type { DesktopBridge } from './desktop'
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
async function key(input: Element, key: string, options: object = {}) { await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }))) }
async function click(element: Element) { await act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))) }
async function open() { await act(async () => root.render(<Fixture />)); await click(button('Fill')); expect(dialog()).toBeTruthy() }
function pointer(target: Element, type: string, id = 1) { const event = new PointerEvent(type, { bubbles: true, cancelable: true }); Object.defineProperty(event, 'pointerId', { value: id }); return target.dispatchEvent(event) }
test('app-owned color/opacity previews apply once, distinguish paint/layer opacity and return focus', async () => {
  const base = editor.state.doc; await open()
  expect(document.activeElement).toBe(field('填充颜色值'))
  await type(field('填充颜色值'), '#abcdef'); await type(field('填充不透明度 %'), '25')
  expect(editor.state.version).toBe(0); expect(editor.authoredDocument).toBe(base)
  expect(editor.state.doc.nodes[id].fills[0]).toMatchObject({ color: '#abcdef', opacity: .25 }); expect(editor.state.doc.nodes[id].opacity).toBe(.75)
  await click(button('应用')); expect(dialog()).toBe(null); expect(editor.state.version).toBe(1); expect(document.activeElement).toBe(button('Fill'))
  await act(async () => editor.undo()); expect(editor.state.doc).toBe(base)
})
test('invalid intermediate value vetoes outside click and Enter, repair commits on outside click', async () => {
  const base = editor.state.doc; await open(); await type(field('填充颜色值'), '#zz')
  let accepted = true; await act(async () => { accepted = pointer(document.getElementById('outside')!, 'pointerdown') })
  expect(accepted).toBe(false); expect(dialog()).toBeTruthy(); expect(editor.state.doc).toBe(base)
  await key(field('填充颜色值'), 'Enter'); expect(editor.state.version).toBe(0)
  await type(field('填充颜色值'), '#abcdef')
  await act(async () => { accepted = pointer(document.getElementById('outside')!, 'pointerdown') })
  expect(accepted).toBe(true); expect(dialog()).toBe(null); expect(editor.state.version).toBe(1)
})
test('Escape cancels, native-menu Undo cancels before prior history, and no-op close is unchanged', async () => {
  editor.updateProperties([id], n => { n.opacity = .4 }); const base = editor.state.doc, version = editor.state.version
  await open(); await type(field('填充颜色值'), '#abcdef'); await key(field('填充颜色值'), 'Escape')
  expect(dialog()).toBe(null); expect(editor.state.doc).toBe(base); expect(editor.state.version).toBe(version)
  await click(button('Fill')); await type(field('填充不透明度 %'), '9')
  await act(async () => { pointer(button('Undo'), 'pointerdown') }); expect(dialog()).toBeTruthy()
  await click(button('Undo')); expect(dialog()).toBe(null); expect(editor.state.doc).toBe(base); expect(editor.state.version).toBe(version)
  await click(button('Fill')); await click(button('应用')); expect(editor.state.version).toBe(version)
})
test('composition Enter/Escape do not commit/cancel; Tab cycles inside the dialog', async () => {
  const base = editor.state.doc; await open(); const input = field('填充颜色值')
  await act(async () => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
  await type(input, '#abcdef'); await key(input, 'Enter'); await key(input, 'Escape')
  expect(dialog()).toBeTruthy(); expect(editor.state.doc).toBe(base)
  await act(async () => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
  expect(editor.state.doc.nodes[id].fills[0].color).toBe('#abcdef')
  const first = button('取消颜色编辑'), last = button('应用')
  await act(async () => first.focus()); await key(first, 'Tab', { shiftKey: true }); expect(document.activeElement).toBe(last)
  await key(last, 'Tab'); expect(document.activeElement).toBe(first)
  await key(first, 'Escape'); expect(editor.state.doc).toBe(base)
})
test('HDR representation switches and paint-only alpha edits retain exact raw string and intrinsic alpha', async () => {
  const raw = 'color(srgb-linear 4 -0.01 0.125 / 0.37)'
  editor.change('managed fixture', d => { d.schemaVersion = 3; d.rasterProfile = 'figma'; d.colorManagement = defaultColorSettings(); d.nodes[id].fills[0].color = raw })
  const base = editor.state.doc, version = editor.state.version; await open()
  const model = document.querySelector<HTMLSelectElement>('[aria-label="颜色显示方式"]')!
  await act(async () => { model.value = 'hex'; model.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(field('填充颜色值').value).toBe(raw); expect(editor.state.doc).toBe(base); expect(editor.state.version).toBe(version)
  await type(field('填充不透明度 %'), '18'); expect(editor.state.doc.nodes[id].fills[0].color).toBe(raw)
  await key(field('填充不透明度 %'), 'Escape'); expect(editor.state.doc).toBe(base)
})
test('pointer cancellation/lost capture restores pre-drag draft without committing or closing', async () => {
  await open(); await type(field('填充颜色值'), '#aabbcc'); const beforeDrag = editor.state.doc
  const range = field('填充不透明度滑块')
  await act(async () => { pointer(range, 'pointerdown') }); await type(range, '12')
  expect(editor.state.doc.nodes[id].fills[0].opacity).toBe(.12)
  await act(async () => { pointer(range, 'lostpointercapture') })
  expect(editor.state.doc.nodes[id].fills[0]).toEqual(beforeDrag.nodes[id].fills[0]); expect(editor.state.version).toBe(0); expect(dialog()).toBeTruthy()
  await click(button('应用')); expect(editor.state.version).toBe(1)
})
test('unmount cancels owned draft; external document replacement preserves new selection and content', async () => {
  const base = editor.state.doc; await open(); await type(field('填充颜色值'), '#abcdef')
  await act(async () => root.render(<div />)); expect(editor.state.doc).toBe(base); expect(editor.state.version).toBe(0)
  await open(); await type(field('填充颜色值'), '#000000')
  const replacement = blank('New document'), next = node('rectangle'); replacement.nodes[next.id] = next; replacement.pages[0].children = [next.id]
  await act(async () => editor.set({ doc: replacement, page: replacement.pages[0].id, selection: [next.id], version: 11 }))
  expect(dialog()).toBe(null); expect(editor.state.doc).toBe(replacement); expect(editor.state.selection).toEqual([next.id]); expect(editor.state.version).toBe(11)
})

test('save admission recognizes only the current property popover; save settles valid input and vetoes invalid', async () => {
  const bridge = { version: 1, renderPolicy: { cpuOnly: true },
    readRecovery: vi.fn().mockResolvedValue({ status: 'cancelled' }),
    clearRecovery: vi.fn().mockResolvedValue({ status: 'ok' }),
    writeRecovery: vi.fn().mockResolvedValue({ status: 'ok' }),
    saveDocument: vi.fn().mockResolvedValue({ status: 'ok', handle: 'saved', displayName: 'saved.fd' }),
    setDirty: vi.fn().mockResolvedValue(undefined),
  } as unknown as DesktopBridge
  const desktop = new DesktopSession(bridge, editor, async () => 'discard')
  try {
    await desktop.start(); await open(); await type(field('填充颜色值'), '#invalid')
    expect(modalOwnsKeyboard(document.activeElement)).toBe(true)
    expect(ownedPropertyPreviewTarget(editor, document.activeElement)).toBe(true)
    const unrelated = document.createElement('div'); unrelated.setAttribute('role', 'dialog'); document.body.append(unrelated)
    expect(ownedPropertyPreviewTarget(editor, unrelated)).toBe(false)
    await act(async () => { expect(await desktop.save()).toBe(false) })
    expect(dialog()).toBeTruthy(); expect(bridge.saveDocument).not.toHaveBeenCalled()
    await type(field('填充颜色值'), '#abcdef')
    await act(async () => { expect(await desktop.save()).toBe(true) })
    expect(editor.propertyPreviewActive).toBe(false); expect(editor.state.version).toBe(1)
    expect(ownedPropertyPreviewTarget(editor, document.activeElement)).toBe(false)
    const saved = JSON.parse(vi.mocked(bridge.saveDocument).mock.calls[0][0].documentJson)
    expect(saved.nodes[id].fills[0].color).toBe('#abcdef')
  } finally { desktop.dispose() }
})
test('native tool command settles its own focused popover but cannot bypass an invalid draft', async () => {
  await open(); await type(field('填充颜色值'), '#invalid')
  await act(async () => dispatchEditorCommand(editor, 'set-tool-rectangle'))
  expect(editor.state.tool).toBe('select'); expect(editor.propertyPreviewActive).toBe(true)
  await type(field('填充颜色值'), '#abcdef')
  await act(async () => dispatchEditorCommand(editor, 'set-tool-rectangle'))
  expect(editor.state.tool).toBe('rectangle'); expect(editor.propertyPreviewActive).toBe(false)
  expect(editor.state.version).toBe(1); expect(editor.state.doc.nodes[id].fills[0].color).toBe('#abcdef')
})
