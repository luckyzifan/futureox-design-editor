// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { blank } from '../model'
import { readFile } from 'node:fs/promises'
import { URL as FileURL } from 'node:url'

const state = vi.hoisted(() => ({ active: true, sequence: 1, real: false, sampleView: undefined as any, pending: [] as any[], clients: [] as any[], composites: [] as any[] }))
vi.mock('./client', () => ({
  renderExecutionPolicy: { desktopDisplay: true, desktopFullMath: true, cpuOnly: false, hdrCompositing: false, imageMips: false, imageAtlas: false },
  KernelClient: class {
    cancelPreview = vi.fn(); cancelTileFill = vi.fn(); dispose = vi.fn(); releasePresented = vi.fn()
    recordViewportDiagnostic() {}; presentationDiagnosticsEnabled() { return false }
    constructor() { state.clients.push(this) }
    render(document: any, options: any, ...args: any[]) {
      return new Promise<any>((resolve, reject) => state.pending.push({ document, options, progress: args[5], resolve, reject }))
    }
  },
}))
vi.mock('./module', async original => {
  const actual = await original<any>()
  return { ...actual, initializeKernelModule: async () => {
    if (state.real) await actual.initializeKernelModule(new Uint8Array(await readFile(
      new FileURL('../../public/kernel/design_kernel_bg.wasm', import.meta.url))))
  } }
})
vi.mock('./canvas-effect-sampling', async original => {
  const actual = await original<any>()
  return { pageHasFilteredContent: (...args: any[]) => state.real ? actual.pageHasFilteredContent(...args) : true }
})
vi.mock('./tile-plan-aligned', async original => {
  const actual = await original<any>()
  return { tilePrefetchRingsFromHost: () => 0,
  planTilesAligned: (bounds: any, zoom: number, _limit: number, phase = { x: 0, y: 0 }) => {
    if (state.real) return actual.planTilesAligned(bounds, zoom, _limit, phase)
    const x = Math.floor((bounds.x + bounds.width / 2) * zoom / 512) * 512 - 1
    const y = Math.floor((bounds.y + bounds.height / 2) * zoom / 512) * 512 - 1
    return [0, 512, -512].map(dx => ({ key: `${zoom}:${phase.x}:${phase.y}:${x + dx}:${y}`,
      x: x + dx, y, width: 514, height: 514, gutter: 1, zoom, phaseX: phase.x, phaseY: phase.y }))
  },
  planTilesWithPrefetchRim: (...args: any[]) => state.real ? actual.planTilesWithPrefetchRim(...args) : ({ viewport: [], rim: [], cacheLimitSkipped: 0 }),
} })
vi.mock('./use-navigation-zoom', () => ({ useNavigationZoom: (view: any, _identity: string, enabled: boolean) => ({
  active: enabled && state.active, suspended: false, panEnabled: true,
  sample: enabled && state.active ? { sequence: state.sequence, view: state.sampleView || view } : undefined,
}) }))
vi.mock('./use-raster-density', () => ({ useRasterDensity: (density: number) => density }))
vi.mock('./use-zoom-activity', () => ({ useZoomActivity: () => false, useCameraActivity: () => true }))
vi.mock('./presentation', async original => ({ ...await original<any>(), useDevicePixelRatio: () => 2, useDisplayCapability: () => undefined }))
vi.mock('./ResidentCompositeSurface', () => ({ ResidentCompositeSurface: (props: any) => { state.composites.push(props); return null } }))
vi.mock('./TileCompositeSurface', () => ({ TileCompositeSurface: () => null }))

