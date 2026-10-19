/** During camera-only refinement, arrival time is not image quality. A
 * newly requested lower-density tile must not cover a sharper valid resident.
 * Different documents and screen-anchored pixel modes keep their old ordering. */
export function progressiveTileLayer(flags: {
  fine: boolean; cached: boolean; coarse: boolean; sameContent: boolean;
  refining: boolean; cameraDependent: boolean;
}) {
  if (flags.refining && !flags.cameraDependent && flags.sameContent) return 2
  return flags.fine ? 3 : flags.cached ? 2 : flags.coarse ? 1 : 0
}
