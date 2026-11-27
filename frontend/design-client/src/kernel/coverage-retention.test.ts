import { expect, test } from 'vitest'
import { CoverageRetention, hasNativeViewportSamples } from './coverage-retention'

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

test('only the retained native camera, revision and physical viewport can skip the preview wait', () => {
  const coverage = new CoverageRetention()
  const view = { x: 36.099673, y: 348.782679, zoom: .050653594 }
  coverage.retain({ ...frame('exact', 10000), native: { view, width: 855, height: 928, dpr: 2 } }, 120)
  expect(coverage.nativeKeys(1, { ...view }, 855, 928, 2)).toEqual(new Set(['exact']))
  expect(coverage.nativeKeys(2, view, 855, 928, 2)).toBeUndefined()
  expect(coverage.nativeKeys(1, { ...view, zoom: view.zoom + 1e-10 }, 855, 928, 2)).toBeUndefined()
  expect(coverage.nativeKeys(1, view, 855, 928, 1)).toBeUndefined()
  expect(coverage.nativeKeys(1, view, 854, 928, 2)).toBeUndefined()
  coverage.clear()
  expect(coverage.nativeKeys(1, view, 855, 928, 2)).toBeUndefined()
})

test('an accepted density-cache plan can be recalled at its exact native camera', () => {
  const coverage = new CoverageRetention()
  const view = { x: -151.5, y: -507, zoom: 1 }
  const plan = { view, width: 256, height: 256, dpr: 2, rasterScale: 2, samplingMode: 'density-cache' as const }
  const tile = { key: 'exact', x: 302, y: 1013, width: 514, height: 514, zoom: 2 }
  expect(hasNativeViewportSamples(plan, [tile], true)).toBe(true)
  coverage.retain({ ...frame(tile.key, 256), native: plan }, 120)
  expect(coverage.nativeKeys(1, view, plan.width, plan.height, 2)).toEqual(new Set([tile.key]))
  expect(coverage.nativeKeys(1, { ...view, x: view.x + 0.25 }, plan.width, plan.height, 2)).toBeUndefined()
})

test('cached sampling needs the exact cohort and rejects preview and phase or density mismatches', () => {
  const plan = { view: { x: -151.5, y: -507, zoom: 1 }, dpr: 2, rasterScale: 2, samplingMode: 'density-cache' as const }
  const tile = { key: 'exact', x: 511, y: 1023, width: 514, height: 514, zoom: 2 }
  expect(hasNativeViewportSamples(plan, [tile], false)).toBe(false)
  expect(hasNativeViewportSamples({ ...plan, rasterScale: 1 }, [tile], true)).toBe(false)
  expect(hasNativeViewportSamples(plan, [tile, { ...tile, phaseX: 0.25 }], true)).toBe(false)
  expect(hasNativeViewportSamples(plan, [tile, { ...tile, zoom: 1 }], true)).toBe(false)
  expect(hasNativeViewportSamples(plan, [{ ...tile, viewportPreview: true }], true)).toBe(false)
  expect(hasNativeViewportSamples(plan, [], true)).toBe(false)
  expect(hasNativeViewportSamples({ ...plan, samplingMode: 'native' }, [tile], false)).toBe(true)
})

test('a recent native frame can be recalled without pinning any more tiles', () => {
  const coverage = new CoverageRetention()
  coverage.retain(frame('wide', 10000), 120)
  const focus = { view: { x: 0, y: 1.5, zoom: 1 }, width: 855, height: 928, dpr: 2 }
  coverage.retain({ ...frame('focus', 1000), native: focus }, 120)
  coverage.retain({ ...frame('high', 100), native: { ...focus, view: { ...focus.view, zoom: 32 } } }, 120)
  expect(coverage.nativeKeys(1, focus.view, 855, 928, 2)).toEqual(new Set(['focus']))
  expect(coverage.has('focus')).toBe(false)
  expect(coverage.has('high')).toBe(false)
  expect(coverage.has('wide')).toBe(true)
  coverage.trim(2, 120)
  expect(coverage.nativeKeys(1, focus.view, 855, 928, 2)).toBeUndefined()
})
