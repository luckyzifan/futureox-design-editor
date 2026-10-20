import { expect, test } from 'vitest'
import { Editor } from './engine'
import { blank, node, defaultSizing, defaultTextStyle, defaultLayout } from './model'
import { resizeNodeDimension, resizedNode, selectionMetric } from './selection-properties'
import { multiply } from './geometry'
import { localBounds } from './canvas-view'
import { componentFixture } from './component-fixtures'

test('a group width edit changes its children in world space and survives history', () => {
  const doc = blank(), group = node('group', 10, 20, 238, 118), child = node('rectangle', 0, 0, 238, 118)
  group.children = [child.id]; doc.nodes = { [group.id]: group, [child.id]: child }; doc.pages[0].children = [group.id]
  const editor = new Editor(doc)
  try {
    const before = editor.state.doc
    editor.updateProperties([group.id], n => resizeNodeDimension(n, 'width', 476, editor.state.doc))
    expect(selectionMetric(editor.state.doc.nodes[group.id], 'width', editor.state.doc)).toBe(476)
    expect(selectionMetric(editor.state.doc.nodes[child.id], 'width', editor.state.doc)).toBe(476)
    expect(selectionMetric(editor.state.doc.nodes[child.id], 'height', editor.state.doc)).toBe(118)
    editor.undo(); expect(editor.state.doc).toEqual(before)
    editor.redo(); expect(selectionMetric(editor.state.doc.nodes[group.id], 'width', editor.state.doc)).toBe(476)
  } finally { editor.dispose() }
})

test('property width preserves text hug height without changing the legacy canvas contract', () => {
  const source = node('text', 12, 20, 200, 40)
  source.text = 'This text should wrap when its box becomes narrow'
  source.fontSize = 20; source.textStyle = defaultTextStyle(); source.sizing = { ...defaultSizing(), width: 'hug', height: 'hug' }
  const property = structuredClone(source)
  resizeNodeDimension(property, 'width', 100)
  const canvas = { ...source, ...resizedNode(source, multiply(source.transform, [.5, 0, 0, 1, 0, 0])) }
  expect(canvas).toEqual({ ...property, sizing: { ...property.sizing, height: 'fixed' } })
  expect(property.sizing).toMatchObject({ width: 'fixed', height: 'hug' })
  expect(canvas.transform).toEqual(source.transform)
  expect(canvas.fontSize).toBe(20)
  expect(canvas.textStyle?.wrap).toBe(true)
  expect(canvas.sizing).toMatchObject({ width: 'fixed', height: 'fixed' })
  expect(canvas.width).toBe(100)
  expect(source.sizing.width).toBe('hug')
})

test('group dimensions use displayed units under scaled parents', () => {
  const doc = blank(), frame = node('frame', 0, 0, 1000, 1000), group = node('group', 10, 20, 100, 50)
  frame.transform = [2, 0, 0, 2, 0, 0]; frame.children = [group.id]
  doc.nodes = { [frame.id]: frame, [group.id]: group }; doc.pages[0].children = [frame.id]
  group.constrainProportions = true
  resizeNodeDimension(group, 'width', 300, doc)
  expect(selectionMetric(group, 'width', doc)).toBe(300)
  expect(selectionMetric(group, 'height', doc)).toBe(150)
  expect(group.transform.slice(4)).toEqual([10, 20])
})

for (const axis of ['width', 'height'] as const) for (const otherMode of ['hug', 'fill'] as const) {
  test(`${axis}-only property edits preserve the other ${otherMode} sizing axis`, () => {
    const n = node('frame', 0, 0, 100, 80)
    n.sizing = { ...defaultSizing(), width: otherMode, height: otherMode }
    resizeNodeDimension(n, axis, 160)
    const other = axis === 'width' ? 'height' : 'width'
    expect(n.sizing[axis]).toBe('fixed')
    expect(n.sizing[other]).toBe(otherMode)
    expect(n[other]).toBe(other === 'height' ? 80 : 100)
  })
}

