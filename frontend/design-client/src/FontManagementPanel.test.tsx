// Actual React DOM + Editor/WASM and font bytes. IPC is a host boundary double;
// these CPU tests make no native-dialog, browser-rendering or GPU claim.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { appendFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, defaultTextStyle, node } from './model'
import { FontManagementPanel } from './FontManagementPanel'
import { DraftInput } from './DraftInput'
import { hasPendingEdits } from './pending-edits'
import { encodeDocumentBinary } from './kernel/binfmt'
import * as fonts from './font-management'
import { font_faces_json } from './generated/design-kernel/design_kernel'
import type { DesktopFontData } from './desktop'
import { fontTestBytes } from './font-test-fixtures'

const bootstrap = await vi.hoisted(async () => {
  // @ts-expect-error jsdom is a test-only runtime dependency.
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  for (const name of ['window', 'document', 'navigator']) vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  return dom
})
bootstrap.window.close()
const fontBytes = new Uint8Array(fontTestBytes('noto-latin'))
const latin = { family: 'Noto Sans SC Regular', data: Buffer.from(fontBytes).toString('base64'), index: 0 }
let dom: any, root: Root, mount: HTMLDivElement, errors: unknown[][]
const editors: Editor[] = []
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://font-test.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLSelectElement', 'Node', 'Event', 'KeyboardEvent', 'CompositionEvent', 'localStorage']) vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  errors = []; const original = console.error.bind(console)
  vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args); original(...args) })
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount()); editors.splice(0).forEach(e => e.dispose())
  dom.window.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); expect(errors).toEqual([])
})
function fixture(count = 2) {
  const doc = blank('Font panel'), ids: string[] = []; doc.fonts = { latin }
  for (let i = 0; i < count; i++) {
    const n = node('text', i * 3, 0, 200, 30); n.text = 'ABC'; n.textStyle = { ...defaultTextStyle(), fontId: 'default' }
    n.textRuns = [{ start: 0, end: 1, fontId: 'default', weight: 600 }]
    doc.nodes[n.id] = n; doc.pages[0].children.push(n.id); ids.push(n.id)
  }
  const editor = new Editor(doc); editor.select(ids); editors.push(editor); return { editor, ids }
}
function field<T extends HTMLElement = HTMLInputElement>(name: string) {
  const element = [...mount.querySelectorAll<HTMLElement>('[aria-label]')].find(e => e.getAttribute('aria-label') === name)
  expect(element, `Missing ${name}`).toBeTruthy(); return element as T
}
function button(name: string) { const b = [...mount.querySelectorAll<HTMLButtonElement>('button')].find(e => e.textContent?.trim() === name); expect(b, `Missing button ${name}`).toBeTruthy(); return b! }
function click(element: HTMLElement) { act(() => element.click()) }
function type(input: HTMLInputElement, value: string) { act(() => { input.focus(); Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })) }) }
function choose(name: string, value: string) { const select = field<HTMLSelectElement>(name); act(() => { select.value = value; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })) }) }
async function settle(check: () => boolean) { for (let i = 0; i < 100 && !check(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }); expect(check()).toBe(true) }
async function render(editor: Editor, extra?: React.ReactNode) { await act(async () => root.render(<>{extra}<FontManagementPanel editor={editor} /></>)) }
function nativeCatalog(read?: () => Promise<any>) {
  const face = JSON.parse(font_faces_json(fontBytes))[0]
  const catalog = Array.from({ length: 121 }, (_, i) => ({ id: `native-${i}`, family: 'Noto Sans SC', style: `Test style ${String(i).padStart(3, '0')}`, postscript: `Test-${i}`, index: 0 }))
  const data: DesktopFontData = { font: { id: 'returned-face', family: face.family, style: face.style, postscript: face.postscript, index: 0 }, data: latin.data, index: 0, sourceIndex: 4, extracted: true }
  const list = vi.fn(async () => ({ status: 'ok', fonts: catalog, truncated: false, skippedCollections: 0 }))
  const reader = vi.fn(read || (async () => ({ status: 'ok', ...data })))
  Object.defineProperty(window, 'coreDesktop', { configurable: true, value: { version: 1, fonts: { list, read: reader } } })
  return { list, read: reader, data }
}

