import { afterEach, expect, test } from 'vitest'
import { Editor } from './engine'
import { geometry_json } from './generated/design-kernel/design_kernel'
import { blank, node } from './model'
import { worldMatrix } from './geometry'

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
