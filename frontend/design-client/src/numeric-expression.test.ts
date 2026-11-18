import { expect, test } from 'vitest'
import { numericExpression, propertyExpression } from './numeric-expression'

test('property arithmetic preserves full values and supports explicit relative edits', () => {
  expect(numericExpression('100 + 11 / 16', 50)).toBe(100.6875)
  expect(numericExpression('(100 + 11) / 16', 50)).toBe(6.9375)
  expect(numericExpression('+= 2.125', 10.0625)).toBe(12.1875)
  expect(numericExpression('50%', 111.0625, 'length')).toBe(55.53125)
  expect(numericExpression('50%', 20, 'percent')).toBe(50)
  expect(numericExpression('*=50%', 20, 'percent')).toBe(10)
  expect(numericExpression('1e2 / -4', 0)).toBe(-25)
})
test('leading operators use the current value while signed coordinates and powers stay available', () => {
  expect(propertyExpression('+40', 160)).toBe(200)
  expect(propertyExpression('*2', 40)).toBe(80)
  expect(propertyExpression('/2', 160)).toBe(80)
  expect(propertyExpression('-20', 160)).toBe(-20)
  expect(propertyExpression('-=20', 160)).toBe(140)
  expect(propertyExpression('*50%', 20, 'percent')).toBe(10)
  expect(numericExpression('+2', 1)).toBe(2)
  expect(numericExpression('2^3^2', 0)).toBe(512)
  expect(numericExpression('-2^2 + 2^-2', 0)).toBe(-3.75)
  expect(numericExpression('350/2+25', 150, 'length')).toBe(200)
})
test('length, angular and time units have explicit conversions', () => {
  expect(numericExpression('72pt', 0, 'length')).toBe(96)
  expect(numericExpression('1in', 0, 'length')).toBe(96)
  expect(numericExpression('.25turn', 0, 'angle')).toBe(90)
  expect(numericExpression('1.5s', 0, 'time')).toBe(1500)
  expect(() => numericExpression('2cm', 0, 'angle')).toThrow()
})
test('invalid/expensive expressions cannot execute code or yield nonfinite values', () => {
  for (const text of ['', '1/0', '/0', '2^1024', '1e999', 'NaN', 'Math.random()', 'globalThis.x=1', '1;2', '2 ** 10', '(2+3', ')4', '('.repeat(30)+'1'+')'.repeat(30), '1'.repeat(257)])
    expect(() => numericExpression(text, 1)).toThrow()
})
