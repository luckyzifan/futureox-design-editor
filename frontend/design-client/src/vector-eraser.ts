import type { DesignNode, Network, Point } from './model'
import { uid } from './model'
import {
  area,
  contours,
  contoursToNetwork,
  distance,
  edgePoints,
  lerp,
  pointInContours,
  segmentDistance,
} from './geometry'
import { booleanContours } from './vector'
import { editableNetwork } from './editable-network'

/** Screen-pixel width of the eraser. World radius is this divided by zoom. */
export const ERASER_RADIUS_PX = 12

const EMPTY: Network = { vertices: [], edges: [], fillRule: 'evenodd' }

function finite(points: Point[]): Point[] {
  return points.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
}

function downsample(points: Point[], max: number): Point[] {
  if (points.length <= max) return points
  const out: Point[] = []
  for (let i = 0; i < max; i++) out.push(points[Math.round((i * (points.length - 1)) / (max - 1))])
  return out
}

function circle(center: Point, radius: number, steps = 16): Point[] {
  return Array.from({ length: steps }, (_, index) => {
    const angle = (index / steps) * Math.PI * 2
    return { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius }
  })
}

function stadium(a: Point, b: Point, radius: number): Point[] {
  const dx = b.x - a.x, dy = b.y - a.y
  const length = Math.hypot(dx, dy)
  if (length < 1e-6) return circle(a, radius)
  const nx = (-dy / length) * radius, ny = (dx / length) * radius
  const heading = Math.atan2(dy, dx)
  const arc = (center: Point, start: number) => Array.from({ length: 8 }, (_, index) => {
    const angle = start + (Math.PI * index) / 8
    return { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius }
  })
  return [
    { x: a.x + nx, y: a.y + ny },
    { x: b.x + nx, y: b.y + ny },
    ...arc(b, heading + Math.PI / 2),
    { x: b.x - nx, y: b.y - ny },
    { x: a.x - nx, y: a.y - ny },
    ...arc(a, heading + Math.PI * 1.5),
  ]
}

/** One closed brush outline. A long stroke is downsampled before the unions. */
export function brushContour(stroke: Point[], radius: number): Point[] | null {
  const points = downsample(finite(stroke), 24)
  if (!points.length || !(radius > 0)) return null
  const pieces = points.length === 1
    ? [circle(points[0], radius)]
    : points.slice(0, -1).map((point, index) => stadium(point, points[index + 1], radius))
  try {
    let loops = [pieces[0]]
    for (let index = 1; index < pieces.length; index++) {
      const united = booleanContours([loops, [pieces[index]]], 'union')
      if (united.length) loops = united
    }
    loops.sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)))
    return loops[0] && loops[0].length >= 3 ? loops[0] : null
  } catch {
    return pieces[0].length >= 3 ? pieces[0] : null
  }
}

function hitsStroke(point: Point, stroke: Point[], radius: number): boolean {
  if (stroke.length === 1) return distance(point, stroke[0]) <= radius
  for (let index = 1; index < stroke.length; index++) {
    if (segmentDistance(point, stroke[index - 1], stroke[index]) <= radius) return true
  }
  return false
}

function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2) return points
  const kept = [points[0]]
  for (let index = 1; index < points.length - 1; index++) {
    if (segmentDistance(points[index], kept[kept.length - 1], points[index + 1]) > tolerance) kept.push(points[index])
  }
  kept.push(points[points.length - 1])
  return kept
}

/** Remove the portions of a network that pass through the eraser stroke.
 * Untouched curves stay authored. A partial cut becomes editable points.
 * The result stays one network: this does not split a layer. */
