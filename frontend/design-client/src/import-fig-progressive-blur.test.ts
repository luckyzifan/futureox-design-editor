import { expect, test } from 'vitest'
import { mapFigBlurEffect } from './import-fig'

const ramp = {
  type: 'BACKGROUND_BLUR', visible: true, radius: 8, startRadius: 0, blurType: 'PROGRESSIVE',
  startOffset: { x: 0, y: 0.5 }, endOffset: { x: 1, y: 0.5 },
}

test('a FIG progressive background blur becomes two editable ends on the layer box', () => {
  const notes: string[] = []
  const mapped = mapFigBlurEffect(ramp, 'background-blur', [80, 40], message => notes.push(message))
  expect(notes).toEqual([])
  expect(mapped.radius).toBe(1)
  expect(mapped.gradientBlur).toEqual({ start: [0, 20], end: [80, 20], startCount: 0, endCount: 8, smooth: true })
})

test('equal radii and radii outside the strength field stay uniform and name the limit', () => {
  const equalNotes: string[] = []
  const equal = mapFigBlurEffect(
    { type: 'BACKGROUND_BLUR', radius: 6, startRadius: 6, blurType: 'PROGRESSIVE' },
    'background-blur', [80, 40], message => equalNotes.push(message),
  )
  expect(equal.gradientBlur).toBeUndefined()
  expect(equal.radius).toBe(6)
  expect(equalNotes).toEqual(['progressive-background-blur-equal-radii-kept-uniform'])

  const wideNotes: string[] = []
  const wide = mapFigBlurEffect(
    { ...ramp, radius: 80 },
    'background-blur', [80, 40], message => wideNotes.push(message),
  )
  expect(wide.gradientBlur).toBeUndefined()
  expect(wide.radius).toBeUndefined()
  expect(wideNotes).toEqual(['progressive-background-blur-radius-outside-model'])
})

test('a style or override without a layer box cannot place the two ends', () => {
  const notes: string[] = []
  const mapped = mapFigBlurEffect(ramp, 'background-blur', undefined, message => notes.push(message))
  expect(mapped.gradientBlur).toBeUndefined()
  expect(mapped.radius).toBeUndefined()
  expect(notes).toEqual(['progressive-background-blur-needs-layer-bounds'])
})

test('progressive layer blur stays outside this background import', () => {
  const notes: string[] = []
  const mapped = mapFigBlurEffect(
    { type: 'LAYER_BLUR', radius: 6, startRadius: 0, blurType: 'PROGRESSIVE', startOffset: { x: 0, y: 0 }, endOffset: { x: 1, y: 0 } },
    'blur', [80, 40], message => notes.push(message),
  )
  expect(mapped.gradientBlur).toBeUndefined()
  expect(notes).toEqual(['progressive-layer-blur-outside-background-scope'])
})

test('an ordinary background blur is left unchanged', () => {
  const notes: string[] = []
  const mapped = mapFigBlurEffect({ type: 'BACKGROUND_BLUR', radius: 4 }, 'background-blur', [80, 40], message => notes.push(message))
  expect(mapped).toEqual({})
  expect(notes).toEqual([])
})
