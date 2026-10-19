/** A product quality boundary, not a recovered Figma constant. Navigation
 * speed and memory pressure alone never authorize reduced normal-zoom pixels. */
export const LOW_ZOOM_SAMPLING_LIMIT = 0.25
export function allowsReducedSampling(zoom: number) {
  return Number.isFinite(zoom) && zoom > 0 && zoom <= LOW_ZOOM_SAMPLING_LIMIT
}