test('real DOM apply and replacement differ correctly, undo restores bytes, and camera changes do no font indexing', async () => {
  const { editor, ids } = fixture(), index = vi.spyOn(fonts, 'documentFontChoices'), search = vi.spyOn(fonts, 'searchFontChoices')
  await render(editor); const before = editor.state.doc, beforeBytes = encodeDocumentBinary(before)
  choose('目标字体', 'latin'); click(button('替换匹配的字体'))
  expect(editor.state.doc.nodes[ids[0]].textRuns?.[0]).toEqual({ start: 0, end: 1, fontId: 'latin', weight: 600 })
  expect(editor.state.doc.nodes[ids[1]].textStyle?.fontId).toBe('latin')
  act(() => editor.undo()); expect(encodeDocumentBinary(editor.state.doc)).toEqual(beforeBytes)
  click(button('应用所选文字（2）'))
  expect(editor.state.doc.nodes[ids[0]].textRuns?.[0]).toEqual({ start: 0, end: 1, weight: 600 })
  const html = mount.innerHTML; index.mockClear(); search.mockClear()
  for (let i = 1; i <= 120; i++) act(() => editor.set({ view: { x: i, y: i, zoom: 1 + i / 1000 } }))
  expect(index).not.toHaveBeenCalled(); expect(search).not.toHaveBeenCalled(); expect(mount.innerHTML).toBe(html)
})

test('invalid drafts and active IME remain recoverable and block all font mutations', async () => {
  const { editor, ids } = fixture(1)
  await render(editor, <DraftInput editor={editor} aria-label="Pending name" value={editor.state.doc.nodes[ids[0]].name} validate={value => value !== 'invalid'} onCommit={value => editor.updateProperties(ids, { name: value })} />)
  const before = editor.state.doc
  type(field('Pending name'), 'invalid'); choose('目标字体', 'latin'); click(button('应用所选文字（1）'))
  expect(editor.state.doc).toBe(before); expect(field('Pending name').value).toBe('invalid'); expect(hasPendingEdits(editor)).toBe(true)
  type(field('Pending name'), 'Composing')
  act(() => field('Pending name').dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true })))
  click(button('替换匹配的字体')); expect(editor.state.doc).toBe(before)
  act(() => field('Pending name').dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true })))
  click(button('应用所选文字（1）'))
  expect(editor.state.doc.nodes[ids[0]].name).toBe('Composing'); expect(editor.state.doc.nodes[ids[0]].textStyle?.fontId).toBe('latin')
})

test('native catalog pages beyond the old 100-face cutoff, searches styles and reads bytes only when chosen', async () => {
  const { editor, ids } = fixture(1), host = nativeCatalog(); await render(editor)
  expect(host.list).not.toHaveBeenCalled(); expect(host.read).not.toHaveBeenCalled()
  click(button('选择本机字体')); await settle(() => host.list.mock.calls.length === 1 && !!mount.querySelector('[aria-label="搜索本机字体"]') && !button('下一页字体').disabled)
  const rows = () => mount.querySelectorAll('.system-font-picker button[style]').length
  expect(rows()).toBe(40); expect(host.read).not.toHaveBeenCalled()
  click(button('下一页字体')); click(button('下一页字体')); click(button('下一页字体')); expect(rows()).toBe(1)
  type(field('搜索本机字体'), 'SC 120'); expect(rows()).toBe(1)
  const before = editor.state.doc, version = editor.state.version
  click(mount.querySelector<HTMLButtonElement>('.system-font-picker button[style]')!)
  await settle(() => editor.state.version === version + 1)
  expect(host.read).toHaveBeenCalledTimes(1); expect(host.read).toHaveBeenCalledWith({ id: 'native-120' })
  const id = editor.state.doc.nodes[ids[0]].textStyle!.fontId
  expect(id).not.toBe('default'); expect(editor.state.doc.fonts?.[id].data).toBe(latin.data); expect(editor.state.doc.fonts?.[id].index).toBe(0)
  act(() => editor.undo()); expect(editor.state.doc).toEqual(before)
})