beforeEach(() => {
  state.active = true; state.sequence = 1; state.real = false; state.sampleView = undefined; state.pending = []; state.clients = []; state.composites = []
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('WebGL2RenderingContext', function () {})
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: {} })
  vi.stubEnv('VITE_DESIGN_NATIVE_NAVIGATION', '0'); vi.stubEnv('VITE_DESIGN_SHARP_ZOOM', '0'); vi.stubEnv('VITE_DESIGN_GESTURE_DENSITY_HEADROOM', '0')
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); delete (navigator as any).gpu })
async function fixture(zoom = 32, document = blank()) {
  const { ProgressiveSurfaceImpl } = await import('./ProgressiveSurface')
  const container = window.document.createElement('div'), root = createRoot(container)
  let props: any = { document, pageId: document.pages[0].id, width: 855, height: 888,
    view: { x: 0, y: 0, zoom }, grid: false, backend: 'webgpu', onFallback: vi.fn() }
  const render = async (extra: any = {}) => { props = { ...props, ...extra }; await act(async () => root.render(<ProgressiveSurfaceImpl {...props} />)) }
  const complete = async (index: number) => {
    const request = state.pending[index]
    await act(async () => request.resolve({ bitmap: { width: request.options.width, height: request.options.height, close: vi.fn() },
      bytes: new Uint8Array(0), backend: 'webgpu', milliseconds: 1 }))
  }
  await render(); await vi.waitFor(() => expect(state.pending).toHaveLength(1))
  return { render, complete, root, container, get props() { return props } }
}

test('complete retained edit pixels suspend obsolete canvas work and release resumes exact repair',async()=>{
 vi.stubEnv('VITE_DESIGN_RETAINED_INPUT_PRIORITY','1');state.active=false
 const f=await fixture(1)
 try{
  const client=state.clients[0],before=client.cancelPreview.mock.calls.length
  const control={current:{blocksCanvasRefinement:()=>true,isActive:()=>true,covers:()=>true}}
  const interaction={document:f.props.document,selection:['retained'],active:true,epoch:0,readinessRevision:1,control,onReady(){}}
  await f.render({interaction})
  expect(client.cancelPreview.mock.calls.length).toBeGreaterThan(before)
  expect(state.pending).toHaveLength(1)
  await act(async()=>state.pending[0].reject(Error('PREVIEW_CANCELLED')))
  await f.render({interaction:{...interaction,readinessRevision:2}})
  expect(state.pending).toHaveLength(1)
  await f.render({interaction:{...interaction,active:false,readinessRevision:3}})
  await vi.waitFor(()=>expect(state.pending.length).toBeGreaterThan(1))
  expect(f.props.onFallback).not.toHaveBeenCalled()
 }finally{await act(async()=>f.root.unmount())}
})

test('idle interaction readiness updates do not restart the unchanged viewport plan',async()=>{
 const {RenderMailbox}=await import('./render-mailbox'),enqueue=vi.spyOn(RenderMailbox.prototype,'run')
 state.active=false;const f=await fixture(1)
 try{
  const control={current:{blocksCanvasRefinement:()=>false,isActive:()=>false,covers:()=>false}}
  const interaction={document:f.props.document,selection:[],active:false,epoch:0,readinessRevision:1,control,onReady(){}}
  await f.render({interaction});const before=enqueue.mock.calls.length
  for(let readinessRevision=2;readinessRevision<22;readinessRevision++)await f.render({interaction:{...interaction,readinessRevision}})
  expect(enqueue).toHaveBeenCalledTimes(before)
 }finally{await act(async()=>f.root.unmount());enqueue.mockRestore()}
})

test('continuous DPR2 navigation gives one real native tile a turn without increasing preview density', async () => {
  const f = await fixture()
  try {
    expect(state.pending[0].options.width).toBe(855)
    expect(state.pending[0].options.view.zoom).toBe(32)
    await f.complete(0)
    await vi.waitFor(() => expect(state.pending.some(job => job.options.tileViewport?.length === 1)).toBe(true))
    const native = state.pending.find(job => job.options.tileViewport?.length)
    expect(native.options.tileViewport).toHaveLength(1)
    expect(native.options.tileViewport[0].zoom).toBe(64)
    expect(native.options.renderIntent).toBe('canvas')
    expect(native.options.livePreview).toBeUndefined()
    expect(native.options.tilePrepareViewport).toBeDefined()
    expect(f.container.querySelector('[data-detail-ready="true"]')).toBeNull()
  } finally { await act(async () => f.root.unmount()) }
})

