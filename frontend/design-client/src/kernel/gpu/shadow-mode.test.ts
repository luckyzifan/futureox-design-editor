import { expect, test } from 'vitest'
import { effect } from '../../model'
import { compositorModes } from './compositor-modes'
import type { GpuScene } from './types'

test('a translucent knockout shadow prepares the silhouette compositor', () => {
  const shadow = effect('shadow')
  const shape = {
    blend: 'normal', fills: [], strokes: [], effects: [shadow], shadowPaintAlpha: 0.5,
  }
  const scene = { floatCompositing: true, nodes: { shape } } as unknown as GpuScene
  expect(compositorModes(scene).has(63)).toBe(false)
  shadow.shadowKnockout = true
  expect(compositorModes(scene).has(63)).toBe(true)
  shadow.visible = false
  expect(compositorModes(scene).has(63)).toBe(false)
})
