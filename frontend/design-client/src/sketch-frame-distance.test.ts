import assert from 'node:assert/strict'
import { test } from 'vitest'
import { multiply } from './commands/affine'
import { blank, defaultLayout, defaultSizing, node, type DesignDocument, type DesignNode, type Matrix } from './model'
import {
  figmaPositionOffset,
  frameEdgeDisplayLocal,
  sketchFrameDistance,
  sketchFrameEdges,
  sketchNestedFramePins,
} from './sketch-frame-distance'

/** Frames read from the zip page of testing/fixtures/user-regression-20261109/117.sketch.
 * Path: page 117 → artboard 117 → group 主视觉 → shapePath image.png, masked by sibling 椭圆 63.
 * The published Sketch 2026.3.1 readout is the rounded form of these frames. */
const ARTBOARD = { x: -410, y: 358, width: 1922, height: 1080 }
const GROUP = { x: 263, y: 135, width: 1393, height: 945 }
const MASK = { x: 0, y: 0, width: 1393, height: 945 }
const IMAGE = { x: 0, y: 90.6031494140625, width: 1393, height: 762.819580078125 }

function parentsOf(doc: DesignDocument) {
  const map = new Map<string, string>()
  for (const item of Object.values(doc.nodes)) for (const child of item.children) map.set(child, item.id)
  return map
}
function place(nodes: DesignNode[], root: DesignNode) {
  const doc = blank('117')
  for (const item of nodes) doc.nodes[item.id] = item
  doc.pages[0].children = [root.id]
  return doc
}
function imagePng() {
  const artboard = node('frame', ARTBOARD.x, ARTBOARD.y, ARTBOARD.width, ARTBOARD.height)
  artboard.name = '117'
  artboard.clip = true
  const group = node('group', GROUP.x, GROUP.y, GROUP.width, GROUP.height)
  group.name = '主视觉'
  const mask = node('rectangle', MASK.x, MASK.y, MASK.width, MASK.height)
  mask.name = '椭圆 63'
  mask.mask = true
  const image = node('rectangle', IMAGE.x, IMAGE.y, IMAGE.width, IMAGE.height)
  image.name = 'image.png'
  artboard.children = [group.id]
  group.children = [mask.id, image.id]
  const doc = place([artboard, group, mask, image], artboard)
  return { doc, artboard, group, mask, image, parents: parentsOf(doc) }
}
function edgesOf(doc: DesignDocument, id: string, parents = parentsOf(doc)) {
  const distance = sketchFrameDistance(doc, id, parents)
  assert.ok(distance)
  const frame = doc.nodes[distance.frameId]
  const node = doc.nodes[id]
  const box = { x: node.transform[4], y: node.transform[5], width: node.width, height: node.height }
  return { distance, frame, box, edges: sketchFrameEdges(box, distance, frame) }
}
function applyEdge(doc: DesignDocument, id: string, edge: 'left' | 'top' | 'right' | 'bottom', displayValue: number, scale = 1) {
  const { distance, frame, box } = edgesOf(doc, id)
  const { axis, displayLocal } = frameEdgeDisplayLocal(edge, displayValue, box, distance, frame, scale, scale)
  const item = doc.nodes[id]
  // Same translation update as setNodePosition for a parent-space axis.
  item.transform[axis === 'x' ? 4 : 5] += displayLocal / scale - box[axis]
}

test('117 image.png distances use the artboard, not the group or the world origin', () => {
  const { doc, artboard, group, mask, image, parents } = imagePng()
  const before = {
    artboard: artboard.transform.slice(),
    group: group.transform.slice(),
    mask: mask.transform.slice(),
    image: image.transform.slice(),
    clip: artboard.clip,
    masked: mask.mask,
  }
  const { edges } = edgesOf(doc, image.id, parents)
  const world = multiply(multiply(artboard.transform, group.transform), image.transform)
  assert.equal(edges.left, 263)
  assert.equal(edges.right, 266)
  assert.equal(Number(edges.top.toFixed(2)), 225.6)
  assert.equal(Number(edges.bottom.toFixed(2)), 91.58)
  assert.equal(Number(IMAGE.height.toFixed(2)), 762.82)
  assert.notEqual(edges.left, image.transform[4])
  assert.deepEqual(world.slice(4), [-147, 358 + 135 + IMAGE.y])
  assert.notEqual(edges.left, world[4])
  assert.equal(figmaPositionOffset(doc, image.id, parents).x, GROUP.x)
  assert.equal(figmaPositionOffset(doc, image.id, parents).y, GROUP.y)
  assert.equal(sketchNestedFramePins(doc, image.id, parents), true)
  assert.deepEqual(artboard.transform, before.artboard)
  assert.deepEqual(group.transform, before.group)
  assert.deepEqual(mask.transform, before.mask)
  assert.deepEqual(image.transform, before.image)
  assert.equal(artboard.clip, before.clip)
  assert.equal(mask.mask, before.masked)
  assert.equal(image.width, IMAGE.width)
  assert.equal(image.height, IMAGE.height)
})

