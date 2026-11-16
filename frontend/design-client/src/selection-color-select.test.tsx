// Sketch color-row selection. jsdom + real Editor/WASM. No Electron, canvas pixels, or native Sketch GUI.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { import_sketch_json } from './generated/design-kernel/design_kernel'
import { Editor } from './engine'
import { blank, effect, node, paint, type DesignDocument, type DesignNode } from './model'
import { displayColorHex } from './color'
import { Inspector } from './Inspector'
import { Layers } from './Layers'
import { PendingEditContext } from './pending-edit-context'
import { interfacePreference } from './interface-preference'
import { selectionColorLayerIds, selectionColors } from './selection-colors'

const bootstrapDom = await vi.hoisted(async () => {
  // @ts-expect-error jsdom is a test-only runtime dependency.
  const { JSDOM } = await import('jsdom')
  const initial = new JSDOM('<!doctype html><html><body></body></html>')
  for (const name of ['window', 'document', 'navigator'])
    vi.stubGlobal(name, name === 'window' ? initial.window : initial.window[name])
  return initial
})
bootstrapDom.window.close()

let dom: JSDOM, mount: HTMLDivElement, root: Root, editor: Editor
let consoleErrors: unknown[][]
beforeEach(() => {
  consoleErrors = []
  const originalError = console.error.bind(console)
  vi.spyOn(console, 'error').mockImplementation((...args) => { consoleErrors.push(args); originalError(...args) })
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Node', 'Element', 'Event', 'MouseEvent', 'KeyboardEvent', 'localStorage'])
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name as 'document'])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  localStorage.clear()
  interfacePreference.set({ uiMode: 'sketch', locale: 'zh-CN' })
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount())
  editor?.dispose()
  interfacePreference.reset()
  dom.window.close()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  expect(consoleErrors).toEqual([])
})

const BLUE = '#2B74FF'
const importedBlue = `color(srgb ${43 / 255} ${116 / 255} 1 / 1)`

function put(doc: DesignDocument, ...nodes: DesignNode[]) {
  for (const n of nodes) doc.nodes[n.id] = n
}

function colorFacts(doc: DesignDocument) {
  return Object.fromEntries(Object.values(doc.nodes).map(n => [n.id, {
    fills: n.fills.map(p => ({ color: p.color, opacity: p.opacity, kind: p.kind, visible: p.visible, stops: p.stops.map(stop => stop.color) })),
    strokes: n.strokes.map(s => ({ color: s.paint.color, opacity: s.paint.opacity })),
    effects: n.effects.map(e => ({ color: e.color, opacity: e.opacity, kind: e.kind })),
    textRuns: n.textRuns?.map(run => run.color),
    opacity: n.opacity, visible: n.visible, locked: n.locked,
  }]))
}

