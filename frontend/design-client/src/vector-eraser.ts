import { editableNetwork, materializeEditableNetwork } from './editable-network'
import {
  allParents,
  apply,
  bounds,
  contoursToNetwork,
  distance,
  edgePoints,
  inverse,
  pointInContours,
  strokeWalks,
  worldMatrix,
} from './geometry'
import { uid, type DesignDocument, type DesignNode, type Network, type Point } from './model'
import { booleanContours } from './vector'

/** Screen-constant brush. Figma's eraser weight is independent of stroke width. */
export const ERASER_SCREEN_PX = 12

const ERASABLE = new Set<DesignNode['kind']>(['line', 'vector', 'rectangle', 'ellipse', 'polygon', 'star'])

export type EraserCircle = Point & { r: number }
export type EraserEdit =
  | { id: string; kind: 'delete' }
  | { id: string; kind: 'update'; node: DesignNode }

type Circle = { c: Point; r: number }
type Cubic = [Point, Point, Point, Point]

function pointAt(c: Cubic, t: number): Point {
  const s = 1 - t
  return {
    x: s * s * s * c[0].x + 3 * s * s * t * c[1].x + 3 * s * t * t * c[2].x + t * t * t * c[3].x,
    y: s * s * s * c[0].y + 3 * s * s * t * c[1].y + 3 * s * t * t * c[2].y + t * t * t * c[3].y,
  }
}

function splitCubic(c: Cubic, t: number): [Cubic, Cubic] {
  const [a, b, c1, d] = c
  const ab = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
  const bc = { x: b.x + (c1.x - b.x) * t, y: b.y + (c1.y - b.y) * t }
  const cd = { x: c1.x + (d.x - c1.x) * t, y: c1.y + (d.y - c1.y) * t }
  const abc = { x: ab.x + (bc.x - ab.x) * t, y: ab.y + (bc.y - ab.y) * t }
  const bcd = { x: bc.x + (cd.x - bc.x) * t, y: bc.y + (cd.y - bc.y) * t }
  const mid = { x: abc.x + (bcd.x - abc.x) * t, y: abc.y + (bcd.y - abc.y) * t }
  return [[a, ab, abc, mid], [mid, bcd, cd, d]]
}

function sliceCubic(c: Cubic, t0: number, t1: number): Cubic {
  let right = c
  if (t0 > 1e-6) right = splitCubic(c, t0)[1]
  const u = t0 >= 1 - 1e-6 ? 0 : (t1 - t0) / (1 - t0)
  if (u >= 1 - 1e-6) return right
  return splitCubic(right, Math.min(1, Math.max(0, u)))[0]
}

function insidePoint(point: Point, circles: Circle[]) {
  return circles.some(circle => distance(point, circle.c) <= circle.r + 1e-6)
}

function insideIntervals(c: Cubic, circles: Circle[]): [number, number][] {
  const length = distance(c[0], c[1]) + distance(c[1], c[2]) + distance(c[2], c[3])
  const radius = Math.max(1e-3, Math.min(...circles.map(circle => circle.r)))
  const steps = Math.max(8, Math.min(64, Math.ceil(length / (radius * 0.5))))
  const flags: boolean[] = []
  for (let i = 0; i <= steps; i++) flags.push(insidePoint(pointAt(c, i / steps), circles))
  const refine = (lo: number, hi: number, wantInside: boolean) => {
    let a = lo, b = hi
    for (let i = 0; i < 18; i++) {
      const mid = (a + b) / 2
      if (insidePoint(pointAt(c, mid), circles) === wantInside) b = mid
      else a = mid
    }
    return (a + b) / 2
  }
  const cuts: [number, number][] = []
  let i = 0
  while (i <= steps) {
    if (!flags[i]) { i++; continue }
    const start = i
    while (i <= steps && flags[i]) i++
    const t0 = start === 0 ? 0 : refine((start - 1) / steps, start / steps, true)
    const t1 = i > steps ? 1 : refine((i - 1) / steps, Math.min(1, i / steps), false)
    if (t1 - t0 > 1e-4) cuts.push([Math.max(0, t0), Math.min(1, t1)])
  }
  return cuts
}

function edgeCubic(network: Network, edge: Network['edges'][number]): Cubic | null {
  const a = network.vertices.find(vertex => vertex.id === edge.from)
  const d = network.vertices.find(vertex => vertex.id === edge.to)
  if (!a || !d) return null
  return [a, edge.c1 || a, edge.c2 || d, d]
}

/** Open strokes keep untouched cubics. The span under the brush is removed and
 * new points sit on the original curve at the brush boundary. */
