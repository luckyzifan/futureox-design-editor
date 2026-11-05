import { multiply, inverse, apply, translate, rotate, around, matrixString, boxPoints, bounds, unionBounds } from './commands/affine'
import { maximumStrokeWidth } from './stroke-profile'
import { kernelBounds, kernelGeometryNetwork, kernelHit, kernelSvgPaths } from './kernel/picking'
import { documentTransition } from './document-patch'
import {
  type Point,
  type Matrix,
  type Bounds,
  type DesignDocument,
  type DesignNode,
  type Network,
  type Edge,
  identity,
  uid,
} from './model'
export const EPS = 1e-7
export const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y })
export const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y })
export const scale = (a: Point, k: number): Point => ({ x: a.x * k, y: a.y * k })
export const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x
export const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y
export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
export const lerp = (a: Point, b: Point, t: number) => add(a, scale(sub(b, a), t))
export { multiply, inverse, apply, translate, rotate, around, matrixString, boxPoints, bounds, unionBounds } from './commands/affine'
export const intersects = (a: Bounds, b: Bounds) =>
  a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y
export const contains = (b: Bounds, p: Point) =>
  p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height
export const polygonD = (points: Point[], closed = true) =>
  points.length ? `M${points.map((p) => `${p.x},${p.y}`).join(' L')}${closed ? ' Z' : ''}` : ''
export const area = (ps: Point[]) =>
  ps.reduce((s, p, i) => s + cross(p, ps[(i + 1) % ps.length]), 0) / 2
