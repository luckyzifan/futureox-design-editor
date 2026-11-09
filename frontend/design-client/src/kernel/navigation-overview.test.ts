import { expect, test } from 'vitest'
import { coarsePanCoverNeeded } from './navigation-overview'

const base = {
  firstNative: false, hasStrip: true, stripCached: false, pasteboard: false, cpuOnly: false,
  translated: false, moving: true, continuousZoom: true, translationFollow: false, residentsCover: false,
}

test('pasteboard still asks for the coarse strip when the camera is quiet', () => {
  expect(coarsePanCoverNeeded({ ...base, pasteboard: true, moving: false, continuousZoom: false })).toBe(true)
  expect(coarsePanCoverNeeded({ ...base, pasteboard: true, moving: true, continuousZoom: true })).toBe(false)
  expect(coarsePanCoverNeeded({ ...base, pasteboard: true, translated: true })).toBe(true)
})

test('a pan that leaves resident pictures asks for the strip before the old refine', () => {
  expect(coarsePanCoverNeeded({ ...base, translationFollow: true, residentsCover: false })).toBe(true)
  expect(coarsePanCoverNeeded({ ...base, translationFollow: true, residentsCover: true })).toBe(false)
  expect(coarsePanCoverNeeded({ ...base, translationFollow: false })).toBe(false)
  expect(coarsePanCoverNeeded({ ...base, translationFollow: true, firstNative: true })).toBe(false)
  expect(coarsePanCoverNeeded({ ...base, translationFollow: true, stripCached: true })).toBe(false)
})
