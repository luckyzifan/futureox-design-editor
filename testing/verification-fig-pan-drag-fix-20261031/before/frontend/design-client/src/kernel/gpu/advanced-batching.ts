/**
 * 高级实例化批渲染 - 扩展版
 *
 * 在基础 path-batching.ts 基础上扩展：
 * 1. 支持渐变填充批处理
 * 2. 支持图片填充批处理
 * 3. 支持描边批处理
 * 4. 支持混合模式批处理
 * 5. 深度集成到渲染循环
 */

import type { GpuNode, GpuPaint, PathMesh } from './types'
import { generatePathFingerprint, type PathFingerprint } from './path-batching'

/** 扩展批处理组 - 支持更多填充类型 */
export interface AdvancedBatchGroup {
  /** 几何指纹 */
  geometryFingerprint: PathFingerprint

  /** 材质指纹（填充类型 + 配置） */
  materialFingerprint: MaterialFingerprint

  /** 实例列表 */
  instances: BatchInstance[]

  /** 共享GPU资源 */
  sharedResources?: {
    geometryBuffer?: GPUBuffer
    materialBuffer?: GPUBuffer
    instanceBuffer?: GPUBuffer
  }
}

/** 材质指纹 */
export interface MaterialFingerprint {
  type: 'solid' | 'linear' | 'radial' | 'angular' | 'diamond' | 'image'

  // 纯色
  color?: string

  // 渐变
  gradientStops?: Array<{ offset: number; color: string }>
  gradientAngle?: number

  // 图片
  imageId?: string
  imageFit?: 'cover' | 'contain' | 'stretch'

  // 混合
  blend: string
  opacity: number

  // 哈希（快速比较）
  hash: string
}

/** 批处理实例 */
export interface BatchInstance {
  nodeId: string
  transform: Float32Array  // 6 floats: [a, b, c, d, tx, ty]
  rect: { x: number; y: number; w: number; h: number }
  zIndex: number

  // 实例特定数据
  instanceData?: Float32Array
}

const MAX_INSTANCES_PER_BATCH = 1024  // 单批次最大实例数（Figma 级别）

/** 生成材质指纹 */
export function generateMaterialFingerprint(paint: GpuPaint): MaterialFingerprint {
  let hash = ''

  if (paint.kind === 'solid') {
    hash = `solid-${paint.color}`
  } else if (paint.kind === 'linear' || paint.kind === 'radial' || paint.kind === 'angular') {
    // 渐变：stops + angle
    const stopsHash = paint.stops?.map(s => `${s.offset}:${s.color}`).join('|') ?? ''
    hash = `${paint.kind}-${paint.angle}-${stopsHash}`
  } else if (paint.kind === 'image') {
    hash = `image-${paint.id}-${paint.fit}`
  }

  // 混合模式
  hash += `-${paint.blend}-${paint.opacity}`

  return {
    type: paint.kind,
    color: paint.kind === 'solid' ? paint.color : undefined,
    gradientStops: (paint.kind === 'linear' || paint.kind === 'radial' || paint.kind === 'angular')
      ? paint.stops : undefined,
    gradientAngle: (paint.kind === 'linear' || paint.kind === 'radial' || paint.kind === 'angular')
      ? paint.angle : undefined,
    imageId: paint.kind === 'image' ? paint.id : undefined,
    imageFit: paint.kind === 'image' ? (paint.fit as 'cover' | 'contain' | 'stretch') : undefined,
    blend: paint.blend,
    opacity: paint.opacity,
    hash,
  }
}

/** 判断材质是否可批处理 */
export function isBatchableMaterial(paint: GpuPaint): boolean {
  // 纯色：总是可批处理
  if (paint.kind === 'solid') return true

  // 简单线性/径向渐变：2-4 色阶，可批处理
  if (paint.kind === 'linear' || paint.kind === 'radial') {
    const stopCount = paint.stops?.length ?? 0
    return stopCount >= 2 && stopCount <= 4
  }

  // 图片：相同 imageId + fit，可批处理
  if (paint.kind === 'image') {
    return !!paint.id
  }

  // 角度/钻石渐变：暂不批处理（较少见）
  return false
}

