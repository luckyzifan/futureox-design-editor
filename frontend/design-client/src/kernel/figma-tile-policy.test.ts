import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { FrameDebouncedValue } from './frame-debounced-value'
import { planTiles } from './tile-cache'
import { planTilesWithPrefetchRim } from './tile-plan-aligned'
import { tileViewportDistance, tileOverlapsViewport } from './tile-scheduler'

test('frame debounce matches the captured Figma class on interrupted, reversed and repeated updates', () => {
  const source = readFileSync(new URL('../../../../figma-wasm-analysis/evidence/js-mining-2026-10-16/viewer-tile-scheduler.js', import.meta.url), 'utf8')
  const start = source.indexOf('class mP{'), end = source.indexOf('class mD{', start)
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
  // Execute only the captured value queue; rq is its inert value wrapper.
  // No reference application, network or environment code is evaluated.
  const Reference = new Function('rq', `return (${source.slice(start, end)})`)(class { constructor(public value: number) {} })
  let actualChanges = 0, referenceChanges = 0
  const reference = new Reference(() => {}, 2, (a: number, b: number) => a === b, () => referenceChanges++)
  const actual = new FrameDebouncedValue<number>(2, (a, b) => a === b)
  let seed = 51831
  for (let step = 0; step < 2000; step++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    if (step === 0 || seed % 3) {
      const value = [0.473, 0.5, 1, 1.01, 2, 2.78][seed % 6]
      reference.queueValue(value); if (actual.queue(value)) actualChanges++
    } else { reference.onFrame(); if (actual.onFrame()) actualChanges++ }
    expect(actual.value).toBe(reference.getValue())
    expect(actual.pending).toBe(reference.hasQueuedValue())
    expect(actualChanges).toBe(referenceChanges)
  }
  actual.clear(); reference.clear()
  expect(actual.queue(0.1)).toBe(true); reference.queueValue(0.1)
  expect(actual.value).toBe(reference.getValue()); expect(actual.pending).toBe(false)
})

test('bounded prefetch equals exhaustive viewport-height expansion and distance ordering', () => {
  for (const zoom of [.473, 1, 2.78]) for (const phase of [{ x: 0, y: 0 }, { x: .25, y: .75 }]) {
    const bounds = { x: -63.25, y: 118.375, width: 900 / zoom, height: 750 / zoom }
    const expanded = { x: bounds.x - bounds.height, y: bounds.y - bounds.height,
      width: bounds.width + 2 * bounds.height, height: 3 * bounds.height }
    const all = planTiles(expanded, zoom, 4096, phase)
    const viewport = planTiles(bounds, zoom, 256, phase), visible = new Set(viewport.map(t => t.key))
    const reference = all.filter(t => !visible.has(t.key)).sort((a, b) =>
      tileViewportDistance(a, bounds) - tileViewportDistance(b, bounds) || a.y - b.y || a.x - b.x)
    for (const limit of [viewport.length, viewport.length + 3, 64, 256]) {
      const actual = planTilesWithPrefetchRim(bounds, zoom, limit, phase)
      const expected = reference.slice(0, limit - viewport.length)
      expect(actual.rim.map(t => t.key)).toEqual(expected.map(t => t.key))
      expect(actual.cacheLimitSkipped).toBe(reference.length - expected.length)
      expect(actual.rim.every(t => !tileOverlapsViewport(t, bounds))).toBe(true)
    }
  }
})

test('overlap gutters and fractional phases cannot spend the viewport exemption', () => {
  const tile = { key: 'edge', x: 511, y: -1, width: 514, height: 514, zoom: 1 }
  expect(tileOverlapsViewport(tile, { x: 0, y: 0, width: 512, height: 512 })).toBe(false)
  expect(tileViewportDistance(tile, { x: 0, y: 0, width: 512, height: 512 })).toBe(0)
  expect(tileOverlapsViewport({ ...tile, phaseX: .25 }, { x: 0, y: 0, width: 512, height: 512 })).toBe(true)
})
