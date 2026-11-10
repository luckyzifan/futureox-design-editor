import { expect, test } from 'vitest'
import { dominantUpscale, zoomInFramePastPlan } from './coverage-stack'
import type { RasterTile } from './tile-cache'

const size = { width: 800, height: 600 }
const tile = (key: string, zoom: number, x: number, y: number, span = 512): RasterTile => ({
  key, x: x * zoom - 1, y: y * zoom - 1, width: span + 2, height: span + 2, zoom, gutter: 1,
})

test('a finished coarse lattice still publishes a ready finer region of the current camera', () => {
  const view = { x: 0, y: 0, zoom: 8 }
  const backing = tile('backing', 1, 0, 0, 800)
  const coarse = tile('coarse', 2, 0, 0, 800)
  const sharp = tile('sharp', 8, 40, 20, 200)
  const frame = zoomInFramePastPlan([backing, coarse, sharp], [backing], view, size, 2)
  expect(frame?.map(item => item.key)).toContain('sharp')
  expect(frame?.map(item => item.key)).toContain('backing')
  expect(dominantUpscale([coarse], view, size)).toBe(4)
  expect(zoomInFramePastPlan([backing, coarse], [backing], view, size, 2)).toBeUndefined()
  const covered = tile('covered', 8, 0, 0, 1600)
  expect(zoomInFramePastPlan([covered], [backing], view, size, 2)?.map(item => item.key)).toEqual(['covered'])
  expect(zoomInFramePastPlan([sharp], [backing], view, size, 2)).toBeUndefined()
})
