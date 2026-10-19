import type { RasterTile } from './tile-cache'

/** Viewport-distance tile fill scheduling with a per-frame budget.
 *
 * Policy layer only: it reorders and paces tile rasterization requests; it
 * never changes tile geometry, LOD buckets or cache residency. The behaviour
 * mirrors Figma's viewer JS tile scheduler policy:
 *
 * - Priority: `getPrioritizedListOfTilesToPopulate` sorts tiles by canvas-space
 *   distance to the viewport (nearest first) and the draw loop processes
 *   on-screen tiles before off-screen prefetch tiles.
 * - Frame budget: 16 ms / 2 tile rasterizations /
 *   250 render-target switches per frame. On-screen tiles run with
 *   `permitWorkAfterBudgetExceeded()` (exempt, except safe mode); off-screen
 *   prefetch is forced through `permitsMoreWork()` and stops with a
 *   `brokeRenderAt` reason (`offscreenHitBudget_`, `offscreenHitCacheLimit_`,
 *   `completedScreenTiles_`).
 *
 * Differences against Figma are recorded inline:
 * - Distance uses content bounds (gutters are not owned pixels), converted
 *   to canvas space. Every viewport-intersecting tile has distance zero.
 * - Our rasterization is async in the render worker, so the budget gates
 *   request submission per animation frame, not in-frame synchronous GPU work.
 *   The tile-count budget is the effective limiter; the time budget bounds the
 *   scheduling window of one frame tick.
 * - TODO(Figma parity, not implemented): 384 MiB tile-cache target
 *   (`_F.DEFAULT_TARGET_MEMORY_USAGE_IN_MB`) — our display residency keeps its
 *   own viewport-derived byte budget (displayTileBudget); generation-stamped
 *   LRU with `makeLeastRecent` devaluation (m4/m5) — our ExactTileCache is a
 *   plain byte-bounded LRU; adaptive devicePixelPerCanvasPixel with 2-frame
 *   debounce (mP) — our tiles are Sketch-style fixed LOD buckets, intentionally
 *   unchanged; the 250 RT-switch budget is recorded as
 *   TILE_FRAME_RENDER_TARGET_SWITCH_BUDGET but not enforced because the worker
 *   path exposes no per-frame render-target switch counter. */

/** Figma viewer `m2.defaultTimeBudgetInSeconds = .016`. */
export const DEFAULT_TILE_FRAME_TIME_BUDGET_MS = 16
/** Figma viewer `m2.defaultTileRenderingBudget = 2`. */
export const DEFAULT_TILE_FRAME_TILE_RENDER_BUDGET = 2
/** Figma viewer `m2.defaultRenderTargetSwitchBudget = 250`. Recorded for
 * parity only: our worker path has no per-frame RT-switch counter, so this
 * budget is never consulted. */
export const TILE_FRAME_RENDER_TARGET_SWITCH_BUDGET = 250

export type ViewportRect = { x: number; y: number; width: number; height: number }

/** Figma `brokeRenderAt` interruption reasons. `offscreenHitCacheLimit_` is
 * emitted for prefetch-rim tiles the planner dropped at plan time because the
 * resident-cache-derived plan limit had no room after the viewport tiles (our
 * analog of Figma's SKIPPED `ensureTileIsPopulated` result — a permanent
 * per-plan skip, not a per-frame retry); `tileOutsideViewport_` is not needed
 * because the queues are partitioned up front instead of breaking mid-list. */
export type TileBudgetCutoffReason =
  | 'offscreenHitBudget_'
  | 'offscreenHitCacheLimit_'
  | 'completedScreenTiles_'

/** Figma Se.canvasSpaceDistanceToViewport: tile.bounds().distanceTo(viewport).
 * Our grid is already world-aligned (the reference's transform scale is 1).
 * Strip the one-pixel transport gutters and the sampling phase first. */
export function tileViewportDistance(tile: RasterTile, viewport: ViewportRect): number {
  const scale = tile.zoom
  const left = (tile.x + 1 - (tile.phaseX || 0)) / scale
  const top = (tile.y + 1 - (tile.phaseY || 0)) / scale
  const right = left + (tile.width - 2) / scale
  const bottom = top + (tile.height - 2) / scale
  return Math.hypot(Math.max(viewport.x - right, left - viewport.x - viewport.width, 0),
    Math.max(viewport.y - bottom, top - viewport.y - viewport.height, 0))
}

