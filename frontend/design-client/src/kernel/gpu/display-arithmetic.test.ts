import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { displayArithmeticSource } from './display-arithmetic'
test('display specialization keeps blend equations and color conversion while using native arithmetic', () => {
  const source = ['sampling', 'vector'].map(file => readFileSync(new URL(`../../../../../design-studio/crates/design-kernel/shaders/${file}.wgsl`, import.meta.url), 'utf8')).join('\n')
  const display = displayArithmeticSource(source)
  expect(display).toContain('fn addRN(a:f32,b:f32)->f32{return a+b;}')
  expect(display).toContain('fn mulRN(a:f32,b:f32)->f32{return a*b;}')
  expect(display.includes('fn divideRN(a:f32,b:f32)->f32 {return a/b;}')).toBe(true)
  expect(display).toContain('fn sqrtRN(a:f32)->f32{return sqrt(a);}')
  expect(displayArithmeticSource(source,false).includes('fn divideRN(a:f32,b:f32)->f32 {return a/b;}')).toBe(false)
  for (const name of ['displayColor', 'linearImageTexel', 'channel', 'blendRN']) {
    const start = source.indexOf(`fn ${name}(`), end = source.indexOf('\nfn ', start + 3)
    expect(start).toBeGreaterThan(-1)
    expect(display).toContain(source.slice(start, end < 0 ? undefined : end))
  }
  expect(() => displayArithmeticSource('fn addRN(){}')).toThrow('Unexpected compositor function')
})
