/** Motion-time affine content preview policy (default off). While a rotate or
 * scale gesture streams poses, the cached native pose texture is reprojected on
 * the GPU instead of re-rasterized per sample. The preview is transient: the
 * quiet window and every terminal/release pose still render exact, and a resize
 * pose (non-affine gesture) never enters this path. */
export type MotionAffineSessionFlags = {
  native?: boolean
  affine?: boolean
  fixedWindow?: boolean
  stopped: boolean
  bitmapPreviewOnly?: boolean
  nativePosePending?: boolean
}
export type MotionAffineSceneFlags = {
  interactionLocalFootprint?: unknown
  interactionFixedMask?: unknown
  displayFilters?: unknown
  displayMaterialSource?: unknown
  displayImageSource?: unknown
  linearRetainedCapture?: unknown
  resolve?: unknown
  presentation?: unknown
  softwareRaster?: unknown
}
export type MotionAffineAdmission = {
  enabled: boolean
  terminal?: boolean
  forceExact?: boolean
  coversDisplay: boolean
  transforms: Readonly<Record<string, unknown>>
  session: MotionAffineSessionFlags
  scene: MotionAffineSceneFlags
}
/** Conservative admission: a single-selection, full-viewport native affine
 * capture whose cached pixels can be reprojected without structural surprises.
 * Anything else keeps the existing fresh-native-render-per-pose path. */
export function motionAffineEligible(input: MotionAffineAdmission): boolean {
  const session = input.session, scene = input.scene
  return input.enabled && !input.terminal && !input.forceExact && input.coversDisplay &&
    session.native === true && session.affine === true && session.fixedWindow === true &&
    !session.stopped && !session.bitmapPreviewOnly && !session.nativePosePending &&
    Object.keys(input.transforms).length === 1 &&
    !scene.interactionLocalFootprint && !scene.interactionFixedMask &&
    !scene.displayFilters && !scene.displayMaterialSource && !scene.displayImageSource &&
    !scene.linearRetainedCapture && !scene.resolve && !scene.presentation && !scene.softwareRaster
}
/** One armed quiet timer per worker. Re-arming replaces the previous timer, and
 * cancelling retires it, so a stale callback can never request an exact pose for
 * another session. The callback decides whether to schedule a frame. */
export class MotionAffineQuietWindow<S extends { slot: number }, P> {
  private armed?: { session: S; pose: P; timer: ReturnType<typeof setTimeout> }
  constructor(private readonly delayMs: number, private readonly onQuiet: (session: S, pose: P) => void) {}
  get session() { return this.armed?.session }
  arm(session: S, pose: P) {
    this.cancel()
    const timer = setTimeout(() => {
      if (this.armed?.session !== session) return
      this.armed = undefined
      this.onQuiet(session, pose)
    }, this.delayMs)
    this.armed = { session, pose, timer }
  }
  cancel(session?: S) {
    if (!this.armed || session && this.armed.session !== session) return
    clearTimeout(this.armed.timer)
    this.armed = undefined
  }
}