import { expect, test } from 'vitest'
import { planArrangement, translatedLocalTransform } from './arrangement-plan'
import { planChildReparent, planContainerPlacement, reparentedTransform } from './structure-plan'
import { applyChildListPlan, applyTransformPlan } from './apply-plan'
import { apply, inverse, multiply, rotate, translate } from './affine'
import { CORE_SELECTION_PROFILE } from './profiles'
import { blank, node, type Bounds, type Matrix } from '../model'
const rect = (x: number, y: number, width: number, height: number): Bounds => ({ x, y, width, height })
for (const profile of [CORE_SELECTION_PROFILE]) {
  for (const axis of ['x', 'y'] as const) for (const mode of ['start', 'center', 'end'] as const) test(`${profile}: ${axis}/${mode} planning is pure`, () => {
    const boxes = [rect(10, 10, 20, 20), rect(70, 70, 30, 30)], before = structuredClone(boxes)
    const result = planArrangement(profile, boxes, axis, mode)!
    expect(result.profile).toBe(profile); expect(boxes).toEqual(before)
    const aligned = boxes.map((box, index) => box[axis] + result.offsets[index][axis] + (mode === 'center' ? box.width / 2 : mode === 'end' ? box.width : 0))
    expect(aligned[0]).toBe(aligned[1]); expect(result.offsets.every(p => p[axis === 'x' ? 'y' : 'x'] === 0)).toBe(true)
  })
  test(`${profile}: parent, equal gaps, primitive minimum, overlap arithmetic and stable ties`, () => {
    expect(planArrangement(profile, [], 'x', 'start')).toBeNull()
    expect(planArrangement(profile, [rect(1, 2, 10, 20)], 'x', 'start')).toBeNull()
    expect(planArrangement(profile, [rect(20, 5, 30, 10)], 'x', 'center', rect(0, 0, 100, 80))!.offsets).toEqual([{ x: 15, y: 0 }])
    const boxes = [rect(100, 0, 10, 10), rect(0, 0, 10, 10), rect(30, 0, 20, 10)], before = structuredClone(boxes)
    expect(planArrangement(profile, boxes, 'x', 'distribute')!.offsets).toEqual([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 15, y: 0 }]); expect(boxes).toEqual(before)
    expect(planArrangement(profile, boxes.slice(0, 2), 'x', 'distribute')).toBeNull()
    expect(planArrangement(profile, [rect(0, 0, 20, 10), rect(10, 0, 20, 10), rect(20, 0, 20, 10)], 'x', 'distribute')!.offsets.map(p => p.x)).toEqual([0, 0, 0])
    expect(planArrangement(profile, [rect(0, 0, 10, 10), rect(0, 0, 20, 10), rect(60, 0, 10, 10)], 'x', 'distribute')!.offsets.map(p => p.x)).toEqual([0, 25, 0])
  })
  test(`${profile}: sibling rewrite copies input, preserves interleaving and after-removal index`, () => {
    const lists = [{ parent: 'p', children: ['a', 'x', 'b', 'y', 'c'] }, { parent: 'g', children: [] as string[] }], original = structuredClone(lists)
    expect(planChildReparent(profile, [{ id: 'a', parent: 'p' }, { id: 'b', parent: 'p' }], lists, 'g').lists).toEqual([
      { parent: 'p', children: ['x', 'y', 'c'] }, { parent: 'g', children: ['a', 'b'] },
    ]); expect(lists).toEqual(original)
    expect(planChildReparent(profile, [{ id: 'a', parent: 'p' }, { id: 'b', parent: 'p' }], [lists[0]], 'p', 2).lists).toEqual([{ parent: 'p', children: ['x', 'y', 'a', 'b', 'c'] }])
    expect(planChildReparent(profile, [], [lists[0]], 'p', 0).lists).toEqual([lists[0]])
  })
  test(`${profile}: isolated apply preserves source snapshot and child world transforms`, () => {
    const doc = blank(), parent = node('frame'), child = node('rectangle', 7, 9), group = node('group', 2, 3)
    parent.transform = multiply(translate(10, 20), rotate(25)); parent.children = [child.id, group.id]
    doc.pages[0].children = [parent.id]; doc.nodes = { [parent.id]: parent, [child.id]: child, [group.id]: group }
    const before = structuredClone(doc), draft = structuredClone(doc), world = multiply(parent.transform, child.transform), newParentWorld = multiply(parent.transform, group.transform)
    applyChildListPlan(draft, planChildReparent(profile, [{ id: child.id, parent: parent.id }], [{ parent: parent.id, children: parent.children }, { parent: group.id, children: [] }], group.id))
    applyTransformPlan(draft, [{ id: child.id, transform: reparentedTransform(newParentWorld, world) }])
    expect(doc).toEqual(before); expect(draft.nodes[parent.id].children).toEqual([group.id]); expect(draft.nodes[group.id].children).toEqual([child.id])
    multiply(newParentWorld, draft.nodes[child.id].transform).forEach((value, i) => expect(value).toBeCloseTo(world[i], 10))
  })
}
test('world moves remain correct through rotated, reflected, skewed parents; singular rejects', () => {
  for (const parent of [multiply(translate(30, 20), rotate(30)), [-2, .4, .2, 3, 17, -8] as Matrix]) {
    const world = multiply(parent, translate(8, 10)), result = translatedLocalTransform(parent, world, { x: 12.5, y: 0 })
    const before = apply(world, { x: 0, y: 0 }), after = apply(multiply(parent, result), { x: 0, y: 0 })
    expect(after.x).toBeCloseTo(before.x + 12.5, 10); expect(after.y).toBeCloseTo(before.y, 10)
  }
  expect(() => inverse([0, 0, 0, 0, 0, 0])).toThrow('不可逆变换')
})
test('one Core wrapper contract uses parent-local bounds and admitted minimum dimensions', () => {
  const parent = multiply(translate(10, 20), rotate(30)), box = rect(8, 8, 100, 75)
  expect(planContainerPlacement(CORE_SELECTION_PROFILE, box, parent).transform).toEqual(translate(8, 8))
  expect(planContainerPlacement(CORE_SELECTION_PROFILE, rect(0, 0, 0, 0), parent)).toMatchObject({ width: .01, height: .01 })
})
test('invalid structural plans fail before touching caller-owned lists', () => {
  const lists = [{ parent: 'p', children: ['a'] }, { parent: 'g', children: [] as string[] }], before = structuredClone(lists)
  expect(() => planChildReparent(CORE_SELECTION_PROFILE, [{ id: 'missing', parent: 'p' }], lists, 'g')).toThrow('Missing reparent child')
  expect(() => planChildReparent(CORE_SELECTION_PROFILE, [{ id: 'a', parent: 'p' }, { id: 'a', parent: 'p' }], lists, 'g')).toThrow('Duplicate reparent child')
  expect(() => planChildReparent(CORE_SELECTION_PROFILE, [{ id: 'a', parent: 'p' }], lists, 'g', 2)).toThrow('Invalid reparent index')
  expect(lists).toEqual(before)
})

