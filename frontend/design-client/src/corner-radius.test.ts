import { expect, test } from 'vitest'
import { cornerHandleLocal, cornerRadiusDrag, radiiUniform } from './corner-radius'

test('equal radii collapse to one value and a drag from the top-left sets the shared radius', () => {
  expect(radiiUniform([8, 8, 8, 8])).toBe(true)
  expect(radiiUniform([8, 8, 8, 1])).toBe(false)
  expect(cornerRadiusDrag(0, 0, 18, 2, 40, false)).toBe(18)
  expect(cornerRadiusDrag(12, 0, -4, 1, 40, false)).toBe(8)
  expect(cornerRadiusDrag(3.4, 0, 1.2, 0, 40, true)).toBe(5)
  expect(cornerRadiusDrag(10, 0, 100, 0, 24, false)).toBe(24)
  expect(cornerRadiusDrag(4, 0, -20, 0, 24, false)).toBe(0)
})

test('each corner uses the inward axis and the handle stays off a zero-radius resize corner', () => {
  expect(cornerRadiusDrag(6, 1, -9, 1, 40, false)).toBe(15)
  expect(cornerRadiusDrag(6, 2, 2, -8, 40, false)).toBe(14)
  expect(cornerRadiusDrag(6, 3, 5, -1, 40, false)).toBe(11)
  expect(cornerHandleLocal(80, 60, 0, 0, 14)).toEqual({ x: 14, y: 0 })
  expect(cornerHandleLocal(80, 60, 0, 22, 14)).toEqual({ x: 22, y: 0 })
  expect(cornerHandleLocal(80, 60, 2, 10, 14)).toEqual({ x: 66, y: 60 })
})
