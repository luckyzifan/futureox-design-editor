import { expect, test } from 'vitest'
import { blank, node, type Matrix } from './model'
import { prepareDocument, takePreparedDocument } from './prepared-document'
import { documentPatch, producePoseDocument } from './document-patch'
import { compileEditOps } from './kernel/op-sync'
import { Editor } from './engine'

test('consecutive poses carry a complete diff against their source and isolate caller-owned matrices', () => {
  const input = blank(), a = node('rectangle', 0, 0, 10, 10), b = node('rectangle', 20, 0, 10, 10)
  input.nodes = { [a.id]: a, [b.id]: b }
  input.pages[0].children = [a.id, b.id]
  const before = takePreparedDocument(prepareDocument(input))!
  const m: Matrix = [1, 0, 0, 1, 7, 11]
  const first = producePoseDocument(before, { [a.id]: { transform: m } })!
  m[4] = 100
  const second = producePoseDocument(first, { [b.id]: { transform: [0, 1, -1, 0, 21, 0] } })!
  expect(first.nodes[b.id]).toBe(before.nodes[b.id])
  expect(second.nodes[a.id].transform[4]).toBe(7)
  expect(Object.keys(documentPatch(before, second).nodes).sort()).toEqual([a.id, b.id].sort())
  const expected = { [a.id]: [1, 0, 0, 1, 7, 11], [b.id]: [0, 1, -1, 0, 21, 0] }
  expect(compileEditOps(before, second)).toEqual({ mode: 'ops', ops: Object.keys(before.nodes)
    .map(id => ({ type: 'setTransform', id, matrix: expected[id] })) })
  // Even if someone edits a published copy in place, the compiler must
  // account for the extra field and must never silently compile only poses.
  second.nodes[a.id].name = 'Also renamed'
  const compiled = compileEditOps(before, second)
  expect(compiled.mode === 'ops' && compiled.ops.some(op => op.type === 'setName')).toBe(true)
  expect(producePoseDocument(before, { [a.id]: { transform: [0, 0, 0, 0, 0, 0] } })).toBeUndefined()
})

test('releasing a pose still rejects an invalid unrelated record in the public preview', () => {
  const input = blank(), a = node('rectangle', 0, 0, 10, 10), b = node('rectangle', 20, 0, 10, 10)
  input.nodes = { [a.id]: a, [b.id]: b }
  input.pages[0].children = [a.id, b.id]
  const editor = new Editor(input)
  try {
    const before = editor.state.doc, revision = editor.state.version
    editor.begin('旋转')
    expect(editor.preview({ [a.id]: { transform: [0, 1, -1, 0, 5, 0] } })).toBe(true)
    editor.state.doc.nodes[b.id] = { ...before.nodes[b.id], transform: [0, 0, 0, 0, 0, 0] }
    editor.commit()
    expect(editor.state.doc).toBe(before)
    expect(editor.state.version).toBe(revision)
    expect(editor.canUndo).toBe(false)
  } finally { editor.dispose() }
})
