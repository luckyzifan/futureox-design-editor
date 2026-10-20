import type { DesignNode, Network } from './model'
export type VectorBrush = {
  source: Network
  mode: 'stretch' | 'scatter'
  width: number
  spacing: number
  seed: number
  rotation: number
  rotationVariance: number
  scaleVariance: number
  scatter: number
  followTangent: boolean
}
export function defaultVectorBrush(source: Network): VectorBrush {
  return { source: structuredClone(source), mode: 'scatter', width: 16, spacing: 24, seed: 1, rotation: 0, rotationVariance: 0, scaleVariance: 0, scatter: 0, followTangent: true }
}
export function validateVectorBrush(node: DesignNode) {
  const b = node.vectorBrush
  if (!b) throw new Error('矢量笔刷数据无效')
  if (node.kind !== 'vector' || !node.network || node.pathOffset || node.booleanOperation || node.children.length) throw new Error('矢量笔刷需要独立矢量路径，不支持偏移或布尔结果')
  if (Object.keys(b).some(k => !['source', 'mode', 'width', 'spacing', 'seed', 'rotation', 'rotationVariance', 'scaleVariance', 'scatter', 'followTangent'].includes(k)) || !['stretch', 'scatter'].includes(b.mode) || typeof b.followTangent !== 'boolean' || !Number.isInteger(b.seed) || b.seed < 0 || b.seed > 4294967295) throw new Error('矢量笔刷模式或随机种子无效')
  if (node.network.fillRule !== 'nonzero' || b.source?.fillRule !== 'nonzero') throw new Error('矢量笔刷需要非零填充规则')
  const bounds = [[b.width, .001, 10000], [b.spacing, .001, 1e7], [b.rotation, -Math.PI * 2, Math.PI * 2], [b.rotationVariance, 0, Math.PI * 2], [b.scaleVariance, 0, .99], [b.scatter, 0, 10000]]
  if (bounds.some(([v, min, max]) => !Number.isFinite(v) || v < min || v > max)) throw new Error('矢量笔刷参数超出范围')
  for (const network of [node.network, b.source]) {
    if (!network || !Array.isArray(network.vertices) || !Array.isArray(network.edges) || network.vertices.length > 4096 || network.edges.length > 4096 || !['nonzero', 'evenodd'].includes(network.fillRule)) throw new Error('矢量笔刷网络超出范围')
    const vertices = new Set<string>(), edges = new Set<string>()
    for (const p of network.vertices) {
      if (!p || typeof p.id !== 'string' || !p.id || vertices.has(p.id) || ![p.x, p.y].every(v => Number.isFinite(v) && Math.abs(v) <= 1e7)) throw new Error('矢量笔刷顶点无效')
      vertices.add(p.id)
    }
    for (const e of network.edges) {
      if (!e || typeof e.id !== 'string' || !e.id || edges.has(e.id) || !vertices.has(e.from) || !vertices.has(e.to) || [e.c1, e.c2].some(p => p != null && ![p.x, p.y].every(v => Number.isFinite(v) && Math.abs(v) <= 1e7))) throw new Error('矢量笔刷边无效')
      edges.add(e.id)
    }
    if (network.filledFaces !== undefined && (!Array.isArray(network.filledFaces) || network.filledFaces.length > 4096 || network.filledFaces.some(f => !Array.isArray(f) || f.length > 4096 || f.some(e => !edges.has(e))))) throw new Error('矢量笔刷填充区域无效')
  }
}