test('a same-ID reopen cancels stale native reads and leaves the picker usable', async () => {
  const { editor } = fixture(1); let resolve!: (value: any) => void
  const host = nativeCatalog(() => new Promise(r => { resolve = r })); await render(editor)
  click(button('选择本机字体')); await settle(() => !!mount.querySelector('.system-font-picker button[style]'))
  click(mount.querySelector<HTMLButtonElement>('.system-font-picker button[style]')!); expect(host.read).toHaveBeenCalledTimes(1)
  const before = editor.state.doc; act(() => editor.load(structuredClone(before)))
  const reopened = editor.state.doc, version = editor.state.version
  await act(async () => { resolve({ status: 'ok', ...host.data }); await new Promise(r => setTimeout(r, 10)) })
  expect(editor.state.doc).toBe(reopened); expect(editor.state.version).toBe(version)
  expect(button('选择本机字体').disabled).toBe(false)
  expect(Object.keys(editor.state.doc.fonts!)).toEqual(['latin'])
})

test('1000 selected text layers produce bounded DOM and one font command', async () => {
  const { editor, ids } = fixture(1000), change = vi.spyOn(editor, 'change'), before = editor.state.doc
  const started = performance.now(); await render(editor); const mountMs = performance.now() - started
  const elements = mount.querySelectorAll('*').length; expect(elements).toBeLessThan(70)
  choose('目标字体', 'latin'); const editStarted = performance.now(); click(button('应用所选文字（1000）')); const editMs = performance.now() - editStarted
  expect(change).toHaveBeenCalledTimes(1); expect(editor.state.doc.nodes[ids[999]].textStyle?.fontId).toBe('latin')
  act(() => editor.undo()); expect(editor.state.doc).toEqual(before)
  const row = { runtime: 'React/jsdom and real Editor/WASM; CPU only', name: '1000-text-font-DOM', mountMs, editMs, elements, editorChanges: change.mock.calls.length }
  console.info('FONT_BATCH_DOM', JSON.stringify(row)); if (process.env.FONT_BATCH_METRICS) appendFileSync(process.env.FONT_BATCH_METRICS, JSON.stringify(row) + '\n')
}, 120000)

test('the real font file input admits actual bytes in one change and undo removes the added resource', async () => {
  const { TextStylePanel } = await import('./TextStylePanel')
  const { editor, ids } = fixture(1), before = editor.state.doc, version = editor.state.version
  await act(async () => root.render(<TextStylePanel editor={editor} ids={ids} node={editor.state.doc.nodes[ids[0]]} />))
  const input = mount.querySelector<HTMLInputElement>('input[type="file"]')!
  expect(input).not.toBeNull()
  const selected = new dom.window.File([fontBytes], 'noto-latin.ttf', { type: 'font/ttf' })
  Object.defineProperty(selected, 'arrayBuffer', { value: async () => fontBytes.slice().buffer })
  Object.defineProperty(input, 'files', { configurable: true, value: [selected] })
  act(() => input.dispatchEvent(new dom.window.Event('change', { bubbles: true })))
  await settle(() => editor.state.version === version + 1)
  const id = editor.state.doc.nodes[ids[0]].textStyle!.fontId
  expect(editor.state.doc.fonts?.[id].data).toBe(latin.data)
  expect(editor.state.doc.fonts?.[id].family).toContain('Noto Sans SC')
  expect(editor.state.doc.nodes[ids[0]].textRuns?.[0].fontId).toBeUndefined()
  act(() => editor.undo()); expect(editor.state.doc).toEqual(before)
})

test('native malformed font bytes are rejected atomically with a visible error', async () => {
  const { editor } = fixture(1), host = nativeCatalog(); host.read.mockImplementation(async () => ({ status: 'ok', ...host.data, data: btoa('invalid font bytes') }))
  await render(editor); click(button('选择本机字体')); await settle(() => !!mount.querySelector('.system-font-picker button[style]'))
  const before = editor.state.doc, version = editor.state.version
  click(mount.querySelector<HTMLButtonElement>('.system-font-picker button[style]')!)
  await settle(() => !button('选择本机字体').disabled)
  expect(editor.state.doc).toBe(before); expect(editor.state.version).toBe(version)
  expect(mount.querySelector('.system-font-picker [role="status"]')?.textContent).toMatch(/font|字体|parse|invalid/i)
})


