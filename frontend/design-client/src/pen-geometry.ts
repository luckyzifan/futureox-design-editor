import { distance } from './geometry'
import { uid, type Edge, type Network, type Point } from './model'
import { splitEdge } from './vector'

/** On-canvas vector chrome uses the same selection blue as the rest of the
 * canvas outlines. Toolbar pills keep the workspace accent. */
export const PEN_BLUE = '#0d99ff'
export const PEN_HIT_PX = 8

export type PenDraft = {
  network: Network
  last: string | null
  first: string | null
  outgoing?: Point
  /** True after the path is closed onto its first point with at least a triangle. */
  closed?: boolean
}

export function constrainToAngles(origin: Point, point: Point, step = Math.PI / 4): Point {
  const dx = point.x - origin.x, dy = point.y - origin.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return { x: point.x, y: point.y }
  const angle = Math.round(Math.atan2(dy, dx) / step) * step
  return { x: origin.x + Math.cos(angle) * len, y: origin.y + Math.sin(angle) * len }
}

export function mirrorAcross(anchor: Point, handle: Point): Point {
  return { x: 2 * anchor.x - handle.x, y: 2 * anchor.y - handle.y }
}

export function penCurvePath(from: Point, outgoing: Point | undefined, to: Point): string {
  if (!outgoing) return `M${from.x} ${from.y} L${to.x} ${to.y}`
  return `M${from.x} ${from.y} C${outgoing.x} ${outgoing.y} ${to.x} ${to.y} ${to.x} ${to.y}`
}

type MirrorMode = 'none' | 'angle' | 'full'

function classifyMirror(anchor: Point, active: Point, opposite: Point): MirrorMode {
  const a = { x: active.x - anchor.x, y: active.y - anchor.y }
  const b = { x: opposite.x - anchor.x, y: opposite.y - anchor.y }
  const la = Math.hypot(a.x, a.y), lb = Math.hypot(b.x, b.y)
  if (la < 1e-6 || lb < 1e-6) return 'none'
  const cross = a.x * b.y - a.y * b.x
  const dot = a.x * b.x + a.y * b.y
  if (Math.abs(cross) > 1e-3 * la * lb || dot >= 0) return 'none'
  const ratio = la / lb
  return ratio > 0.98 && ratio < 1.02 ? 'full' : 'angle'
}

function oppositeControl(network: Network, anchorId: string, edgeId: string, control: 'c1' | 'c2') {
  for (const edge of network.edges) {
    if (edge.id === edgeId) continue
    if (edge.to === anchorId && edge.c2 && control === 'c1') return { edgeId: edge.id, control: 'c2' as const, point: edge.c2 }
    if (edge.from === anchorId && edge.c1 && control === 'c2') return { edgeId: edge.id, control: 'c1' as const, point: edge.c1 }
  }
  return null
}

/** Drag one cubic handle. Alt leaves the sister handle in place. Otherwise a
 * mirrored pair keeps mirror-angle-and-length, and a colinear pair keeps
 * mirror-angle. Shift is applied by the caller in world space. */
export function dragBezierHandle(original: Network, edgeId: string, control: 'c1' | 'c2', point: Point, alt: boolean): Network {
  const next = structuredClone(original)
  const edge = next.edges.find(item => item.id === edgeId)
  const source = original.edges.find(item => item.id === edgeId)
  if (!edge || !source) return next
  const anchorId = control === 'c1' ? edge.from : edge.to
  const anchor = next.vertices.find(vertex => vertex.id === anchorId)
  const sourceAnchor = original.vertices.find(vertex => vertex.id === anchorId)
  const sourceHandle = source[control]
  if (!anchor || !sourceAnchor) return next
  edge[control] = { x: point.x, y: point.y }
  if (alt || !sourceHandle) return next
  const opposite = oppositeControl(original, anchorId, edgeId, control)
  if (!opposite) return next
  const mode = classifyMirror(sourceAnchor, sourceHandle, opposite.point)
  if (mode === 'none') return next
  const mirrored = mirrorAcross(anchor, point)
  const target = next.edges.find(item => item.id === opposite.edgeId)
  if (!target) return next
  if (mode === 'full') {
    target[opposite.control] = mirrored
    return next
  }
  const length = Math.hypot(opposite.point.x - sourceAnchor.x, opposite.point.y - sourceAnchor.y)
  const dir = { x: mirrored.x - anchor.x, y: mirrored.y - anchor.y }
  const scale = length / (Math.hypot(dir.x, dir.y) || 1)
  target[opposite.control] = { x: anchor.x + dir.x * scale, y: anchor.y + dir.y * scale }
  return next
}

