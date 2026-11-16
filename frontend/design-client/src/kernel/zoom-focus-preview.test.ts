import { expect, test } from 'vitest'
import { ANALYTIC_ZOOM_TILE_SIDE, doomedZoomSourceHalo, withAnalyticZoomPreview, zoomPreviewAdmission, type ZoomPreviewRequest } from './zoom-focus-preview'

const zoomBlur = { visible: true, kind: 'zoom-blur', radius: 0, zoomBlur: { amount: 10 } }
const imageGaussian = { visible: true, kind: 'gaussian-blur', radius: 9.564871788024902 }
const zoom = 150.6 * 2

function request(patch: Partial<ZoomPreviewRequest> = {}): ZoomPreviewRequest {
  return {
    livePreview: true, renderIntent: 'preview' as const, rasterProfile: 'analytic', backend: 'webgpu',
    zoom, width: 1600, height: 1200, analyticRegionsEnabled: true, hasTileViewport: false,
    hasCaptureViewport: false, hasGpuViewport: false, effects: [zoomBlur, imageGaussian], ...patch,
  }
}

test('15060% DPR 2 whole-scene Zoom Blur preview compiles as one analytic capture', () => {
  expect(doomedZoomSourceHalo(zoom, [zoomBlur, imageGaussian])).toBe(true)
  expect(3 * imageGaussian.radius * zoom + 2).toBeGreaterThan(2048)
  expect(zoomPreviewAdmission(request())).toEqual({ kind: 'capture' })
  expect(withAnalyticZoomPreview({
    livePreview: true, renderIntent: 'preview', rasterProfile: 'analytic', width: 1600, height: 1200,
    view: { x: -174000, y: -120000, zoom }, pageId: 'p', transparent: false, grid: false,
  }, { backend: 'webgpu', analyticRegionsEnabled: true, effects: [zoomBlur, imageGaussian] })).toEqual({
    kind: 'capture',
    options: {
      livePreview: true, renderIntent: 'preview', rasterProfile: 'analytic', width: 1600, height: 1200,
      view: { x: -174000, y: -120000, zoom }, pageId: 'p', transparent: false, grid: false,
      gpuAnalyticRegions: true, captureViewport: { x: 0, y: 0, w: 1600, h: 1200 },
    },
  })
  expect(zoomPreviewAdmission(request({ hasCaptureViewport: true }))).toEqual({ kind: 'capture' })
  expect(ANALYTIC_ZOOM_TILE_SIDE).toBe(512)
})

test('an output past the capture limit uses analytic tiles instead of the doomed whole scene', () => {
  expect(zoomPreviewAdmission(request({ width: 8192, height: 2000 }))).toEqual({ kind: 'tiles' })
})

test('previews that are not the doomed analytic range stay unchanged', () => {
  expect(zoomPreviewAdmission(request({ renderIntent: 'canvas' }))).toEqual({ kind: 'unchanged' })
  expect(zoomPreviewAdmission(request({ hasTileViewport: true }))).toEqual({ kind: 'unchanged' })
  expect(zoomPreviewAdmission(request({ rasterProfile: 'figma' }))).toEqual({ kind: 'unchanged' })
  expect(zoomPreviewAdmission(request({ backend: 'cpu' }))).toEqual({ kind: 'unchanged' })
  expect(zoomPreviewAdmission(request({ analyticRegionsEnabled: false }))).toEqual({ kind: 'unchanged' })
  expect(zoomPreviewAdmission(request({ effects: [imageGaussian] }))).toEqual({ kind: 'unchanged' })
  expect(zoomPreviewAdmission(request({ effects: [zoomBlur, { ...imageGaussian, visible: false }] }))).toEqual({ kind: 'unchanged' })
  expect(zoomPreviewAdmission(request({ zoom: 32 }))).toEqual({ kind: 'unchanged' })
  expect(zoomPreviewAdmission(request({ sequentialViewport: true }))).toEqual({ kind: 'unchanged' })
})
