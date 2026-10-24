import { expect, test, vi } from 'vitest'
import { Editor } from '../engine'
import { figmaFixture } from '../figma-fixtures'
import * as picking from '../kernel/picking'
import * as geometry from '../geometry'
import { blank, node } from '../model'
import { prepareSelectionArrangement, prepareSelectionWrap, selectionCommandAdmission, prepareSelectionUnwrap, applySelectionUnwrap } from './selection-command'
import { unionBounds } from './affine'

test('mutable simple batch vectors never reuse an old WeakMap node key or trigger whole-document layout', () => {
  const doc = figmaFixture('curve'), editor = new Editor(doc), draft = structuredClone(editor.state.doc)
  const frame = draft.nodes[draft.pages[0].children[0]], child = draft.nodes[frame.children[0]]
  const bounds = vi.spyOn(picking, 'kernelBounds'), layout = vi.spyOn(picking, 'kernelLayout')
  try {
    const before = prepareSelectionWrap(draft, [child.id], { fresh: false })
    for (const point of child.network!.vertices) point.x += 20
    for (const edge of child.network!.edges) { if (edge.c1) edge.c1.x += 20; if (edge.c2) edge.c2.x += 20 }
    const after = prepareSelectionWrap(draft, [child.id], { fresh: false })
    expect(after.transform[4] - before.transform[4]).toBeCloseTo(20, 8)
    expect(bounds).toHaveBeenCalledTimes(2); expect(bounds.mock.calls.every(([record]) => record !== child)).toBe(true)
    expect(bounds.mock.calls[0][0]).not.toBe(bounds.mock.calls[1][0]); expect(layout).not.toHaveBeenCalled()
  } finally { bounds.mockRestore(); layout.mockRestore(); editor.dispose() }
})
test('availability reuses supplied immutable parent index without a whole-tree traversal', () => {
  const doc = blank(), parent = node('frame'), child = node('rectangle')
  doc.nodes = { [parent.id]: parent, [child.id]: child }; doc.pages[0].children = [parent.id]; parent.children = [child.id]
  const parents = geometry.allParents(doc), read = vi.spyOn(geometry, 'allParents')
  const original = doc.nodes
  doc.nodes = new Proxy(original, { ownKeys() { throw Error('Unexpected full node scan during availability') } })
  try { expect(selectionCommandAdmission(doc, [child.id], 'align', parents)).toEqual({ ok: true }); expect(read).not.toHaveBeenCalled() }
  finally { read.mockRestore() }
})
test('many selected wrappers rewrite each shared parent list once and retain sibling order', () => {
  const doc = blank(), page = doc.pages[0], count = 3000
  const wrappers = Array.from({ length: count }, (_, i) => {
    const wrapper = node('group', i * 10, 0, 5, 5), child = node('rectangle', 1, 1, 2, 2)
    wrapper.children = [child.id]; doc.nodes[wrapper.id] = wrapper; doc.nodes[child.id] = child; page.children.push(wrapper.id)
    return { wrapper, child }
  })
  const plan = prepareSelectionUnwrap(doc, wrappers.map(entry => entry.wrapper.id), { fresh: true })
  let reads = 0
  page.children = new Proxy(page.children, { get(target, key, receiver) {
    if (typeof key === 'string' && /^(?:0|[1-9]\d*)$/.test(key)) reads++
    return Reflect.get(target, key, receiver)
  } })
  const revealed = applySelectionUnwrap(doc, plan)
  expect(reads).toBeLessThanOrEqual(count + 4)
  expect(page.children).toEqual(wrappers.map(entry => entry.child.id)); expect(revealed).toEqual([...page.children])
  expect(Object.keys(doc.nodes)).toHaveLength(count)
})
test('large bounds union uses bounded-arity operations and keeps negative extents semantics', () => {
  const rectangles = Array.from({ length: 150000 }, (_, i) => ({ x: i, y: -i, width: 2, height: 2 }))
  expect(unionBounds(rectangles)).toEqual({ x: 0, y: -149999, width: 150001, height: 150001 })
  expect(unionBounds([{ x: 5, y: 7, width: -2, height: -3 }])).toEqual({ x: 3, y: 4, width: 2, height: 3 })
})

// The cubic's maximum y is 45 at t=1/2, independent of its stored size.
// These assertions use that analytic extremum, not kernelBounds as their oracle.
function preciseSelectionFixture() {
  const doc = blank(), shape = node('vector', 10, 20, 200, 200), other = node('rectangle', 300, 200, 20, 30)
  doc.schemaVersion = 16; shape.strokes = []
  shape.transform = [2, 0, 0, 3, 10, 20]
  shape.vectorGeometry = { fillRule: 'nonzero', fill: [
    { move: [0, 0] }, { cubic: [0, 60, 60, 60, 60, 0] }, { line: [0, 0] }, 'close',
  ] }
  doc.nodes = { [shape.id]: shape, [other.id]: other }; doc.pages[0].children = [shape.id, other.id]
  return { doc, shape, other }
}
test('precise render curves use true transformed extrema for wrap and alignment', () => {
  const { doc, shape, other } = preciseSelectionFixture()
  const wrapped = prepareSelectionWrap(doc, [shape.id], { fresh: false })
  expect(wrapped.transform).toEqual([1, 0, 0, 1, 10, 20])
  expect(wrapped.width).toBeCloseTo(120, 9); expect(wrapped.height).toBeCloseTo(135, 9)
  const aligned = prepareSelectionArrangement(doc, [shape.id, other.id], 'y', 'end', { fresh: false })
  // other ends at y=230; the cubic ends at y=155, so only it moves by 75.
  expect(aligned.patches).toEqual([{ id: shape.id, transform: [2, 0, 0, 3, 10, 95] }])
})
test('mutable precise curves get new exact-bound keys after edits, without layout', () => {
  const { doc, shape } = preciseSelectionFixture()
  const bounds = vi.spyOn(picking, 'kernelBounds'), layout = vi.spyOn(picking, 'kernelLayout')
  try {
    const before = prepareSelectionWrap(doc, [shape.id], { fresh: false })
    const cubic = shape.vectorGeometry!.fill[1] as { cubic: [number, number, number, number, number, number] }
    cubic.cubic[1] = cubic.cubic[3] = 80
    const after = prepareSelectionWrap(doc, [shape.id], { fresh: false })
    expect(before.height).toBeCloseTo(135, 9); expect(after.height).toBeCloseTo(180, 9)
    expect(bounds).toHaveBeenCalledTimes(2)
    expect(bounds.mock.calls[0][0]).not.toBe(shape); expect(bounds.mock.calls[1][0]).not.toBe(shape)
    expect(bounds.mock.calls[0][0]).not.toBe(bounds.mock.calls[1][0]); expect(layout).not.toHaveBeenCalled()
  } finally { bounds.mockRestore(); layout.mockRestore() }
})
test('precise selection geometry fails closed when the kernel is unavailable', () => {
  const { doc, shape } = preciseSelectionFixture(), bounds = vi.spyOn(picking, 'kernelBounds').mockReturnValue(null)
  try { expect(() => prepareSelectionWrap(doc, [shape.id], { fresh: false })).toThrow('Exact selection geometry is unavailable') }
  finally { bounds.mockRestore() }
})
