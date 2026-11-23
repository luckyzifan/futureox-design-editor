import assert from 'node:assert/strict'
import test from 'node:test'
import { suppressCameraPreviewForZoom } from './pan-preview.ts'
import { physicalCoverageGaps } from './gpu/physical-coverage.ts'

test('zoom keeps the accepted picture and same-zoom pan can still preview a strip', () => {
  assert.equal(suppressCameraPreviewForZoom(1, 1), false)
  assert.equal(suppressCameraPreviewForZoom(1, 1.25), true)
  assert.equal(suppressCameraPreviewForZoom(2, 1), true)
  assert.equal(suppressCameraPreviewForZoom(32, 1), true)
  assert.equal(suppressCameraPreviewForZoom(1, 32), true)
  assert.equal(suppressCameraPreviewForZoom(undefined, 1), false)
  assert.equal(suppressCameraPreviewForZoom(0, 1), false)
  assert.equal(suppressCameraPreviewForZoom(Number.NaN, 2), false)
})

test('one ready tile during zoom leaves most of the viewport empty if the clear runs', () => {
  const width = 960
  const height = 640
  const gaps = physicalCoverageGaps([{ x: 320, y: 213, width: 320, height: 214 }], width, height)
  const pending = gaps.reduce((sum, gap) => sum + gap.width * gap.height, 0)
  const fraction = pending / (width * height)
  assert.ok(fraction > 0.8, `expected a large hole, got ${fraction}`)
})
