import { cloneValue } from './draft'
import { geometry_json } from './generated/design-kernel/design_kernel'
import { allParents, apply, bounds, inverse, worldMatrix } from './geometry'
import { node, type DesignDocument, type DesignNode, type Network } from './model'

export type ShapeBuilderMode = 'merge' | 'erase'
export interface ShapeBuilderRegion { id: string; sources: number[]; network: Network }
export interface ShapeBuilderResponse { regions: ShapeBuilderRegion[]; networks: Network[] }
export interface ShapeBuilderPreview {
  ids: string[]; parent: string; position: number; nodes: DesignNode[]; regions: ShapeBuilderRegion[]
  /** Revision-independent content fence also used inside atomic MCP batches. */
  fingerprint: string
}
const fail = (message: string): never => { throw new Error(message) }
function inputs(doc: DesignDocument, ids: string[]) {
  if (!ids.length || ids.length > 16 || new Set(ids).size !== ids.length) fail('请选择 1–16 个不重复的闭合形状')
  const parents = allParents(doc), parent = parents.get(ids[0])
  if (!parent || ids.some(id => !doc.nodes[id] || parents.get(id) !== parent)) fail('形状构建需要同一容器中的图层')
  const siblings = doc.nodes[parent!]?.children || doc.pages.find(p => p.id === parent)!.children
  const ordered = [...ids].sort((a,b) => siblings.indexOf(a)-siblings.indexOf(b))
  if (siblings.some(id => doc.nodes[id].mask)) fail('请先将蒙版内容转换为独立矢量')
  for (const id of ordered) {
    const n = doc.nodes[id]
    if (!['rectangle','ellipse','polygon','star','vector'].includes(n.kind) || n.children.length || n.booleanOperation || n.repeat || n.mask || n.maskType || (n as DesignNode & { vectorBrush?: unknown }).vectorBrush) fail('仅支持未蒙版的闭合形状；请先烘焙布尔或画笔路径')
    if (n.strokes.some(s => s.visible && s.width > 0)) fail('请先将可见描边转换为轮廓')
    if (n.pathOffset || n.effects.some(e => e.visible)) fail('请先烘焙路径偏移或效果')
    if (n.fills.some(p => p.visible && p.kind !== 'solid') || !n.fills.some(p => p.visible)) fail('当前形状构建支持纯色填充')
    let at: string | undefined = id
    while (at && doc.nodes[at]) {
      const ancestor: DesignNode = doc.nodes[at]
      if (ancestor.locked || !ancestor.visible || ancestor.mask || (at !== id && (ancestor.clip || ancestor.instance || ancestor.repeat))) fail('锁定、隐藏、裁切或实例内容无法直接构建')
      at = parents.get(at)
    }
  }
  const nodes = ordered.map(id => ({ ...doc.nodes[id], transform: worldMatrix(doc,id,parents) }))
  const fingerprint = JSON.stringify({ parent, siblings, nodes, parentTransform: worldMatrix(doc,parent!,parents) })
  return { ids: ordered, parent: parent!, position: Math.min(...ordered.map(id => siblings.indexOf(id))), nodes, fingerprint }
}
function kernel(nodes: DesignNode[], mode: 'partition' | ShapeBuilderMode, regionIds: string[] = []): ShapeBuilderResponse {
  return JSON.parse(geometry_json(JSON.stringify({ operation: 'shape-builder', nodes, mode, regionIds }))) as ShapeBuilderResponse
}
export function previewShapeBuilder(doc: DesignDocument, ids: string[]): ShapeBuilderPreview {
  const prepared = inputs(doc,ids)
  return { ...prepared, regions: kernel(prepared.nodes,'partition').regions }
}
/** Applies a complete region gesture to an isolated document draft. No history,
 * I/O, renderer or secondary mutation: callers own the single atomic commit. */
export function applyShapeBuilder(doc: DesignDocument, preview: ShapeBuilderPreview, regionIds: string[], mode: ShapeBuilderMode): string[] {
  const current = inputs(doc,preview.ids)
  if (current.fingerprint !== preview.fingerprint) fail('形状构建预览已过期，请重新打开')
  if (!['merge','erase'].includes(mode)) fail('未知形状构建操作')
  const selected = new Set(regionIds)
  if (!selected.size || selected.size !== regionIds.length || regionIds.some(id => !preview.regions.some(r => r.id === id))) fail('请选择有效区域')
  const result = kernel(current.nodes,mode,regionIds)
  const styles = result.regions.filter(r => !selected.has(r.id)).map(r => Math.max(...r.sources))
  if (mode === 'merge') styles.push(Math.max(...result.regions.filter(r => selected.has(r.id)).flatMap(r => r.sources)))
  const toParent = inverse(worldMatrix(doc,current.parent))
  const replacements = result.networks.map((network,index) => {
    const source = current.nodes[styles[index]], n = node('vector',0,0,1,1)
    const transformed: Network = { ...network, vertices: network.vertices.map(v => ({ ...v, ...apply(toParent,v) })),
      edges: network.edges.map(e => ({ ...e, ...(e.c1 ? {c1:apply(toParent,e.c1)} : {}), ...(e.c2 ? {c2:apply(toParent,e.c2)} : {}) })) }
    const box = bounds([...transformed.vertices, ...transformed.edges.flatMap(e => [e.c1,e.c2].filter((p): p is NonNullable<typeof p> => !!p))])
    n.name = mode === 'merge' && index === result.networks.length-1 ? '合并区域' : '构建区域'
    n.width = Math.max(.01,box.width); n.height = Math.max(.01,box.height)
    n.transform = [1,0,0,1,box.x,box.y]
    const local = (p: {x:number;y:number}) => ({x:p.x-box.x,y:p.y-box.y})
    n.network = { ...transformed, vertices: transformed.vertices.map(v => ({ ...v,...local(v) })), edges: transformed.edges.map(e => ({ ...e,...(e.c1?{c1:local(e.c1)}:{}),...(e.c2?{c2:local(e.c2)}:{}) })) }
    n.fills = cloneValue(source.fills); n.strokes = []; n.opacity = source.opacity; n.blend = source.blend
    return n
  })
  const siblings = doc.nodes[current.parent]?.children || doc.pages.find(p => p.id === current.parent)!.children
  const keep = siblings.filter(id => !current.ids.includes(id)); keep.splice(current.position,0,...replacements.map(n => n.id))
  siblings.splice(0,siblings.length,...keep)
  for (const id of current.ids) delete doc.nodes[id]
  for (const n of replacements) doc.nodes[n.id] = n
  return replacements.map(n => n.id)
}