export function pointInContours(
  p: Point,
  contours: Point[][],
  rule: 'evenodd' | 'nonzero' = 'evenodd',
): boolean {
  let winding = 0
  for (const ps of contours)
    for (let i = 0; i < ps.length; i++) {
      const a = ps[i],
        b = ps[(i + 1) % ps.length]
      if (a.y <= p.y && b.y > p.y && cross(sub(b, a), sub(p, a)) > 0) winding++
      else if (a.y > p.y && b.y <= p.y && cross(sub(b, a), sub(p, a)) < 0) winding--
    }
  return rule === 'evenodd' ? Math.abs(winding) % 2 === 1 : winding !== 0
}
export function segmentDistance(p: Point, a: Point, b: Point): number {
  const v = sub(b, a)
  return distance(p, lerp(a, b, Math.max(0, Math.min(1, dot(sub(p, a), v) / (dot(v, v) || 1)))))
}
export function flattenCubic(
  a: Point,
  b: Point,
  c: Point,
  d: Point,
  tolerance = 0.2,
  depth = 0,
): Point[] {
  if (depth >= 14 || Math.max(segmentDistance(b, a, d), segmentDistance(c, a, d)) <= tolerance)
    return [a, d]
  const ab = lerp(a, b, 0.5),
    bc = lerp(b, c, 0.5),
    cd = lerp(c, d, 0.5),
    abc = lerp(ab, bc, 0.5),
    bcd = lerp(bc, cd, 0.5),
    mid = lerp(abc, bcd, 0.5)
  return [
    ...flattenCubic(a, ab, abc, mid, tolerance, depth + 1).slice(0, -1),
    ...flattenCubic(mid, bcd, cd, d, tolerance, depth + 1),
  ]
}
export type Walk = { edges: { edge: Edge; reverse: boolean }[]; closed: boolean }
export function networkWalks(g: Network): Walk[] {
  const vertices = new Map(g.vertices.map((v) => [v.id, v]))
  const incident = new Map<string, { edge: Edge; reverse: boolean }[]>()
  for (const e of g.edges) {
    if (!vertices.has(e.from) || !vertices.has(e.to)) continue
    for (const [id, reverse] of [
      [e.from, false],
      [e.to, true],
    ] as const) {
      const list = incident.get(id) || []
      list.push({ edge: e, reverse })
      incident.set(id, list)
    }
  }
  const angle = (h: { edge: Edge; reverse: boolean }) => {
    const e = h.edge
    const a = vertices.get(h.reverse ? e.to : e.from)!
    const b = (h.reverse ? e.c2 : e.c1) || vertices.get(h.reverse ? e.from : e.to)!
    return Math.atan2(b.y - a.y, b.x - a.x)
  }
  for (const list of incident.values()) list.sort((a, b) => angle(a) - angle(b))
  const visited = new Set<string>()
  const result: Walk[] = []
  for (const edge of g.edges)
    for (const reverse of [false, true]) {
      let h = { edge, reverse }
      const first = `${edge.id}:${reverse}`
      if (visited.has(first)) continue
      const walk: Walk = { edges: [], closed: false }
      for (let count = 0; count <= g.edges.length * 2; count++) {
        const key = `${h.edge.id}:${h.reverse}`
        if (visited.has(key)) {
          walk.closed = key === first
          break
        }
        visited.add(key)
        walk.edges.push(h)
        const end = h.reverse ? h.edge.from : h.edge.to
        const next = incident.get(end)!
        const i = next.findIndex((v) => v.edge.id === h.edge.id && v.reverse !== h.reverse)
        h = next[(i - 1 + next.length) % next.length]
      }
      if (walk.closed) {
        const ps = walkPoints(g, walk)
        const degree2 = walk.edges.every(
          (h) => incident.get(h.edge.from)?.length === 2 && incident.get(h.edge.to)?.length === 2,
        )
        if (
          area(ps) > EPS ||
          (degree2 &&
            Math.abs(area(ps)) <= EPS &&
            !result.some((w) => w.edges.some((h) => h.edge.id === edge.id)))
        )
          result.push(walk)
      }
    }
  return result
}
export function edgePoints(g: Network, e: Edge, reverse = false, tolerance = 0.2): Point[] {
  const a = g.vertices.find((v) => v.id === e.from)!,
    d = g.vertices.find((v) => v.id === e.to)!
  if (!a || !d) return []
  const ps = e.c1 || e.c2 ? flattenCubic(a, e.c1 || a, e.c2 || d, d, tolerance) : [a, d]
  return reverse ? ps.reverse() : ps
}
export function walkPoints(g: Network, w: Walk): Point[] {
  return w.edges.flatMap((h) => edgePoints(g, h.edge, h.reverse).slice(0, -1))
}
export function edgeD(g: Network, e: Edge, reverse = false, move = true): string {
  const a = g.vertices.find((v) => v.id === (reverse ? e.to : e.from))!,
    d = g.vertices.find((v) => v.id === (reverse ? e.from : e.to))!
  if (!a || !d) return ''
  const c1 = (reverse ? e.c2 : e.c1) || a,
    c2 = (reverse ? e.c1 : e.c2) || d
  return `${move ? `M${a.x},${a.y} ` : ''}${e.c1 || e.c2 ? `C${c1.x},${c1.y} ${c2.x},${c2.y} ${d.x},${d.y}` : `L${d.x},${d.y}`} `
}
export function strokeWalks(g: Network): Walk[] {
  const incident = new Map<string, Edge[]>()
  for (const edge of g.edges)
    for (const id of [edge.from, edge.to]) {
      const es = incident.get(id) || []
      es.push(edge)
      incident.set(id, es)
    }
  const used = new Set<string>(),
    result: Walk[] = []
  const walk = (edge: Edge, start: string) => {
    const edges: Walk['edges'] = []
    let current = edge,
      at = start
    while (!used.has(current.id)) {
      used.add(current.id)
      const reverse = current.to === at
      edges.push({ edge: current, reverse })
      at = reverse ? current.from : current.to
      const next = (incident.get(at) || []).filter((e) => !used.has(e.id))
      if (at === start || incident.get(at)?.length !== 2 || !next.length) break
      current = next[0]
    }
    result.push({ edges, closed: at === start })
  }
  for (const [id, es] of incident)
    if (es.length !== 2) for (const edge of es) if (!used.has(edge.id)) walk(edge, id)
  for (const edge of g.edges) if (!used.has(edge.id)) walk(edge, edge.from)
  return result
}
function filledWalks(g:Network) {
  return networkWalks(g).filter(w=>g.filledFaces===undefined || g.filledFaces.some(f=>JSON.stringify([...new Set(f)].sort())===JSON.stringify([...new Set(w.edges.map(h=>h.edge.id))].sort())))
}
export function networkD(g: Network, fill = false): string {
  return fill
    ? filledWalks(g)
        .map((w) => w.edges.map((h, i) => edgeD(g, h.edge, h.reverse, i === 0)).join('') + 'Z')
        .join(' ')
    : strokeWalks(g)
        .map(
          (w) =>
            w.edges.map((h, i) => edgeD(g, h.edge, h.reverse, i === 0)).join('') +
            (w.closed ? 'Z' : ''),
        )
        .join(' ')
}
export function primitivePoints(n: DesignNode): Point[] {
  const w = n.width,
    h = n.height
  if (n.kind === 'ellipse')
    return Array.from({ length: 96 }, (_, i) => ({
      x: w / 2 + (Math.cos((i * Math.PI) / 48) * w) / 2,
      y: h / 2 + (Math.sin((i * Math.PI) / 48) * h) / 2,
    }))
  if (n.kind === 'polygon' || n.kind === 'star') {
    const count = n.points * (n.kind === 'star' ? 2 : 1)
    return Array.from({ length: count }, (_, i) => {
      const r = n.kind === 'star' && i % 2 ? n.innerRadius : 1
      const a = (i * Math.PI * 2) / count - Math.PI / 2
      return { x: w / 2 + ((Math.cos(a) * w) / 2) * r, y: h / 2 + ((Math.sin(a) * h) / 2) * r }
    })
  }
  if (n.kind === 'line')
    return [
      { x: 0, y: 0 },
      { x: w, y: h },
    ]
  const r = n.radii.map((v) => Math.max(0, Math.min(v, w / 2, h / 2)))
  const power = 2 + n.smoothing * 3
  const centers = [
    { x: w - r[1], y: r[1] },
    { x: w - r[2], y: h - r[2] },
    { x: r[3], y: h - r[3] },
    { x: r[0], y: r[0] },
  ]
  const radii = [r[1], r[2], r[3], r[0]]
  return centers.flatMap((p, i) =>
    Array.from({ length: radii[i] > 0 ? 13 : 1 }, (_, j) => {
      const a = (-0.5 + i * 0.5 + (j / 12) * 0.5) * Math.PI
      return {
        x: p.x + radii[i] * Math.sign(Math.cos(a)) * Math.abs(Math.cos(a)) ** (2 / power),
        y: p.y + radii[i] * Math.sign(Math.sin(a)) * Math.abs(Math.sin(a)) ** (2 / power),
      }
    }),
  )
}
export function shapeD(n: DesignNode, fill = false): string {
  if(n.vectorGeometry){const paths=kernelSvgPaths(n);if(!paths)throw Error('矢量内核尚未就绪');return fill?paths.fill:paths.stroke}
  return n.network ? networkD(n.network, fill) : polygonD(primitivePoints(n), n.kind !== 'line')
}
export function contours(n: DesignNode): Point[][] {
  return n.network
    ? filledWalks(n.network).map((w) => walkPoints(n.network!, w))
    : n.kind === 'line'
      ? []
      : [primitivePoints(n)]
}
export function toNetwork(n: DesignNode): Network {
  if (n.network) return structuredClone(n.network)
  if (n.vectorGeometry) return kernelGeometryNetwork(n.vectorGeometry)
  const ps = primitivePoints(n),
    vertices = ps.map((p) => ({ ...p, id: uid() }))
  return {
    vertices,
    edges: vertices
      .slice(0, n.kind === 'line' ? -1 : undefined)
      .map((v, i) => ({ id: uid(), from: v.id, to: vertices[(i + 1) % vertices.length].id })),
    fillRule: 'evenodd',
  }
}
export function contoursToNetwork(cs: Point[][]): Network {
  const g: Network = { vertices: [], edges: [], fillRule: 'evenodd' }
  for (const ps of cs) {
    const vs = ps.map((p) => ({ ...p, id: uid() }))
    g.vertices.push(...vs)
    g.edges.push(...vs.map((v, i) => ({ id: uid(), from: v.id, to: vs[(i + 1) % vs.length].id })))
  }
  return g
}
export type SceneEntry = {
  id: string
  parent: string
  matrix: Matrix
  bounds: Bounds
  hitBounds?: Bounds
  depth: number
  ancestors: string[]
  locked: boolean
}
export function scene(d: DesignDocument, pageId: string, roots?: ReadonlySet<string>): SceneEntry[] {
  const result: SceneEntry[] = []
  const page = d.pages.find((p) => p.id === pageId)
  if (!page) return result
  const visit = (id: string, parent: string, m: Matrix, ancestors: string[], locked: boolean) => {
    const n = d.nodes[id]
    if (!n || !n.visible) return
    const wm = multiply(m, n.transform)
    const localPoints = n.network
      ? [
          ...n.network.vertices,
          ...n.network.edges.flatMap((e) => [e.c1, e.c2].filter((p): p is Point => !!p)),
        ]
      : boxPoints({ x: 0, y: 0, width: n.width, height: n.height })
    const b =
      ((n.network||n.vectorGeometry||n.textPath||n.pathOffset) ? kernelBounds(n, wm) : null) || bounds((localPoints.length ? localPoints : [{x:0,y:0}]).map((p) => apply(wm, p)))
    const padding =
      Math.max(0, ...n.strokes.filter((s) => s.visible).map(maximumStrokeWidth)) *
      4 *
      Math.hypot(wm[0], wm[1], wm[2], wm[3])
    const entry: SceneEntry = {
      hitBounds: {
        x: b.x - padding,
        y: b.y - padding,
        width: b.width + 2 * padding,
        height: b.height + 2 * padding,
      },
      id,
      parent,
      matrix: wm,
      bounds: b,
      depth: ancestors.length,
      ancestors,
      locked: locked || n.locked,
    }
    result.push(entry)
    const childBounds: Bounds[] = []
    n.children.forEach((c) => {
      const start = result.length
      visit(c, id, wm, [...ancestors, id], locked || n.locked)
      if (result.length > start) childBounds.push(result[start].bounds)
    })
    if (n.kind === 'group' && n.children.length) {
      if (childBounds.length) entry.bounds = unionBounds(childBounds)
    }
  }
  page.children.forEach((id) => { if (!roots || roots.has(id)) visit(id, page.id, identity(), [], false) })
  return result
}
/** Read-only topology shared within an immutable snapshot or one operation.
 * allParents deliberately stays fresh for callers working on mutable drafts. */
