/** Current screen-density pixels finish the native handoff, even if history
 * was sampled more densely for a previous zoom. Sub-native arrivals must still
 * leave sharper residents visible. Otherwise historical fragments keep every
 * oversampled tile in use and can prevent native completion/admission forever. */
export function progressiveTileLayer(flags: {
  fine: boolean; cached: boolean; coarse: boolean; sameContent: boolean;
  refining: boolean; cameraDependent: boolean; nativeDensity?: boolean;
}) {
  if (flags.fine && flags.nativeDensity) return 3
  if (flags.refining && !flags.cameraDependent && flags.sameContent) return 2
  return flags.fine ? 3 : flags.cached ? 2 : flags.coarse ? 1 : 0
}
