import { formatFigmaAngle } from './rotation-field'
import type { Bounds, DesignDocument, DesignNode, Matrix, Point } from './model'
import { apply, inverse, multiply } from './commands/affine'
import { captureBoardFrame } from './retained-board-capture'
import { concealCanvasFeedback, restoreCanvasFeedbackVisibility } from './canvas-move-feedback'

export type FollowCamera = { x: number; y: number; zoom: number }

/** Screen-pixel camera. World deltas become the same CSS pixels the snapshot uses. */
export function followCamera(view: FollowCamera): Matrix {
  return [view.zoom, 0, 0, view.zoom, view.x, view.y]
}

/**
 * Map a screen point of the gesture-start snapshot to where that content
 * should be now. `worldDelta` is the same matrix the editor applies to each
 * selected world matrix (`transform * world`).
 */
export function screenWarp(view: FollowCamera, worldDelta: Matrix): Matrix | null {
  if (view.zoom <= 0 || !Number.isFinite(view.zoom) || worldDelta.length !== 6 ||
      !worldDelta.every(Number.isFinite)) return null
  try {
    const camera = followCamera(view)
    return multiply(camera, multiply(worldDelta, inverse(camera)))
  } catch {
    return null
  }
}

/**
 * CSS transform for an element whose layout origin is `origin` (the snapshot
 * crop). The element's local (0, 0) is that screen point before the gesture.
 */
export function elementMatrix(warp: Matrix, origin: { x: number; y: number }): Matrix {
  const [a, b, c, d, e, f] = warp
  return [a, b, c, d,
    a * origin.x + c * origin.y + e - origin.x,
    b * origin.x + d * origin.y + f - origin.y]
}

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

export type GestureFollowLayer = {
  holding: boolean
  waiting?: DesignDocument
  place(worldDelta: Matrix, screen: Point, degrees?: number): void
  reconceal(host: HTMLElement): void
  holdForCommit(): void
  waitFor(document: DesignDocument): void
  releaseIfPresented(frame: { document: object; preview?: boolean } | null): void
  destroy(): void
}

/** Lift the current pixels of the selection and move them with the pointer.
 * The exact renderer keeps working underneath; this only covers it until the
 * committed picture is presented. A failed snapshot leaves the existing path. */
export function mountGestureFollow(host: HTMLElement, options: {
  box: Bounds
  view: FollowCamera
  corners: readonly Point[]
  hole: string
  drawSelection: boolean
  ids: readonly string[]
  onDestroy?: () => void
}): GestureFollowLayer | null {
  let captured: ReturnType<typeof captureBoardFrame>
  try { captured = captureBoardFrame(host, options.box, options.view) }
  catch { return null }
  if (!captured) return null
  const warp0 = screenWarp(options.view, [1, 0, 0, 1, 0, 0])
  if (!warp0) return null
  const root = document.createElement('div')
  root.dataset.testid = 'gesture-follow'
  root.setAttribute('aria-hidden', 'true')
  Object.assign(root.style, {
    position: 'absolute', inset: '0', zIndex: '2', pointerEvents: 'none', overflow: 'hidden',
  })
  const { background, foreground, crop, width, height, pixelRatio } = captured
  background.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px`
  foreground.style.cssText = `position:absolute;left:${crop.x}px;top:${crop.y}px;width:${crop.width}px;height:${crop.height}px;will-change:transform;transform-origin:0 0`
  const context = background.getContext('2d')
  if (context) {
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    context.fillStyle = options.hole
    context.fillRect(crop.x, crop.y, crop.width, crop.height)
  }
  root.append(background, foreground)
  const hidden = new Map<SVGElement, string>()
  concealCanvasFeedback(host, options.ids, hidden)
  let polygon: SVGPolygonElement | undefined
  let hint: HTMLDivElement | undefined
  if (options.drawSelection && options.corners.length >= 3) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', String(width))
    svg.setAttribute('height', String(height))
    Object.assign(svg.style, { position: 'absolute', inset: '0', overflow: 'visible' })
    polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon')
    polygon.setAttribute('fill', 'none')
    polygon.setAttribute('stroke', '#0d99ff')
    polygon.setAttribute('stroke-width', '1.3')
    svg.append(polygon)
    root.append(svg)
  }
  hint = document.createElement('div')
  hint.className = 'canvas-rotation-hint'
  hint.dataset.testid = 'rotation-feedback'
  hint.style.display = 'none'
  root.append(hint)
  host.append(root)
  let destroyed = false
  let holding = false
  let waiting: DesignDocument | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const layer: GestureFollowLayer = {
    get holding() { return holding },
    get waiting() { return waiting },
    reconceal(host) { if (!destroyed) concealCanvasFeedback(host, options.ids, hidden) },
    place(worldDelta, screen, degrees) {
      if (destroyed) return
      const warp = screenWarp(options.view, worldDelta)
      if (!warp) return
      const matrix = elementMatrix(warp, crop)
      foreground.style.transform = `matrix(${matrix.join(',')})`
      if (polygon) {
        const camera = followCamera(options.view)
        polygon.setAttribute('points', options.corners.map(corner => {
          const at = apply(camera, apply(worldDelta, corner))
          return `${at.x},${at.y}`
        }).join(' '))
      }
      if (degrees === undefined) hint.style.display = 'none'
      else {
        hint.style.display = 'block'
        hint.style.left = `${screen.x + 18}px`
        hint.style.top = `${screen.y + 18}px`
        hint.textContent = `${formatFigmaAngle(degrees)}°`
      }
    },
    holdForCommit() {
      holding = true
      polygon?.remove()
      hint.style.display = 'none'
    },
    waitFor(document) {
      holding = true
      waiting = document
      clearTimeout(timer)
      // Exact pixels replace this preview. If they never arrive, uncover the
      // canvas anyway so a commit cannot stay hidden behind the snapshot.
      timer = setTimeout(() => layer.destroy(), 1500)
    },
    releaseIfPresented(frame) {
      if (frame && waiting && frame.document === waiting && !frame.preview) layer.destroy()
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      holding = false
      waiting = undefined
      clearTimeout(timer)
      restoreCanvasFeedbackVisibility(hidden)
      root.remove()
      options.onDestroy?.()
    },
  }
  return layer
}
