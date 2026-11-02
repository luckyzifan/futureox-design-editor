import { expect, test } from 'vitest'
import { blank, node, paint, stroke, effect, defaultLayout, defaultSizing, type DesignNode } from '../model'
import { Editor } from '../engine'
import { worldMatrix } from '../geometry'
import { kernelLayout } from '../kernel/picking'
import { prepareBooleanCreate, applyBooleanCreate, type LiveBooleanOperation } from './boolean-command'
function fixture() {
  const doc = blank(), parent = node('frame', 30, 60, 500, 500), a = node('ellipse', 0, 0, 100, 100), b = node('ellipse', 40, 0, 100, 100)
  parent.transform = [1.3, .2, -.4, .8, 30, 60]
  a.fills = [paint('#ff0000')]; b.fills = [paint('#0000ff')]
  doc.nodes = Object.fromEntries([parent, a, b].map(n => [n.id, n])); doc.pages[0].children = [parent.id]; parent.children = [a.id, b.id]
  return { doc, parent, a, b }
}
for (const operation of ['union', 'subtract', 'intersect', 'exclude'] as LiveBooleanOperation[]) test(`${operation}: authored order, paint oracle, preserved operands and world transforms`, () => {
  const f = fixture(), before = structuredClone(f.doc)
  f.b.effects = [effect('shadow')]
  const p = prepareBooleanCreate(f.doc, [f.b.id, f.a.id], { operation, id: '30000000-0000-4000-8000-000000000001' }, { fresh: true }, 'verified-fill')
  expect(p.wrap.ids).toEqual([f.a.id, f.b.id])
  expect(p.styleSourceId).toBe(operation === 'subtract' ? f.a.id : f.b.id)
  expect(p.wrapper.fills).toEqual(f.doc.nodes[p.styleSourceId].fills)
  expect(p.wrapper.effects).toEqual(f.doc.nodes[p.styleSourceId].effects)
  applyBooleanCreate(f.doc, p)
  expect(f.doc.nodes['30000000-0000-4000-8000-000000000001'].children).toEqual([f.a.id, f.b.id]); expect(f.doc.nodes['30000000-0000-4000-8000-000000000001'].network).toBeUndefined()
  for (const id of [f.a.id, f.b.id]) {
    worldMatrix(f.doc, id).forEach((value, i) => expect(value).toBeCloseTo(worldMatrix(before, id)[i], 10))
    expect(f.doc.nodes[id].fills).toEqual(before.nodes[id].fills)
  }
})
test('UI legacy fill-only acceptance and bottom paint remain unchanged', () => {
  const f = fixture(); f.a.strokes = [stroke('#ff0000', 4)]
  const e = new Editor(f.doc)
  try {
    const original = e.state.doc.nodes[f.a.id]
    e.select([f.b.id, f.a.id]); e.group(false, 'union')
    const result = e.state.doc.nodes[e.state.selection[0]]
    expect(result.booleanOperation).toBe('union'); expect(result.fills).toEqual(original.fills.map(p => ({ ...p, image: p.image ?? null })))
    expect(result.strokes).toEqual(original.strokes.map(s => ({ ...s, paint: { ...s.paint, image: s.paint.image ?? null } }))); expect(result.effects).toEqual([])
  } finally { e.dispose() }
  expect(() => prepareBooleanCreate(f.doc, [f.a.id, f.b.id], { operation: 'union' }, { fresh: true }, 'verified-fill')).toThrow(/outline visible strokes/)
})
test('legacy frame input stays accepted by shared planner; verified admission explicitly rejects it', () => {
  const f = fixture(); f.a.kind = 'frame'
  expect(prepareBooleanCreate(f.doc, [f.a.id, f.b.id], { operation: 'subtract' }, { fresh: true }, 'existing-fill').wrap.ids).toEqual([f.a.id, f.b.id])
  expect(() => prepareBooleanCreate(f.doc, [f.a.id, f.b.id], { operation: 'subtract' }, { fresh: true }, 'verified-fill')).toThrow(/text, frames and Symbols/)
})
for (const edit of [
  (n: DesignNode) => { n.locked = true },
  (n: DesignNode) => { n.kind = 'text' },
  (n: DesignNode) => { n.mask = true },
  (n: DesignNode) => { n.strokes = [stroke()] },
]) test('unsupported mixed operands reject without partial writes', () => {
  const f = fixture(); edit(f.b); const before = structuredClone(f.doc)
  expect(() => prepareBooleanCreate(f.doc, [f.a.id, f.b.id], { operation: 'subtract' }, { fresh: true }, 'verified-fill')).toThrow()
  expect(f.doc).toEqual(before)
})
test('nested locked operand and stale derived geometry reject before writes', () => {
  const f = fixture(), nested = node('vector', 0, 0, 100, 100)
  nested.booleanOperation = 'union'; nested.fills = [paint()]; nested.strokes = []; nested.children = [f.a.id]
  f.doc.nodes[nested.id] = nested; f.parent.children = [nested.id, f.b.id]
  f.a.locked = true
  expect(() => prepareBooleanCreate(f.doc, [nested.id, f.b.id], { operation: 'subtract' }, { fresh: true }, 'verified-fill')).toThrow(/locked/)
  f.a.locked = false
  expect(() => prepareBooleanCreate(f.doc, [nested.id, f.b.id], { operation: 'subtract' }, { fresh: false }, 'verified-fill')).toThrow(/not yet proven fresh/)
})

