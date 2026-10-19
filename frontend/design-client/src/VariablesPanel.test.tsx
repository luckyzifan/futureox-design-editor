// Real React DOM events + Editor/WASM. jsdom has no browser rendering or GPU.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Editor } from './engine'
import { blank, node, type DesignDocument } from './model'
import { emptySystem } from './design-system'
import { VariablesPanel } from './VariablesPanel'
import { DesignTools } from './DesignTools'
import * as editing from './variable-editing'
import { commitPendingEdits, hasPendingEdits } from './pending-edits'
import { encodeDocumentBinary, decodeDocumentBinary } from './kernel/binfmt'

const bootstrap = await vi.hoisted(async () => {
  // @ts-expect-error jsdom is a test-only runtime dependency.
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  for (const name of ['window', 'document', 'navigator']) vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  return dom
})
bootstrap.window.close()
let dom: any, mount: HTMLDivElement, root: Root, errors: unknown[][]
const editors: Editor[] = []
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLSelectElement', 'Node', 'Event', 'KeyboardEvent'])
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  errors = []
  const original = console.error.bind(console)
  vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args); original(...args) })
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount())
  editors.splice(0).forEach(e => e.dispose())
  dom.window.close(); vi.unstubAllGlobals(); vi.restoreAllMocks()
  expect(errors).toEqual([])
})
function editor(doc = blank()) { const e = new Editor(doc); editors.push(e); return e }
function fixture(count = 2, modeCount = 2) {
  const doc = blank('Variable UI'), layer = node('rectangle', 0, 0, 10, 10), s = doc.designSystem = emptySystem()
  doc.schemaVersion = 4
  doc.nodes[layer.id] = layer; doc.pages[0].children = [layer.id]
  const modes = ['Light', 'Dark', ...Array.from({ length: Math.max(0, modeCount - 2) }, (_, i) => `Mode ${i + 3}`)]
  s.collections.theme = { name: 'Theme', modes, defaultMode: 'Light' }; s.activeModes.theme = 'Light'
  for (let i = 0; i < count; i++) s.variables[`v${i}`] = { name: `Spacing/${String(i).padStart(4, '0')}`, collection: 'theme', kind: 'number', values: Object.fromEntries(modes.map((m, j) => [m, 10 + i + j * 70])) }
  return { doc, layer }
}
const label = <T extends HTMLElement = HTMLInputElement>(name: string): T => {
  const found = [...mount.querySelectorAll<HTMLElement>('[aria-label]')].find(e => e.getAttribute('aria-label') === name)
  expect(found, `Missing label ${name}`).toBeTruthy(); return found as T
}
const button = (name: string) => {
  const found = [...mount.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === name)
  expect(found, `Missing button ${name}`).toBeTruthy(); return found!
}
function click(element: HTMLElement) { act(() => element.click()) }
function type(field: HTMLInputElement, value: string) {
  act(() => {
    field.focus(); Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
function key(field: HTMLElement, value: string) { act(() => field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true }))) }
function choose(name: string, value: string) {
  const field = label<HTMLSelectElement>(name)
  act(() => { field.value = value; field.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
}
function finish(name: string, value: string) { const field = label(name); type(field, value); key(field, 'Enter') }

 test('collection and typed variable controls commit atomic changes and UI edits survive binary disk reopen', async () => {
  const e = editor(); await act(async () => root.render(<VariablesPanel editor={e} />))
  type(label('集合名称'), 'Tokens'); click(button('新建集合')); click(button('+ number'))
  const id = Object.keys(e.state.doc.designSystem!.variables)[0], cid = Object.keys(e.state.doc.designSystem!.collections)[0]
  finish('变量名称', 'Spacing/base')
  const before = e.state.doc, version = e.state.version
  type(label('Spacing/base Dark'), '1.23456789012345')
  expect(e.state.doc).toBe(before); expect(hasPendingEdits(e)).toBe(true)
  key(label('Spacing/base Dark'), 'Enter')
  expect(e.state.doc.designSystem!.variables[id].values.Dark).toBe(1.23456789012345)
  expect(e.state.version).toBe(version + 1)
  click(button('撤销')); expect(e.state.doc).toEqual(before)
  click(button('重做')); expect(label('Spacing/base Dark').value).toBe('1.23456789012345')
  finish('重命名集合', 'Saved tokens'); finish('重命名模式 Dark', 'Night')
  expect(e.state.doc.designSystem!.collections[cid].modes).toEqual(['Light', 'Night'])
  click(button('+ boolean'))
  choose('新boolean变量 Light', 'false')
  const booleanId = Object.keys(e.state.doc.designSystem!.variables).find(key => key !== id)!
  expect(e.state.doc.designSystem!.variables[booleanId].values.Light).toBe(false)
  const directory = await mkdtemp(join(tmpdir(), 'variables-ui-'))
  try {
    const expected = e.state.doc, file = join(directory, 'saved.fd')
    await writeFile(file, encodeDocumentBinary(expected))
    const reopened = editor(decodeDocumentBinary(new Uint8Array(await readFile(file))) as DesignDocument)
    expect(reopened.state.doc).toEqual(expected)
    await act(async () => root.render(<VariablesPanel key="reopened" editor={reopened} />))
    expect(label('Spacing/base Night').value).toBe('1.23456789012345')
    expect(label<HTMLSelectElement>('新boolean变量 Light').value).toBe('false')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('alias-to-value UI uses the inactive column and rejects a cycle without changing history', async () => {
  const { doc } = fixture(), s = doc.designSystem!
  s.variables.v1.values = { Light: { alias: 'v0' }, Dark: { alias: 'v0' } }
  const e = editor(doc); await act(async () => root.render(<VariablesPanel editor={e} />))
  const before = e.state.doc
  choose('Spacing/0001 Dark 值类型', 'literal')
  expect(e.state.doc.designSystem!.variables.v1.values.Dark).toBe(80)
  expect(e.state.doc.designSystem!.activeModes.theme).toBe('Light')
  click(button('撤销')); expect(e.state.doc).toEqual(before)
  choose('Spacing/0000 Light 值类型', 'alias')
  choose('Spacing/0000 Light 别名', 'v1')
  expect(e.state.doc).toEqual(before); expect(e.canUndo).toBe(false)
  expect(mount.querySelector('[role="alert"]')?.textContent).toMatch(/cycle|循环/i)
  choose('Spacing/0000 Light 值类型', 'literal')
  expect(label('Spacing/0000 Light').value).toBe('10')
})

test('invalid drafts veto Close and tab changes; Escape cancels the field without closing the dialog', async () => {
  const { doc } = fixture(), e = editor(doc), close = vi.fn()
  await act(async () => root.render(<DesignTools editor={e} onClose={close} />))
  const field = label('Spacing/0000 Light'), before = e.state.doc
  type(field, '-')
  click(button('关闭')); expect(close).not.toHaveBeenCalled(); expect(mount.contains(field)).toBe(true)
  click(button('共享样式')); expect(mount.contains(field)).toBe(true); expect(field.value).toBe('-')
  expect(e.state.doc).toBe(before); expect(e.canUndo).toBe(false)
  key(field, 'Escape'); expect(field.value).toBe('10'); expect(close).not.toHaveBeenCalled()
  expect(hasPendingEdits(e)).toBe(false)
  click(button('共享样式')); expect(label('样式名称')).toBeTruthy()
  click(button('变量与主题')); expect(label('Spacing/0000 Light').value).toBe('10')
  click(button('关闭')); expect(close).toHaveBeenCalledOnce()
})

test('IME and invalid pending fields survive collection, filter and pagination attempts', async () => {
  const { doc } = fixture(42, 4), e = editor(doc)
  await act(async () => root.render(<VariablesPanel editor={e} />))
  const field = label('Spacing/0000 Light')
  act(() => field.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true })))
  type(field, '32')
  click(label('下一页变量')); expect(mount.contains(field)).toBe(true); expect(field.value).toBe('32')
  click(label('下一组模式')); expect(mount.contains(field)).toBe(true)
  expect(e.state.doc.designSystem!.variables.v0.values.Light).toBe(10)
  act(() => field.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true, data: '32' })))
  key(field, 'Enter'); expect(e.state.doc.designSystem!.variables.v0.values.Light).toBe(32)
  type(label('Spacing/0000 Light'), 'invalid')
  type(label('搜索变量'), '0041')
  expect(label('搜索变量').value).toBe(''); expect(label('Spacing/0000 Light').value).toBe('invalid')
  key(label('Spacing/0000 Light'), 'Escape')
  type(label('搜索变量'), '0041')
  expect(mount.querySelectorAll('[data-variable-id]')).toHaveLength(1)
  expect(label('Spacing/0041 Light').value).toBe('51')
})

