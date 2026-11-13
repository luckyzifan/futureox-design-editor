import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { expect, test } from 'vitest'
import { zoom_refine_admit } from '../generated/design-kernel/design_kernel'
import { navigationOverview } from './navigation-overview'
import {
  admitAction, admitPreparedTile, admitReason, scheduleZoomRefine, takeScheduleCalls,
  type RefineFacts, type RefineHooks,
} from './zoom-refine-schedule'

const none: RefineHooks = {
  measureStrip: () => { throw Error('strip was not requested') },
  outwardCover: () => { throw Error('outward cover was not requested') },
  overviewCandidates: () => { throw Error('page overview was not requested') },
  prefetchCount: () => { throw Error('prefetch was not requested') },
}

function facts(patch: Partial<RefineFacts> = {}): RefineFacts {
  return {
    moving: false, continuousZoom: false, zoomingIn: false, panned: false, translated: false,
    translationFollow: false, firstNative: false, cpuOnly: false, residentsCover: false, hasBacking: true,
    outwardCover: false, outwardKnown: true, materialKeys: false, prefetchNotReady: false, overviewMode: false,
    pipelineFullSource: false, exactLattice: true, canBuildStrip: false, hasStrip: false, stripCached: false,
    pasteboard: false, stripMeasured: false, overviewSupplied: false, prefetchSupplied: false, overviewReady: false,
    costlyOverview: false, overviewIsCold: false, exactMissing: 0, overviewCandidates: 0, prefetchMissing: 0,
    optionalDelayMs: 0, rasterScale: 1, shownCount: 0, tileCount: 4, coldBudget: 1, sourceNodes: 20,
    sourceWidth: 2000, sourceHeight: 2000, ...patch,
  }
}

test('one action chain is traceable and does not release resources', () => {
  const zoomIn = scheduleZoomRefine(facts({
    moving: true, continuousZoom: true, zoomingIn: true, exactMissing: 4, canBuildStrip: true, hasBacking: false,
  }), none)
  const inward = scheduleZoomRefine(facts({
    moving: true, continuousZoom: true, zoomingIn: true, exactMissing: 4, materialKeys: true, hasBacking: true,
  }), none)
  const zoomOut = scheduleZoomRefine(facts({
    moving: true, continuousZoom: true, exactMissing: 0, canBuildStrip: true, shownCount: 4, sourceNodes: 4000,
    sourceWidth: 12000, sourceHeight: 12000,
  }), {
    ...none,
    measureStrip: () => ({ hasStrip: true, stripCached: false, pasteboard: true }),
    prefetchCount: () => 0,
  })
  const quiet = scheduleZoomRefine(facts({ exactMissing: 0, canBuildStrip: true }), {
    ...none,
    measureStrip: () => ({ hasStrip: true, stripCached: false, pasteboard: true }),
    prefetchCount: () => 0,
  })
  const exactFirst = scheduleZoomRefine(facts({
    exactMissing: 3, shownCount: 1, sourceNodes: 4000, sourceWidth: 9000, sourceHeight: 9000,
  }), none)
  const page = scheduleZoomRefine(facts({ exactMissing: 0, overviewReady: true, shownCount: 2 }), {
    ...none,
    overviewCandidates: () => 2,
    prefetchCount: () => 5,
  })
  expect([zoomIn, zoomOut, quiet, exactFirst, page].map(item => item.trace)).toEqual([
    'exact-viewport', 'stop-empty', 'strip-quiet', 'exact-viewport', 'overview',
  ])
  expect(zoomIn.batchLimit).toBe(2)
  expect(zoomIn.priority).toBe(1)
  expect(inward.batchLimit).toBe(1)
  expect(inward.suppressPrepare).toBe(true)
  expect(inward.releaseInUseResources).toBe(false)
  expect(quiet.batchLimit).toBe(1)
  expect(quiet.priority).toBe(0)
  expect(exactFirst.cohort).toBe('exact')
  expect(page.priority).toBe(2)
  for (const item of [zoomIn, zoomOut, quiet, exactFirst, page]) {
    expect(item.releaseCachedTiles).toBe(false)
    expect(item.releaseInUseResources).toBe(false)
  }
})

