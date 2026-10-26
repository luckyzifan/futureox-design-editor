import { expect, test } from 'vitest'
import { estimatedTileResidencyBytes, TileResidencyLedger, PAGE_MEMORY_POLICIES, pageResidencyBudget, validRenderMemoryTier } from './page-memory-policy'
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

test('incremental retirement matches enumeration for shared buffers, handles, canvases and held aliases', () => {
  const buffers = Array.from({ length: 7 }, () => new ArrayBuffer(128))
  const bitmaps = Array.from({ length: 5 }, () => ({} as ImageBitmap))
  const values = Array.from({ length: 300 }, (_, i) => ({
    bytes: new Uint8Array(buffers[i % 7], 8, 16), linear: new Float32Array(buffers[(i + 3) % 7]),
    width: 2 + i % 9, height: 3, color: i % 2 ? {} : undefined,
    gpuTile: i % 3 === 0 ? i % 11 : undefined, bitmap: i % 3 === 1 ? bitmaps[i % 5] : undefined,
  }))
  const remaining = [...values, values[17], values[29]]
  const ledger = new TileResidencyLedger(remaining)
  expect(ledger.bytes).toBe(estimatedTileResidencyBytes(remaining))
  while (remaining.length) {
    const at = remaining.indexOf(remaining[Math.floor(remaining.length / 3)])
    ledger.remove(remaining.splice(at, 1)[0])
    expect(ledger.bytes).toBe(estimatedTileResidencyBytes(remaining))
  }
  expect(ledger.bytes).toBe(0)
  expect(() => ledger.remove(values[0])).toThrow('Unknown tile residency owner')
})

test('removing the primary owner leaves its held alias in the original enumeration order', () => {
  const a={bytes:new Uint8Array(),gpuTile:1,width:2,height:2}, b={...a,width:4}
  const ledger=new TileResidencyLedger([a,b,a]);ledger.remove(a)
  expect(ledger.bytes).toBe(estimatedTileResidencyBytes([b,a]))
  ledger.remove(b);expect(ledger.bytes).toBe(estimatedTileResidencyBytes([a]))
})
