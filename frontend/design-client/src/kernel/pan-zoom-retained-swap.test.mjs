import test from 'node:test'
import assert from 'node:assert/strict'
import { keepCompleteCameraBacking } from './navigation-backing.ts'

const frame = (over) => ({ dpr: 2, interaction: false, ids: [1], ...over })

test('a same-zoom pan publishes only a strip outside the retained picture', () => {
  const backing = frame({ view: { x: 10, y: 20, zoom: 1 }, width: 100, height: 80 })
  const next = { ...backing, view: { x: backing.view.x - 30, y: backing.view.y, zoom: 1 }, preview: true }
  const strip = { ...next, previewGaps: [{ x: 180, y: 0, width: 20, height: 160 }] }
  const overOld = { ...next, previewGaps: [{ x: 80, y: 0, width: 20, height: 160 }] }
  assert.equal(keepCompleteCameraBacking(backing, strip, true, false, next), false)
  assert.equal(keepCompleteCameraBacking(backing, strip, true, false, next, backing), false)
  assert.equal(keepCompleteCameraBacking(backing, overOld, true, false, next), true)
  assert.equal(keepCompleteCameraBacking(backing, overOld, true, false, next, backing), true)
})

test('a within-limit zoom preview cannot clear retained pixels just because a wide atlas contains them', () => {
  const backing = frame({ view: { x: 0, y: 0, zoom: 1 }, width: 800, height: 600, dpr: 1 })
  const target = { view: { x: -120, y: -90, zoom: 1.4 }, width: 800, height: 600 }
  const next = frame({
    ...backing,
    view: target.view,
    width: target.width,
    height: target.height,
    dpr: 1,
    preview: true,
    previewGaps: [{ x: 40, y: 30, width: 720, height: 540 }],
  })
  const wide = { view: { x: 400, y: 300, zoom: 0.25 }, width: 4000, height: 3000 }
  assert.equal(keepCompleteCameraBacking(backing, next, true, true, target, wide, true), true)
  assert.equal(keepCompleteCameraBacking(backing, next, true, true, target), true)
})

test('existing camera handoff decisions stay in place', () => {
  const backing = frame({ view: { x: 10, y: 20, zoom: 1 }, width: 100, height: 80 })
  const fitted = { ...backing, view: { x: 0, y: 0, zoom: 0.15 }, preview: true, previewGaps: [{ x: 10, y: 10, width: 40, height: 30 }] }
  assert.equal(keepCompleteCameraBacking(backing, fitted, true), true)
  assert.equal(keepCompleteCameraBacking(backing, { ...fitted, preview: false, previewGaps: undefined }, true), false)
  const narrow = { ...backing, view: { x: -40, y: -20, zoom: 2 } }
  assert.equal(keepCompleteCameraBacking(backing, narrow, true, true), true)
  assert.equal(keepCompleteCameraBacking(backing, narrow, true, false, narrow), false)
  assert.equal(keepCompleteCameraBacking(backing, narrow, true, false, backing), true)
  assert.equal(keepCompleteCameraBacking(narrow, backing, true, true), false)
  assert.equal(keepCompleteCameraBacking(backing, narrow, false, true), false)
  const low = frame({ view: { x: 0, y: 0, zoom: 1 }, width: 100, height: 80 })
  const far = { ...low, view: { x: 0, y: 0, zoom: 8 }, preview: true }
  const live = { view: far.view, width: 100, height: 80 }
  assert.equal(keepCompleteCameraBacking(low, far, true, true, live), true)
  assert.equal(keepCompleteCameraBacking(low, { ...far, zoomUnderlay: true }, true, true, live), false)
  assert.equal(keepCompleteCameraBacking(low, { ...far, zoomUnderlay: true, previewGaps: [{ x: 0, y: 0, width: 4, height: 4 }] }, true, true, live), true)
  const high = { ...low, view: { x: 0, y: 0, zoom: 2 } }
  assert.equal(keepCompleteCameraBacking(low, high, true, true, live), false)
  assert.equal(keepCompleteCameraBacking(high, low, true, true, live), true)
  const wide = { view: { x: 0, y: 0, zoom: 1 }, width: 200, height: 200, dpr: 2, interaction: false, ids: [1] }
  const closer = { ...wide, view: { x: -20, y: -20, zoom: 1.2 }, ids: [2] }
  assert.equal(keepCompleteCameraBacking(wide, closer, true, true, closer), false)
  assert.equal(keepCompleteCameraBacking(wide, closer, true, true, closer, undefined, true), true)
  assert.equal(keepCompleteCameraBacking(wide, closer, true, false, closer, undefined, true), false)
  assert.equal(keepCompleteCameraBacking(wide, closer, true, true, closer, wide, true), false)
})
