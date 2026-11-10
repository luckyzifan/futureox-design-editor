import type { CanvasCamera } from '../canvas-camera'
import { allowsReducedSampling } from './render-quality'
import { previewCameraScaleWithinLimit } from './tile-preview'

/** Navigation-only timing. A wheel/pinch burst keeps one latest target rather
 * than refining every intermediate camera. Expensive filtered panning may opt
 * into the same preview tier; object edits remain outside it. These are host
 * policy values, not kernel limits or estimates of the device frame rate. */
export const NAVIGATION_ZOOM_SAMPLE_MS = 160
export const NAVIGATION_ZOOM_QUIET_MS = 160
// Sparse wheel input retains the conservative quiet window. Once a dense
// burst has established its cadence, waiting another 160 ms only delays the
// exact final tiles. Three recent input intervals tolerate skipped frames;
// the floor also keeps short irregular gaps within the same gesture.
export const NAVIGATION_ZOOM_DENSE_QUIET_MS = 48
const CADENCE_INTERVALS = 8
// Require the whole window before inferring dense input; a five-event wheel
// packet is not enough evidence to speculate about the next packet gap.
const CADENCE_REQUIRED_INTERVALS = CADENCE_INTERVALS
const CADENCE_QUIET_MULTIPLIER = 3
/** Experimental only: the normal React hook deliberately uses conservative
 * settling until hardware-backed input/display measurements justify a change. */
export type NavigationZoomOptions = { adaptiveQuiet?: boolean; includeTranslation?: boolean; sampleOnFrame?: boolean }
export type NavigationZoomSample = { active: boolean; view: CanvasCamera; sequence: number }
export class NavigationZoom {
  private target: CanvasCamera
  private changedAt = -Infinity
  private sampledAt = -Infinity
  private stableFrames = 0
  private intervals: number[] = []
  private resumedBeforeQuiet = false
  private held = false
  sample: NavigationZoomSample
  constructor(view: CanvasCamera, private readonly options: NavigationZoomOptions = {}) {
    this.target = { ...view }
    this.sample = { active: false, view: { ...view }, sequence: 0 }
  }
  /** Diagnostic snapshot only; never drives scheduling or adds a timer. */
  pendingAge(now: number) {
    return this.active && this.hasUnsampledView() ? Math.max(0, now - this.sampledAt) : 0
  }
  get active() { return this.sample.active }
  get zoom() { return this.target.zoom }
  get pointerHeld() { return this.held }
  inputChanged(view: CanvasCamera) {
    return view.zoom !== this.target.zoom || !!this.options.includeTranslation &&
      (view.x !== this.target.x || view.y !== this.target.y)
  }
  update(view: CanvasCamera, now: number, pointerHeld = false): NavigationZoomSample {
    const held = !!this.options.includeTranslation && pointerHeld
    const released = this.held && !held
    const changed = this.inputChanged(view) || held && !this.held
    this.held = held
    this.target = { ...view }
    // Canvas flushes the final pointer position before releasing its gesture.
    // A known release needs no guessed quiet interval before exact refinement.
    if (released) {
      this.changedAt = now; this.stableFrames = 0
      return this.publish(false, now)
    }
    if (changed) {
      // A short resume proves that the previous adaptive settle was early.
      // Keep the original quiet window for this entire logical gesture, not
      // merely until a small rolling cadence window forgets the pause. This
      // bounds speculative exact work to one extra frame even when rendering
      // completes faster than the next burst. Only a real quiet gap resets it.
      if (now - this.changedAt >= NAVIGATION_ZOOM_QUIET_MS) this.resumedBeforeQuiet = false
      else if (!this.active) this.resumedBeforeQuiet = true
      if (!this.active) this.intervals = []
      else if (now > this.changedAt) {
        this.intervals.push(now - this.changedAt)
        if (this.intervals.length > CADENCE_INTERVALS) this.intervals.shift()
      }
      this.changedAt = now; this.stableFrames = 0
      if (!this.active) return this.publish(true, now)
    }
    if (!this.options.sampleOnFrame && this.active && this.hasUnsampledView() &&
        now - this.sampledAt >= NAVIGATION_ZOOM_SAMPLE_MS) return this.publish(true, now)
    return this.sample
  }
  frame(now: number): NavigationZoomSample {
    if (!this.active) return this.sample
    // Observe stability during the quiet interval, rather than adding another
    // frame after it. A zoom update resets this counter, including reversals.
    if (now > this.changedAt) this.stableFrames++
    const quiet = !this.options.adaptiveQuiet || this.resumedBeforeQuiet || this.intervals.length < CADENCE_REQUIRED_INTERVALS ? NAVIGATION_ZOOM_QUIET_MS :
      Math.min(NAVIGATION_ZOOM_QUIET_MS,
        Math.max(NAVIGATION_ZOOM_DENSE_QUIET_MS, ...this.intervals.map(interval => interval * CADENCE_QUIET_MULTIPLIER)))
    if (!this.held && this.stableFrames >= 2 && now - this.changedAt >= quiet) return this.publish(false, now)
    if ((this.options.sampleOnFrame || now - this.sampledAt >= NAVIGATION_ZOOM_SAMPLE_MS) && this.hasUnsampledView())
      return this.publish(true, now)
    return this.sample
  }
  private hasUnsampledView() {
    const a = this.target, b = this.sample.view
    return a.x !== b.x || a.y !== b.y || a.zoom !== b.zoom
  }
  private publish(active: boolean, now: number) {
    this.sampledAt = now
    return this.sample = { active, view: { ...this.target }, sequence: this.sample.sequence + 1 }
  }
}

/** Normal-zoom camera previews use physical DPR. Overview/continuity captures
 * without a camera keep their bounded tier. Final/export rules are unchanged. */
/** A fit bitmap more than the preview ratio behind the live camera is the
 * stretched low-resolution picture. Continuous zoom then spends the only
 * raster channel on another whole-viewport capture of that same camera and
 * the closer tiles never get a turn. Detail replaces that capture; the final
 * native density is unchanged. Below 100% the existing preview capture stays. */
export function zoomDetailInsteadOfViewportPreview(input: {
  navigating: boolean
  displayedZoom?: number
  requestedZoom: number
}) {
  const displayed = input.displayedZoom
  if (!input.navigating || !(input.requestedZoom >= 1) || displayed === undefined || !(displayed > 0)) return false
  return input.requestedZoom > displayed && !previewCameraScaleWithinLimit(displayed, input.requestedZoom)
}

export function navigationPreviewDensity(dpr: number, width: number, height: number, native = false, zoom?: number) {
  // Existing viewport/device/working-set admission still runs in the
  // client/kernel/driver; a rejected native request is never relabelled 1x.
  // Normal-zoom navigation uses the physical display lattice too. The small
  // continuity tier remains available for overviews and callers without a
  // camera, but must not turn Retina wheel input into a permanent 1x image.
  if (native || zoom !== undefined && !allowsReducedSampling(zoom)) return dpr
  return Math.min(dpr, 1, Math.sqrt(1_048_576 / Math.max(1, width * height)), 2048 / Math.max(1, width, height))
}
