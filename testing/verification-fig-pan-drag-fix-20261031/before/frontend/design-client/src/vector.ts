import { type Point, type Network, uid } from './model'
import {
  add,
  sub,
  scale,
  cross,
  dot,
  distance,
  lerp,
  pointInContours,
  area,
  edgePoints,
  strokeWalks,
} from './geometry'
export type BooleanOp = 'union' | 'subtract' | 'intersect' | 'exclude'
export function dashNetwork(g: Network, dash: string): Network {
  let pattern = dash.trim().split(/[ ,]+/).filter(Boolean).map(Number)
  if (!pattern.length) return g
  if (pattern.some((v) => !Number.isFinite(v) || v < 0)) throw new Error('虚线间距必须为非负数')
  if (pattern.every((v) => v === 0)) return g
  if (pattern.length % 2) pattern = [...pattern, ...pattern]
  const out: Network = { vertices: [], edges: [], fillRule: g.fillRule }
  const append = (ps: Point[]) => {
    if (ps.length < 2) return
    const vs = ps.map((p) => ({ ...p, id: uid() }))
    out.vertices.push(...vs)
    out.edges.push(...vs.slice(0, -1).map((v, i) => ({ id: uid(), from: v.id, to: vs[i + 1].id })))
    if (out.edges.length > 5000) throw new Error('虚线轮廓超过单次运算限制')
  }
  for (const walk of strokeWalks(g)) {
    const points = walk.edges.flatMap((h, i) =>
      edgePoints(g, h.edge, h.reverse, 0.15).slice(i ? 1 : 0),
    )
    let phase = 0,
      remaining = pattern[0],
      active: Point[] = []
    for (let i = 0; i < points.length - 1; i++) {
      let a = points[i]
      const b = points[i + 1]
      let length = distance(a, b)
      while (length > 1e-8) {
        while (remaining <= 1e-8) {
          if (phase % 2 === 0) {
            append(active)
            active = []
          }
          phase = (phase + 1) % pattern.length
          remaining = pattern[phase]
        }
        const take = Math.min(remaining, length),
          end = lerp(a, b, take / length)
        if (phase % 2 === 0) {
          if (!active.length) active.push(a)
          active.push(end)
        }
        a = end
        length -= take
        remaining -= take
      }
    }
    append(active)
  }
  return out
}
type Segment = { a: Point; b: Point; cuts: number[] }
// Planar arrangement: split intersections (including collinear overlap), classify both
// sides of each atomic edge, then trace oriented boundary loops. Curves are adaptively
// flattened by the caller; no third-party geometry or editor engine is used.
export function booleanContours(inputs: Point[][][], operation: BooleanOp): Point[][] {
  const segments: Segment[] = inputs
    .flatMap((cs) =>
      cs.flatMap((ps) => ps.map((a, i) => ({ a, b: ps[(i + 1) % ps.length], cuts: [0, 1] }))),
    )
    .filter((s) => distance(s.a, s.b) > 1e-8)
  if (segments.length > 6000) throw new Error('单次几何运算最多支持 6000 个离散边，请分批处理')
  const magnitude = Math.max(1, ...segments.flatMap((s) => [Math.abs(s.a.x), Math.abs(s.a.y)]))
  const epsilon = Math.max(1e-7, magnitude * 1e-10)
  const snap = epsilon * 4
  const push = (s: Segment, t: number) => {
    if (t >= -1e-9 && t <= 1 + 1e-9) s.cuts.push(Math.max(0, Math.min(1, t)))
  }
  for (let i = 0; i < segments.length; i++)
    for (let j = i + 1; j < segments.length; j++) {
      const a = segments[i],
        b = segments[j]
      if (
        Math.max(a.a.x, a.b.x) + epsilon < Math.min(b.a.x, b.b.x) ||
        Math.max(b.a.x, b.b.x) + epsilon < Math.min(a.a.x, a.b.x) ||
        Math.max(a.a.y, a.b.y) + epsilon < Math.min(b.a.y, b.b.y) ||
        Math.max(b.a.y, b.b.y) + epsilon < Math.min(a.a.y, a.b.y)
      )
        continue
      const r = sub(a.b, a.a),
        s = sub(b.b, b.a),
        q = sub(b.a, a.a),
        den = cross(r, s)
      const threshold = 1e-12 * Math.max(1, Math.hypot(r.x, r.y) * Math.hypot(s.x, s.y))
      if (Math.abs(den) > threshold) {
        const t = cross(q, s) / den,
          u = cross(q, r) / den
        if (t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) {
          push(a, t)
          push(b, u)
        }
      } else if (Math.abs(cross(q, r)) <= epsilon * Math.hypot(r.x, r.y)) {
        push(a, dot(sub(b.a, a.a), r) / dot(r, r))
        push(a, dot(sub(b.b, a.a), r) / dot(r, r))
        push(b, dot(sub(a.a, b.a), s) / dot(s, s))
        push(b, dot(sub(a.b, b.a), s) / dot(s, s))
      }
    }
  const filled = (p: Point) => {
    const bs = inputs.map((cs) => pointInContours(p, cs))
    switch (operation) {
      case 'union':
        return bs.some(Boolean)
      case 'intersect':
        return bs.every(Boolean)
      case 'subtract':
        return !!bs[0] && !bs.slice(1).some(Boolean)
      case 'exclude':
        return bs.filter(Boolean).length % 2 === 1
    }
  }
  const key = (p: Point) => `${Math.round(p.x / snap)},${Math.round(p.y / snap)}`
  const edges = new Map<string, { a: Point; b: Point; used: boolean }>()
  for (const s of segments) {
    const cuts = [...new Set(s.cuts)].sort((a, b) => a - b)
    for (let i = 0; i < cuts.length - 1; i++) {
      let a = lerp(s.a, s.b, cuts[i]),
        b = lerp(s.a, s.b, cuts[i + 1])
      const length = distance(a, b)
      if (length < epsilon) continue
      const middle = lerp(a, b, 0.5),
        normal = scale(
          { x: -(b.y - a.y), y: b.x - a.x },
          Math.min(length * 0.001, epsilon * 8) / length,
        )
      const left = filled(add(middle, normal)),
        right = filled(sub(middle, normal))
      if (left === right) continue
      if (!left) [a, b] = [b, a]
      edges.set(`${key(a)}>${key(b)}`, { a, b, used: false })
    }
  }
  const outgoing = new Map<string, typeof edges extends Map<string, infer V> ? V[] : never>()
  for (const edge of edges.values()) {
    const k = key(edge.a),
      list = outgoing.get(k) || []
    list.push(edge)
    outgoing.set(k, list)
  }
  const loops: Point[][] = []
  for (const start of edges.values()) {
    if (start.used) continue
    let current = start
    const ps: Point[] = []
    let closed = false
    for (let count = 0; count <= edges.size; count++) {
      if (current.used) break
      current.used = true
      ps.push(current.a)
      if (key(current.b) === key(start.a)) {
        closed = true
        break
      }
      const candidates = (outgoing.get(key(current.b)) || []).filter((e) => !e.used)
      if (!candidates.length) break
      const reverse = Math.atan2(current.a.y - current.b.y, current.a.x - current.b.x)
      candidates.sort(
        (a, b) =>
          ((reverse - Math.atan2(a.b.y - a.a.y, a.b.x - a.a.x) + Math.PI * 2) % (Math.PI * 2)) -
          ((reverse - Math.atan2(b.b.y - b.a.y, b.b.x - b.a.x) + Math.PI * 2) % (Math.PI * 2)),
      )
      current = candidates[0]
    }
    if (!closed) throw new Error('几何边界未闭合，原图层已保留')
    if (ps.length >= 3 && Math.abs(area(ps)) > epsilon * epsilon) loops.push(ps)
  }
  return loops
}
export function outlineNetwork(
  g: Network,
  width: number,
  cap: 'butt' | 'round' | 'square',
  join: 'miter' | 'round' | 'bevel',
): Point[][] {
  const shapes: Point[][][] = []
  const half = width / 2
  if (width <= 0) return []
  const circle = (p: Point) =>
    Array.from({ length: 24 }, (_, i) => ({
      x: p.x + Math.cos((i * Math.PI) / 12) * half,
      y: p.y + Math.sin((i * Math.PI) / 12) * half,
    }))
  const degree = new Map<string, number>()
  for (const e of g.edges) {
    degree.set(e.from, (degree.get(e.from) || 0) + 1)
    degree.set(e.to, (degree.get(e.to) || 0) + 1)
  }
  for (const e of g.edges) {
    const ps = edgePoints(g, e, false, 0.15)
    for (let i = 0; i < ps.length - 1; i++) {
      let a = ps[i],
        b = ps[i + 1]
      const length = distance(a, b)
      if (length < 1e-8) continue
      const tangent = scale(sub(b, a), 1 / length),
        normal = scale({ x: -tangent.y, y: tangent.x }, half)
      if (cap === 'square') {
        if (i === 0 && degree.get(e.from) === 1) a = sub(a, scale(tangent, half))
        if (i === ps.length - 2 && degree.get(e.to) === 1) b = add(b, scale(tangent, half))
      }
      shapes.push([[add(a, normal), add(b, normal), sub(b, normal), sub(a, normal)]])
      if (i > 0) shapes.push([circle(a)])
    }
  }
  for (const v of g.vertices) {
    const deg = degree.get(v.id) || 0
    if ((deg === 1 && cap === 'round') || (deg > 1 && join === 'round')) shapes.push([circle(v)])
    else if (deg > 1) {
      const normals: Point[] = []
      for (const e of g.edges.filter((e) => e.from === v.id || e.to === v.id)) {
        const ps = edgePoints(g, e, e.to === v.id)
        const tangent = sub(ps[1], ps[0])
        const len = Math.hypot(tangent.x, tangent.y) || 1
        normals.push(
          scale({ x: -tangent.y, y: tangent.x }, half / len),
          scale({ x: tangent.y, y: -tangent.x }, half / len),
        )
      }
      normals.sort((a, b) => Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x))
      let poly = normals.map((n) => add(v, n))
      if (join === 'miter' && normals.length === 4) {
        const extra: Point[] = []
        for (let i = 0; i < normals.length; i++) {
          const a = normals[i],
            b = normals[(i + 1) % normals.length],
            sum = add(a, b),
            den = dot(sum, a)
          if (den > 1e-8) {
            const m = scale(sum, (half * half) / den)
            if (Math.hypot(m.x, m.y) <= half * 4) extra.push(add(v, m))
          }
        }
        poly = [...poly, ...extra].sort(
          (a, b) => Math.atan2(a.y - v.y, a.x - v.x) - Math.atan2(b.y - v.y, b.x - v.x),
        )
      }
      shapes.push([poly])
    }
  }
  return booleanContours(shapes, 'union')
}
export function splitEdge(g: Network, id: string, t = 0.5): string {
  const edge = g.edges.find((e) => e.id === id)
  if (!edge) throw new Error('路径段不存在')
  const a = g.vertices.find((v) => v.id === edge.from)!,
    d = g.vertices.find((v) => v.id === edge.to)!
  const b = edge.c1 || a,
    c = edge.c2 || d
  const ab = lerp(a, b, t),
    bc = lerp(b, c, t),
    cd = lerp(c, d, t),
    abc = lerp(ab, bc, t),
    bcd = lerp(bc, cd, t),
    middle = lerp(abc, bcd, t)
  const v = { ...middle, id: uid() }
  g.vertices.push(v)
  const curved = !!(edge.c1 || edge.c2)
  g.edges = g.edges.filter((e) => e.id !== id)
  g.edges.push(
    { id: uid(), from: a.id, to: v.id, ...(curved ? { c1: ab, c2: abc } : {}) },
    { id: uid(), from: v.id, to: d.id, ...(curved ? { c1: bcd, c2: cd } : {}) },
  )
  return v.id
}
