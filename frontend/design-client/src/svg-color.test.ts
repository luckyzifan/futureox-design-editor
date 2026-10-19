import { afterEach, expect, test, vi } from 'vitest'
import { svgColorParser } from './svg-color'

afterEach(() => vi.unstubAllGlobals())

test('opaque hex parsing is CPU-only, exact and import-local', () => {
  const createElement = vi.fn(() => { throw new Error('Canvas must not be requested') })
  vi.stubGlobal('document', { createElement })
  const parse = svgColorParser()
  for (let i = 0; i < 10000; i++) expect(parse('#AbC')).toBe('#aabbcc')
  expect(parse('  #abcdef ')).toBe('#abcdef')
  expect(createElement).not.toHaveBeenCalled()
})

test('fallback creates one context and normalizes each unique color once; invalid colors cannot reuse a previous value', () => {
  let assignments = 0, value = '#000000'
  // Deliberate Canvas host double: verifies cache and sentinel control flow,
  // not browser CSS color parsing or pixel fidelity.
  const context = {
    get fillStyle() { return value },
    set fillStyle(input: string) {
      assignments++
      if (/^#[\da-f]{6}$/i.test(input)) value = input.toLowerCase()
      if (input === 'red') value = '#ff0000'
      if (input === 'blue') value = '#0000ff'
      if (input === 'transparent') value = 'rgba(0, 0, 0, 0)'
    },
  }
  const getContext = vi.fn(() => context), createElement = vi.fn(() => ({ getContext }))
  vi.stubGlobal('document', { createElement })
  const parse = svgColorParser()
  for (let i = 0; i < 1000; i++) expect(parse('red')).toBe('#ff0000')
  expect(assignments).toBe(4)
  expect(parse('blue')).toBe('#0000ff')
  expect(assignments).toBe(8)
  expect(() => parse('invalid')).toThrow(/不支持/)
  expect(() => parse('transparent')).toThrow(/fill-opacity/)
  expect(createElement).toHaveBeenCalledTimes(1)
  expect(getContext).toHaveBeenCalledTimes(1)
  expect(svgColorParser()('red')).toBe('#ff0000')
  expect(createElement).toHaveBeenCalledTimes(2)
})
