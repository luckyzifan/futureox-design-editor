/** Shared preview / partial-sharp / screen-ready verdict for the ordinary
 * editor surface and the full-source surface. A regional sharp patch is not
 * a screen-ready frame, and a camera, revision, density or phase mismatch
 * cannot promote a preview. */

export type FrameHandoff = 'reject' | 'preview' | 'partial-sharp' | 'screen-ready'

export function acceptNativeSample(input: {
  sameRevision: boolean
  nativeDensity: boolean
  nativePhase: boolean
}) {
  return input.sameRevision && input.nativeDensity && input.nativePhase
}

export function frameHandoff(input: {
  sameRevision: boolean
  sameCamera: boolean
  nativeDensity: boolean
  nativePhase: boolean
  viewportCovered: boolean
  regional: boolean
}): FrameHandoff {
  if (!input.sameRevision) return 'reject'
  if (!input.sameCamera || !acceptNativeSample({
    sameRevision: true,
    nativeDensity: input.nativeDensity,
    nativePhase: input.nativePhase,
  })) return 'preview'
  if (input.viewportCovered && !input.regional) return 'screen-ready'
  if (input.regional) return 'partial-sharp'
  return 'preview'
}
