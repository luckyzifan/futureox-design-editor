import assert from 'node:assert/strict'
import test from 'node:test'
import { retainedCaptureMatches, retainedPixelOffset } from './edit-preview-pixels.ts'

test('integer physical shifts preserve authored coordinates at fractional DPR and zoom', () => {
  for (const [zoom, ratio, x, y] of [[1, 1, 1, -2], [2, 1.25, .4, -.8], [.4, 2.5, 3, -4], [32, 3, 1 / 96, -1 / 48]]) {
    const offset = { x, y }
    assert.equal(retainedPixelOffset(offset, zoom, ratio), offset)
  }
})

test('fractional physical shifts decline bitmap reuse without rounding the pointer', () => {
  for (const [zoom, ratio, x, y] of [[1, 1, .5, 0], [1, 1.25, 1, 0], [.4, 2, 1, 0], [32, 3, 0, .01]]) {
    const offset = { x, y }
    assert.equal(retainedPixelOffset(offset, zoom, ratio), null)
    assert.deepEqual(offset, { x, y })
  }
})

test('floating-point roundoff is allowed but genuine subpixel movement is not', () => {
  assert.ok(retainedPixelOffset({ x: .1 + .2, y: 0 }, 10, 1))
  assert.equal(retainedPixelOffset({ x: .30001, y: 0 }, 10, 1), null)
})

test('invalid or unsafe movement cannot enter the retained pixel path', () => {
  for (const bad of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(retainedPixelOffset({ x: bad, y: 0 }, 1, 1), null)
  for (const bad of [NaN, Infinity, 0, -1]) {
    assert.equal(retainedPixelOffset({ x: 0, y: 0 }, bad, 1), null)
    assert.equal(retainedPixelOffset({ x: 0, y: 0 }, 1, bad), null)
  }
})

test('capture reuse requires the same camera, viewport, and full display density', () => {
  const view = { x: 12.5, y: -9.25, zoom: 1.6 }, size = { width: 801.3, height: 603.7 }
  const capture = { view, size, pixels: { pixelRatio: 1.25, devicePixelRatio: 1.25 } }
  assert.equal(retainedCaptureMatches(capture, { ...view }, { ...size }, 1.25), true)
  for (const field of ['x', 'y', 'zoom'])
    assert.equal(retainedCaptureMatches(capture, { ...view, [field]: view[field] + .1 }, size, 1.25), false)
  for (const field of ['width', 'height'])
    assert.equal(retainedCaptureMatches(capture, view, { ...size, [field]: size[field] + .1 }, 1.25), false)
  assert.equal(retainedCaptureMatches(capture, view, size, 2), false)
  assert.equal(retainedCaptureMatches({ ...capture, pixels: { pixelRatio: 1, devicePixelRatio: 1.25 } }, view, size, 1.25), false)
})
