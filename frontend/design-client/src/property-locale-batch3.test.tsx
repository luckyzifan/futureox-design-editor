// Third-batch regression gate: mounted locale and numeric-semantic invariants.
// Real Editor/WASM + mounted React; no native GUI/physical layout acceptance.
// @ts-expect-error jsdom runtime dependency
import { JSDOM } from 'jsdom'
import React, { act, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Inspector } from './Inspector'
import { LayoutPanel } from './LayoutPanel'
import { TextStylePanel } from './TextStylePanel'
import { MultiSelectionInspector } from './MultiSelectionInspector'
import { AlignmentControls } from './AlignmentControls'
import { Editor } from './engine'
import { blank, defaultLayout, defaultTextStyle, node } from './model'
import { interfacePreference } from './interface-preference'
import { PendingEditContext } from './pending-edit-context'
import { NumberField } from './fields'
import { InputFamily, InputPhase } from './input-diagnostics'
import { canvasActions, ActionOutcome } from './canvas-action-diagnostics'
import { useInterfacePreferences } from './interface-preference'
import { hasPendingEdits } from './pending-edits'

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
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'CompositionEvent', 'localStorage']) vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key])
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
function Panel({ kind }: { kind: 'inspector' | 'layout' | 'text' | 'multi' | 'alignment' }) {
  const state = useSyncExternalStore(editor.subscribe, editor.panelSnapshot)
  const n = state.doc.nodes[ids[0]]
  return <PendingEditContext.Provider value={editor}>{kind === 'inspector' ? <Inspector editor={editor} />
    : kind === 'layout' ? <LayoutPanel editor={editor} node={n} ids={ids} />
    : kind === 'text' ? <TextStylePanel editor={editor} node={n} ids={ids} />
    : kind === 'multi' ? <MultiSelectionInspector editor={editor} nodes={ids.map(id => state.doc.nodes[id])} />
    : <AlignmentControls editor={editor} />}</PendingEditContext.Provider>
}
const input = (label: string) => mount.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
const locale = (value: 'en' | 'zh-CN') => act(async () => { interfacePreference.set({ locale: value }) })
async function type(field: HTMLInputElement, value: string) {
  await act(async () => { field.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
}
const key = (field: HTMLInputElement, value: string) => act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })) })

test('single inspector keeps dirty input, focus and authored name while changing presentation', async () => {
  fixture(); await act(async () => root.render(<Panel kind="inspector" />))
  const before = editor.state.doc, field = input('旋转 °'), aside = mount.querySelector('aside')!
  await type(field, '12.')
  expect(hasPendingEdits(editor)).toBe(true)
  await locale('en')
  expect(input('Rotation °')).toBe(field); expect(document.activeElement).toBe(field); expect(field.value).toBe('12.')
  expect(mount.querySelector('aside')).toBe(aside)
  expect(aside.getAttribute('aria-label')).toBe('Properties for 用户图层 0')
  expect(editor.state.doc).toBe(before)
  await key(field, 'Escape'); expect(editor.state.doc).toBe(before)
})

for (const selectedLocale of ['zh-CN', 'en'] as const) {
  test(`layout length expressions retain their authored units and undo in ${selectedLocale}`, async () => {
    fixture('frame'); await act(async () => root.render(<Panel kind="layout" />))
    const originalField = input('项目间距')
    expect(originalField, 'The Chinese layout fixture must expose its real item-gap input').not.toBeNull()
    await locale(selectedLocale)
    const field = input(selectedLocale === 'en' ? 'Item gap' : '项目间距'), before = editor.state.doc
    expect(field, 'Changing locale must relabel the existing item-gap input').toBe(originalField)
    await type(field, '1in'); expect(editor.state.doc).toBe(before)
    await key(field, 'Enter')
    expect(editor.state.doc.nodes[ids[0]].layout!.gap).toBe(96)
    await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before)
  })
}

