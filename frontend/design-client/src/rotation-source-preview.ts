import type { Bounds, DesignNode, Matrix, Point } from './model'
import type { ColorSpace } from './color'
import { isIdentityImageAdjust } from './model'
import { apply, boxPoints } from './commands/affine'
import { color_fully_opaque, rotation_source_preview_allowed } from './generated/design-kernel/design_kernel'
import { concealCanvasFeedback, restoreCanvasFeedbackVisibility } from './canvas-move-feedback'
import { elementMatrix, followCamera, screenWarp, type FollowCamera, type GestureFollowLayer } from './gesture-follow'
import { formatAngleDegrees } from './selection-handles'
import { SELECTION_BLUE, SELECTION_UNION_STROKE_PX } from './selection-blue'
import { sourceBitmap } from './source-bitmap'

/** Redraw one node's own paint. There is no crop: a viewport slice cannot
 * supply pixels that rotate in from outside the screen, and a framebuffer
 * crop of encoded alpha already contains the background. */
export type RotationBackdropPatch = { box: Bounds; color: string }

export type RotationSourcePlan = {
  box: Bounds
  /** Partition of the visible original footprint. Each patch is a color that
   * is actually behind that rectangle. This is not the immediate parent fill
   * stretched across the whole child. */
  holes: readonly RotationBackdropPatch[]
  /** Axis-aligned ancestor clip in world space. Paint stays the full source
   * rectangle; the clip only hides pixels the ancestors themselves hide. */
  clip?: Bounds
  paint: { kind: 'solid'; color: string } | { kind: 'image'; src: string; fit: 'cover' | 'contain' | 'fill' }
}

export type RotationAncestor = { node: DesignNode; matrix: Matrix }

export type RotationSourceInput = {
  node: DesignNode
  world: Matrix
  others: readonly Bounds[]
  center: Point
  degrees: number
  pageBackground: string
  documentSpace: ColorSpace
  parent: DesignNode | null
  /** Outermost first. Required when `parent` is set. */
  ancestors?: readonly RotationAncestor[]
  /** Document nodes, so a mask under an ancestor can be rejected. */
  nodes?: Readonly<Record<string, DesignNode>>
  grid: boolean
  checkerboard: boolean
  pixelPreview: boolean
}

const AREA_EPS = 1e-6

/** The browser paints this URL once. `?samples=1` is the desktop texel
 * protocol, not a second image; GET of the same path is the PNG. */
export function rotationImageAddress(uri: string): string | null {
  if (/^(?:data:|blob:|https?:|\/)/.test(uri)) return uri
  if (!sourceBitmap(uri)) return null
  const query = uri.indexOf('?')
  return query < 0 ? uri : uri.slice(0, query)
}

function axisAlignedBox(node: DesignNode, world: Matrix): Bounds | null {
  const [a, b, c, d, e, f] = world
  if (![a, b, c, d, e, f, node.width, node.height].every(Number.isFinite)) return null
  if (Math.abs(b) > 1e-6 || Math.abs(c) > 1e-6 || a <= 1e-6 || d <= 1e-6) return null
  const width = node.width * a
  const height = node.height * d
  if (!(width > AREA_EPS) || !(height > AREA_EPS)) return null
  return { x: e, y: f, width, height }
}

function intersectArea(a: Bounds, b: Bounds): Bounds | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (right - x <= AREA_EPS || bottom - y <= AREA_EPS) return null
  return { x, y, width: right - x, height: bottom - y }
}

/** `subject` minus `cover`, as up to four rectangles. A cover that contains
 * `subject` leaves nothing. */
function subtractArea(subject: Bounds, cover: Bounds): Bounds[] {
  const inside = intersectArea(subject, cover)
  if (!inside) return [subject]
  const subjectRight = subject.x + subject.width
  const subjectBottom = subject.y + subject.height
  const insideRight = inside.x + inside.width
  const insideBottom = inside.y + inside.height
  if (inside.x - subject.x <= AREA_EPS && inside.y - subject.y <= AREA_EPS &&
      subjectRight - insideRight <= AREA_EPS && subjectBottom - insideBottom <= AREA_EPS) return []
  const pieces: Bounds[] = []
  if (inside.x - subject.x > AREA_EPS) pieces.push({ x: subject.x, y: subject.y, width: inside.x - subject.x, height: subject.height })
  if (subjectRight - insideRight > AREA_EPS) pieces.push({ x: insideRight, y: subject.y, width: subjectRight - insideRight, height: subject.height })
  if (inside.y - subject.y > AREA_EPS) pieces.push({ x: inside.x, y: subject.y, width: inside.width, height: inside.y - subject.y })
  if (subjectBottom - insideBottom > AREA_EPS) pieces.push({ x: inside.x, y: insideBottom, width: inside.width, height: subjectBottom - insideBottom })
  return pieces
}

function opaquePageColor(pageBackground: string): string | null {
  if (!color_fully_opaque(pageBackground, 1)) return null
  return pageBackground.slice(0, 7).toLowerCase()
}

