import { afterEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node, stroke, uid, type DesignDocument } from './model'
import { allParents, multiply, translate, worldMatrix } from './geometry'
import { canvasMenuItems, clampContextMenu } from './canvas-menu-model'
import { dispatchEditorCommand } from './editor-commands'
import { createClip } from './animation'
import { VectorEngine } from './generated/design-kernel/design_kernel'
import { prepareDocumentForEditing } from './kernel/picking'

afterEach(() => vi.unstubAllGlobals())

test('Frame selection and native unframe preserve world transforms with one undo each', async () => {
  const { editor, parent, a, b } = rotatedFixture(), before = editor.state.doc
  const worlds = [a.id, b.id].map(id => worldMatrix(before, id))
  await dispatchEditorCommand(editor, 'frame-selection')
  const id = editor.state.selection[0], frame = editor.state.doc.nodes[id]
  expect(frame.kind).toBe('frame'); expect(frame.fills).toEqual([]); expect(frame.clip).toBe(false)
  expect(allParents(editor.state.doc).get(id)).toBe(parent.id)
  for (const [index, child] of [a.id, b.id].entries()) worldMatrix(editor.state.doc, child).forEach((v, i) => expect(v).toBeCloseTo(worlds[index][i], 10))
  const wrapped = editor.state.doc
  await dispatchEditorCommand(editor, 'ungroup')
  expect(editor.state.doc.nodes[id]).toBeUndefined()
  for (const [index, child] of [a.id, b.id].entries()) worldMatrix(editor.state.doc, child).forEach((v, i) => expect(v).toBeCloseTo(worlds[index][i], 10))
  editor.undo(); expect(editor.state.doc).toEqual(wrapped)
  editor.undo(); expect(editor.state.doc).toEqual(before); editor.dispose()
})
test('Move to page keeps world placement, invalid targets are no-ops, and Undo restores source hierarchy', async () => {
  const { editor, a, b } = rotatedFixture(), targetPage = uid()
  editor.change('add page', d => { d.pages.push({ id: targetPage, name: 'Target', background: '#ffffff', children: [] }) })
  const before = editor.state.doc, worlds = [a.id, b.id].map(id => worldMatrix(before, id))
  await dispatchEditorCommand(editor, 'move-to-page', { pageId: 'missing' }); expect(editor.state.doc).toBe(before)
  await dispatchEditorCommand(editor, 'move-to-page', { pageId: targetPage })
  expect(editor.state.selection).toEqual([])
  expect(editor.state.doc.pages.find(p => p.id === targetPage)!.children).toEqual([a.id, b.id])
  for (const [index, id] of [a.id, b.id].entries()) worldMatrix(editor.state.doc, id).forEach((v, i) => expect(v).toBeCloseTo(worlds[index][i], 10))
  editor.undo(); expect(editor.state.doc).toEqual(before); editor.dispose()
})
test('Context auto layout, remove layout, component and mask dispatch to native document operations', async () => {
  for (const command of ['auto-layout', 'create-component', 'mask-selection'] as const) {
    const { editor } = rotatedFixture(), before = editor.state.doc
    await dispatchEditorCommand(editor, command)
    const root = editor.state.doc.nodes[editor.state.selection[0]]
    if (command === 'auto-layout') { expect(root.layout?.mode).toBe('vertical'); await dispatchEditorCommand(editor, 'remove-auto-layout'); expect(editor.state.doc.nodes[root.id].layout).toBeUndefined(); editor.undo() }
    if (command === 'create-component') expect(root.component).toBeDefined()
    if (command === 'mask-selection') expect(editor.state.doc.nodes[root.children[0]].mask).toBe(true)
    editor.undo(); expect(editor.state.doc).toEqual(before); editor.dispose()
  }
})
function rotatedFixture() {
  const document = blank('context placement'), parent = node('frame', 0, 0, 400, 400)
  parent.transform = [0.8, 0.6, -0.4, 1.2, 140, -60]
  const a = node('rectangle', -20, 10, 80, 50), b = node('ellipse', 100, 80, 40, 60)
  parent.children = [a.id, b.id]
  document.nodes = { [parent.id]: parent, [a.id]: a, [b.id]: b }; document.pages[0].children = [parent.id]
  const editor = new Editor(document); editor.select([a.id, b.id])
  return { editor, parent, a, b }
}
function animationHistoryShape(document: DesignDocument) {
  const value = structuredClone(document)
  // Rust's Option field in animation keyframe paints roundtrips omitted image
  // as null. Compare every authored field, normalizing only that absent value.
  for (const clip of value.animations || []) for (const track of clip.tracks) for (const key of track.keyframes)
    for (const paint of [...key.value.fills, ...key.value.strokes.map((stroke) => stroke.paint)])
      if (paint.image == null) delete paint.image
  return value
}

