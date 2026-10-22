/** Allocation-domain experiment only. Authored/export options cannot enable
 * it, and presentation/readback transport does not change its pixel math. */
export function usesPainterSupport(flag: unknown, request: {
  backend: string; renderIntent?: string; livePreview?: boolean; tileViewport?: unknown
  png?: boolean; exportFormat?: unknown; exportRegion?: unknown; pixelPreview?: number; rasterProfile?: string
  interaction?: boolean; grid?: boolean; checkerboard?: boolean
}) {
  return flag === '1' && request.backend === 'webgpu' &&
    (request.renderIntent === 'preview' || request.renderIntent === 'canvas') &&
    (request.livePreview === true || !!request.tileViewport) &&
    !request.png && !request.exportFormat && !request.exportRegion && !request.pixelPreview &&
    !request.interaction && !request.grid && !request.checkerboard &&
    request.rasterProfile !== 'figmaSoftware'
}

/** Captured-source trimming has its own acceptance gate. It cannot grant a
 * painter contract to a request excluded by the existing host quality policy. */
export function usesPainterCaptureReads(flag: unknown, painterSupport: unknown) {
  return flag === '1' && painterSupport === true
}
