import { afterEach, expect, test } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'
import { allParents } from './geometry'
import { interfacePreference } from './interface-preference'

const editors: Editor[] = []
afterEach(() => {
  editors.splice(0).forEach(editor => editor.dispose())
  interfacePreference.reset()
})

function open(mode: 'figma' | 'sketch', layers: ReturnType<typeof node>[]) {
  interfacePreference.set({ uiMode: mode })
  const doc = blank('sketch-frame-paste')
  doc.nodes = Object.fromEntries(layers.map(layer => [layer.id, layer]))
  doc.pages[0].children = layers
    .filter(layer => !layers.some(parent => parent.children.includes(layer.id)))
    .map(layer => layer.id)
  const editor = new Editor(doc)
  editors.push(editor)
  return editor
}

function copiesIn(editor: Editor, parentId: string, width: number) {
  return editor.state.doc.nodes[parentId].children
    .map(id => editor.state.doc.nodes[id])
    .filter(layer => Math.abs(layer.width - width) < 1e-6)
}

test('sketch paste into two equal frames centers each copy at the native in-frame point', () => {
  const source = node('rectangle', 30, 15, 39, 23)
  const left = node('frame', 500, 40, 170, 102)
  const right = node('frame', 40, 700, 170, 102)
  const markLeft = node('rectangle', 4, 6, 8, 9)
  const markRight = node('rectangle', 11, 13, 5, 7)
  markLeft.name = 'mark-left'
  markRight.name = 'mark-right'
  left.children = [markLeft.id]
  right.children = [markRight.id]
  const editor = open('sketch', [source, left, right, markLeft, markRight])
  editor.select([source.id])
  editor.importClipboard(editor.exportClipboard()!)
  editor.select([left.id, right.id])
  expect(editor.canUndo).toBe(false)
  const before = editor.state.doc
  editor.pasteToSelection()
  expect(editor.state.selection).toHaveLength(2)
  expect(new Set(editor.state.selection).size).toBe(2)
  for (const frame of [left, right]) {
    const [copy] = copiesIn(editor, frame.id, 39)
    expect(copy).toBeTruthy()
    expect(allParents(editor.state.doc).get(copy.id)).toBe(frame.id)
    expect(copy.transform[4]).toBeCloseTo(65.5, 6)
    expect(copy.transform[5]).toBeCloseTo(39.5, 6)
    expect(copy.width).toBe(39)
    expect(copy.height).toBe(23)
    expect(editor.state.doc.nodes[frame.id].children).toHaveLength(2)
    expect(editor.state.doc.nodes[frame.id].children[0]).not.toBe(copy.id)
  }
  expect(editor.state.doc.nodes[markLeft.id].transform.slice(4)).toEqual([4, 6])
  expect(editor.state.doc.nodes[markRight.id].transform.slice(4)).toEqual([11, 13])
  expect(editor.state.doc.nodes[source.id].transform.slice(4)).toEqual([30, 15])
  expect(editor.canUndo).toBe(true)
  editor.undo()
  expect(editor.state.doc).toEqual(before)
  expect(editor.canUndo).toBe(false)
  expect(editor.canRedo).toBe(true)
  editor.redo()
  for (const frame of [left, right]) {
    const [copy] = copiesIn(editor, frame.id, 39)
    expect(copy.transform[4]).toBeCloseTo(65.5, 6)
    expect(copy.transform[5]).toBeCloseTo(39.5, 6)
  }
  editor.undo()
  expect(editor.state.doc).toEqual(before)
})

test('sketch paste centers independently in two differently sized frames', () => {
  const source = node('rectangle', 30, 15, 39, 23)
  const wide = node('frame', 480, 25, 170, 102)
  const tall = node('frame', 30, 640, 200, 80)
  const angle = Math.PI / 6
  tall.transform = [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 30, 640]
  const markWide = node('rectangle', 2, 3, 6, 6)
  const markTall = node('rectangle', 9, 4, 6, 6)
  markWide.name = 'mark-wide'
  markTall.name = 'mark-tall'
  wide.children = [markWide.id]
  tall.children = [markTall.id]
  const editor = open('sketch', [source, wide, tall, markWide, markTall])
  editor.select([source.id])
  editor.copy()
  editor.select([wide.id, tall.id])
  editor.pasteToSelection()
  const wideCopy = copiesIn(editor, wide.id, 39)[0]
  const tallCopy = copiesIn(editor, tall.id, 39)[0]
  expect(wideCopy.transform[4]).toBeCloseTo((170 - 39) / 2, 6)
  expect(wideCopy.transform[5]).toBeCloseTo((102 - 23) / 2, 6)
  expect(tallCopy.transform[4]).toBeCloseTo((200 - 39) / 2, 6)
  expect(tallCopy.transform[5]).toBeCloseTo((80 - 23) / 2, 6)
  expect(wideCopy.transform[4]).toBeCloseTo(65.5, 6)
  expect(wideCopy.transform[5]).toBeCloseTo(39.5, 6)
  expect(tallCopy.transform[4]).toBeCloseTo(80.5, 6)
  expect(tallCopy.transform[5]).toBeCloseTo(28.5, 6)
  expect(editor.state.doc.nodes[markWide.id].transform.slice(4)).toEqual([2, 3])
  expect(editor.state.doc.nodes[markTall.id].transform.slice(4)).toEqual([9, 4])
  expect(editor.state.doc.nodes[tall.id].transform[0]).toBeCloseTo(Math.cos(angle), 6)
})

