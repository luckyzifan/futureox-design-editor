/**
 * GPU 优化集成补丁
 *
 * 将三项核心优化集成到主渲染循环：
 * 1. 扩展实例化批渲染
 * 2. 描边 GPU 计算管线
 * 3. 玻璃效果 GPU 片元化
 *
 * 同时修复：
 * - 放大缩小时清晰度不动态（改用 Figma 的平滑密度）
 * - Electron 版内存限制移除
 */

import type { GpuNode, GpuScene } from './types'
import { organizeAdvancedBatches, type AdvancedBatchGroup } from './advanced-batching'
import { StrokeGpuPipeline } from './stroke-gpu-pipeline'
import { GlassEffectGpuRenderer } from './glass-sdf-shader'
import { adaptiveBudget } from './adaptive-budget'

/** 判断是否为 Electron 环境 */
export function isElectronEnvironment(): boolean {
  return typeof navigator !== 'undefined' && /Electron/.test(navigator.userAgent)
}

/**
 * 渲染器优化扩展
 * 注入到现有 GpuRenderer 的 renderAttempt 方法中
 */
export class RendererOptimizations {
  private strokePipeline?: StrokeGpuPipeline
  private glassRenderer?: GlassEffectGpuRenderer
  private batchingEnabled = true
  private strokeGpuEnabled = true
  private glassGpuEnabled = true

  constructor(private device: GPUDevice) {}

  async initialize() {
    // 初始化描边 GPU 管线
    if (this.strokeGpuEnabled) {
      try {
        this.strokePipeline = new StrokeGpuPipeline(this.device)
        await this.strokePipeline.initialize()
        console.log('✅ 描边 GPU 计算管线已初始化')
      } catch (error) {
        console.warn('⚠️ 描边 GPU 管线初始化失败，回退到 CPU:', error)
        this.strokeGpuEnabled = false
      }
    }

    // 初始化玻璃效果渲染器
    if (this.glassGpuEnabled) {
      try {
        this.glassRenderer = new GlassEffectGpuRenderer(this.device)
        await this.glassRenderer.initialize()
        console.log('✅ 玻璃效果 GPU 片元化已初始化')
      } catch (error) {
        console.warn('⚠️ 玻璃效果 GPU 初始化失败，回退到 CPU:', error)
        this.glassGpuEnabled = false
      }
    }
  }

  /**
   * 在渲染前组织批处理
   * 返回：批处理组和剩余未批处理的节点
   */
  organizeBatching(scene: GpuScene): {
    batches: AdvancedBatchGroup[]
    unbatchedNodes: GpuNode[]
    stats: {
      originalDrawCalls: number
      batchedDrawCalls: number
      savings: number
    }
  } {
    if (!this.batchingEnabled) {
      const nodes = Object.values(scene.nodes)
      return {
        batches: [],
        unbatchedNodes: nodes,
        stats: { originalDrawCalls: nodes.length, batchedDrawCalls: nodes.length, savings: 0 }
      }
    }

    const nodes = Object.values(scene.nodes)
    const batches = organizeAdvancedBatches(nodes, {
      minInstancesPerBatch: 4,
      enableGradientBatching: true,
      enableImageBatching: true,
      enableBlendModeBatching: true,
    })

    // 已批处理的节点 ID
    const batchedIds = new Set<string>()
    for (const batch of batches) {
      for (const inst of batch.instances) {
        batchedIds.add(inst.nodeId)
      }
    }

    const unbatchedNodes = nodes.filter(n => !batchedIds.has(n.id))

    const originalDrawCalls = nodes.length
    const batchedDrawCalls = unbatchedNodes.length + batches.length
    const savings = originalDrawCalls - batchedDrawCalls

    if (import.meta.env.DEV && batches.length > 0) {
      console.log(`🎨 批渲染: ${originalDrawCalls} draw calls → ${batchedDrawCalls} (-${savings}, ${((savings/originalDrawCalls)*100).toFixed(1)}%)`)
    }

    return { batches, unbatchedNodes, stats: { originalDrawCalls, batchedDrawCalls, savings } }
  }

