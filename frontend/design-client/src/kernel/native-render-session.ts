/**
 * 桌面原生渲染会话:经 window.coreDesktop.nativeRender 驱动 design-render
 * serve 模式(macOS Metal/wgpu),把真实帧和 E6 四桶 GPU 内存台账带回渲染进程。
 * 仅桌面、仅显式启用(localStorage `forma-render-backend=native` 或构建期
 * VITE_DESIGN_NATIVE=1);默认行为不变,画布仍走 WASM worker。
 */
import { desktopBridge, type NativeGpuMemoryBreakdown, type NativeRenderFrameOptions, type NativeRenderFrameStats } from '../desktop'
import { prefersNativeBackend } from './render-policy'
import { decodeNativeRenderPixels } from './native-render-pixels'
export { decodeNativeRenderPixels } from './native-render-pixels'

/** 与 kernel/client.ts 的后端偏好读取同一 localStorage 键。 */
export function nativeBackendPreferred(): boolean {
  if (import.meta.env.VITE_DESIGN_NATIVE === '1') return true
  if (import.meta.env.VITE_DESIGN_NATIVE === '0') return false
  try {
    return prefersNativeBackend(localStorage.getItem('forma-render-backend'))
  } catch {
    return false
  }
}

export function nativeRenderAvailable(): boolean {
  return !!desktopBridge()?.nativeRender
}

export type NativeRenderProbeResult = {
  width: number
  height: number
  rgba: Uint8Array
  stats: NativeRenderFrameStats
  gpuMemory: NativeGpuMemoryBreakdown | null
}

/** 端到端探针:load → frame → stats,返回真实帧与四桶台账。 */
export async function probeNativeRender(
  documentJson: string,
  options: NativeRenderFrameOptions,
): Promise<NativeRenderProbeResult> {
  const bridge = desktopBridge()?.nativeRender
  if (!bridge) throw new Error('原生渲染桥不可用(非桌面环境或未安装 design-render)')
  const loaded = await bridge.load(documentJson)
  if (!loaded.ok) throw new Error(`原生文档加载失败:${loaded.error}`)
  const frame = await bridge.frame(options)
  if (!frame.ok) throw new Error(`原生帧渲染失败:${frame.error}`)
  const rgba = decodeNativeRenderPixels(frame)
  const stats = await bridge.stats()
  const gpuMemory = stats.ok ? stats.stats.gpu_memory || null : frame.stats.gpu_memory || null
  return { width: frame.width, height: frame.height, rgba, stats: frame.stats, gpuMemory }
}

/** 与 design-gpu gpu_ledger 硬件测试相同的双形状文档,保证四桶都有真实分配。 */
const PROBE_DOCUMENT = JSON.stringify({
  schemaVersion: 1, id: 'd', name: 'native-probe',
  pages: [{ id: 'p', name: 'p', children: ['a', 'b'], background: '#ffffff' }],
  nodes: {
    a: { id: 'a', kind: 'rectangle', width: 64, height: 48, fills: [{ kind: 'solid', color: '#3777e8' }] },
    b: { id: 'b', kind: 'ellipse', width: 40, height: 40, transform: [1, 0, 0, 1, 12, 4], fills: [{ kind: 'solid', color: '#c070e0', opacity: 0.5 }] },
  },
})
const PROBE_OPTIONS: NativeRenderFrameOptions = {
  pageId: 'p', width: 96, height: 64, view: { x: 0, y: 0, zoom: 1 }, transparent: true,
}

export async function runNativeRenderProbe(): Promise<NativeRenderProbeResult> {
  const result = await probeNativeRender(PROBE_DOCUMENT, PROBE_OPTIONS)
  console.info('[native-render] frame', `${result.width}x${result.height}`,
    `backend=${result.stats.backend}`, 'gpu_memory=', result.gpuMemory)
  return result
}

// 桌面进程内显式启用时自动跑一次探针,并把入口暴露给 dev 控制台手动调用。
if (typeof window !== 'undefined' && nativeRenderAvailable()) {
  ;(window as unknown as { __nativeRenderProbe?: typeof runNativeRenderProbe }).__nativeRenderProbe = runNativeRenderProbe
  if (nativeBackendPreferred()) {
    void runNativeRenderProbe().catch((error) => console.warn('[native-render] probe failed:', error))
  }
}