test('sketch paste keeps relative positions while centering the copied bounds in each frame', () => {
  const first = node('rectangle', 30, 15, 39, 23)
  const second = node('rectangle', 50, 40, 10, 10)
  const wide = node('frame', 300, 20, 170, 102)
  const tall = node('frame', 20, 400, 80, 200)
  const markWide = node('rectangle', 1, 1, 3, 3)
  const markTall = node('rectangle', 2, 2, 3, 3)
  markWide.name = 'mark-wide'
  markTall.name = 'mark-tall'
  wide.children = [markWide.id]
  tall.children = [markTall.id]
  const editor = open('sketch', [first, second, wide, tall, markWide, markTall])
  editor.select([first.id, second.id])
  editor.copy()
  editor.select([wide.id, tall.id])
  const before = editor.state.doc
  editor.pasteToSelection()
  expect(editor.state.selection).toHaveLength(4)
  const placed = (frameId: string) => ({
    a: copiesIn(editor, frameId, 39)[0],
    b: copiesIn(editor, frameId, 10)[0],
  })
  const wideCopies = placed(wide.id)
  const tallCopies = placed(tall.id)
  expect(wideCopies.a.transform[4]).toBeCloseTo(65.5, 6)
  expect(wideCopies.a.transform[5]).toBeCloseTo(33.5, 6)
  expect(wideCopies.b.transform[4]).toBeCloseTo(85.5, 6)
  expect(wideCopies.b.transform[5]).toBeCloseTo(58.5, 6)
  expect(tallCopies.a.transform[4]).toBeCloseTo(20.5, 6)
  expect(tallCopies.a.transform[5]).toBeCloseTo(82.5, 6)
  expect(tallCopies.b.transform[4]).toBeCloseTo(40.5, 6)
  expect(tallCopies.b.transform[5]).toBeCloseTo(107.5, 6)
  expect(allParents(editor.state.doc).get(wideCopies.a.id)).toBe(wide.id)
  expect(allParents(editor.state.doc).get(wideCopies.b.id)).toBe(wide.id)
  expect(allParents(editor.state.doc).get(tallCopies.a.id)).toBe(tall.id)
  expect(allParents(editor.state.doc).get(tallCopies.b.id)).toBe(tall.id)
  for (const copies of [wideCopies, tallCopies]) {
    expect(copies.b.transform[4] - copies.a.transform[4]).toBeCloseTo(20, 6)
    expect(copies.b.transform[5] - copies.a.transform[5]).toBeCloseTo(25, 6)
  }
  editor.undo()
  expect(editor.state.doc).toEqual(before)
  editor.redo()
  expect(copiesIn(editor, wide.id, 39)[0].transform[4]).toBeCloseTo(65.5, 6)
  expect(copiesIn(editor, tall.id, 10)[0].transform[5]).toBeCloseTo(107.5, 6)
})

test('figma paste into differently sized frames keeps the copied position plus 10', () => {
  const source = node('rectangle', 30, 15, 39, 23)
  const wide = node('frame', 480, 25, 170, 102)
  const tall = node('frame', 30, 640, 200, 80)
  const markWide = node('rectangle', 2, 3, 6, 6)
  const markTall = node('rectangle', 9, 4, 6, 6)
  wide.children = [markWide.id]
  tall.children = [markTall.id]
  const editor = open('figma', [source, wide, tall, markWide, markTall])
  editor.select([source.id])
  editor.copy()
  editor.select([wide.id, tall.id])
  editor.pasteToSelection()
  for (const frame of [wide, tall]) {
    const [copy] = copiesIn(editor, frame.id, 39)
    expect(allParents(editor.state.doc).get(copy.id)).toBe(frame.id)
    expect(copy.transform[4]).toBeCloseTo(40, 6)
    expect(copy.transform[5]).toBeCloseTo(25, 6)
  }
})

