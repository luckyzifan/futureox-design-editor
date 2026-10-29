import type { Bounds, Point } from './model'

export function zoomStep(zoom: number, direction: 1 | -1): number {
  const power = Math.log2(zoom)
  const next = direction > 0 ? Math.floor(power + 1e-9) + 1 : Math.ceil(power - 1e-9) - 1
  const value = 2 ** next
  return value > 0 && Number.isFinite(value) ? value : zoom
}

// x/y and screen points are viewport-local CSS pixels, never device pixels.
// World coordinates and camera math stay as JS doubles; zoom must be positive.
export type CanvasCamera = { x: number; y: number; zoom: number }
export type CanvasSize = { width: number; height: number }

export function worldToScreen(view: CanvasCamera, point: Point): Point {
  return { x: point.x * view.zoom + view.x, y: point.y * view.zoom + view.y }
}

export function screenToWorld(view: CanvasCamera, point: Point): Point {
  return { x: (point.x - view.x) / view.zoom, y: (point.y - view.y) / view.zoom }
}

export function zoomAt(view: CanvasCamera, zoom: number, anchor: Point): CanvasCamera {
  if (!Number.isFinite(zoom) || zoom <= 0) return { ...view }
  if (zoom === view.zoom) return { ...view }
  const world = screenToWorld(view, anchor)
  const next = { zoom, x: anchor.x - world.x * zoom, y: anchor.y - world.y * zoom }
  // Numeric overflow is not a product zoom ceiling. Never publish an invalid
  // camera; the native compiler separately checks its actual device geometry.
  return Object.values(next).every(Number.isFinite) ? next : { ...view }
}

export function fitBounds(
  bounds: Bounds,
  size: CanvasSize,
  { padding = 40, maxZoom = Infinity } = {},
): CanvasCamera {
  const requested = Math.min(
    maxZoom,
    (size.width - padding * 2) / Math.max(1, bounds.width),
    (size.height - padding * 2) / Math.max(1, bounds.height),
  )
  const zoom = requested > 0 && Number.isFinite(requested) ? requested : 1
  return {
    zoom,
    x: size.width / 2 - (bounds.x + bounds.width / 2) * zoom,
    y: size.height / 2 - (bounds.y + bounds.height / 2) * zoom,
  }
}

/** Minimal camera pan bringing `bounds` fully into the viewport with a
 * CSS-pixel margin, keeping the zoom untouched — the layer-list reveal
 * behaviour: selecting from a panel scrolls, it never re-scales. Returns null
 * when the bounds are already visible, so clicks on visible layers never move
 * a pixel; selections larger than the viewport centre instead of hugging an
 * edge. */
export function revealInView(
  view: CanvasCamera,
  bounds: Bounds,
  size: CanvasSize,
  margin = 48,
): CanvasCamera | null {
  const zoom = view.zoom
  const left = -view.x / zoom,
    top = -view.y / zoom,
    width = size.width / zoom,
    height = size.height / zoom,
    pad = margin / zoom
  if (
    bounds.x >= left + pad &&
    bounds.x + bounds.width <= left + width - pad &&
    bounds.y >= top + pad &&
    bounds.y + bounds.height <= top + height - pad
  )
    return null
  let nextLeft = left,
    nextTop = top
  if (bounds.width + pad * 2 <= width) {
    if (bounds.x < left + pad) nextLeft = bounds.x - pad
    else if (bounds.x + bounds.width > left + width - pad)
      nextLeft = bounds.x + bounds.width + pad - width
  } else nextLeft = bounds.x + bounds.width / 2 - width / 2
  if (bounds.height + pad * 2 <= height) {
    if (bounds.y < top + pad) nextTop = bounds.y - pad
    else if (bounds.y + bounds.height > top + height - pad)
      nextTop = bounds.y + bounds.height + pad - height
  } else nextTop = bounds.y + bounds.height / 2 - height / 2
  // Selections larger than the viewport re-centre; when one is already
  // centred there is nothing left to improve and the camera must stay put.
  if (Math.abs(nextLeft - left) < 1e-9 && Math.abs(nextTop - top) < 1e-9) return null
  return { zoom, x: -nextLeft * zoom, y: -nextTop * zoom }
}

// DOM_DELTA_LINE has no fixed browser-independent pixel size. Use a stable
// 16-CSS-pixel line; DOM_DELTA_PAGE uses this canvas, not the browser window.
export function wheelDeltaPixels(
  event: { deltaX: number; deltaY: number; deltaMode: number; shiftKey?: boolean },
  size: CanvasSize,
): Point {
  const xScale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.width : 1
  const yScale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1
  // Chromium/macOS may already map Shift+wheel onto deltaX. Never swap it
  // back or discard a genuine two-axis trackpad gesture.
  if (event.shiftKey && event.deltaX === 0)
    return { x: event.deltaY * yScale, y: 0 }
  return { x: event.deltaX * xScale, y: event.deltaY * yScale }
}

/** Chromium pinch carries synthetic Ctrl; an actual Ctrl/Meta key press
 * identifies modified mouse scrolling instead. Wheel fields may be accessors. */
export function isNativePinch(
  event: { ctrlKey?: boolean; metaKey?: boolean; deltaMode: number; deltaX: number },
  physical: { ctrl: boolean; meta: boolean },
): boolean {
  return event.ctrlKey === true && event.metaKey !== true && !physical.ctrl && !physical.meta &&
    event.deltaMode === 0 && event.deltaX === 0
}

/** Wheel coordinates and the camera share viewport-local CSS pixels. Keep
 * the point under the pointer fixed while scaling the entire world. */
export function wheelCamera(
  view: CanvasCamera,
  event: { deltaX: number; deltaY: number; deltaMode: number; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean },
  size: CanvasSize,
  anchor: Point,
  scrollWheelZoom = false,
  pinch = false,
): CanvasCamera {
  const modified = !!(event.ctrlKey || event.metaKey)
  if (modified || (scrollWheelZoom && !event.shiftKey)) {
    // Native WheelEvent fields are prototype accessors, not enumerable own
    // properties. Spreading the event drops its deltas in a real browser.
    const delta = wheelDeltaPixels({ deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode, shiftKey: false }, size)
    // Chromium encodes native pinch as deltaY = -100 * log(scale).
    // Undo that encoding for pinch, independently of physical wheel tuning:
    // .002 applied to a 2x native gesture incorrectly produces only 1.149x.
    // components/input/touchpad_pinch_event_queue.cc, Chromium source.
    // Shared Web/Electron wheel response: 120 CSS pixels now scale by ~1.43x
    // (previously ~1.27x). Physical pinch remains faithful to its native scale.
    return zoomAt(view, view.zoom * Math.exp(-delta.y * (pinch ? .01 : .003)), anchor)
  }
  const delta = wheelDeltaPixels(event, size)
  return { ...view, x: view.x - delta.x, y: view.y - delta.y }
}
