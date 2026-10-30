import assert from 'node:assert/strict'
// DOM-published renderer/ownership contract, NOT pixel or physical-frame proof.
const finite = value => value !== undefined && value !== '' && Number.isFinite(Number(value))
export function assertNativeZoomFrame(current, { zoom, afterRevision } = {}) {
  assert.ok(current && Number.isFinite(current.dpr) && current.dpr > 0, 'Valid display pixel ratio is required')
  assert.ok(Array.isArray(current.status) && current.status.every(text => !/Error|超限|超过|失败/.test(text)), 'Renderer reported an error')
  assert.ok(Array.isArray(current.presentation) && current.presentation.length > 0, 'Presentation is absent')
  const presenter = current.presentation.find(frame => frame.presentationReady === 'true' && frame.presentationBackend === 'gpu' &&
    frame.previewActive === 'false' && frame.displayedDocument && frame.displayedDocument === frame.requestedDocument &&
    finite(frame.displayedEpoch) && frame.displayedEpoch === frame.requestedEpoch &&
    ['X', 'Y', 'Zoom'].every(axis => finite(frame[`camera${axis}`]) && Number(frame[`camera${axis}`]) === Number(frame[`requestedCamera${axis}`])) &&
    Number(frame.pixelRatio) === current.dpr && (!zoom || Number(frame.requestedCameraZoom) === zoom))
  assert.ok(presenter, 'Matching ready GPU presentation did not finish')
  assert.ok(Array.isArray(current.tiles) && current.tiles.some(tile => tile.detailReady === 'true' && tile.previewActive === 'false' &&
    tile.renderer === 'webgpu' && finite(tile.samplingScale) && finite(tile.requestedCameraZoom) &&
    Number(tile.samplingScale) >= Number(tile.requestedCameraZoom) * current.dpr * .999 &&
    Number(tile.requestedCameraZoom) === Number(presenter.requestedCameraZoom) &&
    finite(tile.revision) && finite(tile.requestedRevision) && Number(tile.revision) === Number(tile.requestedRevision) &&
    (afterRevision === undefined || Number(tile.revision) > afterRevision) &&
    (!zoom || Number(tile.requestedCameraZoom) === zoom)), 'Native-density WebGPU frame did not finish at the requested revision')
  assert.ok(Array.isArray(current.compositor) && current.compositor.length > 0, 'GPU compositor is absent')
  assert.ok(current.compositor.every(canvas => finite(canvas.missingTextureCount) && Number(canvas.missingTextureCount) === 0), 'GPU compositor has missing textures or missing diagnostics')
  return current
}
export function zoomReplayTargets(enabled) {
  return enabled ? [8, 32, 1, 32, 2, 32, 3, 32, 4, 32, 5] : [8, 32]
}