/** Page color behind a top-level object. An ancestor fill is not this color:
 * it covers only that ancestor's own rectangle, and only where outer clips
 * still show it. */
export function rotationBackdropColor(pageBackground: string, parent: DesignNode | null): string | null {
  if (parent) return null
  return opaquePageColor(pageBackground)
}

function rectangularShape(node: DesignNode): boolean {
  return (node.kind === 'rectangle' || node.kind === 'frame' || node.kind === 'section' || node.kind === 'group')
    && !node.network && !node.vectorGeometry && !node.booleanOperation && !node.arc && !node.textPath && node.pathOffset == null
}

function ancestorAllowsBackdrop(node: DesignNode, matrix: Matrix, nodes: RotationSourceInput['nodes']): boolean {
  if (!node.visible || !(node.opacity >= 1 - 1e-9)) return false
  if (node.blend !== 'normal' && node.blend !== 'pass-through') return false
  if (node.mask || node.repeat) return false
  if (!rectangularShape(node)) return false
  if ((node.cornerRadius ?? 0) > 1e-6 || node.radii.some(radius => radius > 1e-6) || node.smoothing > 1e-6) return false
  if (node.effects.some(effect => effect.visible)) return false
  if (node.strokes.some(stroke => stroke.visible && stroke.width > 0)) return false
  if (!axisAlignedBox(node, matrix)) return false
  if (node.children.some(id => !nodes?.[id])) return false
  return !node.children.some(id => {
    const child = nodes?.[id]
    return !!child?.visible && !!child.mask
  })
}

type Coverage = { kind: 'clear' } | { kind: 'paint'; box: Bounds; color: string } | { kind: 'unknown'; box: Bounds }

function ancestorCoverage(node: DesignNode, matrix: Matrix, outerClip: Bounds | null): Coverage | null {
  const box = axisAlignedBox(node, matrix)
  if (!box) return null
  const shape = outerClip ? intersectArea(box, outerClip) : box
  if (!shape) return { kind: 'clear' }
  const fills = node.fills.filter(paint => paint.visible && paint.opacity > 0)
  if (!fills.length) return { kind: 'clear' }
  const front = fills[fills.length - 1]
  if (front.kind === 'solid' && front.blend === 'normal' && color_fully_opaque(front.color, front.opacity)) {
    return { kind: 'paint', box: shape, color: front.color.slice(0, 7).toLowerCase() }
  }
  return { kind: 'unknown', box: shape }
}

function overlapsAny(box: Bounds, rects: readonly Bounds[]): boolean {
  return rects.some(rect => intersectArea(box, rect) !== null)
}

/** Visible footprint of `child`, clipped by every ancestor that clips, then
 * split into the front-most opaque color that actually covers each piece.
 * A parent fill that only crosses part of the footprint does not become the
 * color of the rest. */
function proveRotationBackdrop(
  input: RotationSourceInput,
  child: Bounds,
  chain: readonly RotationAncestor[],
): { holes: RotationBackdropPatch[]; clip?: Bounds } | null {
  for (const ancestor of chain) {
    if (!ancestorAllowsBackdrop(ancestor.node, ancestor.matrix, input.nodes)) return null
  }
  let clip: Bounds | undefined
  for (const ancestor of chain) {
    if (!ancestor.node.clip) continue
    const box = axisAlignedBox(ancestor.node, ancestor.matrix)
    if (!box) return null
    const next = clip ? intersectArea(clip, box) : box
    if (!next) return null
    clip = next
  }
  const visible = clip ? intersectArea(child, clip) : child
  if (!visible) return null
  let uncovered = [visible]
  const holes: RotationBackdropPatch[] = []
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    let outer: Bounds | null = null
    for (let outerIndex = 0; outerIndex < index; outerIndex += 1) {
      if (!chain[outerIndex].node.clip) continue
      const box = axisAlignedBox(chain[outerIndex].node, chain[outerIndex].matrix)
      if (!box) return null
      const next: Bounds | null = outer ? intersectArea(outer, box) : box
      if (!next) return null
      outer = next
    }
    const coverage = ancestorCoverage(chain[index].node, chain[index].matrix, outer)
    if (!coverage) return null
    if (coverage.kind === 'clear') continue
    if (coverage.kind === 'unknown') {
      if (overlapsAny(coverage.box, uncovered)) return null
      continue
    }
    const next: Bounds[] = []
    for (const rect of uncovered) {
      const hit = intersectArea(rect, coverage.box)
      if (!hit) {
        next.push(rect)
        continue
      }
      holes.push({ box: hit, color: coverage.color })
      next.push(...subtractArea(rect, coverage.box))
      if (holes.length > 16 || next.length > 16) return null
    }
    uncovered = next
  }
  if (uncovered.length) {
    const page = opaquePageColor(input.pageBackground)
    if (!page) return null
    for (const rect of uncovered) holes.push({ box: rect, color: page })
  }
  if (!holes.length || holes.length > 16) return null
  return clip ? { holes, clip } : { holes }
}

