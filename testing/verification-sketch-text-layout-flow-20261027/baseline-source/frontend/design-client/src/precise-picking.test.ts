import { expect, test } from 'vitest'
import {
  hit_test_device_json,
  hit_test_fill_device_json,
} from './generated/design-kernel/design_kernel'
import { Editor } from './engine'
import { cornerPoint } from './cubic-corner-reference'
import { apply, SpatialIndex } from './geometry'
import { blank, node, type Matrix } from './model'

function smooth() {
  const n = node('rectangle', 0, 0, 4000, 4000)
  n.radii = [2000, 2000, 2000, 2000]
  n.smoothing = 1
  return n
}

test('point-local fill retains high zoom cubic interior and signed large device coordinates', () => {
  const n = JSON.stringify(smooth()),
    reference = cornerPoint(2000)
  for (const m of [
    [32, 0, 0, 32, 0.125, -0.375],
    [-32, 8, 15, 4, 3e9 + 0.125, -3e9 - 0.375],
    [32, 8, 15, 4, -3e9 - 0.125, 3e9 + 0.375],
  ] as Matrix[]) {
    const matrix = JSON.stringify(m)
    for (const offset of [-0.05, 0.05]) {
      const p = apply(m, reference.offset(offset))
      expect(hit_test_device_json(n, matrix, p.x, p.y, 5)).toBe(offset < 0)
      expect(hit_test_fill_device_json(n, matrix, p.x, p.y)).toBe(offset < 0)
    }
  }
})

test('nested smooth clips and shape masks keep their fill constraint after point and zoom changes', () => {
  const doc = blank(),
    frame = smooth(),
    group = node('group'),
    mask = smooth(),
    leaf = smooth()
  frame.kind = 'frame'
  frame.fills = []
  frame.clip = true
  mask.mask = true
  mask.locked = true
  leaf.radii = [0, 0, 0, 0]
  frame.children = [group.id]
  group.children = [mask.id, leaf.id]
  doc.pages[0].children = [frame.id]
  for (const n of [frame, group, mask, leaf]) doc.nodes[n.id] = n
  frame.transform = [-1, 0.25, 0.5, 1, 9999999.125, -9999999.125]
  const editor = new Editor(doc),
    index = new SpatialIndex(editor.entries())
  const reference = cornerPoint(2000)
  for (const zoom of [1, 32, 0.25, 32]) {
    editor.set({ view: { x: 0.125, y: -0.375, zoom } })
    for (const offset of [-1.5, 1.5, -1.5]) {
      const p = apply(frame.transform, reference.offset(offset))
      if (offset < 0) expect(editor.hit(p, true, index)).toBe(leaf.id)
      else expect(editor.hit(p, true, index)).not.toBe(leaf.id)
    }
  }
})

test('smooth ancestor geometry remains independent of frame selection box and five-pixel halo', () => {
  const frame = smooth()
  frame.kind = 'frame'
  frame.fills = []
  const json = JSON.stringify(frame),
    matrix = JSON.stringify([32, 0, 0, 32, 0, 0])
  expect(hit_test_device_json(json, matrix, 1, 1, 5)).toBe(true)
  expect(hit_test_fill_device_json(json, matrix, 1, 1)).toBe(false)
  const smoothJson = JSON.stringify(smooth())
  expect(hit_test_device_json(smoothJson, matrix, 64000, -0.001, 5)).toBe(false)
  expect(hit_test_fill_device_json(smoothJson, matrix, 64000, -0.001)).toBe(false)
})
