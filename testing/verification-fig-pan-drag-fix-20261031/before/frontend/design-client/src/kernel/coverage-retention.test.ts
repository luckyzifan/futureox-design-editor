import { expect, test } from 'vitest'
import { CoverageRetention } from './coverage-retention'

const frame = (key: string, width: number, revision = 1, bytes = 20) => ({
  revision, bytes, keys: new Set([key]), bounds: { x: 0, y: 0, width, height: width },
})

test('a completed broad view survives repeated higher-density cache pressure', () => {
  const coverage = new CoverageRetention()
  coverage.retain(frame('whole-page', 10000), 120)
  const cache = new Map([['whole-page', 20]])
  for (let i = 0; i < 100; i++) {
    const key = `detail-${i}`
    coverage.retain(frame(key, 100), 120)
    cache.set(key, 20)
    for (const old of cache.keys()) {
      if (cache.size <= 6) break
      if (!coverage.has(old) && old !== key) cache.delete(old)
    }
  }
  expect(cache.has('whole-page')).toBe(true)
  expect(cache.size).toBe(6)
  coverage.retain(frame('wider-page', 20000), 120)
  expect(coverage.has('whole-page')).toBe(false)
  expect(coverage.has('wider-page')).toBe(true)
})

test('coverage never pins another revision or exceeds its share of a resized display budget', () => {
  const coverage = new CoverageRetention()
  coverage.retain(frame('oversize', 20000, 1, 41), 120)
  expect(coverage.has('oversize')).toBe(false)
  coverage.retain(frame('page', 10000), 120)
  coverage.trim(2, 120)
  expect(coverage.has('page')).toBe(false)
  coverage.retain(frame('new-page', 10000, 2), 120)
  coverage.trim(2, 30)
  expect(coverage.has('new-page')).toBe(false)
})