export type ParentMap = ReadonlyMap<string, string>
const parentMaps = new WeakMap<DesignDocument, Map<string, string>>()
function buildParents(d: DesignDocument): Map<string, string> {
  const map = new Map<string, string>()
  d.pages.forEach((p) => p.children.forEach((c) => map.set(c, p.id)))
  Object.values(d.nodes).forEach((n) => n.children.forEach((c) => map.set(c, n.id)))
  return map
}
function parentRoot(d: DesignDocument): DesignDocument {
  let cursor = d
  for (let hop = 0; hop < 32; hop++) {
    const link = documentTransition(cursor)
    if (!link || link.structural) return cursor
    cursor = link.before
  }
  return cursor
}
export function allParents(d: DesignDocument): Map<string, string> {
  const cached = parentMaps.get(d)
  if (cached) return cached
  const root = parentRoot(d)
  // Only witnessed immutable snapshots share a map. A draft mutated between
  // calls must observe the latest children arrays, so it never enters this cache.
  if (root !== d || documentTransition(d)) {
    let map = parentMaps.get(root)
    if (!map) {
      map = buildParents(root)
      parentMaps.set(root, map)
    }
    if (root !== d) parentMaps.set(d, map)
    return map
  }
  return buildParents(d)
}
export function worldMatrix(d: DesignDocument, id: string, parents: ParentMap = allParents(d)): Matrix {
  const n = d.nodes[id]
  if (!n) return identity()
  const parent = parents.get(id)
  return parent && d.nodes[parent]
    ? multiply(worldMatrix(d, parent, parents), n.transform)
    : n.transform
}
export function preciseHit(n: DesignNode, p: Point, tolerance: number): boolean {
  if(n.vectorGeometry)return kernelHit(n,p,tolerance)
  if (n.kind === 'text' || n.kind === 'frame' || n.kind === 'section')
    return contains({ x: 0, y: 0, width: n.width, height: n.height }, p)
  if (n.fills.some((f) => f.visible) && pointInContours(p, contours(n), n.network?.fillRule))
    return true
  const paths = n.network
    ? n.network.edges.map((e) => edgePoints(n.network!, e))
    : [n.kind === 'line' ? primitivePoints(n) : [...primitivePoints(n), primitivePoints(n)[0]]]
  const width = Math.max(0, ...n.strokes.filter((s) => s.visible).map((s) => s.width))
  if (!width) return false
  return paths.some((ps) =>
    ps.some(
      (a, i) => i < ps.length - 1 && segmentDistance(p, a, ps[i + 1]) <= width / 2 + tolerance,
    ),
  )
}
function boundedCellRange(b: Bounds, limit: number) {
  if (
    ![b.x, b.y, b.width, b.height].every(Number.isFinite) ||
    b.width < 0 ||
    b.height < 0
  )
    return null
  const x = Math.floor(b.x / 256),
    right = Math.floor((b.x + b.width) / 256),
    y = Math.floor(b.y / 256),
    bottom = Math.floor((b.y + b.height) / 256)
  // Finite composed transforms can exceed integer precision even when a tiny
  // shape rounds to a single cell. Iterating that world cell with x++ can stall.
  if (![x, right, y, bottom].every(Number.isSafeInteger)) return null
  const width = right - x + 1,
    height = bottom - y + 1
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > limit ||
    height > limit ||
    width * height > limit
  )
    return null
  return { x, y, width, height }
}
export class SpatialIndex<T extends Pick<SceneEntry, 'id'|'bounds'|'hitBounds'> = SceneEntry> {
  private cells = new Map<string, T[]>()
  private large: T[] = []
  private ranks = new Map<string, number>()
  constructor(public entries: T[], previous?: SpatialIndex<T>) {
    if (previous) {
      this.cells = new Map(previous.cells)
      this.large = previous.large.slice()
      const next = new Map(entries.map((entry,i) => { this.ranks.set(entry.id,i); return [entry.id,entry] }))
      const touched = new Set<string>()
      const update = (entry:T, add:boolean) => {
        const range = boundedCellRange(entry.hitBounds || entry.bounds,256)
        if (!range) { if (add) this.large.push(entry); else this.large = this.large.filter(e => e !== entry); return }
        for(let x=0;x<range.width;x++)for(let y=0;y<range.height;y++) {
          const key = `${range.x+x},${range.y+y}`
          if (!touched.has(key)) { this.cells.set(key,(this.cells.get(key)||[]).slice()); touched.add(key) }
          const cell = this.cells.get(key)!
          if(add)cell.push(entry);else {const index=cell.indexOf(entry);if(index>=0)cell.splice(index,1)}
        }
      }
      for(const entry of previous.entries)if(next.get(entry.id)!==entry)update(entry,false)
      for(const entry of entries)if(previous.entries[previous.ranks.get(entry.id)??-1]!==entry)update(entry,true)
      for(const key of touched)if(!this.cells.get(key)!.length)this.cells.delete(key)
      return
    }
    entries.forEach((e, i) => {
      this.ranks.set(e.id, i)
      const range = boundedCellRange(e.hitBounds || e.bounds, 256)
      if (!range) {
        this.large.push(e)
        return
      }
      for (let x = 0; x < range.width; x++)
        for (let y = 0; y < range.height; y++) {
          const key = `${range.x + x},${range.y + y}`
          const cell = this.cells.get(key) || []
          cell.push(e)
          this.cells.set(key, cell)
        }
    })
  }
  query(b: Bounds): T[] {
    const found = new Map<string, T>()
    const range = boundedCellRange(b, 4096)
    if (!range)
      return this.entries.filter((e) => intersects(e.hitBounds || e.bounds, b))
    for (let x = 0; x < range.width; x++)
      for (let y = 0; y < range.height; y++)
        for (const e of this.cells.get(`${range.x + x},${range.y + y}`) || [])
          if (intersects(e.hitBounds || e.bounds, b)) found.set(e.id, e)
    for (const e of this.large) if (intersects(e.hitBounds || e.bounds, b)) found.set(e.id, e)
    return [...found.values()].sort((a, b) => this.ranks.get(a.id)! - this.ranks.get(b.id)!)
  }
}
