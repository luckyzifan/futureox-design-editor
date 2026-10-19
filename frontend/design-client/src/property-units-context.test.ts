import { expect, test } from 'vitest'
import { blank, node, type Matrix } from './model'
import { Editor } from './engine'
import { propertyUnitReader, propertyUnits } from './property-units'
import { selectionMetric } from './selection-properties'

test.each<Matrix>([[2, 0, 0, 2, 10, 20], [0, -2, -2, 0, 30, 40], [1.2, .3, -.1, 2.5, 40, 50]])('scoped units preserve exact inherited scale values for %j', (...matrix) => {
  const doc = blank(), parent = node('group'), child = node('rectangle', 10, 20, 30, 40)
  parent.transform = matrix as Matrix; child.transform = [.7, .4, -.2, 1.4, 10, 20]
  parent.children = [child.id]; doc.nodes = { [parent.id]: parent, [child.id]: child }; doc.pages[0].children = [parent.id]
  const read = propertyUnitReader(doc), direct = propertyUnits(doc, child.id), first = read(child.id)
  expect(first).toEqual(direct); expect(read(child.id)).toBe(first)
  for (const metric of ['x', 'y', 'width', 'height', 'rotation', 'opacity'] as const)
    expect(Object.is(selectionMetric(child, metric, doc, first), selectionMetric(child, metric, doc))).toBe(true)
})

test('default reads and fresh scopes observe in-place topology/transform edits without a global document cache', () => {
  const doc = blank(), a = node('group'), b = node('group'), child = node('rectangle')
  a.transform = [2, 0, 0, 2, 0, 0]; b.transform = [3, 0, 0, 3, 0, 0]
  a.children = [child.id]; doc.nodes = { [a.id]: a, [b.id]: b, [child.id]: child }; doc.pages[0].children = [a.id, b.id]
  expect(propertyUnitReader(doc)(child.id).style).toBe(2)
  a.children = []; b.children = [child.id]
  expect(propertyUnits(doc, child.id).style).toBe(3)
  expect(propertyUnitReader(doc)(child.id).style).toBe(3)
  b.transform[0] = b.transform[3] = 4
  expect(propertyUnits(doc, child.id).style).toBe(4)
  expect(propertyUnitReader(doc)(child.id).style).toBe(4)
})

test('published snapshot scopes stay isolated through parent edits, undo, and redo', () => {
  const doc = blank(), parent = node('group'), child = node('rectangle')
  parent.children = [child.id]; doc.nodes = { [parent.id]: parent, [child.id]: child }; doc.pages[0].children = [parent.id]
  const editor = new Editor(doc)
  try {
    const original = editor.state.doc, old = propertyUnitReader(original)
    expect(old(child.id).style).toBe(1)
    editor.updateProperties([parent.id], { transform: [3, 0, 0, 3, 0, 0] })
    expect(propertyUnitReader(editor.state.doc)(child.id).style).toBe(3)
    expect(old(child.id).style).toBe(1)
    editor.undo(); expect(propertyUnitReader(editor.state.doc)(child.id).style).toBe(1)
    editor.redo(); expect(propertyUnitReader(editor.state.doc)(child.id).style).toBe(3)
  } finally { editor.dispose() }
})
