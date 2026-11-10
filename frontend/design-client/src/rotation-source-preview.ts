import type { Bounds, DesignNode, Matrix, Point } from './model'
import { isIdentityImageAdjust } from './model'
import { apply, boxPoints } from './commands/affine'
import { color_fully_opaque, rotation_source_preview_allowed } from './generated/design-kernel/design_kernel'
import { concealCanvasFeedback, restoreCanvasFeedbackVisibility } from './canvas-move-feedback'
import { elementMatrix, followCamera, screenWarp, type FollowCamera, type GestureFollowLayer } from './gesture-follow'
import { formatAngleDegrees } from './selection-handles'
import { SELECTION_BLUE, SELECTION_UNION_STROKE_PX } from './selection-blue'

/** Redraw one node's own paint. There is no crop: a viewport slice cannot
 * supply pixels that rotate in from outside the screen, and a framebuffer
 * crop of encoded alpha already contains the background. */
export type RotationSourcePlan = {
  box: Bounds
  hole: string
  paint: { kind: 'solid'; color: string } | { kind: 'image'; src: string; fit: 'cover' | 'contain' | 'fill' }
}

export type RotationSourceInput = {
  node: DesignNode
  world: Matrix
  others: readonly Bounds[]
  center: Point
  degrees: number
  pageBackground: string
  parent: DesignNode | null
  grid: boolean
  checkerboard: boolean
  pixelPreview: boolean
}

function axisAlignedBox(node: DesignNode, world: Matrix): Bounds | null {
  const [a, b, c, d, e, f] = world
  if (![a, b, c, d, e, f, node.width, node.height].every(Number.isFinite)) return null
  if (Math.abs(b) > 1e-6 || Math.abs(c) > 1e-6 || a <= 1e-6 || d <= 1e-6) return null
  const width = node.width * a
  const height = node.height * d
  if (!(width > 0) || !(height > 0)) return null
  return { x: e, y: f, width, height }
}

/** The color behind an isolated node. A parent that is not one opaque solid
 * fill has a background this preview cannot reconstruct. */
export function rotationBackdropColor(pageBackground: string, parent: DesignNode | null): string | null {
  if (parent) {
    if (parent.effects.some(effect => effect.visible)) return null
    const fills = parent.fills.filter(paint => paint.visible && paint.opacity > 0)
    if (fills.length !== 1 || fills[0].kind !== 'solid' || fills[0].blend !== 'normal') return null
    if (!color_fully_opaque(fills[0].color, fills[0].opacity)) return null
    return fills[0].color.slice(0, 7)
  }
  if (!color_fully_opaque(pageBackground, 1)) return null
  return pageBackground.slice(0, 7)
}

export function rotationSourcePlan(input: RotationSourceInput): RotationSourcePlan | null {
  const { node } = input
  if (input.grid || input.checkerboard || input.pixelPreview) return null
  if (!node.visible || !(node.opacity >= 1 - 1e-9) || (node.blend !== 'normal' && node.blend !== 'pass-through')) return null
  if (node.kind !== 'rectangle' && node.kind !== 'frame') return null
  if (node.children.length || node.mask || node.network || node.vectorGeometry || node.booleanOperation || node.arc) return null
  if ((node.cornerRadius ?? 0) > 1e-6 || node.radii.some(radius => radius > 1e-6) || node.smoothing > 1e-6) return null
  const box = axisAlignedBox(node, input.world)
  const hole = rotationBackdropColor(input.pageBackground, input.parent)
  if (!box || !hole || !Number.isFinite(input.degrees) || !Number.isFinite(input.center.x) || !Number.isFinite(input.center.y)) return null
  const fills = node.fills.filter(paint => paint.visible && paint.opacity > 0)
  if (fills.length !== 1) return null
  const fill = fills[0]
  if (fill.blend !== 'normal') return null
  const backdrop = node.effects.some(effect => effect.visible && (effect.kind === 'background-blur' || effect.kind === 'glass'))
  const effects = node.effects.some(effect => effect.visible)
  const strokes = node.strokes.some(stroke => stroke.visible)
  let image = false
  let paint: RotationSourcePlan['paint']
  if (fill.kind === 'solid') {
    paint = { kind: 'solid', color: fill.color.slice(0, 7) }
  } else if (fill.kind === 'image' && fill.image && /^(?:data:|blob:|https?:|\/)/.test(fill.image)) {
    if (fill.transform || (fill.adjust && !isIdentityImageAdjust(fill.adjust)) || (fill.tile && fill.tile.mode !== 'none')) return null
    image = true
    paint = { kind: 'image', src: fill.image, fit: fill.fit === 'stretch' ? 'fill' : fill.fit }
  } else {
    return null
  }
  const others = new Float64Array(input.others.length * 4)
  for (let index = 0; index < input.others.length; index++) {
    const other = input.others[index]
    others[index * 4] = other.x
    others[index * 4 + 1] = other.y
    others[index * 4 + 2] = other.width
    others[index * 4 + 3] = other.height
  }
  if (!rotation_source_preview_allowed(
    fill.color, fill.opacity, image, backdrop, effects, strokes,
    box.x, box.y, box.width, box.height, input.center.x, input.center.y, input.degrees, others,
  )) return null
  return { box, hole, paint }
}

