import { expect, test } from 'vitest'
import { blank, node, type DesignDocument } from './model'
import { Editor } from './engine'
import { layerDropPlan, layerDropPosition, orderedLayerRoots } from './layer-drop'
import { worldMatrix } from './geometry'
import { commonValue, resizeNodeDimension, selectionMetric } from './selection-properties'

function fixture() {
  const doc = blank(), a = node('rectangle', 5, 7, 20, 20), b = node('rectangle', 35, 7, 20, 20), c = node('rectangle', 65, 7, 20, 20), frame = node('frame', 100, 100, 200, 200)
  doc.nodes = { [a.id]: a, [b.id]: b, [c.id]: c, [frame.id]: frame }; doc.pages[0].children = [a.id, b.id, c.id, frame.id]
  return { doc, a, b, c, frame, page: doc.pages[0].id }
}
const display = (doc: DesignDocument) => [...doc.pages[0].children].reverse()

test('above/below/inside use visible row geometry and reversed painter order', () => {
  const f = fixture(), editor = new Editor(f.doc)
  const move = (target: string, position: 'above' | 'below' | 'inside') => {
    const plan = layerDropPlan(editor.state.doc, f.page, [f.a.id], target, position)!
    editor.reparentMany([f.a.id], plan.parent, plan.before)
  }
  expect(layerDropPosition(true, .1)).toBe('above')
  expect(layerDropPosition(true, .5)).toBe('inside')
  expect(layerDropPosition(true, .9)).toBe('below')
  expect(layerDropPosition(false, .49)).toBe('above')
  expect(layerDropPosition(false, .51)).toBe('below')
  move(f.c.id, 'above'); expect(display(editor.state.doc)).toEqual([f.frame.id, f.a.id, f.c.id, f.b.id])
  editor.undo(); expect(display(editor.state.doc)).toEqual(display(f.doc))
  move(f.frame.id, 'below'); expect(editor.state.doc.nodes[f.frame.id].children).toEqual([])
  expect(display(editor.state.doc)).toEqual([f.frame.id, f.a.id, f.c.id, f.b.id])
  editor.undo(); const matrix = worldMatrix(editor.state.doc, f.a.id)
  move(f.frame.id, 'inside'); expect(editor.state.doc.nodes[f.frame.id].children).toEqual([f.a.id])
  expect(worldMatrix(editor.state.doc, f.a.id)).toEqual(matrix)
  editor.undo(); expect(display(editor.state.doc)).toEqual(display(f.doc))
  editor.dispose()
})

test('multi-drag order is independent of click sequence and root drop can exit a frame', () => {
  const f = fixture(), editor = new Editor(f.doc), ordered = orderedLayerRoots(f.doc, f.page, [f.c.id, f.b.id])
  expect(ordered).toEqual([f.b.id, f.c.id])
  const plan = layerDropPlan(f.doc, f.page, ordered, f.a.id, 'below')!
  editor.reparentMany(ordered, plan.parent, plan.before)
  expect(display(editor.state.doc)).toEqual([f.frame.id, f.a.id, f.c.id, f.b.id])
  editor.undo(); editor.reparentMany([f.a.id], f.frame.id)
  const root = layerDropPlan(editor.state.doc, f.page, [f.a.id], null, 'below')!
  editor.reparentMany([f.a.id], root.parent, root.before)
  expect(editor.state.doc.nodes[f.frame.id].children).toEqual([])
  expect(display(editor.state.doc)).toEqual(display(f.doc))
  editor.dispose()
})

test('drop plans reject self, descendant and locked ancestor destinations', () => {
  const f = fixture(); f.frame.children = [f.a.id]; f.doc.pages[0].children = [f.b.id, f.c.id, f.frame.id]
  expect(layerDropPlan(f.doc, f.page, [f.frame.id], f.a.id, 'above')).toBeUndefined()
  expect(layerDropPlan(f.doc, f.page, [f.frame.id], f.frame.id, 'inside')).toBeUndefined()
  f.frame.locked = true
  expect(layerDropPlan(f.doc, f.page, [f.b.id], f.a.id, 'below')).toBeUndefined()
})

test('explicit property edits retain locks, mixed selection and one undo; default updates stay protected', () => {
  const f = fixture(); f.a.locked = true
  const editor = new Editor(f.doc), before = editor.state.doc
  editor.update([f.a.id], { width: 77 }, '修改属性')
  expect(editor.state.doc).toBe(before)
  editor.updateProperties([f.a.id, f.b.id], { width: 137.125 }, '修改属性')
  expect([f.a.id, f.b.id].map(id => editor.state.doc.nodes[id].width)).toEqual([137.125, 137.125])
  expect(editor.state.doc.nodes[f.a.id].locked).toBe(true)
  editor.undo(); expect([f.a.id, f.b.id].map(id => editor.state.doc.nodes[id].width)).toEqual([20, 20])
  editor.select([f.a.id]); expect(editor.topSelection()).toEqual([])
  editor.dispose()
})

test('equal explicit dimensions do not inherit different old-size rounding', () => {
  const a = node('rectangle', 0, 0, 80, 110), b = node('rectangle', 30, 0, 110, 80)
  for (const n of [a, b]) {
    resizeNodeDimension(n, 'width', 111.0625)
    resizeNodeDimension(n, 'height', 137.125)
  }
  expect([a.width, b.width]).toEqual([111.0625, 111.0625])
  expect(commonValue([a, b].map(n => selectionMetric(n, 'width')))).toBe(111.0625)
  expect([a.height, b.height]).toEqual([137.125, 137.125])
  b.transform = [2, 0, 0, 4, 30, 0]
  resizeNodeDimension(b, 'width', 111.0625); resizeNodeDimension(b, 'height', 137.125)
  expect(selectionMetric(b, 'width')).toBe(111.0625)
  expect(selectionMetric(b, 'height')).toBe(137.125)
})
