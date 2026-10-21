import { expect, test } from 'vitest'
import { blank, node, paint, stroke, effect, type DesignNode } from '../model'
import { Editor } from '../engine'
import { worldMatrix } from '../geometry'
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
test('non-UUID requested wrapper ID rejects before mutation', () => {
  const f = fixture(), before = structuredClone(f.doc)
  expect(() => prepareBooleanCreate(f.doc, [f.a.id, f.b.id], { operation: 'subtract', id: 'invalid-wrapper' }, { fresh: true }, 'verified-fill')).toThrow(/UUID/)
  expect(f.doc).toEqual(before)
})