/** 组织高级批处理 */
export function organizeAdvancedBatches(
  nodes: GpuNode[],
  options: {
    minInstancesPerBatch?: number
    enableGradientBatching?: boolean
    enableImageBatching?: boolean
    enableBlendModeBatching?: boolean
  } = {}
): AdvancedBatchGroup[] {
  const {
    minInstancesPerBatch = 4,  // 降低阈值（Figma 从2个实例就批）
    enableGradientBatching = true,
    enableImageBatching = true,
    enableBlendModeBatching = true,
  } = options

  const groups = new Map<string, AdvancedBatchGroup>()

  for (const node of nodes) {
    // 跳过复杂节点
    if (node.children.length || node.mask || node.passthrough) continue
    if (node.effects.length > 0) continue  // 效果节点暂不批处理

    // 单一填充
    if (node.fills.length !== 1) continue
    const fill = node.fills[0]
    if (!fill.visible) continue

    // 检查材质是否可批处理
    if (!isBatchableMaterial(fill)) continue

    // 混合模式限制
    if (!enableBlendModeBatching && (node.blend !== 'normal' || fill.blend !== 'normal')) {
      continue
    }

    // 渐变/图片开关
    if (fill.kind !== 'solid') {
      if (fill.kind === 'image' && !enableImageBatching) continue
      if ((fill.kind === 'linear' || fill.kind === 'radial') && !enableGradientBatching) continue
    }

    // 生成指纹
    const geoFingerprint = generatePathFingerprint(node.fill)
    const matFingerprint = generateMaterialFingerprint(fill)

    // 批次键：几何 + 材质 + 混合
    const key = `${geoFingerprint.geometryHash}-${matFingerprint.hash}-${node.blend}`

    let group = groups.get(key)
    if (!group) {
      group = {
        geometryFingerprint: geoFingerprint,
        materialFingerprint: matFingerprint,
        instances: [],
      }
      groups.set(key, group)
    }

    // 分割超大批次
    if (group.instances.length >= MAX_INSTANCES_PER_BATCH) {
      let suffix = 1
      let newKey = `${key}-${suffix}`
      while (groups.has(newKey) && groups.get(newKey)!.instances.length >= MAX_INSTANCES_PER_BATCH) {
        suffix++
        newKey = `${key}-${suffix}`
      }
      group = groups.get(newKey) ?? {
        geometryFingerprint: geoFingerprint,
        materialFingerprint: matFingerprint,
        instances: [],
      }
      groups.set(newKey, group)
    }

    // 添加实例
    group.instances.push({
      nodeId: node.id,
      transform: new Float32Array(node.matrix),
      rect: node.rect,
      zIndex: 0,  // TODO: 从场景图计算
    })
  }

  // 过滤：只返回满足最小实例数的批次
  return Array.from(groups.values()).filter(g => g.instances.length >= minInstancesPerBatch)
}