/** Visible content overlap; gutters cannot buy the on-screen exemption. */
export function tileOverlapsViewport(tile: RasterTile, viewport: ViewportRect): boolean {
  const scale = tile.zoom,
    left = viewport.x * scale,
    top = viewport.y * scale,
    right = left + viewport.width * scale,
    bottom = top + viewport.height * scale
  const x = tile.x + 1 - (tile.phaseX || 0), y = tile.y + 1 - (tile.phaseY || 0)
  return x < right && x + tile.width - 2 > left && y < bottom && y + tile.height - 2 > top
}

export type PrioritizedTileFill = { onScreen: RasterTile[]; offScreen: RasterTile[] }

/** Partition a fill set into on-screen (viewport-intersecting) and off-screen
 * tiles. Both classes sort by viewport distance ascending; equal distances
 * keep stable row order (y, then x) — the order Figma's row-major
 * `forEachTileWithinBounds` produces for its distance-0 on-screen ties.
 * Tiles planned with `prefetch` (the rim around the viewport set) are always
 * off-screen: their one-pixel overlap gutters can touch the viewport edge,
 * but gutter pixels alone must never buy the on-screen budget exemption. */
export function prioritizeTileFill(tiles: RasterTile[], viewport: ViewportRect): PrioritizedTileFill {
  const ranked = tiles.map((tile, index) => ({
    tile,
    index,
    onScreen: tile.prefetch !== true && tileOverlapsViewport(tile, viewport),
    distance: tileViewportDistance(tile, viewport),
  }))
  const byDistanceThenRow = (
    a: (typeof ranked)[number],
    b: (typeof ranked)[number],
  ) => {
    const distance = a.distance - b.distance
    if (Math.abs(distance) > 1e-6) return distance
    return a.tile.y - b.tile.y || a.tile.x - b.tile.x || a.index - b.index
  }
  const onScreen = ranked.filter((entry) => entry.onScreen).sort(byDistanceThenRow)
  const offScreen = ranked.filter((entry) => !entry.onScreen).sort(byDistanceThenRow)
  return { onScreen: onScreen.map((entry) => entry.tile), offScreen: offScreen.map((entry) => entry.tile) }
}

export type TileFrameBudgetOptions = {
  /** Per-frame scheduling window in milliseconds. Default 16 (Figma). */
  timeBudgetMs?: number
  /** Tile rasterizations permitted per frame. Default 2 (Figma). */
  tileRenderBudget?: number
  /** Injectable clock for deterministic tests (Figma mirrors this with
   * `useDeterministicTimeBudgetForTests`). */
  now?: () => number
}

const wallClock =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now()

/** Per-frame budget, the analog of Figma viewer's `m2` FrameBudget. On-screen
 * work runs under `permitWorkAfterBudgetExceeded()` and ignores the budget;
 * off-screen work is forced through `permitsMoreWork()`. Tile rasterizations
 * are always recorded (Figma's `recordTileWasRendered`), so on-screen tiles
 * spend the frame's budget first and prefetch only runs with the remainder of
 * later frames. */
export class TileFrameBudget {
  readonly timeBudgetMs: number
  readonly tileRenderBudget: number
  private readonly now: () => number
  private frameStartMs = 0
  private tileRendersRemaining = 0
  private overrideBudget = false

  constructor(options: TileFrameBudgetOptions = {}) {
    this.timeBudgetMs = options.timeBudgetMs ?? DEFAULT_TILE_FRAME_TIME_BUDGET_MS
    this.tileRenderBudget = options.tileRenderBudget ?? DEFAULT_TILE_FRAME_TILE_RENDER_BUDGET
    this.now = options.now ?? wallClock
    if (!Number.isFinite(this.timeBudgetMs) || this.timeBudgetMs <= 0)
      throw new Error('Invalid tile frame time budget')
    if (!Number.isSafeInteger(this.tileRenderBudget) || this.tileRenderBudget <= 0)
      throw new Error('Invalid tile frame render budget')
  }

  beginFrame() {
    this.frameStartMs = this.now()
    this.tileRendersRemaining = this.tileRenderBudget
  }

