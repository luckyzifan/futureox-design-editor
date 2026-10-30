// Real React/jsdom + Editor/current WASM. These are CPU/work-count checks,
// not a browser, GPU, frame-rate, or pixel-quality benchmark.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { appendFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node, effect, stroke, type DesignNode } from './model'
import { Inspector } from './Inspector'
import { PendingEditContext } from './pending-edit-context'
import { selectionMetric } from './selection-properties'
const parentScans = vi.hoisted(() => ({ count: 0 }))
vi.mock('./geometry', async importOriginal => {
  const actual = await importOriginal<typeof import('./geometry')>()
  return { ...actual, allParents: (...args: Parameters<typeof actual.allParents>) => {
    parentScans.count++
    return actual.allParents(...args)
  } }
})

const bootstrap = await vi.hoisted(async () => {
  // @ts-expect-error jsdom is a test-only runtime dependency.
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  for (const name of ['window', 'document', 'navigator'])
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  return dom
})
bootstrap.window.close()

let dom: any, root: Root, mount: HTMLDivElement
const editors: Editor[] = []
let errors: unknown[][]
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Node', 'Event', 'KeyboardEvent', 'localStorage'])
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  errors = []
  parentScans.count = 0
  const original = console.error.bind(console)
  vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args); original(...args) })
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount())
  editors.splice(0).forEach(editor => editor.dispose())
  dom.window.close(); vi.unstubAllGlobals(); vi.restoreAllMocks()
  expect(errors).toEqual([])
})

