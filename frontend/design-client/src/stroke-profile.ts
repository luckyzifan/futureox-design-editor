import type { DesignNode, Stroke, WidthPoint } from './model'

export function profileTopology(n: DesignNode) {
  if (!n.network) return { branched: false, closed: n.kind !== 'line' }
  const degree = new Map<string, number>()
  const adjacency = new Map<string, string[]>()
  for (const e of n.network.edges)
    for (const id of [e.from, e.to]) degree.set(id, (degree.get(id) || 0) + 1)
  for (const e of n.network.edges) {
    adjacency.set(e.from, [...(adjacency.get(e.from) || []), e.to])
    adjacency.set(e.to, [...(adjacency.get(e.to) || []), e.from])
  }
  // A closed connected component can coexist with an open one.
  const seen = new Set<string>()
  let closed = false
  for (const id of degree.keys()) {
    if (seen.has(id)) continue
    const pending = [id]
    let cycle = true
    while (pending.length) {
      const at = pending.pop()!
      if (seen.has(at)) continue
      seen.add(at)
      if (degree.get(at) !== 2) cycle = false
      for (const next of adjacency.get(at) || []) if (!seen.has(next)) pending.push(next)
    }
    if (cycle) closed = true
  }
  return { branched: [...degree.values()].some((d) => d > 2), closed }
}
export function validStroke(s: Stroke): boolean {
  if (
    !s ||
    ![undefined, 'none', 'arrow', 'triangle', 'circle', 'diamond', 'square', 'bar'].includes(s.startMarker) ||
    ![undefined, 'none', 'arrow', 'triangle', 'circle', 'diamond', 'square', 'bar'].includes(s.endMarker) ||
    !Number.isFinite(s.width) ||
    s.width < 0 ||
    s.width > 10000 ||
    !Number.isFinite(s.dashOffset ?? 0) ||
    Math.abs(s.dashOffset ?? 0) > 1e7 ||
    !['center', 'inside', 'outside'].includes(s.align) ||
    !['butt', 'round', 'square'].includes(s.cap) ||
    !['round', 'miter', 'bevel'].includes(s.join) ||
    typeof s.dash !== 'string' ||
    s.dash.length > 1000 ||
    !/^[\d .,-]*$/.test(s.dash)
  )
    return false
  if (
    s.dash.length !== 0 && s.dash
      .split(/[\s,]+/)
      .filter(Boolean)
      .some((v) => {
        const n = Number(v)
        return !Number.isFinite(n) || n < 0 || n > 1e7 || (n > 0 && n < 1e-6)
      })
  )
    return false
  const ps = s.widthProfile
  return (
    ps === undefined ||
    (Array.isArray(ps) &&
      ps.length <= 512 &&
      ps.every(
        (p, i) =>
          p &&
          Number.isFinite(p.position) &&
          p.position >= 0 &&
          p.position <= 1 &&
          Number.isFinite(p.left) &&
          p.left >= 0 &&
          p.left <= 4 &&
          Number.isFinite(p.right) &&
          p.right >= 0 &&
          p.right <= 4 &&
          (i === 0 || p.position - ps[i - 1].position >= 1e-6),
      ))
  )
}
export function validProfiles(n: DesignNode): boolean {
  if (!n.strokes.some((s) => s.widthProfile?.length)) return true
  const { branched, closed } = profileTopology(n)
  if (branched || n.kind === 'text') return false
  return (
    !closed ||
    n.strokes.every((s) => {
      const ps = s.widthProfile
      if (!ps?.length) return true
      const a = ps[0],
        b = ps[ps.length - 1]
      return (
        a.position !== 0 ||
        b.position !== 1 ||
        (Math.abs(a.left - b.left) <= 1e-9 && Math.abs(a.right - b.right) <= 1e-9)
      )
    })
  )
}
export function profilePreset(name: string, closed: boolean): WidthPoint[] | undefined {
  const p = (position: number, left: number, right = left) => ({ position, left, right })
  if (name === 'spindle') return [p(0, 0), p(0.5, 1), p(1, 0)]
  if (name === 'wave') return [p(0, 0.35), p(0.25, 1.5), p(0.5, 0.35), p(0.75, 1.5), p(1, 0.35)]
  if (name === 'one-side') return [p(0, 0, 0), p(0.5, 2, 0), p(1, 0, 0)]
  if (name === 'taper' && !closed) return [p(0, 1), p(1, 0)]
  if (name === 'grow' && !closed) return [p(0, 0), p(1, 1)]
  if (name === 'custom') return [p(0, 1), p(0.5, 1), p(1, 1)]
  return undefined
}
export function maximumStrokeWidth(s: Stroke): number {
  return (
    s.width *
    (s.widthProfile?.length ? Math.max(...s.widthProfile.flatMap((p) => [p.left, p.right])) : 1)
  )
}
