// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { blank } from '../model'

const state = vi.hoisted(() => ({ active: true, suspended: false, sequence: 1, dpr: 2,
  composites: [] as any[], clients: [] as any[], pending: [] as any[], plan: vi.fn(), rejectAdmission: false }))
vi.mock('./tile-admission', async original => {
  const actual = await original<any>()
  return { ...actual, planTileAdmission: (...args: any[]) => {
    if (state.rejectAdmission) throw new actual.TileAdmissionBudgetError({ proposedBytes: 2, budgetBytes: 1,
      heldCount: 1, usedCount: 1, pinnedCount: 1, incomingBytes: 1, reserveBytes: 0 })
    return actual.planTileAdmission(...args)
  } }
})
vi.mock('./client', () => ({
  renderExecutionPolicy: { desktopDisplay: true, desktopFullMath: true, cpuOnly: false, hdrCompositing: false,
    imageMips: false, imageAtlas: false },
  KernelClient: class {
    cancelPreview = vi.fn(); cancelTileFill = vi.fn(); dispose = vi.fn(); releasePresented = vi.fn()
    recordViewportDiagnostic() {}
    presentationDiagnosticsEnabled() { return false }
    constructor() { state.clients.push(this) }
    render(document: any, options: any, ...args: any[]) {
      return new Promise<any>((resolve, reject) => state.pending.push({ document, options, signal: args[6], resolve, reject }))
    }
  },
}))
vi.mock('./module', () => ({ initializeKernelModule: async () => {} }))
vi.mock('./tile-plan-aligned', () => ({ tilePrefetchRingsFromHost: () => 0,
  planTilesAligned: () => [], planTilesWithPrefetchRim: (...args: any[]) => {
    state.plan(...args)
    return { viewport: [], rim: [], cacheLimitSkipped: 0 }
  } }))
vi.mock('./use-navigation-zoom', () => ({ useNavigationZoom: (view: any, _identity: string, enabled: boolean) => ({
  active: enabled && state.active, suspended: state.suspended, panEnabled: true,
  sample: enabled && state.active ? { sequence: state.sequence, view } : undefined,
}) }))
vi.mock('./use-raster-density', () => ({ useRasterDensity: (density: number) => density }))
vi.mock('./use-zoom-activity', () => ({ useZoomActivity: () => false, useCameraActivity: () => false }))
vi.mock('./presentation', async original => ({ ...await original<any>(), useDevicePixelRatio: () => state.dpr,
  useDisplayCapability: () => undefined }))
vi.mock('./ResidentCompositeSurface', () => ({ ResidentCompositeSurface: (props: any) => {
  state.composites.push(props); return null
} }))
vi.mock('./TileCompositeSurface', () => ({ TileCompositeSurface: () => null }))

beforeEach(() => {
  state.active = true; state.suspended = false; state.sequence = 1; state.dpr = 2
  state.rejectAdmission = false
  state.composites = []; state.clients = []; state.pending = []; state.plan.mockClear()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('WebGL2RenderingContext', function () {})
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: {} })
  vi.stubEnv('VITE_DESIGN_NATIVE_NAVIGATION', '1'); vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', '1')
  vi.stubEnv('VITE_DESIGN_SHARP_ZOOM', '0'); vi.stubEnv('VITE_DESIGN_GESTURE_DENSITY_HEADROOM', '0')
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); delete (navigator as any).gpu })