test('delete inspection reports actual dependents, rechecks live references and supports cancel and undo', async () => {
  const { doc, layer } = fixture(); doc.designSystem!.variables.v1.values.Dark = { alias: 'v0' }; layer.bindings = { width: 'v0' }
  const e = editor(doc); await act(async () => root.render(<VariablesPanel editor={e} />))
  click(label('删除变量 Spacing/0000'))
  const inspection = label('删除检查')
  expect(inspection.textContent).toContain('别名'); expect(inspection.textContent).toContain('width')
  expect(button('确认删除').disabled).toBe(true)
  click(button('取消删除')); expect(mount.querySelector('[aria-label="删除检查"]')).toBeNull()
  click(label('删除变量 Spacing/0000'))
  act(() => e.change('Release dependencies', d => { delete d.nodes[layer.id].bindings; d.designSystem!.variables.v1.values.Dark = 25 }))
  expect(button('确认删除').disabled).toBe(false)
  const before = e.state.doc
  click(button('确认删除')); expect(e.state.doc.designSystem!.variables).not.toHaveProperty('v0')
  click(button('撤销')); expect(e.state.doc).toEqual(before)
})

test('mode add, rename, default, safe delete and collection delete enforce their policies in visible controls', async () => {
  const { doc } = fixture(), e = editor(doc); await act(async () => root.render(<VariablesPanel editor={e} />))
  click(label('删除模式 Light'))
  expect(label('删除检查').textContent).toContain('默认模式'); expect(label('删除检查').textContent).toContain('当前模式')
  expect(button('确认删除').disabled).toBe(true); click(button('取消删除'))
  type(label('新增模式名称'), 'Print'); choose('复制模式值来源', 'Dark'); click(button('添加模式'))
  expect(e.state.doc.designSystem!.variables.v0.values.Print).toBe(80)
  choose('Theme 默认模式', 'Print'); expect(e.state.doc.designSystem!.activeModes.theme).toBe('Light')
  finish('重命名模式 Dark', 'Night'); expect(e.state.doc.designSystem!.variables.v0.values.Night).toBe(80)
  click(label('删除模式 Night')); expect(button('确认删除').disabled).toBe(false); click(button('确认删除'))
  expect(e.state.doc.designSystem!.variables.v0.values).not.toHaveProperty('Night')
  click(button('撤销')); expect(e.state.doc.designSystem!.variables.v0.values.Night).toBe(80)
  click(button('删除集合')); expect(button('确认删除').disabled).toBe(true); expect(label('删除检查').textContent).toContain('Spacing/0000')
})

