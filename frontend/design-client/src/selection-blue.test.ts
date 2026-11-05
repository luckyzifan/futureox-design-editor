import { expect, test } from 'vitest'
import { SELECTION_BLUE, selectionOutlinePlan } from './selection-blue'

test('selection chrome uses the workspace blue, a 2px union, and per-object hairlines only when several layers are selected', () => {
  expect(SELECTION_BLUE).toBe('#4597f7')
  expect(selectionOutlinePlan(1)).toMatchObject({
    color: '#4597f7', hoverColor: '#4597f7', unionStrokePx: 1, memberStrokePx: 0,
    hoverStrokePx: 1, handles: true, handlePx: 8, sizePill: 'accent', sizePillText: '#ffffff',
  })
  expect(selectionOutlinePlan(3)).toMatchObject({ memberStrokePx: 1, unionStrokePx: 1, handles: true })
  expect(selectionOutlinePlan(1).hoverColor).toBe(selectionOutlinePlan(1).color)
})
