import type { CanvasCamera, CanvasSize } from './canvas-camera'
import type { Point } from './model'

/** A retained bitmap belongs to one physical-pixel grid. Resizing the viewport,
 * changing displays, or moving the camera invalidates that capture. */
export function retainedCaptureMatches(
  capture: { view: CanvasCamera; size: CanvasSize; pixels: { pixelRatio: number; devicePixelRatio: number } },
  view: CanvasCamera, size: CanvasSize, devicePixelRatio: number,
) {
  return capture.view.x === view.x && capture.view.y === view.y && capture.view.zoom === view.zoom &&
    capture.size.width === size.width && capture.size.height === size.height &&
    capture.pixels.pixelRatio === devicePixelRatio && capture.pixels.devicePixelRatio === devicePixelRatio
}

/** Translating sampled edges by part of a device pixel interpolates them a
 * second time. Keep authored coordinates intact and rerasterize that move. */
export function retainedPixelOffset(offset: Point | null, zoom: number, pixelRatio: number): Point | null {
  if (!offset || !Number.isFinite(zoom) || zoom <= 0 || !Number.isFinite(pixelRatio) || pixelRatio <= 0) return null
  const aligned = (value: number) => Number.isFinite(value) && Number.isSafeInteger(Math.round(value)) &&
    Math.abs(value - Math.round(value)) <= 1e-7
  return aligned(offset.x * zoom * pixelRatio) && aligned(offset.y * zoom * pixelRatio) ? offset : null
}