test('large sibling plans avoid function argument limits without changing order', () => {
  const doc = blank(), page = doc.pages[0], count = 150000
  page.children = Array.from({ length: count }, (_, index) => `id-${index}`)
  const plan = planChildReparent(CORE_SELECTION_PROFILE, [{ id: page.children[0], parent: page.id }], [{ parent: page.id, children: page.children }], page.id)
  applyChildListPlan(doc, plan)
  expect(page.children.length).toBe(count); expect(page.children[0]).toBe('id-1'); expect(page.children.at(-1)).toBe('id-0')
})


test.each([CORE_SELECTION_PROFILE])('%s: 150k moving and 150k siblings are scanned once without spread limits', profile => {
  const count = 150000, movingIds = Array.from({ length: count }, (_, i) => `move-${i}`)
  const siblings = Array.from({ length: count }, (_, i) => `stay-${i}`)
  let reads = 0
  const observed = (values: string[]) => new Proxy(values, { get(target, key, receiver) {
    if (typeof key === 'string' && /^(?:0|[1-9]\d*)$/.test(key)) reads++
    return Reflect.get(target, key, receiver)
  } })
  const plan = planChildReparent(profile, movingIds.map(id => ({ id, parent: 'source' })), [
    { parent: 'source', children: observed(movingIds) }, { parent: 'target', children: observed(siblings) },
  ], 'target', count / 2)
  expect(reads).toBe(count * 2)
  expect(plan.lists[0].children).toEqual([])
  expect(plan.lists[1].children).toHaveLength(count * 2)
  expect(plan.lists[1].children.slice(0, count / 2)).toEqual(siblings.slice(0, count / 2))
  expect(plan.lists[1].children.slice(count / 2, count / 2 + count)).toEqual(movingIds)
  expect(plan.lists[1].children.slice(count / 2 + count)).toEqual(siblings.slice(count / 2))
  expect(movingIds.length).toBe(count); expect(siblings.length).toBe(count)
})

test('multi-parent moving order and duplicate-source legacy first-removal semantics are retained', () => {
  const plan = planChildReparent(CORE_SELECTION_PROFILE, [{ id: 'b', parent: 'p' }, { id: 'd', parent: 'q' }, { id: 'a', parent: 'p' }], [
    { parent: 'p', children: ['a', 'b', 'a', 'c'] }, { parent: 'q', children: ['d', 'e'] },
  ], 'p', 1)
  expect(plan.lists).toEqual([{ parent: 'p', children: ['a', 'b', 'd', 'a', 'c'] }, { parent: 'q', children: ['e'] }])
})


test('fractional distribution pins both endpoints exactly rather than accumulating roundoff', () => {
  const rects = [{ x: .1, y: 0, width: .2, height: 1 }, { x: .5, y: 0, width: .1, height: 1 }, { x: 1.3, y: 0, width: .2, height: 1 }]
  const plan = planArrangement(CORE_SELECTION_PROFILE, rects, 'x', 'distribute')!
  expect(plan.offsets[0]).toEqual({ x: 0, y: 0 }); expect(plan.offsets[2]).toEqual({ x: 0, y: 0 })
})
