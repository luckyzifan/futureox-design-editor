import { expect, test } from 'vitest'
import { acceptNativeSample, densityCertifiesDemand, frameHandoff, settledCoverageChoice } from './frame-handoff'

const ready = {
  sameRevision: true,
  sameCamera: true,
  nativeDensity: true,
  nativePhase: true,
  viewportCovered: true,
  regional: false,
}

test('screen ready requires revision, camera, density, phase and full coverage', () => {
  expect(frameHandoff(ready)).toBe('screen-ready')
  expect(frameHandoff({ ...ready, sameRevision: false })).toBe('reject')
  expect(frameHandoff({ ...ready, sameCamera: false })).toBe('preview')
  expect(frameHandoff({ ...ready, nativeDensity: false })).toBe('preview')
  expect(frameHandoff({ ...ready, nativePhase: false })).toBe('preview')
  expect(frameHandoff({ ...ready, viewportCovered: false })).toBe('preview')
  expect(frameHandoff({ ...ready, regional: true, viewportCovered: false })).toBe('partial-sharp')
  expect(frameHandoff({ ...ready, regional: true, viewportCovered: true })).toBe('partial-sharp')
  expect(acceptNativeSample({ sameRevision: true, nativeDensity: true, nativePhase: false })).toBe(false)
})

test('a stale high zoom does not certify the current low-zoom sample', () => {
  expect(densityCertifiesDemand([{ zoom: 0.5 }, { zoom: 0.5 }], 0.5)).toBe(true)
  expect(densityCertifiesDemand([{ zoom: 64 }, { zoom: 0.5 }], 0.5)).toBe(false)
  expect(densityCertifiesDemand([], 0.5)).toBe(false)
  const exact = [{ key: '0.5:0', zoom: 0.5 }, { key: '0.5:1', zoom: 0.5 }]
  const returned = settledCoverageChoice({
    stored: [...exact, { key: '64:0', zoom: 64 }],
    exact, exactComplete: true, targetScale: 0.5,
  })
  expect(returned.certify).toBe(true)
  expect(returned.continuity).toBe(false)
  expect(returned.tiles.map(tile => tile.zoom)).toEqual([0.5, 0.5])
  const waiting = settledCoverageChoice({
    stored: [{ key: '64:0', zoom: 64 }],
    exact: [], exactComplete: false, targetScale: 0.5,
  })
  expect(waiting).toMatchObject({ certify: false, continuity: true })
  const strip = settledCoverageChoice({
    stored: [{ key: 'strip', zoom: 0.5 }],
    exact: [{ key: 'lattice', zoom: 1 }],
    exactComplete: true, targetScale: 1,
  })
  expect(strip.tiles.map(tile => tile.key)).toEqual(['strip'])
  expect(strip.certify).toBe(true)
  expect(strip.continuity).toBe(true)
})
