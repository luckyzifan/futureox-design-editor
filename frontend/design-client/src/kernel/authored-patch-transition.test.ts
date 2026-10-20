import { expect, test } from 'vitest'
import { blank, node } from '../model'
import { boundedPatchWire, prepareAuthoredPatchTransition, supportsAcknowledgedPropertyPatch } from './authored-patch-transition'
function fixture() {
  const before = blank(), shape = node('rectangle', 1, 2, 20, 30)
  Object.assign(shape, { extension: { absentVsNull: null, values: [-0, 'unknown'] } })
  Object.assign(before, { extension: { unchanged: true } })
  before.nodes[shape.id] = shape; before.pages[0].children = [shape.id]
  const after = { ...before, nodes: { ...before.nodes, [shape.id]: { ...shape, transform: [1, 0, 0, 1, 7, 9] as typeof shape.transform } } }
  return { before, after, shape }
}
test('complete immutable property transitions certify edits and undo without changing unknown authored data', () => {
  const { before, after, shape } = fixture(), transition = prepareAuthoredPatchTransition(before, after)
  expect(transition.canAcknowledge).toBe(true); expect(transition.patch.nodes[shape.id]).toBe(after.nodes[shape.id])
  expect(prepareAuthoredPatchTransition(after, before).canAcknowledge).toBe(true)
  expect((after.nodes[shape.id] as any).extension).toBe((shape as any).extension)
  expect(Object.is((after.nodes[shape.id] as any).extension.values[0], -0)).toBe(true)
})
test('unknown roots, field absence/null, topology, resources, animation and node insertion/deletion stay unsupported', () => {
  const { before, after, shape } = fixture()
  for (const changed of [
    { ...after, extension: null }, { ...after, fonts: {} }, { ...after, animations: [] },
    { ...after, nodes: { ...after.nodes, [shape.id]: { ...after.nodes[shape.id], children: ['new'] } } },
    { ...after, nodes: { ...after.nodes, [shape.id]: { ...after.nodes[shape.id], fills: [] } } },
    { ...after, nodes: { ...after.nodes, [shape.id]: { ...after.nodes[shape.id], extension: null } } },
    { ...after, nodes: {} }, { ...after, nodes: { ...after.nodes, added: { ...shape, id: 'added' } } },
  ]) expect(prepareAuthoredPatchTransition(before, changed).canAcknowledge).toBe(false)
  const animated = { ...before, animations: [{ id: 'animation' }] as any }
  expect(prepareAuthoredPatchTransition(animated, { ...after, animations: animated.animations }).canAcknowledge).toBe(false)
  const missing = { ...before } as any; delete missing.extension
  expect(prepareAuthoredPatchTransition(before, missing).canAcknowledge).toBe(false)
})
test('bounded proof rejects malformed numeric transforms and oversized edits without blocking legacy patch construction', () => {
  const { before, after, shape } = fixture()
  const patch = prepareAuthoredPatchTransition(before, after).patch
  expect(supportsAcknowledgedPropertyPatch(before, { ...patch, nodes: { [shape.id]: { ...after.nodes[shape.id], transform: [1, 0, 0, 1, NaN, 2] } } })).toBe(false)
  expect(boundedPatchWire('a'.repeat(21845))).toBe(true); expect(boundedPatchWire('a'.repeat(21846))).toBe(false)
  const nodes = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`n${i}`, { ...shape, id: `n${i}` }]))
  const many = { ...before, nodes }, changed = { ...many, nodes: Object.fromEntries(Object.entries(nodes).map(([id, n]) => [id, { ...n, opacity: .5 }])) }
  expect(prepareAuthoredPatchTransition(many, changed).canAcknowledge).toBe(false)
})
