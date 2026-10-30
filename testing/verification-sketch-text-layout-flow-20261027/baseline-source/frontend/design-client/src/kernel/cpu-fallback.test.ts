import { expect, test } from 'vitest'
import { shouldUseExactCpuFallback } from './cpu-fallback'

test.each(['auto', 'webgpu', 'webgl2'] as const)('%s application surface recovers exact CPU on unavailable or lost GPU', backend => {
  for (const error of ['浏览器未提供 WebGPU', '没有可用的 WebGPU 适配器', 'GPU_UNAVAILABLE: NotSupportedError', 'WebGPU Canvas 不可用', 'WebGPU 设备已丢失', 'GPU device lost'])
    expect(shouldUseExactCpuFallback(backend, new Error(error))).toBe(true)
})
test('cancellation, invalid input, CPU failure and unrelated errors never start fallback', () => {
  for (const error of ['PREVIEW_CANCELLED: device lost', 'AbortError: GPU_UNAVAILABLE:', 'Invalid tile request device lost', 'invalid document', 'GPU texture feedback loop'])
    expect(shouldUseExactCpuFallback('webgpu', error)).toBe(false)
  expect(shouldUseExactCpuFallback('cpu', 'GPU device lost')).toBe(false)
  expect(shouldUseExactCpuFallback('webgpu', 'PREVIEW_CPU_FALLBACK: budget')).toBe(false)
  expect(shouldUseExactCpuFallback('auto', 'PREVIEW_CPU_FALLBACK: budget')).toBe(true)
})
