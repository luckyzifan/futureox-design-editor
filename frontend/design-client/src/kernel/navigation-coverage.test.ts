import { expect, test } from 'vitest'
import { captureMostlyOffscreen, captureVisibleFraction, liveNavigationCapture, navigationCoverageTiles, navigationHasCoverage, navigationCoverageFlight, navigationReadyDensity, previewUnderlayHides, retainedPressureError, viewportOverlapFraction } from './navigation-coverage'
import { navigationPreviewDensity } from './navigation-zoom'
import { compositeDrawPlan, compositeRasterQuad } from './gpu/composite-draw-plan'
import { physicalCoverage } from './gpu/physical-coverage'

test('settled native detail can revoke only an unfinished lower-density capture', async () => {
  let cancelled = 0, finished = false
  const flight = navigationCoverageFlight({}, 1, { zoom: .5, rasterScale: .5,
    bounds: { x: 0, y: 0, width: 1000, height: 640 }, cancel: () => cancelled++ })
  void flight.done.then(() => { finished = true })
  expect(flight.cancelForNative(.5)).toBe(false)
  expect(flight.cancelForNative(1)).toBe(true)
  expect(flight.cancelForNative(1)).toBe(false)
  await Promise.resolve()
  expect(cancelled).toBe(1)
  expect(finished).toBe(false)
  flight.finish()
  await flight.done
  expect(finished).toBe(true)
})

test('a zoom-in capture more than the preview ratio behind the live camera yields, and a nearer one stays', () => {
  let cancelled = 0
  const flight = navigationCoverageFlight({}, 1, { zoom: 0.403, bounds: { x: 0, y: 0, width: 1000, height: 640 }, cancel: () => cancelled++ })
  expect(flight.cancelStaleZoomIn({ x: 0, y: 0, zoom: 0.7 })).toBe(false)
  expect(flight.cancelStaleZoomIn({ x: 0, y: 0, zoom: 0.806 })).toBe(false)
  expect(cancelled).toBe(0)
  expect(flight.cancelStaleZoomIn({ x: 0, y: 0, zoom: 3.942 })).toBe(true)
  expect(cancelled).toBe(1)
  expect(flight.cancelStaleZoomIn({ x: 0, y: 0, zoom: 3.942 })).toBe(false)
  const delivered = navigationCoverageFlight({}, 1, { zoom: 0.403, bounds: { x: 0, y: 0, width: 10, height: 10 }, cancel: () => { throw Error('delivered capture cancelled') } })
  delivered.tile = {}
  expect(delivered.cancelStaleZoomIn({ x: 0, y: 0, zoom: 8 })).toBe(false)
  expect(navigationCoverageFlight({}, 1).cancelStaleZoomIn({ x: 0, y: 0, zoom: 4 })).toBe(false)
  expect(flight.cancelStaleZoomIn({ x: 0, y: 0, zoom: Number.NaN })).toBe(false)
})

test('quiet native work revokes only an undelivered optional capture, retaining its physical fence',async()=>{
  let cancelled=0,done=false
  const capture={zoom:32,bounds:{x:0,y:0,width:1024,height:512},cancel:()=>cancelled++}
  const flight=navigationCoverageFlight<object>({},1,capture)
  void flight.done.then(()=>{done=true})
  expect(flight.cancelForNative()).toBe(true)
  expect(cancelled).toBe(1);expect(flight.cancellationRequested).toBe(true)
  expect(flight.cancelForNative()).toBe(false)
  await Promise.resolve();expect(done).toBe(false)
  flight.finish();await flight.done;expect(done).toBe(true)
  const delivered=navigationCoverageFlight<object>({},1,capture)
  delivered.tile={};expect(delivered.cancelForNative()).toBe(false)
  delivered.finish();expect(delivered.cancelForNative()).toBe(false)
  expect(navigationCoverageFlight({},1).cancelForNative()).toBe(false)
  expect(cancelled).toBe(1)
})

