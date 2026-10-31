import { expect, test } from 'vitest'
import { InteractionDensity } from './interaction-density'

test('continuous zoom cannot starve density updates', () => {
  const density = new InteractionDensity(1),
    updates: number[] = []
  for (let frame = 1; frame <= 30; frame++) {
    const now = frame * 16,
      next = 1 + frame * 0.02
    if (density.queue(next, now) || density.frame(now + 1)) updates.push(now)
  }
  expect(updates.length).toBeGreaterThanOrEqual(4)
  expect(updates[0]).toBeLessThanOrEqual(96)
  expect(density.value).toBeGreaterThanOrEqual(1.48)
})

test('large zoom jumps immediately request screen density; small changes settle in two frames', () => {
  const density = new InteractionDensity(0.25)
  expect(density.queue(2, 0)).toBe(true)
  expect(density.value).toBe(2)
  expect(density.queue(2.1, 10)).toBe(false)
  expect(density.frame(16)).toBe(false)
  expect(density.frame(32)).toBe(true)
  expect(density.value).toBe(2.1)
  expect(density.pending).toBe(false)
})

test('reversing a gesture clears pending work without publishing a false change', () => {
  const density = new InteractionDensity(1)
  density.queue(1.1, 0)
  density.queue(1, 16)
  density.frame(32)
  expect(density.frame(48)).toBe(false)
  expect(density.pending).toBe(false)
  expect(density.value).toBe(1)
})
