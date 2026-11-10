import { frameHandoff, type FrameHandoff } from './frame-handoff'

/** One presented sample's camera. Surfaces fill this from their own source.
 * Equality is component-wise; a missing camera is not the live frame. */
export type FrameCamera = { x: number; y: number; zoom: number }

/** How much of the live viewport this sample paints.
 * `partial` and `full` are separate receipts: a sharp region is never
 * screen-ready, and a full frame is never reported as only partial. */
export type ViewportCoverage = 'uncovered' | 'partial' | 'full'

/** Why a sample is or is not the live demand.
 * `current` is the only arrival that can become partial-sharp or screen-ready.
 * Zoom, pan, and an older generation stay previews. Another revision is rejected. */
export type FrameArrival = 'current' | 'same-zoom-pan' | 'zoom' | 'stale' | 'foreign-revision'

export type ClarityReceipt = {
  arrival: FrameArrival
  verdict: FrameHandoff
  /** True only for a full-viewport sample whose camera, revision, density and phase all match. */
  screenReady: boolean
  /** True only for a regional sample of that same identity. Never implies screenReady. */
  partialSharp: boolean
}

function revisionMatches(sample: unknown, demand: unknown) {
  return sample !== undefined && demand !== undefined && Object.is(sample, demand)
}

function cameraFinite(camera: FrameCamera) {
  return [camera.x, camera.y, camera.zoom].every(value => Number.isFinite(value))
}

/** Classify a late or live sample before any clarity promotion.
 * Generation is the surface's own monotonic receipt. An older one cannot
 * replace a newer acceptance. Equal generations are one delivery, not a replay
 * of a retired frame. A non-finite generation is not treated as older. */
export function classifyFrameArrival(input: {
  sampleRevision: unknown
  demandRevision: unknown
  sampleCamera: FrameCamera | undefined
  demandCamera: FrameCamera
  generation: number
  acceptedGeneration: number
}): FrameArrival {
  if (!revisionMatches(input.sampleRevision, input.demandRevision)) return 'foreign-revision'
  if (Number.isFinite(input.generation) && Number.isFinite(input.acceptedGeneration) &&
      input.generation < input.acceptedGeneration) return 'stale'
  const sample = input.sampleCamera
  if (!sample || !cameraFinite(sample) || !cameraFinite(input.demandCamera)) return 'zoom'
  if (sample.zoom !== input.demandCamera.zoom) return 'zoom'
  if (sample.x !== input.demandCamera.x || sample.y !== input.demandCamera.y) return 'same-zoom-pan'
  return 'current'
}

/** Clarity receipt shared by ProgressiveSurface and NativeSourceSurface.
 * Density and phase stay surface-measured: the editor lattice and the source
 * tile cache do not use the same geometry. This function still refuses to
 * accept a frame unless camera, revision, those two measurements, and coverage
 * agree. A late zoom, pan, stale generation, or foreign revision cannot be
 * repaired into partial-sharp or screen-ready. Pixel replacement stays with
 * the caller. */
export function acceptFrameClarity(input: {
  sampleRevision: unknown
  demandRevision: unknown
  sampleCamera: FrameCamera | undefined
  demandCamera: FrameCamera
  nativeDensity: boolean
  nativePhase: boolean
  coverage: ViewportCoverage
  generation: number
  acceptedGeneration: number
}): ClarityReceipt {
  const arrival = classifyFrameArrival(input)
  if (arrival === 'foreign-revision')
    return { arrival, verdict: 'reject', screenReady: false, partialSharp: false }
  if (arrival !== 'current')
    return { arrival, verdict: 'preview', screenReady: false, partialSharp: false }
  const verdict = frameHandoff({
    sameRevision: true,
    sameCamera: true,
    nativeDensity: input.nativeDensity === true,
    nativePhase: input.nativePhase === true,
    viewportCovered: input.coverage === 'full',
    regional: input.coverage === 'partial',
  })
  return {
    arrival,
    verdict,
    screenReady: verdict === 'screen-ready',
    partialSharp: verdict === 'partial-sharp',
  }
}
