import { expect, test } from 'vitest'
import { acceptFinishedReferenceFrame, referenceFrameCoveragePx, referenceOverlayCamera, retainMovedReferenceFrame } from './reference-zoom-frame'

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

test('a zoom-out after rotation does not publish a tighter crop over the wide frame', () => {
  const wide = { view: { x: 0, y: 0, zoom: 1.25 }, width: 900, height: 700 }
  const tight = { x: 12, y: -8, zoom: 8 }
  const live = { x: 4, y: -2, zoom: 0.2 }
  expect(acceptFinishedReferenceFrame({
    live, finished: tight, displayed: wide,
    frameWidth: 900, frameHeight: 700, viewportWidth: 900, viewportHeight: 700,
    renderViewCurrent: true,
  })).toBe(false)
  expect(acceptFinishedReferenceFrame({
    live, finished: { x: 0, y: 0, zoom: 0.5 }, displayed: wide,
    frameWidth: 900, frameHeight: 700, viewportWidth: 900, viewportHeight: 700,
    renderViewCurrent: false,
  })).toBe(true)
  expect(acceptFinishedReferenceFrame({
    live: { x: 0, y: 0, zoom: 8 }, finished: tight, displayed: wide,
    frameWidth: 900, frameHeight: 700, viewportWidth: 900, viewportHeight: 700,
    renderViewCurrent: true,
  })).toBe(true)
})

test('cpu overlay chrome follows the live zoom instead of the pre-rotation frame', () => {
  const live = { x: 4, y: -2, zoom: 0.2 }
  const presented = { x: 0, y: 0, zoom: 1.25 }
  expect(referenceOverlayCamera({ cpu: true, live, presented, scopeMatches: true, editPreview: false })).toEqual(live)
  expect(referenceOverlayCamera({ cpu: false, live, presented, scopeMatches: true, editPreview: false })).toEqual(presented)
  const held = { x: 12, y: -4, zoom: 24 }
  const page = { x: 0, y: 0, zoom: 1 }
  expect(referenceOverlayCamera({
    cpu: false, live: held, presented: page, scopeMatches: true, editPreview: false,
    viewport: { width: 800, height: 600 },
  })).toEqual(held)
  expect(referenceOverlayCamera({ cpu: false, live, presented: null, scopeMatches: false, editPreview: false })).toEqual(live)
})

test('the first finished frame is shown when nothing is on screen', () => {
  expect(retainMovedReferenceFrame({
    finished: { x: 10, y: -4, zoom: 1 }, requested: { x: 40, y: 12, zoom: 0.2 }, displayed: null,
    frameWidth: 400, frameHeight: 300, viewportWidth: 400, viewportHeight: 300,
  })).toBe(true)
})
