import { afterEach, expect, test } from 'vitest'
import { dispatchEditorCommand } from './editor-commands'
import { Editor } from './engine'
import { interfacePreference } from './interface-preference'
import { blank, node } from './model'
import { canCloseSelectionPath, canReverseSelectionPath, closeablePath, reversiblePath } from './sketch-path-commands'

const editors: Editor[] = []
afterEach(() => {
  editors.splice(0).forEach(editor => editor.dispose())
  interfacePreference.reset()
})

function openPathEditor() {
  interfacePreference.set({ uiMode: 'sketch' })
  const doc = blank('Path commands')
  const path = node('vector', 10, 20, 100, 80)
  path.network = {
    vertices: [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 50, y: 0 },
      { id: 'c', x: 50, y: 40 },
    ],
    edges: [
      { id: 'ab', from: 'a', to: 'b', c1: { x: 10, y: 0 }, c2: { x: 40, y: 0 } },
      { id: 'bc', from: 'b', to: 'c' },
    ],
    fillRule: 'evenodd',
  }
  doc.nodes[path.id] = path
  doc.pages[0].children = [path.id]
  const editor = new Editor(doc)
  editor.select([path.id])
  editors.push(editor)
  return { editor, path }
}

test('Close Path links the two open ends as one undoable edit and refuses closed or branched paths', async () => {
  const { editor } = openPathEditor()
  const before = editor.state.doc
  expect(canCloseSelectionPath(editor)).toBe(true)
  await dispatchEditorCommand(editor, 'close-path')
  const network = editor.state.doc.nodes[editor.state.selection[0]].network!
  expect(network.edges).toHaveLength(3)
  expect(network.edges[2]).toMatchObject({ from: 'c', to: 'a' })
  expect(editor.canUndo).toBe(true)
  expect(canCloseSelectionPath(editor)).toBe(false)
  editor.undo()
  expect(editor.state.doc).toEqual(before)
  expect(editor.canUndo).toBe(false)

  const closed = structuredClone(before)
  const nodeId = Object.keys(closed.nodes)[0]
  closed.nodes[nodeId].network!.edges.push({ id: 'ca', from: 'c', to: 'a' })
  expect(closeablePath(closed, [nodeId])).toBe(false)

  const branched = structuredClone(before)
  const branchId = Object.keys(branched.nodes)[0]
  branched.nodes[branchId].network!.vertices.push({ id: 'd', x: 70, y: 60 })
  branched.nodes[branchId].network!.edges.push({ id: 'bd', from: 'b', to: 'd' })
  expect(closeablePath(branched, [branchId])).toBe(false)
})

test('Reverse Order swaps edge direction and handles, restores with undo, and leaves non-vector nodes alone', async () => {
  const { editor } = openPathEditor()
  const before = editor.state.doc
  expect(canReverseSelectionPath(editor)).toBe(true)
  await dispatchEditorCommand(editor, 'reverse-order')
  const network = editor.state.doc.nodes[editor.state.selection[0]].network!
  expect(network.edges.map(edge => edge.id)).toEqual(['bc', 'ab'])
  expect(network.edges[1]).toMatchObject({
    from: 'b', to: 'a', c1: { x: 40, y: 0 }, c2: { x: 10, y: 0 },
  })
  editor.undo()
  expect(editor.state.doc).toEqual(before)

  const rectangle = node('rectangle', 0, 0, 20, 20)
  editor.change('add rectangle', draft => {
    draft.nodes[rectangle.id] = rectangle
    draft.pages[0].children.push(rectangle.id)
  })
  editor.select([rectangle.id])
  expect(reversiblePath(editor.state.doc, editor.state.selection)).toBe(false)
  const version = editor.state.version
  await dispatchEditorCommand(editor, 'reverse-order')
  expect(editor.state.version).toBe(version)
})