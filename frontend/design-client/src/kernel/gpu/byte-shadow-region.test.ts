import { expect, test } from 'vitest'
import { byteShadowRegion } from './byte-shadow-region'

test('large integer shadow preserves the source Y domain and inverse-translates its certified consumer', () => {
  const source = { x: -1927, y: -2567, w: 3918, h: 2633 }, output = { x: -2, y: -2, w: 68, h: 68 }
  const plan = byteShadowRegion(source, output, 1920, 0, 640)!
  expect(plan.filtered).toEqual({ x: -2, y: -642, w: 68, h: 68 })
  expect(plan.horizontal).toEqual({ x: -2, y: -2567, w: 68, h: 2633 })
  expect(plan.horizontalPlan!.bytes + plan.verticalPlan!.bytes).toBeLessThanOrEqual(4 * 1024 * 1024)
  source.x = 99; output.y = 99
  expect(plan.source.x).toBe(-1927); expect(plan.output.y).toBe(-2)
})
test('the filtered result is transparent outside the original finite filter rectangle', () => {
  const plan = byteShadowRegion({ x: 0, y: 0, w: 8, h: 8 }, { x: -2, y: -2, w: 4, h: 4 }, 3, 0, 0)!
  expect(plan.filtered).toEqual({ x: 0, y: 0, w: 2, h: 2 })
  expect(plan.horizontal).toEqual({ x: 0, y: 0, w: 2, h: 8 })
  const outside = byteShadowRegion({ x: 0, y: 0, w: 8, h: 8 }, { x: 20, y: 20, w: 4, h: 4 }, 3, 0, 0)!
  expect(outside.filtered).toBeUndefined(); expect(outside.horizontalPlan).toBeUndefined()
})
test.each(['fractional-radius', 'fractional-offset', 'radius', 'domain', 'area', 'shift-overflow'] as const)('%s is outside this byte shadow contract', kind => {
  const source = { x: 0, y: 0, w: 64, h: 64 }, output = { x: 0, y: 0, w: 4, h: 4 }
  let radius = 3, dx = 0
  if (kind === 'fractional-radius') radius = 3.25
  if (kind === 'fractional-offset') dx = .25
  if (kind === 'radius') radius = 2049
  if (kind === 'domain') source.x = 1048575
  if (kind === 'area') { source.w = 8192; source.h = 4096 }
  if (kind === 'shift-overflow') dx = -1048576
  expect(byteShadowRegion(source, output, radius, dx, 0)).toBeUndefined()
})
