import { afterEach, expect, test } from 'vitest'
import { Editor } from './engine'
import { geometry_json } from './generated/design-kernel/design_kernel'
import { blank, node } from './model'
import { contours, inverse, pointInContours, worldMatrix } from './geometry'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach(editor => editor.dispose()))

function editorWithGeometry(nodes: ReturnType<typeof node>[], roots = nodes.map(item => item.id)) {
  const doc = blank('flatten')
  doc.nodes = Object.fromEntries(nodes.map(item => [item.id, item]))
  doc.pages[0].children = roots
  const editor = new Editor(doc)
  editors.push(editor)
  Object.assign(editor, {
    runGeometry: async (payload: unknown) => JSON.parse(geometry_json(JSON.stringify(payload))),
  })
  return editor
}

test('flatten unions two rectangles into one vector and undoes once', async () => {
  const a = node('rectangle', 0, 0, 40, 30), b = node('rectangle', 20, 10, 40, 30)
  a.name = 'Back'; b.name = 'Front'
  const editor = editorWithGeometry([a, b])
  editor.select([a.id, b.id])
  const before = editor.state.doc
  await editor.flattenSelection()
  const id = editor.state.selection[0], vector = editor.state.doc.nodes[id]
  expect(editor.state.doc.pages[0].children).toEqual([id])
  expect(vector.kind).toBe('vector')
  expect(vector.name).toBe('Front')
  expect(vector.network?.vertices.length).toBeGreaterThan(2)
  expect(editor.state.doc.nodes[a.id]).toBeUndefined()
  expect(editor.state.doc.nodes[b.id]).toBeUndefined()
  const box = worldMatrix(editor.state.doc, id)
  expect(box[4]).toBeCloseTo(0, 3)
  expect(box[5]).toBeCloseTo(0, 3)
  editor.undo(); expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false)
})

test('flatten bakes one boolean with its own operation into a vector', async () => {
  const a = node('rectangle', 0, 0, 80, 80), b = node('rectangle', 20, 20, 20, 20)
  const editor = editorWithGeometry([a, b])
  editor.select([a.id, b.id])
  editor.group(false, 'subtract')
  const booleanId = editor.state.selection[0]
  expect(editor.state.doc.nodes[booleanId].booleanOperation).toBe('subtract')
  const before = editor.state.doc
  await editor.flattenSelection()
  const id = editor.state.selection[0], vector = editor.state.doc.nodes[id]
  expect(vector.kind).toBe('vector')
  expect(vector.booleanOperation).toBeUndefined()
  expect(vector.children).toEqual([])
  expect(editor.state.doc.nodes[booleanId]).toBeUndefined()
  expect(editor.state.doc.nodes[a.id]).toBeUndefined()
  editor.undo(); expect(editor.state.doc).toEqual(before)
})

test('flatten unions a boolean union with another rectangle into one vector', async () => {
  const a = node('rectangle', 0, 0, 80, 50), b = node('rectangle', 40, 20, 80, 50), side = node('rectangle', 160, 0, 30, 30)
  const editor = editorWithGeometry([a, b, side])
  editor.select([a.id, b.id])
  editor.group(false, 'union')
  const booleanId = editor.state.selection[0]
  editor.select([booleanId, side.id])
  const before = editor.state.doc
  await editor.flattenSelection()
  expect(editor.state.message).not.toContain('请单独展平')
  const id = editor.state.selection[0], vector = editor.state.doc.nodes[id]
  expect(vector.kind).toBe('vector')
  expect(editor.state.doc.pages[0].children).toEqual([id])
  expect(editor.state.doc.nodes[booleanId]).toBeUndefined()
  expect(editor.state.doc.nodes[side.id]).toBeUndefined()
  const m = inverse(vector.transform)
  const local = (x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] })
  const rings = contours(vector)
  expect(pointInContours(local(20, 10), rings)).toBe(true)
  expect(pointInContours(local(60, 30), rings)).toBe(true)
  expect(pointInContours(local(170, 10), rings)).toBe(true)
  editor.undo(); expect(editor.state.doc).toEqual(before)
})

test('flatten bakes a boolean mixed with another shape and keeps the hole', async () => {
  const base = node('rectangle', 0, 0, 80, 80), hole = node('rectangle', 20, 20, 20, 20), side = node('rectangle', 100, 0, 40, 40)
  base.name = 'Base'; hole.name = 'Hole'; side.name = 'Side'
  const editor = editorWithGeometry([base, hole, side])
  editor.select([base.id, hole.id])
  editor.group(false, 'subtract')
  const booleanId = editor.state.selection[0]
  expect(editor.state.doc.nodes[booleanId].booleanOperation).toBe('subtract')
  editor.select([booleanId, side.id])
  const before = editor.state.doc
  await editor.flattenSelection()
  expect(editor.state.message).not.toContain('请单独展平')
  const id = editor.state.selection[0], vector = editor.state.doc.nodes[id]
  expect(vector.kind).toBe('vector')
  expect(vector.booleanOperation).toBeUndefined()
  expect(editor.state.doc.nodes[booleanId]).toBeUndefined()
  expect(editor.state.doc.nodes[side.id]).toBeUndefined()
  expect(editor.state.doc.pages[0].children).toEqual([id])
  const m = inverse(vector.transform)
  const local = (x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] })
  const rings = contours(vector)
  expect(pointInContours(local(10, 10), rings)).toBe(true)
  expect(pointInContours(local(30, 30), rings)).toBe(false)
  expect(pointInContours(local(110, 10), rings)).toBe(true)
  expect(pointInContours(local(90, 10), rings)).toBe(false)
  editor.undo(); expect(editor.state.doc).toEqual(before)
})

test('flatten resolves a nested boolean before unioning the rest of the selection', async () => {
  const base = node('rectangle', 0, 0, 80, 80), hole = node('rectangle', 20, 20, 20, 20), extra = node('rectangle', 0, 90, 30, 20)
  const editor = editorWithGeometry([base, hole, extra])
  editor.select([base.id, hole.id])
  editor.group(false, 'subtract')
  const inner = editor.state.selection[0]
  editor.select([inner, extra.id])
  editor.group(false, 'union')
  const outer = editor.state.selection[0]
  const side = node('rectangle', 120, 0, 20, 20)
  editor.change('side', d => { d.nodes[side.id] = side; d.pages[0].children.push(side.id) })
  editor.select([outer, side.id])
  const before = editor.state.doc
  await editor.flattenSelection()
  const vector = editor.state.doc.nodes[editor.state.selection[0]]
  expect(vector.kind).toBe('vector')
  expect(editor.state.doc.nodes[outer]).toBeUndefined()
  const m = inverse(vector.transform)
  const local = (x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] })
  const rings = contours(vector)
  expect(pointInContours(local(10, 10), rings)).toBe(true)
  expect(pointInContours(local(30, 30), rings)).toBe(false)
  expect(pointInContours(local(10, 100), rings)).toBe(true)
  expect(pointInContours(local(125, 5), rings)).toBe(true)
  editor.undo(); expect(editor.state.doc).toEqual(before)
})

test('flatten refuses text and reports an empty shape selection', async () => {
  const text = node('text', 0, 0, 40, 20)
  text.text = 'Hi'
  const editor = editorWithGeometry([text])
  editor.select([text.id])
  const before = editor.state.doc
  await editor.flattenSelection()
  expect(editor.state.doc).toBe(before)
  expect(editor.state.message).toContain('不能展平')
})
