import type { CanvasCamera } from '../../canvas-camera'
import type { RenderPolicy } from '../render-policy'
import { displayTileBudget } from '../tile-cache'

/** Admission for screen-density navigation only. Callers retain their own
 * launch gate and exact/export routing; this grants no effect simplification. */
export function usesSharpZoom(policy: RenderPolicy, request: {
  resident: boolean; pixelPreview?: number; grid?: boolean; checkerboard?: boolean
}): boolean {
  return policy.desktopDisplay && request.resident && !policy.cpuOnly && !policy.hdrCompositing &&
    !request.pixelPreview && !request.grid && !request.checkerboard
}

/** Schedule at least the requested screen density, with at most one eighth
 * octave of optional headroom (<19% extra sampled area). This is a density
 * request, not proof that the GPU has completed sharp pixels for every input.
 * Display residency admission cannot prove that a filtered graph fits its
 * separate working budget; callers must preserve that allocation/fallback gate.
 */
export function sharpZoomScale(view: CanvasCamera, dpr: number, width: number, height: number,
  { headroom = true, hdr = false, maxScale = 128 }: {
    headroom?: boolean; hdr?: boolean; maxScale?: number
  } = {}): number {
  const requested = view.zoom * dpr
  if (![view.zoom, dpr, width, height, maxScale, requested].every(Number.isFinite) ||
      view.zoom <= 0 || dpr <= 0 || requested <= 0 || width < 0 || height < 0 || maxScale <= 0)
    throw new Error('Invalid sharp zoom density')
  if (!headroom || requested >= maxScale) return requested
  let bucket = Math.ceil(Math.log2(requested) * 8)
  let scale = 2 ** (bucket / 8)
  // log2 may round a value immediately beside a bucket onto its boundary.
  // Compare the actual doubles so a next-up request never selects less detail,
  // and an exact bucket is not unnecessarily promoted by logarithm rounding.
  if (scale < requested) scale = 2 ** (++bucket / 8)
  else {
    const previous = 2 ** ((bucket - 1) / 8)
    if (previous >= requested) scale = previous
  }
  if (!Number.isFinite(scale) || scale > maxScale || scale / requested > 2 ** (1 / 8) + Number.EPSILON * 2)
    return requested
  try {
    displayTileBudget(width, height, scale / view.zoom, hdr)
    return scale
  } catch {
    // Reject speculative headroom, not the caller's DPR. The ordinary native
    // render path remains responsible for any unsupported original viewport.
    return requested
  }
}
