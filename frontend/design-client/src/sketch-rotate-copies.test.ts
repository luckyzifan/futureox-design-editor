import { afterEach, expect, test } from 'vitest'
import { Editor } from './engine'
import { blank, defaultLayout, node } from './model'
import { around, multiply, rotate, worldMatrix } from './geometry'
import { interfacePreference } from './interface-preference'
import { applySketchRotateCopies, canRotateCopies, MAX_ROTATE_COPIES, rotateCopiesTarget, validRotateCopies } from './sketch-rotate-copies'
import { commandSearchEntries } from './command-search'
import { canvasContextItems, canvasMenuItems } from './canvas-menu-model'
import { dispatchEditorCommand, resolveDesktopEditorCommand } from './editor-commands'

const editors: Editor[] = []
afterEach(() => { editors.splice(0).forEach(editor => editor.dispose()); interfacePreference.reset() })
function editorWith(nodes: ReturnType<typeof node>[] = [node('rectangle', 100, 50, 200, 100)]) {
  const doc = blank('rotate copies')
  doc.nodes = Object.fromEntries(nodes.map(item => [item.id, item]))
  doc.pages[0].children = nodes.map(item => item.id)
  const editor = new Editor(doc); editors.push(editor)
  interfacePreference.set({ uiMode: 'sketch' })
  return { editor, nodes, doc }
}
const sketch = { profile: 'sketch-like' as const, platform: 'mac' as const, uiMode: 'sketch' as const, desktop: true }

test('three copies rotate around the selection center and commit as one undo step', () => {
  const { editor, nodes } = editorWith()
  const source = nodes[0]
  editor.select([source.id])
  const target = rotateCopiesTarget(editor)!
  expect(target).not.toBeNull()
  expect(target.center).toEqual({ x: 200, y: 100 })
  const before = editor.state.doc
  const result = applySketchRotateCopies(editor, target, 3)
  expect(result?.status).toBe('committed')
  expect(editor.state.doc.pages[0].children).toHaveLength(4)
  expect(editor.state.selection).toHaveLength(3)
  expect(editor.state.selection).not.toContain(source.id)
  const sourceWorld = worldMatrix(editor.state.doc, source.id)
  editor.state.selection.forEach((id, index) => {
    expect(id).not.toBe(source.id)
    const expected = multiply(around({ x: 200, y: 100 }, rotate(90 * (index + 1))), sourceWorld)
    const actual = worldMatrix(editor.state.doc, id)
    actual.forEach((value, at) => expect(value).toBeCloseTo(expected[at], 8))
  })
  expect(worldMatrix(editor.state.doc, source.id)).toEqual(sourceWorld)
  editor.undo()
  expect(editor.state.doc).toEqual(before)
  editor.redo()
  expect(editor.state.doc.pages[0].children).toHaveLength(4)
})

test('multiple roots rotate together around their union center', () => {
  const left = node('rectangle', 0, 50, 100, 100)
  const right = node('rectangle', 300, 50, 100, 100)
  const { editor } = editorWith([left, right])
  editor.select([left.id, right.id])
  const target = rotateCopiesTarget(editor)!
  expect(target.center).toEqual({ x: 200, y: 100 })
  applySketchRotateCopies(editor, target, 1)
  expect(editor.state.selection).toHaveLength(2)
  const [copyLeft, copyRight] = editor.state.selection.map(id => worldMatrix(editor.state.doc, id))
  expect(copyLeft[4]).toBeCloseTo(400, 8)
  expect(copyLeft[5]).toBeCloseTo(150, 8)
  expect(copyRight[4]).toBeCloseTo(100, 8)
  expect(copyRight[5]).toBeCloseTo(150, 8)
})

test('admission rejects non-Sketch layouts, locks, flow parents, and invalid counts', async () => {
  const { editor, nodes } = editorWith()
  interfacePreference.set({ uiMode: 'figma' })
  expect(canRotateCopies(editor)).toBe(false)
  interfacePreference.set({ uiMode: 'sketch' })
  editor.select([nodes[0].id])
  expect(canRotateCopies(editor)).toBe(true)
  editor.update([nodes[0].id], { locked: true })
  expect(canRotateCopies(editor)).toBe(false)
  editor.update([nodes[0].id], { locked: false })

  const flowDoc = blank('flow parent')
  const frame = node('frame', 0, 0, 600, 400)
  frame.layout = { ...defaultLayout(), mode: 'horizontal' }
  const inner = node('rectangle', 20, 20, 100, 100)
  frame.children = [inner.id]
  flowDoc.nodes = { [frame.id]: frame, [inner.id]: inner }
  flowDoc.pages[0].children = [frame.id]
  const flowEditor = new Editor(flowDoc); editors.push(flowEditor)
  flowEditor.select([inner.id])
  expect(canRotateCopies(flowEditor)).toBe(false)
  expect(validRotateCopies(0)).toBe(false)
  expect(validRotateCopies(MAX_ROTATE_COPIES + 1)).toBe(false)
  expect(validRotateCopies(3)).toBe(true)
  const target = rotateCopiesTarget(flowEditor)
  expect(target).toBeNull()
  const before = flowEditor.state.doc
  await dispatchEditorCommand(flowEditor, 'rotate-copies', { shortcutProfile: 'sketch-like' })
  expect(flowEditor.state.doc).toBe(before)
})

test('command search, native command route, and Sketch context menu expose Rotate Copies and Flatten', () => {
  const { editor, nodes } = editorWith()
  editor.select([nodes[0].id])
  const entries = commandSearchEntries(editor, sketch, 'zh-CN')
  const entry = entries.find(item => item.id === 'rotate-copies')!
  expect(entry).toMatchObject({ label: '旋转副本', group: 'path', disabled: false })
  expect(entry.aliases).toContain('Rotate Copies')
  expect(resolveDesktopEditorCommand('rotate-copies')).toBe('rotate-copies')
  const item = canvasMenuItems(editor, sketch).find(command => command.command === 'rotate-copies')!
  expect(item).toMatchObject({ label: '旋转副本', disabled: false })
  const flatten = canvasContextItems(editor, sketch, 'sketch').find(command => command.command === 'flatten')!
  expect(flatten).toMatchObject({ label: '拼合选中图像', disabled: false })
  editor.update([nodes[0].id], { locked: true })
  expect(canvasMenuItems(editor, sketch).find(command => command.command === 'rotate-copies')?.disabled).toBe(true)
})