import type { CanvasCamera } from '../canvas-camera'

/** Navigation-only timing: object edits and fixed-scale panning never enter
 * this tier. A wheel/pinch burst keeps one latest target rather than refining
 * every intermediate scale. These are host policy values, not kernel limits. */
export const NAVIGATION_ZOOM_SAMPLE_MS = 160
export const NAVIGATION_ZOOM_QUIET_MS = 160
export type NavigationZoomSample = { active: boolean; view: CanvasCamera; sequence: number }
export class NavigationZoom {
  private target: CanvasCamera
  private changedAt = -Infinity
  private sampledAt = -Infinity
  private stableFrames = 0
  sample: NavigationZoomSample
  constructor(view: CanvasCamera) {
    this.target = { ...view }
    this.sample = { active: false, view: { ...view }, sequence: 0 }
  }
  get active() { return this.sample.active }
  get zoom() { return this.target.zoom }
  update(view: CanvasCamera, now: number): NavigationZoomSample {
    const changed = view.zoom !== this.target.zoom
    this.target = { ...view }
    if (changed) {
      this.changedAt = now; this.stableFrames = 0
      if (!this.active) return this.publish(true, now)
    }
    if (this.active && this.hasUnsampledView() && now - this.sampledAt >= NAVIGATION_ZOOM_SAMPLE_MS) return this.publish(true, now)
    return this.sample
  }
  frame(now: number): NavigationZoomSample {
    if (!this.active) return this.sample
    if (now - this.changedAt >= NAVIGATION_ZOOM_QUIET_MS) {
      if (++this.stableFrames >= 2) return this.publish(false, now)
    } else this.stableFrames = 0
    if (now - this.sampledAt >= NAVIGATION_ZOOM_SAMPLE_MS && this.hasUnsampledView())
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

/** Fixed output-density cap for temporary zoom previews. Final tiles use the
 * exact zoom*DPR lattice; this never changes document/export sampling rules. */
export function navigationPreviewDensity(dpr: number, width: number, height: number) {
  return Math.min(dpr, 1, Math.sqrt(1_048_576 / Math.max(1, width * height)), 2048 / Math.max(1, width, height))
}