test('large reversal revokes only the optional narrow capture and retains its physical completion fence',async()=>{
  let cancelled=0,done=false
  const flight=navigationCoverageFlight({},1,{zoom:8,bounds:{x:0,y:0,width:128,height:64},cancel:()=>cancelled++})
  void flight.done.then(()=>{done=true})
  expect(flight.cancelObsoleteZoomOut({x:0,y:0,zoom:6},1024,512,2)).toBe(false)
  expect(flight.cancelObsoleteZoomOut({x:0,y:0,zoom:4},1024,512,2)).toBe(true)
  expect(cancelled).toBe(1);expect(flight.cancellationRequested).toBe(true)
  await Promise.resolve();expect(done).toBe(false)
  expect(flight.cancelObsoleteZoomOut({x:0,y:0,zoom:2},1024,512,2)).toBe(false)
  flight.finish();await flight.done;expect(done).toBe(true)
})

test('a large pan yields an undelivered capture that misses the newest viewport', () => {
  let cancelled = 0
  const flight = navigationCoverageFlight({}, 1, {
    zoom: 2, bounds: { x: 0, y: 0, width: 512, height: 256 }, cancel: () => cancelled++,
  })
  expect(viewportOverlapFraction({ x: 0, y: 0, width: 512, height: 256 }, { x: -40, y: 0, zoom: 2 }, 1024, 512)).toBeGreaterThan(0.5)
  expect(flight.cancelMissedViewport({ x: -40, y: 0, zoom: 2 }, 1024, 512)).toBe(false)
  expect(flight.cancelMissedViewport({ x: -700, y: 0, zoom: 2 }, 1024, 512)).toBe(true)
  expect(cancelled).toBe(1)
  expect(flight.cancelMissedViewport({ x: -700, y: 0, zoom: 2 }, 1024, 512)).toBe(false)
  const delivered = navigationCoverageFlight({}, 1, {
    zoom: 2, bounds: { x: 0, y: 0, width: 512, height: 256 }, cancel: () => { throw Error('delivered capture stays') },
  })
  delivered.tile = {}
  expect(delivered.cancelMissedViewport({ x: -700, y: 0, zoom: 2 }, 1024, 512)).toBe(false)
  expect(navigationCoverageFlight({}, 1).cancelMissedViewport({ x: 0, y: 0, zoom: 1 }, 100, 100)).toBe(false)
  expect(flight.cancelMissedViewport({ x: 0, y: 0, zoom: Number.NaN }, 100, 100)).toBe(false)
})

test('an active gesture keeps a pure zoom-out and yields a pan that leaves that sample', () => {
  let cancelled = 0
  const flight = navigationCoverageFlight({}, 1, {
    zoom: 2, bounds: { x: 0, y: 0, width: 512, height: 256 }, cancel: () => cancelled++,
  })
  // Zoom 2 at the origin still sits inside a centered zoom-out to 1.
  const zoomed = { x: 256, y: 128, zoom: 1 }
  expect(captureVisibleFraction({ x: 0, y: 0, width: 512, height: 256 }, zoomed, 1024, 512)).toBe(1)
  expect(flight.cancelMissedViewport(zoomed, 1024, 512, 0.5, true)).toBe(false)
  expect(flight.cancelMissedViewport({ x: -40, y: 0, zoom: 2 }, 1024, 512, 0.5, true)).toBe(false)
  expect(flight.cancelMissedViewport({ x: -700, y: 0, zoom: 3 }, 1024, 512, 0.5, true)).toBe(false)
  expect(cancelled).toBe(0)
  // The same sample is off the live viewport after the long pan, even though
  // its zoom has not caught the zoom-out yet.
  const panned = { x: -700, y: 0, zoom: 1 }
  expect(captureVisibleFraction({ x: 0, y: 0, width: 512, height: 256 }, panned, 1024, 512)).toBe(0)
  expect(flight.cancelMissedViewport(panned, 1024, 512, 0.5, true)).toBe(true)
  expect(cancelled).toBe(1)
  expect(flight.cancelMissedViewport(panned, 1024, 512, 0.5, true)).toBe(false)
  expect(liveNavigationCapture({ x: 0, y: 0, zoom: 2 }, zoomed, 1024, 512)).toEqual({ x: 0, y: 0, zoom: 2 })
  expect(liveNavigationCapture({ x: 0, y: 0, zoom: 2 }, panned, 1024, 512)).toEqual(panned)
  expect(liveNavigationCapture({ x: 0, y: 0, zoom: 2 }, { x: -700, y: 0, zoom: 2 }, 1024, 512)).toEqual({ x: -700, y: 0, zoom: 2 })
  expect(liveNavigationCapture({ x: 0, y: 0, zoom: 2 }, { x: -40, y: 0, zoom: 2 }, 1024, 512)).toEqual({ x: 0, y: 0, zoom: 2 })
  expect(captureMostlyOffscreen({ x: 0, y: 0, width: 512, height: 256 }, panned, 1024, 512)).toBe(true)
  expect(captureMostlyOffscreen({ x: 0, y: 0, width: 512, height: 256 }, zoomed, 1024, 512)).toBe(false)
  expect(captureMostlyOffscreen({ x: 0, y: 0, width: 512, height: 256 }, panned, 1024, 512, Number.NaN)).toBe(false)
  expect(liveNavigationCapture({ x: Number.NaN, y: 0, zoom: 2 }, panned, 1024, 512)).toEqual({ x: Number.NaN, y: 0, zoom: 2 })
})

