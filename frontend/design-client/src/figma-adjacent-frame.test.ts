import { afterEach, expect, test } from 'vitest'
import { Editor } from './engine'
import { addAdjacentFigmaFrame } from './figma-adjacent-frame'
import { worldMatrix } from './geometry'
import { interfacePreference } from './interface-preference'
import { blank, node, type DesignNode } from './model'

const editors: Editor[] = []
afterEach(() => {
  editors.splice(0).forEach(editor => editor.dispose())
  interfacePreference.reset()
})
function setup(nodes: DesignNode[], roots: DesignNode[]) {
  interfacePreference.set({ uiMode: 'figma' })
  const doc = blank()
  doc.nodes = Object.fromEntries(nodes.map(layer => [layer.id, layer]))
  doc.pages[0].children = roots.map(layer => layer.id)
  const editor = new Editor(doc)
  editors.push(editor)
  editor.set({ tool: 'frame' })
  return editor
}

test('adds a same-row copy and opens a gap without moving the source or other rows', () => {
  const source = node('frame', 100, 120, 100, 100), child = node('rectangle', 12, 16, 30, 20)
  const a = node('frame', 240, 120, 100, 100), b = node('frame', 380, 120, 120, 100)
  const below = node('frame', 240, 330, 100, 100), separated = node('frame', 800, 120, 100, 100)
  source.children = [child.id]
  const roots = [source, a, b, below, separated], editor = setup([...roots, child], roots)
  const before = editor.authoredDocument
  expect(addAdjacentFigmaFrame(editor, source.id, 1, false)).toBe(true)
  const after = editor.authoredDocument, copy = after.nodes[editor.state.selection[0]]
  expect(copy.transform.slice(4)).toEqual([240, 120])
  expect(copy.children).toHaveLength(1)
  expect(copy.children[0]).not.toBe(child.id)
  expect(after.nodes[copy.children[0]].transform).toEqual(child.transform)
  expect(after.nodes[a.id].transform[4]).toBe(380)
  expect(after.nodes[b.id].transform[4]).toBe(520)
  for (const original of [source, child, below, separated]) expect(after.nodes[original.id]).toEqual(before.nodes[original.id])
  editor.undo()
  expect(editor.authoredDocument).toEqual(before)
  expect(editor.canUndo).toBe(false)
  editor.redo()
  expect(editor.authoredDocument).toEqual(after)
})

test('Option adds a blank frame on the left and grows a section around both frames', () => {
  const section = node('section', 400, 90, 300, 160)
  const source = node('frame', 15, 20, 100, 100), original = node('rectangle', 10, 12, 30, 20)
  const following = node('frame', 180, 20, 70, 90)
  source.children = [original.id]; section.children = [source.id, following.id]
  const editor = setup([section, source, original, following], [section])
  const before = editor.authoredDocument
  const world = worldMatrix(before, source.id), nextWorld = worldMatrix(before, following.id)
  expect(addAdjacentFigmaFrame(editor, source.id, -1, true)).toBe(true)
  const after = editor.authoredDocument, copy = after.nodes[editor.state.selection[0]]
  expect(copy).toMatchObject({ width: 100, height: 100, children: [] })
  expect(after.nodes[section.id].children).toEqual([copy.id, source.id, following.id])
  expect(after.nodes[section.id].width).toBe(425)
  expect(worldMatrix(after, copy.id).slice(4)).toEqual([275, 110])
  expect(worldMatrix(after, source.id)).toEqual(world)
  expect(worldMatrix(after, following.id)).toEqual(nextWorld)
  expect(after.nodes[original.id]).toEqual(before.nodes[original.id])
  editor.undo()
  expect(editor.authoredDocument).toEqual(before)
  expect(editor.canUndo).toBe(false)
})

test('a locked neighbour can veto a collision without a partial duplicate', () => {
  const source = node('frame', 50, 20, 100, 100), locked = node('frame', 190, 20, 100, 100)
  locked.locked = true
  const editor = setup([source, locked], [source, locked])
  const before = editor.authoredDocument
  expect(addAdjacentFigmaFrame(editor, source.id, 1, false)).toBe(false)
  expect(editor.authoredDocument).toBe(before)
  expect(editor.canUndo).toBe(false)
})
