import type { Bounds } from './model'

export { largeRotatedSourceDirect } from './kernel/gpu/source-bitmap-grid'

type FollowCamera = { x: number; y: number; zoom: number }

/** Visible part of a rotated bitmap. The capture margin stays inside the
 * viewport, including when the bitmap is larger than the screen. */
export function visibleRotationCrop(box: Bounds, view: FollowCamera, width: number, height: number): Bounds | null {
  if (view.zoom <= 0 || width <= 0 || height <= 0) return null
  const inset = 4 / view.zoom
  const left = -view.x / view.zoom + inset
  const top = -view.y / view.zoom + inset
  const right = (width - view.x) / view.zoom - inset
  const bottom = (height - view.y) / view.zoom - inset
  const x = Math.max(box.x, left)
  const y = Math.max(box.y, top)
  const farX = Math.min(box.x + box.width, right)
  const farY = Math.min(box.y + box.height, bottom)
  if (!(farX - x >= 1) || !(farY - y >= 1)) return null
  return { x, y, width: farX - x, height: farY - y }
}

/** How a rotation drag shows the large bitmap before the next exact frame.
 * `snapshot` moves pixels that are already on screen. Releasing the pointer
 * is not this step. */
export function rotationBitmapFollowPlan(input: {
  bakedOutline: boolean
  ownPaint: 'solid' | 'image' | null
  visibleBox: Bounds | null
  /** Screen area of the selection. Large images follow from pixels already
   * shown; a small image can wait for its own decoded paint. */
  largeBitmap: boolean
}): { mode: 'own-paint' | 'snapshot' | 'gpu'; drawSelection: boolean } {
  if (input.bakedOutline) {
    return input.visibleBox
      ? { mode: 'snapshot', drawSelection: false }
      : { mode: 'gpu', drawSelection: false }
  }
  if (input.ownPaint === 'solid' || (input.ownPaint === 'image' && !input.largeBitmap)) {
    return { mode: 'own-paint', drawSelection: true }
  }
  if (input.visibleBox) return { mode: 'snapshot', drawSelection: true }
  if (input.ownPaint === 'image') return { mode: 'own-paint', drawSelection: true }
  return { mode: 'gpu', drawSelection: false }
}