export function rotationSourcePlan(input: RotationSourceInput): RotationSourcePlan | null {
  const { node } = input
  // CSS paint has sRGB semantics. A parent is allowed only when the backdrop
  // under the visible footprint is a proven partition of opaque rectangles.
  if (input.documentSpace !== 'srgb') return null
  if (input.grid || input.checkerboard || input.pixelPreview) return null
  const chain = input.ancestors ?? []
  if (input.parent) {
    if (!chain.length || chain[chain.length - 1].node !== input.parent) return null
  } else if (chain.length) return null
  if (!node.visible || !(node.opacity >= 1 - 1e-9) || (node.blend !== 'normal' && node.blend !== 'pass-through')) return null
  if (node.kind !== 'rectangle' && node.kind !== 'frame') return null
  if (node.children.length || node.mask || node.repeat || node.network || node.vectorGeometry || node.booleanOperation || node.arc || node.textPath || node.pathOffset != null) return null
  if ((node.cornerRadius ?? 0) > 1e-6 || node.radii.some(radius => radius > 1e-6) || node.smoothing > 1e-6) return null
  const box = axisAlignedBox(node, input.world)
  if (!box || !Number.isFinite(input.degrees) || !Number.isFinite(input.center.x) || !Number.isFinite(input.center.y)) return null
  const proven = proveRotationBackdrop(input, box, chain)
  if (!proven) return null
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
  } else if (fill.kind === 'image' && fill.image) {
    const src = rotationImageAddress(fill.image)
    if (!src) return null
    if (fill.transform || (fill.adjust && !isIdentityImageAdjust(fill.adjust)) || (fill.tile && fill.tile.mode !== 'none')) return null
    image = true
    paint = { kind: 'image', src, fit: fill.fit === 'stretch' ? 'fill' : fill.fit }
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
  return proven.clip ? { box, holes: proven.holes, clip: proven.clip, paint } : { box, holes: proven.holes, paint }
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

/** Place the node's own paint on top of the stationary page. Each hole is a
 * proven backdrop rectangle. Incoming pixels come from the full source
 * rectangle, not from a captured viewport slice. */
export function mountRotationSource(host: HTMLElement, options: {
  plan: RotationSourcePlan
  view: FollowCamera
  viewport: { width: number; height: number }
  corners: readonly Point[]
  drawSelection: boolean
  ids: readonly string[]
  onDestroy?: () => void
  onPaintError?: () => void
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
  const patches: HTMLElement[] = []
  for (const hole of plan.holes) {
    const visible = intersectArea(hole.box, worldView)
    if (!visible) continue
    const holeScreen = screenRect(visible, view)
    const patch = document.createElement('div')
    patch.dataset.testid = 'rotation-source-hole'
    patch.dataset.holeColor = hole.color
    Object.assign(patch.style, {
      position: 'absolute', left: `${holeScreen.x}px`, top: `${holeScreen.y}px`,
      width: `${holeScreen.width}px`, height: `${holeScreen.height}px`, background: hole.color,
    })
    root.append(patch)
    patches.push(patch)
  }
  const clipScreen = plan.clip ? screenRect(plan.clip, view) : null
  const paintHost = document.createElement('div')
  if (clipScreen) {
    paintHost.dataset.testid = 'rotation-source-clip'
    Object.assign(paintHost.style, {
      position: 'absolute', overflow: 'hidden',
      left: `${clipScreen.x}px`, top: `${clipScreen.y}px`,
      width: `${clipScreen.width}px`, height: `${clipScreen.height}px`,
    })
  } else Object.assign(paintHost.style, { position: 'absolute', inset: '0', overflow: 'visible' })
  const source = document.createElement('div')
  source.dataset.testid = 'rotation-source-paint'
  source.dataset.sourceBox = `${plan.box.x},${plan.box.y},${plan.box.width},${plan.box.height}`
  Object.assign(source.style, {
    position: 'absolute', left: `${rect.x - (clipScreen?.x ?? 0)}px`, top: `${rect.y - (clipScreen?.y ?? 0)}px`,
    width: `${rect.width}px`, height: `${rect.height}px`,
    transformOrigin: '0 0', willChange: 'transform',
  })
  let paintFailed = false
  let destroyPaint: (() => void) | undefined
  if (plan.paint.kind === 'solid') source.style.background = plan.paint.color
  else {
    source.style.visibility = 'hidden'
    for (const patch of patches) patch.style.visibility = 'hidden'
    const image = document.createElement('img')
    image.alt = ''
    image.draggable = false
    const reveal = () => {
      source.style.visibility = ''
      for (const patch of patches) patch.style.visibility = ''
    }
    image.addEventListener('load', reveal)
    image.addEventListener('error', () => { paintFailed = true; options.onPaintError?.(); destroyPaint?.() })
    image.src = plan.paint.src
    if (image.complete && image.naturalWidth > 0) reveal()
    Object.assign(image.style, { width: '100%', height: '100%', objectFit: plan.paint.fit, display: 'block' })
    source.append(image)
  }
  paintHost.append(source)
  root.append(paintHost)
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
  destroyPaint = () => layer.destroy()
  if (paintFailed) queueMicrotask(() => { if (!destroyed) layer.destroy() })
  return layer
}
