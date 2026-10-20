import { expect, test } from 'vitest'
import { estimatedTileResidencyBytes, PAGE_MEMORY_POLICIES, pageResidencyBudget, validRenderMemoryTier } from './page-memory-policy'
const MiB = 1024 * 1024
test('bounded tiers enlarge only inactive estimates and never the active planner or renderer', () => {
  expect(pageResidencyBudget(128 * MiB, 'balanced')).toBe(224 * MiB)
  expect(pageResidencyBudget(480 * MiB, 'expanded')).toBe(512 * MiB)
  expect(PAGE_MEMORY_POLICIES.expanded.maxPages).toBe(16)
  for (const value of [NaN, Infinity, -1, 513 * MiB]) expect(() => pageResidencyBudget(value, 'balanced')).toThrow()
  expect(validRenderMemoryTier('__proto__')).toBe(false)
})
test('shared payload buffers and resident GPU handles count once with actual SDR capture format', () => {
  const bytes = new Uint8Array(32), a = { bytes: bytes.subarray(0, 8), width: 2, height: 2, gpuTile: 10, color: {} }
  const b = { ...a, bytes: bytes.subarray(8, 16) }
  expect(estimatedTileResidencyBytes([a, a, b])).toBe(32 + 16)
  expect(estimatedTileResidencyBytes([{ ...a, gpuTile: undefined, linear: new Float32Array(16) }])).toBe(32 + 64 + 32)
})
test('shared bitmap and independent mounted canvases have distinct ownership estimates', () => {
  const bitmap = {} as ImageBitmap, a = { bytes: new Uint8Array(), width: 2, height: 2, bitmap }
  expect(estimatedTileResidencyBytes([a, { ...a }])).toBe(16 + 16 + 16)
})
