/**
 * 检测是否在 Electron 环境中运行
 */
export function isElectronEnvironment(): boolean {
  if (typeof window === 'undefined') return false
  return !!(window as any).electron || !!(window as any).electronAPI || (navigator.userAgent.includes('Electron'))
}

/**
 * 根据缩放等级计算预算倍数
 */
export function budgetMultiplierForZoom(zoom: number): number {
  if (zoom <= 1) return 1     // ≤100%：正常预算
  if (zoom <= 2) return 1.5   // 100-200%: 1.5×
  if (zoom <= 4) return 2     // 200-400%: 2×
  if (zoom <= 8) return 3     // 400-800%: 3×
  if (zoom <= 16) return 4    // 800-1600%: 4×
  if (zoom <= 32) return 6    // 1600-3200%: 6×
  return 8                     // 3200%+: 8×
}

/**
 * 计算动态预算
 * @param isElectron - 是否为 Electron 环境（桌面版）
 */
export function adaptiveBudget(
  baseBytes: number,
  zoom: number,
  deviceMemory?: number,
  isElectron?: boolean
): number {
  const multiplier = budgetMultiplierForZoom(zoom)
  const adjusted = baseBytes * multiplier

  if (isElectron) {
    const deviceMem = deviceMemory || 16 * 1024 * 1024 * 1024 // 默认 16GB
    return Math.min(adjusted, deviceMem * 0.5) // 最多使用 50% 设备内存
  }

  // Web 版：保持合理限制
  const maxBudget = deviceMemory
    ? Math.min(deviceMemory * 0.25, 2 * 1024 * 1024 * 1024) // 设备内存的 25%，最多 2GB
    : 1024 * 1024 * 1024 // 默认最多 1GB

  return Math.min(adjusted, maxBudget)
}

/**
 * 分块渲染策略
 * 当单个表面超过预算时，分块渲染再拼接
 */
export interface TileStrategy {
  enabled: boolean
  tileSize: number  // 每块最大尺寸
  overlap: number   // 边缘重叠像素数
}

export function tileStrategyForZoom(zoom: number, imageSize: [number, number]): TileStrategy {
  const [w, h] = imageSize
  const pixels = w * h
  const bytesPerPixel = 16 // RGBA32F
  const singleSurfaceBytes = pixels * bytesPerPixel

  // 8K: 7680×4320 = 33,177,600 像素 × 16 字节 = 530,841,600 字节 ≈ 506MB
  // 超过 256MB 在高倍率时启用分块，或任何超过 512MB 的情况
  const threshold = zoom > 16 ? 256 * 1024 * 1024 : 512 * 1024 * 1024

  if (singleSurfaceBytes > threshold) {
    // 目标每块 256MB
    const targetPixels = (256 * 1024 * 1024) / bytesPerPixel
    const tileSide = Math.floor(Math.sqrt(targetPixels))

    return {
      enabled: true,
      tileSize: Math.min(tileSide, 4096),
      overlap: Math.ceil(Math.max(4, zoom * 2)) // 高倍率更多重叠
    }
  }

  return { enabled: false, tileSize: 0, overlap: 0 }
}

/**
 * 智能驱逐策略
 * 根据缩放等级优先保留关键纹理
 */
export interface EvictionPriority {
  category: 'critical' | 'important' | 'normal' | 'disposable'
  score: number
}

export function evictionPriority(
  texture: { width: number; height: number; bytes: number },
  lastUsedFrame: number,
  currentFrame: number,
  isInteraction: boolean,
  isImage: boolean
): EvictionPriority {
  const age = currentFrame - lastUsedFrame

  // 交互缓存：critical
  if (isInteraction) {
    return { category: 'critical', score: 1000 - age }
  }

  // 当前显示图片：important
  if (isImage && age < 5) {
    return { category: 'important', score: 500 - age }
  }

  // 小纹理（< 1MB）：normal
  if (texture.bytes < 1024 * 1024) {
    return { category: 'normal', score: 100 - age }
  }

  // 大纹理：disposable（年龄超过 50 帧时负分）
  return { category: 'disposable', score: Math.max(-100, 50 - age) }
}

/**
 * GPU 使用率优化策略
 */
export interface GpuOptimizationStrategy {
  // 预算管理
  budgetBytes: number
  budgetMultiplier: number

  // 分块渲染
  tiling: TileStrategy

  // 批处理
  batchingEnabled: boolean
  minBatchSize: number

  // 驱逐策略
  aggressiveEviction: boolean
  evictionThreshold: number  // 0-1，触发驱逐的预算占用比例
}

export function optimizationStrategyForZoom(
  zoom: number,
  imageSize: [number, number],
  baseBudget: number,
  deviceMemory?: number
): GpuOptimizationStrategy {
  const multiplier = budgetMultiplierForZoom(zoom)
  const budgetBytes = adaptiveBudget(baseBudget, zoom, deviceMemory)
  const tiling = tileStrategyForZoom(zoom, imageSize)

  return {
    budgetBytes,
    budgetMultiplier: multiplier,
    tiling,
    batchingEnabled: true,
    minBatchSize: zoom > 4 ? 16 : 8, // 高倍率更激进的批处理
    aggressiveEviction: zoom > 8,     // 超过 800% 启用激进驱逐
    evictionThreshold: zoom > 8 ? 0.7 : 0.85 // 高倍率更早驱逐
  }
}
