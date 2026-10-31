import { expect, test } from 'vitest'
import { PresentationOwnership } from './presentation-ownership'

test('batched same-key replacement reclaims deliveries never observed by React', () => {
  const owner = new PresentationOwnership()
  owner.track(1); owner.track(2); owner.track(3)
  expect(owner.retireExcept([1, 3])).toEqual([2]) // 1 is still the displayed frame.
  expect(owner.retireExcept([3])).toEqual([1]) // The replacement has presented.
  expect(owner.retireExcept([3])).toEqual([])
  expect(owner.size).toBe(1)
})

test('eviction before first paint and repeated retirement do not retain orphan handles', () => {
  const owner = new PresentationOwnership()
  for (let id = 1; id <= 1000; id++) owner.track(id)
  expect(owner.retireExcept([999, 1000])).toHaveLength(998)
  owner.track(undefined); owner.track(1000)
  expect(owner.size).toBe(2)
  owner.clear()
  expect(owner.retireExcept([])).toEqual([])
})
