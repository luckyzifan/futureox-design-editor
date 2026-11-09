import { expect, test } from 'vitest'
import { choosePreparedTile } from './zoom-refinement-policy'

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
