import type { CanvasCamera, CanvasSize } from '../canvas-camera'
import { frameCovers, frameTransform } from './presentation'
import { previewCameraScaleWithinLimit, previewPlacementIntersects } from './tile-preview'

export type ShownReferenceFrame = { view: CanvasCamera; width: number; height: number }

/** CSS pixels of `frame` that land inside the requested viewport after the
 * same reprojection the reference surface uses. */
export function referenceFrameCoveragePx(
  requested: CanvasCamera,
  frame: CanvasCamera,
  frameWidth: number,
  frameHeight: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  if (!(requested.zoom > 0) || !(frame.zoom > 0) || frameWidth <= 0 || frameHeight <= 0 ||
      viewportWidth <= 0 || viewportHeight <= 0) return 0
  const placed = frameTransform(requested, frame)
  if (!Number.isFinite(placed.scale) || placed.scale <= 0) return 0
  const left = Math.max(0, placed.x)
  const top = Math.max(0, placed.y)
  const right = Math.min(viewportWidth, placed.x + frameWidth * placed.scale)
  const bottom = Math.min(viewportHeight, placed.y + frameHeight * placed.scale)
  return Math.max(0, right - left) * Math.max(0, bottom - top)
}

/** A CPU frame that finished after the wheel moved can still fill the board.
 * Zooming out leaves pasteboard around a tighter crop. Keep the finished
 * frame when it covers the request, or when it covers more of that request
 * than the picture already on screen. A tighter zoom-in must not replace a
 * wider frame. */
export function retainMovedReferenceFrame(input: {
  finished: CanvasCamera
  requested: CanvasCamera
  displayed: ShownReferenceFrame | null
  frameWidth: number
  frameHeight: number
  viewportWidth: number
  viewportHeight: number
}): boolean {
  const { finished, requested, displayed, frameWidth, frameHeight, viewportWidth, viewportHeight } = input
  if (frameCovers(requested, finished, { width: frameWidth, height: frameHeight },
    { width: viewportWidth, height: viewportHeight })) return true
  const next = referenceFrameCoveragePx(requested, finished, frameWidth, frameHeight, viewportWidth, viewportHeight)
  if (!displayed) return next > 0
  const current = referenceFrameCoveragePx(requested, displayed.view, displayed.width, displayed.height, viewportWidth, viewportHeight)
  return next > current + 1
}

/** A render that still matches the lagging render view must not replace a
 * wider picture once the live camera has zoomed out. Rotation makes that
 * render slow enough to finish after the zoom, which flashed a tight crop
 * on the pasteboard. */
export function acceptFinishedReferenceFrame(input: {
  live: CanvasCamera
  finished: CanvasCamera
  displayed: ShownReferenceFrame | null
  frameWidth: number
  frameHeight: number
  viewportWidth: number
  viewportHeight: number
  renderViewCurrent: boolean
}): boolean {
  const zoomingOut = input.finished.zoom > 0 && input.live.zoom < input.finished.zoom * (1 - 1e-6)
  if (!zoomingOut && input.renderViewCurrent) return true
  return retainMovedReferenceFrame({
    finished: input.finished,
    requested: input.live,
    displayed: input.displayed,
    frameWidth: input.frameWidth,
    frameHeight: input.frameHeight,
    viewportWidth: input.viewportWidth,
    viewportHeight: input.viewportHeight,
  })
}

/** CPU pixels are CSS-fit to the live camera. Overlay chrome uses that same
 * camera. A presented frame from before the zoom, including one committed
 * by a rotation, must not keep the blue box at the old scale. */
export function referenceOverlayCamera(input: {
  cpu: boolean
  live: CanvasCamera
  presented: CanvasCamera | null
  scopeMatches: boolean
  editPreview: boolean
  /** A bitmap held past the preview ratio is CSS-reprojected into the live
   * camera, so the blue box uses that same live camera and stays on the
   * picture. A 2400% pasteboard frame must not keep drawing its grid after
   * Center Selection has moved onto the group. */
  viewport?: CanvasSize
}): CanvasCamera {
  if (input.cpu || input.editPreview || !input.scopeMatches || !input.presented) return input.live
  if (input.viewport && input.viewport.width > 0 && input.viewport.height > 0) {
    if (!previewCameraScaleWithinLimit(input.presented.zoom, input.live.zoom)) return input.live
    const placed = frameTransform(input.live, input.presented)
    if (!previewPlacementIntersects(placed, input.viewport.width, input.viewport.height, input.viewport.width, input.viewport.height))
      return input.live
  }
  return input.presented
}
