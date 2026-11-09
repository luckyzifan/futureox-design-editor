import type { RasterTile } from './tile-cache'


/** Figma viewer `m2.defaultTimeBudgetInSeconds = .016`. */
export const DEFAULT_TILE_FRAME_TIME_BUDGET_MS = 16
/** Figma viewer `m2.defaultTileRenderingBudget = 2`. */
export const DEFAULT_TILE_FRAME_TILE_RENDER_BUDGET = 2
/** Figma viewer `m2.defaultRenderTargetSwitchBudget = 250`. Recorded for
 * parity only: our worker path has no per-frame RT-switch counter, so this
 * budget is never consulted. */
export const TILE_FRAME_RENDER_TARGET_SWITCH_BUDGET = 250

export type ViewportRect = { x: number; y: number; width: number; height: number }

export type TileBudgetCutoffReason =
  | 'offscreenHitBudget_'
  | 'offscreenHitCacheLimit_'
  | 'completedScreenTiles_'

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
 * tiles. Visible tiles sort center-out, with input order breaking equal
 * center distances. Off-screen tiles retain viewport-distance / row order.
 * Coverage repair can then stably promote visible holes before batch slicing.
 * Tiles planned with `prefetch` (the rim around the viewport set) are always
 * off-screen: their one-pixel overlap gutters can touch the viewport edge,
 * but gutter pixels alone must never buy the on-screen budget exemption. */
export function prioritizeTileFill(tiles: RasterTile[], viewport: ViewportRect): PrioritizedTileFill {
  const centerX = viewport.x + viewport.width / 2, centerY = viewport.y + viewport.height / 2
  const ranked = tiles.map((tile, index) => ({
    tile,
    index,
    onScreen: tile.prefetch !== true && tileOverlapsViewport(tile, viewport),
    distance: tileViewportDistance(tile, viewport),
    centerDistance: Math.hypot((tile.x + tile.width / 2 - (tile.phaseX || 0)) / tile.zoom - centerX,
      (tile.y + tile.height / 2 - (tile.phaseY || 0)) / tile.zoom - centerY),
  }))
  const byDistanceThenRow = (
    a: (typeof ranked)[number],
    b: (typeof ranked)[number],
  ) => {
    const distance = a.distance - b.distance
    if (Math.abs(distance) > 1e-6) return distance
    return a.tile.y - b.tile.y || a.tile.x - b.tile.x || a.index - b.index
  }
  const onScreen = ranked.filter((entry) => entry.onScreen).sort((a, b) =>
    a.centerDistance - b.centerDistance || a.index - b.index)
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
