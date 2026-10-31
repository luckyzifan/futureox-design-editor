import { describe, expect, test, vi } from 'vitest'
import { planTiles, type RasterTile } from './tile-cache'
import {
  DEFAULT_TILE_FRAME_TIME_BUDGET_MS,
  DEFAULT_TILE_FRAME_TILE_RENDER_BUDGET,
  prioritizeTileFill,
  rafTileFrameDriver,
  TileFillScheduler,
  TileFrameBudget,
  tileOverlapsViewport,
  tileViewportDistance,
  type TileBudgetCutoffReason,
  type TileFrameDriver,
} from './tile-scheduler'

/** Planned tiles carry the production geometry: 512 px content plus the
 * one-pixel overlap gutters on each side. */
const TILE_SIDE = 514
function tile(x: number, y: number, zoom = 1): RasterTile {
  return { key: `${zoom}:0:0:${x}:${y}`, x, y, width: TILE_SIDE, height: TILE_SIDE, zoom }
}
/** Planned prefetch-rim tile: off-screen by contract even when its overlap
 * gutter touches the viewport edge. */
function rimTile(x: number, y: number, zoom = 1): RasterTile {
  return { ...tile(x, y, zoom), key: `p:${zoom}:0:0:${x}:${y}`, prefetch: true }
}
function manualDriver() {
  const frames: (() => void)[] = []
  const driver: TileFrameDriver = {
    scheduleFrame(callback) {
      frames.push(callback)
      return () => {
        const index = frames.indexOf(callback)
        if (index >= 0) frames.splice(index, 1)
      }
    },
  }
  return {
    driver,
    pendingFrames: () => frames.length,
    flush() {
      for (const frame of frames.splice(0)) frame()
    },
  }
}
function clock(startMs = 0) {
  let now = startMs
  return {
    now: () => now,
    advance(ms: number) {
      now += ms
    },
  }
}
/** Each scheduler tick awaits its (synchronous) submit per pass, so its
 * continuation lands one microtask later; flush enough of them. */
async function settleMicrotasks(times = 12) {
  for (let i = 0; i < times; i++) await Promise.resolve()
}
const viewport = { x: 0, y: 0, width: 1024, height: 1024 }

describe('viewport-distance priority', () => {
  test('Figma frame-budget defaults are pinned (16 ms / 2 rasterizations)', () => {
    // m2.defaultTimeBudgetInSeconds = .016, m2.defaultTileRenderingBudget = 2
    expect(DEFAULT_TILE_FRAME_TIME_BUDGET_MS).toBe(16)
    expect(DEFAULT_TILE_FRAME_TILE_RENDER_BUDGET).toBe(2)
  })

  test('canvas-space distance and overlap classification', () => {
    expect(tileViewportDistance(tile(0, 0), viewport)).toBe(0)
    expect(tileViewportDistance(tile(1000, 0), viewport)).toBe(0)
    expect(tileViewportDistance(tile(0, 1000), viewport)).toBe(0)
    expect(tileViewportDistance(tile(2000, 0), viewport)).toBeCloseTo(977, 6)
    expect(tileViewportDistance(tile(2000, 0, 2), { x: 0, y: 0, width: 512, height: 512 })).toBe(488.5)
    expect(tileOverlapsViewport(tile(0, 0), viewport)).toBe(true)
    // Adjacent without overlap stays off-screen.
    expect(tileOverlapsViewport(tile(1024, 0), viewport)).toBe(false)
    expect(tileOverlapsViewport(tile(2000, 0), viewport)).toBe(false)
    // The world viewport scales into each tile's own zoom space.
    expect(tileOverlapsViewport(tile(0, 0, 2), { x: 0, y: 0, width: 512, height: 512 })).toBe(true)
    expect(tileOverlapsViewport(tile(0, 0, 2), { x: 300, y: 0, width: 100, height: 100 })).toBe(false)
  })

  test('visible tiles are center-first; off-screen tiles keep distance / row order', () => {
    // Centers: interior tiles sit inside the viewport (distance 0); the edge
    // tile overlaps but its center is 233 px outside; off-screen tiles sit at
    // 1233 (four row-tied placements) and 2233 px.
    const interiorA = tile(0, 0), interiorB = tile(500, 0), edge = tile(1000, 0)
    const rowTieLeft = tile(-1490, 0), rowTieRight = tile(2000, 0)
    const tieLowRow = tile(2000, 143), tieHighRow = tile(2000, 343)
    const far = tile(3000, 0)
    const ranked = prioritizeTileFill(
      [far, tieHighRow, interiorB, rowTieLeft, edge, rowTieRight, interiorA, tieLowRow],
      viewport,
    )
    expect(ranked.onScreen.map((t) => t.key)).toEqual([interiorB.key, interiorA.key, edge.key])
    expect(ranked.offScreen.map((t) => t.key)).toEqual([
      rowTieLeft.key, rowTieRight.key, tieLowRow.key, tieHighRow.key, far.key,
    ])
  })

  test('a production center-out plan is not reset to its top-left row', () => {
    const bounds = { x: 0, y: 0, width: 2560, height: 2560 }
    const planned = planTiles(bounds, 1)
    const ranked = prioritizeTileFill(planned, bounds).onScreen
    expect(ranked[0]).toBe(planned[0])
    expect(ranked[0].key).toBe('1:0:0:2:2')
    expect(ranked).toHaveLength(planned.length)
    expect(new Set(ranked)).toEqual(new Set(planned))
    // Four exactly equidistant neighbours retain their input order.
    const ties = planned.filter(t => Math.abs(t.x + 257 - 1280) + Math.abs(t.y + 257 - 1280) === 512)
    expect(prioritizeTileFill(ties, bounds).onScreen).toEqual(ties)
  })
})

