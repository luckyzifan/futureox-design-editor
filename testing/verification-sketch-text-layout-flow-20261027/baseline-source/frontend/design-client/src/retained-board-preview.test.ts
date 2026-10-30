import { expect, test } from 'vitest'
import { blank, node, effect } from './model'
import { scene } from './geometry'
import { retainedBoardPlan, retainedBoardOffset } from './retained-board-preview'
import { kernelBounds } from './kernel/picking'
import { geometry_bounds_json } from './generated/design-kernel/design_kernel'

test('isolated whole-board translation retains pixels, but overlap or content edits invalidate them', () => {
  const d = blank(), a = node('frame', 40, 20, 100, 80), b = node('frame', 280, 20, 100, 80)
  d.nodes = { [a.id]: a, [b.id]: b }; d.pages[0].children = [a.id, b.id]
  const plan = retainedBoardPlan(d, d.pages[0].id, [b.id])!
  expect(plan).not.toBeNull()
  const moved = { ...d, nodes: { ...d.nodes, [b.id]: { ...b, transform: [1,0,0,1,260,30] as typeof b.transform } } }
  expect(retainedBoardOffset(plan, moved)).toEqual({ x: -20, y: 10 })
  expect(retainedBoardOffset(plan, { ...d, nodes: { ...d.nodes, [a.id]: { ...a, opacity: .5 } } })).toBeNull()
  moved.nodes[b.id].transform[4] = 100
  expect(retainedBoardOffset(plan, moved)).toBeNull()
  a.effects = [effect('shadow')]; a.effects[0].radius = 100
  expect(retainedBoardPlan(d, d.pages[0].id, [b.id])).toBeNull()
})

test('empty imported paths stay at their transformed origin instead of expanding distant groups back to world zero', () => {
  const d = blank(), g = node('group', 4000, 50, 100, 100), empty = node('vector', 10, 15, 0, 0)
  empty.network = { vertices: [], edges: [], fillRule: 'nonzero' }
  g.children = [empty.id]; d.nodes = { [g.id]: g, [empty.id]: empty }; d.pages[0].children = [g.id]
  const entries = scene(d, d.pages[0].id)
  expect(entries[1].bounds).toEqual({ x: 4010, y: 65, width: 0, height: 0 })
  expect(entries[0].bounds.x).toBe(4010)
})

test('translation-reused bounds agree with direct Rust extrema under rotation, shear and reflection', () => {
  const n = node('ellipse', 0, 0, 137, 83)
  for (const matrix of [[1,.2,.3,1,123.25,-60.5],[-.5,.3,.9,1,6500.125,900.875],[0,1,-1,0,-450.5,300.25]] as typeof n.transform[]) {
    const direct = JSON.parse(geometry_bounds_json(JSON.stringify(n), JSON.stringify(matrix)))
    const cached = kernelBounds(n, matrix)!
    for (const field of ['x','y','width','height'] as const) expect(cached[field]).toBeCloseTo(direct[field], 8)
  }
})