test('65 operands reject at the shared admission limit without native work', () => {
  const doc = blank(), nodes = Array.from({ length: 65 }, () => node('ellipse'))
  doc.nodes = Object.fromEntries(nodes.map(n => [n.id, n])); doc.pages[0].children = nodes.map(n => n.id)
  expect(() => prepareBooleanCreate(doc, nodes.map(n => n.id), { operation: 'union' }, { fresh: true }, 'verified-fill')).toThrow(/2–64/)
})
test('union takes the front-most sibling slot and freezes operand sizing', () => {
  const doc = blank(), frame = node('frame', 0, 0, 400, 200)
  const a = node('rectangle', 10, 20, 40, 40), mid = node('rectangle', 80, 20, 20, 20), c = node('rectangle', 140, 30, 50, 30)
  for (const shape of [a, mid, c]) shape.fills = [paint('#3366ff')]
  a.sizing = { ...defaultSizing(), width: 'hug', height: 'fill' }
  frame.children = [a.id, mid.id, c.id]
  doc.nodes = Object.fromEntries([frame, a, mid, c].map(item => [item.id, item]))
  doc.pages[0].children = [frame.id]
  const before = structuredClone(doc)
  const plan = prepareBooleanCreate(doc, [c.id, a.id], { operation: 'union', id: '30000000-0000-4000-8000-000000000010' }, { fresh: true }, 'existing-fill')
  expect(plan.wrap.index).toBe(2)
  expect(plan.wrapper.name).toBe('联集')
  applyBooleanCreate(doc, plan)
  expect(frame.children.map(id => doc.nodes[id].booleanOperation ? 'union' : id)).toEqual([mid.id, 'union'])
  expect(doc.nodes[plan.wrapper.id].children).toEqual([a.id, c.id])
  expect(doc.nodes[a.id].sizing).toMatchObject({ width: 'fixed', height: 'fixed' })
  for (const id of [a.id, mid.id, c.id]) worldMatrix(doc, id).forEach((value, index) => expect(value).toBeCloseTo(worldMatrix(before, id)[index], 8))
})

test('union inside auto layout becomes one fixed flow item and keeps operand spacing', () => {
  const doc = blank(), frame = node('frame', 0, 0, 320, 80)
  frame.layout = { ...defaultLayout(), mode: 'horizontal', gap: 10, padding: [0, 0, 0, 0] }
  const a = node('rectangle', 0, 0, 40, 40), b = node('rectangle', 0, 0, 40, 40), c = node('rectangle', 0, 0, 30, 20)
  for (const shape of [a, b, c]) shape.fills = [paint('#2244aa')]
  frame.children = [a.id, b.id, c.id]
  doc.nodes = Object.fromEntries([frame, a, b, c].map(item => [item.id, item]))
  doc.pages[0].children = [frame.id]
  const editor = new Editor(doc)
  try {
    const before = editor.state.doc
    const dx = worldMatrix(before, c.id)[4] - worldMatrix(before, a.id)[4]
    const span = worldMatrix(before, c.id)[4] + before.nodes[c.id].width - worldMatrix(before, a.id)[4]
    editor.select([a.id, c.id])
    editor.group(false, 'union')
    const parent = editor.state.doc.nodes[frame.id]
    const booleanId = parent.children.find(id => editor.state.doc.nodes[id].booleanOperation)
    expect(booleanId).toBeTruthy()
    expect(parent.children).toEqual([b.id, booleanId])
    expect(parent.layout?.mode).toBe('horizontal')
    const result = editor.state.doc.nodes[booleanId!]
    expect(result.name).toBe('联集')
    expect(result.layout).toBeUndefined()
    expect(result.children).toEqual([a.id, c.id])
    expect(result.width).toBeCloseTo(span, 6)
    expect(worldMatrix(editor.state.doc, c.id)[4] - worldMatrix(editor.state.doc, a.id)[4]).toBeCloseTo(dx, 6)
    expect(kernelLayout(editor.state.doc).nodes[booleanId!].children).toEqual([a.id, c.id])
  } finally { editor.dispose() }
})

test('verified-fill allows an auto-layout parent and still rejects a masked ancestor', () => {
  const doc = blank(), frame = node('frame', 0, 0, 200, 80)
  frame.layout = { ...defaultLayout(), padding: [0, 0, 0, 0] }
  const a = node('ellipse', 0, 0, 40, 40), b = node('ellipse', 60, 0, 40, 40)
  a.fills = [paint('#ff0000')]; b.fills = [paint('#0000ff')]
  frame.children = [a.id, b.id]
  doc.nodes = Object.fromEntries([frame, a, b].map(item => [item.id, item]))
  doc.pages[0].children = [frame.id]
  expect(prepareBooleanCreate(doc, [a.id, b.id], { operation: 'subtract' }, { fresh: true }, 'verified-fill').wrap.index).toBe(1)
  frame.mask = true
  expect(() => prepareBooleanCreate(doc, [a.id, b.id], { operation: 'subtract' }, { fresh: true }, 'verified-fill')).toThrow(/masked ancestors/)
})

test('non-UUID requested wrapper ID rejects before mutation', () => {
  const f = fixture(), before = structuredClone(f.doc)
  expect(() => prepareBooleanCreate(f.doc, [f.a.id, f.b.id], { operation: 'subtract', id: 'invalid-wrapper' }, { fresh: true }, 'verified-fill')).toThrow(/UUID/)
  expect(f.doc).toEqual(before)
})
