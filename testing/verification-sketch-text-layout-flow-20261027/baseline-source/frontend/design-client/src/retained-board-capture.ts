import type { Bounds } from './model'

/** A retained bitmap uses one physical-pixel lattice for both axes. Round
 * its backing size and crop on that lattice, then derive their CSS sizes;
 * stretching rounded pixels back to layout bounds distorts a moving board. */
export function retainedCaptureGeometry(width: number, height: number, box: Bounds,
  view: { x: number; y: number; zoom: number }, devicePixelRatio: number) {
  if (![width, height, box.x, box.y, box.width, box.height, view.x, view.y, view.zoom, devicePixelRatio].every(Number.isFinite) ||
      width <= 0 || height <= 0 || box.width < 0 || box.height < 0 || view.zoom <= 0 || devicePixelRatio <= 0) return null
  // Decline an oversized snapshot instead of reducing its density during a
  // drag. The ordinary renderer remains responsible for that frame.
  const pixelRatio = devicePixelRatio
  const pixelWidth = Math.ceil(width * pixelRatio), pixelHeight = Math.ceil(height * pixelRatio)
  const left = Math.floor((box.x * view.zoom + view.x - 2) * pixelRatio)
  const top = Math.floor((box.y * view.zoom + view.y - 2) * pixelRatio)
  const right = Math.ceil(((box.x + box.width) * view.zoom + view.x + 2) * pixelRatio)
  const bottom = Math.ceil(((box.y + box.height) * view.zoom + view.y + 2) * pixelRatio)
  if (left < 0 || top < 0 || right / pixelRatio > width || bottom / pixelRatio > height ||
      pixelWidth * pixelHeight > 8_388_608) return null
  return {
    pixelRatio, devicePixelRatio, pixelWidth, pixelHeight,
    width: pixelWidth / pixelRatio, height: pixelHeight / pixelRatio,
    pixelCrop: { x: left, y: top, width: right - left, height: bottom - top },
    crop: { x: left / pixelRatio, y: top / pixelRatio,
      width: (right - left) / pixelRatio, height: (bottom - top) / pixelRatio },
  }
}

/** Snapshot only the published display canvases, in their compositor order.
 * Bounded to two viewport surfaces; no GPU readback or authored-data change. */
export function captureBoardFrame(host: HTMLElement, box: Bounds, view: { x: number; y: number; zoom: number }) {
  const presentation = host.querySelector('.kernel-presentation[data-presentation-ready="true"]')
  if (!presentation) { host.dataset.boardCapture = 'not-ready'; return null }
  const hostBox = host.getBoundingClientRect()
  const geometry = retainedCaptureGeometry(hostBox.width, hostBox.height, box, view, window.devicePixelRatio || 1)
  if (!geometry) { host.dataset.boardCapture = 'clipped-or-over-budget'; return null }
  const { pixelRatio, pixelWidth, pixelHeight, crop, pixelCrop } = geometry
  const background = document.createElement('canvas'), foreground = document.createElement('canvas')
  background.width = pixelWidth; background.height = pixelHeight
  foreground.width = pixelCrop.width; foreground.height = pixelCrop.height
  const back = background.getContext('2d'), front = foreground.getContext('2d')
  if (!back || !front) return null
  back.scale(pixelRatio, pixelRatio)
  const canvases = Array.from(presentation.querySelectorAll('canvas')).filter(canvas => {
    const style = getComputedStyle(canvas)
    return canvas.width > 0 && canvas.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && canvas.getAttribute('aria-hidden') !== 'true'
  }).sort((a, b) => (Number(getComputedStyle(a).zIndex) || 0) - (Number(getComputedStyle(b).zIndex) || 0))
  if (!canvases.length) { host.dataset.boardCapture = 'empty'; return null }
  for (const canvas of canvases) {
    const r = canvas.getBoundingClientRect()
    back.drawImage(canvas, r.x - hostBox.x, r.y - hostBox.y, r.width, r.height)
  }
  // Integer source/destination coordinates copy the crop without a second
  // resampling pass, including fractional monitor scales such as 125%.
  front.drawImage(background, pixelCrop.x, pixelCrop.y, pixelCrop.width, pixelCrop.height,
    0, 0, pixelCrop.width, pixelCrop.height)
  back.clearRect(crop.x, crop.y, crop.width, crop.height)
  host.dataset.boardCapture = 'captured'
  return { background, foreground, crop, width: geometry.width, height: geometry.height,
    pixelRatio, devicePixelRatio: geometry.devicePixelRatio }
}
