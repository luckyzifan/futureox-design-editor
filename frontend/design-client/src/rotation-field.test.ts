import { expect, test } from 'vitest'
import { apply, around, inverse, multiply, rotate } from './geometry'
import { blank, node } from './model'
import { rotateNode, rotationDegrees } from './canvas-view'
import { Editor } from './engine'
import { figmaRotationDegrees, formatFigmaAngle, snapRotationDelta } from './rotation-field'
import { nextConstraint } from './layout-constraints'

test('the angle field is clockwise-positive, wraps at a half turn, and keeps two decimals', () => {
  const n = node('rectangle', 10, 20, 80, 40)
  rotateNode(n, 17)
  expect(figmaRotationDegrees(n.transform)).toBeCloseTo(-rotationDegrees(n), 10)
  expect(formatFigmaAngle(figmaRotationDegrees(n.transform))).toBe('-17')
  n.transform = rotate(90)
  expect(formatFigmaAngle(figmaRotationDegrees(n.transform))).toBe('90')
  rotateNode(n, -45)
  expect(formatFigmaAngle(figmaRotationDegrees(n.transform))).toBe('45')
  rotateNode(n, 0)
  expect(formatFigmaAngle(figmaRotationDegrees(n.transform))).toBe('0')
  expect(formatFigmaAngle(-45.256)).toBe('-45.26')
  expect(formatFigmaAngle(15.254)).toBe('15.25')
  expect(formatFigmaAngle(-0.004)).toBe('0')
  expect(formatFigmaAngle(190)).toBe('-170')
  expect(formatFigmaAngle(-190)).toBe('170')
  expect(formatFigmaAngle(180)).toBe('180')
  expect(formatFigmaAngle(-180)).toBe('-180')
})

test('shift-snap corrects the layer angle, not the parent, onto 15 degree steps', () => {
  const frame = node('frame', 0, 0, 400, 300), child = node('rectangle', 40, 50, 80, 40)
  rotateNode(frame, 20)
  const world = multiply(frame.transform, child.transform)
  const center = apply(world, { x: 40, y: 20 })
  const delta = around(center, rotate(12))
  const unsnapped = multiply(inverse(frame.transform), multiply(delta, world))
  expect(figmaRotationDegrees(unsnapped)).toBeCloseTo(12, 5)
  const snapped = snapRotationDelta(frame.transform, world, delta, center)
  const local = multiply(inverse(frame.transform), multiply(snapped, world))
  expect(figmaRotationDegrees(local)).toBeCloseTo(15, 5)
  expect(formatFigmaAngle(figmaRotationDegrees(local))).toBe('15')
  expect(apply(multiply(snapped, world), { x: 40, y: 20 }).x).toBeCloseTo(center.x, 6)
  expect(apply(multiply(snapped, world), { x: 40, y: 20 }).y).toBeCloseTo(center.y, 6)
})

test('a canvas rotation publishes the formatted angle before the document preview', () => {
  const doc = blank(), rect = node('rectangle', 0, 0, 30, 20)
  doc.nodes[rect.id] = rect
  doc.pages[0].children = [rect.id]
  const editor = new Editor(doc)
  try {
    editor.select([rect.id])
    const before = editor.state.doc
    let notices = 0
    const stop = editor.subscribeLiveRotation(() => { notices += 1 })
    const live = {
      session: editor.sessionGeneration, page: editor.state.page, documentId: editor.state.doc.id,
      textById: { [rect.id]: '-12.5' },
    }
    editor.setLiveRotation(live)
    editor.setLiveRotation({ ...live, textById: { [rect.id]: '-12.5' } })
    expect(notices).toBe(1)
    expect(editor.liveRotation?.textById[rect.id]).toBe('-12.5')
    expect(editor.state.doc).toBe(before)
    editor.setLiveRotation(null)
    expect(editor.liveRotation).toBeNull()
    expect(notices).toBe(2)
    stop()
  } finally { editor.dispose() }
})

test('constraint clicks match the Figma diagram, including shift for both edges', () => {
  expect(nextConstraint('start', 'end', false)).toBe('end')
  expect(nextConstraint('start', 'end', true)).toBe('stretch')
  expect(nextConstraint('stretch', 'start', true)).toBe('end')
  expect(nextConstraint('stretch', 'end', false)).toBe('end')
  expect(nextConstraint('scale', 'start', false)).toBe('start')
  expect(nextConstraint('center', 'center', false)).toBe('center')
})
