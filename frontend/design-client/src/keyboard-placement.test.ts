import { expect, test } from 'vitest'
import { apply, worldMatrix } from './geometry'
import { insertKeyboardPlacedNode, keyboardPlacementPoint, keyboardPlacedNode, keyboardPlacesTool } from './keyboard-placement'
import { blank, node, validateDocument } from './model'

test('Return places frames, shapes, and text, and leaves lines and pens alone', () => {
  for (const tool of ['frame', 'section', 'rectangle', 'ellipse', 'polygon', 'star', 'text'])
    expect(keyboardPlacesTool(tool)).toBe(true)
  for (const tool of ['line', 'arrow', 'pen', 'vector', 'pencil', 'table', 'connector-straight', 'connector-elbowed', 'select', 'slice'])
    expect(keyboardPlacesTool(tool)).toBe(false)
})

test('the keyboard crosshair is the viewport center and the default object is centered on it', () => {
  const view = { x: 30, y: 35, zoom: 2 }
  const point = keyboardPlacementPoint(view, { width: 1000, height: 800 })
  expect(point).toEqual({ x: (500 - 30) / 2, y: (400 - 35) / 2 })
  for (const tool of ['frame', 'rectangle', 'ellipse', 'text'] as const) {
    const placed = keyboardPlacedNode(tool, point, false)
    expect(placed.width).toBe(100)
    expect(placed.height).toBe(100)
    expect(placed.transform[4] + placed.width / 2).toBeCloseTo(point.x, 8)
    expect(placed.transform[5] + placed.height / 2).toBeCloseTo(point.y, 8)
    const doc = blank()
    insertKeyboardPlacedNode(doc, doc.pages[0].id, placed)
    expect(doc.pages[0].children).toEqual([placed.id])
    expect(() => validateDocument(doc)).not.toThrow()
  }
  expect(() => keyboardPlacementPoint(view, { width: 0, height: 800 })).toThrow('Invalid placement viewport')
})

test('a placed rectangle joins the frame under the crosshair and keeps that world center', () => {
  const doc = blank('parent')
  const frame = node('frame', 100, 80, 4000, 4000)
  doc.nodes[frame.id] = frame
  doc.pages[0].children = [frame.id]
  const point = { x: 470, y: 365 }
  const placed = keyboardPlacedNode('rectangle', point, false)
  insertKeyboardPlacedNode(doc, doc.pages[0].id, placed)
  expect(doc.pages[0].children).toEqual([frame.id])
  expect(frame.children).toEqual([placed.id])
  expect(placed.transform[4]).toBeCloseTo(point.x - placed.width / 2 - 100, 8)
  expect(placed.transform[5]).toBeCloseTo(point.y - placed.height / 2 - 80, 8)
  const center = apply(worldMatrix(doc, placed.id), { x: placed.width / 2, y: placed.height / 2 })
  expect(center.x).toBeCloseTo(point.x, 8)
  expect(center.y).toBeCloseTo(point.y, 8)
  expect(placed.fills[0]?.color).toBe('#d9d9d9')
  expect(() => validateDocument(doc)).not.toThrow()
})
