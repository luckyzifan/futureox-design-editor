import { expect, test } from 'vitest'
import { effect } from '../../model'
import { compositorModes } from './compositor-modes'
import type { GpuScene } from './types'

function scene(kind: 'blur' | 'background-blur', progressive: boolean, visible = true): GpuScene {
  const fx = effect(kind)
  fx.visible = visible
  fx.radius = 1
  if (progressive) fx.gradientBlur = { start: [0, 4], end: [32, 4], startCount: 0, endCount: 6, smooth: true }
  return { nodes: { lens: { blend: 'normal', fills: [], strokes: [], effects: [fx] } } } as unknown as GpuScene
}

test('managed WebGPU prepares the shared gradient composite for progressive background blur', () => {
  expect(compositorModes(scene('background-blur', true)).has(46)).toBe(true)
  expect(compositorModes(scene('blur', true)).has(46)).toBe(true)
  expect(compositorModes(scene('background-blur', false)).has(46)).toBe(false)
  expect(compositorModes(scene('background-blur', true, false)).has(46)).toBe(false)
})
