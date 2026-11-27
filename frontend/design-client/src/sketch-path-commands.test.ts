import { afterEach, expect, test } from 'vitest'
import { dispatchEditorCommand, resolveDesktopEditorCommand } from './editor-commands'
import { Editor } from './engine'
import { interfacePreference } from './interface-preference'
import { apply, worldMatrix } from './geometry'
import { blank, node } from './model'
import { canCloseSelectionPath, canJoinSelectionPaths, canReverseSelectionPath, closeablePath, reversiblePath } from './sketch-path-commands'

const editors: Editor[] = []
afterEach(() => {
  editors.splice(0).forEach(editor => editor.dispose())
  interfacePreference.reset()
})

function openPathEditor(reorderVertices = false) {
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
  if (reorderVertices) path.network.vertices.reverse()
  doc.nodes[path.id] = path
  doc.pages[0].children = [path.id]
  const editor = new Editor(doc)
  editor.select([path.id])
  editors.push(editor)
  return { editor, path }
}

function openJoinEditor(change?: (doc: ReturnType<typeof blank>, top: ReturnType<typeof node>) => void) {
  interfacePreference.set({ uiMode: 'sketch' })
  const doc = blank('Join paths')
  const group = node('group', 80, 96, 240, 240)
  group.transform = [0, -1, 1, 0, 80, 96]
  const bottom = node('vector', 50, 20, 100, 80)
  const top = node('vector', 50, 60, 100, 80)
  bottom.transform = [0, 1, -1, 0, 50, 20]
  top.transform = [0, 1, -1, 0, 50, 60]
  bottom.network = {
    vertices: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 40, y: 0 }],
    edges: [{ id: 'arc', from: 'a', to: 'b', c1: { x: 9.25, y: 3.5 }, c2: { x: 28.5, y: 2 } }],
    fillRule: 'evenodd',
  }
  top.network = {
    vertices: [{ id: 'a', x: 35, y: 16 }, { id: 'b', x: 0, y: 0 }],
    edges: [{ id: 'arc', from: 'a', to: 'b', c1: { x: 25, y: 16.5 }, c2: { x: 8.5, y: 5 } }],
    fillRule: 'evenodd',
  }
  group.children = [bottom.id, top.id]
  doc.pages[0].children = [group.id]
  doc.nodes = Object.fromEntries([group, bottom, top].map(layer => [layer.id, layer]))
  change?.(doc, top)
  const editor = new Editor(doc)
  editor.select([top.id, bottom.id])
  editors.push(editor)
  return { editor, group, bottom, top }
}

test('the desktop Join command retains the bottom path and merges exact cubic geometry as one undoable edit', async () => {
  const { editor, group, bottom, top } = openJoinEditor()
  const before = editor.state.doc
  const command = resolveDesktopEditorCommand('join-paths')
  expect(command).toBe('join-paths')
  expect(canJoinSelectionPaths(editor)).toBe(true)
  if (!command) return
  await dispatchEditorCommand(editor, command)
  const after = editor.state.doc
  const retained = after.nodes[bottom.id]
  expect(after.nodes[top.id]).toBeUndefined()
  expect(after.nodes[group.id].children).toEqual([bottom.id])
  expect(editor.state.selection).toEqual([bottom.id])
  expect(retained.transform).toEqual(bottom.transform)
  expect(retained.network!.vertices).toHaveLength(3)
  expect(new Set(retained.network!.vertices.map(vertex => vertex.id)).size).toBe(3)
  expect(retained.network!.edges).toHaveLength(2)
  expect(retained.network!.edges[0]).toEqual(bottom.network!.edges[0])
  const joined = retained.network!.edges[1]
  const head = retained.network!.vertices.find(point => point.id === joined.to)!
  const input = top.network!.edges[0]
  expect(joined.from).toBe('b')
  expect(joined.id).not.toBe(input.id)
  expect(['a', 'b']).not.toContain(head.id)
  const worldBefore = worldMatrix(before, top.id)
  const worldAfter = worldMatrix(after, bottom.id)
  expect(apply(worldAfter, head)).toEqual(apply(worldBefore, top.network!.vertices[0]))
  expect(apply(worldAfter, joined.c1!)).toEqual(apply(worldBefore, input.c2!))
  expect(apply(worldAfter, joined.c2!)).toEqual(apply(worldBefore, input.c1!))
  editor.undo()
  expect(editor.state.doc).toEqual(before)
  expect(editor.state.selection).toEqual([top.id, bottom.id])
  expect(editor.canUndo).toBe(false)
  editor.redo()
  expect(editor.state.doc).toEqual(after)
  expect(editor.state.selection).toEqual([bottom.id])
})

test.each([
  ['a gap between endpoints', (_doc, top) => { top.transform[5] += 1 }],
  ['two matching endpoint pairs', (_doc, top) => { top.network!.vertices[0] = { id: 'a', x: -40, y: 0 } }],
  ['a different affine basis', (_doc, top) => { top.transform[0] = 1 }],
  ['a different stroke', (_doc, top) => { top.strokes[0].paint.color = '#990000' }],
  ['a locked operand', (_doc, top) => { top.locked = true }],
  ['separate parents', (doc, top) => {
    doc.nodes[doc.pages[0].children[0]].children.pop()
    doc.pages[0].children.push(top.id)
  }],
  ['an intervening sibling', (doc) => {
    const between = node('rectangle')
    doc.nodes[between.id] = between
    doc.nodes[doc.pages[0].children[0]].children.splice(1, 0, between.id)
  }],
  ['a disconnected cycle', (_doc, top) => {
    top.network!.vertices.push({ id: 'c', x: 2, y: 4 }, { id: 'd', x: 3, y: 8 }, { id: 'e', x: 2, y: 9 })
    top.network!.edges.push({ id: 'cd', from: 'c', to: 'd' }, { id: 'de', from: 'd', to: 'e' }, { id: 'ec', from: 'e', to: 'c' })
  }],
  ['a path attachment', (doc, top) => {
    doc.schemaVersion = 4
    doc.prototype = { interactions: { [top.id]: [{ trigger: 'click', actions: [{ kind: 'back' }] }] } }
  }],
] as [string, NonNullable<Parameters<typeof openJoinEditor>[0]>][])('Join preserves the original document when given %s', async (_name, change) => {
  const { editor } = openJoinEditor(change)
  const before = editor.state.doc, selection = editor.state.selection
  expect(canJoinSelectionPaths(editor)).toBe(false)
  await dispatchEditorCommand(editor, 'join-paths')
  expect(editor.state.doc).toBe(before)
  expect(editor.state.selection).toEqual(selection)
  expect(editor.canUndo).toBe(false)
})

test.each([false, true])('Close Path closes the directed contour and supports undo (reordered vertices: %s)', async reorderVertices => {
  const { editor } = openPathEditor(reorderVertices)
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
