import { expect, test } from 'vitest'
import { nativeTileMotionScale } from './canvas-raster-plan'
import { continuousZoomInScale } from './continuous-zoom-scale'
import { MAX_PREVIEW_SCALE_RATIO } from './tile-preview'

const size = { width: 1440, height: 960 }

test('a fit picture stretched to 394% schedules the current motion lattice, not the half-octave rung', () => {
  const shown = 0.403 * 2
  const nearMotion = nativeTileMotionScale({ x: 100, y: 80, zoom: 0.7 }, 2, size.width, size.height)
  const near = continuousZoomInScale({ shown, native: 0.7 * 2, previous: 0, motion: nearMotion })
  // 70% is still inside the preview ratio of a 40.3% fit, so the coarse step stays.
  expect(near).toBeLessThan(shown * MAX_PREVIEW_SCALE_RATIO)
  const farView = { x: 100, y: 80, zoom: 3.942 }
  const motion = nativeTileMotionScale(farView, 2, size.width, size.height)
  const far = continuousZoomInScale({ shown, native: farView.zoom * 2, previous: near, motion })
  expect(far).toBe(motion)
  expect(far).toBeGreaterThanOrEqual(shown * MAX_PREVIEW_SCALE_RATIO)
  // The old half-octave choice from this fit density is 1. It cannot replace the picture.
  expect(near).toBeLessThan(shown * MAX_PREVIEW_SCALE_RATIO)
  const heldMotion = nativeTileMotionScale({ ...farView, zoom: 4.1 }, 2, size.width, size.height)
  const held = continuousZoomInScale({ shown, native: 4.1 * 2, previous: far, motion: heldMotion })
  expect(held).toBe(far)
})

test('a continuous zoom inside the preview ratio keeps its lattice until the shown density catches up', () => {
  const shown = 0.5
  const first = continuousZoomInScale({
    shown, native: 0.45 * 2, previous: 0,
    motion: nativeTileMotionScale({ x: 0, y: 0, zoom: 0.45 }, 2, 800, 600),
  })
  // 0.49 / 0.25 is still inside the preview ratio. 0.56 is not, and the
  // half-octave rung cannot replace the fit picture, so it must move.
  const inside = continuousZoomInScale({
    shown, native: 0.49 * 2, previous: first,
    motion: nativeTileMotionScale({ x: 0, y: 0, zoom: 0.49 }, 2, 800, 600),
  })
  expect(inside).toBe(first)
  const crossed = continuousZoomInScale({
    shown, native: 0.56 * 2, previous: first,
    motion: nativeTileMotionScale({ x: 0, y: 0, zoom: 0.56 }, 2, 800, 600),
  })
  expect(crossed).toBeGreaterThanOrEqual(shown * MAX_PREVIEW_SCALE_RATIO)
  const advanced = continuousZoomInScale({
    shown: first, native: 0.58 * 2, previous: first,
    motion: nativeTileMotionScale({ x: 0, y: 0, zoom: 0.58 }, 2, 800, 600),
  })
  expect(advanced).toBeGreaterThan(first)
})
