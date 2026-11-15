import { expect, test } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'
import { dispatchEditorCommand } from './editor-commands'
import { multiply, translate, worldMatrix } from './geometry'
import { frameCropPatches, resizeNodeDimension } from './selection-properties'
import { createOutlineScene } from './CanvasOutlines'

function sceneWithFrame() {
  const doc = blank('Sketch selection')
  const frame = node('frame', 50, 35, 100, 80)
  const child = node('rectangle', 12, 18, 24, 16)
  frame.children = [child.id]
  doc.nodes[frame.id] = frame
  doc.nodes[child.id] = child
  doc.pages[0].children = [frame.id]
  return { doc, frame, child }
}

test('graphic is created around the selection and its width and height scale descendants through document layout', async () => {
  const { doc, frame, child } = sceneWithFrame()
  const editor = new Editor(doc)
  try {
    editor.select([child.id])
    const world = worldMatrix(editor.state.doc, child.id)
    await dispatchEditorCommand(editor, 'graphic-selection')
    const id = editor.state.selection[0]
    expect(editor.state.doc.nodes[id]).toMatchObject({ kind: 'frame', graphic: true, children: [child.id] })
    expect(editor.state.doc.nodes[frame.id].children).toEqual([id])
    expect(worldMatrix(editor.state.doc, child.id)).toEqual(world)
    const initial = editor.state.doc.nodes[id]
    const member = editor.state.doc.nodes[child.id]
    editor.updateProperties([id], (n, draft) => {
      resizeNodeDimension(n, 'width', initial.width * 2, draft)
    })
    expect(editor.state.doc.nodes[child.id]).toMatchObject({ width: member.width * 2, height: member.height,
      transform: [...member.transform.slice(0,4), member.transform[4]*2, member.transform[5]] })
    editor.undo()
    expect(worldMatrix(editor.state.doc, child.id)).toEqual(world)
    editor.redo()
    expect(editor.state.doc.nodes[child.id].width).toBe(member.width * 2)
  } finally { editor.dispose() }
})

test('frame cropping changes only its bounds, even with end pins and a rotated parent', () => {
  const { doc, frame, child } = sceneWithFrame()
  frame.transform = [0, 1, -1, 0, 50, 35]
  child.constraints = { horizontal: 'end', vertical: 'center', referenceWidth: frame.width, referenceHeight: frame.height }
  child.locked = true
  const editor = new Editor(doc)
  try {
    const source = editor.state.doc
    const world = worldMatrix(source, child.id)
    const transform = multiply(frame.transform, translate(5, -8))
    const patches = frameCropPatches(source, frame.id, { transform, width: 140, height: 55 })
    editor.change('裁切画框', draft => {
      for (const [id, patch] of Object.entries(patches)) Object.assign(draft.nodes[id], patch)
    })
    expect(editor.state.doc.nodes[frame.id]).toMatchObject({ width: 140, height: 55, transform })
    expect(editor.state.doc.nodes[child.id]).toMatchObject({ width: 24, height: 16, locked: true,
      constraints: { horizontal: 'end', vertical: 'center', referenceWidth: 140, referenceHeight: 55 } })
    expect(worldMatrix(editor.state.doc, child.id)).toEqual(world)
    editor.undo()
    expect(editor.state.doc.nodes[frame.id].transform).toEqual(frame.transform)
    expect(worldMatrix(editor.state.doc, child.id)).toEqual(world)
  } finally { editor.dispose() }
})

test('an outline scene can reveal a hidden subtree outside its clipped frame without changing the source', () => {
  const { doc, frame, child } = sceneWithFrame()
  frame.visible = false
  frame.clip = true
  child.transform[4] = 150
  const source = JSON.stringify(doc)
  expect(createOutlineScene(doc, doc.pages[0].id, false, false).index.entries).toEqual([])
  const outline = createOutlineScene(doc, doc.pages[0].id, true, true)
  expect(outline.index.query({ x: 200, y: 53, width: 24, height: 16 })).toMatchObject([{ id: child.id, hidden: true }])
  expect(JSON.stringify(doc)).toBe(source)
})
