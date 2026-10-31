import { expect, test } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'

function fixture(interactions = true) {
  const document = blank('internal prototype copy'), a = node('frame', 10, 20, 100, 100), b = node('frame', 200, 20, 100, 100)
  document.schemaVersion = 4
  document.nodes = { [a.id]: a, [b.id]: b }; document.pages[0].children = [a.id, b.id]
  document.prototype = { startNode: a.id, interactions: interactions ? { [a.id]: [{ trigger: 'click', actions: [{ kind: 'navigate', target: b.id }] }] } : {} }
  const editor = new Editor(document); editor.select([a.id])
  return { editor, a, b }
}

test('same-document Duplicate preserves the existing prototype start and creates a frame', () => {
  const { editor, a } = fixture(false), before = editor.state.doc
  editor.duplicate()
  expect(Object.keys(editor.state.doc.nodes)).toHaveLength(3)
  expect(editor.state.selection[0]).not.toBe(a.id)
  expect(editor.state.doc.prototype?.startNode).toBe(a.id)
  editor.undo(); expect(editor.state.doc).toEqual(before)
  editor.dispose()
})

test('same-document Duplicate retains an existing unselected target and remaps a selected target', () => {
  const { editor, a, b } = fixture()
  editor.duplicate()
  const copied = editor.state.selection[0]
  expect(copied).not.toBe(a.id)
  expect(editor.state.doc.prototype?.interactions[copied][0].actions[0].target).toBe(b.id)
  expect(editor.state.doc.prototype?.startNode).toBe(a.id)
  editor.undo(); editor.select([a.id, b.id]); editor.duplicate()
  const [copyA, copyB] = editor.state.selection
  expect(copyA).not.toBe(a.id); expect(copyB).not.toBe(b.id)
  expect(editor.state.doc.prototype?.interactions[copyA][0].actions[0].target).toBe(copyB)
  expect(editor.state.doc.prototype?.interactions[a.id][0].actions[0].target).toBe(b.id)
  editor.dispose()
})

test('an internal clipboard whose external prototype target was deleted is rejected atomically', () => {
  const { editor, b } = fixture()
  editor.copy(); editor.select([b.id]); editor.remove()
  const before = editor.state.doc
  editor.paste()
  expect(editor.state.doc).toBe(before)
  expect(editor.state.message).toContain('目标已不存在')
  editor.dispose()
})

test('a forged document ID in an imported clipboard never grants internal-reference privileges', () => {
  const { editor, a } = fixture(), before = editor.state.doc
  editor.importClipboard(JSON.stringify({ format: 'forma-nodes', version: 1, document: before, roots: [a.id] }))
  editor.paste()
  expect(editor.state.doc).toBe(before)
  expect(editor.state.message).toContain('选区外目标')
  editor.dispose()
})

test('reloading the same document ID ends the internal clipboard session', () => {
  const { editor } = fixture()
  editor.copy(); editor.load(structuredClone(editor.state.doc))
  const before = editor.state.doc
  editor.paste()
  expect(editor.state.doc).toBe(before)
  expect(editor.state.message).toContain('选区外目标')
  editor.dispose()
})