test('bounded rows and modes, search and type filtering keep all data accessible without camera rerenders', async () => {
  const { doc } = fixture(1000, 7), e = editor(doc), index = vi.spyOn(editing, 'variableIndex')
  const start = performance.now()
  await act(async () => root.render(<DesignTools editor={e} onClose={() => {}} />))
  expect(mount.querySelectorAll('[data-variable-id]')).toHaveLength(editing.VARIABLE_PAGE_SIZE)
  expect(mount.querySelectorAll('[aria-label^="重命名模式 "]')).toHaveLength(editing.MODE_PAGE_SIZE)
  const field = label('Spacing/0000 Light'), initialHtml = mount.innerHTML, calls = index.mock.calls.length
  for (let i = 1; i <= 120; i++) act(() => e.set({ view: { x: i, y: -i, zoom: 1 + i / 100 } }))
  expect(index.mock.calls).toHaveLength(calls); expect(mount.innerHTML).toBe(initialHtml); expect(label('Spacing/0000 Light')).toBe(field)
  click(label('下一页变量')); expect(mount.querySelectorAll('[data-variable-id]')).toHaveLength(40)
  expect(label('Spacing/0040 Light')).toBeTruthy()
  type(label('搜索变量'), '0999'); expect(mount.querySelectorAll('[data-variable-id]')).toHaveLength(1)
  click(label('下一组模式')); expect(label('Spacing/0999 Mode 4')).toBeTruthy()
  choose('变量类型筛选', 'color'); expect(mount.querySelectorAll('[data-variable-id]')).toHaveLength(0)
  choose('变量类型筛选', 'number'); expect(mount.querySelectorAll('[data-variable-id]')).toHaveLength(1)
  console.info('VARIABLE_UI_METRIC', JSON.stringify({ variables: 1000, modes: 7, maxRows: 40, maxColumns: 3, cameraUpdates: 120, cameraReindexes: index.mock.calls.length - calls, durationMs: performance.now() - start, runtime: 'React/jsdom + real Editor/WASM; no browser/GPU' }))
})

test('multi-selection binding shows mixed state then applies one typed variable and undoes both layers', async () => {
  const { doc, layer } = fixture(), other = node('rectangle', 30, 0, 10, 10)
  doc.nodes[other.id] = other; doc.pages[0].children.push(other.id)
  layer.bindings = { width: 'v0' }; other.bindings = { width: 'v1' }
  const e = editor(doc); e.select([layer.id, other.id])
  await act(async () => root.render(<VariablesPanel editor={e} />))
  choose('绑定属性', 'width'); expect(label<HTMLSelectElement>('绑定变量').value).toBe('__mixed__')
  const before = e.state.doc
  choose('绑定变量', 'v0')
  expect(e.state.doc.nodes[layer.id].width).toBe(10); expect(e.state.doc.nodes[other.id].width).toBe(10)
  expect(e.state.doc.nodes[other.id].bindings?.width).toBe('v0')
  click(button('撤销')); expect(e.state.doc).toEqual(before)
  choose('Theme 图层局部模式', 'mode:Dark')
  expect(e.state.doc.nodes[layer.id].width).toBe(80); expect(e.state.doc.nodes[other.id].width).toBe(81)
})

