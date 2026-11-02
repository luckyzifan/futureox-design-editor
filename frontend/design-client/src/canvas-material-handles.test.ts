import { expect, test } from 'vitest'
import { effect, node, paint } from './model'
import {
  cornerHandlePoint, cornerRadiiAfterDrag, editableGradient, firstGlass, fittedCornerRadii,
  glassHandleLocal, glassLightAngle, glassLightDirection, gradientAngleFromLocal, gradientAngleHandle,
  gradientEndpoints, gradientStopOffset, rectangleCornerTarget,
} from './canvas-material-handles'

test('fitted corners match the kernel shared-edge limit', () => {
  expect(fittedCornerRadii(100, 80, [12, 12, 12, 12])).toEqual([12, 12, 12, 12])
  expect(fittedCornerRadii(100, 80, [80, 80, 0, 0])).toEqual([50, 50, 0, 0])
  expect(fittedCornerRadii(100, 80, [30, 0, 4, 0])).toEqual([30, 0, 4, 0])
})

test('uniform drag writes every corner and Alt writes one', () => {
  const uniform = cornerRadiiAfterDrag(120, 80, [4, 4, 4, 4], 0, { x: 18, y: 30 }, true)
  expect(uniform).toEqual([18, 18, 18, 18])
  const single = cornerRadiiAfterDrag(120, 80, [4, 9, 2, 1], 1, { x: 100, y: 14 }, false)
  expect(single).toEqual([4, 14, 2, 1])
  expect(cornerRadiiAfterDrag(40, 20, [0, 0, 0, 0], 2, { x: -5, y: 100 }, false)[2]).toBe(0)
})

test('corner handles sit inside the shape and clear a zero-radius corner', () => {
  expect(rectangleCornerTarget(node('rectangle'))).toBe(true)
  expect(rectangleCornerTarget(node('ellipse'))).toBe(false)
  const sharp = cornerHandlePoint(80, 60, [0, 0, 0, 0], 0, 14)
  expect(sharp.x).toBeCloseTo(14 / Math.SQRT2)
  expect(sharp.y).toBeCloseTo(14 / Math.SQRT2)
  expect(cornerHandlePoint(80, 60, [20, 0, 0, 0], 0, 14)).toEqual({ x: 20, y: 20 })
})

test('glass light angle 0 points down and the drag inverts it', () => {
  expect(glassLightDirection(0).x).toBeCloseTo(0)
  expect(glassLightDirection(0).y).toBeCloseTo(1)
  expect(glassLightAngle(0, 20, false, 45)).toBeCloseTo(0)
  expect(glassLightAngle(20, 0, false, 0)).toBeCloseTo(-90)
  expect(glassLightAngle(0, 0, false, 33)).toBe(33)
  expect(glassLightAngle(0, 20, true, 0)).toBe(0)
  const handle = glassHandleLocal(40, 20, 0, 16)
  expect(handle).toEqual({ x: 20, y: 26 })
  const lens = node('rectangle', 0, 0, 40, 20)
  lens.effects = [effect('glass')]
  expect(firstGlass(lens)?.angle).toBe(45)
  lens.effects[0].visible = false
  expect(firstGlass(lens)).toBeNull()
})

test('gradient handles follow the kernel angle and keep stops on the segment', () => {
  const ends = gradientEndpoints(100, 50, 0)
  expect(ends.end.x).toBeGreaterThan(ends.start.x)
  expect(gradientAngleFromLocal(100, 50, ends.end, false, 12)).toBeCloseTo(0)
  expect(gradientAngleFromLocal(100, 50, { x: 50, y: 0 }, true, 0)).toBeCloseTo(-90)
  const handle = gradientAngleHandle(100, 50, 0, 10)
  expect(handle.x).toBeGreaterThan(ends.end.x)
  expect(gradientStopOffset(ends.start, ends.end, ends.start)).toBe(0)
  expect(gradientStopOffset(ends.start, ends.end, ends.end)).toBe(1)
  const shape = node('rectangle')
  shape.fills = [{ ...paint('#112233', 'linear'), transform: [2, 0, 0, 2, -0.5, -0.5] }]
  expect(editableGradient(shape)).toBeNull()
  shape.fills = [paint('#112233'), { ...paint('#112233', 'angular'), angle: 20 }]
  expect(editableGradient(shape)?.index).toBe(1)
  shape.fills.push(paint('#445566'))
  expect(editableGradient(shape)).toBeNull()
})
