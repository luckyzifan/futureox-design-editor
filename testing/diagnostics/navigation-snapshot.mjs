/** Call via page.evaluate(navigationSnapshot) in an already-authorized test.
 * A bounded DOM snapshot only: no pixel readback, no rendering, no user content.
 * Capture deployed build revision and launch flags separately in the test report.
 */
export function navigationSnapshot() {
  const surface = document.querySelector('.kernel-tiles')
  const compositor = document.querySelector('[data-compositor="webgpu-resident"]')
  const fields = (element, keys) => Object.fromEntries(keys.map(key => [key, element?.dataset[key] ?? null]))
  return {
    at: performance.now(), visibility: document.visibilityState, dpr: devicePixelRatio,
    webgpuApi: !!navigator.gpu, offscreenTransfer: typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function',
    surface: fields(surface, ['residentEligible', 'residentReason', 'navigationZoomActive', 'navigationZoomSequence',
      'navigationPendingAgeMs', 'previewActive', 'framePublication', 'revision', 'requestedCameraX', 'requestedCameraY',
      'requestedCameraZoom', 'progressiveTiles', 'viewportPreviewTiles']),
    compositor: fields(compositor, ['residentAttached', 'residentAttachmentReason', 'compositorFrames',
      'compositorCaptures', 'compositorUploads', 'presentedCamera', 'contentSequence']),
    semantics: { compositorFrames: 'GPU queue submissions, not scanout', contentSequence: 'object interaction input only; not camera refresh',
      viewportPreviewTiles: 'resident preview count, not update rate', presentedCamera: 'DEV-only submitted camera acknowledgement' },
  }
}