function fixture() {
  const doc = blank('117'), frame = node('frame', 0, 0, 400, 300)
  frame.name = '117'; frame.fills = [paint('#ffffff')]
  const solid = node('rectangle', 10, 10, 40, 20); solid.name = '实色'; solid.fills = [paint(BLUE)]
  const faded = node('rectangle', 60, 10, 40, 20); faded.name = '半透明'; faded.fills = [paint(BLUE)]; faded.fills[0].opacity = 0.4
  const other = node('rectangle', 110, 10, 40, 20); other.name = '其他颜色'; other.fills = [paint('#ff0000')]
  const gradient = node('rectangle', 160, 10, 40, 20); gradient.name = '渐变'
  gradient.fills = [{ ...paint(BLUE), kind: 'linear', stops: [{ offset: 0, color: BLUE }, { offset: 1, color: '#00ff00' }] }]
  const otherGradient = node('rectangle', 210, 10, 40, 20); otherGradient.name = '其他渐变'
  otherGradient.fills = [{ ...paint(), kind: 'linear', stops: [{ offset: 0, color: '#112233' }, { offset: 1, color: '#445566' }] }]
  const hidden = node('rectangle', 10, 50, 40, 20); hidden.name = '隐藏'; hidden.fills = [paint(BLUE)]; hidden.visible = false
  const locked = node('rectangle', 60, 50, 40, 20); locked.name = '锁定'; locked.fills = [paint(BLUE)]; locked.locked = true
  const hiddenGroup = node('group', 110, 50, 40, 20); hiddenGroup.name = '隐藏编组'; hiddenGroup.visible = false
  const hiddenChild = node('rectangle', 0, 0, 20, 10); hiddenChild.name = '隐藏编组内'; hiddenChild.fills = [paint(BLUE)]
  hiddenGroup.children = [hiddenChild.id]
  const shadow = node('rectangle', 160, 50, 40, 20); shadow.name = '阴影'
  shadow.fills = [paint('#111111')]; const shade = effect('shadow'); shade.color = BLUE; shadow.effects = [shade]
  const imported = node('rectangle', 210, 50, 40, 20); imported.name = '导入不透明度'
  imported.fills = [paint('#000000')]; imported.fills[0].color = importedBlue; imported.fills[0].opacity = 0.4
  const outside = node('rectangle', 500, 10, 40, 20); outside.name = '画框外'; outside.fills = [paint(BLUE)]
  frame.children = [solid.id, faded.id, other.id, gradient.id, otherGradient.id, hidden.id, locked.id, hiddenGroup.id, shadow.id, imported.id]
  put(doc, frame, solid, faded, other, gradient, otherGradient, hidden, locked, hiddenGroup, hiddenChild, shadow, imported, outside)
  doc.pages[0].children = [frame.id, outside.id]
  editor = new Editor(doc)
  editor.select([frame.id])
  return { frame, solid, faded, other, gradient, otherGradient, hidden, locked, hiddenGroup, hiddenChild, shadow, imported, outside }
}

async function render() {
  await act(async () => root.render(<PendingEditContext.Provider value={editor}><Layers editor={editor} /><Inspector editor={editor} /></PendingEditContext.Provider>))
}
function colorRow(color: string) {
  return [...mount.querySelectorAll<HTMLElement>('.selection-color-row')].find(row => row.dataset.selectionColor === color)
}
function selectButton(row: HTMLElement) {
  const button = [...row.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === '选择使用此颜色的图层')
  expect(button, 'missing select-layers button').toBeTruthy()
  return button!
}
async function click(button: HTMLElement) {
  await act(async () => { button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })) })
}
function treeSelected() {
  return [...mount.querySelectorAll<HTMLElement>('[role="treeitem"]')].filter(row => row.getAttribute('aria-selected') === 'true').map(row => row.dataset.layerId)
}

