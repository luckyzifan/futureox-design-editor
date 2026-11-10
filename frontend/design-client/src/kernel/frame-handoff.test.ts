import { expect, test } from 'vitest'
import { acceptNativeSample, frameHandoff, partialSharpSample } from './frame-handoff'

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

test('a regional sample is partial-sharp and never screen-ready', () => {
  expect(partialSharpSample({ sameRevision: true, nativeDensity: true, nativePhase: true })).toBe(true)
  expect(partialSharpSample({ sameRevision: false, nativeDensity: true, nativePhase: true })).toBe(false)
  expect(partialSharpSample({ sameRevision: true, nativeDensity: false, nativePhase: true })).toBe(false)
  expect(partialSharpSample({ sameRevision: true, nativeDensity: true, nativePhase: false })).toBe(false)
  expect(frameHandoff({ ...ready, regional: true, viewportCovered: true })).not.toBe('screen-ready')
})
