import { expect, test } from 'vitest'
import { constrainToAngles, deleteAndHealVertex, dragBezierHandle, mirrorAcross, penHandleMove, penPointerDown, popPenPoint, type PenDraft } from './pen-geometry'
import type { Network } from './model'

const empty = (): PenDraft => ({ network: { vertices: [], edges: [], fillRule: 'evenodd' }, last: null, first: null })

test('shift snaps a pen segment to the nearest 45 degrees without changing its length', () => {
  const placed = constrainToAngles({ x: 100, y: 100 }, { x: 160, y: 130 })
  const length = Math.hypot(60, 30)
  expect(placed.x).toBeCloseTo(100 + length * Math.cos(Math.PI / 4), 6)
  expect(placed.y).toBeCloseTo(100 + length * Math.sin(Math.PI / 4), 6)
})

test('a drag mirrors the incoming handle and option leaves that side straight', () => {
  let draft = empty()
  draft = penPointerDown(draft, { x: 0, y: 0 }, false, 8).draft
  draft = penHandleMove(draft, draft.last!, { x: 0, y: 0 }, { x: 0, y: 40 }, false, false, 2)
  const second = penPointerDown(draft, { x: 100, y: 0 }, false, 8)
  draft = penHandleMove(second.draft, second.dragVertex!, { x: 100, y: 0 }, { x: 140, y: -30 }, false, false, 2)
  const edge = draft.network.edges[0]
  expect(edge.c1).toEqual({ x: 0, y: 40 })
  expect(edge.c2).toEqual(mirrorAcross({ x: 100, y: 0 }, { x: 140, y: -30 }))
  const independent = penHandleMove(second.draft, second.dragVertex!, { x: 100, y: 0 }, { x: 140, y: -30 }, true, false, 2)
  expect(independent.network.edges[0].c1).toEqual({ x: 0, y: 40 })
  expect(independent.network.edges[0].c2).toBeUndefined()
  expect(independent.outgoing).toEqual({ x: 140, y: -30 })
})

test('returning inside the drag threshold keeps the handle that was already pulled', () => {
  let draft = penPointerDown(empty(), { x: 100, y: 100 }, false, 8).draft
  draft = penHandleMove(draft, draft.last!, { x: 100, y: 100 }, { x: 120, y: 115 }, false, false, 2)
  const back = penHandleMove(draft, draft.last!, { x: 100, y: 100 }, { x: 100.25, y: 100.25 }, false, false, 2)
  expect(back).toBe(draft)
  expect(back.outgoing).toEqual({ x: 120, y: 115 })
})

test('clicking the first point of a triangle closes the path', () => {
  let draft = empty()
  draft = penPointerDown(draft, { x: 0, y: 0 }, false, 8).draft
  draft = penPointerDown(draft, { x: 80, y: 0 }, false, 8).draft
  draft = penPointerDown(draft, { x: 40, y: 50 }, false, 8).draft
  draft = penPointerDown(draft, { x: 1, y: 1 }, false, 8).draft
  expect(draft.closed).toBe(true)
  expect(draft.network.edges).toHaveLength(3)
  expect(draft.network.vertices).toHaveLength(3)
})

test('option-click heals a degree-2 point and undo removes the last placed point', () => {
  let draft = empty()
  for (const point of [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 20 }]) draft = penPointerDown(draft, point, false, 8).draft
  const healed = penPointerDown(draft, { x: 50, y: 0 }, true, 8)
  expect(healed.healed).toBe(true)
  expect(healed.draft.network.vertices).toHaveLength(2)
  expect(healed.draft.network.edges).toHaveLength(1)
  expect(healed.draft.network.edges[0].from).not.toBe(healed.draft.network.edges[0].to)
  const popped = popPenPoint(draft)
  expect(popped.network.vertices).toHaveLength(2)
  expect(popped.network.edges).toHaveLength(1)
  expect(popPenPoint(popPenPoint(popped)).network.vertices).toHaveLength(0)
})

test('clicking a segment inserts a point instead of starting a detached vertex', () => {
  let draft = empty()
  draft = penPointerDown(draft, { x: 0, y: 0 }, false, 8).draft
  draft = penPointerDown(draft, { x: 100, y: 0 }, false, 8).draft
  draft = { ...draft, last: null }
  const inserted = penPointerDown(draft, { x: 50, y: 1 }, false, 8)
  expect(inserted.draft.network.vertices).toHaveLength(3)
  expect(inserted.draft.network.edges).toHaveLength(2)
  expect(inserted.draft.last).toBe(inserted.dragVertex)
})

test('dragging a mirrored handle moves its sister, and alt does not', () => {
  const network: Network = {
    fillRule: 'nonzero',
    vertices: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 100, y: 0 }],
    edges: [
      { id: 'in', from: 'z', to: 'a', c2: { x: -30, y: 0 } },
      { id: 'out', from: 'a', to: 'b', c1: { x: 30, y: 0 } },
    ],
  }
  network.vertices.push({ id: 'z', x: -100, y: 0 })
  const moved = dragBezierHandle(network, 'out', 'c1', { x: 40, y: 20 }, false)
  expect(moved.edges.find(edge => edge.id === 'out')!.c1).toEqual({ x: 40, y: 20 })
  const sister = moved.edges.find(edge => edge.id === 'in')!.c2!
  expect(sister.x).toBeCloseTo(-40, 6)
  expect(sister.y).toBeCloseTo(-20, 6)
  const broken = dragBezierHandle(network, 'out', 'c1', { x: 40, y: 20 }, true)
  expect(broken.edges.find(edge => edge.id === 'in')!.c2).toEqual({ x: -30, y: 0 })
})

test('delete and heal drops a branch point and its edges when more than two meet', () => {
  const network: Network = {
    fillRule: 'evenodd',
    vertices: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 10, y: 0 }, { id: 'c', x: 0, y: 10 }, { id: 'd', x: -10, y: 0 }],
    edges: [
      { id: 'ab', from: 'a', to: 'b' },
      { id: 'ac', from: 'a', to: 'c' },
      { id: 'ad', from: 'a', to: 'd' },
    ],
  }
  const healed = deleteAndHealVertex(network, 'a')
  expect(healed.vertices.map(vertex => vertex.id).sort()).toEqual(['b', 'c', 'd'])
  expect(healed.edges).toHaveLength(0)
})
