// Mounted inputs + real Editor/WASM authored-state tests; not GPU/pixel evidence.
// @ts-expect-error jsdom runtime dependency
import { JSDOM } from 'jsdom'
import React, { act, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { NumberField } from './fields'
import { DraftInput } from './DraftInput'
import { MixedNumberField } from './MixedNumberField'
import { ColorInput } from './ColorInput'
import { Editor } from './engine'
import { blank, node } from './model'
import { PendingEditContext } from './pending-edit-context'
import { selectionMetric, resizeNodeDimension } from './selection-properties'
import { parentBounds } from './canvas-view'
import { canvasActions, ActionOutcome, closeCanvasActions } from './canvas-action-diagnostics'
import { InputFamily, InputPhase } from './input-diagnostics'
const bootstrap = await vi.hoisted(async () => {
  // @ts-expect-error jsdom runtime dependency
  const { JSDOM } = await import('jsdom')
  const d = new JSDOM('<!doctype html><html><body></body></html>')
  for (const name of ['window', 'document', 'navigator']) vi.stubGlobal(name, name === 'window' ? d.window : d.window[name])
  return d
})
bootstrap.window.close()
let dom: any, mount: HTMLDivElement, root: Root, editor: Editor, id: string
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'CompositionEvent']) vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  ;(window as any).coreDesktop = { renderDiagnostics: true, renderDiagnosticsDetail: true }
  const doc = blank(), rect = node('rectangle', 0, 0, 100, 50); id = rect.id; doc.nodes[id] = rect; doc.pages[0].children.push(id)
  editor = new Editor(doc); editor.select([id])
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount)
})
afterEach(async () => { await act(async () => root.unmount()); closeCanvasActions(editor); editor.dispose(); dom.window.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function Dimensions() {
  const s = useSyncExternalStore(editor.subscribe, editor.snapshot), n = s.doc.nodes[id]
  return <PendingEditContext.Provider value={editor}>{(['width', 'height'] as const).map((axis, i) => <NumberField key={axis} label={i ? 'H' : 'W'} value={selectionMetric(n, axis, s.doc)} min={.01} max={500} onChange={v => editor.updateProperties([id], n => resizeNodeDimension(n, axis, v, s.doc))} />)}</PendingEditContext.Provider>
}
const input = (label: string) => mount.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
async function type(field: HTMLInputElement, value: string) {
  await act(async () => { field.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function key(field: HTMLInputElement, key: string) { await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))) }
const completed = () => canvasActions(editor).snapshot().rows.filter(r => r.actionPhase === 2)
test('blank-document width and height author geometry agrees with selection bounds, with undo', async () => {
  await act(async () => root.render(<Dimensions />))
  for (const [label, axis, value] of [['W', 'width', 160], ['H', 'height', 90]] as const) {
    const before = editor.state.doc.nodes[id][axis]
    await type(input(label), String(value)); expect(editor.state.doc.nodes[id][axis]).toBe(before)
    await key(input(label), 'Enter')
    expect(editor.state.doc.nodes[id][axis]).toBe(value)
    expect(parentBounds(editor.state.doc.nodes[id])[axis]).toBe(value)
    expect(completed().some(r => r.actionOutcome === ActionOutcome.committed && r[axis === 'width' ? 'expectedWidthComparison' : 'expectedHeightComparison'] === 1)).toBe(true)
    await act(async () => editor.undo()); expect(editor.state.doc.nodes[id][axis]).toBe(before)
  }
})
test('min/max invalid draft and Escape do not author; ratio lock preserves ratio', async () => {
  editor.updateProperties([id], n => { n.constrainProportions = true })
  await act(async () => root.render(<Dimensions />)); const before = editor.state.doc
  for (const invalid of ['0', '501', 'not-a-number']) { await type(input('W'), invalid); await key(input('W'), 'Enter'); expect(editor.state.doc).toBe(before); await key(input('W'), 'Escape') }
  await type(input('W'), '140'); await key(input('W'), 'Escape'); expect(editor.state.doc).toBe(before)
  await type(input('W'), '200'); await key(input('W'), 'Enter')
  expect(editor.state.doc.nodes[id].height).toBe(100)
  expect(completed().some(r => r.aspectRatioComparison === 1)).toBe(true)
  expect(completed().some(r => r.inputValid === 0)).toBe(true)
  expect(completed().some(r => r.actionOutcome === ActionOutcome.cancelled)).toBe(true)
})
test('callback return without authored change is blocked, never committed', async () => {
  await act(async () => root.render(<PendingEditContext.Provider value={editor}><NumberField label="W" value={100} onChange={() => {}} /></PendingEditContext.Provider>))
  await type(input('W'), '120'); await key(input('W'), 'Enter')
  expect(completed().some(r => r.actionOutcome === ActionOutcome.blocked)).toBe(true)
  expect(completed().some(r => r.actionOutcome === ActionOutcome.committed)).toBe(false)
})
test('generic draft composition waits; cancellation and sensitive contents never enter diagnostics', async () => {
  const secret = 'private-name-path-clipboard-value'
  await act(async () => root.render(<PendingEditContext.Provider value={editor}><DraftInput aria-label="Draft" value="" onCommit={text => editor.updateProperties([id], n => { n.name = text })} /></PendingEditContext.Provider>))
  const f = input('Draft'), before = editor.state.doc
  await act(async () => { f.focus(); f.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })) })
  await type(f, secret); await key(f, 'Enter'); expect(editor.state.doc).toBe(before)
  await act(async () => f.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
  await key(f, 'Escape'); expect(editor.state.doc).toBe(before)
  const rows = completed(); expect(rows.some(r => r.inputPhase === InputPhase.compositionStart)).toBe(true)
  expect(JSON.stringify(rows)).not.toContain(secret)
  expect(rows.every(r => Object.values(r).every(v => v === undefined || typeof v === 'number'))).toBe(true)
})
test('mixed input commits all selected targets atomically, invalid draft stays uncommitted', async () => {
  const second = node('rectangle', 200, 0, 50, 50); editor.change('fixture', d => { d.nodes[second.id] = second; d.pages[0].children.push(second.id) }); editor.select([id, second.id])
  const ids = [...editor.state.selection]
  await act(async () => root.render(<PendingEditContext.Provider value={editor}><MixedNumberField label="W" value={undefined} bases={[100, 50]} min={.01} max={500} onChange={value => editor.updateProperties(ids, n => resizeNodeDimension(n, 'width', value, editor.state.doc))} /></PendingEditContext.Provider>))
  await type(input('W'), '170'); await key(input('W'), 'Enter')
  expect(ids.map(id => editor.state.doc.nodes[id].width)).toEqual([170, 170])
  expect(completed().some(r => r.fieldFamily === InputFamily.mixed && r.targetCount === 2 && r.actionOutcome === ActionOutcome.committed)).toBe(true)
  await act(async () => editor.undo()); expect(ids.map(id => editor.state.doc.nodes[id].width)).toEqual([100, 50])
})
test('native color authors separately from paint alpha and layer opacity; undo restores', async () => {
  function Paint() { const s = useSyncExternalStore(editor.subscribe, editor.snapshot), n = s.doc.nodes[id]; return <PendingEditContext.Provider value={editor}><ColorInput label="Fill" value={n.fills[0].color!} onChange={color => editor.updateProperties([id], n => { n.fills[0].color = color })} /><NumberField label="不透明度 %" value={n.fills[0].opacity * 100} min={0} max={100} onChange={v => editor.updateProperties([id], n => { n.fills[0].opacity = v / 100 })} /><NumberField label="透明度 %" value={n.opacity * 100} min={0} max={100} onChange={v => editor.updateProperties([id], n => { n.opacity = v / 100 })} /></PendingEditContext.Provider> }
  await act(async () => root.render(<Paint />))
  await type(input('不透明度 %'), '25'); await key(input('不透明度 %'), 'Enter')
  expect(editor.state.doc.nodes[id].fills[0].opacity).toBe(.25); expect(editor.state.doc.nodes[id].opacity).toBe(1)
  await type(input('透明度 %'), '50'); await key(input('透明度 %'), 'Enter')
  expect(editor.state.doc.nodes[id].opacity).toBe(.5); expect(editor.state.doc.nodes[id].fills[0].opacity).toBe(.25)
  const original = editor.state.doc.nodes[id].fills[0].color
  await type(input('Fill'), '#123456'); expect(editor.state.doc.nodes[id].fills[0].color).toBe('#123456')
  expect(JSON.stringify(completed())).not.toContain('#123456')
  await act(async () => editor.undo()); expect(editor.state.doc.nodes[id].fills[0].color).toBe(original)
})