export function cutNetwork(network: Network, stroke: Point[], radius: number): { network: Network; changed: boolean } {
  const samples = finite(stroke)
  if (!(radius > 0) || !samples.length || !network.edges.length) return { network, changed: false }
  const vertices = new Map(network.vertices.map(vertex => [vertex.id, vertex]))
  const nextVertices = network.vertices.map(vertex => ({ ...vertex }))
  const nextEdges: Network['edges'] = []
  const used = new Set<string>()
  let changed = false
  for (const edge of network.edges) {
    const from = vertices.get(edge.from), to = vertices.get(edge.to)
    if (!from || !to) { changed = true; continue }
    const flat = edgePoints(network, edge, false, Math.min(0.35, Math.max(radius / 4, 0.15)))
    const chain: Point[] = []
    for (let index = 0; index < flat.length - 1; index++) {
      const length = distance(flat[index], flat[index + 1])
      const steps = Math.min(80, Math.max(1, Math.ceil(length / Math.max(radius / 3, 0.25))))
      for (let step = 0; step < steps; step++) chain.push(lerp(flat[index], flat[index + 1], step / steps))
    }
    chain.push(flat[flat.length - 1])
    const erased = chain.map(point => hitsStroke(point, samples, radius))
    if (erased.every(flag => !flag)) {
      nextEdges.push({ ...edge })
      used.add(edge.from)
      used.add(edge.to)
      continue
    }
    changed = true
    if (erased.every(Boolean)) continue
    let index = 0
    while (index < erased.length) {
      if (erased[index]) { index++; continue }
      let end = index
      while (end < erased.length && !erased[end]) end++
      const run = simplify(chain.slice(index, end), Math.max(0.35, radius / 5))
      if (run.length >= 2) {
        const ids = run.map((point, pointIndex) => {
          if (index === 0 && pointIndex === 0) return edge.from
          if (end === erased.length && pointIndex === run.length - 1) return edge.to
          const id = uid()
          nextVertices.push({ ...point, id })
          return id
        })
        for (let pointIndex = 0; pointIndex < ids.length - 1; pointIndex++) {
          nextEdges.push({ id: uid(), from: ids[pointIndex], to: ids[pointIndex + 1] })
          used.add(ids[pointIndex])
          used.add(ids[pointIndex + 1])
        }
      }
      index = end
    }
  }
  if (!changed) return { network, changed: false }
  const edgeIds = new Set(nextEdges.map(edge => edge.id))
  const filledFaces = network.filledFaces?.filter(face => face.every(id => edgeIds.has(id)))
  return {
    network: {
      vertices: nextVertices.filter(vertex => used.has(vertex.id)),
      edges: nextEdges,
      fillRule: network.fillRule,
      ...(filledFaces && filledFaces.length ? { filledFaces } : {}),
    },
    changed: true,
  }
}

function brushHits(shape: Point[][], stroke: Point[], radius: number): boolean {
  for (const point of stroke) {
    if (shape.some(contour => pointInContours(point, [contour]) || contour.some((start, index) => segmentDistance(point, start, contour[(index + 1) % contour.length]) <= radius)))
      return true
  }
  return false
}

/** Figma's eraser rubs out part of a vector and leaves the rest on the same layer.
 * Filled closed shapes lose the brush area. Open strokes lose the crossed span. */
export function eraseNodeGeometry(node: DesignNode, stroke: Point[], radius: number): { network: Network; changed: boolean } | null {
  const samples = finite(stroke)
  if (!(radius > 0) || !samples.length) return { network: node.network ? { ...node.network, vertices: node.network.vertices.map(v => ({ ...v })), edges: node.network.edges.map(e => ({ ...e })) } : EMPTY, changed: false }
  const filled = node.fills.some(paint => paint.visible) && node.kind !== 'line'
  if (filled) {
    let shape: Point[][] = []
    try { shape = contours(node).filter(contour => contour.length >= 3) } catch { shape = [] }
    if (shape.length && brushHits(shape, samples, radius)) {
      const brush = brushContour(samples, radius)
      if (brush) {
        try {
          const loops = booleanContours([shape, [brush]], 'subtract')
          if (!loops.length) return { network: EMPTY, changed: true }
          const before = shape.reduce((sum, contour) => sum + Math.abs(area(contour)), 0)
          const after = loops.reduce((sum, contour) => sum + Math.abs(area(contour)), 0)
          const same = loops.length === shape.length && Math.abs(after - before) < Math.max(0.25, radius * radius * 0.02)
          if (!same) return { network: contoursToNetwork(loops), changed: true }
        } catch { /* fall through to the stroke cut */ }
      }
    }
  }
  try {
    return cutNetwork(editableNetwork(node), samples, radius)
  } catch {
    return null
  }
}