test('existing advanced font drafts participate in the pending barrier and preserve invalid fallback input', async () => {
  const { TextStylePanel } = await import('./TextStylePanel')
  const { editor, ids } = fixture(1)
  function LivePanel() { const { doc } = useSyncExternalStore(editor.subscribe, editor.panelSnapshot); return <TextStylePanel editor={editor} ids={ids} node={doc.nodes[ids[0]]} /> }
  await act(async () => root.render(<LivePanel />))
  type(field('后备字体'), 'missing-font')
  const before = editor.state.doc; expect(hasPendingEdits(editor)).toBe(true)
  choose('文字字体', 'latin')
  expect(editor.state.doc).toBe(before); expect(field('后备字体').value).toBe('missing-font')
  type(field('后备字体'), 'default')
  type(field('OpenType 特性'), '-liga,kern')
  act(() => field('OpenType 特性').dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true })))
  choose('文字字体', 'latin'); expect(editor.state.doc.nodes[ids[0]].textStyle?.fontId).toBe('default')
  act(() => field('OpenType 特性').dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true })))
  choose('文字字体', 'latin')
  expect(editor.state.doc.nodes[ids[0]].textStyle?.fontId).toBe('latin')
  expect(editor.state.doc.nodes[ids[0]].textStyle?.features).toEqual(['-liga', 'kern'])
  expect(editor.state.doc.nodes[ids[0]].textStyle?.fallbacks).toEqual(['default'])
  expect(hasPendingEdits(editor)).toBe(false)
})

test('a same-ID reopen does not commit an older advanced-font draft into the new session', async () => {
  const { TextStylePanel } = await import('./TextStylePanel')
  const { editor, ids } = fixture(1)
  function LivePanel() { const { doc } = useSyncExternalStore(editor.subscribe, editor.panelSnapshot); return <TextStylePanel editor={editor} ids={ids} node={doc.nodes[ids[0]]} /> }
  await act(async () => root.render(<LivePanel />))
  type(field('OpenType 特性'), '-liga'); expect(hasPendingEdits(editor)).toBe(true)
  act(() => editor.load(structuredClone(editor.state.doc)))
  const reopened = editor.state.doc, version = editor.state.version
  act(() => field('OpenType 特性').blur())
  choose('文字字体', 'latin')
  expect(editor.state.doc).toBe(reopened); expect(editor.state.version).toBe(version)
  expect(field('OpenType 特性').value).toBe('-liga'); expect(hasPendingEdits(editor)).toBe(true)
})