test('latest pan wins queued refinement while one in-flight native tile survives inputs and previews continue', async () => {
  const f = await fixture()
  try {
    state.sequence++
    await f.render({ view: { x: 100, y: 0, zoom: 32 } })
    await f.complete(0)
    await vi.waitFor(() => expect(state.pending).toHaveLength(2))
    expect(state.pending[1].options.livePreview).toBe(true)
    for (let i = 0; i < 30; i++) {
      state.sequence++
      await f.render({ view: { x: 1000 + i * 100, y: 0, zoom: 32 } })
    }
    await f.complete(1)
    await vi.waitFor(() => expect(state.pending).toHaveLength(3))
    const native = state.pending[2]
    expect(native.options.tileViewport).toHaveLength(1)
    // World center of the latest viewport, not either old sampled camera.
    const centerX = native.options.tileViewport[0].x + 257
    expect(Math.abs(centerX - (855 / 2 - 3900) * 2)).toBeLessThanOrEqual(256)
    const cancels = state.clients[0].cancelTileFill.mock.calls.length
    for (let i = 0; i < 30; i++) { state.sequence++; await f.render({ view: { x: 4000 + i * 10, y: 0, zoom: 32 } }) }
    expect(state.pending).toHaveLength(3)
    expect(state.clients[0].cancelTileFill).toHaveBeenCalledTimes(cancels)
    await f.complete(2)
    await vi.waitFor(() => expect(state.pending).toHaveLength(4))
    expect(state.pending[3].options.livePreview).toBe(true)
    expect(state.pending[3].options.view.x).toBe(4290)
    expect(f.container.querySelector('[data-detail-ready="true"]')).toBeNull()
  } finally { await act(async () => f.root.unmount()) }
})

for (const boundary of ['paused', 'visible', 'contract', 'device'] as const) {
  test(`late native tile is retired across ${boundary}, never admitted as current pixels`, async () => {
    const f = await fixture()
    try {
      const client = state.clients[0]
      const device = { client, deviceWorkerScope: 1, deviceIncarnation: 1, deviceOwner: 1 }
      const frame = { ids: [], view: f.props.view, width: f.props.width, height: f.props.height, dpr: 2, interaction: false }
      await act(async () => state.composites.at(-1).onPresented(frame, undefined, device))
      await f.complete(0)
      await vi.waitFor(() => expect(state.pending).toHaveLength(2))
      const native = state.pending[1]
      expect(native.options.tileViewport).toHaveLength(1)
      if (boundary === 'device') await act(async () => state.composites.at(-1).onPresented(frame, undefined, { ...device, deviceIncarnation: 2 }))
      else await f.render(boundary === 'paused' ? { paused: true } : boundary === 'visible' ? { visible: false } : { presentationEpoch: 2 })
      const bitmap = { width: 514, height: 514, close: vi.fn() }
      await act(async () => native.progress({ ...native.options.tileViewport[0], bitmap, gpuTile: 777, bytes: new Uint8Array(0), backend: 'webgpu', milliseconds: 1 }))
      expect(bitmap.close).toHaveBeenCalledOnce()
      expect(client.releasePresented).toHaveBeenCalledWith([777])
      expect(state.composites.at(-1).items.some((item: any) => item.tile.bitmap === bitmap)).toBe(false)
      expect(f.container.querySelector('[data-detail-ready="true"]')).toBeNull()
    } finally { await act(async () => f.root.unmount()) }
  })
}

test('one finished native world tile is staged through camera changes and cannot certify the viewport', async () => {
  const f = await fixture()
  try {
    await f.complete(0); await vi.waitFor(() => expect(state.pending).toHaveLength(2))
    const native = state.pending[1], bitmap = { width: 514, height: 514, close: vi.fn() }
    await act(async () => native.progress({ ...native.options.tileViewport[0], bitmap, gpuTile: 777, bytes: new Uint8Array(0), backend: 'webgpu', milliseconds: 1 }))
    let item = state.composites.at(-1).items.find((item: any) => item.tile.bitmap === bitmap)
    expect(item).toBeDefined()
    await act(async () => state.composites.at(-1).onReady(item.tile.key, item.tile.serial, false))
    item = state.composites.at(-1).items.find((item: any) => item.tile.bitmap === bitmap)
    expect(item.active).toBe(false)
    expect(item.tile.zoom).toBe(64)
    expect(f.container.querySelector('[data-detail-ready="true"]')).toBeNull()
    state.sequence++; await f.render({ view: { x: 100000, y: 0, zoom: 32 } })
    item = state.composites.at(-1).items.find((item: any) => item.tile.bitmap === bitmap)
    expect(item?.active || false).toBe(false)
    expect(f.container.querySelector('[data-detail-ready="true"]')).toBeNull()
  } finally { await act(async () => f.root.unmount()) }
})

