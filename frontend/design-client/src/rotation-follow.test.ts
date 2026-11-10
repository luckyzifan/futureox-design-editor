import { expect, test } from 'vitest'
import { blank, effect, node, type DesignNode, type Matrix } from './model'
import { apply, around, bounds, boxPoints, multiply, rotate } from './commands/affine'
import { elementMatrix, followCamera, isolatedGestureCrop, screenWarp } from './gesture-follow'
import { rotationFollowPlan, rotationLiftOwnsPreview, rotationPreviewLift, type RotationSnapshotEntry } from './rotation-follow'

function entry(node: DesignNode, parent: Matrix, ancestors: string[]): RotationSnapshotEntry {
  const matrix = multiply(parent, node.transform)
  return {
    id: node.id, matrix, ancestors,
    bounds: bounds(boxPoints({ x: 0, y: 0, width: node.width, height: node.height }).map(point => apply(matrix, point))),
  }
}

test('a 90° turn into a front layer is refused by the same crop the screenshot uses', () => {
  const doc = blank()
  const image = node('rectangle', 100, 100, 120, 40)
  const front = node('rectangle', 145, 150, 30, 24)
  doc.nodes = { [image.id]: image, [front.id]: front }
  doc.pages[0].children = [image.id, front.id]
  const entries = [entry(image, [1, 0, 0, 1, 0, 0], []), entry(front, [1, 0, 0, 1, 0, 0], [])]
  const plan = rotationFollowPlan(doc, doc.pages[0].id, image.id, entries)!
  const center = { x: plan.box.x + plan.box.width / 2, y: plan.box.y + plan.box.height / 2 }
  const delta = around(center, rotate(90))
  const view = { x: 0, y: 0, zoom: 1 }
  expect(isolatedGestureCrop(plan.box, plan.others, view, delta, 400, 300)).toBeUndefined()
  expect(rotationPreviewLift({
    node: image, box: plan.box, others: plan.others, view, delta, width: 400, height: 300,
  })).toBeUndefined()
})

test('a semi-transparent fill with background blur is not lifted even when the crop is free', () => {
  const doc = blank()
  const image = node('rectangle', 30, 30, 100, 80)
  image.opacity = 0.45
  image.fills[0].opacity = 0.45
  image.effects = [effect('background-blur')]
  doc.nodes = { [image.id]: image }
  doc.pages[0].children = [image.id]
  const entries = [entry(image, [1, 0, 0, 1, 0, 0], [])]
  const view = { x: 0, y: 0, zoom: 1 }
  const delta: Matrix = [1, 0, 0, 1, 0, 0]
  expect(isolatedGestureCrop(entries[0].bounds, [], view, delta, 400, 300)).toEqual(entries[0].bounds)
  expect(rotationFollowPlan(doc, doc.pages[0].id, image.id, entries)).toBeNull()
  expect(rotationPreviewLift({
    node: image, box: entries[0].bounds, others: [], view, delta, width: 400, height: 300,
  })).toBeUndefined()
})

test('an opaque large image follows inside the visible slice before release', () => {
  const doc = blank()
  doc.pages[0].background = '#eeeeee'
  const frame = node('frame', 0, 0, 4000, 3000)
  frame.fills[0].color = '#112233'
  const image = node('rectangle', 100, 80, 3000, 2000)
  frame.children = [image.id]
  doc.nodes = { [frame.id]: frame, [image.id]: image }
  doc.pages[0].children = [frame.id]
  const frameMatrix = frame.transform
  const entries = [entry(frame, [1, 0, 0, 1, 0, 0], []), entry(image, frameMatrix, [frame.id])]
  const plan = rotationFollowPlan(doc, doc.pages[0].id, image.id, entries)!
  expect(plan.hole).toBe('#112233')
  expect(plan.others).toEqual([])
  const view = { x: 0, y: 0, zoom: 1 }
  const center = { x: plan.box.x + plan.box.width / 2, y: plan.box.y + plan.box.height / 2 }
  const delta = around(center, rotate(24.06))
  expect(isolatedGestureCrop(plan.box, plan.others, view, delta, 800, 600)).toBeUndefined()
  const lifted = rotationPreviewLift({
    node: image, box: plan.box, others: plan.others, view, delta, width: 800, height: 600,
  })
  expect(lifted).toBeTruthy()
  expect(isolatedGestureCrop(lifted!, plan.others, view, delta, 800, 600)).toEqual(lifted)
  const warp = screenWarp(view, delta)!
  const local = elementMatrix(warp, { x: lifted!.x, y: lifted!.y })
  const moved = apply(followCamera(view), apply(delta, { x: lifted!.x, y: lifted!.y }))
  expect(lifted!.x + local[4]).toBeCloseTo(moved.x, 6)
  expect(lifted!.y + local[5]).toBeCloseTo(moved.y, 6)
  expect(Math.hypot(moved.x - lifted!.x, moved.y - lifted!.y)).toBeGreaterThan(1)
  expect(rotationLiftOwnsPreview('rotate', { holding: false })).toBe(true)
  expect(rotationLiftOwnsPreview('rotate', { holding: true })).toBe(false)
})