async function fixture(knownDevice = true) {
  const { ProgressiveSurfaceImpl } = await import('./ProgressiveSurface')
  const document = blank(), container = window.document.createElement('div'), root = createRoot(container)
  let props: any = { document, pageId: document.pages[0].id, width: 100, height: 80,
    view: { x: .125, y: -.375, zoom: 32 }, grid: false, backend: 'webgpu', onFallback: vi.fn(), paused: true }
  const render = async (extra: any = {}) => {
    props = { ...props, ...extra }
    await act(async () => root.render(<ProgressiveSurfaceImpl {...props} />))
  }
  const frame = (ids: number[], view = props.view) => ({ ids, view, width: props.width, height: props.height,
    dpr: state.dpr, interaction: false })
  const device = { client: undefined as any, deviceWorkerScope: 1, deviceIncarnation: 2, deviceOwner: 3 }
  await render()
  device.client = state.clients[0]
  if (knownDevice) await act(async () => state.composites.at(-1).onPresented(frame([]), undefined, device))
  await render({ paused: false })
  await vi.waitFor(() => expect(state.pending).toHaveLength(1))
  const quiet = async (extra: any = {}) => { state.active = false; state.sequence++; await render(extra) }
  const complete = async (index = 0, backend = 'webgpu') => {
    const request = state.pending[index], bitmap = { width: request.options.width, height: request.options.height, close: vi.fn() }
    await act(async () => request.resolve({ bitmap, bytes: new Uint8Array(0), backend, milliseconds: 1 }))
    return bitmap
  }
  const acknowledge = async (bitmap: any, owner = device) => {
    const tile = state.composites.at(-1).items.find((item: any) => item.tile.bitmap === bitmap)?.tile
    expect(tile).toBeDefined()
    tile.gpuTile = 101
    await act(async () => state.composites.at(-1).onReady(tile.key, tile.serial, false))
    await act(async () => state.composites.at(-1).onPresented(frame([101]), undefined, owner))
    return tile
  }
  return { render, quiet, complete, acknowledge, root, container, device, frame, get props() { return props } }
}

