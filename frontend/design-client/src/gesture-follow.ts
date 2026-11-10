import type { Bounds, DesignDocument, Matrix, Point } from './model'
import { apply, inverse, multiply, boxPoints, bounds } from './commands/affine'
import { type FollowCamera } from './gesture-follow-frame'
export { gestureHoleColor, visibleFollowBox, type FollowCamera } from './gesture-follow-frame'
import { captureBoardFrame } from './retained-board-capture'
import { concealCanvasFeedback, restoreCanvasFeedbackVisibility } from './canvas-move-feedback'
import { formatAngleDegrees } from './selection-handles'
import { SELECTION_BLUE, SELECTION_UNION_STROKE_PX } from './selection-blue'

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
  const determinant = worldDelta[0] * worldDelta[3] - worldDelta[1] * worldDelta[2]
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null
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

/** Both the lifted crop (including its two CSS pixel capture border) and its
 * destination must be independent of stationary paint in the completed frame. */
export function isolatedGestureCrop(box: Bounds, others: readonly Bounds[], view: FollowCamera, delta: Matrix,
  width: number, height: number): Bounds | undefined {
  const margin = 2/view.zoom
  const crop = {x:box.x-margin,y:box.y-margin,width:box.width+2*margin,height:box.height+2*margin}
  if (crop.x*view.zoom+view.x < 0 || crop.y*view.zoom+view.y < 0 ||
      (crop.x+crop.width)*view.zoom+view.x > width || (crop.y+crop.height)*view.zoom+view.y > height) return
  const moved = bounds(boxPoints(crop).map(point=>apply(delta,point)))
  const overlaps = (a: Bounds,b: Bounds) => a.x<b.x+b.width && b.x<a.x+a.width && a.y<b.y+b.height && b.y<a.y+a.height
  if (!others.some(other=>overlaps(crop,other) || overlaps(moved,other))) return box
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
    polygon.setAttribute('stroke', SELECTION_BLUE)
    polygon.setAttribute('stroke-width', String(SELECTION_UNION_STROKE_PX))
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
        hint.textContent = `${formatAngleDegrees(degrees)}°`
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
