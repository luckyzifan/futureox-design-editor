import { expect, test } from 'vitest'
import { acceptNativeSample, frameHandoff } from './frame-handoff'

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