  /**
   * 计算自适应预算（区分 Electron 和 Web）
   */
  computeAdaptiveBudget(baseBudget: number, zoom: number): number {
    const deviceMemory = (navigator as any).deviceMemory
      ? (navigator as any).deviceMemory * 1024 * 1024 * 1024
      : undefined

    const isElectron = isElectronEnvironment()
    const adapted = adaptiveBudget(baseBudget, zoom, deviceMemory, isElectron)

    if (import.meta.env.DEV) {
      const env = isElectron ? 'Electron' : 'Web'
      const maxPercent = isElectron ? '50%' : '25%'
      console.log(
        `🎯 自适应预算 [${env}]: zoom=${zoom.toFixed(1)}×, ` +
        `base=${(baseBudget/1024/1024).toFixed(0)}MB → ${(adapted/1024/1024).toFixed(0)}MB ` +
        `(最多设备内存 ${maxPercent})`
      )
    }

    return adapted
  }

  /**
   * 检测节点是否需要 GPU 描边
   */
  needsGpuStroke(node: GpuNode): boolean {
    if (!this.strokeGpuEnabled || !this.strokePipeline) return false

    // 有描边且描边宽度 > 2px 时使用 GPU
    return node.strokes.length > 0 && node.strokes.some(s => {
      const visible = (s as any).visible ?? true
      const width = (s as any).width ?? 0
      return visible && width > 2
    })
  }

  /**
   * 检测节点是否需要 GPU 玻璃效果
   */
  needsGpuGlass(node: GpuNode): boolean {
    if (!this.glassGpuEnabled || !this.glassRenderer) return false

    // 有玻璃效果
    return node.effects.some(e => e.visible && e.kind === 'glass')
  }

  /**
   * 获取性能统计
   */
  getStats() {
    return {
      batchingEnabled: this.batchingEnabled,
      strokeGpuEnabled: this.strokeGpuEnabled,
      glassGpuEnabled: this.glassGpuEnabled,
      isElectron: isElectronEnvironment(),
    }
  }
}

/**
 * 平滑清晰度计算（替代半八度档位）
 *
 * 问题：motionRasterScale 使用半八度档位（2^(ceil(log2(requested) * 2) / 2)）
 * 导致清晰度阶梯式变化（0.5x → 0.71x → 1x → 1.41x → 2x）
 *
 * 解决：使用 Figma 的平滑密度计算（calculateDynamicDensity）
 * 返回任意浮点值（0.73x、1.42x），平滑过渡
 */
export function smoothDensity(
  zoom: number,
  dpr: number,
  viewportWidth: number,
  viewportHeight: number,
  maxTiles = 256,
  tileSize = 512
): number {
  const requestedDensity = zoom * dpr

  // 使用 Figma 的动态密度算法
  const viewport = {
    width: viewportWidth / zoom,
    height: viewportHeight / zoom,
  }

  // calculateDynamicDensity 已经在 tile-cache.ts 中实现
  // 这里简化版本：根据瓦片预算动态降采样

  const columns = Math.ceil(viewport.width * requestedDensity / tileSize)
  const rows = Math.ceil(viewport.height * requestedDensity / tileSize)
  const required = columns * rows

  if (required <= maxTiles) {
    return requestedDensity  // 预算充足，返回请求的密度
  }

  // Figma 的 4x 降采样策略（log4 = log2 / 2）
  const ratio = required / maxTiles
  const log4Factor = Math.ceil(Math.log2(ratio) / 2)
  let density = requestedDensity / (2 ** log4Factor)

  // 仍然超过预算？额外 2x 降采样
  const adjustedColumns = Math.ceil(viewport.width * density / tileSize)
  const adjustedRows = Math.ceil(viewport.height * density / tileSize)
  const adjustedRequired = adjustedColumns * adjustedRows

  if (adjustedRequired > maxTiles) {
    density = density / 2
  }

  // 平滑返回（不再量化到档位）
  return Math.max(0.1, density)
}

/**
 * 替换 motionRasterScale 的平滑版本
 *
 * 用法：
 * ```typescript
 * // 旧代码（canvas-raster-plan.ts:10）
 * const scale = 2 ** (Math.ceil(Math.log2(requested) * 2) / 2)
 *
 * // 新代码
 * const scale = smoothMotionRasterScale(view, dpr, width, height)
 * ```
 */
export function smoothMotionRasterScale(
  view: { x: number; y: number; zoom: number },
  dpr: number,
  width: number,
  height: number
): number {
  const density = smoothDensity(view.zoom, dpr, width, height)

  // 超过 128x 时不再缩放（保留原逻辑）
  if (density > 128) {
    return view.zoom * dpr
  }

  return density
}
