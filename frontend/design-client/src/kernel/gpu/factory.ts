import type { ColorSettings } from '../../color'
import type { ManagedImageLoader } from './renderer'
import { GpuRenderer } from './renderer'
import { WebGpuDriver } from './webgpu'
import { WebGlDriver } from './webgl'
import { figma_unpremultiply_rgba8 } from '../../generated/design-kernel/design_kernel'
import { validGpuWorkingBudgetMiB } from '../render-policy'
export async function createGpu(
  backend: 'webgpu' | 'webgl2',
  optimized = true,
  solidBatch = true,
  color?: ColorSettings,
  imageLoader?: ManagedImageLoader,
  hdr = false,
  floating = !!color,
  imageMips = false,
  imageAtlas = false,
  displayMath = false,
  gpuWorkingBudgetMiB?: number,
) {
  if (gpuWorkingBudgetMiB !== undefined && !validGpuWorkingBudgetMiB(gpuWorkingBudgetMiB))
    throw Error('Invalid GPU working budget')
  return new GpuRenderer(
    backend === 'webgpu'
      ? await WebGpuDriver.create(floating, hdr, !!color, optimized, displayMath)
      : new WebGlDriver(floating, !!color, optimized),
    optimized,
    solidBatch && !floating,
    imageLoader,
    imageMips,
    imageAtlas,
    gpuWorkingBudgetMiB,
  )
}
export function straightAlpha(bytes: Uint8Array, software = false) {
  if(!software){figma_unpremultiply_rgba8(bytes);return bytes}
  for (let i = 0; i < bytes.length; i += 4) {
    const alpha = bytes[i + 3]
    for (let c = 0; c < 3; c++) {
      if (!alpha) { bytes[i + c] = 0; continue }
      if (software) {
        const reciprocal = Math.fround(1 / 255)
        const normalized = Math.fround(Math.fround(bytes[i + c] * reciprocal) / Math.fround(alpha * reciprocal))
        const scaled = Math.fround(Math.max(0, Math.min(1, normalized)) * 255)
        const q = Math.floor(scaled), fraction = scaled - q
        bytes[i + c] = q + Number(fraction > 0.5 || (fraction === 0.5 && q % 2 === 1))
      }
    }
  }
  return bytes
}