test('valid input commits before switching tabs and nonvariable tabs keep their original controls', async () => {
  const { doc } = fixture(), e = editor(doc), close = vi.fn()
  await act(async () => root.render(<DesignTools editor={e} onClose={close} />))
  type(label('Spacing/0000 Light'), '34.625'); click(button('共享样式'))
  expect(e.state.doc.designSystem!.variables.v0.values.Light).toBe(34.625)
  expect(hasPendingEdits(e)).toBe(false); expect(label('样式名称')).toBeTruthy()
  click(button('组件库')); expect(label('组件库版本')).toBeTruthy()
  click(button('交互原型')); expect(button('将选中图层设为起点')).toBeTruthy()
  click(button('关闭')); expect(close).toHaveBeenCalledOnce()
})

test('invalid numeric input remains recoverable and lifecycle commit refuses it without coercing empty to zero', async () => {
  const { doc } = fixture(), e = editor(doc); await act(async () => root.render(<VariablesPanel editor={e} />))
  const before = e.state.doc, field = label('Spacing/0000 Light')
  type(field, '')
  act(() => { expect(commitPendingEdits(e)).toBe(false) })
  expect(e.state.doc).toBe(before); expect(field.value).toBe(''); expect(field.getAttribute('aria-invalid')).toBe('true')
  type(field, '12.875'); key(field, 'Enter')
  expect(e.state.doc.designSystem!.variables.v0.values.Light).toBe(12.875)
  expect(hasPendingEdits(e)).toBe(false)
})

test('same-ID reopen remounts variable drafts for the new session while dirty invalid drafts veto replacement', async () => {
  const { doc } = fixture(), e = editor(doc)
  await act(async () => root.render(<DesignTools editor={e} onClose={() => {}} />))
  const oldField = label('Spacing/0000 Light'), generation = e.sessionGeneration
  const reopened = structuredClone(e.state.doc); reopened.designSystem!.variables.v0.values.Light = 35.5
  act(() => { expect(e.load(reopened)).toBe(true) })
  expect(e.sessionGeneration).toBe(generation + 1)
  expect(label('Spacing/0000 Light')).not.toBe(oldField)
  expect(label('Spacing/0000 Light').value).toBe('35.5')
  finish('Spacing/0000 Light', '67.25')
  expect(e.state.doc.designSystem!.variables.v0.values.Light).toBe(67.25)
  const current = label('Spacing/0000 Light'), before = e.state.doc
  type(current, '-')
  act(() => { expect(e.load(reopened)).toBe(false) })
  expect(e.state.doc).toBe(before); expect(label('Spacing/0000 Light')).toBe(current); expect(current.value).toBe('-')
  key(current, 'Escape'); expect(current.value).toBe('67.25')
})

test.each(['1e1', '10.0', '+10', ' 10 '])('equivalent numeric draft %s finishes cleanly without fake history or revision', async spelling => {
  const { doc } = fixture(), e = editor(doc), close = vi.fn()
  await act(async () => root.render(<DesignTools editor={e} onClose={close} />))
  const before = e.state.doc, version = e.state.version
  finish('Spacing/0000 Light', spelling)
  expect(e.state.doc).toBe(before); expect(e.state.version).toBe(version); expect(e.canUndo).toBe(false)
  expect(hasPendingEdits(e)).toBe(false); expect(label('Spacing/0000 Light').value).toBe('10')
  click(button('关闭')); expect(close).toHaveBeenCalledOnce()
})

test('explicit multi-layer variable binding includes locked selection and undoes atomically', async () => {
  const { doc, layer } = fixture(), other = node('rectangle', 30, 0, 10, 10)
  layer.locked = true; doc.nodes[other.id] = other; doc.pages[0].children.push(other.id)
  const e = editor(doc); e.select([layer.id, other.id]); const before = e.state.doc
  await act(async () => root.render(<VariablesPanel editor={e} />))
  choose('绑定属性', 'width'); choose('绑定变量', 'v1')
  for (const id of [layer.id, other.id]) { expect(e.state.doc.nodes[id].bindings?.width).toBe('v1'); expect(e.state.doc.nodes[id].width).toBe(11) }
  expect(e.state.doc.nodes[layer.id].locked).toBe(true)
  click(button('撤销')); expect(e.state.doc).toEqual(before)
})