test('writing each artboard edge moves only the bitmap translation and one restore returns the readout', () => {
  const { doc, artboard, group, mask, image } = imagePng()
  const original = image.transform.slice() as Matrix
  const untouched = () => {
    assert.deepEqual(artboard.transform, [1, 0, 0, 1, ARTBOARD.x, ARTBOARD.y])
    assert.deepEqual(group.transform, [1, 0, 0, 1, GROUP.x, GROUP.y])
    assert.deepEqual(mask.transform, [1, 0, 0, 1, MASK.x, MASK.y])
    assert.equal(artboard.clip, true)
    assert.equal(mask.mask, true)
    assert.equal(image.width, IMAGE.width)
    assert.equal(image.height, IMAGE.height)
    assert.deepEqual(image.transform.slice(0, 4), [1, 0, 0, 1])
  }
  for (const [edge, value, axis] of [
    ['left', 300, 4],
    ['top', 200, 5],
    ['right', 200, 4],
    ['bottom', 40, 5],
  ] as const) {
    applyEdge(doc, image.id, edge, value)
    untouched()
    const next = edgesOf(doc, image.id).edges
    assert.equal(Number(next[edge].toFixed(6)), value)
    assert.notEqual(image.transform[axis], original[axis])
    image.transform = original.slice() as Matrix
    const restored = edgesOf(doc, image.id).edges
    assert.equal(restored.left, 263)
    assert.equal(restored.right, 266)
    assert.equal(Number(restored.top.toFixed(2)), 225.6)
    assert.equal(Number(restored.bottom.toFixed(2)), 91.58)
  }
})

test('ordinary nested groups add translations and a nested frame stops at itself', () => {
  const outer = node('frame', 5, 6, 1000, 800)
  const inner = node('frame', 100, 50, 200, 150)
  const first = node('group', 10, 20, 1, 1)
  const second = node('group', 3, 4, 1, 1)
  const rect = node('rectangle', 4, 5, 6, 7)
  outer.children = [inner.id]
  inner.children = [first.id]
  first.children = [second.id]
  second.children = [rect.id]
  const doc = place([outer, inner, first, second, rect], outer)
  const { edges, distance } = edgesOf(doc, rect.id)
  assert.equal(distance.frameId, inner.id)
  assert.equal(edges.left, 17)
  assert.equal(edges.top, 29)
  assert.equal(edges.right, 200 - 17 - 6)
  assert.equal(edges.bottom, 150 - 29 - 7)
  assert.equal(sketchNestedFramePins(doc, rect.id, parentsOf(doc)), true)
  assert.deepEqual(figmaPositionOffset(doc, rect.id, parentsOf(doc)), { x: 13, y: 24 })
})

test('groups outside a frame stay on immediate coordinates while Figma still sums them', () => {
  const group = node('group', 30, 40, 10, 10)
  const rect = node('rectangle', 2, 3, 4, 5)
  group.children = [rect.id]
  const doc = place([group, rect], group)
  assert.equal(sketchFrameDistance(doc, rect.id, parentsOf(doc)), undefined)
  assert.deepEqual(figmaPositionOffset(doc, rect.id, parentsOf(doc)), { x: 30, y: 40 })
})