test('Paste here uses the selection top-left in world space, at negative coordinates, as one page-level undo', () => {
  const { editor, parent, a, b } = rotatedFixture(), before = editor.state.doc
  const box = editor.selectionBounds()!, at = { x: -450, y: -240 }, delta = { x: at.x - box.x, y: at.y - box.y }
  const originals = [a.id, b.id].map((id) => worldMatrix(before, id))
  editor.copy(); editor.paste(false, at)
  const selected = editor.state.selection, result = editor.selectionBounds()!, parents = allParents(editor.state.doc)
  expect(result.x).toBeCloseTo(at.x, 10); expect(result.y).toBeCloseTo(at.y, 10)
  selected.forEach((id, index) => {
    expect(parents.get(id)).toBe(editor.state.page)
    expect(parents.get(id)).not.toBe(parent.id)
    worldMatrix(editor.state.doc, id).forEach((value, component) => expect(value).toBeCloseTo(multiply(translate(delta.x, delta.y), originals[index])[component], 10))
  })
  editor.undo(); expect(editor.state.doc).toEqual(before)
  editor.dispose()
})

test('Paste here preserves nested animation world frames with independent x/y offsets and one undo', () => {
  const fixture = rotatedFixture(), document = structuredClone(fixture.editor.state.doc)
  fixture.editor.dispose()
  document.animations = [createClip(document, document.pages[0].id, [fixture.a.id])]
  const clip = document.animations[0]
  clip.tracks[0].keyframes[1].value.transform = [0.9, 0.3, -0.3, 0.9, 75, -25]
  const editor = new Editor(prepareDocumentForEditing(document)); editor.select([fixture.a.id])
  const before = editor.state.doc, box = editor.selectionBounds()!, at = { x: -230, y: 460 }
  const delta = translate(at.x - box.x, at.y - box.y)
  editor.copy(); editor.paste(false, at)
  const id = editor.state.selection[0], pasted = editor.state.doc, imported = pasted.animations!.find((value) => value.id !== clip.id)!
  const kernel = new VectorEngine()
  try {
    for (const timeMs of [0, 173, 500, 1000]) {
      const source = JSON.parse(kernel.animation_document(JSON.stringify(before), JSON.stringify({ clipId: clip.id, timeMs })))
      const target = JSON.parse(kernel.animation_document(JSON.stringify(pasted), JSON.stringify({ clipId: imported.id, timeMs })))
      const expected = multiply(delta, worldMatrix(source, fixture.a.id)), actual = worldMatrix(target, id)
      actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 10))
    }
  } finally { kernel.free() }
  editor.undo(); expect(animationHistoryShape(editor.state.doc)).toEqual(animationHistoryShape(before))
  editor.dispose()
})

test('ordinary Duplicate steps 10px down-right; top-level frames move right at unchanged y', () => {
  const { editor, a, parent } = rotatedFixture()
  editor.select([a.id]); const before = worldMatrix(editor.state.doc, a.id)
  editor.duplicate(); const copied = worldMatrix(editor.state.doc, editor.state.selection[0])
  expect(copied[4] - before[4]).toBeCloseTo(10, 8)
  expect(copied[5] - before[5]).toBeCloseTo(10, 8)
  editor.undo(); editor.select([parent.id]); const box = editor.selectionBounds()!
  editor.duplicate(); const duplicated = editor.selectionBounds()!
  expect(duplicated.x).toBeCloseTo(box.x + box.width + 24, 10)
  expect(duplicated.y).toBeCloseTo(box.y, 10)
  editor.dispose()
})

