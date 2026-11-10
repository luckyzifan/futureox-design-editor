import { expect, test } from 'vitest'
import { settledPoseDamage } from './interaction-pose-damage'

test('a proved leaf rotation stays local and an open dependency stays full', () => {
  expect(settledPoseDamage({ full: false, bounds: [1, 2, 3, 4], rects: [[1, 2, 3, 4], [5, 6, 7, 8]] })).toMatchObject({
    full: false, bounds: [1, 2, 3, 4], reason: 'native-interaction-pose',
  })
  expect(settledPoseDamage({ full: true, bounds: null, reason: 'backdrop' })).toEqual({
    full: true, bounds: null, reason: 'native-interaction-pose',
  })
  expect(settledPoseDamage(null)).toEqual({ full: true, bounds: null, reason: 'native-interaction-pose' })
  expect(settledPoseDamage({ full: false, bounds: null })).toEqual({ full: true, bounds: null, reason: 'native-interaction-pose' })
})
