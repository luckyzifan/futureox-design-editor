import { expect, test } from 'vitest'
import type { Effect, Matrix } from '../../model'
import { gradientBlurPlaneKey } from './blur-parameter-cache'

function node(effect: Effect) {
  return {
    id: 'shape', matrix: [1, 0, 0, 1, 4, 8] as Matrix, inverse: [1, 0, 0, 1, -4, -8] as Matrix,
    size: [120, 80] as [number, number], rect: { x: 1, y: 2, w: 40, h: 30 },
    fills: [], strokes: [], children: [], opacity: 1, blend: 'normal', effects: [effect],
    clip: false, mask: false, maskId: undefined, passthrough: false,
  }
}
const policy = [true, false, 'srgb']
const gradient = (end: [number, number], endCount = 6): Effect => ({
  id: 'fx', kind: 'blur', visible: true, radius: 4, x: 0, y: 0, spread: 0, color: '#000000', opacity: 1,
  gradientBlur: { start: [0, 40], end, startCount: 0, endCount, smooth: true },
} as Effect)

test('gradient plane identity ignores endpoint positions and keeps strength, geometry, and coverage', () => {
  const first = node(gradient([120, 40]))
  const moved = node(gradient([80, 10]))
  const key = gradientBlurPlaneKey(first, first.effects[0], policy, false)
  expect(key).toBeTruthy()
  expect(gradientBlurPlaneKey(moved, moved.effects[0], policy, false)).toBe(key)
  expect(gradientBlurPlaneKey(node(gradient([120, 40], 9)), node(gradient([120, 40], 9)).effects[0], policy, false)).not.toBe(key)
  expect(gradientBlurPlaneKey({ ...first, rect: { ...first.rect, w: 41 } }, first.effects[0], policy, false)).not.toBe(key)
  expect(gradientBlurPlaneKey(first, first.effects[0], policy, true)).not.toBe(key)
  expect(gradientBlurPlaneKey(first, { ...first.effects[0], kind: 'zoom-blur' }, policy, false)).toBeUndefined()
})