test('dirty text length draft crosses locale without commit, then same unit parse and undo', async () => {
  fixture('text'); await act(async () => root.render(<Panel kind="text" />))
  const field = input('字间距'), before = editor.state.doc
  await type(field, '1pt'); await locale('en')
  expect(input('Letter spacing')).toBe(field); expect(document.activeElement).toBe(field); expect(field.value).toBe('1pt')
  expect(editor.state.doc).toBe(before)
  await key(field, 'Enter')
  expect(editor.state.doc.nodes[ids[0]].textStyle!.letterSpacing).toBeCloseTo(96 / 72, 10)
  expect(editor.state.doc.nodes[ids[0]].text).toBe('作者文字 Do not translate')
  await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before)
})

test('invalid OpenType draft stays pending while its validation message changes language', async () => {
  fixture('text'); await act(async () => root.render(<Panel kind="text" />))
  const field = input('OpenType 特性'), draft = Array.from({ length: 17 }, (_, i) => `ss${i}`).join(','), before = editor.state.doc
  await type(field, draft)
  expect(mount.querySelector('[role="alert"]')!.textContent).toBe('特性最多 16 项')
  await locale('en')
  expect(input('OpenType features')).toBe(field); expect(field.value).toBe(draft); expect(document.activeElement).toBe(field)
  expect(mount.querySelector('[role="alert"]')!.textContent).toBe('At most 16 features')
  expect(hasPendingEdits(editor)).toBe(true); expect(editor.state.doc).toBe(before)
})

test('mixed text size admits the same absolute unit after switching language and cancels safely', async () => {
  fixture('text', 2); await act(async () => root.render(<Panel kind="multi" />))
  const field = input('字号'), before = editor.state.doc
  await type(field, '1in'); await locale('en')
  expect(input('Font size')).toBe(field); expect(field.value).toBe('1in'); expect(document.activeElement).toBe(field)
  expect(mount.querySelector('aside')!.getAttribute('aria-label')).toBe('Multi-selection properties')
  expect(editor.state.doc).toBe(before)
  await key(field, 'Enter')
  for (const id of ids) expect(editor.state.doc.nodes[id].fontSize).toBe(96)
  await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before)
  const next = input('Font size'); await type(next, '1in'); await key(next, 'Escape'); expect(editor.state.doc).toEqual(before)
})

test('alignment buttons keep semantic identity and focus through locale changes', async () => {
  fixture('rectangle', 2); await act(async () => root.render(<Panel kind="alignment" />))
  const button = mount.querySelector<HTMLButtonElement>('button[aria-label="左对齐"]')!, before = editor.state.doc
  button.focus(); await locale('en')
  expect(mount.querySelector('button[aria-label="Align left"]')).toBe(button)
  expect(document.activeElement).toBe(button); expect(editor.state.doc).toBe(before)
  expect(button.disabled).toBe(false)
})


for (const family of [InputFamily.layerOpacity, InputFamily.paintOpacity]) {
  test(`opacity family ${family} remains stable when a dirty edit spans a locale change`, async () => {
    fixture()
    function OpacityField() {
      const { locale: currentLocale } = useInterfacePreferences()
      const state = useSyncExternalStore(editor.subscribe, editor.panelSnapshot)
      const n = state.doc.nodes[ids[0]], layer = family === InputFamily.layerOpacity
      const props = {
        label: currentLocale === 'en' ? (layer ? 'Opacity %' : 'Paint opacity %') : (layer ? '透明度 %' : '不透明度 %'),
        unit: 'percent' as const, diagnosticFamily: family,
        value: 100 * (layer ? n.opacity : n.fills[0].opacity), min: 0, max: 100,
        onChange: (value: number) => editor.updateProperties(ids, target => {
          if (layer) target.opacity = value / 100; else target.fills[0].opacity = value / 100
        }),
      }
      return <PendingEditContext.Provider value={editor}><NumberField {...props} /></PendingEditContext.Provider>
    }
    await act(async () => root.render(<OpacityField />))
    const field = mount.querySelector<HTMLInputElement>('input')!, before = editor.state.doc
    await type(field, '50%')
    expect(canvasActions(editor).snapshot().rows.some(row => row.fieldFamily === family)).toBe(true)
    await locale('en')
    expect(mount.querySelector('input')).toBe(field); expect(document.activeElement).toBe(field); expect(editor.state.doc).toBe(before)
    await key(field, 'Enter')
    const result = editor.state.doc.nodes[ids[0]]
    expect(family === InputFamily.layerOpacity ? result.opacity : result.fills[0].opacity).toBe(.5)
    const committedFamilies = canvasActions(editor).snapshot().rows.filter(row => row.inputPhase === InputPhase.commit && row.actionOutcome === ActionOutcome.committed).map(row => row.fieldFamily)
    expect(committedFamilies, 'A translated display label must not change the committed diagnostic family').toContain(family)
    await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before)
  })
}