  permitsMoreWork() {
    return (
      this.overrideBudget ||
      (this.tileRendersRemaining > 0 && this.now() - this.frameStartMs < this.timeBudgetMs)
    )
  }

  recordTileWasRendered() {
    this.tileRendersRemaining--
  }

  /** On-screen exemption (Figma m2 API): work continues past every budget. */
  permitWorkAfterBudgetExceeded() {
    this.overrideBudget = true
  }

  forbidWorkAfterBudgetExceeded() {
    this.overrideBudget = false
  }

  pastTimeBudgetMs() {
    return this.now() - this.frameStartMs - this.timeBudgetMs
  }

  tileRendersRemainingInFrame() {
    return this.tileRendersRemaining
  }
}

/** Frame-cadence driver. requestAnimationFrame in browser hosts; an immediate
 * timeout keeps workers and non-DOM test hosts functional. */
export type TileFrameDriver = { scheduleFrame(callback: () => void): () => void }

export const rafTileFrameDriver: TileFrameDriver = {
  scheduleFrame(callback) {
    if (typeof requestAnimationFrame === 'function') {
      const handle = requestAnimationFrame(() => callback())
      return () => cancelAnimationFrame(handle)
    }
    const timer = setTimeout(callback, 0)
    return () => clearTimeout(timer)
  },
}

export type TileFillCounters = {
  frames: number
  onScreenSubmitted: number
  offScreenSubmitted: number
  /** Cumulative tile deferrals (tiles waiting at a frame cut). */
  deferredTiles: number
  /** Cumulative prefetch tiles dropped by the plan's cache allowance. */
  cacheSkippedTiles: number
  cutoffs: {
    offscreenHitBudget: number
    offscreenHitCacheLimit: number
    completedScreenTiles: number
  }
}

export type TileFillSchedulerConfig = {
  /** Submit one frame's rasterization requests. The scheduler awaits each
   * chunk before pacing the next frame; rejections abort the fill. */
  submit: (tiles: RasterTile[]) => Promise<void> | void
  viewport: ViewportRect
  driver?: TileFrameDriver
  budget?: TileFrameBudgetOptions
  /** Interruption-reason accounting hook (stats/telemetry surface). */
  onCutoff?: (reason: TileBudgetCutoffReason, counters: TileFillCounters) => void
}

/** Two-phase tile fill driver mirroring Figma's draw loop:
 * 1. on-screen tiles are submitted in full, exempt from the frame budget
 *    (Figma's `drawOnScreenTiles` + `permitWorkAfterBudgetExceeded`);
 * 2. off-screen tiles are submitted while `permitsMoreWork()` holds; budget
 *    exhaustion defers the remainder to the next frame (never drops a tile —
 *    `drawOffScreenTiles` records `offscreenHitBudget_` and resumes later).
 * The first tick runs synchronously so first paint never waits a frame. */
export class TileFillScheduler {
  readonly counters: TileFillCounters = {
    frames: 0,
    onScreenSubmitted: 0,
    offScreenSubmitted: 0,
    deferredTiles: 0,
    cacheSkippedTiles: 0,
    cutoffs: { offscreenHitBudget: 0, offscreenHitCacheLimit: 0, completedScreenTiles: 0 },
  }
  private readonly config: TileFillSchedulerConfig
  private readonly budget: TileFrameBudget
  private onScreen: RasterTile[] = []
  private offScreen: RasterTile[] = []
  private cancelled = false
  private cancelFrame: (() => void) | undefined
  private settle: (() => void) | undefined
  private abort: ((error: unknown) => void) | undefined

  constructor(config: TileFillSchedulerConfig) {
    this.config = config
    this.budget = new TileFrameBudget(config.budget)
  }

  fill(tiles: RasterTile[]): Promise<void> {
    if (this.cancelled) return Promise.resolve()
    const prioritized = prioritizeTileFill(tiles, this.config.viewport)
    this.onScreen = prioritized.onScreen
    this.offScreen = prioritized.offScreen
    return new Promise<void>((resolve, reject) => {
      this.settle = resolve
      this.abort = reject
      void this.tick()
    })
  }

