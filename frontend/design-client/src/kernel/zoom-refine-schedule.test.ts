import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { zoom_refine_policy_json } from '../generated/design-kernel/design_kernel'
import {
  choosePreparedTile, coarsePanCoverNeeded, exactTilesBeforeOverview, quietPasteStripAllowed, selectZoomRefine,
  type RefineScheduleInput,
} from './zoom-refinement-policy'

const stopped: RefineScheduleInput = {
  moving: false, continuousZoom: false, zoomingIn: false, panned: false, translated: false,
  translationFollow: false, firstNative: false, hasStrip: false, stripCached: false, pasteboard: false,
  cpuOnly: false, residentsCover: false, hasBacking: true, exactMissing: 0, overviewCandidates: 0,
  prefetchMissing: 0, outwardCover: false, materialKeys: false, prefetchNotReady: false,
  optionalDelayMs: 0, overviewMode: false, pipelineFullSource: false, exactLattice: true, rasterScale: 1,
}

test('one action chain is traceable through the rust schedule and does not release resources', () => {
  const zoomIn = selectZoomRefine({
    ...stopped, moving: true, continuousZoom: true, zoomingIn: true, exactMissing: 4, hasStrip: true, pasteboard: true,
  })
  const zoomOut = selectZoomRefine({
    ...stopped, moving: true, continuousZoom: true, zoomingIn: false, exactMissing: 0, hasStrip: true, pasteboard: true,
  })
  const quiet = selectZoomRefine({ ...stopped, exactMissing: 0, hasStrip: true, pasteboard: true, hasBacking: true })
  const exactFirst = selectZoomRefine({ ...stopped, exactMissing: 3, overviewCandidates: 2 })
  const page = selectZoomRefine({ ...stopped, exactMissing: 0, overviewCandidates: 2 })
  expect([zoomIn, zoomOut, quiet, exactFirst, page].map(item => item.trace)).toEqual([
    'exact-viewport', 'stop-empty', 'strip-quiet', 'exact-viewport', 'overview',
  ])
  expect(zoomIn.batchLimit).toBe(2)
  expect(zoomIn.priority).toBe(1)
  expect(quiet.batchLimit).toBe(1)
  expect(quiet.priority).toBe(0)
  expect(exactFirst.cohort).toBe('exact')
  expect(page.priority).toBe(2)
  for (const item of [zoomIn, zoomOut, quiet, exactFirst, page]) {
    expect(item.releaseCachedTiles).toBe(false)
    expect(item.releaseInUseResources).toBe(false)
  }
  expect(exactTilesBeforeOverview(['a', 'b'], ['page'])).toEqual(['a', 'b'])
  expect(exactTilesBeforeOverview([], ['page'])).toEqual(['page'])
  expect(exactTilesBeforeOverview([], [])).toEqual([])
  expect(quietPasteStripAllowed({ moving: false, continuousZoom: false, exactMissing: 0 })).toBe(true)
  expect(quietPasteStripAllowed({ moving: true, continuousZoom: true, exactMissing: 0 })).toBe(false)
  expect(coarsePanCoverNeeded({
    firstNative: false, hasStrip: true, stripCached: false, pasteboard: true, cpuOnly: false, translated: false,
    moving: true, continuousZoom: true, translationFollow: false, residentsCover: true, quietStripAllowed: true,
  })).toBe(false)
})

test('the settled eight-tile batch stays on the existing pipeline', () => {
  expect(selectZoomRefine({
    ...stopped, exactMissing: 2, overviewMode: true, rasterScale: 1, hasStrip: false,
  }).batchLimit).toBe(8)
  expect(selectZoomRefine({
    ...stopped, exactMissing: 4, pipelineFullSource: true, exactLattice: true, rasterScale: 0.125, hasStrip: false,
  }).batchLimit).toBe(8)
  expect(selectZoomRefine({
    ...stopped, exactMissing: 4, pipelineFullSource: true, exactLattice: false, rasterScale: 0.125, hasStrip: false,
  }).batchLimit).toBe(2)
  expect(selectZoomRefine({
    ...stopped, exactMissing: 4, pipelineFullSource: true, exactLattice: true, rasterScale: 0.75, hasStrip: false,
  }).batchLimit).toBe(2)
  const cover = selectZoomRefine({
    ...stopped, moving: true, zoomingIn: false, continuousZoom: true, exactMissing: 4, overviewMode: true, rasterScale: 1,
  })
  expect(cover.batchLimit).toBe(1)
  expect(cover.reorderHoles).toBe(true)
  expect(cover.releaseInUseResources).toBe(false)
})

test('every preview fence matches the rust admit operation and never releases resources', () => {
  const flags = [false, true]
  for (const aborted of flags)
    for (const generationCurrent of flags)
      for (const fillCurrent of flags)
        for (const enforceFill of flags)
          for (const channelIsCanvas of flags)
            for (const allowGapFill of flags)
              for (const canFillGap of flags) {
                const input = { aborted, generationCurrent, fillCurrent, enforceFill, channelIsCanvas, allowGapFill, canFillGap }
                const js = choosePreparedTile(input)
                const rust = JSON.parse(zoom_refine_policy_json(JSON.stringify({ op: 'admit', ...input }))) as {
                  action: string; reason?: string; releaseInUse: boolean; releaseCachedTiles: boolean
                }
                expect(rust.action).toBe(js.action)
                expect(rust.reason).toBe(js.action === 'cancel' ? js.reason : undefined)
                expect(rust.releaseInUse).toBe(false)
                expect(rust.releaseCachedTiles).toBe(false)
                expect(js.releaseInUse).toBe(false)
              }
})

test('the surface and worker call the single schedule and fence', () => {
  const surface = readFileSync(new URL('./NativeSourceSurface.tsx', import.meta.url), 'utf8')
  const worker = readFileSync(new URL('./render-worker.ts', import.meta.url), 'utf8')
  expect(surface.includes('selectZoomRefine(')).toBe(true)
  expect(surface.includes('coarsePanCoverNeeded')).toBe(false)
  expect(surface.includes('quietPasteStripAllowed')).toBe(false)
  expect(surface.includes('exactTilesBeforeOverview')).toBe(false)
  expect(surface.includes('缩放精修取消不得释放仍在使用的资源')).toBe(true)
  expect(worker.includes('const admitPreview =')).toBe(true)
  expect(worker.includes('const previewCurrent = () => admitPreview(!!tileViewport).action !== \'cancel\'')).toBe(true)
  expect(worker.includes('const current = () => !packetWait')).toBe(false)
  expect(worker.includes('sourceSettledCohort')).toBe(false)
  expect(worker.includes('leadingCoarseTiles')).toBe(false)
})