test('mixed width retains supported per-node relative-expression bases across a language change', async () => {
  fixture('rectangle', 2); await act(async () => root.render(<Panel kind="multi" />))
  const field = input('W'), before = editor.state.doc
  await type(field, '+=1pt'); await locale('en')
  expect(input('W')).toBe(field); expect(field.value).toBe('+=1pt'); expect(editor.state.doc).toBe(before)
  await key(field, 'Enter')
  for (const [index, id] of ids.entries()) expect(editor.state.doc.nodes[id].width).toBeCloseTo(100 + index * 20 + 96 / 72, 10)
  await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before)
})


test('image tiling placeholders switch language without changing tile values or input identity', async () => {
  fixture()
  editor.updateProperties(ids, n => { n.fills[0].kind = 'image' })
  await act(async () => root.render(<Panel kind="inspector" />))
  const fields = [...mount.querySelectorAll<HTMLInputElement>('input[placeholder="0 = 原始尺寸"]')]
  expect(fields).toHaveLength(2)
  const before = editor.state.doc
  fields[0].focus()
  await locale('en')
  expect([...mount.querySelectorAll('input[placeholder="0 = original size"]')]).toEqual(fields)
  expect(document.activeElement).toBe(fields[0])
  expect(editor.state.doc).toBe(before)
})


test('scrubbing across locales retains the semantic history label and one undo boundary', async () => {
  fixture(); await act(async () => root.render(<Panel kind="inspector" />))
  await locale('en')
  const before = editor.state.doc
  const handle = mount.querySelector<HTMLElement>('.number-scrub[aria-label="Adjust Rotation ° by dragging"]')!
  expect(handle).not.toBeNull()
  handle.setPointerCapture = () => {}; handle.hasPointerCapture = () => false; handle.releasePointerCapture = () => {}
  const pointer = async (type: string, x: number) => act(async () => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x })
    Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } })
    handle.dispatchEvent(event)
  })
  await pointer('pointerdown', 100)
  await pointer('pointermove', 110)
  await locale('zh-CN')
  expect(mount.querySelector('.number-scrub[aria-label="拖动调整 旋转 °"]')).toBe(handle)
  expect(document.activeElement).toBe(handle)
  await pointer('pointerup', 110)
  expect(editor.state.doc).not.toBe(before)
  expect(editor.state.message).toBe('调整 旋转 °')
  await act(async () => editor.undo())
  expect(editor.state.doc).toEqual(before)
  expect(editor.state.message).toBe('撤销：调整 旋转 °')
  expect(editor.canUndo).toBe(false)
})

test('long localized numeric labels retain their full tooltip and accessible input name', async () => {
  fixture('text', 2); await act(async () => root.render(<Panel kind="multi" />))
  await locale('en')
  const mixed = input('Font size')
  expect(mixed).not.toBeNull()
  expect(mixed.closest('label')!.querySelector('span')!.title).toBe('Font size')
  await act(async () => root.render(<Panel kind="inspector" />))
  const rotation = input('Rotation °')
  expect(rotation).not.toBeNull()
  expect(rotation.closest('label')!.querySelector('span')!.title).toContain('Rotation °')
})
