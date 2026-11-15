import { expect, test } from 'vitest'
import { layoutFixture, named } from './layout-fixtures'
import { validateDocument, defaultSizing, LAYOUT_GAP_LIMIT } from './model'
test('responsive metadata including signed gaps survives JSON import', () => {
  const d = layoutFixture('grid')
  Object.assign(named(d, '容器').layout!, { gap: -1, lineGap: -8 })
  expect(validateDocument(JSON.parse(JSON.stringify(d)))).toEqual(d)
})
test('invalid flow, track count, gap bounds and padding are rejected', () => {
  for (const patch of [
    { mode: 'css' },
    { columns: 0 },
    { gap: -LAYOUT_GAP_LIMIT - 1 },
    { lineGap: LAYOUT_GAP_LIMIT + 1 },
    { gap: -Infinity },
    { padding: [0, 0, -1, 0] },
    { padding: [0, 0, 0, Infinity] },
  ]) {
    const d = layoutFixture('grid')
    Object.assign(named(d, '容器').layout!, patch)
    expect(() => validateDocument(d)).toThrow()
  }
})
test('contradictory sizing and constraint references are rejected', () => {
  const d = layoutFixture('horizontal'),
    n = named(d, '填满项目')
  n.sizing = { ...defaultSizing(), minWidth: 300, maxWidth: 200 }
  expect(() => validateDocument(d)).toThrow()
  delete n.sizing
  n.constraints = { horizontal: 'end', vertical: 'start', referenceWidth: -1 }
  expect(() => validateDocument(d)).toThrow()
})
