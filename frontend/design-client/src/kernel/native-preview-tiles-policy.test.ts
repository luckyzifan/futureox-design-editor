import { expect, test } from 'vitest'
import { usesNativePreviewTiles } from './native-preview-tiles-policy'
import { createRenderPolicy } from './render-policy'

const flags = { tiles: '1', navigation: '1', exactClamp: '1' }
const policy = createRenderPolicy(false, false, false, false, true, true)
const request = { backend: 'webgpu', renderIntent: 'preview', livePreview: true, previewTileFallback: true,
  rasterProfile: 'figmaSubpixel', width: 1710, height: 1776 }

test('trusted native display can skip a large physical whole probe without inspecting camera or document values', () => {
  expect(usesNativePreviewTiles(flags, policy, request)).toBe(true)
  expect(usesNativePreviewTiles(flags, policy, { ...request, width: 1024, height: 1025 })).toBe(true)
  expect(usesNativePreviewTiles(flags, policy, { ...request, width: 4100, height: 1000 })).toBe(true)
})
test.each(['tiles', 'navigation', 'exactClamp'] as const)('%s requires an independent strict launch opt-in', key => {
  for (const value of [undefined, '0', 'true', '01', 1, true])
    expect(usesNativePreviewTiles({ ...flags, [key]: value }, policy, request)).toBe(false)
})
test.each([
  { backend: 'cpu' }, { backend: 'webgl2' }, { backend: 'auto' }, { renderIntent: 'canvas' },
  { livePreview: false }, { livePreview: 'true' }, { previewTileFallback: false }, { previewTileFallback: 'true' },
  { interaction: true }, { tileViewport: [] }, { captureViewport: {} }, { readback: true }, { png: true },
  { exportFormat: 'png' }, { exportRegion: {} }, { pixelPreview: 1 }, { rasterProfile: 'figmaSoftware' },
])('keeps the existing route for excluded output or ownership boundary %j', excluded => {
  expect(usesNativePreviewTiles(flags, policy, { ...request, ...excluded })).toBe(false)
})
test.each([
  createRenderPolicy(true, false, false, false, true, true),
  createRenderPolicy(false, true, false, false, true, true),
  createRenderPolicy(false, false, false, false, false, true),
  createRenderPolicy(false, false, false, false, true, false),
])('request fields cannot replace the pinned desktop launch policy %j', denied => {
  expect(usesNativePreviewTiles(flags, denied, request)).toBe(false)
})
test.each([
  { width: 1024, height: 1024 }, { width: 1024, height: 1023 }, { width: 4101, height: 1000 },
  { width: 8193, height: 129 }, { width: 0 }, { height: -1 }, { width: 1.5 }, { width: Infinity },
  { height: NaN }, { width: '1710' }, { height: undefined },
])('small, malformed and unsupported assembly domains retain their original route %j', size => {
  expect(usesNativePreviewTiles(flags, policy, { ...request, ...size })).toBe(false)
})