/** 编码高级批处理实例数据 */
export function encodeAdvancedBatchInstances(group: AdvancedBatchGroup): {
  geometryData?: Float32Array
  materialData?: Float32Array
  instanceData: Float32Array
  instanceCount: number
} {
  const { instances, materialFingerprint } = group

  // 实例数据布局：transform(6) + rect(4) + custom(6) = 16 floats
  const floatsPerInstance = 16
  const instanceData = new Float32Array(instances.length * floatsPerInstance)

  for (let i = 0; i < instances.length; i++) {
    const inst = instances[i]
    const offset = i * floatsPerInstance

    // Transform matrix (6)
    instanceData.set(inst.transform, offset)

    // Rect (4)
    instanceData[offset + 6] = inst.rect.x
    instanceData[offset + 7] = inst.rect.y
    instanceData[offset + 8] = inst.rect.w
    instanceData[offset + 9] = inst.rect.h

    // Custom data (6) - 材质特定
    if (materialFingerprint.type === 'solid' && materialFingerprint.color) {
      // 纯色：RGBA
      const hex = materialFingerprint.color
      instanceData[offset + 10] = parseInt(hex.slice(1, 3), 16) / 255
      instanceData[offset + 11] = parseInt(hex.slice(3, 5), 16) / 255
      instanceData[offset + 12] = parseInt(hex.slice(5, 7), 16) / 255
      instanceData[offset + 13] = materialFingerprint.opacity
    } else if (materialFingerprint.type === 'linear' || materialFingerprint.type === 'radial') {
      // 渐变：angle + stop count
      instanceData[offset + 10] = materialFingerprint.gradientAngle ?? 0
      instanceData[offset + 11] = materialFingerprint.gradientStops?.length ?? 0
      instanceData[offset + 12] = materialFingerprint.opacity
    } else if (materialFingerprint.type === 'image') {
      // 图片：fit mode
      const fitMap = { cover: 0, contain: 1, stretch: 2 }
      instanceData[offset + 10] = fitMap[materialFingerprint.imageFit || 'cover']
      instanceData[offset + 11] = materialFingerprint.opacity
    }

    // z-index (用于排序)
    instanceData[offset + 14] = inst.zIndex

    // padding
    instanceData[offset + 15] = 0
  }

  return {
    instanceData,
    instanceCount: instances.length,
  }
}

/** 预估高级批处理收益 */
export function estimateAdvancedBatchingSavings(
  nodes: GpuNode[],
  options?: Parameters<typeof organizeAdvancedBatches>[1]
): {
  totalNodes: number
  batchGroups: number
  batchableNodes: number
  drawCallReduction: number
  savingsPercent: number
  breakdown: {
    solid: number
    gradient: number
    image: number
  }
} {
  const batches = organizeAdvancedBatches(nodes, options)

  let solidCount = 0
  let gradientCount = 0
  let imageCount = 0

  for (const batch of batches) {
    const count = batch.instances.length
    if (batch.materialFingerprint.type === 'solid') solidCount += count
    else if (batch.materialFingerprint.type === 'linear' || batch.materialFingerprint.type === 'radial') {
      gradientCount += count
    } else if (batch.materialFingerprint.type === 'image') imageCount += count
  }

  const batchableNodes = solidCount + gradientCount + imageCount
  const drawCallBefore = nodes.length
  const drawCallAfter = nodes.length - batchableNodes + batches.length
  const reduction = drawCallBefore - drawCallAfter

  return {
    totalNodes: nodes.length,
    batchGroups: batches.length,
    batchableNodes,
    drawCallReduction: reduction,
    savingsPercent: (reduction / drawCallBefore) * 100,
    breakdown: {
      solid: solidCount,
      gradient: gradientCount,
      image: imageCount,
    },
  }
}

/** 批处理统计信息（用于调试） */
export function getBatchingStats(batches: AdvancedBatchGroup[]): {
  totalBatches: number
  totalInstances: number
  avgInstancesPerBatch: number
  largestBatch: number
  smallestBatch: number
  byMaterialType: Record<string, number>
} {
  if (batches.length === 0) {
    return {
      totalBatches: 0,
      totalInstances: 0,
      avgInstancesPerBatch: 0,
      largestBatch: 0,
      smallestBatch: 0,
      byMaterialType: {},
    }
  }

  const totalInstances = batches.reduce((sum, b) => sum + b.instances.length, 0)
  const instanceCounts = batches.map(b => b.instances.length)
  const byMaterialType: Record<string, number> = {}

  for (const batch of batches) {
    const type = batch.materialFingerprint.type
    byMaterialType[type] = (byMaterialType[type] || 0) + batch.instances.length
  }

  return {
    totalBatches: batches.length,
    totalInstances,
    avgInstancesPerBatch: totalInstances / batches.length,
    largestBatch: Math.max(...instanceCounts),
    smallestBatch: Math.min(...instanceCounts),
    byMaterialType,
  }
}