test('exact holes do not plan a page overview and use one packed call when no strip can be built', () => {
  let overview = 0
  takeScheduleCalls()
  const decision = scheduleZoomRefine(facts({
    moving: true, continuousZoom: true, zoomingIn: true, exactMissing: 4, shownCount: 2,
    sourceNodes: 4000, sourceWidth: 12000, sourceHeight: 8000, tileCount: 6, canBuildStrip: true,
  }), { ...none, overviewCandidates: () => { overview += 1; return 8 } })
  expect(decision.trace).toBe('exact-viewport')
  expect(decision.batchLimit).toBe(2)
  expect(decision.wantStrip).toBe(false)
  expect(overview).toBe(0)
  expect(takeScheduleCalls()).toBe(1)
})

test('a zoom-out with a buildable strip still does not plan the page while exact tiles are missing', () => {
  let overview = 0
  let strips = 0
  takeScheduleCalls()
  const decision = scheduleZoomRefine(facts({
    moving: true, continuousZoom: true, zoomingIn: false, exactMissing: 4, shownCount: 2,
    sourceNodes: 4000, sourceWidth: 12000, sourceHeight: 8000, canBuildStrip: true, hasBacking: false,
  }), {
    ...none,
    measureStrip: () => { strips += 1; return { hasStrip: true, stripCached: false, pasteboard: true } },
    overviewCandidates: () => { overview += 1; return 4 },
    outwardCover: () => false,
  })
  expect(decision.cohort).toBe('exact')
  expect(decision.trace).not.toBe('strip-quiet')
  expect(strips).toBe(1)
  expect(overview).toBe(0)
  expect(takeScheduleCalls()).toBe(2)
})

test('the settled eight-tile batch stays on the existing pipeline', () => {
  expect(scheduleZoomRefine(facts({ exactMissing: 2, overviewMode: true, rasterScale: 1 }), none).batchLimit).toBe(8)
  expect(scheduleZoomRefine(facts({
    exactMissing: 4, pipelineFullSource: true, exactLattice: true, rasterScale: 0.125, hasBacking: true,
  }), none).batchLimit).toBe(8)
  expect(scheduleZoomRefine(facts({
    exactMissing: 4, pipelineFullSource: true, exactLattice: false, rasterScale: 0.125, hasBacking: true,
  }), none).batchLimit).toBe(2)
  expect(scheduleZoomRefine(facts({
    exactMissing: 4, pipelineFullSource: true, exactLattice: true, rasterScale: 0.75, hasBacking: true,
  }), none).batchLimit).toBe(2)
  const cover = scheduleZoomRefine(facts({
    moving: true, continuousZoom: true, panned: true, exactMissing: 4, overviewMode: true, rasterScale: 1,
  }), none)
  expect(cover.batchLimit).toBe(1)
  expect(cover.reorderHoles).toBe(true)
  expect(cover.releaseInUseResources).toBe(false)
})

test('strip reasons and invalid quiet counts stay on the kernel schedule', () => {
  const strip = { ...none, measureStrip: () => ({ hasStrip: true, stripCached: false, pasteboard: true }) }
  expect(scheduleZoomRefine(facts({
    canBuildStrip: true, moving: true, continuousZoom: true, translated: true, exactMissing: 3,
  }), { ...strip, outwardCover: () => false }).trace).toBe('strip-translated')
  expect(scheduleZoomRefine(facts({
    canBuildStrip: true, moving: true, continuousZoom: true, translationFollow: true, exactMissing: 0, hasBacking: true,
  }), { ...none, measureStrip: () => ({ hasStrip: true, stripCached: false, pasteboard: false }) }).trace).toBe('strip-pan-follow')
  expect(scheduleZoomRefine(facts({
    canBuildStrip: true, hasBacking: false, exactMissing: 4,
  }), { ...strip, outwardCover: () => false }).trace).toBe('strip-bootstrap')
  expect(scheduleZoomRefine(facts({
    canBuildStrip: true, firstNative: true, exactMissing: 0,
  }), strip).trace).toBe('paint-first-native')
  expect(scheduleZoomRefine(facts({
    canBuildStrip: true, exactMissing: Number.NaN,
  }), strip).quietStrip).toBe(false)
  expect(scheduleZoomRefine(facts({
    canBuildStrip: true, exactMissing: -1,
  }), strip).wantStrip).toBe(false)
})