function nearestVertex(network: Network, point: Point, limit: number) {
  let best: Network['vertices'][number] | undefined
  let bestDistance = limit
  for (const vertex of network.vertices) {
    const delta = distance(vertex, point)
    if (delta <= bestDistance) { best = vertex; bestDistance = delta }
  }
  return best
}

function cubicAt(a: Point, b: Point, c: Point, d: Point, t: number): Point {
  const s = 1 - t
  return {
    x: s * s * s * a.x + 3 * s * s * t * b.x + 3 * s * t * t * c.x + t * t * t * d.x,
    y: s * s * s * a.y + 3 * s * s * t * b.y + 3 * s * t * t * c.y + t * t * t * d.y,
  }
}

export function penSegmentHit(network: Network, point: Point, limit: number): { edgeId: string; t: number } | null {
  let best: { edgeId: string; t: number; distance: number } | null = null
  for (const edge of network.edges) {
    const a = network.vertices.find(vertex => vertex.id === edge.from)
    const d = network.vertices.find(vertex => vertex.id === edge.to)
    if (!a || !d) continue
    const b = edge.c1 || a, c = edge.c2 || d
    const steps = 24
    let t = 0, found = Infinity
    for (let i = 0; i <= steps; i++) {
      const at = i / steps
      const delta = distance(cubicAt(a, b, c, d, at), point)
      if (delta < found) { found = delta; t = at }
    }
    let lo = Math.max(0, t - 1 / steps), hi = Math.min(1, t + 1 / steps)
    for (let i = 0; i < 16; i++) {
      const left = lo + (hi - lo) / 3, right = hi - (hi - lo) / 3
      if (distance(cubicAt(a, b, c, d, left), point) < distance(cubicAt(a, b, c, d, right), point)) hi = right
      else lo = left
    }
    t = (lo + hi) / 2
    const delta = distance(cubicAt(a, b, c, d, t), point)
    if (delta <= limit && (!best || delta < best.distance)) best = { edgeId: edge.id, t, distance: delta }
  }
  return best ? { edgeId: best.edgeId, t: best.t } : null
}

export function penHitsNetwork(network: Network, point: Point, limit: number) {
  return !!nearestVertex(network, point, limit) || !!penSegmentHit(network, point, limit * 0.75)
}

function handleAt(edge: Edge, id: string) {
  if (edge.from === id) return edge.c1
  if (edge.to === id) return edge.c2
  return undefined
}

/** Option-click removes a point. Two neighbors are joined; other degrees drop
 * the incident edges. The point itself is removed either way. */
export function deleteAndHealVertex(network: Network, vertexId: string): Network {
  const next = structuredClone(network)
  const incident = next.edges.filter(edge => edge.from === vertexId || edge.to === vertexId)
  if (incident.length === 2) {
    const [first, second] = incident
    const a = first.from === vertexId ? first.to : first.from
    const c = second.from === vertexId ? second.to : second.from
    next.edges = next.edges.filter(edge => edge !== first && edge !== second)
    if (a !== c && a !== vertexId && c !== vertexId) {
      const c1 = handleAt(first, a) || handleAt(second, a)
      const c2 = handleAt(first, c) || handleAt(second, c)
      next.edges.push({ id: uid(), from: a, to: c, ...(c1 ? { c1: { ...c1 } } : {}), ...(c2 ? { c2: { ...c2 } } : {}) })
    }
  } else {
    next.edges = next.edges.filter(edge => edge.from !== vertexId && edge.to !== vertexId)
  }
  next.vertices = next.vertices.filter(vertex => vertex.id !== vertexId)
  if (next.filledFaces) {
    const edges = new Set(next.edges.map(edge => edge.id))
    next.filledFaces = next.filledFaces.filter(face => face.every(id => edges.has(id)))
  }
  return next
}

function connect(draft: PenDraft, network: Network, vertexId: string) {
  let closed = !!draft.closed
  if (draft.last && draft.last !== vertexId && !network.edges.some(edge => edge.from === draft.last && edge.to === vertexId)) {
    network.edges.push({
      id: uid(), from: draft.last, to: vertexId,
      ...(draft.outgoing ? { c1: { x: draft.outgoing.x, y: draft.outgoing.y } } : {}),
    })
    if (vertexId === draft.first && draft.last !== draft.first && network.vertices.length >= 3) closed = true
  }
  return closed
}

