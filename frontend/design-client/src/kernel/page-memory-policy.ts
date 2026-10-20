/** Surface residency estimates only: not a process/device/OS allocation cap.
 * Active sampling quality and the renderer working pool are not enlarged. */
export type RenderMemoryTier = 'conservative' | 'balanced' | 'expanded'
const MiB = 1024 * 1024
export const PAGE_MEMORY_POLICIES = Object.freeze({
  conservative: Object.freeze({ inactiveBytes: 32 * MiB, maxPages: 3 }),
  balanced: Object.freeze({ inactiveBytes: 96 * MiB, maxPages: 8 }),
  expanded: Object.freeze({ inactiveBytes: 192 * MiB, maxPages: 16 }),
})
export const DEFAULT_RENDER_MEMORY_TIER: RenderMemoryTier = 'balanced'
export function validRenderMemoryTier(value: unknown): value is RenderMemoryTier {
  return value === 'conservative' || value === 'balanced' || value === 'expanded'
}
export function pageResidencyBudget(activeBudget: number, tier: RenderMemoryTier) {
  if (!Number.isSafeInteger(activeBudget) || activeBudget < 0 || activeBudget > 512 * MiB)
    throw new Error('Invalid active surface budget')
  return Math.min(512 * MiB, activeBudget + PAGE_MEMORY_POLICIES[tier].inactiveBytes)
}
/** Shared typed-array buffers and bitmap/GPU handles are counted once. GPU
 * captures are non-HDR RGBA/BGRA8; managed canvas estimates use RGBA16F. Browser
 * backing-store, mip/driver overhead and pending deletion are not measured here. */
export function estimatedTileResidencyBytes(tiles: Iterable<{
  bytes: Uint8Array; linear?: Float32Array; width: number; height: number;
  color?: unknown; gpuTile?: number; bitmap?: ImageBitmap
}>) {
  const buffers = new Set<ArrayBufferLike>(), gpu = new Set<number>(), bitmaps = new Set<ImageBitmap>(), objects = new Set<object>()
  let bytes = 0
  for (const tile of tiles) {
    if (objects.has(tile)) continue
    objects.add(tile)
    for (const data of [tile.bytes, tile.linear]) if (data?.byteLength && !buffers.has(data.buffer)) {
      buffers.add(data.buffer); bytes += data.buffer.byteLength
    }
    if (tile.gpuTile !== undefined) {
      if (!gpu.has(tile.gpuTile)) { gpu.add(tile.gpuTile); bytes += tile.width * tile.height * 4 }
    } else if (tile.bitmap) {
      if (!bitmaps.has(tile.bitmap)) { bitmaps.add(tile.bitmap); bytes += tile.width * tile.height * 4 }
      // The mounted display canvas is a distinct allocation from its bitmap.
      bytes += tile.width * tile.height * (tile.color ? 8 : 4)
    } else bytes += tile.width * tile.height * (tile.color ? 8 : 4)
  }
  return bytes
}
