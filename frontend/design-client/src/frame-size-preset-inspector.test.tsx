// Mounted inspector and preset dialog. jsdom clicks are not the macOS Figma or Sketch apps.
// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { Editor } from './engine'
import { FramePresetPanel } from './FramePresetPanel'
import { framePresets } from './frame-presets'
import { Inspector } from './Inspector'
import { interfacePreference } from './interface-preference'
import { blank, node, type DesignNode } from './model'
import { PendingEditContext } from './pending-edit-context'

const phone = framePresets.find(preset => preset.name === 'iPhone 13 / 13 Pro')
if (!phone) throw new Error('missing iPhone 13 / 13 Pro preset')

let root: Root | undefined
let editor: Editor | undefined
beforeEach(() => {
  interfacePreference.reset()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Element.prototype.scrollTo = () => {}
  if (typeof globalThis.ResizeObserver !== 'function')
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as typeof ResizeObserver
})
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  editor?.dispose()
  editor = undefined
  document.body.innerHTML = ''
  interfacePreference.reset()
})

function color(target: DesignNode, value: string) {
  const fill = target.fills[0]
  if (fill?.kind === 'solid') fill.color = value
  return target
}
function mount(doc = blank('检查器'), selected?: string) {
  editor = new Editor(doc)
  if (selected) editor.select([selected])
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => { root!.render(<PendingEditContext.Provider value={editor!}><Inspector editor={editor!} /></PendingEditContext.Provider>) })
  return editor
}
function presetButton() { return document.querySelector<HTMLButtonElement>('button.frame-size-preset') }
function listedPreset() {
  return [...document.querySelectorAll<HTMLButtonElement>('.frame-preset-list button')].find(button => button.querySelector('span')?.textContent === 'iPhone 13 / 13 Pro')
}

