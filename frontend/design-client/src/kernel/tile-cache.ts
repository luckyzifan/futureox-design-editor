/** World-aligned geometric tiles. Raster owners additionally key their exact
 * computation camera, document revision and render contract; algebraically
 * translating an old float computation is not a proof of bitwise equivalence. */
export type RasterTile = {
  key: string
  x: number
  y: number
  width: number
  height: number
  zoom: number
  /** Fractional device-pixel camera origin; zero is the legacy integer phase. */
  phaseX?: number
  phaseY?: number
  /** Planned prefetch-rim tile (outside the viewport set). Forces the tile
   * into the scheduler's off-screen budget branch; the one-pixel overlap
   * gutters alone can never promote it to the on-screen exemption. */
  prefetch?: true
  /** Regular 514px tiles have a 1px filtering gutter (also the legacy default).
   * Whole-viewport transient samples explicitly set 0. */
  gutter?: number
  viewportPreview?: true
  nativeCapture?: true
  /** Immutable snapshot of a validated final native-density interaction. */
  committedViewport?: true
}
export const TILE_SIDE = 512
export const MIN_DISPLAY_TILE_BYTES = 128 * 1024 * 1024
export const MAX_DISPLAY_TILE_BYTES = 512 * 1024 * 1024

/** Display residency is distinct from the renderer's 256 MiB working pool.
 * Reserve a complete old frame, a complete incoming frame and its payloads.
 * Include gutters and the extra row/column exposed by any sub-tile pan. The
 * viewport determines this allowance; zoom and document size cannot grow it.
 */
export function displayTileBudget(width: number, height: number, dpr: number, hdr: boolean): number {
  if (![width, height, dpr].every(Number.isFinite) || width < 0 || height < 0 || dpr <= 0)
    throw new Error('Invalid display tile viewport')
  const columns = Math.ceil(width * dpr / TILE_SIDE) + 1
  const rows = Math.ceil(height * dpr / TILE_SIDE) + 1
  const resident = hdr ? 8 : 4, payload = hdr ? 20 : 4
  const bytes = columns * rows * (TILE_SIDE + 2) ** 2 * (2 * resident + payload)
  if (columns * rows > 256 || bytes > MAX_DISPLAY_TILE_BYTES)
    throw new Error('Display viewport exceeds supported tile memory budget')
  return Math.max(MIN_DISPLAY_TILE_BYTES, Math.ceil(bytes / 1048576) * 1048576)
}
/** Worst-case resident bytes per planned tile. SDR keeps the CPU payload plus
 * an RGBA8 canvas (8 B/px); the managed float path additionally retains the
 * linear HDR payload and an rgba16float canvas (28 B/px). Deriving the plan
 * limit from the ProgressiveSurface resident budget keeps a full plan from
 * structurally exceeding it — previously a 256-tile HDR plan (~133 MiB) hit
 * the 128 MiB resident eviction and threw after the paint work was done.
 * With 512² tiles the byte-derived limit itself is small (SDR 64 / HDR 18
 * at 128 MiB), so the floor only guards degenerate tiny budgets; it must
 * never lift a plan past the resident budget. */
export function budgetTileLimit(residentBudgetBytes: number, floatCompositing: boolean): number {
  const bytesPerPixel = floatCompositing ? 28 : 8
  return Math.max(16, Math.min(256, Math.floor(residentBudgetBytes / (TILE_SIDE * TILE_SIDE * bytesPerPixel))))
}
export function tileLevel(zoom: number) {
  return Math.max(1 / 512, Math.min(128, 2 ** (Math.ceil(Math.log2(zoom) * 4) / 4)))
}
/** Calculate dynamic density with Figma's on-demand downsampling strategy.
 * Only reduces density when tile budget is exceeded (not pre-bucketed).
 * Returns arbitrary float values (0.73, 1.42) for smooth zoom transitions. */