test('sketch paste into one selected frame centers in that frame', () => {
  const source = node('rectangle', 30, 15, 39, 23)
  const frame = node('frame', 220, 80, 170, 102)
  const mark = node('rectangle', 4, 6, 8, 9)
  mark.name = 'mark'
  frame.children = [mark.id]
  const editor = open('sketch', [source, frame, mark])
  editor.select([source.id])
  editor.copy()
  editor.select([frame.id])
  editor.pasteToSelection()
  const [centered] = copiesIn(editor, frame.id, 39)
  expect(allParents(editor.state.doc).get(centered.id)).toBe(frame.id)
  expect(centered.transform[4]).toBeCloseTo(65.5, 6)
  expect(centered.transform[5]).toBeCloseTo(39.5, 6)
  expect(editor.state.doc.nodes[mark.id].transform.slice(4)).toEqual([4, 6])
})

test('Sketch in-place paste keeps parent-local coordinates while Figma keeps world coordinates', () => {
  const sourceFrame = node('frame', 100, 60, 240, 160)
  const child = node('rectangle', 30, 25, 40, 30)
  const target = node('frame', 420, 170, 200, 150)
  sourceFrame.children = [child.id]
  const editor = open('sketch', [sourceFrame, child, target])
  editor.select([child.id])
  const packet = editor.exportClipboard()!
  const before = editor.authoredDocument
  editor.importClipboard(packet)
  editor.select([target.id])
  editor.pasteToSelection(false, true)
  const [local] = copiesIn(editor, target.id, 40)
  expect(local.transform.slice(4)).toEqual([30, 25])
  editor.undo()
  expect(editor.authoredDocument).toEqual(before)
  expect(editor.canUndo).toBe(false)

  interfacePreference.set({ uiMode: 'figma' })
  editor.importClipboard(packet)
  editor.select([target.id])
  editor.paste(true)
  const [world] = copiesIn(editor, target.id, 40)
  expect(world.transform.slice(4)).toEqual([-290, -85])
  editor.undo()
  expect(editor.authoredDocument).toEqual(before)
})

test('sketch sibling paste inside a frame still steps by 10', () => {
  const frame = node('frame', 10, 20, 170, 102)
  const child = node('rectangle', 30, 15, 39, 23)
  frame.children = [child.id]
  const editor = open('sketch', [frame, child])
  editor.select([child.id])
  editor.copy()
  editor.pasteToSelection()
  const copy = editor.state.doc.nodes[editor.state.selection[0]]
  expect(copy.id).not.toBe(child.id)
  expect(allParents(editor.state.doc).get(copy.id)).toBe(frame.id)
  expect(copy.transform[4]).toBeCloseTo(40, 6)
  expect(copy.transform[5]).toBeCloseTo(25, 6)
  expect(editor.state.doc.nodes[child.id].transform.slice(4)).toEqual([30, 15])
})

test('sketch paste into selected groups and sections keeps the local step', () => {
  const source = node('rectangle', 30, 15, 39, 23)
  const group = node('group', 10, 10, 170, 102)
  const section = node('section', 400, 10, 200, 80)
  const markGroup = node('rectangle', 1, 1, 4, 4)
  const markSection = node('rectangle', 2, 2, 4, 4)
  group.children = [markGroup.id]
  section.children = [markSection.id]
  const editor = open('sketch', [source, group, section, markGroup, markSection])
  editor.select([source.id])
  editor.copy()
  editor.select([group.id, section.id])
  editor.pasteToSelection()
  for (const parent of [group, section]) {
    const [copy] = copiesIn(editor, parent.id, 39)
    expect(allParents(editor.state.doc).get(copy.id)).toBe(parent.id)
    expect(copy.transform[4]).toBeCloseTo(40, 6)
    expect(copy.transform[5]).toBeCloseTo(25, 6)
  }
})

test('sketch paste-replace keeps the replaced layer position', () => {
  const frame = node('frame', 0, 0, 170, 102)
  const source = node('rectangle', 30, 15, 39, 23)
  const target = node('rectangle', 12.25, 8.5, 20, 20)
  frame.children = [target.id]
  const editor = open('sketch', [frame, source, target])
  editor.select([source.id])
  editor.copy()
  editor.select([target.id])
  const before = editor.state.doc
  editor.pasteToSelection(true)
  const copy = editor.state.doc.nodes[editor.state.selection[0]]
  expect(editor.state.doc.nodes[target.id]).toBeUndefined()
  expect(allParents(editor.state.doc).get(copy.id)).toBe(frame.id)
  expect(copy.transform[4]).toBeCloseTo(12.25, 6)
  expect(copy.transform[5]).toBeCloseTo(8.5, 6)
  expect(copy.width).toBe(39)
  editor.undo()
  expect(editor.state.doc).toEqual(before)
})
