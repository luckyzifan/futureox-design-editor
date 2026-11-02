import { expect, test } from 'vitest'
import { SELECTION_BLUE, selectionOutlinePlan } from './selection-blue'

test('selection chrome uses the workspace blue, a 2px union, and per-object hairlines only when several layers are selected', () => {
  expect(SELECTION_BLUE).toBe('#3459d4')
  expect(selectionOutlinePlan(1)).toMatchObject({
    color: '#3459d4', hoverColor: '#859be5', unionStrokePx: 2, memberStrokePx: 0,
    hoverStrokePx: 1, handles: true, handlePx: 8, sizePill: 'accent', sizePillText: '#ffffff',
  })
  expect(selectionOutlinePlan(3)).toMatchObject({ memberStrokePx: 1, unionStrokePx: 2, handles: true })
  expect(selectionOutlinePlan(1).hoverColor).not.toBe(selectionOutlinePlan(1).color)
})