test('same-camera quiet keeps native work and promotes only after its import and actual device ACK', async () => {
  const f = await fixture()
  try {
    const first = state.pending[0]
    expect(first.options.view).toEqual({ x: .25, y: -.75, zoom: 64 })
    await f.quiet()
    expect(first.signal.aborted).toBe(false); expect(state.plan).not.toHaveBeenCalled()
    const bitmap = await f.complete()
    expect(f.container.querySelector('[data-detail-ready="true"]')).toBeNull()
    const tile = await f.acknowledge(bitmap)
    expect(tile.viewportCache.identity.view).toEqual(first.options.view)
    expect(state.pending).toHaveLength(1); expect(state.plan).not.toHaveBeenCalled()
    expect(f.container.querySelector('[data-detail-ready="true"]')).not.toBeNull()
    expect(f.container.querySelector('[data-sampling-mode="native"]')).not.toBeNull()
    expect(bitmap.close).not.toHaveBeenCalled()
  } finally { await act(async () => f.root.unmount()) }
})
test('visible-tile candidate starts native regional planning during input without a viewport preview',async()=>{
  vi.stubEnv('VITE_DESIGN_NATIVE_NAVIGATION','0');vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX','0')
  vi.stubEnv('VITE_DESIGN_NATIVE_VISIBLE_TILES','1')
  const f=await fixture()
  try{
    expect(state.pending[0].options.renderIntent).toBe('canvas')
    expect(state.pending[0].options.livePreview).toBeUndefined()
    expect(state.pending[0].options.tileViewport).toEqual([])
    expect(state.plan).toHaveBeenCalled()
    expect(state.plan.mock.calls[0][1]).toBe(64)
    expect(f.container.querySelector('[data-native-visible-tiles="true"]')).not.toBeNull()
    await f.render({view:{x:20,y:-30,zoom:16}})
    expect(state.plan.mock.calls.at(-1)![1]).toBe(32)
    expect(state.pending.every(job=>job.options.renderIntent==='canvas')).toBe(true)
  }finally{await act(async()=>f.root.unmount())}
})
test('60 native pan release/restarts keep one running job; queued cameras expire on quiet', async () => {
  const f = await fixture()
  try {
    const first = state.pending[0]
    for (let i = 0; i < 60; i++) {
      await f.quiet()
      state.active = true; state.sequence++
      await f.render({ view: { ...f.props.view, x: .125 + i / 8 } })
    }
    await f.quiet({ view: { x: .125, y: -.375, zoom: 32 } })
    expect(first.signal.aborted).toBe(false); expect(state.pending).toHaveLength(1)
    const ordinaryPlans = state.plan.mock.calls.length
    await f.acknowledge(await f.complete())
    // The intermediate quiet cameras correctly planned ordinary refinement;
    // the final exact-camera handoff adds no further duplicate plan.
    expect(state.pending).toHaveLength(1); expect(state.plan).toHaveBeenCalledTimes(ordinaryPlans)
    expect(f.container.querySelector('[data-detail-ready="true"]')).not.toBeNull()
  } finally { await act(async () => f.root.unmount()) }
})
test('a different final camera does not wait or mark stale coverage sharp', async () => {
  const f = await fixture()
  try {
    const first = state.pending[0]
    await f.quiet({ view: { ...f.props.view, x: .25 } })
    expect(first.signal.aborted).toBe(false)
    expect(state.plan).toHaveBeenCalledOnce()
    const bitmap = await f.complete()
    const tile = await f.acknowledge(bitmap)
    expect(tile.viewportCache.identity.view.x).toBe(.25)
    expect(f.container.querySelector('[data-detail-ready="true"]')).toBeNull()
  } finally { await act(async () => f.root.unmount()) }
})
test('a newer actual requested camera cannot be replaced by the lagging sampled view', async () => {
  const f = await fixture()
  try {
    await f.quiet({ requestedView: { ...f.props.view, x: .5 } })
    expect(state.plan).toHaveBeenCalledOnce()
    await f.acknowledge(await f.complete())
    expect(f.container.querySelector('[data-detail-ready="true"]')).toBeNull()
  } finally { await act(async () => f.root.unmount()) }
})
test('unknown owner at start remains history even if its eventual ACK names a device', async () => {
  const f = await fixture(false)
  try {
    await f.quiet()
    expect(state.plan).toHaveBeenCalledOnce()
    const tile = await f.acknowledge(await f.complete())
    expect(tile.nativeNavigationDevice).toBeUndefined()
    expect(f.container.querySelector('[data-detail-ready="true"]')).toBeNull()
  } finally { await act(async () => f.root.unmount()) }
})
test('cache admission failure retires the incoming bitmap once and wakes ordinary refinement without new input', async () => {
  const f = await fixture()
  try {
    await f.quiet(); state.rejectAdmission = true
    const bitmap = await f.complete()
    expect(bitmap.close).toHaveBeenCalledOnce()
    expect(state.plan).toHaveBeenCalledOnce()
    expect(f.container.querySelector('[data-detail-ready="true"]')).toBeNull()
  } finally { await act(async () => f.root.unmount()) }
})
test('an actual CPU fallback payload cannot certify a native GPU handoff', async () => {
  const f = await fixture()
  try {
    await f.quiet()
    const tile = await f.acknowledge(await f.complete(0, 'cpu'))
    expect(tile.nativeNavigationDevice).toBeUndefined()
    expect(state.plan).toHaveBeenCalledOnce()
    expect(f.container.querySelector('[data-detail-ready="true"]')).toBeNull()
  } finally { await act(async () => f.root.unmount()) }
})
test('a real owner-incarnation change aborts the old lease and releases its late GPU handle once', async () => {
  const f = await fixture()
  try {
    const first = state.pending[0]
    await f.quiet()
    const device = { ...f.device, deviceIncarnation: 4 }
    await act(async () => state.composites.at(-1).onPresented(f.frame([]), undefined, device))
    expect(first.signal.aborted).toBe(true)
    await act(async () => first.resolve({ gpuTile: 999, bytes: new Uint8Array(0), backend: 'webgpu', milliseconds: 1 }))
    expect(state.clients[0].releasePresented).toHaveBeenCalledExactlyOnceWith([999])
    expect(f.container.querySelector('[data-detail-ready="true"]')).toBeNull()
  } finally { await act(async () => f.root.unmount()) }
})
test.each(['document', 'page', 'session', 'backend', 'width', 'height', 'dpr', 'profile', 'paused', 'visible', 'suspended', 'pixelPreview'] as const)(
  '%s boundary aborts native ownership and closes a late bitmap exactly once', async boundary => {
    const f = await fixture()
    try {
      const first = state.pending[0]
      let extra: any = {}
      if (boundary === 'document') extra = { document: { ...f.props.document, nodes: { ...f.props.document.nodes } } }
      if (boundary === 'page') extra = { pageId: 'other-page' }
      if (boundary === 'session') extra = { presentationEpoch: 2 }
      if (boundary === 'backend') extra = { backend: 'cpu' }
      if (boundary === 'width') extra = { width: 101 }
      if (boundary === 'height') extra = { height: 81 }
      if (boundary === 'dpr') state.dpr = 3
      if (boundary === 'profile') extra = { rasterProfile: 'analytic' }
      if (boundary === 'paused') extra = { paused: true }
      if (boundary === 'visible') extra = { visible: false }
      if (boundary === 'suspended') state.suspended = true
      if (boundary === 'pixelPreview') extra = { pixelPreview: 1 }
      await f.render(extra)
      expect(first.signal.aborted).toBe(true)
      const bitmap = await f.complete()
      expect(bitmap.close).toHaveBeenCalledOnce()
      expect(f.props.onFallback).not.toHaveBeenCalled()
    } finally { await act(async () => f.root.unmount()) }
  })
