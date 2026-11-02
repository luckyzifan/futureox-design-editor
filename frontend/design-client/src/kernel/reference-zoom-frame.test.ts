import { expect, test } from 'vitest'
import { referenceFrameCoveragePx, retainMovedReferenceFrame } from './reference-zoom-frame'

const view = { width: 800, height: 600 }

test('a finished zoom-out still covers the viewport and is kept', () => {
  const finished = { x: 0, y: 0, zoom: 0.5 }
  const requested = { x: 0, y: 0, zoom: 0.5 }
  expect(referenceFrameCoveragePx(requested, finished, view.width, view.height, view.width, view.height)).toBe(800 * 600)
  expect(retainMovedReferenceFrame({
    finished, requested, displayed: { view: { x: 0, y: 0, zoom: 1 }, width: 800, height: 600 },
    frameWidth: 800, frameHeight: 600, viewportWidth: 800, viewportHeight: 600,
  })).toBe(true)
})

test('an intermediate zoom-out replaces a tighter crop and a later zoom-in does not', () => {
  const requested = { x: 0, y: 0, zoom: 0.25 }
  const tight = { view: { x: 0, y: 0, zoom: 1 }, width: 800, height: 600 }
  const wider = { x: 0, y: 0, zoom: 0.5 }
  expect(retainMovedReferenceFrame({
    finished: wider, requested, displayed: tight,
    frameWidth: 800, frameHeight: 600, viewportWidth: 800, viewportHeight: 600,
  })).toBe(true)
  expect(referenceFrameCoveragePx(requested, wider, 800, 600, 800, 600))
    .toBeGreaterThan(referenceFrameCoveragePx(requested, tight.view, 800, 600, 800, 600))
  expect(retainMovedReferenceFrame({
    finished: { x: 0, y: 0, zoom: 2 }, requested, displayed: { view: wider, width: 800, height: 600 },
    frameWidth: 800, frameHeight: 600, viewportWidth: 800, viewportHeight: 600,
  })).toBe(false)
})

test('the first finished frame is shown when nothing is on screen', () => {
  expect(retainMovedReferenceFrame({
    finished: { x: 10, y: -4, zoom: 1 }, requested: { x: 40, y: 12, zoom: 0.2 }, displayed: null,
    frameWidth: 400, frameHeight: 300, viewportWidth: 400, viewportHeight: 300,
  })).toBe(true)
})