test('the single-text font picker shares the explicit detach choice with font management', async () => {
  const { TextStylePanel } = await import('./TextStylePanel'), { emptySystem } = await import('./design-system')
  const { editor, ids } = fixture(1)
  editor.change('Shared body style', doc => { doc.designSystem = emptySystem(); doc.designSystem.styles.body = { name: 'Body', kind: 'text', value: defaultTextStyle() }; doc.nodes[ids[0]].styleRefs = { textStyle: 'body' } })
  function LivePanel() { const { doc } = useSyncExternalStore(editor.subscribe, editor.panelSnapshot); return <TextStylePanel editor={editor} ids={ids} node={doc.nodes[ids[0]]} /> }
  await act(async () => root.render(<LivePanel />))
  const before = editor.state.doc
  choose('文字字体', 'latin'); expect(editor.state.doc).toBe(before)
  const detach = [...mount.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(input => input.parentElement?.textContent === '转为本地文字样式')!
  expect(detach).toBeTruthy(); click(detach); choose('文字字体', 'latin')
  expect(editor.state.doc.nodes[ids[0]].textStyle?.fontId).toBe('latin'); expect(editor.state.doc.nodes[ids[0]].styleRefs?.textStyle).toBeUndefined()
  act(() => editor.undo()); expect(editor.state.doc).toEqual(before)
})

test('original-font matching bounds retained font bytes before an oversized catalog can enter the document', async () => {
  const { emptySystem } = await import('./design-system')
  const { editor, ids } = fixture(100), host = nativeCatalog()
  editor.change('Original font identities', doc => { doc.designSystem = emptySystem(); doc.designSystem.fontSources = Object.fromEntries(ids.map((id, index) => [id, { style: `Test-${index}` }])) })
  let readIndex = 0
  host.read.mockImplementation(async () => {
    // Valid packaged subset bytes with distinct harmless trailing padding.
    const bytes = new Uint8Array(fontBytes.length + 4); bytes.set(fontBytes); new DataView(bytes.buffer).setUint32(fontBytes.length, ++readIndex)
    return { status: 'ok', ...host.data, data: Buffer.from(bytes).toString('base64') }
  })
  await render(editor); const before = editor.state.doc, version = editor.state.version
  click(button('匹配文档原字体'))
  await settle(() => host.read.mock.calls.length >= 33 && !button('匹配文档原字体').disabled)
  expect(host.read).toHaveBeenCalledTimes(33)
  expect(editor.state.doc).toBe(before); expect(editor.state.version).toBe(version)
  expect(mount.textContent).toContain('文档最多支持 32 个字体资源')
})

test('skipped locked original-font references must not consume the matching resource cap', async () => {
  const { emptySystem } = await import('./design-system')
  const { editor, ids } = fixture(35), host = nativeCatalog()
  editor.change('Original font identities and locks', doc => {
    doc.designSystem = emptySystem(); doc.designSystem.fontSources = Object.fromEntries(ids.map((id, index) => [id, { style: `Test-${index}` }]))
    ids.slice(0, 34).forEach(id => { doc.nodes[id].locked = true })
  })
  let readIndex = 0
  host.read.mockImplementation(async () => {
    const bytes = new Uint8Array(fontBytes.length + 4); bytes.set(fontBytes); new DataView(bytes.buffer).setUint32(fontBytes.length, ++readIndex)
    return { status: 'ok', ...host.data, data: Buffer.from(bytes).toString('base64') }
  })
  await render(editor); click(button('匹配文档原字体'))
  await settle(() => host.read.mock.calls.length > 0 && !button('匹配文档原字体').disabled)
  expect(editor.state.doc.nodes[ids[34]].textStyle?.fontId).not.toBe('default')
  expect(host.read).toHaveBeenCalledTimes(1)
})

test('selection change cancels a pending native read before it can modify the old selection', async () => {
  const { editor, ids } = fixture(2); act(() => editor.select([ids[0]]))
  let resolve!: (value: any) => void
  const host = nativeCatalog(() => new Promise(r => { resolve = r })); await render(editor)
  click(button('选择本机字体')); await settle(() => !!mount.querySelector('.system-font-picker button[style]'))
  click(mount.querySelector<HTMLButtonElement>('.system-font-picker button[style]')!)
  const before = editor.state.doc, version = editor.state.version
  act(() => editor.select([ids[1]]))
  await act(async () => { resolve({ status: 'ok', ...host.data }); await new Promise(r => setTimeout(r, 10)) })
  expect(editor.state.doc).toBe(before); expect(editor.state.version).toBe(version)
  expect(button('选择本机字体').disabled).toBe(false)
})

test('closing a pending read and choosing again does not let the old completion overwrite the new choice', async () => {
  const { editor, ids } = fixture(1); const resolves: ((value: any) => void)[] = []
  const host = nativeCatalog(() => new Promise(r => { resolves.push(r) })); await render(editor)
  click(button('选择本机字体')); await settle(() => !!mount.querySelector('.system-font-picker button[style]'))
  click(mount.querySelector<HTMLButtonElement>('.system-font-picker button[style]')!); click(button('关闭'))
  click(button('选择本机字体')); await settle(() => !!mount.querySelector('.system-font-picker button[style]') && !button('选择本机字体').disabled)
  click(mount.querySelector<HTMLButtonElement>('.system-font-picker button[style]')!)
  await act(async () => { resolves[1]({ status: 'ok', ...host.data }); await new Promise(r => setTimeout(r, 10)) })
  const after = editor.state.doc, version = editor.state.version; expect(after.nodes[ids[0]].textStyle?.fontId).not.toBe('default')
  await act(async () => { resolves[0]({ status: 'ok', ...host.data, data: btoa('invalid stale bytes') }); await new Promise(r => setTimeout(r, 10)) })
  expect(editor.state.doc).toBe(after); expect(editor.state.version).toBe(version)
  expect(mount.textContent).not.toContain('invalid stale bytes')
})

test('thirty-third resource is atomically rejected with exact history and document preserved', async () => {
  const { editor, ids } = fixture(1)
  editor.change('Fill valid font slots', doc => { doc.fonts = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`font-${i}`, latin])) })
  const before = editor.state.doc, version = editor.state.version
  const result = fonts.applySelectionFont(editor, ids, 'new-font', {}, latin)
  expect(result.status).toBe('rejected'); expect(editor.state.doc).toBe(before); expect(editor.state.version).toBe(version)
  expect(Object.keys(editor.state.doc.fonts!)).toHaveLength(32)
})

