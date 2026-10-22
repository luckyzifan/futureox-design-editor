import { defaultColorSettings } from './color'
import { acceptCanvasColor, hasCanvasColorPicker } from './canvas-color-picker'
import { SystemFontPicker } from './SystemFontPicker'
import { ColorInput } from './ColorInput'
// Locale/async-combination gate against the frozen property-localization baseline.
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
function Panel({ kind }: { kind: 'system-fonts' | 'color' }) {
  const state = useSyncExternalStore(editor.subscribe, editor.panelSnapshot), n = state.doc.nodes[ids[0]]
  return <PendingEditContext.Provider value={editor}>{kind === 'system-fonts' ? <SystemFontPicker editor={editor} ids={ids} />
    : n && <ColorInput label="Authored color" value={n.fills[0].color} onChange={() => { throw Error('Legacy callback must not run') }} target={{ kind: 'solid-fill', nodeId: n.id, fillId: n.fills[0].id, fillIndex: 0 }} />}</PendingEditContext.Provider>
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


function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const fontResult = { status: 'ok', fonts: [{ id: 'late-face', family: '作者字体 Late Sans', style: 'Regular', postscript: 'LateSans-Regular', index: 0 }] }
for (const outcome of ['complete', 'cancel', 'replace-document'] as const) {
  test(`pending local font list crosses locale then ${outcome} without stale mutation`, async () => {
    fixture('text'); const pending = deferred<typeof fontResult>(), list = vi.fn(() => pending.promise), read = vi.fn()
    ;(window as any).coreDesktop = { version: 1, fonts: { list, read } }
    await act(async () => root.render(<Panel kind="system-fonts" />)); await click(button('选择本机字体'))
    const field = input('搜索本机字体'), before = editor.state.doc
    expect(field).not.toBeNull(); field.focus(); await locale('en')
    expect(input('Search local fonts')).toBe(field); expect(document.activeElement).toBe(field)
    expect(list).toHaveBeenCalledTimes(1); expect(read).not.toHaveBeenCalled()
    let expected = before
    if (outcome === 'cancel') await click(button('Close'))
    if (outcome === 'replace-document') {
      const next = blank('Replacement 作者文档'), n = node('text'); n.text = 'New author text'; n.textStyle = defaultTextStyle()
      next.nodes[n.id] = n; next.pages[0].children = [n.id]
      await act(async () => editor.set({ doc: next, page: next.pages[0].id, selection: [n.id], version: 9 }))
      expected = next
    }
    await act(async () => { pending.resolve(fontResult); await pending.promise })
    expect(editor.state.doc).toBe(expected); expect(read).not.toHaveBeenCalled(); expect(list).toHaveBeenCalledTimes(1)
    if (outcome === 'complete') {
      expect(mount.textContent).toContain('作者字体 Late Sans'); expect(mount.textContent).toContain('1 fonts')
      expect(input('Search local fonts')).toBe(field)
    } else {
      expect(mount.textContent).not.toContain('作者字体 Late Sans')
      if (outcome === 'cancel') expect(mount.querySelector('.system-font-picker')).toBeNull()
      if (outcome === 'replace-document') expect(editor.state.version).toBe(9)
    }
  })
}
async function openColor() { await act(async () => root.render(<Panel kind="color" />)); await click(button('Authored color')); expect(document.querySelector('[role="dialog"]')).not.toBeNull() }

test('color IME composition crosses locale without interpreting Enter or Escape', async () => {
  fixture(); const before = editor.state.doc; await openColor()
  const field = portalInput('填充颜色值'), panel = document.querySelector('[role="dialog"]')
  await act(async () => field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
  await type(field, '#abcdef'); await locale('en')
  expect(portalInput('Fill color value')).toBe(field); expect(document.activeElement).toBe(field); expect(field.value).toBe('#abcdef')
  await key(field, 'Enter'); await key(field, 'Escape')
  expect(document.querySelector('[role="dialog"]')).toBe(panel); expect(editor.authoredDocument).toBe(before); expect(editor.state.version).toBe(0)
  await act(async () => field.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
  await key(field, 'Enter'); expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(editor.state.doc.nodes[ids[0]].fills[0].color).toBe('#abcdef'); expect(editor.state.version).toBe(1)
  await act(async () => editor.undo()); expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
})

test('HDR bytes and unsupported opacity-expression draft survive locale without parser expansion', async () => {
  fixture(); const raw = 'color(srgb-linear 4 -0.01 0.125 / 0.37)'
  editor.change('HDR fixture', d => { d.schemaVersion = 3; d.rasterProfile = 'figma'; d.colorManagement = defaultColorSettings(); d.nodes[ids[0]].fills[0].color = raw })
  const before = editor.state.doc, version = editor.state.version; await openColor()
  const opacity = portalInput('填充不透明度 %'), color = portalInput('填充颜色值')
  await type(opacity, '50/2'); await locale('en')
  expect(portalInput('Fill opacity %')).toBe(opacity); expect(document.activeElement).toBe(opacity); expect(opacity.value).toBe('50/2')
  expect(color.value).toBe(raw); await key(opacity, 'Enter')
  expect(document.querySelector('[role="dialog"]')).not.toBeNull(); expect(editor.authoredDocument).toBe(before); expect(editor.state.version).toBe(version)
  await type(opacity, '25'); await key(opacity, 'Enter')
  expect(editor.state.doc.nodes[ids[0]].fills[0]).toMatchObject({ color: raw, opacity: .25 })
  expect(editor.state.version).toBe(version + 1); await act(async () => editor.undo()); expect(editor.state.doc).toBe(before)
})

test('active opacity slider drag crosses locale and pointer cancellation restores the owned draft', async () => {
  fixture(); const before = editor.state.doc; await openColor()
  const range = portalInput('填充不透明度滑块')
  range.setPointerCapture = () => {}; range.hasPointerCapture = () => false; range.releasePointerCapture = () => {}
  const pointer = async (type: string) => act(async () => { const event = new MouseEvent(type, { bubbles: true, cancelable: true }); Object.defineProperty(event, 'pointerId', { value: 7 }); range.dispatchEvent(event) })
  await pointer('pointerdown'); await type(range, '12'); await locale('en')
  expect(portalInput('Fill opacity slider')).toBe(range); expect(document.activeElement).toBe(range); expect(range.value).toBe('12')
  expect(editor.authoredDocument).toBe(before); expect(editor.state.version).toBe(0)
  await pointer('pointercancel'); expect(editor.state.doc.nodes[ids[0]].fills[0].opacity).toBe(before.nodes[ids[0]].fills[0].opacity)
  await click(button('Cancel')); expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
})

for (const outcome of ['accept', 'cancel'] as const) {
  test(`pending canvas sampling crosses locale then ${outcome} without stale session writes`, async () => {
    fixture(); const before = editor.state.doc; await openColor()
    const panel = document.querySelector('[role="dialog"]'); await click(button('从画布取色'))
    expect(hasCanvasColorPicker(editor)).toBe(true); await locale('en')
    expect(document.querySelector('[role="dialog"]')).toBe(panel); expect(editor.authoredDocument).toBe(before)
    if (outcome === 'cancel') {
      await click(button('Cancel')); expect(hasCanvasColorPicker(editor)).toBe(false)
      await act(async () => acceptCanvasColor(editor, '#abcdef'))
      expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false); expect(document.querySelector('[role="dialog"]')).toBeNull()
    } else {
      await act(async () => acceptCanvasColor(editor, '#abcdef'))
      expect(hasCanvasColorPicker(editor)).toBe(false); expect(portalInput('Fill color value').value).toBe('#abcdef')
      expect(editor.authoredDocument).toBe(before); await click(button('Apply'))
      expect(editor.state.doc.nodes[ids[0]].fills[0].color).toBe('#abcdef'); expect(editor.state.version).toBe(1)
      await act(async () => editor.undo()); expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
    }
  })
}
