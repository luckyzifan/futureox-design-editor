import { expect, test } from 'vitest'
import { constrainAngle, penHandle } from './pen-constraints'

test('Shift snaps a pen point onto the nearest 45 degree ray without changing its length', () => {
  const origin = { x: 10, y: 20 }
  const point = constrainAngle(origin, { x: 90, y: -20 })
  const length = Math.hypot(80, -40)
  expect(Math.hypot(point.x - origin.x, point.y - origin.y)).toBeCloseTo(length)
  const angle = Math.atan2(point.y - origin.y, point.x - origin.x)
  expect(Math.abs(angle + Math.PI / 4)).toBeLessThan(1e-9)
})

test('Option disconnects the pen handle and a plain drag keeps the mirror', () => {
  const vertex = { x: 4, y: 6 }
  const plain = penHandle(vertex, { x: 10, y: 6 }, false, false)
  expect(plain.mirror).toEqual({ x: -2, y: 6 })
  const broken = penHandle(vertex, { x: 10, y: 8 }, true, true)
  expect(broken.mirror).toBeUndefined()
  expect(Math.atan2(broken.outgoing.y - vertex.y, broken.outgoing.x - vertex.x) % (Math.PI / 4)).toBeCloseTo(0)
})
