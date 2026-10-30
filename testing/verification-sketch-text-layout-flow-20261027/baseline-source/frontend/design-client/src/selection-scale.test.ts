import { afterEach, expect, test } from 'vitest'
import { Editor } from './engine'
import { blank, node, paint, stroke, effect, validateDocument } from './model'
import { apply, around, multiply, worldMatrix } from './geometry'
import { scaleAnchor, scaleInputFactor, selectionScaleFrame } from './selection-scale'
import { VectorEngine } from './generated/design-kernel/design_kernel'
const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach(e => e.dispose()))
test('scale input distinguishes a 1px dimension from a multiplier and rejects invalid arithmetic', () => {
  expect(scaleInputFactor('2x')).toBe(2); expect(scaleInputFactor('200%')).toBe(2)
  expect(scaleInputFactor('150', 100)).toBe(1.5); expect(scaleInputFactor('2', 1)).toBe(2)
  for (const value of ['2x', '0', '1/0']) expect(() => scaleInputFactor(value, 1)).toThrow()
})
function fixture() {
  const doc = blank(), frame = node('frame', 10, 20, 100, 80), child = node('rectangle', 8, 12, 40, 30)
  frame.children = [child.id]; frame.fills = []; frame.clip = false
  child.strokes = [{ ...stroke(), width: 2.5, dash: '4 2' }]; child.effects = [{ ...effect('shadow'), radius: 3.5, x: 2, y: 3 }]
  doc.nodes = { [frame.id]: frame, [child.id]: child }; doc.pages[0].children = [frame.id]
  const editor = new Editor(doc); editors.push(editor); editor.select([frame.id]); return { editor, frame, child }
}
test('Scale center matches the live Figma 256→512 center anchor without changing native local content', () => {
  const { editor, frame, child } = fixture()
  editor.update([frame.id], { width: 256, height: 256, transform: [1, 0, 0, 1, 5704, 96] })
  const before = editor.state.doc
  expect(editor.scaleSelection(2)).toBe(true)
  expect(editor.state.doc.nodes[frame.id].transform).toEqual([2, 0, 0, 2, 5576, -32])
  expect(editor.state.doc.nodes[child.id]).toEqual(before.nodes[child.id])
  expect(selectionScaleFrame(editor.state.doc, editor.state.page, [frame.id]).width).toBe(512)
  expect(validateDocument(JSON.parse(JSON.stringify(editor.state.doc)))).toEqual(editor.state.doc)
  editor.undo(); expect(editor.state.doc).toEqual(before)
  editor.redo(); expect(editor.state.doc.nodes[frame.id].transform).toEqual([2, 0, 0, 2, 5576, -32])
})
test('all nine anchors remain fixed through reflected/sheared parents and fractional scaling', () => {
  for (let anchor = 0; anchor < 9; anchor++) {
    const { editor, frame, child } = fixture()
    editor.update([frame.id], { transform: [-.8, .6, .4, 1.2, 140.125, -60.25] }); editor.select([child.id])
    const before = editor.state.doc, scaleFrame = selectionScaleFrame(before, editor.state.page, [child.id]), at = scaleAnchor(scaleFrame, anchor)
    const expected = multiply(around(at, [1.375, 0, 0, 1.375, 0, 0]), worldMatrix(before, child.id))
    expect(editor.scaleSelection(1.375, anchor)).toBe(true)
    worldMatrix(editor.state.doc, child.id).forEach((v, i) => expect(v).toBeCloseTo(expected[i], 10))
    const after = scaleAnchor(selectionScaleFrame(editor.state.doc, editor.state.page, [child.id]), anchor)
    expect(after.x).toBeCloseTo(at.x, 10); expect(after.y).toBeCloseTo(at.y, 10)
    editor.undo(); expect(editor.state.doc).toEqual(before)
  }
})
test('nested selection scales only its root; locked ancestors and invalid factors do not mutate history', () => {
  const { editor, frame, child } = fixture(); editor.select([frame.id, child.id]); const before = editor.state.doc
  expect(editor.scaleSelection(2, 0)).toBe(true)
  expect(worldMatrix(editor.state.doc, child.id)[0]).toBe(2)
  editor.undo(); expect(editor.state.doc).toEqual(before)
  for (const factor of [0, -1, NaN, Infinity, 10001]) { expect(editor.scaleSelection(factor)).toBe(false); expect(editor.state.doc).toEqual(before) }
  editor.update([frame.id], { locked: true }, 'lock'); editor.select([child.id]); const locked = editor.state.doc
  expect(editor.scaleSelection(2)).toBe(false); expect(editor.state.doc).toBe(locked)
})
test('Scale uses the same CPU material, stroke and gradient algorithm as an equivalent camera transform', () => {
  const { editor, frame, child } = fixture()
  editor.update([frame.id], { transform: [1, 0, 0, 1, 0, 0] })
  editor.update([child.id], { fills: [{ ...paint('#ff0000'), kind: 'linear', stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }] }] })
  expect(editor.state.doc.nodes[child.id].fills[0].kind).toBe('linear')
  const before = editor.state.doc; expect(editor.scaleSelection(2, 0)).toBe(true)
  const kernel = new VectorEngine()
  try {
    const render = (doc: typeof before, zoom: number) => { kernel.load_document(JSON.stringify(doc)); return kernel.render_rgba(JSON.stringify({ pageId: editor.state.page, width: 256, height: 256, view: { x: 0, y: 0, zoom }, transparent: true, rasterProfile: 'figma' })) }
    const expected = render(before, 2), actual = render(editor.state.doc, 1)
    expect(expected.some((v, i) => i % 4 === 3 && v > 0)).toBe(true)
    expect(actual).toEqual(expected)
  } finally { kernel.free() }
})
