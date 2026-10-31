import type { RenderBackend } from './render-policy'

/** Application surface recovery only. Explicit worker/reference GPU requests
 * remain strict. A new ReferenceSurface owns a fresh CPU worker and canvases;
 * a transferred resident WebGPU canvas is never reused for Canvas2D.
 * Do not turn invalid scenes, cancellations or generic renderer bugs into
 * apparently successful fallback. Surface owns a one-way, exact-frame handoff. */
export function shouldUseExactCpuFallback(backend: RenderBackend, error: unknown): boolean {
  if (backend === 'cpu') return false
  const message = String(error)
  if (/PREVIEW_CANCELLED|AbortError|Invalid tile request/.test(message)) return false
  if (backend === 'auto' && message.includes('PREVIEW_CPU_FALLBACK:')) return true
  return /GPU_UNAVAILABLE:|浏览器未提供 WebGPU|没有可用的 WebGPU 适配器|WebGPU Canvas 不可用|device lost|has been lost|设备已丢失/i.test(message)
}