test('both layouts expose the selected-frame preset entry and applying it does not create a frame', async () => {
  const doc = blank('01有料素材副本')
  const frame = node('frame', 80, 90, 1440, 1640)
  frame.name = '01_Dashboard'
  frame.clip = true
  const pinned = color(node('rectangle', 1200, 1500, 100, 80), '#111111')
  pinned.name = '贴右'
  pinned.constraints = { horizontal: 'end', vertical: 'end', referenceWidth: 1440, referenceHeight: 1640 }
  const free = color(node('rectangle', 1000, 80, 50, 50), '#777777')
  free.name = '超出'
  doc.nodes = { [frame.id]: frame, [pinned.id]: pinned, [free.id]: free }
  doc.pages[0].children = [frame.id]
  frame.children = [pinned.id, free.id]
  const current = mount(doc, frame.id)
  expect(presetButton()?.textContent).toBe('画框尺寸预设')
  expect(document.body.textContent).not.toContain('选择模板')
  await act(async () => interfacePreference.set({ uiMode: 'sketch' }))
  expect(presetButton()?.textContent).toBe('选择模板')
  expect([...document.querySelectorAll('button')].some(button => button.textContent === '画框尺寸预设')).toBe(false)
  await act(async () => presetButton()!.click())
  const dialog = document.querySelector('.frame-preset-panel')
  expect(dialog?.querySelector('strong')?.textContent).toBe('选择模板')
  expect(dialog?.textContent).toContain('不会新建画板')
  expect(dialog?.querySelector('form')).toBeNull()
  const search = document.querySelector<HTMLInputElement>('[aria-label="搜索画板预设"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'iPhone 13 / 13 Pro')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(listedPreset()).toBeDefined()
  const beforeIds = Object.keys(current.state.doc.nodes)
  await act(async () => listedPreset()!.click())
  expect(document.querySelector('.frame-preset-panel')).toBeNull()
  expect(Object.keys(current.state.doc.nodes)).toEqual(beforeIds)
  expect(current.state.selection).toEqual([frame.id])
  expect(current.state.doc.nodes[frame.id]).toMatchObject({ name: '01_Dashboard', width: 390, height: 844, clip: true })
  expect(current.state.doc.nodes[pinned.id]).toMatchObject({ width: 100, height: 80 })
  expect(current.state.doc.nodes[pinned.id].transform.slice(4)).toEqual([150, 704])
  expect(current.state.doc.nodes[pinned.id].constraints).toEqual({ horizontal: 'end', vertical: 'end', referenceWidth: 390, referenceHeight: 844 })
  expect(current.state.doc.nodes[free.id].transform.slice(4)).toEqual([1000, 80])
  expect(current.state.doc.nodes[free.id].constraints).toBeUndefined()
  const applied = current.state.doc
  await act(async () => current.undo())
  expect(current.state.doc.nodes[frame.id]).toMatchObject({ width: 1440, height: 1640 })
  expect(current.state.doc.nodes[pinned.id].transform.slice(4)).toEqual([1200, 1500])
  await act(async () => current.redo())
  expect(current.state.doc).toBe(applied)
  await act(async () => interfacePreference.set({ locale: 'en', uiMode: 'figma' }))
  expect(presetButton()?.textContent).toBe('Frame dimension presets')
  await act(async () => presetButton()!.click())
  expect(document.querySelector('.frame-preset-panel strong')?.textContent).toBe('Frame dimension presets')
  await act(async () => document.querySelector<HTMLInputElement>('.frame-preset-panel input[type="checkbox"]')!.click())
  const englishSearch = document.querySelector<HTMLInputElement>('[aria-label="Search frame presets"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(englishSearch, 'iPhone 13 / 13 Pro')
    englishSearch.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(listedPreset()?.textContent).toContain('844 × 390')
  await act(async () => listedPreset()!.click())
  expect(current.state.doc.nodes[frame.id]).toMatchObject({ name: '01_Dashboard', width: 844, height: 390, clip: true })
  expect(current.state.doc.nodes[pinned.id].transform.slice(4)).toEqual([604, 250])
  expect(Object.keys(current.state.doc.nodes)).toEqual(beforeIds)
  await act(async () => current.undo())
  expect(current.state.doc).toBe(applied)
})

test('a locked frame keeps the entry disabled, and other layers have no preset entry', async () => {
  const doc = blank('禁用')
  const frame = node('frame', 0, 0, 1440, 1640)
  frame.locked = true
  const rectangle = node('rectangle', 0, 0, 20, 20)
  doc.nodes = { [frame.id]: frame, [rectangle.id]: rectangle }
  doc.pages[0].children = [frame.id, rectangle.id]
  const current = mount(doc, frame.id)
  expect(presetButton()?.disabled).toBe(true)
  await act(async () => current.select([rectangle.id]))
  expect(presetButton()).toBeNull()
  await act(async () => current.select([frame.id, rectangle.id]))
  expect(presetButton()).toBeNull()
  const graphicDoc = blank('图形')
  graphicDoc.schemaVersion = 23
  const graphic = node('frame', 0, 0, 64, 64)
  graphic.graphic = true
  graphicDoc.nodes[graphic.id] = graphic
  graphicDoc.pages[0].children = [graphic.id]
  await act(async () => root?.unmount())
  current.dispose()
  editor = undefined
  mount(graphicDoc, graphic.id)
  expect(document.querySelector('.inspector')?.textContent).toContain('图形容器')
  expect(presetButton()).toBeNull()
})

test('opening the entry and changing selection does not resize either frame', async () => {
  const doc = blank('切换')
  const frame = node('frame', 0, 0, 1440, 1640)
  frame.name = '01_Dashboard'
  const other = node('frame', 2000, 0, 1922, 1080)
  other.name = '117'
  doc.nodes = { [frame.id]: frame, [other.id]: other }
  doc.pages[0].children = [frame.id, other.id]
  const current = mount(doc, frame.id)
  const before = current.state.doc
  await act(async () => presetButton()!.click())
  expect(document.querySelector('.frame-preset-panel')).not.toBeNull()
  await act(async () => current.select([other.id]))
  expect(document.querySelector('.frame-preset-panel')).toBeNull()
  expect(current.state.doc).toBe(before)
  expect(current.state.doc.nodes[frame.id]).toMatchObject({ width: 1440, height: 1640 })
  expect(current.state.doc.nodes[other.id]).toMatchObject({ width: 1922, height: 1080 })
})

test('the existing create panel still adds a frame when one is already selected', async () => {
  const doc = blank('新建')
  const frame = node('frame', 0, 0, 1440, 1640)
  frame.name = '01_Dashboard'
  const child = node('rectangle', 10, 10, 20, 20)
  doc.nodes = { [frame.id]: frame, [child.id]: child }
  doc.pages[0].children = [frame.id]
  frame.children = [child.id]
  const current = mount(doc, frame.id)
  const before = current.state.doc
  await act(async () => { root!.render(<PendingEditContext.Provider value={current}><Inspector editor={current} /><FramePresetPanel editor={current} onClose={() => {}} /></PendingEditContext.Provider>) })
  const search = document.querySelector<HTMLInputElement>('[aria-label="搜索画板预设"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'iPhone 13 / 13 Pro')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => listedPreset()!.click())
  const createdId = current.state.selection[0]
  expect(createdId).not.toBe(frame.id)
  expect(current.state.doc.nodes[frame.id]).toMatchObject({ name: '01_Dashboard', width: 1440, height: 1640 })
  expect(current.state.doc.nodes[child.id]).toEqual(before.nodes[child.id])
  expect(current.state.doc.nodes[createdId]).toMatchObject({ kind: 'frame', name: 'iPhone 13 / 13 Pro', width: phone.width, height: phone.height })
  expect(current.state.doc.pages[0].children).toContain(createdId)
  expect(current.state.doc.nodes[frame.id].children).toEqual([child.id])
  await act(async () => current.undo())
  expect(current.state.doc).toBe(before)
  expect(current.canUndo).toBe(false)
})
