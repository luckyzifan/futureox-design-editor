// GPU 实例化批渲染优化 - 路径指纹识别与批量合并
// 目标：减少 draw call，提升 GPU 并行度

import type { GpuNode, PathMesh } from './types'

/** 路径几何指纹 - 用于识别可批量处理的相似路径 */
export interface PathFingerprint {
  /** 路径类型（矩形/圆角矩形/多边形/自由路径） */
  type: 'rect' | 'rounded-rect' | 'polygon' | 'path'
  /** 顶点数量 */
  vertexCount: number
  /** 曲线段数量 */
  curveCount: number
  /** 填充规则 */
  rule: 'evenodd' | 'nonzero' | 'union'
  /** 是否为解析几何（可快速批处理） */
  analytic: boolean
  /** 几何哈希（粗粒度，用于快速分组） */
  geometryHash: number
}

/** 批处理组 - 相似路径的实例集合 */
export interface PathBatchGroup {
  fingerprint: PathFingerprint
  instances: PathInstance[]
  /** 共享的几何数据（顶点/曲线） */
  sharedGeometry?: {
    vertices: Float32Array
    curves: Float32Array
  }
}

/** 单个路径实例 */
export interface PathInstance {
  node: GpuNode
  /** 实例变换矩阵 */
  transform: Float32Array  // 6 floats: [a, b, c, d, tx, ty]
  /** 填充颜色（RGBA） */
  color: Float32Array  // 4 floats
  /** 目标矩形 */
  rect: { x: number; y: number; w: number; h: number }
}

const MAX_BATCH_INSTANCES = 512  // 单个批次最大实例数

/** 从路径生成指纹 */
export function generatePathFingerprint(path: PathMesh): PathFingerprint {
  let geometryHash = 2166136261  // FNV-1a 初始值

  // 简单哈希：顶点数 + 曲线数 + 规则
  geometryHash = (geometryHash ^ path.count) * 16777619
  if (path.analytic) geometryHash = (geometryHash ^ path.analytic.count) * 16777619
  if (path.area) geometryHash = (geometryHash ^ path.area.count) * 16777619

  return {
    type: path.analyticRect ? 'rect' :
          (path.analytic && path.analytic.count < 8) ? 'rounded-rect' :
          path.count < 12 ? 'polygon' : 'path',
    vertexCount: path.count,
    curveCount: path.analytic?.count ?? path.area?.count ?? 0,
    rule: path.rule,
    analytic: !!(path.analytic || path.analyticRect || path.area),
    geometryHash: geometryHash >>> 0,
  }
}

/** 判断两个指纹是否匹配（可批量处理） */
export function matchesFingerprint(a: PathFingerprint, b: PathFingerprint): boolean {
  return a.type === b.type &&
         a.vertexCount === b.vertexCount &&
         a.curveCount === b.curveCount &&
         a.rule === b.rule &&
         a.analytic === b.analytic &&
         a.geometryHash === b.geometryHash
}

/** 将节点列表组织为批处理组 */
export function organizeBatches(nodes: GpuNode[]): PathBatchGroup[] {
  const groups = new Map<string, PathBatchGroup>()

  for (const node of nodes) {
    // 只批处理简单节点
    if (node.opacity !== 1 || node.blend !== 'normal' || node.children.length ||
        node.strokes.length || node.effects.length || node.mask || node.passthrough) {
      continue
    }

    if (node.fills.length !== 1) continue
    const fill = node.fills[0]
    if (!fill.visible || fill.opacity !== 1 || fill.blend !== 'normal') continue

    // 目前只批处理纯色填充（后续可扩展到简单渐变）
    if (fill.kind !== 'solid') continue

    const fingerprint = generatePathFingerprint(node.fill)
    const key = `${fingerprint.type}-${fingerprint.geometryHash}`

    let group = groups.get(key)
    if (!group) {
      group = { fingerprint, instances: [] }
      groups.set(key, group)
    }

    // 避免单个批次过大
    if (group.instances.length >= MAX_BATCH_INSTANCES) {
      // 创建新组（后缀序号）
      let suffix = 1
      let newKey = `${key}-${suffix}`
      while (groups.has(newKey) && groups.get(newKey)!.instances.length >= MAX_BATCH_INSTANCES) {
        suffix++
        newKey = `${key}-${suffix}`
      }
      group = groups.get(newKey) ?? { fingerprint, instances: [] }
      groups.set(newKey, group)
    }

    // 提取实例数据
    const transform = new Float32Array(node.matrix)
    const hex = fill.color
    const r = parseInt(hex.slice(1, 3), 16) / 255
    const g = parseInt(hex.slice(3, 5), 16) / 255
    const b = parseInt(hex.slice(5, 7), 16) / 255
    const color = new Float32Array([r, g, b, 1.0])

    group.instances.push({
      node,
      transform,
      color,
      rect: node.rect,
    })
  }

  // 过滤：只返回至少有 8 个实例的批次（批处理开销权衡）
  return Array.from(groups.values()).filter(g => g.instances.length >= 8)
}

/** 编码批处理实例数据为 GPU buffer 格式 */
export function encodeBatchInstances(group: PathBatchGroup): Float32Array {
  const floatsPerInstance = 16  // transform(6) + color(4) + rect(4) + padding(2)
  const data = new Float32Array(group.instances.length * floatsPerInstance)

  for (let i = 0; i < group.instances.length; i++) {
    const inst = group.instances[i]
    const offset = i * floatsPerInstance

    // Transform matrix (6 floats)
    data.set(inst.transform, offset)

    // Color (4 floats)
    data.set(inst.color, offset + 6)

    // Rect (4 floats)
    data[offset + 10] = inst.rect.x
    data[offset + 11] = inst.rect.y
    data[offset + 12] = inst.rect.w
    data[offset + 13] = inst.rect.h

    // Padding for alignment
    data[offset + 14] = 0
    data[offset + 15] = 0
  }

  return data
}

/** 预估批处理收益（节省的 draw call 数） */
export function estimateBatchingSavings(nodes: GpuNode[]): {
  totalNodes: number
  batchableNodes: number
  estimatedDrawCalls: { before: number; after: number }
  savings: number
} {
  const batches = organizeBatches(nodes)
  const batchableNodes = batches.reduce((sum, g) => sum + g.instances.length, 0)
  const before = nodes.length
  const after = nodes.length - batchableNodes + batches.length

  return {
    totalNodes: nodes.length,
    batchableNodes,
    estimatedDrawCalls: { before, after },
    savings: before - after,
  }
}