test('a covering capture and finished/capture-free flights never spend reversal cancellation',()=>{
  const source={zoom:8,bounds:{x:-200,y:-200,width:1000,height:1000},cancel:()=>{throw Error('Unexpected cancel')}}
  const flight=navigationCoverageFlight({},1,source)
  expect(flight.cancelObsoleteZoomOut({x:0,y:0,zoom:4},1024,512,2)).toBe(false)
  flight.finish()
  expect(flight.cancelObsoleteZoomOut({x:0,y:0,zoom:1},1024,512)).toBe(false)
  expect(navigationCoverageFlight({},1).cancelObsoleteZoomOut({x:0,y:0,zoom:1},1024,512)).toBe(false)
})

const document = {}, client = {}
const owner = { document, client, revision: 4, resident: true, device: '11/1/1' }
const tile = { key: 'high-zoom', document, revision: 4, x: 0, y: 0, width: 1024, height: 512,
  zoom: 32, gutter: 0, gpuTile: 1, residentDevice: { client, key: '11/1/1' } }

test.each([1, 2, 3, 4, 5])('32x dwell crop does not certify newly exposed %ix viewport', zoom => {
  const residents = navigationCoverageTiles([tile], new Set([tile.key]), owner)
  expect(navigationHasCoverage(residents, { x: 0, y: 0, zoom: 32 }, 1024, 512)).toBe(true)
  expect(navigationHasCoverage(residents, { x: 0, y: 0, zoom }, 1024, 512)).toBe(false)
  const covering = { ...tile, key: 'wide', zoom }
  expect(navigationHasCoverage([...residents, covering], { x: 0, y: 0, zoom }, 1024, 512)).toBe(true)
  expect(navigationHasCoverage([...residents, covering], { x: 0, y: 0, zoom }, 1024, 512, zoom * 2)).toBe(false)
})

test.each(['document', 'revision', 'page/session-contract', 'device', 'client', 'not-ready', 'unknown-device'] as const)(
  'continuity reuse rejects %s without falsely certifying coverage', kind => {
    const next = { ...owner }
    if (kind === 'document') next.document = {}
    if (kind === 'revision' || kind === 'page/session-contract') next.revision++
    if (kind === 'device') next.device = '11/2/2'
    if (kind === 'client') next.client = {}
    if (kind === 'unknown-device') next.device = ''
    expect(navigationCoverageTiles([tile], new Set(kind === 'not-ready' ? [] : [tile.key]), next)).toEqual([])
  })

