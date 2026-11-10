import { expect, test } from 'vitest'
import { blank, effect, node, type DesignNode, type Matrix } from './model'
import { apply, around, bounds, boxPoints, multiply, rotate } from './commands/affine'
import { rotationSnapshotCrop, rotationSnapshotOwnsPreview, rotationSnapshotPlan, type RotationSnapshotEntry } from './rotation-follow'

function entry(node: DesignNode, parent: Matrix, ancestors: string[]): RotationSnapshotEntry {
  const matrix = multiply(parent, node.transform)
  return {
    id: node.id, matrix, ancestors,
    bounds: bounds(boxPoints({ x: 0, y: 0, width: node.width, height: node.height }).map(point => apply(matrix, point))),
  }
}

function picture() {
  const doc = blank()
  doc.pages[0].background = '#eeeeee'
  const frame = node('frame', 0, 0, 4000, 3000)
  frame.fills[0].color = '#112233'
  const back = node('rectangle', 0, 0, 4000, 3000)
  const image = node('rectangle', 100, 80, 3000, 2000)
  const badge = node('rectangle', 3500, 80, 40, 40)
  frame.children = [back.id, image.id, badge.id]
  const distant = node('rectangle', 5000, 5000, 30, 30)
  distant.effects = [effect('shadow')]
  doc.nodes = { [frame.id]: frame, [back.id]: back, [image.id]: image, [badge.id]: badge, [distant.id]: distant }
  doc.pages[0].children = [frame.id, distant.id]
  const frameMatrix = frame.transform
  const entries = [
    entry(frame, [1, 0, 0, 1, 0, 0], []),
    entry(back, frameMatrix, [frame.id]),
    entry(image, frameMatrix, [frame.id]),
    entry(badge, frameMatrix, [frame.id]),
    entry(distant, [1, 0, 0, 1, 0, 0], []),
  ]
  return { doc, frame, back, image, badge, distant, entries }
}

test('a nested large image lifts without treating its frame, backdrop, or unrelated effects as overlap', () => {
  const { doc, frame, back, image, badge, distant, entries } = picture()
  const plan = rotationSnapshotPlan(doc, doc.pages[0].id, image.id, entries)
  expect(plan).not.toBeNull()
  expect(plan!.hole).toBe('#112233')
  expect(plan!.box).toMatchObject({ x: 100, y: 80, width: 3000, height: 2000 })
  const ids = new Set(entries.filter(item => plan!.others.some(box =>
    box.x === item.bounds.x && box.y === item.bounds.y && box.width === item.bounds.width && box.height === item.bounds.height)).map(item => item.id))
  expect(ids.has(back.id)).toBe(false)
  expect(ids.has(frame.id)).toBe(false)
  expect(ids.has(badge.id)).toBe(true)
  expect(ids.has(distant.id)).toBe(true)
  const identity: Matrix = [1, 0, 0, 1, 0, 0]
  const crop = rotationSnapshotCrop(plan!.box, plan!.others, { x: 0, y: 0, zoom: 1 }, identity, 800, 600)
  expect(crop).toMatchObject({ x: 100, y: 80 })
  expect(crop!.x + crop!.width).toBeLessThanOrEqual(800)
  expect(crop!.y + crop!.height).toBeLessThanOrEqual(600)
  // Swinging across a label that is not inside the lifted crop still follows.
  // The exact frame restores stacking after release.
  const turned = rotationSnapshotCrop(plan!.box, plan!.others, { x: 0, y: 0, zoom: 1 },
    around({ x: 1600, y: 1080 }, rotate(90)), 800, 600)
  expect(turned).toEqual(crop)
})

test('paint in front of the lifted crop keeps the image on the ordinary preview', () => {
  const { doc, frame, image, badge, entries } = picture()
  badge.transform = [1, 0, 0, 1, 200, 200]
  badge.width = 30
  badge.height = 30
  const next = entries.map(item => item.id === badge.id ? entry(badge, frame.transform, [frame.id]) : item)
  const plan = rotationSnapshotPlan(doc, doc.pages[0].id, image.id, next)!
  expect(rotationSnapshotCrop(plan.box, plan.others, { x: 0, y: 0, zoom: 1 }, [1, 0, 0, 1, 0, 0], 800, 600)).toBeUndefined()
})

test('selecting the clipped artboard still lifts when another object merely has an effect', () => {
  const { doc, frame, entries } = picture()
  expect(frame.clip).toBe(true)
  const plan = rotationSnapshotPlan(doc, doc.pages[0].id, frame.id, entries)
  expect(plan).not.toBeNull()
  expect(plan!.box.width).toBeGreaterThanOrEqual(4000)
  expect(plan!.others.some(box => box.x === 5000)).toBe(true)
})

test('a fully visible layer keeps its own crop', () => {
  const doc = blank()
  const layer = node('rectangle', 40, 50, 20, 16)
  doc.nodes = { [layer.id]: layer }
  doc.pages[0].children = [layer.id]
  const entries = [entry(layer, [1, 0, 0, 1, 0, 0], [])]
  const plan = rotationSnapshotPlan(doc, doc.pages[0].id, layer.id, entries)!
  expect(rotationSnapshotCrop(plan.box, plan.others, { x: 0, y: 0, zoom: 2 }, [1, 0, 0, 1, 0, 0], 400, 300)).toEqual(plan.box)
})

test('transparent, masked, and singular poses do not invent a lift', () => {
  const { doc, image, entries } = picture()
  image.opacity = 0.5
  expect(rotationSnapshotPlan(doc, doc.pages[0].id, image.id, entries)).toBeNull()
  image.opacity = 1
  image.mask = true
  expect(rotationSnapshotPlan(doc, doc.pages[0].id, image.id, entries)).toBeNull()
  image.mask = false
  const plan = rotationSnapshotPlan(doc, doc.pages[0].id, image.id, entries)!
  expect(rotationSnapshotCrop(plan.box, plan.others, { x: 0, y: 0, zoom: 1 }, [1, 0, 0, 0, 0, 0], 800, 600)).toBeUndefined()
})

test('an active rotation lift owns the preview until it is held for commit', () => {
  expect(rotationSnapshotOwnsPreview('rotate', { holding: false })).toBe(true)
  expect(rotationSnapshotOwnsPreview('rotate', { holding: true })).toBe(false)
  expect(rotationSnapshotOwnsPreview('rotate', null)).toBe(false)
  expect(rotationSnapshotOwnsPreview('move', { holding: false })).toBe(false)
})
