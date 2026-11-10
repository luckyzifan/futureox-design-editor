import { expect, test } from 'vitest'
import { incompleteWideBandCohort, sourceBandDefersWholePresent } from './source-display-band'

test('a partial wide-band cohort is the incomplete handoff, and an ordinary tile is not', () => {
  const wide = (cached: boolean) => ({ width: 962, height: 742, cached })
  expect(incompleteWideBandCohort([wide(true), wide(true), wide(true), wide(false)])).toBe(true)
  expect(incompleteWideBandCohort([wide(false), wide(false), wide(false), wide(false)])).toBe(false)
  expect(incompleteWideBandCohort([wide(true), wide(true), wide(true), wide(true)])).toBe(false)
  expect(incompleteWideBandCohort([
    { width: 514, height: 514, cached: true },
    { width: 514, height: 514, cached: false },
  ])).toBe(false)
  expect(incompleteWideBandCohort([wide(true)])).toBe(false)
})

test('only a source-detail capture wider than an ordinary tile defers the whole present', () => {
  expect(sourceBandDefersWholePresent(true, 962, 742)).toBe(true)
  expect(sourceBandDefersWholePresent(true, 514, 514)).toBe(false)
  expect(sourceBandDefersWholePresent(false, 962, 742)).toBe(false)
  expect(sourceBandDefersWholePresent(true, 400, 962)).toBe(true)
})