function pointInConvex(point: Point, corners: readonly Point[]): boolean {
  let sign = 0
  for (let index = 0; index < corners.length; index++) {
    const a = corners[index]
    const b = corners[(index + 1) % corners.length]
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x)
    if (Math.abs(cross) <= 1e-6) continue
    const next = Math.sign(cross)
    if (sign && next !== sign) return false
    sign = next
  }
  return sign !== 0
}

/** Screen point covered by the full source rectangle after `delta`. */
export function rotationSourceCoversScreen(box: Bounds, view: FollowCamera, delta: Matrix, screen: Point): boolean {
  const camera = followCamera(view)
  return pointInConvex(screen, boxPoints(box).map(corner => apply(camera, apply(delta, corner))))
}

function screenRect(box: Bounds, view: FollowCamera) {
  return {
    x: view.x + box.x * view.zoom,
    y: view.y + box.y * view.zoom,
    width: box.width * view.zoom,
    height: box.height * view.zoom,
  }
}

function intersectBox(a: Bounds, b: Bounds): Bounds | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (right - x < 0.5 || bottom - y < 0.5) return null
  return { x, y, width: right - x, height: bottom - y }
}

/** Place the node's own paint on top of the stationary page. The old footprint
 * is covered with the backdrop color. Incoming pixels come from the full
 * source rectangle, not from a captured viewport slice. */
export function mountRotationSource(host: HTMLElement, options: {
  plan: RotationSourcePlan
  view: FollowCamera
  viewport: { width: number; height: number }
  corners: readonly Point[]
  drawSelection: boolean
  ids: readonly string[]
  onDestroy?: () => void
}): GestureFollowLayer | null {
  const { plan, view } = options
  if (!(view.zoom > 0) || !(options.viewport.width > 0) || !(options.viewport.height > 0)) return null
  const warp0 = screenWarp(view, [1, 0, 0, 1, 0, 0])
  if (!warp0) return null
  const rect = screenRect(plan.box, view)
  const root = document.createElement('div')
  root.dataset.testid = 'rotation-source-preview'
  root.setAttribute('aria-hidden', 'true')
  Object.assign(root.style, {
    position: 'absolute', inset: '0', zIndex: '2', pointerEvents: 'none', overflow: 'hidden',
  })
  const worldView = {
    x: -view.x / view.zoom, y: -view.y / view.zoom,
    width: options.viewport.width / view.zoom, height: options.viewport.height / view.zoom,
  }
  const hole = intersectBox(plan.box, worldView)
  if (hole) {
    const holeScreen = screenRect(hole, view)
    const patch = document.createElement('div')
    patch.dataset.testid = 'rotation-source-hole'
    Object.assign(patch.style, {
      position: 'absolute', left: `${holeScreen.x}px`, top: `${holeScreen.y}px`,
      width: `${holeScreen.width}px`, height: `${holeScreen.height}px`, background: plan.hole,
    })
    root.append(patch)
  }
  const source = document.createElement('div')
  source.dataset.testid = 'rotation-source-paint'
  source.dataset.sourceBox = `${plan.box.x},${plan.box.y},${plan.box.width},${plan.box.height}`
  Object.assign(source.style, {
    position: 'absolute', left: `${rect.x}px`, top: `${rect.y}px`,
    width: `${rect.width}px`, height: `${rect.height}px`,
    transformOrigin: '0 0', willChange: 'transform',
  })
  if (plan.paint.kind === 'solid') source.style.background = plan.paint.color
  else {
    const image = document.createElement('img')
    image.alt = ''
    image.draggable = false
    image.src = plan.paint.src
    Object.assign(image.style, { width: '100%', height: '100%', objectFit: plan.paint.fit, display: 'block' })
    source.append(image)
  }
  root.append(source)
  const hidden = new Map<SVGElement, string>()
  concealCanvasFeedback(host, options.ids, hidden)
  let polygon: SVGPolygonElement | undefined
  if (options.drawSelection && options.corners.length >= 3) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', String(options.viewport.width))
    svg.setAttribute('height', String(options.viewport.height))
    Object.assign(svg.style, { position: 'absolute', inset: '0', overflow: 'visible' })
    polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon')
    polygon.setAttribute('fill', 'none')
    polygon.setAttribute('stroke', SELECTION_BLUE)
    polygon.setAttribute('stroke-width', String(SELECTION_UNION_STROKE_PX))
    svg.append(polygon)
    root.append(svg)
  }
  const hint = document.createElement('div')
  hint.className = 'canvas-rotation-hint'
  hint.dataset.testid = 'rotation-feedback'
  hint.style.display = 'none'
  root.append(hint)
  host.append(root)
  let destroyed = false
  let holding = false
  let waiting: import('./model').DesignDocument | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const layer: GestureFollowLayer = {
    get holding() { return holding },
    get waiting() { return waiting },
    reconceal(next) { if (!destroyed) concealCanvasFeedback(next, options.ids, hidden) },
    place(worldDelta, screen, degrees) {
      if (destroyed) return
      const warp = screenWarp(view, worldDelta)
      if (!warp) return
      source.style.transform = `matrix(${elementMatrix(warp, rect).join(',')})`
      if (polygon) {
        const camera = followCamera(view)
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
    waitFor(next) {
      holding = true
      waiting = next
      clearTimeout(timer)
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
