import { previewCameraScaleWithinLimit } from './tile-preview'

/** Shared preview / partial-sharp / screen-ready verdict for the ordinary
 * editor surface and the full-source surface. A regional sharp patch is not
 * a screen-ready frame, and a camera, revision, density or phase mismatch
 * cannot promote a preview. */

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
