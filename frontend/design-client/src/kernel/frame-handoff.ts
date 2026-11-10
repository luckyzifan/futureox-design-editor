import { previewCameraScaleWithinLimit } from './tile-preview'

/** Shared preview / partial-sharp / screen-ready verdict for the ordinary
 * editor surface and the full-source surface. A regional sharp patch is not
 * a screen-ready frame, and a camera, revision, density or phase mismatch
 * cannot promote a preview. Callers that own a real revision use
 * acceptFrameClarity; this function does not invent a matching version. */

export type FrameHandoff = 'reject' | 'preview' | 'partial-sharp' | 'screen-ready'

/** The tiles actually sampled for this frame, not a stale render scale or an
 * older ready camera. A much finer resident can stay in a continuity stack,
 * but it is not the current density. */
export function densityCertifiesDemand(tiles: readonly { zoom: number }[], targetScale: number) {
  if (!(targetScale > 0) || !Number.isFinite(targetScale) || tiles.length === 0) return false
  return tiles.every(tile => tile.zoom >= targetScale * 0.999999 && previewCameraScaleWithinLimit(tile.zoom, targetScale))
}

/** A same-zoom pan may publish a continuity stack that still contains a much
 * finer zoom. That stack must not become the ready receipt when the cached
 * lattice already matches the requested sample. An in-range strip stays. */
export function settledCoverageChoice<T extends { key: string; zoom: number }>(input: {
  stored: readonly T[]
  exact: readonly T[]
  exactComplete: boolean
  targetScale: number
}): { tiles: readonly T[]; certify: boolean; continuity: boolean } {
  const far = input.stored.some(tile => !previewCameraScaleWithinLimit(tile.zoom, input.targetScale))
  if (!far) return { tiles: input.stored, certify: input.exactComplete, continuity: true }
  if (input.exactComplete && densityCertifiesDemand(input.exact, input.targetScale)) {
    const extra = input.stored.filter(tile => previewCameraScaleWithinLimit(tile.zoom, input.targetScale) &&
      !input.exact.some(item => item.key === tile.key))
    const withExtra = [...input.exact, ...extra]
    const tiles = densityCertifiesDemand(withExtra, input.targetScale) ? withExtra : input.exact
    return { tiles, certify: true, continuity: tiles.length !== input.exact.length }
  }
  return { tiles: input.stored, certify: false, continuity: true }
}

export function acceptNativeSample(input: {
  sameRevision: boolean
  nativeDensity: boolean
  nativePhase: boolean
}) {
  return input.sameRevision && input.nativeDensity && input.nativePhase
}

/** Partial sharp is the regional verdict. The caller still owns camera identity:
 * this only promotes a sample whose revision, density and phase already match. */
export function partialSharpSample(input: {
  sameRevision: boolean
  nativeDensity: boolean
  nativePhase: boolean
}) {
  return frameHandoff({
    sameRevision: input.sameRevision,
    sameCamera: true,
    nativeDensity: input.nativeDensity,
    nativePhase: input.nativePhase,
    viewportCovered: false,
    regional: true,
  }) === 'partial-sharp'
}

/** How a viewport preview may meet pixels that are already on screen.
 *  `exclusive` is a cold picture or a different revision: the preview is the
 *  only image, so two revisions are never composited.
 *  `under` keeps same-revision residents and partial sharp regions. The
 *  preview only fills holes. Publishing it alone, then restoring the old
 *  frame on the next wheel tick, is the continuous-zoom flash.
 *  `above` is the same continuity when this preview is at least twice as
 *  dense. It stays in the stack while it still intersects; it is not a
 *  one-sample replacement that the next camera withdraws.
 *  `omit` leaves the existing choice unchanged. */
export type ViewportPreviewRole = 'exclusive' | 'above' | 'under' | 'omit'

export function viewportPreviewRole(input: {
  preview: boolean
  /** Capture camera and coverage match the live view. A mismatched record
   * must not become the sole picture. */
  exact: boolean
  foreignShown: boolean
  sameRevisionDetail: number
  /** Preview samples at least twice the shown same-revision detail. */
  sharperThanShown: boolean
}): ViewportPreviewRole {
  if (!input.preview) return 'omit'
  const detail = input.sameRevisionDetail
  if (!Number.isFinite(detail) || detail < 0) return 'omit'
  if (input.foreignShown && detail === 0) return input.exact ? 'exclusive' : 'omit'
  if (detail > 0) return input.sharperThanShown ? 'above' : 'under'
  return input.exact ? 'exclusive' : 'omit'
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
