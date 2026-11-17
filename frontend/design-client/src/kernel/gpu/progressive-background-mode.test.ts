import { expect, test } from 'vitest'
import { effect } from '../../model'
import { compositorModes } from './compositor-modes'
import type { GpuScene } from './types'

function scene(kind: 'blur' | 'background-blur', progressive: boolean, visible = true, floatCompositing = false): GpuScene {
  const fx = effect(kind)
  fx.visible = visible
  fx.radius = 1
  if (progressive) fx.gradientBlur = { start: [0, 4], end: [32, 4], startCount: 0, endCount: 6, smooth: true }
  return { floatCompositing, nodes: { lens: { blend: 'normal', fills: [], strokes: [], effects: [fx] } } } as unknown as GpuScene
}

test('progressive backdrop prepares the compositor that matches the scene precision', () => {
  expect(compositorModes(scene('background-blur', true)).has(65)).toBe(true)
  expect(compositorModes(scene('background-blur', true)).has(46)).toBe(false)
  const floating = compositorModes(scene('background-blur', true, true, true))
  expect(floating.has(46)).toBe(true)
  expect(floating.has(65)).toBe(false)
  expect(compositorModes(scene('blur', true)).has(46)).toBe(true)
  expect(compositorModes(scene('background-blur', false)).has(65)).toBe(false)
  expect(compositorModes(scene('background-blur', true, false)).has(65)).toBe(false)
})
