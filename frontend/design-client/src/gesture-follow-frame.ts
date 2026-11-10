import type { Bounds, DesignDocument, DesignNode } from './model'

export type FollowCamera = { x: number; y: number; zoom: number }

/** Keep the snapshot inside the viewport. The capture rejects any crop that
 * crosses the canvas edge, which would otherwise disable follow for objects
 * near that edge. */
export function visibleFollowBox(box: Bounds, view: FollowCamera, width: number, height: number): Bounds | null {
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

/** Fill the punched-out snapshot hole. A solid parent frame is closer to what
 * was behind the object than the page color; otherwise use the page. */
export function gestureHoleColor(document: DesignDocument, pageId: string, parent: DesignNode | undefined): string {
  const page = document.pages.find(item => item.id === pageId)?.background || '#ffffff'
  const fill = parent?.fills.find(paint => paint.visible && paint.kind === 'solid' && paint.opacity > 0 &&
    /^#[\da-fA-F]{6}(?:[\da-fA-F]{2})?$/.test(paint.color))
  return fill?.color.slice(0, 7) || page
}