test('canvas callers retain their existing dual-axis semantics, without guessing intent from matrices', () => {
  const n = node('frame', 10, 20, 100, 80)
  n.sizing = { ...defaultSizing(), width: 'hug', height: 'fill' }
  for (const [sx, sy] of [[2, 1], [1, 2], [2, 2], [1, 1], [2, 1 + 1e-12]]) {
    expect(resizedNode(n, multiply(n.transform, [sx, 0, 0, sy, 0, 0])).sizing).toMatchObject({ width: 'fixed', height: 'fixed' })
  }
})

test('explicit same-value property writes fix the authored axis only', () => {
  for (const axis of ['width', 'height'] as const) {
    const n = node('frame', 0, 0, 100, 80)
    n.sizing = { ...defaultSizing(), width: 'hug', height: 'fill' }
    resizeNodeDimension(n, axis, n[axis])
    expect(n.sizing).toMatchObject(axis === 'width' ? { width: 'fixed', height: 'fill' } : { width: 'hug', height: 'fixed' })
  }
})

test('proportional property resize intentionally fixes both affected axes', () => {
  const n = node('frame', 0, 0, 100, 80)
  n.sizing = { ...defaultSizing(), width: 'hug', height: 'fill' }; n.constrainProportions = true
  resizeNodeDimension(n, 'width', 200)
  expect(n.sizing).toMatchObject({ width: 'fixed', height: 'fixed' })
  expect(n.height).toBe(160)
})

for (const mode of ['hug', 'fill'] as const) test(`blank document nested auto-layout keeps ${mode} height on committed width and history`, () => {
  const doc = blank(), parent = node('frame', 0, 0, 400, 100), child = node('frame', 0, 0, 80, 40), content = node('rectangle', 0, 0, 80, 40), sibling = node('rectangle', 0, 0, 50, 40)
  parent.layout = { ...defaultLayout(), gap: 10, padding: [10, 10, 10, 10] }
  parent.sizing = { ...defaultSizing(), width: 'hug', height: mode === 'fill' ? 'fixed' : 'hug' }
  child.layout = { ...defaultLayout(), padding: [0, 0, 0, 0] }
  child.sizing = { ...defaultSizing(), width: 'hug', height: mode }
  parent.children = [child.id, sibling.id]; child.children = [content.id]
  doc.nodes = { [parent.id]: parent, [child.id]: child, [content.id]: content, [sibling.id]: sibling }; doc.pages[0].children = [parent.id]
  const e = new Editor(doc)
  try {
    e.select([child.id]); const before = e.state.doc
    e.updateProperties([child.id], n => resizeNodeDimension(n, 'width', 140, e.state.doc))
    const after = e.state.doc, resolved = after.nodes[child.id]
    expect(resolved.sizing).toMatchObject({ width: 'fixed', height: mode })
    expect(after.nodes[sibling.id].transform[4]).toBe(160)
    expect(after.nodes[parent.id].width).toBe(220)
    expect(selectionMetric(resolved, 'width', after)).toBe(140)
    expect(localBounds(resolved).width).toBe(140)
    expect(e.selectionBounds().width).toBe(140)
    expect(e.state.selection).toEqual([child.id])
    e.undo(); expect(e.state.doc).toEqual(before)
    e.redo(); expect(e.state.doc).toEqual(after)
  } finally { e.dispose() }
})

test('instance width override preserves hug height, other instances, master and history', () => {
  const { doc, ids } = componentFixture(), e = new Editor(doc)
  try {
    e.select([ids.a]); const before = e.state.doc
    const width = before.nodes[ids.a].width + 80
    e.updateProperties([ids.a], n => resizeNodeDimension(n, 'width', width, e.state.doc))
    const after = e.state.doc
    expect(after.nodes[ids.a].sizing).toMatchObject({ width: 'fixed', height: 'hug' })
    expect(after.nodes[ids.a].width).toBe(width)
    expect(e.selectionBounds().width).toBe(width)
    expect(after.nodes[ids.b]).toEqual(before.nodes[ids.b])
    expect(after.nodes[ids.button]).toEqual(before.nodes[ids.button])
    e.undo(); expect(e.state.doc).toEqual(before)
    e.redo(); expect(e.state.doc).toEqual(after)
  } finally { e.dispose() }
})
