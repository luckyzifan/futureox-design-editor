import { expect, test } from 'vitest'
import { Editor } from './engine'
import { blank, node, defaultSizing, defaultTextStyle } from './model'
import { resizeNodeDimension, resizedNode, selectionMetric } from './selection-properties'
import { multiply } from './geometry'

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

test('canvas resize and property dimensions produce the same fixed text layout without scaling glyphs', () => {
  const source = node('text', 12, 20, 200, 40)
  source.text = 'This text should wrap when its box becomes narrow'
  source.fontSize = 20; source.textStyle = defaultTextStyle(); source.sizing = { ...defaultSizing(), width: 'hug', height: 'hug' }
  const property = structuredClone(source)
  resizeNodeDimension(property, 'width', 100)
  const canvas = { ...source, ...resizedNode(source, multiply(source.transform, [.5, 0, 0, 1, 0, 0])) }
  expect(canvas).toEqual(property)
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