  /** Abandons the remaining queues (a superseding plan). Budget deferral never
   * drops tiles; cancellation is a staleness axis owned by the caller, whose
   * in-flight requests are cancelled separately (KernelClient.cancelPreview). */
  cancel() {
    if (this.cancelled) return
    this.cancelled = true
    this.onScreen = []
    this.offScreen = []
    this.cancelFrame?.()
    this.cancelFrame = undefined
    this.settle?.()
  }

  /** Accounts prefetch-rim tiles the planner dropped because the plan limit
   * (the resident-cache-derived tile allowance) was exhausted by the viewport
   * set. Figma's draw loop emits `offscreenHitCacheLimit_` when
   * `ensureTileIsPopulated` returns SKIPPED mid-frame (atlas at capacity); our
   * cache arm is the plan-time allowance, so one event per fill records the
   * whole skipped band. No-op on a cancelled scheduler. */
  recordOffscreenCacheLimitSkips(count: number) {
    if (this.cancelled || !Number.isSafeInteger(count) || count <= 0) return
    this.counters.cutoffs.offscreenHitCacheLimit++
    this.counters.cacheSkippedTiles += count
    this.config.onCutoff?.('offscreenHitCacheLimit_', this.counters)
  }

  private scheduleNextFrame() {
    const driver = this.config.driver ?? rafTileFrameDriver
    this.cancelFrame = driver.scheduleFrame(() => {
      this.cancelFrame = undefined
      void this.tick()
    })
  }

  private async tick(): Promise<void> {
    if (this.cancelled) {
      this.settle?.()
      return
    }
    this.budget.beginFrame()
    this.counters.frames++
    try {
      // Phase 1 — on-screen tiles: budget-exempt, full completion.
      if (this.onScreen.length) {
        const chunk = this.onScreen
        this.onScreen = []
        this.budget.permitWorkAfterBudgetExceeded()
        try {
          for (let i = 0; i < chunk.length; i++) this.budget.recordTileWasRendered()
          this.counters.onScreenSubmitted += chunk.length
          await this.config.submit(chunk)
        } finally {
          this.budget.forbidWorkAfterBudgetExceeded()
        }
        if (this.cancelled) {
          this.settle?.()
          return
        }
      }
      // Phase 2 — off-screen (prefetch) tiles: budget enforced. One
      // rasterization per pass: each submit awaits real work (the worker
      // round-trip), so Figma's time budget is meaningfully re-checked between
      // rasterizations, not only between multi-tile batches.
      while (!this.cancelled && this.offScreen.length && this.budget.permitsMoreWork()) {
        const next = this.offScreen.shift()
        if (!next) break
        this.budget.recordTileWasRendered()
        this.counters.offScreenSubmitted++
        await this.config.submit([next])
      }
      if (this.cancelled) {
        this.settle?.()
        return
      }
      if (this.offScreen.length) {
        // Budget cut: record the Figma interruption reason and defer.
        this.counters.deferredTiles += this.offScreen.length
        this.counters.cutoffs.offscreenHitBudget++
        this.config.onCutoff?.('offscreenHitBudget_', this.counters)
        this.scheduleNextFrame()
      } else {
        this.counters.cutoffs.completedScreenTiles++
        this.config.onCutoff?.('completedScreenTiles_', this.counters)
        this.settle?.()
      }
    } catch (error) {
      this.cancelled = true
      this.onScreen = []
      this.offScreen = []
      this.abort?.(error)
    }
  }
}

/** Product-default budget options: Figma values, optionally pinned by the
 * host through the house localStorage pattern (read per scheduler; storage is
 * optional and absent in non-browser hosts). */
export function tileFrameBudgetOptionsFromHost(): TileFrameBudgetOptions {
  let timeBudgetMs: number | undefined,
    tileRenderBudget: number | undefined
  try {
    const ms = Number(localStorage.getItem('forma.render.tileFrameMs'))
    if (Number.isFinite(ms) && ms > 0) timeBudgetMs = ms
    const tiles = Number(localStorage.getItem('forma.render.tileFrameTiles'))
    if (Number.isSafeInteger(tiles) && tiles > 0) tileRenderBudget = tiles
  } catch {
    /* Storage is optional; Figma defaults apply. */
  }
  return { timeBudgetMs, tileRenderBudget }
}
