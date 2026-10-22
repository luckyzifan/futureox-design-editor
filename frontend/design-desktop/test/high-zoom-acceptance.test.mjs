import test from 'node:test'
import assert from 'node:assert/strict'
import { assertNativeZoomFrame, zoomReplayTargets } from '../scripts/lib/high-zoom-contract.mjs'
const ready = () => ({ dpr: 2, status: ['Ready'], tiles: [{ detailReady: 'true', previewActive: 'false', renderer: 'webgpu', samplingScale: '4', requestedCameraZoom: '2', revision: '7', requestedRevision: '7' }], presentation: [{ presentationReady: 'true', presentationBackend: 'gpu', previewActive: 'false', displayedDocument: 'owned-doc', requestedDocument: 'owned-doc', displayedEpoch: '3', requestedEpoch: '3', cameraX: '0', requestedCameraX: '0', cameraY: '-3', requestedCameraY: '-3', cameraZoom: '2', requestedCameraZoom: '2', pixelRatio: '2' }], compositor: [{ missingTextureCount: '0' }] })
test('matching ready native-density frame is accepted, but is not a pixel oracle', () => {
  const current = ready(); assert.equal(assertNativeZoomFrame(current, { zoom: 2, afterRevision: 6 }), current)
})
for (const [name, change] of [
  ['absent presentation', s => { s.presentation = [] }],
  ['presentation wait timeout', s => { s.presentation[0].presentationReady = 'false' }],
  ['CPU fallback presenter', s => { s.presentation[0].presentationBackend = 'cpu' }],
  ['old document presenter', s => { s.presentation[0].displayedDocument = 'previous-doc' }],
  ['old epoch presenter', s => { s.presentation[0].displayedEpoch = '2' }],
  ['preview presenter', s => { s.presentation[0].previewActive = 'true' }],
  ['old camera presenter', s => { s.presentation[0].cameraZoom = '32' }],
  ['wrong display density', s => { s.presentation[0].pixelRatio = '1' }],
  ['absent compositor', s => { s.compositor = [] }],
  ['missing compositor diagnostic', s => { delete s.compositor[0].missingTextureCount }],
  ['nonfinite missing-texture count', s => { s.compositor[0].missingTextureCount = 'NaN' }],
  ['one missing texture', s => { s.compositor[0].missingTextureCount = '1' }],
  ['second broken compositor', s => { s.compositor.push({ missingTextureCount: '1' }) }],
  ['absent tile frame', s => { s.tiles = [] }],
  ['unfinished detail', s => { s.tiles[0].detailReady = 'false' }],
  ['preview tiles', s => { s.tiles[0].previewActive = 'true' }],
  ['CPU tile renderer', s => { s.tiles[0].renderer = 'cpu' }],
  ['insufficient sampling density', s => { s.tiles[0].samplingScale = '2' }],
  ['stale edit revision', s => { s.tiles[0].revision = '6' }],
  ['missing revision diagnostics', s => { delete s.tiles[0].revision }],
  ['invalid display density', s => { s.dpr = NaN }],
  ['renderer failure', s => { s.status = ['Error: unavailable texture'] }],
]) test(`rejects ${name} instead of allowing a false green`, () => {
  const current = ready(); change(current); assert.throws(() => assertNativeZoomFrame(current, { zoom: 2 }))
})
test('unchanged pre-edit revision cannot satisfy zoom-then-edit acceptance', () => {
  assert.throws(() => assertNativeZoomFrame(ready(), { zoom: 2, afterRevision: 7 }))
})
test('a ready frame at another requested zoom is rejected', () => {
  assert.throws(() => assertNativeZoomFrame(ready(), { zoom: 3 }))
})
test('optional replay returns to 32 before every target from 1 through 5', () => {
  assert.deepEqual(zoomReplayTargets(false), [8, 32])
  assert.deepEqual(zoomReplayTargets(true), [8, 32, 1, 32, 2, 32, 3, 32, 4, 32, 5])
})