function fixture(size: number, styled = false, text = false) {
  const doc = blank('Multi-selection CPU'), outer = node('frame', 20, 40, 20000, 20000), group = node('group', 12, 18, 10000, 10000)
  outer.transform = [0, -2, -2, 0, 20, 40]
  group.transform = [1, .25, .1, 1.5, 12, 18]
  outer.children = [group.id]; doc.pages[0].children = [outer.id]
  doc.nodes = { [outer.id]: outer, [group.id]: group }
  const ids: string[] = []
  for (let i = 0; i < size; i++) {
    const item = node(text ? 'text' : 'rectangle', 10 + i * 4, 20 + (i % 3), 40, 30)
    item.name = `Selected ${i}`; item.locked = i === size - 1
    if (text) { item.text = `Text ${i}`; item.fontSize = 14 }
    if (styled) { item.strokes = [stroke()]; item.effects = [effect('shadow')] }
    doc.nodes[item.id] = item; group.children.push(item.id); ids.push(item.id)
  }
  const editor = new Editor(doc); editor.select(ids); editors.push(editor)
  return { editor, ids, outer, group }
}
async function render(editor: Editor) {
  await act(async () => root.render(<PendingEditContext.Provider value={editor}><Inspector editor={editor} /></PendingEditContext.Provider>))
}
function report(name: string, data: Record<string, unknown>) {
  const row = { name, runtime: 'React/jsdom + real Editor/WASM; CPU only', ...data }
  console.info('MULTISELECTION_CPU_METRIC', JSON.stringify(row))
  if (process.env.MULTISELECTION_CPU_METRICS) appendFileSync(process.env.MULTISELECTION_CPU_METRICS, JSON.stringify(row) + '\n')
}
function field(label: string) { return mount.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)! }
function enter(label: string, value: string) {
  const input = field(label)
  expect(input).not.toBeNull()
  act(() => input.focus())
  act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  act(() => input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
}

test.each([300, 3000])('mount %i selected nested nodes with a bounded number of parent traversals', async size => {
  const { editor, ids } = fixture(size)
  const before = editor.state.doc
  parentScans.count = 0
  const started = performance.now()
  await render(editor)
  const durationMs = performance.now() - started, allParentsCalls = parentScans.count
  report('initial-multiselection', { nodes: Object.keys(before.nodes).length, selected: size, durationMs, allParentsCalls,
    fields: ['X', 'Y', 'W', 'H', '旋转 °', '透明度 %'].map(label => ({ label, value: field(label).value, placeholder: field(label).placeholder })) })
  expect(mount.querySelector('[aria-label="多选属性"]')).not.toBeNull()
  expect(field('X').placeholder).toBe('混合')
  expect(Number(field('W').value)).toBeCloseTo(selectionMetric(before.nodes[ids[0]], 'width', before), 2)
  expect(editor.state.doc).toBe(before)
  // Counts, not wall-clock limits, prevent machine noise masking a regression.
  expect(allParentsCalls).toBeLessThanOrEqual(5)
}, 120000)

test('scaled text/stroke/effect fields share the same traversal and remain live through edits and history', async () => {
  const { editor, ids } = fixture(4, true, true)
  parentScans.count = 0
  await render(editor)
  const renderCalls = parentScans.count
  report('styled-multiselection', { selected: ids.length, allParentsCalls: renderCalls })
  expect(renderCalls).toBeLessThanOrEqual(6)
  const before = editor.state.doc, fontBefore = Number(field('字号').value), strokeBefore = Number(field('描边 1粗细').value)
  enter('W', '180')
  for (const id of ids) expect(selectionMetric(editor.state.doc.nodes[id], 'width', editor.state.doc)).toBeCloseTo(180, 8)
  expect(Number(field('字号').value)).toBe(fontBefore)
  expect(Number(field('描边 1粗细').value)).toBe(strokeBefore)
  const resized = editor.state.doc
  act(() => editor.undo()); expect(editor.state.doc).toEqual(before)
  act(() => editor.redo()); expect(editor.state.doc).toEqual(resized)
  enter('字号', '42')
  expect(Number(field('字号').value)).toBe(42)
  for (const id of ids) expect(editor.state.doc.nodes[id].text).toBe(before.nodes[id].text)
  act(() => editor.undo()); expect(Number(field('字号').value)).toBe(fontBefore)
  enter('描边 1粗细', '9')
  expect(Number(field('描边 1粗细').value)).toBe(9)
  act(() => editor.undo()); expect(Number(field('描边 1粗细').value)).toBe(strokeBefore)
})

test('mixed expressions, preview cancellation, reparenting, and camera writes preserve current values', async () => {
  const { editor, ids, outer, group } = fixture(4)
  await render(editor)
  const before = editor.state.doc
  const x = ids.map(id => selectionMetric(before.nodes[id], 'x', before))
  enter('X', '+=12')
  ids.forEach((id, i) => expect(selectionMetric(editor.state.doc.nodes[id], 'x', editor.state.doc)).toBeCloseTo(x[i] + 12, 8))
  act(() => editor.undo()); expect(editor.state.doc).toEqual(before)
  const html = mount.innerHTML
  parentScans.count = 0
  for (let i = 1; i <= 60; i++) act(() => editor.set({ view: { x: i, y: -i, zoom: 1 + i / 100 } }))
  expect(parentScans.count).toBe(0); expect(mount.innerHTML).toBe(html)
  let clock = performance.now() + 1000
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  editor.begin('Batch move')
  act(() => editor.preview(Object.fromEntries(ids.map(id => [id, { transform: [1, 0, 0, 1, 200, 100] } satisfies Partial<DesignNode>]))))
  clock += 81
  act(() => editor.preview(Object.fromEntries(ids.map(id => [id, { transform: [1, 0, 0, 1, 220, 100] } satisfies Partial<DesignNode>]))))
  expect(field('X').placeholder).not.toBe('混合')
  act(() => editor.cancel()); expect(editor.state.doc).toBe(before); expect(field('X').placeholder).toBe('混合')
  act(() => editor.change('Reparent', doc => {
    doc.nodes[group.id].children = []
    doc.nodes[outer.id].children.push(...ids)
  }))
  expect(Number(field('W').value)).toBe(80)
  act(() => editor.undo()); expect(editor.state.doc).toEqual(before)
  expect(Number(field('W').value)).toBeCloseTo(selectionMetric(before.nodes[ids[0]], 'width', before), 2)
})