test('one-pixel uncovered strip is not full coverage, including fractional cameras', () => {
  const view = { x: .25, y: -.125, zoom: 2 }
  const full = { ...tile, zoom: 2, x: -.25, y: .125 }
  expect(navigationHasCoverage([full], view, 1024, 512)).toBe(true)
  expect(navigationHasCoverage([{ ...full, width: 1023 }], view, 1024, 512)).toBe(false)
})

test('low-density residents do not count as finished coverage for a zoomed-out viewport', () => {
  const overview = { ...tile, key: 'overview', zoom: 0.02, width: 2048, height: 1024 }
  const view = { x: 0, y: 0, zoom: 0.06 }
  expect(navigationHasCoverage([overview], view, 1024, 512)).toBe(true)
  expect(navigationHasCoverage([overview], view, 1024, 512, navigationReadyDensity(view.zoom, 1, 1024, 512))).toBe(false)
  expect(navigationReadyDensity(0.02, 2, 1600, 900)).toBeLessThan(0.05)
  expect(previewUnderlayHides({ document, revision: 4 }, { document, revision: 4 })).toBe(false)
  expect(previewUnderlayHides({ document, revision: 3 }, { document, revision: 4 })).toBe(true)
  expect(retainedPressureError(Error('Compositing memory budget exceeded'))).toBe(true)
  expect(retainedPressureError(Error('Combined filter dependency halo exceeds 2048 device pixels'))).toBe(true)
  expect(retainedPressureError(Error('Layer surface exceeds 16 million pixels'))).toBe(true)
  expect(retainedPressureError(Error('Page not found'))).toBe(false)
})

test('bounded coverage density is temporary and never raises the native sampling contract', () => {
  for (const [width, height, dpr] of [[1024, 512, 2], [3840, 2160, 2], [16000, 9000, 3]]) {
    const density = navigationPreviewDensity(dpr, width, height)
    expect(density).toBeLessThanOrEqual(dpr)
    expect(width * height * density * density).toBeLessThanOrEqual(1_048_577)
    expect(Math.max(width, height) * density).toBeLessThanOrEqual(2048)
  }
})

test('flight completion is idempotent and carries no readiness or exact certificate', async () => {
  const flight = navigationCoverageFlight<object>({}, 3)
  let done = false
  void flight.done.then(() => { done = true })
  await Promise.resolve(); expect(done).toBe(false)
  flight.tile = tile
  await Promise.resolve(); expect(done).toBe(false)
  flight.finish(); flight.finish(); await flight.done
  expect(done).toBe(true)
})


test('production one-pixel gutters do not fill a missing native seam', () => {
  const view = { x: 0, y: 0, zoom: 1 }
  const left = { ...tile, key: 'left', x: -1, y: -1, width: 514, height: 514, zoom: 1, gutter: 1 }
  const right = { ...left, key: 'right', x: 511 }
  expect(navigationHasCoverage([left, right], view, 1024, 512)).toBe(true)
  expect(navigationHasCoverage([left, { ...right, x: 512 }], view, 1024, 512)).toBe(false)
  const ready = new Set([left.key])
  expect(navigationHasCoverage(navigationCoverageTiles([left, right], ready, owner), view, 1024, 512)).toBe(false)
})

test('geometry admission is never a clipped submitted-fragment coverage certificate', () => {
  const full = { ...tile, zoom: 1, serial: 1, bytes: new Uint8Array() }
  const view = { x: 0, y: 0, zoom: 1 }
  expect(navigationHasCoverage([full], view, 1024, 512)).toBe(true)
  const draws = compositeDrawPlan([{ tile: full, active: true, layer: 0, gutter: 0,
    clip: { left: 0, top: 0, width: 1023, height: 512 } }], view, 1024, 512)
  const rows = draws.map(row => ({ ...compositeRasterQuad(row.placement, row.clip, 1024, 512, 1)!, native: false }))
  expect(physicalCoverage(rows, 1024, 512)).toEqual({ pixelCoverageComplete: false, nativeCoverageComplete: false })
})