for (const zoom of [.99, 1]) {
  test(`navigation refinement eligibility preserves the exact ${zoom} boundary`, async () => {
    const f = await fixture(zoom)
    try {
      await f.complete(0)
      if (zoom === 1) {
        await vi.waitFor(() => expect(state.pending).toHaveLength(2))
        expect(state.pending[1].options.tileViewport).toHaveLength(1)
        expect(state.pending[1].options.tileViewport[0].zoom).toBe(2)
      } else {
        await act(async () => { await Promise.resolve(); await Promise.resolve() })
        expect(state.pending).toHaveLength(1)
      }
    } finally { await act(async () => f.root.unmount()) }
  })
}

test('crossing below 1 revokes queued native work and crossing back admits one latest turn', async () => {
  const f = await fixture(1)
  try {
    state.sequence++; await f.render({ view: { x: 10, y: 0, zoom: 1 } })
    await f.complete(0)
    await vi.waitFor(() => expect(state.pending).toHaveLength(2))
    expect(state.pending[1].options.livePreview).toBe(true)
    state.sequence++; await f.render({ view: { x: 20, y: 0, zoom: .99 } })
    await f.complete(1)
    await vi.waitFor(() => expect(state.pending).toHaveLength(3))
    expect(state.pending[2].options.livePreview).toBe(true)
    expect(state.pending[2].options.view.zoom).toBe(.99)
    expect(state.pending.every(job => !job.options.tileViewport)).toBe(true)
    state.sequence++; await f.render({ view: { x: 30, y: 0, zoom: 1 } })
    await f.complete(2)
    await vi.waitFor(() => expect(state.pending).toHaveLength(4))
    expect(state.pending[3].options.livePreview).toBe(true)
    await f.complete(3)
    await vi.waitFor(() => expect(state.pending).toHaveLength(5))
    expect(state.pending[4].options.tileViewport).toHaveLength(1)
    expect(state.pending[4].options.tileViewport[0].zoom).toBe(2)
  } finally { await act(async () => f.root.unmount()) }
})


test('optional full-frame budget refusal still schedules one native refinement turn', async () => {
  const f = await fixture()
  try {
    await act(async () => state.pending[0].reject(Error('PREVIEW_BUDGET: GPU surface budget exceeded')))
    await vi.waitFor(() => expect(state.pending).toHaveLength(2))
    const native = state.pending[1]
    expect(native.options.tileViewport).toHaveLength(1)
    expect(native.options.tileViewport[0].zoom).toBe(64)
    expect(native.options.renderIntent).toBe('canvas')
    expect(native.options.livePreview).toBeUndefined()
    expect(f.props.onFallback).not.toHaveBeenCalled()
    expect(f.container.querySelector('[data-detail-ready="true"]')).toBeNull()
  } finally { await act(async () => f.root.unmount()) }
})


const compileBudget = async () => (await import('./render-failure-telemetry')).markRenderFailure(Error('PREVIEW_BUDGET: GPU surface budget exceeded'), {
  failureCategory: 3, failureCode: 64, failureStage: 5,
})

test('rejected 3200% capture retargets native work to latest reverse zoom, not the failed camera', async () => {
  const f = await fixture()
  try {
    for (const zoom of [5, 1, 5, 1]) { state.sequence++; await f.render({ view: { x: 0, y: 0, zoom } }) }
    await act(async () => state.pending[0].reject(await compileBudget()))
    await vi.waitFor(() => expect(state.pending).toHaveLength(2))
    expect(state.pending[1].options.livePreview).toBe(true)
    expect(state.pending[1].options.view.zoom).toBe(1)
    state.sequence++; await f.render({ view: { x: -100, y: -200, zoom: 5 } })
    await act(async () => state.pending[1].reject(await compileBudget()))
    await vi.waitFor(() => expect(state.pending).toHaveLength(3))
    const native = state.pending[2]
    expect(native.options.tileViewport).toHaveLength(1)
    expect(native.options.tileViewport[0].zoom).toBe(10)
    expect(native.options.view.zoom).toBe(10)
    expect(f.container.querySelector('[data-detail-ready="true"]')).toBeNull()
    // Neither rejection opens another raster queue or cancels running pixels.
    for (const zoom of [1, 5, 1]) { state.sequence++; await f.render({ view: { x: -100, y: -200, zoom } }) }
    expect(state.pending).toHaveLength(3)
    await f.complete(2)
    await vi.waitFor(() => expect(state.pending).toHaveLength(4))
    expect(state.pending[3].options.livePreview).toBe(true)
    expect(state.pending[3].options.view.zoom).toBe(1)
  } finally { await act(async () => f.root.unmount()) }
})