describe('frame budget', () => {
  test('mirrors Figma m2 accounting: per-frame reset, overspend, exemption', () => {
    const c = clock(100)
    const budget = new TileFrameBudget({ now: c.now })
    budget.beginFrame()
    expect(budget.tileRendersRemainingInFrame()).toBe(2)
    expect(budget.permitsMoreWork()).toBe(true)
    // On-screen tiles may overspend the frame's rasterization budget.
    budget.recordTileWasRendered()
    budget.recordTileWasRendered()
    budget.recordTileWasRendered()
    expect(budget.permitsMoreWork()).toBe(false)
    budget.permitWorkAfterBudgetExceeded()
    expect(budget.permitsMoreWork()).toBe(true)
    budget.forbidWorkAfterBudgetExceeded()
    expect(budget.permitsMoreWork()).toBe(false)
    // A fresh frame restores both budget arms.
    c.advance(5)
    budget.beginFrame()
    expect(budget.permitsMoreWork()).toBe(true)
    expect(budget.pastTimeBudgetMs()).toBeLessThanOrEqual(0)
    c.advance(DEFAULT_TILE_FRAME_TIME_BUDGET_MS)
    expect(budget.permitsMoreWork()).toBe(false)
    expect(budget.pastTimeBudgetMs()).toBeGreaterThanOrEqual(0)
  })

  test('rejects non-positive budgets', () => {
    expect(() => new TileFrameBudget({ timeBudgetMs: 0 })).toThrow()
    expect(() => new TileFrameBudget({ tileRenderBudget: 0 })).toThrow()
    expect(() => new TileFrameBudget({ tileRenderBudget: 1.5 })).toThrow()
  })
})