export function eraseStrokeNetwork(network: Network, circles: Circle[]): Network | null | 'unchanged' {
  if (!circles.length || !network.edges.length) return 'unchanged'
  const next: Network = { vertices: [], edges: [], fillRule: network.fillRule }
  const keep = new Map<string, string>()
  let changed = false
  const reuse = (id: string, at: Point) => {
    const existing = keep.get(id)
    if (existing) return existing
    const copy = uid()
    keep.set(id, copy)
    next.vertices.push({ id: copy, x: at.x, y: at.y })
    return copy
  }
  for (const edge of network.edges) {
    const cubic = edgeCubic(network, edge)
    if (!cubic) { changed = true; continue }
    const cuts = insideIntervals(cubic, circles)
    if (!cuts.length) {
      const from = reuse(edge.from, cubic[0])
      const to = reuse(edge.to, cubic[3])
      next.edges.push({ id: uid(), from, to, ...(edge.c1 ? { c1: { ...edge.c1 } } : {}), ...(edge.c2 ? { c2: { ...edge.c2 } } : {}) })
      continue
    }
    changed = true
    const outside: [number, number][] = []
    let cursor = 0
    for (const [a, b] of cuts) {
      if (a - cursor > 1e-4) outside.push([cursor, a])
      cursor = b
    }
    if (1 - cursor > 1e-4) outside.push([cursor, 1])
    const curved = !!(edge.c1 || edge.c2)
    for (const [a, b] of outside) {
      const piece = sliceCubic(cubic, a, b)
      const from = a <= 1e-4 ? reuse(edge.from, piece[0]) : (() => { const id = uid(); next.vertices.push({ id, x: piece[0].x, y: piece[0].y }); return id })()
      const to = b >= 1 - 1e-4 ? reuse(edge.to, piece[3]) : (() => { const id = uid(); next.vertices.push({ id, x: piece[3].x, y: piece[3].y }); return id })()
      if (from === to) continue
      next.edges.push({
        id: uid(), from, to,
        ...(curved ? { c1: { x: piece[1].x, y: piece[1].y }, c2: { x: piece[2].x, y: piece[2].y } } : {}),
      })
    }
  }
  if (!changed) return 'unchanged'
  if (!next.edges.length) return null
  if (network.filledFaces) {
    const edges = new Set(next.edges.map(edge => edge.id))
    next.filledFaces = network.filledFaces.filter(face => face.every(id => edges.has(id)))
  }
  return next
}

function circlePoly(center: Point, radius: number): Point[] {
  const steps = 16
  return Array.from({ length: steps }, (_, i) => ({
    x: center.x + Math.cos((i / steps) * Math.PI * 2) * radius,
    y: center.y + Math.sin((i / steps) * Math.PI * 2) * radius,
  }))
}

function networkContours(network: Network): Point[][] {
  return strokeWalks(network).flatMap(walk => {
    if (!walk.closed) return []
    const points = walk.edges.flatMap((step, index) => edgePoints(network, step.edge, step.reverse, 0.5).slice(index ? 1 : 0))
    return points.length >= 3 ? [points] : []
  })
}

function brushFootprint(circles: Circle[]): Point[][] {
  const shapes = circles.map(circle => [circlePoly(circle.c, circle.r)])
  if (shapes.length === 1) return shapes[0]
  return booleanContours(shapes, 'union')
}

/** Filled shapes lose the brush region and stay one layer. Untouched cubics are
 * rebuilt from the flattened outline, which is the subtraction boundary. */
export function eraseFilledNetwork(network: Network, circles: Circle[]): Network | null | 'unchanged' {
  const contours = networkContours(network)
  if (!contours.length) return eraseStrokeNetwork(network, circles)
  const hitsOutline = network.edges.some(edge => {
    const cubic = edgeCubic(network, edge)
    return !!cubic && insideIntervals(cubic, circles).length > 0
  })
  const hitsInterior = circles.some(circle => pointInContours(circle.c, contours, network.fillRule))
  if (!hitsOutline && !hitsInterior) return 'unchanged'
  try {
    const result = booleanContours([contours, brushFootprint(circles)], 'subtract')
    if (!result.length) return null
    const rebuilt = contoursToNetwork(result)
    rebuilt.fillRule = 'evenodd'
    return rebuilt
  } catch {
    return eraseStrokeNetwork(network, circles)
  }
}