export function calculateDynamicDensity(
  requestedDensity: number,
  viewport: { width: number; height: number },
  maxTiles = 256,
  tileSize = 512,
): number {
  if (!Number.isFinite(requestedDensity) || requestedDensity <= 0) return requestedDensity

  // Calculate required tiles at requested density
  const columns = Math.ceil(viewport.width * requestedDensity / tileSize)
  const rows = Math.ceil(viewport.height * requestedDensity / tileSize)
  const required = columns * rows

  if (required <= maxTiles) return requestedDensity  // Budget sufficient

  // Figma's 4x downsampling strategy (log4 = log2 / 2)
  const ratio = required / maxTiles
  const log4Factor = Math.ceil(Math.log2(ratio) / 2)
  let density = requestedDensity / (2 ** log4Factor)

  // Still exceeds budget? Apply additional 2x downsample
  const recheck = Math.ceil(viewport.width * density / tileSize) *
                  Math.ceil(viewport.height * density / tileSize)
  if (recheck > maxTiles) density /= 2

  return density
}

/** Mirror of the kernel's `tile_stack::lod_bucket_scale` (the threshold table
 * disassembled from Sketch's `MSTiledRenderer.tileLevel(scale:)`): 0.1 / 0.25
 * / 0.5 / 1 / 2 with halving below 0.1, always returning a representative
 * scale <= the input so callers upscale only. Kept pure here because the
 * component reads it during render, before the wasm module initializes; the
 * wasm-parity test freezes the mirror against the export.
 *
 * NOTE: Deprecated in favor of calculateDynamicDensity for main rendering path.
 * Retained for backward compatibility with existing tests. */
export function lodBucketScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return scale
  if (scale > 2) return scale
  if (scale > 1) return 1
  if (scale > 0.5) return 0.5
  if (scale > 0.25) return 0.25
  let bucket = 0.1
  while (bucket > scale) bucket *= 0.5
  return bucket
}
/** Mirror of the kernel's `tile_stack::exact_bucket_scale`: the exact layer
 * renders at the fixed mipmap ladder the disassembled `tileLevel(scale:)`
 * selects (levels pinned at 0.1/0.25/0.5/1/2, level [5] stepping in powers of
 * two above 2), so a zoom inside one bucket never re-rasterizes — the live
 * camera resamples committed pixels through CSS placement, which is Sketch's
 * `drawTiles` behaviour. Always returns a representative scale >= the input
 * (over-render stays below 2x, 2.5x only inside the first rung). */
export function exactBucketScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return scale
  if (scale <= 0.1) return 0.1
  let bucket = 0.25
  while (bucket < scale) bucket *= 2
  return bucket
}
/** Mirror of the kernel's `raster_addresses`. Whole-pixel pans retain the
 * sampling phase and reuse world addresses. Fractional phases shift the grid
 * and remain in the key; edge tiles must cover that shifted footprint. */
