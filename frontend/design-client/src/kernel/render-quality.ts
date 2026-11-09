/** Sampling reduction is limited to explicit low-zoom navigation previews. */
export const LOW_ZOOM_SAMPLING_LIMIT = 0.25
export type RenderQualityPurpose = 'preview' | 'settle' | 'export'
export type RenderQualityRequest = {
  renderIntent?: string; png?: boolean; exportFormat?: unknown; exportRegion?: unknown
  zoom?: number; desktopFullMath?: boolean
}

/** Purpose is independent of transport: readback does not turn a transient
 * preview into an export. Actual raster/effect/color flags still namespace
 * caches; same-quality preview bytes may be reused but are not final output.
 * This contract never changes the kernel's effect coefficients or AA math. */
export function renderQualityContract(request: RenderQualityRequest) {
  const purpose: RenderQualityPurpose = request.png || request.exportFormat || request.exportRegion
    ? 'export' : request.renderIntent === 'preview' ? 'preview' : 'settle'
  const zoom = request.zoom
  return {
    purpose,
    reducedSamplingAllowed: purpose === 'preview' && typeof zoom === 'number' &&
      Number.isFinite(zoom) && zoom > 0 && zoom <= LOW_ZOOM_SAMPLING_LIMIT,
    existingInteractiveEffectsPolicy: purpose === 'preview' && !request.desktopFullMath,
  }
}
export function allowsReducedSampling(zoom: number) {
  return renderQualityContract({ renderIntent: 'preview', zoom }).reducedSamplingAllowed
}
