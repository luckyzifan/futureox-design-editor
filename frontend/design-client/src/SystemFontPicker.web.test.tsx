// Real React DOM + Editor/WASM + real font bytes. Only the browser FontData /
// permission API boundary is doubled; this is not browser permission or GUI QA.
// @ts-expect-error jsdom runtime dependency
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { FontManagementPanel } from './FontManagementPanel'
import { Editor } from './engine'
import { blank, node, defaultTextStyle } from './model'
import { emptySystem } from './design-system'
import { interfacePreference } from './interface-preference'
import { fontTestBytes } from './font-test-fixtures'
import { font_faces_json } from './generated/design-kernel/design_kernel'
import { unmatchedSourceFonts } from './font-matching'
import { importFigTextRuns } from './import-fig-text'
import { componentFixture, originNode } from './component-fixtures'

const bootstrap = await vi.hoisted(async () => {
  // @ts-expect-error jsdom runtime dependency
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  for (const key of ['window', 'document', 'navigator']) vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key])
  return dom
})
bootstrap.window.close()
const bytes = new Uint8Array(fontTestBytes('noto-latin'))
let face: { family: string; style: string; postscript: string }
let dom: any, root: Root, mount: HTMLDivElement, editor: Editor, id: string
beforeEach(() => {
  face = JSON.parse(font_faces_json(bytes))[0]
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://font-test.invalid/' })
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Node', 'Event', 'localStorage']) vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  interfacePreference.reset()
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount)
  const doc = blank('Web fonts'), text = node('text', 0, 0, 240, 40)
  id = text.id; text.text = 'ABC'; text.textStyle = defaultTextStyle()
  doc.nodes[id] = text; doc.pages[0].children.push(id)
  editor = new Editor(doc); editor.select([id])
})
afterEach(async () => {
  await act(async () => root.unmount()); editor.dispose(); interfacePreference.reset()
  dom.window.close(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})
const button = (name: string) => {
  const found = [...mount.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === name)
  expect(found, `Missing button: ${name}`).toBeTruthy(); return found!
}
const click = (element: HTMLElement) => act(() => element.click())
const render = () => act(async () => root.render(<FontManagementPanel editor={editor} />))
async function settle(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
  expect(predicate()).toBe(true)
}
function catalog() {
  const blob = vi.fn(async () => new Blob([bytes]))
  const query = vi.fn(async () => [{ family: face.family, style: face.style, postscriptName: face.postscript, blob }])
  Object.defineProperty(window, 'queryLocalFonts', { configurable: true, value: query })
  return { query, blob }
}

test('Web host never needs IPC, asks for font access only on click, and reads only the chosen face', async () => {
  const { query, blob } = catalog(), before = editor.state.doc
  await render(); expect(window.coreDesktop).toBeUndefined(); expect(query).not.toHaveBeenCalled()
  click(button('选择本机字体')); await settle(() => !!mount.querySelector('.system-font-picker button[style]'))
  expect(query).toHaveBeenCalledTimes(1); expect(blob).not.toHaveBeenCalled()
  click(mount.querySelector<HTMLButtonElement>('.system-font-picker button[style]')!)
  await settle(() => !mount.querySelector('.system-font-picker'))
  const selected = editor.state.doc.nodes[id].textStyle!.fontId
  expect(selected).not.toBe('default'); expect(blob).toHaveBeenCalledTimes(1)
  expect(editor.state.doc.fonts?.[selected].postscript).toBe(face.postscript)
  act(() => editor.undo()); expect(editor.state.doc).toEqual(before)
})

test('partial Web source matching does not silently replace another missing face', async () => {
  const { query, blob } = catalog()
  editor.change('Import FIG source identities', document => {
    const source = importFigTextRuns(document.nodes[id], {
      fontName: { postscript: face.postscript },
      textData: { characterStyleIDs: [0, 1, 0], styleOverrideTable: [{ styleID: 1, fontName: { family: face.family, style: 'Missing Bold' }, fontSize: 17.125 }] },
    }, new Set<string>())
    document.designSystem = { ...emptySystem(), fontSources: { [id]: source } }
  })
  const before = editor.state.doc
  await render(); click(button('匹配文档原字体'))
  await settle(() => query.mock.calls.length === 1 && !button('匹配文档原字体').disabled)
  expect(blob).toHaveBeenCalledTimes(1)
  expect(editor.state.doc.nodes[id].textStyle?.fontId).not.toBe('default')
  expect(editor.state.doc.nodes[id].textRuns?.[0].fontId).toBe('default')
  expect(unmatchedSourceFonts(editor.state.doc, editor.state.doc.nodes[id])).toEqual([`${face.family} Missing Bold`])
  expect(mount.textContent).toContain(`${face.family} Missing Bold`)
  act(() => editor.undo()); expect(editor.state.doc).toEqual(before)
})

test('a browser permission refusal remains non-mutating and re-localizes without a second request', async () => {
  const query = vi.fn(async () => { throw new dom.window.DOMException('User denied access', 'NotAllowedError') })
  Object.defineProperty(window, 'queryLocalFonts', { configurable: true, value: query })
  const before = editor.state.doc
  await render(); click(button('选择本机字体'))
  await settle(() => query.mock.calls.length === 1 && !button('选择本机字体').disabled)
  expect(mount.textContent).toContain('本机字体访问未获授权；可重新授权或导入 TTF / OTF 字体')
  await act(async () => { interfacePreference.set({ locale: 'en' }) })
  expect(mount.textContent).toContain('Local font access was not allowed. Grant access or import a TTF / OTF font instead.')
  expect(query).toHaveBeenCalledTimes(1); expect(editor.state.doc).toBe(before)
})

test('built-in font search matches its visible translated label without changing document data', async () => {
  editor.change('Install alternate font', document => {
    document.fonts = { alternate: { family: '作者字体名称', data: Buffer.from(bytes).toString('base64'), index: 0 } }
  })
  await act(async () => { interfacePreference.set({ locale: 'en' }) }); await render()
  const target = mount.querySelector<HTMLSelectElement>('select[aria-label="Target font"]')!
  await act(async () => { target.value = 'alternate'; target.dispatchEvent(new Event('change', { bubbles: true })) })
  const before = editor.state.doc, input = mount.querySelector<HTMLInputElement>('input[aria-label="Search document fonts"]')!
  expect(input).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Built-in')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  // Use a different selected font: a pinned selection must not masquerade as a
  // search result. The default font must be present as an actual match.
  const { documentFontChoices, searchFontChoices } = await import('./font-management')
  expect(searchFontChoices(documentFontChoices(editor.state.doc, 'en'), 'Built-in').map(font => font.id)).toEqual(['default'])
  expect([...target.options].map(option => option.value)).toEqual(['default', 'alternate'])
  expect(target.options[0].textContent).toContain('Built-in')
  expect(target.options[1].textContent).toBe('作者字体名称')
  expect(editor.state.doc).toBe(before)
})

test('closing during a browser font blob read retires it without installing stale bytes', async () => {
  let release!: (blob: Blob) => void
  const blob = vi.fn(() => new Promise<Blob>(resolve => { release = resolve }))
  Object.defineProperty(window, 'queryLocalFonts', { configurable: true, value: async () => [{ family: face.family, style: face.style, postscriptName: face.postscript, blob }] })
  const before = editor.state.doc, version = editor.state.version
  await render(); click(button('选择本机字体'))
  await settle(() => !!mount.querySelector('.system-font-picker button[style]'))
  click(mount.querySelector<HTMLButtonElement>('.system-font-picker button[style]')!)
  expect(blob).toHaveBeenCalledTimes(1); click(button('关闭'))
  await act(async () => { release(new Blob([bytes])); await new Promise(resolve => setTimeout(resolve, 10)) })
  expect(editor.state.doc).toBe(before); expect(editor.state.version).toBe(version)
  expect(mount.querySelector('.system-font-picker')).toBeNull()
})

test('the Web matching result explains deferred inherited runs in both languages without modifying overrides', async () => {
  editor.dispose()
  const { doc, ids } = componentFixture(), { query } = catalog()
  doc.nodes[ids.label].textStyle = defaultTextStyle()
  doc.nodes[ids.label].textRuns = [{ start: 0, end: 1, weight: 700 }]
  editor = new Editor(doc)
  const key = editor.state.doc.nodes[ids.label].componentKey!, instance = originNode(editor.state.doc, ids.a, key)
  editor.updateProperties([instance.id], text => { text.textStyle!.letterSpacing = .125 })
  editor.change('Imported source identity', document => {
    document.designSystem ??= emptySystem()
    document.designSystem.fontSources = { [instance.id]: { style: face.postscript, runs: { 0: 'Missing Bold' } } }
  })
  editor.select([instance.id]); const before = editor.state.doc
  await render(); click(button('匹配文档原字体'))
  await settle(() => query.mock.calls.length === 1 && !button('匹配文档原字体').disabled)
  expect(mount.textContent).toContain('跳过 1 个含继承字体片段的图层，请在主组件检查')
  await act(async () => { interfacePreference.set({ locale: 'en' }) })
  expect(mount.textContent).toContain('skipped 1 layers with inherited source-font runs; check the main component')
  expect(editor.state.doc).toBe(before)
  expect(editor.state.doc.nodes[ids.a].instance!.overrides[key].textRuns).toBeUndefined()
  expect(query).toHaveBeenCalledTimes(1)
})
