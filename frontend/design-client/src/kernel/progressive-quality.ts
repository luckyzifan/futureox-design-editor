/** Current screen-density pixels finish the native handoff, even if history
 * was sampled more densely for a previous zoom. Sub-native arrivals must still
 * leave sharper residents visible. Otherwise historical fragments keep every
 * oversampled tile in use and can prevent native completion/admission forever. */
export function progressiveTileLayer(flags: {
  fine: boolean; cached: boolean; coarse: boolean; sameContent: boolean;
  refining: boolean; cameraDependent: boolean; nativeDensity?: boolean;nativePhase?:boolean;
  /** Same-content sample selected to improve the retained picture's density. */
  sharperThanPreview?: boolean
}) {
  let layer: number
  if(!flags.cameraDependent&&flags.sameContent&&flags.nativeDensity&&flags.nativePhase)layer = flags.fine?5:4
  else if (flags.fine && flags.nativeDensity) layer = 3
  else if (flags.refining && !flags.cameraDependent && flags.sameContent) layer = 2
  else layer = flags.fine ? 3 : flags.cached ? 2 : flags.coarse ? 1 : 0
  // Camera-dependent refinement leaves this sample at 0, under the stretched
  // preview. Share the preview band so zoom order can paint it, without
  // rising above current native phase.
  if (flags.sharperThanPreview && layer < 2) return 2
  return layer
}
