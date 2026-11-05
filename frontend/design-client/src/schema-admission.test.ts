import { expect, test } from 'vitest'
import { Editor } from './engine'
import { blank, effect, node, validateDocument, type DesignNode } from './model'

test.each([
  ['paint transform', 4, (n: DesignNode) => { n.fills[0].transform = [1, 0, 0, 1, 0, 0] }],
  ['glass', 5, (n: DesignNode) => { n.effects = [effect('glass')] }],
  ['texture', 5, (n: DesignNode) => { n.effects = [effect('texture')] }],
] as const)('legacy admission sees newly authored %s and preserves history', (_name, version, mutate) => {
  const doc = blank(), shape = node('rectangle', 0, 0, 30, 30)
  doc.schemaVersion = 2; doc.nodes[shape.id] = shape; doc.pages[0].children = [shape.id]
  const editor = new Editor(doc)
  try {
    const before = editor.state.doc
    const result = editor.change('Author feature', draft => { mutate(draft.nodes[shape.id]) })
    expect(result?.status).toBe('committed')
    const after = editor.state.doc
    expect(after.schemaVersion).toBe(version)
    expect(before.nodes[shape.id]).toEqual(shape)
    editor.undo(); expect(editor.state.doc).toBe(before)
    editor.redo(); expect(editor.state.doc).toBe(after)
  } finally { editor.dispose() }
})

test('filled faces require schema 10 and edges belonging to that same network', () => {
  const doc = blank(), vector = node('vector', 0, 0, 30, 30)
  const edge = { id: 'edge', from: 'a', to: 'b' }
  vector.network = { vertices: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 8, y: 0 }],
    edges: [edge], fillRule: 'nonzero', filledFaces: [[edge.id]] }
  doc.nodes[vector.id] = vector
  doc.pages[0].children = [vector.id]
  doc.schemaVersion = 10
  expect(validateDocument(doc)).toBe(doc)
  vector.network.filledFaces = [['missing']]
  expect(() => validateDocument(doc)).toThrow('矢量区域填充数据无效')
  vector.network.filledFaces = [[edge.id]]
  doc.schemaVersion = 9
  expect(() => validateDocument(doc)).toThrow()
})


test.each([['v','e'],['','']])('dense network %s/%s rechecks the current IDs and coordinates', (v, e) => {
  const doc = blank(), vector = node('vector'), edge = { id: e+'0', from: v+'0', to: v+'1' }
  const network = { vertices: [{ id: v+'0', x: 0, y: 0 }, { id: v+'1', x: 4, y: 2 }],
    edges: [edge], filledFaces: [[edge.id]], fillRule: 'nonzero' as const }
  doc.schemaVersion = 10
  vector.network = network
  doc.nodes[vector.id] = vector
  doc.pages[0].children.push(vector.id)
  expect(validateDocument(doc)).toBe(doc)
  edge.to = v+'2'
  expect(() => validateDocument(doc)).toThrow('矢量网络引用无效')
  edge.to = v+'1'
  network.filledFaces[0][0] = e+'1'
  expect(() => validateDocument(doc)).toThrow('矢量区域填充数据无效')
  network.filledFaces[0][0] = e+'0'
  network.vertices[1].id = v+'0'
  expect(() => validateDocument(doc)).toThrow('矢量网络引用无效')
  network.vertices[1].id = edge.to = 'custom'
  expect(validateDocument(doc)).toBe(doc)
  network.vertices.reverse()
  expect(validateDocument(doc)).toBe(doc)
  network.vertices[0].x = NaN
  expect(() => validateDocument(doc)).toThrow('矢量网络引用无效')
})