test('ordinary navigation retains same-content coverage over quiet without certifying exact native pixels', async () => {
  vi.stubEnv('VITE_DESIGN_NATIVE_NAVIGATION', '0')
  const f = await fixture()
  try {
    const pending = state.pending[0]
    await f.quiet()
    // Quiet revokes queued goals, not a useful already-running coverage
    // capture. Ordinary DPR-1 pixels do not acquire a DPR-2 certificate.
    expect(pending.signal.aborted).toBe(false)
    const bitmap = await f.complete(), tile = await f.acknowledge(bitmap)
    expect(bitmap.close).not.toHaveBeenCalled()
    expect(tile.zoom).toBe(64)
    expect(tile.nativeNavigationDevice).toBeUndefined()
    expect(f.container.querySelector('[data-detail-ready="true"]')).toBeNull()
    expect(f.props.onFallback).not.toHaveBeenCalled()
  } finally { await act(async () => f.root.unmount()) }
})

for (const boundary of ['content', 'session', 'size', 'device'] as const) {
  test(`ordinary quiet coverage does not survive a mismatched ${boundary} owner`, async () => {
    vi.stubEnv('VITE_DESIGN_NATIVE_NAVIGATION', '0')
    const f = await fixture()
    try {
      const pending = state.pending[0]
      await f.quiet(boundary === 'content' ? { document: { ...f.props.document, nodes: { ...f.props.document.nodes } } } :
        boundary === 'session' ? { presentationEpoch: 1 } : boundary === 'size' ? { width: 120 } : {})
      if (boundary === 'device') await act(async () => state.composites.at(-1).onPresented(f.frame([]), undefined,
        { ...f.device, deviceIncarnation: f.device.deviceIncarnation + 1 }))
      expect(pending.signal.aborted).toBe(true)
      const bitmap = await f.complete()
      expect(bitmap.close).toHaveBeenCalledOnce()
      expect(state.composites.at(-1).items.some((item: any) => item.tile.bitmap === bitmap)).toBe(false)
      expect(f.container.querySelector('[data-detail-ready="true"]')).toBeNull()
      expect(f.props.onFallback).not.toHaveBeenCalled()
    } finally { await act(async () => f.root.unmount()) }
  })
}