export function planTiles(
  bounds: { x: number; y: number; width: number; height: number },
  zoom: number,
  limit = 256,
  phase = { x: 0, y: 0 },
): RasterTile[] {
  if (
    ![bounds.x, bounds.y, bounds.width, bounds.height, zoom, phase.x, phase.y].every(Number.isFinite) ||
    bounds.width < 0 ||
    bounds.height < 0 ||
    zoom <= 0 || phase.x < 0 || phase.x >= 1 || phase.y < 0 || phase.y >= 1
  )
    throw new Error('Invalid tile bounds')
  const x0 = Math.floor((bounds.x * zoom + phase.x) / TILE_SIDE),
    y0 = Math.floor((bounds.y * zoom + phase.y) / TILE_SIDE)
  const x1 = Math.ceil(((bounds.x + bounds.width) * zoom + phase.x) / TILE_SIDE),
    y1 = Math.ceil(((bounds.y + bounds.height) * zoom + phase.y) / TILE_SIDE)
  if ((x1 - x0) * (y1 - y0) > limit) throw new Error('Visible tile budget exceeded')
  const tiles: RasterTile[] = []
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      // Match the Rust-backed production planner: the worker renders the
      // requested 514px viewport, including one sample beyond each core edge.
      // The compositor owns the 512px core and filters using these neighbours.
      tiles.push({
        key: `${zoom}:${phase.x}:${phase.y}:${x}:${y}`,
        x: x * TILE_SIDE - 1,
        y: y * TILE_SIDE - 1,
        width: TILE_SIDE + 2,
        height: TILE_SIDE + 2,
        gutter: 1,
        zoom,
        phaseX: phase.x,
        phaseY: phase.y,
      })
    }
  const cx = (bounds.x + bounds.width / 2) * zoom,
    cy = (bounds.y + bounds.height / 2) * zoom
  const half = TILE_SIDE / 2
  return tiles.sort(
    (a, b) =>
      Math.hypot(a.x + half - cx, a.y + half - cy) - Math.hypot(b.x + half - cx, b.y + half - cy),
  )
}
export class TileCache<T> {
  private values = new Map<string, { value: T; bytes: number }>()
  bytes = 0
  constructor(readonly maxBytes = 128 * 1024 * 1024) {}
  get(key: string) {
    const item = this.values.get(key)
    if (!item) return
    this.values.delete(key)
    this.values.set(key, item)
    return item.value
  }
  set(key: string, value: T, bytes: number) {
    const old = this.values.get(key)
    if (old) {
      this.bytes -= old.bytes
      this.values.delete(key)
    }
    if (bytes > this.maxBytes) return
    while (this.bytes + bytes > this.maxBytes && this.values.size) {
      const [key, item] = this.values.entries().next().value!
      this.values.delete(key)
      this.bytes -= item.bytes
    }
    this.values.set(key, { value, bytes })
    this.bytes += bytes
  }
  clear() {
    this.values.clear()
    this.bytes = 0
  }
  get size() {
    return this.values.size
  }
}

/** Exact rectangular coverage, used to reuse a previous zoom level while idle
 * refinement fills a sharper one. Gutters are excluded from ownership. */
export function tilesCoverBounds(
  tiles: RasterTile[],
  bounds: { x: number; y: number; width: number; height: number },
  minZoom = 0,
) {
  const boxes = tiles
    .filter((t) => t.zoom >= minZoom)
    .map((t) => ({
      x: (t.x + (t.gutter??1) - (t.phaseX || 0)) / t.zoom,
      y: (t.y + (t.gutter??1) - (t.phaseY || 0)) / t.zoom,
      right: (t.x + t.width - (t.gutter??1) - (t.phaseX || 0)) / t.zoom,
      bottom: (t.y + t.height - (t.gutter??1) - (t.phaseY || 0)) / t.zoom,
    }))
  const right = bounds.x + bounds.width,
    bottom = bounds.y + bounds.height
  const xs = [
    ...new Set([
      bounds.x,
      right,
      ...boxes.flatMap((b) => [Math.max(bounds.x, b.x), Math.min(right, b.right)]),
    ]),
  ]
    .filter((x) => x >= bounds.x && x <= right)
    .sort((a, b) => a - b)
  for (let i = 0; i + 1 < xs.length; i++) {
    const x = (xs[i] + xs[i + 1]) / 2
    const spans = boxes.filter((b) => b.x <= x && b.right >= x).sort((a, b) => a.y - b.y)
    let y = bounds.y
    for (const b of spans) {
      if (b.y > y + 1e-7) break
      y = Math.max(y, b.bottom)
    }
    if (y < bottom - 1e-7) return false
  }
  return xs.length >= 2
}

/** Preserve the exact double remainder. Rounding phase would change edge samples. */
export function devicePixelPhase(position: number, dpr: number) {
  const device = position * dpr
  if (!Number.isFinite(device) || !Number.isFinite(dpr) || dpr <= 0)
    throw new Error('Invalid device pixel phase')
  return device - Math.floor(device)
}

/** 根据缩放级别计算动态瓦片密度，优化内存使用和渲染性能。
 *
 * - 缩小时 (scale < 0.5): 降低密度到 0.5，减少 GPU 工作量
 * - 正常视图 (0.5 ≤ scale ≤ 2): 标准密度 1.0
 * - 放大时 (scale > 2): 提升密度到 2.0，增加超采样质量
 */
export function densityForScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1.0
  if (scale < 0.5) return 0.5
  if (scale > 2) return 2.0
  return 1.0
}
