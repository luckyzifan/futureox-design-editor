// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { interfacePreference } from './interface-preference'
import { PendingEditContext } from './pending-edit-context'
import { Editor } from './engine'
import { blank, node } from './model'
import { selectionMetric, resizeNodeDimension, resizeGestureAxes, setNodePosition } from './selection-properties'
import { selectionLocalBounds } from './canvas-view'
import { apply } from './geometry'
import { MultiSelectionInspector } from './MultiSelectionInspector'

function fixture() {
  const doc = blank(), group = node('group', 10, 20, 100, 100), child = node('rectangle', 100, 30, 200, 60), other = node('rectangle', 500, 0, 40, 40)
  group.children = [child.id]; doc.nodes = { [group.id]: group, [child.id]: child, [other.id]: other }; doc.pages[0].children = [group.id, other.id]
  return { editor: new Editor(doc), group, child, other }
}
// Initialize DOM support before React evaluates; do not suppress input errors.
const bootstrap = await vi.hoisted(async () => {
  // @ts-expect-error jsdom is a test-only runtime dependency.
  const { JSDOM } = await import('jsdom')
  const d = new JSDOM('<!doctype html><html><body></body></html>')
  for (const key of ['window', 'document', 'navigator']) vi.stubGlobal(key, key === 'window' ? d.window : d.window[key])
  return d
})
bootstrap.window.close()
async function editMountedField(editor: Editor, label: string, value: number) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'KeyboardEvent', 'localStorage'])
    vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {})
  interfacePreference.reset()
  const mount = document.createElement('div'); document.body.append(mount)
  const root = createRoot(mount), errors: unknown[][] = []
  const originalError = console.error.bind(console)
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args); originalError(...args) })
  try {
    await act(async () => root.render(<PendingEditContext.Provider value={editor}><MultiSelectionInspector editor={editor} nodes={editor.state.selection.map(id => editor.state.doc.nodes[id])} /></PendingEditContext.Provider>))
    const input = mount.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
    expect(input).not.toBeNull()
    await act(async () => {
      input!.focus()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(value))
      input!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  } finally {
    await act(async () => root.unmount())
    errorSpy.mockRestore(); dom.window.close(); vi.unstubAllGlobals()
    expect(errors).toEqual([])
  }
}
function center(editor: Editor, id: string) {
  const n = editor.state.doc.nodes[id], b = selectionLocalBounds(editor.state.doc, id)
  return apply(n.transform, { x: b.x + b.width / 2, y: b.y + b.height / 2 })
}
test('offset descendants determine inspector XYWH, width anchor and native history', () => {
  const { editor, group } = fixture()
  try {
    const before = editor.state.doc, n = before.nodes[group.id]
    expect(['x', 'y', 'width', 'height'].map(f => selectionMetric(n, f as 'x' | 'y' | 'width' | 'height', before))).toEqual([110, 50, 200, 60])
    editor.updateProperties([group.id], n => resizeNodeDimension(n, 'width', 400, editor.state.doc))
    expect(selectionMetric(editor.state.doc.nodes[group.id], 'width', editor.state.doc)).toBe(400)
    expect(selectionMetric(editor.state.doc.nodes[group.id], 'x', editor.state.doc)).toBe(110)
    const after = editor.state.doc; editor.undo(); expect(editor.state.doc).toEqual(before)
    editor.redo(); expect(editor.state.doc).toEqual(after)
  } finally { editor.dispose() }
})
test('actual multi-inspector rotation preserves live group center and is one undo', async () => {
  const { editor, group, other } = fixture()
  try {
    editor.select([group.id, other.id]); const before = editor.state.doc, origin = center(editor, group.id)
    await editMountedField(editor, '旋转 °', 90)
    expect(center(editor, group.id).x).toBeCloseTo(origin.x, 10)
    expect(center(editor, group.id).y).toBeCloseTo(origin.y, 10)
    const after = editor.state.doc; editor.undo(); expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false)
    editor.redo(); expect(editor.state.doc).toEqual(after)
  } finally { editor.dispose() }
})
test('actual multi-inspector X input positions offset group visible bounds, including locked property editing', async () => {
  const { editor, group, other } = fixture()
  try {
    editor.updateProperties([group.id], { locked: true }); editor.select([group.id, other.id])
    const before = editor.state.doc
    await editMountedField(editor, 'X', 350)
    const n = editor.state.doc.nodes[group.id], b = selectionLocalBounds(editor.state.doc, group.id)
    expect(apply(n.transform, { x: b.x, y: b.y }).x).toBeCloseTo(350, 10)
    expect(n.locked).toBe(true); editor.undo(); expect(editor.state.doc).toEqual(before)
  } finally { editor.dispose() }
})

test('explicit corner/proportion axes and world-edge local axes are not guessed from size deltas', () => {
  for (const handle of [0, 1, 2, 3]) expect(resizeGestureAxes(handle, false)).toEqual(['width', 'height'])
  for (const handle of [4, 6]) expect(resizeGestureAxes(handle, false)).toEqual(['height'])
  for (const handle of [5, 7]) expect(resizeGestureAxes(handle, false)).toEqual(['width'])
  expect(resizeGestureAxes(5, true)).toEqual(['width', 'height'])
  expect(resizeGestureAxes(5, false, [0, 1, -1, 0, 0, 0])).toEqual(['height'])
  expect(resizeGestureAxes(4, false, [0, 1, -1, 0, 0, 0])).toEqual(['width'])
  expect(resizeGestureAxes(5, false, [1, 1, -1, 1, 0, 0])).toEqual(['width', 'height'])
})
test('nested group bounds exclude hidden descendants and retain mirrored local anchor on dimension edit', () => {
  const doc = blank(), outer = node('group', 0, 0, 1, 1), inner = node('group', 40, 20, 1, 1), child = node('rectangle', 100, 30, 200, 60), hidden = node('rectangle', -900, -900, 1000, 1000)
  hidden.visible = false; inner.children = [child.id, hidden.id]; outer.children = [inner.id]
  doc.nodes = Object.fromEntries([outer, inner, child, hidden].map(n => [n.id, n])); doc.pages[0].children = [outer.id]
  expect(selectionMetric(outer, 'width', doc)).toBe(200)
  outer.transform = [-2, 0, 0, 3, 800, 0]
  expect(selectionMetric(outer, 'width', doc)).toBe(400)
  const box = selectionLocalBounds(doc, outer.id), anchor = apply(outer.transform, { x: box.x, y: box.y })
  resizeNodeDimension(outer, 'width', 800, doc)
  expect(selectionMetric(outer, 'width', doc)).toBe(800)
  expect(apply(outer.transform, { x: box.x, y: box.y })).toEqual(anchor)
  setNodePosition(outer, 'x', 250, doc); expect(selectionMetric(outer, 'x', doc)).toBe(250)
})
