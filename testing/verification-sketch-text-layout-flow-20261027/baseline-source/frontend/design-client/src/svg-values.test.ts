import { expect, test } from 'vitest'
import { svgAbsoluteLength, svgNumber, svgNumberList } from './svg-values'
import { svgTransform } from './import-svg'
import { apply } from './geometry'

test.each([
  ['96', 96], ['96px', 96], ['1in', 96], ['2.54cm', 96], ['25.4mm', 96],
  ['101.6Q', 96], ['72pt', 96], ['6pc', 96], ['  .5e2px  ', 50], ['-2.5e1pt', -100 / 3],
] as const)('absolute length %s converts without rounding', (source, expected) => {
  expect(svgAbsoluteLength(source, 'x')).toBeCloseTo(expected, 12)
})

test.each(['NaN', 'Infinity', '1e309', '0x10', '', '.', '+', '1 2', '10%','1em', '1rem', 'calc(2px)', '2px!important'])('unsupported/malformed length %s is explicit', source => {
  expect(() => svgAbsoluteLength(source, 'width')).toThrow(/SVG/)
})

test('strict number grammar and comma-whitespace lists do not use JavaScript coercion', () => {
  expect(svgNumber('-.25e+2', 'test')).toBe(-25)
  expect(svgNumberList('1, 2\t3\n4', 'viewBox')).toEqual([1, 2, 3, 4])
  for (const source of ['0x10', '0b10', 'NaN', 'Infinity', '']) expect(() => svgNumber(source, 'test')).toThrow()
  for (const source of ['1,,2', '1,', ',1', '1-2', '1 0x10']) expect(() => svgNumberList(source, 'viewBox')).toThrow()
})

test('attribute transforms accept adjacent signed numbers and preserve order/rotation center', () => {
  expect(svgTransform('translate(10-20)')).toEqual([1, 0, 0, 1, 10, -20])
  expect(svgTransform('matrix(1 0 0 1 .25-.5)')).toEqual([1, 0, 0, 1, .25, -.5])
  expect(svgTransform('translate(10,20) scale(2,3)')).toEqual([2, 0, 0, 3, 10, 20])
  const point = apply(svgTransform('rotate(90,10,20)'), { x: 10, y: 21 })
  expect(point.x).toBeCloseTo(9, 12)
  expect(point.y).toBeCloseTo(20, 12)
})

test.each(['translate()', 'translate(1 2 3)', 'scale()', 'scale(1,2,3)', 'rotate(45 10)', 'rotate(1 2 3 4)', 'skewX()', 'skewY(1 2)', 'matrix(1 2 3)', 'translate(0x10 0)', 'scale(1e309)', 'scale(1e308) scale(1e308)', 'translate(1,,2)', 'translate(1,)', ',scale(1)', 'scale(1),,scale(2)', 'scale(1),', 'scale(1) garbage', 'scaleX(1)', 'constructor(1)', 'toString(1)'])('invalid transform %s never emits an invalid matrix', source => {
  expect(() => svgTransform(source)).toThrow(/SVG/)
})

test('transform count and function argument budget reject bounded adversarial inputs', () => {
  expect(svgTransform('scale(1) '.repeat(20000))).toEqual([1, 0, 0, 1, 0, 0])
  expect(() => svgTransform('scale(1) '.repeat(20001))).toThrow(/20000/)
  expect(() => svgTransform(`matrix(${'1 '.repeat(100000)})`)).toThrow(/参数/)
  expect(() => svgTransform('matrix('.repeat(100000))).toThrow(/语法/)
  expect(() => svgTransform('a'.repeat(100000))).toThrow(/语法/)
})
