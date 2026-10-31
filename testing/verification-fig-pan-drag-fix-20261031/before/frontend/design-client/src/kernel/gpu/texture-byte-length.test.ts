import { expect, test } from 'vitest'
import { textureByteLength } from './texture-byte-length'

test('texture byte accounting matches physical SDR and RGBA32F storage', () => {
  expect(textureByteLength(514, 514, 4)).toBe(1_056_784)
  expect(textureByteLength(514, 514, 16)).toBe(4_227_136)
})
test.each([NaN, Infinity, -Infinity, 0, -1, .25, Number.MAX_SAFE_INTEGER + 1])('invalid texture dimension %s is rejected', value => {
  expect(() => textureByteLength(value, 1, 4)).toThrow()
  expect(() => textureByteLength(1, value, 16)).toThrow()
})
test('safe dimensions cannot overflow exact byte accounting', () => {
  expect(() => textureByteLength(2 ** 26, 2 ** 26, 4)).toThrow(/字节数/)
})
