import { expect, test } from 'vitest'
import { usesPainterCaptureReads, usesPainterSupport } from './painter-support-policy'
const preview = { backend: 'webgpu', renderIntent: 'preview', livePreview: true }
test('only strict host opt-in can admit an ordinary GPU preview', () => {
  for (const flag of [undefined, null, false, true, 0, 1, '', '0', 'true']) expect(usesPainterSupport(flag, preview)).toBe(false)
  expect(usesPainterSupport('1', preview)).toBe(true)
  expect(usesPainterSupport('1', { backend: 'webgpu', renderIntent: 'canvas', tileViewport: [0, 0, 1, 1] })).toBe(true)
})
test('export, exact pixel modes and other backends keep their existing allocation path', () => {
  for (const change of [{ backend: 'webgl2' }, { backend: 'cpu' }, { renderIntent: 'settled' },
    { livePreview: false }, { png: true }, { exportFormat: 'png' }, { exportRegion: {} },
    { pixelPreview: 1 }, { rasterProfile: 'figmaSoftware' }, { interaction: true }, { grid: true }, { checkerboard: true }])
    expect(usesPainterSupport('1', { ...preview, ...change })).toBe(false)
})

test('capture reads requires its own strict opt-in and an admitted painter request', () => {
  expect(usesPainterCaptureReads('1', true)).toBe(true)
  for (const flag of [undefined, null, false, true, 0, 1, '', '0', 'true'])
    expect(usesPainterCaptureReads(flag, true)).toBe(false)
  for (const support of [undefined, null, false, 0, 1, '1', 'true'])
    expect(usesPainterCaptureReads('1', support)).toBe(false)
  for (const request of [{ ...preview, png: true }, { ...preview, exportFormat: 'png' },
    { ...preview, pixelPreview: 1 }, { ...preview, backend: 'cpu' }])
    expect(usesPainterCaptureReads('1', usesPainterSupport('1', request))).toBe(false)
})