test('every preview fence matches the kernel and never releases resources', () => {
  for (let flags = 0; flags < 128; flags++) {
    const direct = zoom_refine_admit(flags) >>> 0
    const cached = admitPreparedTile(flags)
    expect(cached).toBe(direct)
    expect(direct & ~0b1111).toBe(0)
    expect(admitPreparedTile(flags)).toBe(cached)
    if (flags & 1) {
      expect(admitAction(cached)).toBe('cancel')
      expect(admitReason(cached)).toBe('aborted')
    }
  }
  const fill = admitPreparedTile(2 | 8 | 16)
  expect(admitAction(fill)).toBe('cancel')
  expect(admitReason(fill)).toBe('fill')
  expect(admitAction(admitPreparedTile(2 | 8 | 16 | 32 | 64))).toBe('cover-gap')
  expect(admitAction(admitPreparedTile(2 | 16))).toBe('continue')
  expect(() => admitPreparedTile(128)).toThrow('缩放精修调度无效')
})

test('the surface and worker no longer keep a second refine predicate', () => {
  const surface = readFileSync(new URL('./NativeSourceSurface.tsx', import.meta.url), 'utf8')
  const worker = readFileSync(new URL('./render-worker.ts', import.meta.url), 'utf8')
  const navigation = readFileSync(new URL('./navigation-overview.ts', import.meta.url), 'utf8')
  expect(surface.includes('scheduleZoomRefine(')).toBe(true)
  for (const name of ['coarsePanCoverNeeded', 'quietPasteStripAllowed', 'exactTilesBeforeOverview', 'allowsCoarsePanCover', 'choosePreparedTile', 'settledPipeline']) {
    expect(surface.includes(name)).toBe(false)
    expect(worker.includes(name)).toBe(false)
  }
  expect(navigation.includes('export function coarsePanCoverNeeded')).toBe(false)
  expect(worker.includes('admitPreparedTile(')).toBe(true)
  expect(worker.includes('const tileFence = (enforceFill: boolean, allowGapFill = false, canFillGap = false) =>')).toBe(true)
  expect(worker.includes("generation !== previewGenerations[channel]) throw")).toBe(false)
  expect(worker.includes('sourceSettledCohort')).toBe(false)
  expect(worker.includes('leadingCoarseTiles')).toBe(false)
})

test('skipping the page-range plan is faster than building it for the same large source', () => {
  const bounds = { x: 0, y: 0, width: 20000, height: 16000 }
  const eager = () => navigationOverview(bounds, 1, 4000)
  const scheduled = () => scheduleZoomRefine(facts({
    moving: true, continuousZoom: true, zoomingIn: true, exactMissing: 6, shownCount: 2,
    sourceNodes: 4000, sourceWidth: bounds.width, sourceHeight: bounds.height, tileCount: 8, canBuildStrip: true,
  }), none)
  for (let i = 0; i < 3; i++) { eager(); scheduled() }
  const time = (run: () => void) => {
    const start = performance.now()
    for (let i = 0; i < 20; i++) run()
    return performance.now() - start
  }
  const overviewMs = time(eager)
  const scheduleMs = time(scheduled)
  expect(overviewMs).toBeGreaterThan(scheduleMs * 2)
  expect(scheduled().trace).toBe('exact-viewport')
})