test('more than 32 source names sharing one byte identity do not exhaust unique resource admission', async () => {
  const { emptySystem } = await import('./design-system')
  const { editor, ids } = fixture(35), host = nativeCatalog()
  editor.change('Aliased original fonts', doc => { doc.designSystem = emptySystem(); doc.designSystem.fontSources = Object.fromEntries(ids.map((id, index) => [id, { style: `Test-${index}` }])) })
  const before = editor.state.doc
  await render(editor); click(button('匹配文档原字体'))
  await settle(() => host.read.mock.calls.length === 35 && !button('匹配文档原字体').disabled)
  expect(Object.keys(editor.state.doc.fonts!)).toHaveLength(2)
  const font = editor.state.doc.nodes[ids[0]].textStyle?.fontId; expect(font).not.toBe('default')
  for (const id of ids) expect(editor.state.doc.nodes[id].textStyle?.fontId).toBe(font)
  act(() => editor.undo()); expect(editor.state.doc).toEqual(before)
})

test.each(['selection', 'same-ID reopen'] as const)('delayed real font-file reading is retired by %s', async ending => {
  const { TextStylePanel } = await import('./TextStylePanel')
  const { editor, ids } = fixture(2); act(() => editor.select([ids[0]]))
  function LivePanel() { const state = useSyncExternalStore(editor.subscribe, editor.panelSnapshot); return <TextStylePanel editor={editor} ids={state.selection} node={state.doc.nodes[state.selection[0]]} /> }
  await act(async () => root.render(<LivePanel />))
  let resolve!: (value: ArrayBuffer) => void
  const selected = new dom.window.File([fontBytes], 'noto-latin.ttf', { type: 'font/ttf' })
  Object.defineProperty(selected, 'arrayBuffer', { value: () => new Promise<ArrayBuffer>(r => { resolve = r }) })
  const input = mount.querySelector<HTMLInputElement>('input[type="file"]')!
  Object.defineProperty(input, 'files', { configurable: true, value: [selected] })
  act(() => input.dispatchEvent(new dom.window.Event('change', { bubbles: true })))
  expect(resolve).toBeDefined()
  act(() => {
    if (ending === 'selection') editor.select([ids[1]])
    else { editor.load(structuredClone(editor.state.doc)); editor.select([ids[0]]) }
  })
  const before = editor.state.doc, version = editor.state.version
  await act(async () => { resolve(fontBytes.slice().buffer); await new Promise(r => setTimeout(r, 10)) })
  expect(editor.state.doc).toBe(before); expect(editor.state.version).toBe(version)
})

test('the final font import mutation fence rejects a same-ID reopen between the digest helper and caller continuation', async () => {
  const { TextStylePanel } = await import('./TextStylePanel')
  const { editor, ids } = fixture(1), before = editor.state.doc
  const digest = await crypto.subtle.digest('SHA-256', fontBytes)
  let resolveDigest!: (value: ArrayBuffer) => void
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(() => new Promise<ArrayBuffer>(r => { resolveDigest = r }))
  await act(async () => root.render(<TextStylePanel editor={editor} ids={ids} node={before.nodes[ids[0]]} />))
  const selected = new dom.window.File([fontBytes], 'noto-latin.ttf', { type: 'font/ttf' })
  Object.defineProperty(selected, 'arrayBuffer', { value: async () => fontBytes.slice().buffer })
  const input = mount.querySelector<HTMLInputElement>('input[type="file"]')!
  Object.defineProperty(input, 'files', { configurable: true, value: [selected] })
  act(() => input.dispatchEvent(new dom.window.Event('change', { bubbles: true })))
  await settle(() => !!resolveDigest)
  let reopened: typeof before = before, version = editor.state.version
  await act(async () => {
    // The helper's post-await ownership check runs first. This queued reopen
    // then precedes the caller continuation, exercising its separate fence.
    resolveDigest(digest)
    queueMicrotask(() => { editor.load(structuredClone(before)); reopened = editor.state.doc; version = editor.state.version })
    await new Promise(r => setTimeout(r, 10))
  })
  expect(editor.state.doc).toBe(reopened); expect(editor.state.version).toBe(version)
  expect(Object.keys(editor.state.doc.fonts!)).toEqual(['latin'])
})