export function downsampleEraserPoints(points: Point[], radius: number): Point[] {
  const min = Math.max(radius * 0.45, 0.5)
  const kept: Point[] = []
  for (const point of points) {
    const last = kept.at(-1)
    if (!last || distance(last, point) >= min) kept.push(point)
  }
  const tail = points.at(-1)
  if (tail && (!kept.length || distance(kept.at(-1)!, tail) > 1e-6)) kept.push(tail)
  const max = 24
  if (kept.length <= max) return kept
  return Array.from({ length: max }, (_, index) => kept[Math.round(index * (kept.length - 1) / (max - 1))])
}

function lockedNode(doc: DesignDocument, id: string, parents: ReturnType<typeof allParents>) {
  let current: string | undefined = id
  while (current && doc.nodes[current]) {
    if (doc.nodes[current].locked) return true
    current = parents.get(current)
  }
  return false
}

function pageNodeIds(doc: DesignDocument, pageId: string) {
  const page = doc.pages.find(item => item.id === pageId)
  if (!page) return []
  const ids: string[] = []
  const visit = (id: string) => {
    ids.push(id)
    doc.nodes[id]?.children.forEach(visit)
  }
  page.children.forEach(visit)
  return ids
}

function expandedBounds(doc: DesignDocument, id: string, radius: number) {
  const node = doc.nodes[id]
  const matrix = worldMatrix(doc, id)
  const local = node.network?.vertices.length
    ? node.network.vertices
    : [{ x: 0, y: 0 }, { x: node.width, y: 0 }, { x: node.width, y: node.height }, { x: 0, y: node.height }]
  const box = bounds(local.map(point => apply(matrix, point)))
  return { x: box.x - radius, y: box.y - radius, width: box.width + radius * 2, height: box.height + radius * 2 }
}

function hitsBox(box: { x: number; y: number; width: number; height: number }, circles: EraserCircle[]) {
  return circles.some(circle => {
    const x = Math.max(box.x, Math.min(circle.x, box.x + box.width))
    const y = Math.max(box.y, Math.min(circle.y, box.y + box.height))
    return Math.hypot(circle.x - x, circle.y - y) <= circle.r
  })
}

function localCircles(doc: DesignDocument, id: string, circles: EraserCircle[]): Circle[] {
  const matrix = worldMatrix(doc, id)
  const inverseMatrix = inverse(matrix)
  const sx = Math.hypot(matrix[0], matrix[1]) || 1
  const sy = Math.hypot(matrix[2], matrix[3]) || 1
  const scale = 2 / (sx + sy)
  return circles.map(circle => ({ c: apply(inverseMatrix, circle), r: circle.r * scale }))
}

export function planVectorEraser(doc: DesignDocument, pageId: string, points: Point[], radius: number): { edits: EraserEdit[]; rejected: number } {
  const samples = downsampleEraserPoints(points, radius)
  const circles = samples.map(point => ({ ...point, r: radius }))
  const parents = allParents(doc)
  const edits: EraserEdit[] = []
  let rejected = 0
  for (const id of pageNodeIds(doc, pageId)) {
    const node = doc.nodes[id]
    if (!node?.visible || !ERASABLE.has(node.kind)) continue
    if (!hitsBox(expandedBounds(doc, id, radius), circles)) continue
    if (lockedNode(doc, id, parents)) { rejected++; continue }
    let source: Network
    try { source = editableNetwork(node) } catch { continue }
    const local = localCircles(doc, id, circles)
    const filled = node.fills.some(paint => paint.visible)
    const erased = filled ? eraseFilledNetwork(source, local) : eraseStrokeNetwork(source, local)
    if (erased === 'unchanged') continue
    if (!erased) edits.push({ id, kind: 'delete' })
    else edits.push({ id, kind: 'update', node: materializeEditableNetwork(node, erased) })
  }
  return { edits, rejected }
}

export function eraserPreviewPatches(edits: EraserEdit[]): Record<string, Partial<DesignNode>> {
  const patches: Record<string, Partial<DesignNode>> = {}
  for (const edit of edits) {
    if (edit.kind === 'delete') patches[edit.id] = { visible: false }
    else {
      const { id: _id, ...rest } = edit.node
      patches[edit.id] = rest
    }
  }
  return patches
}

export function applyEraserEdits(doc: DesignDocument, edits: EraserEdit[]) {
  const parents = allParents(doc)
  for (const edit of edits) {
    if (!doc.nodes[edit.id]) continue
    if (edit.kind === 'delete') {
      const parent = parents.get(edit.id)
      const list = doc.nodes[parent || '']?.children || doc.pages.find(page => page.id === parent)?.children
      if (list) {
        const index = list.indexOf(edit.id)
        if (index >= 0) list.splice(index, 1)
      }
      delete doc.nodes[edit.id]
    } else doc.nodes[edit.id] = edit.node
  }
}
