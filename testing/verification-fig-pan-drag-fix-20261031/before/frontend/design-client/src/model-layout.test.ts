import { expect, test } from 'vitest'
import { layoutFixture, named } from './layout-fixtures'
import { validateDocument, defaultSizing } from './model'
test('responsive metadata survives JSON import', () => {
  const d = layoutFixture('grid')
  expect(validateDocument(JSON.parse(JSON.stringify(d)))).toEqual(d)
})
test('invalid flow, tracks and padding are rejected', () => {
  for (const patch of [
    { mode: 'css' },
    { columns: 0 },
    { gap: -1 },
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