test('non-translated and special containers block frame distances without changing matrices', () => {
  const cases: Array<(group: DesignNode) => void> = [
    group => { group.transform = [0, 1, -1, 0, 10, 20] },
    group => { group.transform = [2, 0, 0, 2, 10, 20] },
    group => { group.transform = [-1, 0, 0, 1, 10, 20] },
    group => { group.graphic = true },
    group => { group.mask = true },
    group => { group.booleanOperation = 'union' },
    group => { group.instance = { componentId: 'c', overrides: {}, propertyValues: {} } },
    group => { group.layout = { ...defaultLayout(), mode: 'horizontal' } },
    group => { group.repeat = { count: 2, translation: { x: 1, y: 0 }, pivot: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } } },
  ]
  for (const change of cases) {
    const frame = node('frame', 0, 0, 400, 300)
    const group = node('group', 8, 9, 20, 20)
    const rect = node('rectangle', 5, 6, 7, 8)
    const before = [frame.transform.slice(), group.transform.slice(), rect.transform.slice()]
    change(group)
    frame.children = [group.id]
    group.children = [rect.id]
    const doc = place([frame, group, rect], frame)
    const parents = parentsOf(doc)
    assert.equal(sketchFrameDistance(doc, rect.id, parents), undefined)
    assert.deepEqual(figmaPositionOffset(doc, rect.id, parents), { x: 0, y: 0 })
    assert.equal(sketchNestedFramePins(doc, rect.id, parents), false)
    assert.deepEqual(frame.transform, before[0])
    assert.deepEqual(rect.transform, before[2])
  }
})

test('a clipping translated group and a direct frame child keep frame distances', () => {
  const frame = node('frame', -3, 4, 500, 240)
  frame.clip = true
  const group = node('group', 12, 15, 40, 40)
  group.clip = true
  const rect = node('rectangle', 1, 2, 10, 11)
  const directNode = node('rectangle', 20, 30, 40, 50)
  frame.children = [group.id, directNode.id]
  group.children = [rect.id]
  const doc = place([frame, group, rect, directNode], frame)
  const grouped = edgesOf(doc, rect.id)
  assert.equal(grouped.edges.left, 13)
  assert.equal(grouped.edges.top, 17)
  assert.equal(grouped.edges.right, 500 - 13 - 10)
  assert.equal(grouped.edges.bottom, 240 - 17 - 11)
  const alone = edgesOf(doc, directNode.id)
  assert.equal(alone.distance.offsetX, 0)
  assert.equal(alone.edges.left, 20)
  assert.equal(alone.edges.right, 500 - 20 - 40)
  assert.equal(sketchNestedFramePins(doc, directNode.id, parentsOf(doc)), false)
  assert.equal(frame.clip, true)
  assert.equal(group.clip, true)
})

test('graphic and flowed frames do not add nested pin entry', () => {
  const frame = node('frame', 0, 0, 300, 200)
  frame.graphic = true
  const group = node('group', 4, 5, 10, 10)
  const rect = node('rectangle', 6, 7, 8, 9)
  frame.children = [group.id]
  group.children = [rect.id]
  const doc = place([frame, group, rect], frame)
  const parents = parentsOf(doc)
  const distance = sketchFrameDistance(doc, rect.id, parents)
  assert.equal(distance?.offsetX, 4)
  assert.equal(sketchNestedFramePins(doc, rect.id, parents), false)
  frame.graphic = false
  frame.layout = { ...defaultLayout(), mode: 'vertical' }
  assert.equal(sketchNestedFramePins(doc, rect.id, parents), false)
  rect.sizing = { ...defaultSizing(), absolute: true }
  assert.equal(sketchNestedFramePins(doc, rect.id, parents), true)
})

test('a scaled frame writes the displayed right edge back into local translation', () => {
  const frame = node('frame', 0, 0, 100, 80)
  frame.transform = [2, 0, 0, 2, 0, 0]
  const rect = node('rectangle', 10, 15, 20, 10)
  frame.children = [rect.id]
  const doc = place([frame, rect], frame)
  const { distance, box } = edgesOf(doc, rect.id)
  assert.equal(sketchFrameEdges(box, distance, frame).right, 70)
  const { axis, displayLocal } = frameEdgeDisplayLocal('right', 100, box, distance, frame, 2, 2)
  assert.equal(axis, 'x')
  rect.transform[4] += displayLocal / 2 - box.x
  assert.equal(rect.transform[4], 30)
  assert.equal(edgesOf(doc, rect.id).edges.right, 50)
  assert.equal(rect.transform[5], 15)
  assert.deepEqual(frame.transform, [2, 0, 0, 2, 0, 0])
})