describe('tile fill scheduling', () => {
  test('on-screen tiles are exempt from the budget; off-screen defer frame by frame', async () => {
    const manual = manualDriver()
    const c = clock()
    const chunks: string[][] = []
    const cutoffs: TileBudgetCutoffReason[] = []
    const onScreen = [tile(0, 0), tile(500, 0), tile(0, 500)]
    const offScreen = [tile(2000, 0), tile(3000, 0), tile(4000, 0)]
    const scheduler = new TileFillScheduler({
      submit: (batch) => {
        chunks.push(batch.map((t) => t.key))
      },
      viewport,
      driver: manual.driver,
      budget: { now: c.now },
      onCutoff: (reason) => cutoffs.push(reason),
    })
    const done = scheduler.fill([...offScreen, ...onScreen])
    // First tick starts synchronously: all three on-screen tiles submit at
    // once although the budget permits only 2 rasterizations per frame.
    expect(chunks).toEqual([[onScreen[1].key, onScreen[2].key, onScreen[0].key]])
    await settleMicrotasks()
    expect(cutoffs).toEqual(['offscreenHitBudget_'])
    expect(scheduler.counters.deferredTiles).toBe(3)
    expect(scheduler.counters.onScreenSubmitted).toBe(3)
    // Later frames submit the budgeted 2 off-screen tiles each.
    manual.flush()
    await settleMicrotasks()
    expect(chunks[1]).toEqual([offScreen[0].key])
    expect(chunks[2]).toEqual([offScreen[1].key])
    expect(cutoffs).toEqual(['offscreenHitBudget_', 'offscreenHitBudget_'])
    manual.flush()
    await settleMicrotasks()
    expect(chunks[3]).toEqual([offScreen[2].key])
    expect(cutoffs).toEqual([
      'offscreenHitBudget_', 'offscreenHitBudget_', 'completedScreenTiles_',
    ])
    await done
    // Nothing dropped: every tile was submitted exactly once.
    expect(chunks.flat().sort()).toEqual([...onScreen, ...offScreen].map((t) => t.key).sort())
    expect(scheduler.counters.offScreenSubmitted).toBe(3)
  })

  test('the 16 ms time budget cuts a frame even with rasterization budget left', async () => {
    const manual = manualDriver()
    const c = clock()
    const chunks: string[][] = []
    const cutoffs: TileBudgetCutoffReason[] = []
    const offScreen = [tile(2000, 0), tile(3000, 0), tile(4000, 0)]
    const scheduler = new TileFillScheduler({
      submit: (batch) => {
        chunks.push(batch.map((t) => t.key))
        // Each submission awaits real work; simulate a 20 ms worker round-trip
        // so the frame's 16 ms window is exhausted after the first tile.
        c.advance(20)
      },
      viewport,
      driver: manual.driver,
      budget: { now: c.now, tileRenderBudget: 99, timeBudgetMs: 16 },
      onCutoff: (reason) => cutoffs.push(reason),
    })
    const done = scheduler.fill(offScreen)
    expect(chunks).toEqual([[offScreen[0].key]])
    await settleMicrotasks()
    expect(cutoffs).toEqual(['offscreenHitBudget_'])
    manual.flush()
    await settleMicrotasks()
    expect(chunks[1]).toEqual([offScreen[1].key])
    manual.flush()
    await settleMicrotasks()
    expect(chunks[2]).toEqual([offScreen[2].key])
    expect(cutoffs[cutoffs.length - 1]).toBe('completedScreenTiles_')
    await done
    expect(chunks).toHaveLength(3)
  })

  test('budget constants are configurable: 3 rasterizations per frame', async () => {
    const manual = manualDriver()
    const c = clock()
    const sizes: number[] = []
    const offScreen = [1, 2, 3, 4, 5, 6].map((i) => tile(2000 + i * 1000, 0))
    const scheduler = new TileFillScheduler({
      submit: (batch) => {
        sizes.push(batch.length)
      },
      viewport,
      driver: manual.driver,
      budget: { now: c.now, tileRenderBudget: 3 },
    })
    const done = scheduler.fill(offScreen)
    await settleMicrotasks()
    expect(sizes).toEqual([1, 1, 1])
    manual.flush()
    await settleMicrotasks()
    expect(sizes).toEqual([1, 1, 1, 1, 1, 1])
    await done
    expect(scheduler.counters.cutoffs.offscreenHitBudget).toBe(1)
    expect(scheduler.counters.cutoffs.completedScreenTiles).toBe(1)
  })

  test('cancellation stops deferral without rejecting the fill', async () => {
    const manual = manualDriver()
    const c = clock()
    const chunks: string[][] = []
    const scheduler = new TileFillScheduler({
      submit: (batch) => {
        chunks.push(batch.map((t) => t.key))
      },
      viewport,
      driver: manual.driver,
      budget: { now: c.now },
    })
    const done = scheduler.fill([tile(0, 0), tile(500, 0), tile(2000, 0), tile(3000, 0)])
    expect(chunks).toEqual([[tile(500, 0).key, tile(0, 0).key]])
    await settleMicrotasks()
    scheduler.cancel()
    manual.flush()
    manual.flush()
    await settleMicrotasks()
    expect(chunks).toHaveLength(1)
    await done
    // A cancelled scheduler refuses further fills.
    await expect(scheduler.fill([tile(0, 0)])).resolves.toBeUndefined()
    expect(chunks).toHaveLength(1)
  })

  test('empty fill sets complete without work', async () => {
    const manual = manualDriver()
    const cutoffs: TileBudgetCutoffReason[] = []
    const scheduler = new TileFillScheduler({
      submit: () => {
        throw new Error('no submission expected')
      },
      viewport,
      driver: manual.driver,
      onCutoff: (reason) => cutoffs.push(reason),
    })
    await scheduler.fill([])
    expect(cutoffs).toEqual(['completedScreenTiles_'])
    expect(manual.pendingFrames()).toBe(0)
  })

  test('a rejected submission aborts the fill with the worker error', async () => {
    const manual = manualDriver()
    const c = clock()
    const scheduler = new TileFillScheduler({
      submit: () => {
        throw new Error('GPU surface budget exceeded')
      },
      viewport,
      driver: manual.driver,
      budget: { now: c.now },
    })
    await expect(scheduler.fill([tile(0, 0)])).rejects.toThrow('GPU surface budget exceeded')
  })

  test('driver falls back to a timer without requestAnimationFrame', () => {
    vi.useFakeTimers()
    try {
      const fired: number[] = []
      const cancel = rafTileFrameDriver.scheduleFrame(() => fired.push(1))
      expect(fired).toHaveLength(0)
      vi.advanceTimersByTime(1)
      expect(fired).toHaveLength(1)
      cancel()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('prefetch rim scheduling', () => {
  test('a prefetch-marked tile stays off-screen even when its gutter overlaps the viewport', () => {
    // Tile at device x=1023 covers [1023,1537): its one-pixel gutter overlaps
    // the 1024-viewport — geometry alone would classify it on-screen.
    const gutterTouch = tile(1023, 0)
    expect(tileOverlapsViewport(gutterTouch, viewport)).toBe(false)
    const ranked = prioritizeTileFill([rimTile(1023, 0)], viewport)
    expect(ranked.onScreen).toHaveLength(0)
    expect(ranked.offScreen.map((t) => t.key)).toEqual([rimTile(1023, 0).key])
  })

  test('on-screen tiles deliver first; rim tiles pace under the budget and none are dropped', async () => {
    const manual = manualDriver()
    const c = clock()
    const chunks: string[][] = []
    const cutoffs: TileBudgetCutoffReason[] = []
    const onScreen = [tile(0, 0), tile(500, 0)]
    const rim = [rimTile(1030, 0), rimTile(1030, 520), rimTile(1550, 0), rimTile(-530, 0)]
    const scheduler = new TileFillScheduler({
      submit: (batch) => {
        chunks.push(batch.map((t) => t.key))
      },
      viewport,
      driver: manual.driver,
      budget: { now: c.now },
      onCutoff: (reason) => cutoffs.push(reason),
    })
    const done = scheduler.fill([...rim, ...onScreen])
    // The whole viewport plan submits in the first exempt chunk; the rim is
    // deferred behind the frame its on-screen tiles spent.
    expect(chunks).toEqual([[onScreen[1].key, onScreen[0].key]])
    await settleMicrotasks()
    expect(cutoffs).toEqual(['offscreenHitBudget_'])
    expect(scheduler.counters.deferredTiles).toBe(4)
    manual.flush()
    await settleMicrotasks()
    // Rim ordering inside a frame follows viewport distance (263/263, then
    // 273, then 783 px), so the far pair lands last regardless of input order.
    expect(chunks.slice(1).flat()).toEqual([rim[0].key, rim[1].key])
    manual.flush()
    await settleMicrotasks()
    expect(chunks.slice(3).flat().sort()).toEqual([rim[2].key, rim[3].key].sort())
    expect(cutoffs).toEqual(['offscreenHitBudget_', 'offscreenHitBudget_', 'completedScreenTiles_'])
    await done
    expect(chunks.flat().sort()).toEqual([...onScreen, ...rim].map((t) => t.key).sort())
    expect(scheduler.counters.onScreenSubmitted).toBe(2)
    expect(scheduler.counters.offScreenSubmitted).toBe(4)
  })

  test('cache-limit rim skips are accounted as offscreenHitCacheLimit_', () => {
    const cutoffs: TileBudgetCutoffReason[] = []
    const scheduler = new TileFillScheduler({
      submit: () => {},
      viewport,
      onCutoff: (reason) => cutoffs.push(reason),
    })
    scheduler.recordOffscreenCacheLimitSkips(7)
    expect(cutoffs).toEqual(['offscreenHitCacheLimit_'])
    expect(scheduler.counters.cutoffs.offscreenHitCacheLimit).toBe(1)
    expect(scheduler.counters.cacheSkippedTiles).toBe(7)
    // Non-positive or fractional counts are ignored; events vs tiles differ.
    scheduler.recordOffscreenCacheLimitSkips(0)
    scheduler.recordOffscreenCacheLimitSkips(-3)
    scheduler.recordOffscreenCacheLimitSkips(2.5)
    expect(scheduler.counters.cutoffs.offscreenHitCacheLimit).toBe(1)
    expect(scheduler.counters.cacheSkippedTiles).toBe(7)
    // A cancelled scheduler (superseded plan) stops accounting entirely.
    scheduler.cancel()
    scheduler.recordOffscreenCacheLimitSkips(4)
    expect(scheduler.counters.cutoffs.offscreenHitCacheLimit).toBe(1)
    expect(scheduler.counters.cacheSkippedTiles).toBe(7)
  })

  test('cancelling a superseding plan drops the deferred rim without rejecting', async () => {
    const manual = manualDriver()
    const c = clock()
    const chunks: string[][] = []
    const rim = [1, 2, 3, 4].map((i) => rimTile(1030 + i * 600, 0))
    const scheduler = new TileFillScheduler({
      submit: (batch) => {
        chunks.push(batch.map((t) => t.key))
      },
      viewport,
      driver: manual.driver,
      budget: { now: c.now },
    })
    const done = scheduler.fill([tile(0, 0), tile(500, 0), ...rim])
    expect(chunks).toEqual([[tile(500, 0).key, tile(0, 0).key]])
    await settleMicrotasks()
    // Camera moved: the pending rim queue is abandoned before any frame runs.
    scheduler.cancel()
    manual.flush()
    manual.flush()
    await settleMicrotasks()
    expect(chunks).toHaveLength(1)
    await done
    expect(scheduler.counters.offScreenSubmitted).toBe(0)
  })
})