/** Place, continue, insert, or Option-delete. Shift is already applied to `point`. */
export function penPointerDown(draft: PenDraft, point: Point, alt: boolean, hit: number): { draft: PenDraft; dragVertex: string | null; healed: boolean } {
  const network = structuredClone(draft.network)
  const near = nearestVertex(network, point, hit)
  if (alt && near) {
    const healed = deleteAndHealVertex(network, near.id)
    const still = (id: string | null) => !!id && healed.vertices.some(vertex => vertex.id === id)
    return {
      healed: true,
      dragVertex: null,
      draft: {
        network: healed,
        last: still(draft.last) && draft.last !== near.id ? draft.last : null,
        first: still(draft.first) && draft.first !== near.id ? draft.first : healed.vertices[0]?.id || null,
        closed: false,
      },
    }
  }
  if (near) {
    const closed = connect(draft, network, near.id)
    return { healed: false, dragVertex: near.id, draft: { network, last: near.id, first: draft.first || near.id, closed } }
  }
  const segment = penSegmentHit(network, point, hit * 0.75)
  if (segment && segment.t > 0.05 && segment.t < 0.95) {
    const vertexId = splitEdge(network, segment.edgeId, segment.t)
    const closed = connect(draft, network, vertexId)
    return { healed: false, dragVertex: vertexId, draft: { network, last: vertexId, first: draft.first || vertexId, closed } }
  }
  const vertex = { id: uid(), x: point.x, y: point.y }
  network.vertices.push(vertex)
  const closed = connect(draft, network, vertex.id)
  return { healed: false, dragVertex: vertex.id, draft: { network, last: vertex.id, first: draft.first || vertex.id, closed } }
}

/** A drag past the threshold sets the forward handle. Alt drops the incoming
 * mirror; returning inside the threshold keeps the last handle. */
export function penHandleMove<T extends PenDraft>(draft: T, vertexId: string, start: Point, point: Point, alt: boolean, shift: boolean, threshold: number): T {
  if (distance(point, start) <= threshold) return draft
  const next = structuredClone(draft)
  const vertex = next.network.vertices.find(item => item.id === vertexId)
  if (!vertex) return draft
  const handle = { x: vertex.x + point.x - start.x, y: vertex.y + point.y - start.y }
  const placed = shift ? constrainToAngles(vertex, handle) : handle
  next.outgoing = placed
  const previous = next.network.edges.find(edge => edge.to === vertexId)
  if (previous) {
    if (alt) delete previous.c2
    else previous.c2 = mirrorAcross(vertex, placed)
  }
  return next
}

export function popPenPoint<T extends PenDraft>(pen: T): T {
  const network = structuredClone(pen.network)
  let index = -1
  if (pen.last) for (let i = network.edges.length - 1; i >= 0; i--) if (network.edges[i].to === pen.last) { index = i; break }
  if (index >= 0) {
    const edge = network.edges[index]
    network.edges.splice(index, 1)
    const used = (id: string) => network.edges.some(item => item.from === id || item.to === id)
    if (pen.last && !used(pen.last)) network.vertices = network.vertices.filter(vertex => vertex.id !== pen.last)
    const first = pen.first && network.vertices.some(vertex => vertex.id === pen.first) ? pen.first : network.vertices[0]?.id || null
    return { ...pen, network, last: network.vertices.some(vertex => vertex.id === edge.from) ? edge.from : null, first, outgoing: undefined, closed: false }
  }
  if (network.vertices.length) {
    const id = pen.last || network.vertices.at(-1)!.id
    network.vertices = network.vertices.filter(vertex => vertex.id !== id)
    network.edges = network.edges.filter(edge => edge.from !== id && edge.to !== id)
    return { ...pen, network, last: null, first: null, outgoing: undefined, closed: false }
  }
  return { ...pen, network, last: null, first: null, outgoing: undefined, closed: false }
}

export function penAffordance(draft: PenDraft, point: Point, hit: number, alt: boolean): 'close' | 'insert' | 'delete' | null {
  const near = nearestVertex(draft.network, point, hit)
  if (near) {
    if (alt) return 'delete'
    if (draft.last && near.id !== draft.last) return 'close'
    return null
  }
  if (penSegmentHit(draft.network, point, hit * 0.75)) return 'insert'
  return null
}
