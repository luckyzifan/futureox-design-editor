import { expect, test } from 'vitest'
import { choosePreparedTile, exactTilesBeforeOverview, quietPasteStripAllowed } from './zoom-refinement-policy'

const base = {
  aborted: false,
  generationCurrent: true,
  fillCurrent: true,
  enforceFill: true,
  channelIsCanvas: true,
  allowGapFill: false,
  canFillGap: false,
}

test('the same action chain keeps running, cancels, or covers one prepared gap', () => {
  expect(choosePreparedTile(base)).toEqual({ action: 'continue' })
  expect(choosePreparedTile({ ...base, aborted: true, generationCurrent: false })).toEqual({ action: 'cancel', reason: 'aborted' })
  expect(choosePreparedTile({ ...base, generationCurrent: false })).toEqual({ action: 'cancel', reason: 'generation' })
  expect(choosePreparedTile({ ...base, fillCurrent: false })).toEqual({ action: 'cancel', reason: 'fill' })
  expect(choosePreparedTile({ ...base, fillCurrent: false, channelIsCanvas: false })).toEqual({ action: 'continue' })
  expect(choosePreparedTile({ ...base, fillCurrent: false, enforceFill: false })).toEqual({ action: 'continue' })
  expect(choosePreparedTile({ ...base, fillCurrent: false, allowGapFill: true, canFillGap: false })).toEqual({ action: 'cancel', reason: 'fill' })
  expect(choosePreparedTile({ ...base, fillCurrent: false, allowGapFill: true, canFillGap: true })).toEqual({ action: 'cover-gap' })
})

test('missing exact tiles stay ahead of a page overview', () => {
  expect(exactTilesBeforeOverview(['a', 'b'], ['page'])).toEqual(['a', 'b'])
  expect(exactTilesBeforeOverview([], ['page'])).toEqual(['page'])
  expect(exactTilesBeforeOverview([], [])).toEqual([])
})

test('a quiet pasteboard strip waits until the exact lattice is cached', () => {
  expect(quietPasteStripAllowed({ moving: false, continuousZoom: false, exactMissing: 4 })).toBe(false)
  expect(quietPasteStripAllowed({ moving: false, continuousZoom: false, exactMissing: 0 })).toBe(true)
  expect(quietPasteStripAllowed({ moving: true, continuousZoom: false, exactMissing: 0 })).toBe(false)
  expect(quietPasteStripAllowed({ moving: false, continuousZoom: true, exactMissing: 0 })).toBe(false)
  expect(quietPasteStripAllowed({ moving: false, continuousZoom: false, exactMissing: -1 })).toBe(false)
})