test('budget latch keeps one native turn for a sample despite thirty raw camera inputs', async () => {
  state.sampleView = { x: 0, y: 0, zoom: 32 }
  const f = await fixture()
  try {
    await act(async () => state.pending[0].reject(await compileBudget()))
    await vi.waitFor(() => expect(state.pending).toHaveLength(2))
    await f.complete(1)
    for (let i = 1; i <= 30; i++) await f.render({ view: { x: i, y: 0, zoom: 32 } })
    expect(state.pending).toHaveLength(2)
    expect(state.pending.filter(job => job.options.tileViewport)).toHaveLength(1)
    expect(f.container.querySelector('[data-detail-ready="true"]')).toBeNull()
  } finally { await act(async () => f.root.unmount()) }
})

for (const boundary of ['paused', 'visible', 'quiet'] as const) {
  test(`late budget refusal cannot revive navigation refinement after ${boundary}`, async () => {
    const f = await fixture()
    try {
      if (boundary === 'quiet') state.active = false
      await f.render(boundary === 'paused' ? { paused: true } : boundary === 'visible' ? { visible: false } : {})
      const before = state.pending.length
      await act(async () => state.pending[0].reject(await compileBudget()))
      // Quiet may admit ordinary exact work. It must never revive the retired
      // single-tile navigation goal. The pre-existing hidden-page route may
      // synchronize metadata without requesting navigation rasterization.
      await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() })
      expect(state.pending.slice(before).some(job => job.options.tileViewport?.length === 1)).toBe(false)
      if (boundary === 'paused') expect(state.pending).toHaveLength(before)
    } finally { await act(async () => f.root.unmount()) }
  })
}

test('device loss combined with optional budget text remains an error, not a detail retry', async () => {
  const f = await fixture()
  try {
    const onRenderFailure = vi.fn(); await f.render({ onRenderFailure })
    await act(async () => state.pending[0].reject(Error('PREVIEW_BUDGET: GPU device lost')))
    expect(onRenderFailure).toHaveBeenCalledOnce()
    expect(state.pending).toHaveLength(1)
    expect(f.container.querySelector('[data-detail-ready="true"]')).toBeNull()
  } finally { await act(async () => f.root.unmount()) }
})

test.runIf(!!process.env.CORE_NAVIGATION_117_INPUT)('real 117 parsed input and production WASM addresses receive one current native tile after preview refusal', async () => {
  state.real = true
  const document = JSON.parse(await readFile(process.env.CORE_NAVIGATION_117_INPUT!, 'utf8'))
  expect(Object.keys(document.nodes)).toHaveLength(753)
  const f = await fixture(32, document)
  try {
    for (const zoom of [5, 1]) { state.sequence++; await f.render({ view: { x: -100, y: -200, zoom } }) }
    await act(async () => state.pending[0].reject(await compileBudget()))
    await vi.waitFor(() => expect(state.pending).toHaveLength(2))
    await act(async () => state.pending[1].reject(await compileBudget()))
    await vi.waitFor(() => expect(state.pending).toHaveLength(3))
    const native = state.pending[2]
    expect(native.document).toBe(document)
    expect(native.options.tileViewport).toHaveLength(1)
    const tile = native.options.tileViewport[0]
    expect(tile.zoom).toBe(2)
    expect(tile.width).toBe(514)
    expect(tile.height).toBe(514)
    expect(tile.gutter).toBe(1)
    expect(native.options.renderIntent).toBe('canvas')
    expect(native.options.rasterProfile).toBe('figma')
    expect(native.options.livePreview).toBeUndefined()
    expect(native.options.tilePrepareViewport).toBeDefined()
    expect(f.props.onFallback).not.toHaveBeenCalled()
    expect(f.container.querySelector('[data-detail-ready="true"]')).toBeNull()
  } finally { await act(async () => f.root.unmount()) }
})
