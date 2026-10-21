import { expect, test } from 'vitest'
import { captureViewportPreview, reusableViewportPreview, viewportPreviewDeviceKey, viewportPreviewKey,
  type ViewportPreviewIdentity } from './viewport-preview-cache'

const identity = (): ViewportPreviewIdentity => ({ lane: 'navigation-preview', client: {}, document: {}, revision: 3,
  pageId: 'p', sessionEpoch: 7, dpr: 2, backend: 'webgpu', profile: 'figma', precision: 'full-four-sample-sdr',
  capability: undefined, width: 856, height: 889, view: { x: -12.125, y: 7.375, zoom: 2 } })
function fixture() {
  const request = identity(), key = viewportPreviewKey(request), device = '1/2/3'
  const tile = { key, viewportPreview: true, gpuTile: 101, viewportCache: { ...captureViewportPreview(request), device } }
  return { request, tile, device }
}
test('an acknowledged exact capture reuses its live texture without a time-to-live', () => {
  const f = fixture()
  expect(reusableViewportPreview(f.tile, f.request, true, f.device)).toBe(true)
  expect(reusableViewportPreview(f.tile, { ...f.request, view: { ...f.request.view } }, true, f.device)).toBe(true)
  expect(f.tile.gpuTile).toBe(101)
})
test.each(['client', 'document', 'revision', 'pageId', 'sessionEpoch', 'dpr', 'backend', 'profile', 'precision', 'capability', 'width', 'height', 'lane'] as const)(
  '%s changes cannot reuse a captured viewport', field => {
    const f = fixture(), changed = { ...f.request }
    if (field === 'client' || field === 'document' || field === 'capability') Object.assign(changed, { [field]: {} })
    else if (field === 'lane') changed.lane = 'sequential-viewport'
    else Object.assign(changed, { [field]: typeof changed[field] === 'number' ? Number(changed[field]) + 1 : `${changed[field]}-other` })
    expect(reusableViewportPreview(f.tile, changed, true, f.device)).toBe(false)
  })
test.each(['x', 'y', 'zoom'] as const)('binary64 camera %s remains exact, including a one-ULP change', axis => {
  const f = fixture(), words = new BigUint64Array(1), floats = new Float64Array(words.buffer)
  floats[0] = f.request.view[axis]; words[0]++
  const changed = { ...f.request, view: { ...f.request.view, [axis]: floats[0] } }
  expect(viewportPreviewKey(changed)).not.toBe(f.tile.key)
  expect(reusableViewportPreview(f.tile, changed, true, f.device)).toBe(false)
})
test('unacknowledged, gone, invalid or other-device handles never count as reuse', () => {
  const f = fixture()
  expect(reusableViewportPreview(f.tile, f.request, false, f.device)).toBe(false)
  expect(reusableViewportPreview(f.tile, f.request, true, undefined)).toBe(false)
  expect(reusableViewportPreview(f.tile, f.request, true, '1/2/4')).toBe(false)
  expect(reusableViewportPreview({ ...f.tile, gpuTile: undefined }, f.request, true, f.device)).toBe(false)
  expect(reusableViewportPreview({ ...f.tile, viewportCache: captureViewportPreview(f.request) }, f.request, true, f.device)).toBe(false)
})
test('capture snapshots input placement and never inherits the last device as a certificate', () => {
  const request = identity(), captured = captureViewportPreview(request)
  expect(captured.device).toBeUndefined(); expect(captured.identity.view).not.toBe(request.view)
  expect(Object.isFrozen(captured.identity.view)).toBe(true)
  expect(viewportPreviewDeviceKey({ client: request.client, deviceWorkerScope: 1, deviceIncarnation: 2, deviceOwner: 3 })).toBe('1/2/3')
  expect(viewportPreviewDeviceKey({ client: request.client, deviceWorkerScope: 1, deviceIncarnation: 2, deviceOwner: 0 })).toBeUndefined()
})
