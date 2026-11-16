import assert from 'node:assert/strict'
import test from 'node:test'
import { ANALYTIC_ZOOM_TILE_SIDE, doomedZoomSourceHalo, withAnalyticZoomPreview, zoomPreviewAdmission } from './zoom-focus-preview.ts'

const zoomBlur = { visible: true, kind: 'zoom-blur', radius: 0, zoomBlur: { amount: 10 } }
const imageGaussian = { visible: true, kind: 'gaussian-blur', radius: 9.564871788024902 }
const zoom = 150.6 * 2

function request(patch = {}) {
  return {
    livePreview: true, renderIntent: 'preview', rasterProfile: 'analytic', backend: 'webgpu',
    zoom, width: 1600, height: 1200, analyticRegionsEnabled: true, hasTileViewport: false,
    hasCaptureViewport: false, hasGpuViewport: false, effects: [zoomBlur, imageGaussian], ...patch,
  }
}

test('15060% DPR 2 whole-scene Zoom Blur preview compiles as one analytic capture', () => {
  assert.equal(doomedZoomSourceHalo(zoom, [zoomBlur, imageGaussian]), true)
  assert.ok(3 * imageGaussian.radius * zoom + 2 > 2048)
  assert.deepEqual(zoomPreviewAdmission(request()), { kind: 'capture' })
  assert.deepEqual(withAnalyticZoomPreview({
    livePreview: true, renderIntent: 'preview', rasterProfile: 'analytic', width: 1600, height: 1200,
    view: { x: -174000, y: -120000, zoom },
  }, { backend: 'webgpu', analyticRegionsEnabled: true, effects: [zoomBlur, imageGaussian] }), {
    kind: 'capture',
    options: {
      livePreview: true, renderIntent: 'preview', rasterProfile: 'analytic', width: 1600, height: 1200,
      view: { x: -174000, y: -120000, zoom },
      gpuAnalyticRegions: true, captureViewport: { x: 0, y: 0, w: 1600, h: 1200 },
    },
  })
  assert.deepEqual(zoomPreviewAdmission(request({ hasCaptureViewport: true })), { kind: 'capture' })
  const kept = withAnalyticZoomPreview({
    livePreview: true, renderIntent: 'preview', rasterProfile: 'analytic', width: 900, height: 700,
    view: { zoom }, captureViewport: { x: 10, y: 20, w: 900, h: 700 },
  }, { backend: 'webgpu', analyticRegionsEnabled: true, effects: [zoomBlur, imageGaussian] })
  assert.equal(kept.kind, 'capture')
  assert.deepEqual(kept.options.captureViewport, { x: 10, y: 20, w: 900, h: 700 })
  assert.equal(kept.options.gpuAnalyticRegions, true)
  assert.equal(ANALYTIC_ZOOM_TILE_SIDE, 512)
})

test('an output past the capture limit uses analytic tiles instead of the doomed whole scene', () => {
  assert.deepEqual(zoomPreviewAdmission(request({ width: 8192, height: 2000 })), { kind: 'tiles' })
})

test('previews that are not the doomed analytic range stay unchanged', () => {
  for (const patch of [
    { renderIntent: 'canvas' }, { hasTileViewport: true }, { rasterProfile: 'figma' }, { backend: 'cpu' },
    { analyticRegionsEnabled: false }, { effects: [imageGaussian] },
    { effects: [zoomBlur, { ...imageGaussian, visible: false }] }, { zoom: 32 }, { sequentialViewport: true },
  ]) assert.deepEqual(zoomPreviewAdmission(request(patch)), { kind: 'unchanged' })
})