test('sketch color row selects referenced layers without rewriting color or history', async () => {
  expect(displayColorHex(importedBlue)).toBe(BLUE)
  const layers = fixture()
  const authored = editor.state.doc
  const blue = selectionColors(authored, [layers.frame.id]).find(group => group.color === BLUE)!
  const importedGroup = selectionColors(authored, [layers.frame.id]).find(group => group.color === importedBlue)!
  const expected = [layers.solid.id, layers.faded.id, layers.gradient.id, layers.hidden.id, layers.locked.id, layers.hiddenChild.id, layers.shadow.id]
  expect(selectionColorLayerIds(blue)).toEqual(expected)
  expect(selectionColorLayerIds(importedGroup)).toEqual([layers.imported.id])
  expect(blue.uses).toHaveLength(7)
  const beforeColors = JSON.stringify(colorFacts(authored))
  const version = editor.state.version
  await render()

  const row = colorRow(BLUE)
  expect(row, 'missing #2B74FF row').toBeTruthy()
  expect(row!.textContent).toContain('7 处')
  expect(row!.querySelector('input[type="color"]')).not.toBeNull()
  expect(row!.querySelector('button[title="从画布取样"]')).not.toBeNull()
  expect(mount.querySelector('aside.inspector')?.getAttribute('data-geometry-mode')).toBe('sketch')
  expect(treeSelected()).toEqual([layers.frame.id])

  await click(selectButton(colorRow(importedBlue)!))
  expect(editor.state.selection).toEqual([layers.imported.id])
  expect(editor.state.doc).toBe(authored)
  expect(editor.state.version).toBe(version)
  expect(editor.canUndo).toBe(false)
  expect(editor.canRedo).toBe(false)
  expect(authored.nodes[layers.imported.id].fills[0].opacity).toBe(0.4)
  expect(treeSelected()).toEqual([layers.imported.id])

  await act(async () => { editor.select([layers.frame.id]) })
  await click(selectButton(colorRow(BLUE)!))
  expect(editor.state.selection).toEqual(expected)
  expect(editor.state.doc).toBe(authored)
  expect(editor.state.version).toBe(version)
  expect(editor.canUndo).toBe(false)
  expect(editor.canRedo).toBe(false)
  expect(JSON.stringify(colorFacts(editor.state.doc))).toBe(beforeColors)
  expect(new Set(treeSelected())).toEqual(new Set(expected))
  expect(mount.querySelector(`[data-layer-id="${layers.frame.id}"]`)?.getAttribute('aria-selected')).toBe('false')
  expect(mount.querySelector(`[data-layer-id="${layers.outside.id}"]`)?.getAttribute('aria-selected')).toBe('false')
  expect(mount.querySelector(`[data-layer-id="${layers.other.id}"]`)?.getAttribute('aria-selected')).toBe('false')
  expect(mount.querySelector(`[data-layer-id="${layers.hidden.id}"]`)?.className).toContain('hidden-layer')
  expect(mount.querySelector(`[data-layer-id="${layers.hidden.id}"]`)?.getAttribute('aria-selected')).toBe('true')
  expect(mount.querySelector(`[data-layer-id="${layers.locked.id}"]`)?.getAttribute('aria-selected')).toBe('true')
  expect(mount.querySelector(`[data-layer-id="${layers.hiddenChild.id}"]`)?.getAttribute('aria-selected')).toBe('true')
  expect(authored.nodes[layers.hidden.id].visible).toBe(false)
  expect(authored.nodes[layers.locked.id].locked).toBe(true)
  expect(authored.nodes[layers.hiddenGroup.id].visible).toBe(false)
  const inspector = mount.querySelector('aside.inspector')
  expect(inspector?.getAttribute('aria-label')).toBe('多选属性')
  expect(inspector?.getAttribute('data-geometry-mode')).toBe('sketch')
  expect(inspector?.textContent).toContain(`${expected.length} 个图层`)
  expect(mount.querySelector('input[aria-label="X"]')?.getAttribute('placeholder')).toBe('混合')
  const selectedRow = colorRow(BLUE)!
  expect(selectedRow.querySelector('input[type="color"]')).not.toBeNull()
  expect(selectedRow.querySelector('button[title="从画布取样"]')).not.toBeNull()
  expect(selectedRow.querySelector('button[aria-label="选择使用此颜色的图层"]')).not.toBeNull()

  await click(selectButton(selectedRow))
  expect(editor.state.selection).toEqual(expected)
  expect(editor.canUndo).toBe(false)
  expect(editor.state.doc).toBe(authored)

  await act(async () => { interfacePreference.set({ locale: 'en' }) })
  expect(colorRow(BLUE)?.querySelector('button[aria-label="Select layers using this color"]')).not.toBeNull()
  expect(colorRow(BLUE)?.querySelector('button[title="Sample from canvas"]')).not.toBeNull()
  expect(editor.state.doc).toBe(authored)
  expect(editor.state.selection).toEqual(expected)
  await act(async () => { interfacePreference.set({ locale: 'zh-CN' }) })

  const input = colorRow(BLUE)!.querySelector<HTMLInputElement>('input[type="color"]')!
  await act(async () => {
    input.focus()
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, '#112233')
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  expect(editor.state.version).toBe(version + 1)
  expect(editor.canUndo).toBe(true)
  for (const id of expected) {
    const node = editor.state.doc.nodes[id]
    const colors = [
      ...node.fills.filter(p => p.kind === 'solid').map(p => p.color),
      ...node.fills.filter(p => p.kind !== 'solid').flatMap(p => p.stops.map(stop => stop.color)),
      ...node.effects.map(item => item.color),
    ]
    expect(colors).toContain('#112233')
  }
  expect(editor.state.doc.nodes[layers.faded.id].fills[0].opacity).toBe(0.4)
  expect(editor.state.doc.nodes[layers.shadow.id].fills[0].color).toBe('#111111')
  expect(editor.state.doc.nodes[layers.shadow.id].effects[0].opacity).toBe(authored.nodes[layers.shadow.id].effects[0].opacity)
  expect(editor.state.doc.nodes[layers.hidden.id].visible).toBe(false)
  expect(editor.state.doc.nodes[layers.locked.id].locked).toBe(true)
  expect(editor.state.doc.nodes[layers.gradient.id].fills[0].kind).toBe('linear')
  expect(editor.state.doc.nodes[layers.gradient.id].fills[0].stops[1].color).toBe('#00ff00')
  expect(editor.state.doc.nodes[layers.imported.id].fills[0].color).toBe(importedBlue)
  expect(editor.state.doc.nodes[layers.other.id].fills[0].color).toBe('#ff0000')
  await act(async () => { editor.undo() })
  expect(editor.state.doc).toBe(authored)
  expect(editor.canUndo).toBe(false)
  expect(editor.state.selection).toEqual(expected)
  expect(JSON.stringify(colorFacts(editor.state.doc))).toBe(beforeColors)
})

const sketch117 = (() => {
  try {
    const bytes = readFileSync(new URL('../../../testing/fixtures/user-regression-20261109/117.sketch', import.meta.url))
    return bytes.subarray(0, 2).toString() === 'PK' ? new Uint8Array(bytes) : null
  } catch {
    return null
  }
})()

test('imported 117 artboard selects each #2B74FF entry without a history entry', async (ctx) => {
  if (!sketch117) ctx.skip('117.sketch is not a zip in this checkout (Git LFS pointer); the synthetic fixture above still ran')
  const opened = JSON.parse(import_sketch_json(sketch117!)).document
  editor = new Editor(opened)
  const artboard = Object.values(editor.state.doc.nodes).find(n => n.name === '117' && n.kind === 'frame')
  expect(artboard, 'artboard 117').toBeTruthy()
  editor.select([artboard!.id])
  const groups = selectionColors(editor.state.doc, [artboard!.id]).filter(group => displayColorHex(group.color) === '#2B74FF')
  expect(groups.length).toBeGreaterThan(1)
  const authored = editor.state.doc
  const version = editor.state.version
  await render()
  const parents = editor.parentMap()
  const underArtboard = (id: string) => {
    for (let parent = parents.get(id); parent; parent = parents.get(parent)) if (parent === artboard!.id) return true
    return false
  }
  const colors = new Set<string>()
  for (const group of groups) {
    const ids = selectionColorLayerIds(group)
    expect(ids.length).toBeGreaterThan(0)
    expect(colors.has(group.color), group.color).toBe(false)
    colors.add(group.color)
    expect(ids).not.toContain(artboard!.id)
    for (const id of ids) expect(underArtboard(id)).toBe(true)
    const row = colorRow(group.color)
    expect(row, group.color).toBeTruthy()
    expect(row!.textContent).toContain(`${group.uses.length} 处`)
    expect(row!.querySelector('input')).not.toBeNull()
    expect(row!.querySelector('button[title="从画布取样"]')).not.toBeNull()
    await click(selectButton(row!))
    expect(editor.state.selection).toEqual(ids)
    expect(editor.state.doc).toBe(authored)
    expect(editor.state.version).toBe(version)
    expect(editor.canUndo).toBe(false)
    const mounted = [...mount.querySelectorAll<HTMLElement>('[role="treeitem"]')]
    expect(mounted.length).toBeGreaterThan(0)
    for (const item of mounted) expect(item.getAttribute('aria-selected') === 'true').toBe(editor.state.selection.includes(item.dataset.layerId!))
    expect(mounted.some(item => item.getAttribute('aria-selected') === 'true')).toBe(true)
    if (ids.length > 1) {
      const inspector = mount.querySelector('aside.inspector')
      expect(inspector?.getAttribute('aria-label')).toBe('多选属性')
      expect(inspector?.getAttribute('data-geometry-mode')).toBe('sketch')
      expect(inspector?.textContent).toContain(`${ids.length} 个图层`)
      expect(mount.querySelector('input[aria-label="X"]')?.getAttribute('placeholder')).toBe('混合')
    }
    await act(async () => { editor.select([artboard!.id]) })
  }
})
