import { afterEach, expect, test } from 'vitest'
import { Editor } from './engine'
import { blank, node, uid } from './model'
import { SpatialIndex, scene } from './geometry'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach(editor => editor.dispose()))
function fixture() {
  const doc = blank(), a = node('rectangle', 20, 30, 80, 60), b = node('ellipse', 180, 30, 80, 60)
  doc.nodes = { [a.id]: a, [b.id]: b }; doc.pages[0].children = [a.id, b.id]
  const editor = new Editor(doc); editors.push(editor)
  const snapshot = { document: editor.state.doc, pageId: editor.state.page }
  const index = new SpatialIndex(scene(snapshot.document, snapshot.pageId))
  return { editor, a, b, snapshot, index, point: { x: 60, y: 60 } }
}

test('a pending move picks the visible snapshot instead of an invisible current position', () => {
  const { editor, a, snapshot, index, point } = fixture()
  editor.update([a.id], { transform: [1, 0, 0, 1, 320, 30] }, 'Move before next frame')
  expect(editor.hit(point)).toBeNull()
  expect(editor.hit(point, false, index, 1, snapshot)).toBe(a.id)
  expect(editor.hit({ x: 350, y: 60 }, false, index, 1, snapshot)).toBeNull()
  expect(snapshot.document.nodes[a.id].transform[4]).toBe(20)
})

test('a presented snapshot never revives a currently removed or hidden target', () => {
  const { editor, a, snapshot, index, point } = fixture()
  editor.update([a.id], { visible: false }, 'Hide')
  expect(editor.hit(point, true, index, 1, snapshot)).toBeNull()
  editor.undo(); editor.select([a.id]); editor.remove()
  expect(editor.hit(point, true, index, 1, snapshot)).toBeNull()
})

test('current lock and page ownership still apply to visible pixels', () => {
  const { editor, a, snapshot, index, point } = fixture()
  editor.update([a.id], { locked: true }, 'Lock')
  expect(editor.hit(point, true, index, 1, snapshot)).toBeNull()
  editor.undo()
  const page = { ...editor.state.doc.pages[0], id: uid(), children: [] }
  editor.change('Other page', doc => { doc.pages.push(page) })
  editor.switchPage(page.id)
  expect(editor.hit(point, false, index, 1, snapshot)).toBeNull()
  editor.load(blank())
  expect(editor.hit(point, false, index, 1, snapshot)).toBeNull()
})

test('displayed picking preserves the mask/clip and entered hierarchy contract', () => {
  const doc = blank(), frame = node('frame', 50, 60, 90, 90), shape = node('rectangle', 60, 15, 60, 40)
  frame.clip = true; frame.children = [shape.id]; doc.nodes = { [frame.id]: frame, [shape.id]: shape }; doc.pages[0].children = [frame.id]
  const editor = new Editor(doc); editors.push(editor)
  const snapshot = { document: editor.state.doc, pageId: editor.state.page }, index = new SpatialIndex(scene(snapshot.document, snapshot.pageId))
  editor.update([frame.id], { transform: [1, 0, 0, 1, 300, 60] }, 'Move frame')
  expect(editor.hit({ x: 160, y: 90 }, true, index, 1, snapshot)).toBeNull()
  expect(editor.hit({ x: 120, y: 90 }, false, index, 1, snapshot)).toBe(shape.id)
  editor.select([frame.id])
  expect(editor.selectDeeper({ x: 120, y: 90 }, index, 1, snapshot)).toEqual({ id: shape.id, changed: true })
})

test('cached clip transforms follow immutable edits and undo, while exclusions remain per point', () => {
  const doc = blank(), frame = node('frame', 50, 60, 90, 90), shape = node('rectangle', 60, 15, 60, 40)
  frame.clip = true; frame.children = [shape.id]; doc.nodes = { [frame.id]: frame, [shape.id]: shape }; doc.pages[0].children = [frame.id]
  const editor = new Editor(doc); editors.push(editor)
  const pick = (x: number) => editor.hit({ x, y: 90 }, true)
  expect(pick(120)).toBe(shape.id)
  expect(pick(160)).toBeNull()
  expect(pick(120)).toBe(shape.id)
  editor.update([frame.id], { transform: [1, 0, 0, 1, 300, 60] }, 'Move clipped parent')
  expect(pick(120)).toBeNull()
  expect(pick(370)).toBe(shape.id)
  expect(pick(410)).toBeNull()
  editor.undo()
  expect(pick(120)).toBe(shape.id)
  expect(pick(370)).toBeNull()
})