test('context commands flip, order and unlock inherited locks through reversible editor changes', async () => {
  const { editor, a, b, parent } = rotatedFixture()
  editor.select([a.id]); const before = editor.state.doc, box = editor.selectionBounds()!
  await dispatchEditorCommand(editor, 'flip-horizontal')
  const expected = multiply([-1, 0, 0, 1, 2 * box.x + box.width, 0], worldMatrix(before, a.id))
  worldMatrix(editor.state.doc, a.id).forEach((value, index) => expect(value).toBeCloseTo(expected[index], 10))
  editor.undo(); expect(editor.state.doc).toEqual(before)
  await dispatchEditorCommand(editor, 'bring-to-front')
  expect(editor.state.doc.nodes[parent.id].children).toEqual([b.id, a.id])
  editor.undo(); expect(editor.state.doc.nodes[parent.id].children).toEqual([a.id, b.id])
  editor.update([parent.id], { locked: true }, 'lock ancestor')
  expect(canvasMenuItems(editor).find((item) => item.command === 'delete')?.disabled).toBe(true)
  expect(canvasMenuItems(editor).find((item) => item.command === 'unlock-selection')?.label).toBe('解锁图层及父级')
  await dispatchEditorCommand(editor, 'unlock-selection')
  expect(editor.state.doc.nodes[parent.id].locked).toBe(false)
  editor.undo(); expect(editor.state.doc.nodes[parent.id].locked).toBe(true)
  editor.select([parent.id])
  await dispatchEditorCommand(editor, 'hide-selection')
  expect(editor.state.doc.nodes[parent.id].visible).toBe(false)
  editor.undo(); expect(editor.state.doc.nodes[parent.id].visible).toBe(true)
  editor.dispose()
})

test('the menu lists applicable operations for empty, multiple, text, vector and locked selections', () => {
  const { editor, a, b } = rotatedFixture()
  editor.select([])
  expect(canvasMenuItems(editor).some((item) => item.command === 'delete')).toBe(false)
  expect(canvasMenuItems(editor).some((item) => item.command === 'paste-here')).toBe(true)
  editor.select([a.id, b.id])
  expect(canvasMenuItems(editor).find((item) => item.command === 'group')?.disabled).toBe(false)
  expect(canvasMenuItems(editor).some((item) => item.command === 'convert-vector')).toBe(true)
  editor.update([a.id], { kind: 'text' }, 'text'); editor.select([a.id])
  expect(canvasMenuItems(editor).some((item) => item.command === 'convert-vector' || item.command === 'outline-stroke')).toBe(false)
  editor.update([b.id], { strokes: [stroke()] }, 'stroke'); editor.select([b.id])
  expect(canvasMenuItems(editor).some((item) => item.command === 'outline-stroke')).toBe(true)
  editor.update([b.id], { locked: true }, 'lock')
  expect(canvasMenuItems(editor).find((item) => item.command === 'cut')?.disabled).toBe(true)
  expect(canvasMenuItems(editor).find((item) => item.command === 'unlock-selection')?.disabled).toBe(false)
  editor.dispose()
})

test('right-edge and bottom-edge menus clamp into the viewport', () => {
  expect(clampContextMenu({ x: 995, y: 935 }, { width: 252, height: 600 }, { width: 1000, height: 940 })).toEqual({ x: 740, y: 332 })
  expect(clampContextMenu({ x: -5, y: -8 }, { width: 252, height: 100 }, { width: 1000, height: 940 })).toEqual({ x: 8, y: 8 })
})

test('explicit ellipse conversion produces editable curves rather than a 96-edge polygon and undoes once', async () => {
  const document = blank('smooth conversion'), ellipse = node('ellipse', 0.25, 7.5, 123.5, 89.25)
  document.nodes[ellipse.id] = ellipse; document.pages[0].children.push(ellipse.id)
  const editor = new Editor(document); editor.select([ellipse.id]); const before = editor.state.doc
  await dispatchEditorCommand(editor, 'convert-vector')
  const converted = editor.state.doc.nodes[ellipse.id]
  expect(converted.kind).toBe('vector')
  expect(converted.network?.vertices).toHaveLength(4)
  expect(converted.network?.edges).toHaveLength(4)
  expect(converted.network?.edges.every(edge => edge.c1 && edge.c2)).toBe(true)
  editor.undo(); expect(editor.state.doc).toEqual(before)
  editor.dispose()
})
