import type { GpuNode, GpuScene, PathMesh } from './types'

const signatures = new WeakMap<GpuNode, string>()
const encode = (value: unknown) => JSON.stringify(value, (_key, v) => Object.is(v, -0) ? '-0' : v)
function signature(n: GpuNode) {
  let value = signatures.get(n)
  if (value) return value
  const path = (p: PathMesh) => ({ ...p, first: 0,
    area: p.area ? { ...p.area, first: 0 } : undefined,
    analytic: p.analytic ? { ...p.analytic, first: 0 } : undefined })
  const { previewSource: _source, previewDynamic: _dynamic, ...fields } = n
  value = encode({ ...fields, fill: path(n.fill), strokes: n.strokes.map(s => ({ ...s, path: path(s.path) })) })
  signatures.set(n, value); return value
}
const bits = (input: number[] | Float32Array) => {
  const array = input instanceof Float32Array ? input : new Float32Array(input)
  return new Uint32Array(array.buffer, array.byteOffset, array.length)
}
function pathEqual(a: PathMesh, b: PathMesh, old: { curves: Uint32Array; vertices: Uint32Array }, next: typeof old) {
  const span = (p: PathMesh, data: typeof old) => p.area
    ? data.curves.subarray(p.area.first * 4, (p.area.first + p.area.count) * 4)
    : p.analytic ? data.curves.subarray(p.analytic.first * 4, p.analytic.first * 4 + p.analytic.count * 16)
      : data.vertices.subarray(p.first * 2, (p.first + p.count) * 2)
  const aa = span(a, old), bb = span(b, next)
  return aa.length === bb.length && aa.every((value, i) => value === bb[i])
}
/** Preserve only bit-identical isolated paint sources after an exact compile.
 * Device coverage for moved nodes is rebuilt by Rust; no raster translation,
 * coordinate quantization or alpha ramp participates in this proof. */
export function reuseExactSceneSources(previous: GpuScene, next: GpuScene, translatedNodes?: ReadonlySet<string>): GpuScene {
  if(previous.interactionLease!==next.interactionLease)return next
  const policy = (s: GpuScene) => {
    const { nodes: _nodes, vertices: _vertices, curves: _curves, interactionWindow: _window, ...rest } = s
    return encode(Object.keys(rest).sort().map(key => [key, rest[key as keyof typeof rest]]))
  }
  if (policy(previous) !== policy(next)) return next
  const old = { curves: bits(previous.curves || []), vertices: bits(previous.vertices) }
  const fresh = { curves: bits(next.curves || []), vertices: bits(next.vertices) }
  const nodes = { ...next.nodes }
  for (const [id, n] of Object.entries(nodes)) {
    const before = previous.nodes[id]
    if (!before || n.previewDynamic || n.captureReplay || n.textureReplay || signature(before.previewSource || before) !== signature(n)) continue
    // Only the validated native transform entry may supply this closure. Rust
    // retained all other prepared paths/programs at this identical camera and
    // guard. A generic recompile still compares the complete program bits.
    const provenUnchanged = translatedNodes && !translatedNodes.has(id)
    if (!provenUnchanged && (!pathEqual(before.fill, n.fill, old, fresh) ||
      !n.strokes.every((s, i) => pathEqual(before.strokes[i].path, s.path, old, fresh)))) continue
    nodes[id] = { ...n, previewSource: before.previewSource || before }
  }
  return { ...next, nodes }
}
