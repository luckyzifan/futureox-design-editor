import { expect, test } from 'vitest'
import { numericExpression } from './numeric-expression'

test('property arithmetic preserves full values and supports explicit relative edits', () => {
  expect(numericExpression('100 + 11 / 16', 50)).toBe(100.6875)
  expect(numericExpression('(100 + 11) / 16', 50)).toBe(6.9375)
  expect(numericExpression('+= 2.125', 10.0625)).toBe(12.1875)
  expect(numericExpression('50%', 111.0625, 'length')).toBe(55.53125)
  expect(numericExpression('50%', 20, 'percent')).toBe(50)
  expect(numericExpression('*=50%', 20, 'percent')).toBe(10)
  expect(numericExpression('1e2 / -4', 0)).toBe(-25)
})
test('length, angular and time units have explicit conversions', () => {
  expect(numericExpression('72pt', 0, 'length')).toBe(96)
  expect(numericExpression('1in', 0, 'length')).toBe(96)
  expect(numericExpression('.25turn', 0, 'angle')).toBe(90)
  expect(numericExpression('1.5s', 0, 'time')).toBe(1500)
  expect(() => numericExpression('2cm', 0, 'angle')).toThrow()
})
test('invalid/expensive expressions cannot execute code or yield nonfinite values', () => {
  for (const text of ['', '1/0', '1e999', 'NaN', 'Math.random()', 'globalThis.x=1', '1;2', '2 ** 10', '(2+3', ')4', '('.repeat(30)+'1'+')'.repeat(30), '1'.repeat(257)])
    expect(() => numericExpression(text, 1)).toThrow()
})
