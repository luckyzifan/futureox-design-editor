import { markRenderFailure } from './render-failure-telemetry'
import React from 'react'
import { Editor } from '../engine'
import { afterEach, expect, test, vi } from 'vitest'
import { blank, node as makeNode, effect as makeEffect } from '../model'
import { ProgressiveSurfaceImpl } from './ProgressiveSurface'
import { NavigationZoom } from './navigation-zoom'
import { compositeDrawPlan, compositeRasterQuad } from './gpu/composite-draw-plan'
import {presentedFragmentQuality} from './gpu/presented-fragment-quality'
import { planTiles, type RasterTile } from './tile-cache'
import { prioritizeTileFill } from './tile-scheduler'
import { tileBatchPrepareViewport } from './tile-prepare-viewport'

const worker = vi.hoisted(() => ({ clients: [] as any[], calls: [] as any[], maintenance: [] as any[],
  plannedScales: [] as number[], plannedPhases: [] as { x: number; y: number }[],
  navigationEnabled: [] as boolean[], navigationFrameSampling: [] as boolean[], dpr: 1, dynamicPlan: false,
  policy: { cpuOnly: false, hdrCompositing: false, imageMips: false, imageAtlas: false,
    desktopFullMath: false, desktopDisplay: false },
  plan: undefined as RasterTile[] | undefined,
  zooming: false, cameraMoving: undefined as boolean | undefined, forceLod: false,
  navigation: { active: false, suspended: false, sample: undefined as any } }))
vi.mock('./use-navigation-zoom', () => ({ useNavigationZoom: (_view: unknown, _identity: unknown, enabled: boolean,
  _translation: boolean, _held: boolean, frame: boolean) => {
  worker.navigationEnabled.push(enabled)
  worker.navigationFrameSampling.push(frame === true)
  return enabled ? worker.navigation : { ...worker.navigation, active: false, sample: undefined, panEnabled: false }
} }))
vi.mock('./use-zoom-activity', () => ({ useZoomActivity: () => worker.zooming,
  useCameraActivity: () => worker.cameraMoving ?? worker.zooming }))
// This harness invokes the parent's hooks, never the child GPU compositor.
// Keep that explicit boundary from loading picking/WASM as a side effect.
vi.mock('./TileCompositeSurface', () => ({ TileCompositeSurface: () => null }))
vi.mock('./ResidentCompositeSurface', () => ({ ResidentCompositeSurface: () => null }))
vi.mock('./idle-raster-maintenance', () => ({ scheduleRasterMaintenance: (jobs: any[], submit: any, current: any) => {
  const cancel = vi.fn(); worker.maintenance.push({ jobs, submit, current, cancel }); return cancel
} }))
vi.mock('./canvas-raster-plan', async original => {
  const actual = await original<any>()
  return { ...actual, canvasLodScale: (...args: any[]) => worker.forceLod ? .125 : actual.canvasLodScale(...args) }
})
vi.mock('./client', () => ({
  renderExecutionPolicy: worker.policy,
  KernelClient: class {
    onDamage?: (damage: unknown) => void
    recordViewportDiagnostic = vi.fn()
    bindNavigationInput = vi.fn(() => () => {})
    cancelPreview = vi.fn()
    cancelTileFill = vi.fn()
    dispose = vi.fn()
    constructor() { worker.clients.push(this) }
    releasePresented = vi.fn()
    render(document: unknown, options: any, ...args: any[]) {
      return new Promise((resolve, reject) => worker.calls.push({ document, options, reject, signal: args[6], progress: args[5], resolve: (extra = {}) => resolve({
        milliseconds: 0, compileMs: 0, graphMs: 0, finishMs: 0, checkpointMs: 0,
        bytes: new Uint8Array(), backend: 'webgpu', ...extra,
      }) }))
    }
  },
}))
vi.mock('./module', () => ({ initializeKernelModule: async () => {} }))
vi.mock('./tile-plan-aligned', () => {
  const planTilesAligned = (bounds?: any, scale?: number, limit?: number, phase?: { x: number; y: number }) =>
    worker.dynamicPlan ? planTiles(bounds, scale!, limit, phase) : worker.plan ?? (worker.forceLod && scale === .125
    ? Array.from({ length: 8 }, (_, i) => ({ key: `.5:0:0:${i % 4}:${Math.floor(i / 4)}`,
      x: (i % 4) * 512 - 1, y: Math.floor(i / 4) * 512 - 1, width: 514, height: 514, zoom: .5 })) : [
    { key: '4:0:0:0:0', x: -1, y: -1, width: 514, height: 514, zoom: 4 },
    { key: '4:0:0:1:0', x: 511, y: -1, width: 514, height: 514, zoom: 4 },
  ])
  return {
    planTilesAligned,
    // This harness pins damage/cancellation semantics, not the prefetch rim:
    // rings 0 keeps its plan identical to the pre-rim planner output.
    tilePrefetchRingsFromHost: () => 0,
    planTilesWithPrefetchRim: (_bounds: unknown, scale: number, _limit: number, phase: { x: number; y: number }) => {
      worker.plannedScales.push(scale)
      worker.plannedPhases.push(phase)
      const viewport = planTilesAligned(_bounds, scale, _limit, phase).map(tile => worker.dynamicPlan || !phase.x && !phase.y ? tile : { ...tile,
        key: `${tile.key}/phase:${phase.x}:${phase.y}`, phaseX: phase.x, phaseY: phase.y })
      return { viewport, rim: [], cacheLimitSkipped: 0 }
    },
  }
})
vi.mock('./presentation', async importOriginal => ({
  ...await importOriginal<any>(), useDevicePixelRatio: () => worker.dpr,
  useDisplayCapability: () => undefined,
}))

/** Run the production surface's hooks/effects with already painted residents.
 * Worker synchronization is deliberately controllable so stale/cancelled
 * completions can be ordered adversarially. No raster results are invented. */
function surfaceHarness(seedResidents: boolean | RasterTile[] = true, sourceDoc = blank('resident document')) {
  const doc = sourceDoc, states: any[] = [], refs: any[] = [], memos: any[] = []
  const effectSlots: any[] = [], layoutSlots: any[] = []
  const keys = ['4:0:0:0:0', '4:0:0:1:0']
  const seededTiles = Array.isArray(seedResidents) ? seedResidents : seedResidents ? keys.map((key, i) => ({
    key, x: i * 512 - 1, y: -1, width: 514, height: 514, zoom: 4,
  })) : []
  const seededKeys = seededTiles.map(tile => tile.key)
  let stateIndex = 0, refIndex = 0, memoIndex = 0, effectIndex = 0, layoutIndex = 0
  let effects: (() => void)[] = [], layouts: (() => void)[] = []
  const same = (a: any[], b: any[]) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i])
  const schedule = (slots: any[], index: number, callback: () => any, deps: any[], list: (() => void)[]) => {
    if (!slots[index] || !same(slots[index].deps, deps)) list.push(() => {
      slots[index]?.cleanup?.(); slots[index] = { deps, cleanup: callback() }
    })
  }
  const hooks = {
    useSyncExternalStore(_subscribe: unknown, getSnapshot: () => unknown) { return getSnapshot() },
    useState(init: any) {
      const index = stateIndex++
      if (!(index in states)) {
        let value = typeof init === 'function' ? init() : init
        if (value instanceof Map) value = new Map(seededTiles.map((tile, i) => [tile.key, {
          ...tile,
          revision: 1, serial: i + 1, document: doc, bytes: new Uint8Array(), backend: 'webgpu',
        }]))
        states[index] = value
      }
      return [states[index], (next: any) => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
    },
    useRef(init: any) {
      const index = refIndex++
      if (!(index in refs)) refs[index] = { current: init instanceof Set ? new Set(seededKeys) : init }
      return refs[index]
    },
    useMemo(read: () => any, deps: any[]) {
      const index = memoIndex++
      if (!memos[index] || !same(memos[index].deps, deps)) memos[index] = { deps, value: read() }
      return memos[index].value
    },
    useEffect(callback: () => any, deps: any[]) { schedule(effectSlots, effectIndex++, callback, deps, effects) },
    useLayoutEffect(callback: () => any, deps: any[]) { schedule(layoutSlots, layoutIndex++, callback, deps, layouts) },
  }
  const props = { document: doc, pageId: doc.pages[0].id, width: 1024, height: 512,
    view: { x: 0, y: 0, zoom: 4 }, grid: false, backend: 'webgpu' as const,
    presentationEpoch: 0, onFallback: vi.fn() }
  const render = (override = {}) => {
    stateIndex = 0; refIndex = 0; memoIndex = 0; effectIndex = 0; layoutIndex = 0
    effects = []; layouts = []
    const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
    const previous = internals.H
    let output: any
    try { internals.H = hooks; output=ProgressiveSurfaceImpl({ ...props, ...override }) }
    finally { internals.H = previous }
    for (const run of layouts) run()
    for (const run of effects) run()
    return output
  }
  const dispose = () => [...effectSlots, ...layoutSlots].forEach(slot => slot?.cleanup?.())
  return { doc, keys, render, dispose,
    // Read-only planning inspection; active plan ids are nested in an object,
    // so a future capture key in a top-level Set is its residency protection.
    residentSets: () => refs.map(ref => ref.current).filter(value => value instanceof Set) as Set<string>[] }
}

const harnesses: ReturnType<typeof surfaceHarness>[] = []
const harness = (seedResidents: boolean | RasterTile[] = true, sourceDoc?:Parameters<typeof surfaceHarness>[1]) => { const value = surfaceHarness(seedResidents,sourceDoc); harnesses.push(value); return value }
afterEach(() => {
  for (const h of harnesses) h.dispose()
  harnesses.length = 0; worker.calls.length = 0; worker.clients.length = 0
  worker.zooming = false
  worker.cameraMoving = undefined; worker.plannedScales.length = 0; worker.plannedPhases.length = 0
  worker.plan = undefined
  worker.navigation = { active: false, suspended: false, sample: undefined }
  worker.forceLod = false; worker.maintenance.length = 0
  worker.navigationEnabled.length = 0; worker.dpr = 1; worker.dynamicPlan = false
  worker.navigationFrameSampling.length = 0
  Object.assign(worker.policy, { cpuOnly: false, hdrCompositing: false, imageMips: false, imageAtlas: false,
    desktopFullMath: false, desktopDisplay: false })
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

test('apply damage before selecting misses, retaining untouched painted residents', async () => {
  const h = harness(); h.render()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1))
  expect(worker.calls[0].options.tileViewport).toEqual([])
  worker.clients[0].onDamage({ full: false, bounds: [0, 0, 10, 10] })
  worker.calls[0].resolve()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(2))
  expect(worker.calls[1].options.tileViewport.map((tile: any) => tile.key)).toEqual([h.keys[0]])
})

test('damage retirement keeps the displayed bitmap alive until its frame leaves the display', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  const close = vi.fn(), bitmap = { close } as unknown as ImageBitmap
  const seeds = ['4:0:0:0:0', '4:0:0:1:0'].map((key, i) => ({
    key, x: i * 512 - 1, y: -1, width: 514, height: 514, zoom: 4,
    ...(i === 0 ? { bitmap } : {}),
  }))
  const h = harness(seeds)
  const nextPage = { ...h.doc.pages[0], id: 'bitmap-retirement-next-page', children: [] }
  h.doc.pages.push(nextPage)
  h.render({ backend: 'webgl2' }); await flushRasterWork()
  const completed = h.render({ backend: 'webgl2' })
  expect(surfaceParts(completed).wrapper.props['data-frame-publication']).toBe('complete')
  worker.clients[0].onDamage({ full: false, bounds: [0, 0, 10, 10] })
  expect(close).not.toHaveBeenCalled()
  const held = surfaceParts(h.render({ backend: 'webgl2' })).compositor.props.items
    .find((item: any) => item.tile.key === h.keys[0])
  expect(held.tile.bitmap).toBe(bitmap)
  // A page switch removes the old displayed frame. The next committed render
  // can now close its payload, which is no longer in active or inactive cache.
  h.render({ backend: 'webgl2', pageId: nextPage.id })
  h.render({ backend: 'webgl2', pageId: nextPage.id })
  expect(close).toHaveBeenCalledOnce()
})

test('cold visible detail starts before overview maintenance', async () => {
  const h = harness(); h.render({ overview: { x: 0, y: 0, width: 20000, height: 10000 } })
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1))
  worker.clients[0].onDamage({ full: true }); worker.calls[0].resolve()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(2))
  expect(worker.calls[1].options.renderIntent).toBe('canvas')
  expect(worker.calls[1].options.tileViewport.map((tile: any) => tile.key)).toEqual(h.keys)
  expect(worker.maintenance).toHaveLength(0)
})

test('overview is deferred after detail and cancelled by the next camera', async () => {
  const h = harness(), overview = { x: 0, y: 0, width: 20000, height: 10000 }
  h.render({ overview })
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1)); worker.calls[0].resolve()
  await vi.waitFor(() => expect(worker.maintenance).toHaveLength(1))
  expect(worker.calls).toHaveLength(1)
  const jobs = worker.maintenance[0].jobs
  expect(jobs).toHaveLength(1)
  expect(jobs[0].tiles).toHaveLength(1)
  expect(jobs[0].tiles[0].key).toMatch(/^navigation-overview:/)
  expect(worker.maintenance[0].current()).toBe(true)
  h.render({ overview, view: { x: 20, y: 0, zoom: 4 } })
  expect(worker.maintenance[0].cancel).toHaveBeenCalledTimes(1)
  expect(worker.maintenance[0].current()).toBe(false)
})

test('selected objects reserve the worker for live interaction instead of whole-page maintenance', async () => {
  const h = harness(), overview = { x: 0, y: 0, width: 20000, height: 10000 }
  const interaction = { document: h.doc, selection: ['selected'], active: false, epoch: 1, control: { current: null }, onReady() {} }
  h.render({ overview, interaction })
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1)); worker.calls[0].resolve()
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  expect(worker.maintenance).toHaveLength(0)
  h.render({ overview, interaction: { ...interaction, selection: [] } })
  await vi.waitFor(() => expect(worker.maintenance).toHaveLength(1))
})

test('pan schedules newly exposed work immediately without waiting for density debounce', async () => {
  const h = harness(); h.render()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1)); worker.calls[0].resolve()
  await Promise.resolve(); await Promise.resolve()
  worker.clients[0].onDamage({ full: false, bounds: [0, 0, 10, 10] })
  h.render({ view: { x: 40, y: 0, zoom: 4 } })
  await vi.waitFor(() => expect(worker.calls).toHaveLength(2))
  expect(worker.calls[1].options.renderIntent).toBe('canvas')
  expect(worker.calls[1].options.tileViewport.map((tile: any) => tile.key)).toEqual([h.keys[0]])
  expect(worker.clients[0].cancelTileFill).toHaveBeenCalledTimes(1)
})

test('a scale or document change still interrupts obsolete batches', async () => {
  const h = harness(); h.render()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1)); worker.calls[0].resolve()
  await Promise.resolve(); await Promise.resolve()
  h.render({ view: { x: 0, y: 0, zoom: 8 } })
  expect(worker.clients[0].cancelTileFill).toHaveBeenCalledTimes(2)
  h.render({ document: { ...h.doc, nodes: { ...h.doc.nodes } }, view: { x: 0, y: 0, zoom: 8 } })
  expect(worker.clients[0].cancelTileFill).toHaveBeenCalledTimes(3)
})

test('the first low-zoom frame requests native detail before any coarse preview', async () => {
  worker.forceLod = true
  const h = harness(); h.render({ width: 4096, height: 2048, view: { x: 0, y: 0, zoom: .2 } })
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1))
  worker.clients[0].onDamage({ full: true }); worker.calls[0].resolve()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(2))
  expect(worker.calls[1].options.renderIntent).toBe('canvas')
  expect(worker.calls[1].options.tileViewport.map((tile: any) => tile.key).sort()).toEqual([...h.keys].sort())
  expect(worker.calls[1].options.tilePrepareViewport).toBeDefined()
  worker.calls[1].resolve()
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  expect(worker.calls).toHaveLength(2)
})

test('zoom cannot treat unowned WebGPU handles as covering resident pixels', async () => {
  worker.zooming = true
  vi.stubGlobal('WebGL2RenderingContext', class {})
  vi.stubGlobal('navigator', { gpu: {} })
  const h = harness(); h.render({ width: 512, view: { x: -512, y: 0, zoom: 4 } })
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1))
  worker.clients[0].onDamage({ full: false, bounds: [0, 0, 10, 10] })
  worker.calls[0].resolve()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(2))
  expect(worker.calls[1].options.livePreview).toBe(true)
  worker.calls[1].resolve()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(3))
  expect(worker.calls[2].options.tileViewport.map((tile: any) => tile.key)).toEqual([h.keys[0]])
})

test('partly exposed views keep continuity when existing WebGPU ownership is unknown', async () => {
  worker.zooming = true
  vi.stubGlobal('WebGL2RenderingContext', class {})
  vi.stubGlobal('navigator', { gpu: {} })
  const h = harness(); h.render()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1))
  worker.clients[0].onDamage({ full: false, bounds: [0, 0, 10, 10] })
  worker.calls[0].resolve()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(2))
  expect(worker.calls[1].options.livePreview).toBe(true)
  worker.calls[1].resolve()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(3))
  expect(worker.calls[2].options.tileViewport.map((tile: any) => tile.key)).toEqual([h.keys[0]])
})

test('a low-zoom cold motion preview continues into exact tiles without another camera event', async () => {
  worker.zooming = true
  vi.stubGlobal('WebGL2RenderingContext', class {})
  vi.stubGlobal('navigator', { gpu: {} })
  const h = harness(); h.render({ view: {x:0,y:0,zoom:.2} })
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1))
  worker.clients[0].onDamage({ full: true })
  worker.calls[0].resolve()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(2))
  expect(worker.calls[1].options.livePreview).toBe(true)
  worker.calls[1].resolve()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(3))
  expect(worker.calls[2].options.tileViewport.map((tile: any) => tile.key).sort()).toEqual([...h.keys].sort())
  expect(worker.calls[2].options.renderIntent).toBe('canvas')
})

test('normal zoom continues to native pixels after an unowned-backing continuity capture', async () => {
  worker.zooming = true; worker.forceLod = true
  vi.stubGlobal('WebGL2RenderingContext', class {})
  vi.stubGlobal('navigator', { gpu: {} })
  const h = harness(); h.render()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1))
  worker.clients[0].onDamage({ full: true }); worker.calls[0].resolve()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(2))
  expect(worker.calls[1].options.livePreview).toBe(true)
  worker.calls[1].resolve()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(3))
  expect(worker.calls[2].options.renderIntent).toBe('canvas')
  expect(worker.calls[2].options.tileViewport.map((tile:any) => tile.key)).toEqual(h.keys)
})

test('metadata synchronization certifies retained pixels without requesting a raster', async () => {
  const h = harness(); h.render()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1))
  worker.calls[0].resolve()
  await Promise.resolve(); await Promise.resolve()
  const renamed = { ...h.doc, name: 'renamed only' }; h.render({ document: renamed })
  await vi.waitFor(() => expect(worker.calls).toHaveLength(2))
  expect(worker.calls[1].options.tileViewport).toEqual([])
  worker.clients[0].onDamage({ full: false })
  worker.calls[1].resolve()
  await Promise.resolve(); await Promise.resolve()
  expect(worker.calls).toHaveLength(2)
})

test('a hidden replacement backend still composes its ready tiles before handoff',async()=>{
  vi.stubGlobal('WebGL2RenderingContext',class {})
  vi.stubGlobal('navigator',{gpu:{}})
  const h=harness();h.render({visible:false})
  await vi.waitFor(()=>expect(worker.calls).toHaveLength(1))
  worker.calls[0].resolve();await Promise.resolve();await Promise.resolve()
  const tree=h.render({visible:false}),elements:any[]=[]
  const visit=(value:any)=>{
    if(Array.isArray(value)){value.forEach(visit);return}
    if(!value?.props)return
    elements.push(value);visit(value.props.children)
  }
  visit(tree)
  const wrapper=elements.find(e=>e.props.className==='kernel-tiles')
  const compositor=elements.find(e=>Array.isArray(e.props.items))
  expect(wrapper.props.style.visibility).toBe('hidden')
  expect(compositor.props.items.length).toBeGreaterThan(0)
  expect(compositor.props.items.every((item:any)=>item.active)).toBe(true)
})

test('cancelled earlier patch damage cannot be skipped by a newer clean synchronization', async () => {
  const h = harness(); h.render()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1))
  const latest = { ...h.doc, name: 'latest' }; h.render({ document: latest })
  // The mailbox now retains one active job and coalesces camera successors.
  // Damage from that active job still precedes the newer synchronization.
  worker.clients[0].onDamage({ full: false, bounds: [0, 0, 10, 10] })
  worker.calls[0].resolve()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(2))
  expect(worker.calls).toHaveLength(2) // Old work cannot schedule its tiles.
  worker.clients[0].onDamage({ full: false })
  worker.calls[1].resolve()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(3))
  expect(worker.calls[2].document).toBe(latest)
  expect(worker.calls[2].options.tileViewport.map((tile: any) => tile.key)).toEqual([h.keys[0]])
})

test.each([{ presentationEpoch: 1 }, { rasterProfile: 'figmaSubpixel' as const }])(
  'owner or raster contract change clears all old residents: %j', async override => {
    const h = harness(); h.render()
    await vi.waitFor(() => expect(worker.calls).toHaveLength(1))
    worker.calls[0].resolve()
    await Promise.resolve(); await Promise.resolve()
    h.render(override)
    await vi.waitFor(() => expect(worker.calls).toHaveLength(2))
    expect(worker.calls[1].options.tileViewport).toEqual([])
    worker.calls[1].resolve()
    await vi.waitFor(() => expect(worker.calls).toHaveLength(3))
    expect(worker.calls[2].options.tileViewport.map((tile: any) => tile.key)).toEqual(h.keys)
    worker.calls[2].resolve()
  },
)

test('settled zoom replaces motion density while the pan signal remains active', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  worker.zooming = true; worker.cameraMoving = true
  const h = harness(), options = { backend: 'webgl2' as const, view: { x: 0, y: 0, zoom: 31.5 } }
  h.render(options)
  await vi.waitFor(() => expect(worker.plannedScales).toEqual([32]))
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1))
  worker.calls[0].resolve()
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  // Density is already admitted; only the independent zoom settle signal
  // changes here. This must create an exact plan without another pointer move.
  worker.zooming = false
  h.render(options)
  await vi.waitFor(() => expect(worker.plannedScales).toEqual([32, 31.5]))
  expect(worker.clients[0].cancelTileFill).toHaveBeenCalledTimes(2)
})

async function flushRasterWork() {
  for (let i = 0; i < 8; i++) {
    worker.calls.forEach(call => call.resolve())
    await Promise.resolve()
  }
}

test('covered filtered navigation reprojects residents and resumes exact work when it settles', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  const h = harness(), blur = makeNode('rectangle')
  blur.effects = [makeEffect('blur')]
  h.doc.nodes[blur.id] = blur; h.doc.pages[0].children.push(blur.id)
  h.render({ backend: 'webgl2' }); await flushRasterWork()
  h.render({ backend: 'webgl2' })
  const before = worker.calls.length; worker.plannedScales.length = 0
  const view = { x: 0, y: 0, zoom: 4 }
  worker.navigation = { active: true, suspended: false, sample: { active: true, view, sequence: 1 } }
  h.render({ backend: 'webgl2', view }); await flushRasterWork()
  expect(worker.calls).toHaveLength(before)
  expect(worker.plannedScales).toEqual([])
  worker.navigation = { active: false, suspended: false, sample: undefined }
  h.render({ backend: 'webgl2', view }); await flushRasterWork()
  expect(worker.plannedScales).toEqual([4])
})

test('filtered navigation still renders a preview when retained pixels leave a gap', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  const h = harness(), blur = makeNode('rectangle')
  blur.effects = [makeEffect('blur')]
  h.doc.nodes[blur.id] = blur; h.doc.pages[0].children.push(blur.id)
  h.render({ backend: 'webgl2' }); await flushRasterWork()
  const before = worker.calls.length
  const view = { x: -2400, y: 0, zoom: 8 }
  worker.navigation = { active: true, suspended: false, sample: { active: true, view, sequence: 1 } }
  h.render({ backend: 'webgl2', view }); await flushRasterWork()
  expect(worker.calls.slice(before).some(call => call.options.livePreview && call.options.renderIntent === 'preview')).toBe(true)
})

test('held filtered pan reuses exact residents and bounded previews, then schedules only the latest exact release phase', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  const h = harness(), blur = makeNode('rectangle')
  blur.effects = [makeEffect('blur')]
  h.doc.nodes[blur.id] = blur; h.doc.pages[0].children.push(blur.id)
  h.render({ backend: 'webgl2' }); await flushRasterWork()
  const before = worker.calls.length
  worker.plannedScales.length = 0; worker.plannedPhases.length = 0
  worker.cameraMoving = true
  const policy = new NavigationZoom({ x: 0, y: 0, zoom: 4 }, { includeTranslation: true })
  const publish = (sample: ReturnType<NavigationZoom['update']>) => {
    worker.navigation = Object.assign({ active: sample.active, suspended: false,
      sample: sample.active ? sample : undefined }, { panEnabled: true })
  }
  let output: any
  for (let step = 0; step < 30; step++) {
    const view = { x: -step, y: 0, zoom: 4 }
    publish(policy.update(view, step * 16, true))
    output = h.render({ backend: 'webgl2', panGestureActive: true, view })
    await flushRasterWork()
    const { wrapper, compositor } = surfaceParts(output)
    expect(wrapper.props['data-detail-ready']).toBe('false')
    // Existing exact pixels remain active immediately; no replacement raster
    // or quiet timer is needed to show their translated coverage.
    expect(compositor.props.items.some((item: any) => item.active && h.keys.includes(item.tile.key))).toBe(true)
  }
  expect(worker.plannedScales).toEqual([])
  const motion = worker.calls.slice(before)
  expect(motion.length).toBeGreaterThan(0)
  expect(motion.length).toBeLessThanOrEqual(3)
  expect(motion.every(call => call.options.livePreview && call.options.renderIntent === 'preview')).toBe(true)
  const final = { x: -31.375, y: .125, zoom: 4 }
  publish(policy.update(final, 481, false))
  output = h.render({ backend: 'webgl2', panGestureActive: false, view: final })
  await flushRasterWork()
  expect(worker.plannedScales).toEqual([4])
  expect(worker.plannedPhases).toEqual([{ x: .625, y: .125 }])
  const native = worker.calls.slice(before).find(call => call.options.renderIntent === 'canvas' && call.options.tileViewport?.length)
  expect(native?.options.view).toEqual(final)
  expect(surfaceParts(output).wrapper.props['data-detail-ready']).toBe('false')
})

/** The real ProgressiveSurface orchestration and mailbox run here. Only the
 * raster transport/planner boundaries are doubles; this counts work admission,
 * not GPU speed or pixel fidelity. */
test.each([60, 120])('continuous 0.1x to 32x zoom at %i Hz skips intermediate exact plans', async hz => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const h = harness(), policy = new NavigationZoom({ x: 0, y: 0, zoom: .1 })
  const render = (view: { x: number; y: number; zoom: number }, at: number) => {
    const sample = policy.update(view, at)
    worker.navigation = { active: sample.active, suspended: false, sample: sample.active ? sample : undefined }
    h.render({ backend: 'webgl2', view })
  }
  render({ x: 0, y: 0, zoom: .1 }, 0); await flushRasterWork()
  worker.plannedScales.length = 0; const initialCalls = worker.calls.length
  for (let i = 1; i <= hz; i++) {
    render({ x: -i / hz * 20, y: i / hz * 10, zoom: i === hz ? 32 : .1 * 320 ** (i / hz) }, i * 1000 / hz)
    await flushRasterWork()
  }
  expect(worker.plannedScales).toEqual([])
  const previews = worker.calls.slice(initialCalls)
  expect(previews.length).toBeGreaterThan(0)
  expect(previews.length).toBeLessThanOrEqual(7)
  expect(previews.every(call => call.options.renderIntent === 'preview' && call.options.livePreview &&
    call.options.captureViewport === undefined && call.options.tileViewport === undefined)).toBe(true)
  expect(previews.every(call => call.options.width * call.options.height <= 1_050_000)).toBe(true)
  for (let at = 1016; at <= 1216; at += 16) {
    const sample = policy.frame(at)
    worker.navigation = { active: sample.active, suspended: false, sample: sample.active ? sample : undefined }
    h.render({ backend: 'webgl2', view: { x: -20, y: 10, zoom: 32 } })
    await flushRasterWork()
  }
  expect(worker.navigation.active).toBe(false)
  expect(worker.plannedScales).toEqual([32])
})

test('unoptimized per-camera policy admits many intermediate plans for the same one-second gesture', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const h = harness()
  h.render({ backend: 'webgl2', view: { x: 0, y: 0, zoom: .1 } }); await flushRasterWork()
  worker.plannedScales.length = 0
  for (let i = 1; i <= 60; i++) {
    h.render({ backend: 'webgl2', view: { x: 0, y: 0, zoom: .1 * 320 ** (i / 60) } })
    await flushRasterWork()
  }
  expect(worker.plannedScales.length).toBe(60)
})

test('same preview sample is not resubmitted on every pan event, but resizing admits its new extent', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  worker.navigation = { active: true, suspended: false,
    sample: { active: true, sequence: 1, view: { x: 0, y: 0, zoom: 32 } } }
  const h = harness()
  h.render({ backend: 'webgl2', view: { x: 0, y: 0, zoom: 32 } }); await flushRasterWork()
  expect(worker.calls).toHaveLength(1)
  h.render({ backend: 'webgl2', view: { x: 10, y: 0, zoom: 32 } }); await flushRasterWork()
  expect(worker.calls).toHaveLength(1)
  h.render({ backend: 'webgl2', width: 800, view: { x: 10, y: 0, zoom: 32 } }); await flushRasterWork()
  expect(worker.calls).toHaveLength(2)
  expect(worker.calls[1].options.width).toBe(800)
  expect(worker.plannedScales).toEqual([])
})

test('hidden navigation cancels previews and admits no exact work until visible', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  worker.navigation = { active: true, suspended: false,
    sample: { active: true, sequence: 1, view: { x: 0, y: 0, zoom: 32 } } }
  const h = harness(), options = { backend: 'webgl2', view: { x: 0, y: 0, zoom: 32 } }
  h.render(options); await flushRasterWork()
  worker.navigation = { active: false, suspended: true, sample: undefined }
  h.render(options); await flushRasterWork()
  expect(worker.plannedScales).toEqual([])
  expect(worker.clients[0].cancelPreview).toHaveBeenCalledTimes(2)
  worker.navigation = { active: false, suspended: false, sample: undefined }
  h.render(options); await flushRasterWork()
  expect(worker.plannedScales).toEqual([32])
})

test('fractional pan settles onto native phase once, while identical camera renders add no jobs', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  worker.cameraMoving = true
  const h = harness(), options = { backend: 'webgl2', view: { x: .1, y: -.375, zoom: 32 } }
  let output = h.render(options); await flushRasterWork()
  expect(worker.plannedPhases).toEqual([{ x: 0, y: 0 }])
  expect(output.props.children[1].props['data-raster-phase-exact']).toBe('false')
  expect(output.props.children[1].props['data-detail-ready']).toBe('false')
  worker.cameraMoving = false
  output = h.render(options); await flushRasterWork()
  expect(worker.plannedPhases).toEqual([{ x: 0, y: 0 }, { x: .1, y: .625 }])
  const native = worker.calls.at(-1).options
  expect(native.view).toEqual({ x: .1, y: -.375, zoom: 32 })
  expect(native.tileViewport.every((tile: any) => tile.phaseX === .1 && tile.phaseY === .625)).toBe(true)
  expect(output.props.children[1].props['data-raster-phase-exact']).toBe('true')
  // Native pixels have not arrived/presented in this transport harness.
  expect(output.props.children[1].props['data-detail-ready']).toBe('false')
  // Complete the pending transport chain before measuring a no-work revisit.
  // Resolving a preview alone does not deliver or acknowledge native tiles.
  const settled = new Set<any>()
  for(let step=0;step<24;step++){
    for(const call of worker.calls){if(settled.has(call))continue;settled.add(call)
      for(const tile of call.options.tileViewport||[]){
        call.progress({...tile,bytes:new Uint8Array(),backend:'webgl2',cached:false})
        const compositor=surfaceParts(h.render(options)).compositor
        const ready=compositor.props.items.find((item:any)=>item.tile.key===tile.key)?.tile
        if(ready)compositor.props.onReady(ready.key,ready.serial,false)
      }
      call.resolve()
    }
    await Promise.resolve();await Promise.resolve();h.render(options)
  }
  const calls = worker.calls.length, plans = worker.plannedScales.length
  for (let i = 0; i < 240; i++) h.render(options)
  await flushRasterWork()
  expect(worker.calls).toHaveLength(calls)
  expect(worker.plannedScales).toHaveLength(plans)
})

test('integer-pixel pan keeps canonical resident hits without a settle reraster', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  worker.cameraMoving = true
  const h = harness(), options = { backend: 'webgl2', view: { x: 1, y: -2, zoom: 4 } }
  h.render(options); await flushRasterWork()
  expect(worker.calls).toHaveLength(1) // Only document synchronization.
  worker.cameraMoving = false
  h.render(options); await flushRasterWork()
  expect(worker.plannedPhases.every(phase => phase.x === 0 && phase.y === 0)).toBe(true)
  expect(worker.calls).toHaveLength(1)
})

async function acknowledgedNavigationCapture(h: ReturnType<typeof harness>, options: any, index: number,
  gpuTile: number, deviceOwner = 1) {
  await vi.waitFor(() => expect(worker.calls.length).toBeGreaterThan(index))
  worker.calls[index].resolve({ gpuTile }); await settleRejected()
  let compositor = surfaceParts(h.render(options)).compositor
  const tile = compositor.props.items.find((item: any) => item.tile.gpuTile === gpuTile).tile
  compositor.props.onReady(tile.key, tile.serial, false)
  compositor = surfaceParts(h.render(options)).compositor
  compositor.props.onPresented({ view: options.view, width: options.width, height: options.height,
    dpr: worker.dpr, interaction: false, ids: [gpuTile] }, undefined,
    { client: worker.clients[0], deviceWorkerScope: 11, deviceIncarnation: 1, deviceOwner })
  h.render(options)
  return tile
}

async function navigationReturnFixture() {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  vi.stubGlobal('navigator', { gpu: {} })
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {})
  const h = harness(false), first = { backend: 'webgpu', width: 512, height: 256,
    view: { x: -12.125, y: 7.375, zoom: 2 } }
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 1, view: first.view } }
  h.render(first)
  const a = await acknowledgedNavigationCapture(h, first, 0, 801)
  const second = { ...first, view: { ...first.view, x: first.view.x - 20 } }
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 2, view: second.view } }
  h.render(second)
  const b = await acknowledgedNavigationCapture(h, second, 1, 802)
  return { h, first, second, a, b }
}

test('default whole-navigation revisits retain the actual acknowledged texture after idle without a worker render', async () => {
  const { h, first, a } = await navigationReturnFixture(), before = worker.calls.length
  const now = performance.now(), clock = vi.spyOn(performance, 'now').mockReturnValue(now + 60_000)
  try {
    worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 3, view: first.view } }
    h.render(first); await settleRejected()
    const compositor = surfaceParts(h.render(first)).compositor
    expect(worker.calls).toHaveLength(before)
    expect(compositor.props.items.find((item: any) => item.tile === a)?.active).toBe(true)
    expect(a.gpuTile).toBe(801)
    expect(compositor.props.reuseSequence).toBeGreaterThan(0) // Force a real presentation/input ACK of reused pixels.
    expect(compositor.props.view).toEqual(first.view)
  } finally { clock.mockRestore() }
})

test.each(['document', 'dpr', 'device-owner'] as const)('whole-navigation revisit cannot cross %s ownership', async kind => {
  const { h, first, second, a } = await navigationReturnFixture(), before = worker.calls.length
  let returning: any = first
  if (kind === 'document') returning = { ...first, document: { ...h.doc, nodes: { ...h.doc.nodes } } }
  if (kind === 'dpr') worker.dpr = 2
  if (kind === 'device-owner') {
    const compositor = surfaceParts(h.render(second)).compositor
    compositor.props.onPresented({ view: second.view, width: second.width, height: second.height,
      dpr: 1, interaction: false, ids: [802] }, undefined,
      { client: worker.clients[0], deviceWorkerScope: 11, deviceIncarnation: 1, deviceOwner: 2 })
    expect(surfaceParts(h.render(second)).compositor.props.items.some((item: any) => item.tile === a)).toBe(false)
  }
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 3, view: first.view } }
  h.render(returning); await settleRejected()
  expect(worker.calls).toHaveLength(before + 1)
  expect(worker.calls.at(-1).options.livePreview).toBe(true)
})

test.each(['text', 'plain-image'] as const)('default %s navigation reuses covering physical-density tiles before a redundant coarse capture', async kind => {
  vi.stubGlobal('WebGL2RenderingContext', class {}); vi.stubGlobal('navigator', { gpu: {} })
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {})
  const h = harness(), source = makeNode(kind === 'text' ? 'text' : 'rectangle')
  if (kind === 'plain-image') source.fills[0] = { ...source.fills[0], kind: 'image', image: 'data:image/png;base64,unchanged-source' }
  h.doc.nodes[source.id] = source; h.doc.pages[0].children.push(source.id)
  const options = { backend: 'webgpu', width: 512, height: 256, view: { x: 0, y: 0, zoom: 4 } }
  h.render(options); await flushRasterWork(); h.render(options)
  const before = worker.calls.length
  const tree = surfaceParts(h.render(options)).compositor
  // Transport-double handles stand in only for the parent's existing ready
  // residents. This does not exercise the child GPU compositor or pixels.
  tree.props.items.forEach((item: any, index: number) => { item.tile.gpuTile = 900 + index })
  tree.props.onPresented({ view: options.view, width: options.width, height: options.height,
    dpr: worker.dpr, interaction: false, ids: tree.props.items.map((item: any) => item.tile.gpuTile) }, undefined,
    { client: worker.clients[0], deviceWorkerScope: 11, deviceIncarnation: 1, deviceOwner: 1 })
  h.render(options)
  const next = { ...options, view: { x: -20, y: -10, zoom: 4 } }
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 1, view: next.view } }
  h.render(next); await settleRejected()
  const compositor = surfaceParts(h.render(next)).compositor
  expect(worker.calls).toHaveLength(before)
  expect(compositor.props.reuseSequence).toBeGreaterThan(0)
  expect(compositor.props.items.some((item: any) => item.active)).toBe(true)
})

test.each(['under-density', 'partial-coverage'] as const)('navigation still captures when cached tiles have %s', async kind => {
  vi.stubGlobal('WebGL2RenderingContext', class {}); vi.stubGlobal('navigator', { gpu: {} })
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {})
  const h = harness(), options = { backend: 'webgpu', width: 512, height: 256, view: { x: 0, y: 0, zoom: 4 } }
  h.render(options); await flushRasterWork(); h.render(options)
  const ready = surfaceParts(h.render(options)).compositor
  ready.props.items.forEach((item: any, index: number) => { item.tile.gpuTile = 950 + index })
  ready.props.onPresented({ view: options.view, width: options.width, height: options.height,
    dpr: worker.dpr, interaction: false, ids: ready.props.items.map((item: any) => item.tile.gpuTile) }, undefined,
    { client: worker.clients[0], deviceWorkerScope: 11, deviceIncarnation: 1, deviceOwner: 1 })
  h.render(options)
  const before = worker.calls.length, next = { ...options, view: kind === 'under-density'
    ? { x: 0, y: 0, zoom: 8 } : { x: -1500, y: 0, zoom: 4 } }
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 1, view: next.view } }
  h.render(next); await settleRejected()
  expect(worker.calls).toHaveLength(before + 1)
  expect(worker.calls.at(-1).options.livePreview).toBe(true)
})

test('navigation cannot reuse old-device native tiles after a new owner acknowledges its frame', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {}); vi.stubGlobal('navigator', { gpu: {} })
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {})
  const h = harness(), options = { backend: 'webgpu', width: 512, height: 256, view: { x: 0, y: 0, zoom: 4 } }
  h.render(options); await flushRasterWork(); h.render(options)
  const first = surfaceParts(h.render(options)).compositor
  first.props.items.forEach((item: any, index: number) => { item.tile.gpuTile = 980 + index })
  const owner = { client: worker.clients[0], deviceWorkerScope: 11, deviceIncarnation: 1, deviceOwner: 1 }
  first.props.onPresented({ view: options.view, width: options.width, height: options.height, dpr: 1,
    interaction: false, ids: [980, 981] }, undefined, owner)
  let current = surfaceParts(h.render(options)).compositor
  expect(current.props.items).toHaveLength(2) // First known owner preserves the just-ACKed native frame.
  current.props.onPresented({ view: options.view, width: options.width, height: options.height, dpr: 1,
    interaction: false, ids: [] }, undefined, { ...owner, deviceIncarnation: 2, deviceOwner: 2 })
  const changed = surfaceParts(h.render(options))
  current = changed.compositor
  // The previous displayed-frame handoff may remain mounted until repair.
  // It is no longer active cache residency or a certificate for this owner.
  expect(changed.wrapper.props['data-tile-count']).toBe(0)
  const before = worker.calls.length, next = { ...options, view: { x: -20, y: -10, zoom: 4 } }
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 1, view: next.view } }
  h.render(next); await settleRejected()
  expect(worker.calls).toHaveLength(before + 1)
  expect(worker.calls.at(-1).options.livePreview).toBe(true)
})

test('many resizes of a blocked navigation sample retain only the latest waiting extent', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  worker.navigation = { active: true, suspended: false,
    sample: { active: true, sequence: 1, view: { x: 0, y: 0, zoom: 32 } } }
  const h = harness(), options = { backend: 'webgl2', view: { x: 0, y: 0, zoom: 32 } }
  h.render({ ...options, width: 500 })
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1))
  for (let width = 501; width <= 700; width++) h.render({ ...options, width })
  worker.calls[0].resolve()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(2))
  expect(worker.calls[1].options.width).toBe(700)
  await flushRasterWork()
  expect(worker.calls).toHaveLength(2)
})

test('navigation budget errors containing real device loss still report failure', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  worker.navigation = { active: true, suspended: false,
    sample: { active: true, sequence: 1, view: { x: 0, y: 0, zoom: 32 } } }
  const h = harness(), onRenderFailure = vi.fn()
  h.render({ backend: 'webgl2', view: { x: 0, y: 0, zoom: 32 }, onRenderFailure })
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1))
  worker.calls[0].reject(Error('GPU surface budget exceeded; device lost'))
  await vi.waitFor(() => expect(onRenderFailure).toHaveBeenCalledTimes(1))
})

function surfaceParts(tree: any) {
  const wrapper = tree.props.children.find((element: any) => element?.props?.className === 'kernel-tiles')
  return { wrapper, compositor: wrapper.props.children }
}

// Production planner geometry, including filtering gutters, but a distinct
// lower-density key: these pixels cover a region without being an exact hit.
function coveringPreview(tile: RasterTile): RasterTile {
  return { ...tile, key: `coverage:${tile.key}`, zoom: tile.zoom / 2,
    x: (tile.x + 1) / 2 - 1, y: (tile.y + 1) / 2 - 1,
    width: (tile.width - 2) / 2 + 2, height: (tile.height - 2) / 2 + 2 }
}

test.each([{ moving: true, batch: 4 }, { moving: false, batch: 32 }])(
  'a later-batch visible hole precedes covered refinement with batch size $batch', async ({ moving, batch }) => {
    const bounds = { x: 0, y: 0, width: 3072, height: 3072 }
    const planned = planTiles(bounds, 1)
    const centered = prioritizeTileFill(planned, bounds).onScreen
    const hole = centered.at(-1)!
    expect(centered.indexOf(hole)).toBeGreaterThanOrEqual(batch)
    worker.plan = planned; worker.cameraMoving = moving
    const h = harness(planned.filter(tile => tile !== hole).map(coveringPreview))
    const options = { width: bounds.width, height: bounds.height, view: { x: 0, y: 0, zoom: 1 } }
    h.render(options)
    await vi.waitFor(() => expect(worker.calls).toHaveLength(1)); worker.calls[0].resolve()
    const expected = [hole, ...centered.filter(tile => tile !== hole)]
    for (let offset = 0, callIndex = 1; offset < planned.length; offset += batch, callIndex++) {
      await vi.waitFor(() => expect(worker.calls).toHaveLength(callIndex + 1))
      const call = worker.calls[callIndex]
      expect(call.options.tileViewport).toEqual(expected.slice(offset, offset + batch))
      expect(call.options.tileFillPriorities).toEqual(expected.slice(offset, offset + batch).map(tile => tile === hole ? 0 : 1))
      // Priority must not shrink the shared preparation guard or filtering
      // halos to the first visible hole; masks/effects still need the plan.
      expect(call.options.tilePrepareViewport).toEqual(
        tileBatchPrepareViewport(planned, [], call.options.tileViewport, call.options.view))
      expect(call.options.renderIntent).toBe('canvas')
      call.resolve()
    }
    await flushRasterWork()
    expect(worker.calls).toHaveLength(1 + Math.ceil(planned.length / batch))
    expect(worker.calls.slice(1).flatMap(call => call.options.tileViewport.map((tile: RasterTile) => tile.key)).sort())
      .toEqual(planned.map(tile => tile.key).sort())
    expect(worker.calls.some(call => call.options.livePreview)).toBe(false)
  },
)

test.each(['no pixels', 'covered preview'])('%s keeps center-first native requests without redundant work', async coverage => {
  const bounds = { x: 0, y: 0, width: 2560, height: 2560 }
  worker.plan = planTiles(bounds, 1); worker.cameraMoving = true
  const h = harness(coverage === 'covered preview' ? worker.plan.map(coveringPreview) : false)
  h.render({ width: bounds.width, height: bounds.height, view: { x: 0, y: 0, zoom: 1 } })
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1)); worker.calls[0].resolve()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(2))
  const centered = prioritizeTileFill(worker.plan, bounds).onScreen
  expect(worker.calls[1].options.tileViewport).toEqual(centered.slice(0, 4))
  expect(worker.calls[1].options.tileFillPriorities).toEqual(Array(4).fill(coverage === 'no pixels' ? 0 : 1))
  expect(worker.calls[1].options.tileViewport[0].key).toBe('1:0:0:2:2')
  expect(worker.calls[1].options.renderIntent).toBe('canvas')
})

test('superseded gap repair stops old batches and reuses tiles delivered while the latest plan waits', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  vi.stubGlobal('navigator', {})
  const bounds = { x: 0, y: 0, width: 3072, height: 3072 }
  worker.plan = planTiles(bounds, 1); worker.cameraMoving = true
  const h = harness(worker.plan.slice(0, -1).map(coveringPreview))
  const options = { backend: 'webgl2', width: bounds.width, height: bounds.height, view: { x: 0, y: 0, zoom: 1 } }
  h.render(options)
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1)); worker.calls[0].resolve()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(2))
  expect(worker.calls[1].options.livePreview).toBe(true)
  worker.calls[1].resolve()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(3))
  const running = worker.calls[2]
  for (let x = 1; x <= 100; x++) h.render({ ...options, width: bounds.width + x, view: { x, y: 0, zoom: 1 } })
  const latest = { ...options, width: bounds.width + 100, view: { x: 100, y: 0, zoom: 1 } }
  // Same-document pixels from the running batch can still serve the latest
  // camera. Mark actual progress ready before the mailbox admits its successor.
  for (const tile of running.options.tileViewport) {
    running.progress({ ...tile, bytes: new Uint8Array(), backend: 'webgl2', cached: false })
    const { compositor } = surfaceParts(h.render(latest))
    const presented = compositor.props.items.find((item: any) => item.tile.key === tile.key).tile
    compositor.props.onReady(presented.key, presented.serial, false)
  }
  running.resolve()
  for (let i = 0; i < 20; i++) await flushRasterWork()
  const native = worker.calls.filter(call => call.options.tileViewport?.length)
  expect(native).toHaveLength(Math.ceil(worker.plan.length / 4))
  // Analytic tiles use a canonical raster camera; the latest viewport extent
  // identifies the admitted successor without changing tile cache identity.
  expect(native.slice(1).every(call => call.options.width === latest.width)).toBe(true)
  const keys = native.flatMap(call => call.options.tileViewport.map((tile: RasterTile) => tile.key))
  expect(keys.sort()).toEqual(worker.plan.map(tile => tile.key).sort())
  expect(new Set(keys).size).toBe(worker.plan.length)
  const calls = worker.calls.length
  for (let i = 0; i < 30; i++) h.render(latest)
  await flushRasterWork()
  expect(worker.calls).toHaveLength(calls)
})

test('cold startup first paints one full viewport preview, then atomically reveals all exact tiles', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  const h = harness(false), options = { backend: 'webgl2', view: { x: 0, y: 0, zoom: 4 } }
  h.render(options)
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1))
  expect(worker.calls[0].options.tileViewport).toEqual([])
  worker.calls[0].resolve()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(2))
  expect(worker.calls[1].options.renderIntent).toBe('preview')
  expect(worker.calls[1].options.tileViewport).toBeUndefined()
  expect(worker.calls[1].options.width * worker.calls[1].options.height).toBeLessThanOrEqual(1_050_000)
  worker.calls[1].resolve()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(3))
  expect(worker.calls[2].options.renderIntent).toBe('canvas')
  let { wrapper, compositor } = surfaceParts(h.render(options))
  const preview = compositor.props.items.find((item: any) => item.tile.viewportPreview).tile
  compositor.props.onReady(preview.key, preview.serial, false)
  ;({ wrapper, compositor } = surfaceParts(h.render(options)))
  expect(wrapper.props.style.visibility).toBe('visible')
  expect(wrapper.props['data-startup-preview']).toBe('true')
  expect(wrapper.props['data-detail-ready']).toBe('false')
  const exact = worker.calls[2].options.tileViewport
  worker.calls[2].progress({ ...exact[0], bytes: new Uint8Array(), backend: 'webgpu', cached: false })
  ;({ compositor } = surfaceParts(h.render(options)))
  const first = compositor.props.items.find((item: any) => item.tile.key === exact[0].key).tile
  compositor.props.onReady(first.key, first.serial, false)
  ;({ compositor } = surfaceParts(h.render(options)))
  expect(compositor.props.items.filter((item: any) => item.active).map((item: any) => item.tile.key)).toEqual([preview.key])
  worker.calls[2].progress({ ...exact[1], bytes: new Uint8Array(), backend: 'webgpu', cached: false })
  ;({ compositor } = surfaceParts(h.render(options)))
  const second = compositor.props.items.find((item: any) => item.tile.key === exact[1].key).tile
  compositor.props.onReady(second.key, second.serial, false)
  worker.calls[2].resolve()
  ;({ wrapper, compositor } = surfaceParts(h.render(options)))
  expect(wrapper.props['data-detail-ready']).toBe('true')
  expect(compositor.props.items.filter((item: any) => item.active).map((item: any) => item.tile.key).sort())
    .toEqual(exact.map((tile: any) => tile.key).sort())
  const calls = worker.calls.length
  for (let i = 0; i < 120; i++) h.render(options)
  await flushRasterWork()
  expect(worker.calls).toHaveLength(calls)
})

test('optional startup budget failure continues exact work without repeated previews or partial exposure', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  const h = harness(false), options = { backend: 'webgl2', view: { x: 0, y: 0, zoom: 32 } }, failure = vi.fn()
  h.render({ ...options, onRenderFailure: failure })
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1)); worker.calls[0].resolve()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(2))
  worker.calls[1].reject(Error('PREVIEW_BUDGET: GPU surface budget exceeded'))
  await vi.waitFor(() => expect(worker.calls).toHaveLength(3))
  expect(worker.calls[2].options.renderIntent).toBe('canvas')
  const { wrapper } = surfaceParts(h.render(options))
  expect(wrapper.props.style.visibility).toBe('hidden')
  expect(wrapper.props['data-detail-ready']).toBe('false')
  expect(failure).not.toHaveBeenCalled()
  await flushRasterWork()
  for (let i = 0; i < 120; i++) h.render(options)
  expect(worker.calls.filter(call => call.options.renderIntent === 'preview')).toHaveLength(1)
})

test('late startup preview from another document is released and never becomes visible', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  const h = harness(false), options = { backend: 'webgl2', view: { x: 0, y: 0, zoom: 4 } }
  h.render(options)
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1)); worker.calls[0].resolve()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(2))
  const next = blank('next document')
  h.render({ ...options, document: next, pageId: next.pages[0].id })
  const bitmap = { close: vi.fn() }
  worker.calls[1].resolve({ bitmap, gpuTile: 901 })
  await vi.waitFor(() => expect(bitmap.close).toHaveBeenCalledOnce())
  expect(worker.clients[0].releasePresented).toHaveBeenCalledWith([901])
  const { wrapper, compositor } = surfaceParts(h.render({ ...options, document: next, pageId: next.pages[0].id }))
  expect(wrapper.props.style.visibility).toBe('hidden')
  expect(compositor.props.items.some((item: any) => item.tile.document === h.doc)).toBe(false)
})

test('reversed zoom with optional budget pressure retains the previous whole viewport preview', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  const h = harness(false), options = { backend: 'webgl2' }
  worker.navigation = { active: true, suspended: false,
    sample: { active: true, sequence: 1, view: { x: 0, y: 0, zoom: 32 } } }
  h.render({ ...options, view: worker.navigation.sample.view })
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1)); worker.calls[0].resolve()
  await settleRejected()
  let { wrapper, compositor } = surfaceParts(h.render({ ...options, view: worker.navigation.sample.view }))
  const preview = compositor.props.items.find((item: any) => item.tile.viewportPreview).tile
  compositor.props.onReady(preview.key, preview.serial, false)
  worker.navigation = { active: true, suspended: false,
    sample: { active: true, sequence: 2, view: { x: 0, y: 0, zoom: .1 } } }
  h.render({ ...options, view: worker.navigation.sample.view })
  await vi.waitFor(() => expect(worker.calls).toHaveLength(2))
  worker.calls[1].reject(Error('PREVIEW_BUDGET: GPU surface budget exceeded'))
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  ;({ wrapper, compositor } = surfaceParts(h.render({ ...options, view: worker.navigation.sample.view })))
  expect(wrapper.props.style.visibility).toBe('visible')
  expect(wrapper.props['data-detail-ready']).toBe('false')
  expect(compositor.props.items.find((item: any) => item.tile === preview)?.active).toBe(true)
  expect(worker.plannedScales).toEqual([])
})

// Real surface orchestration, with display-upload acknowledgements delayed.
// A navigation capture is provisional and therefore not in displayed.residents.
// Reusing its key must not tear down its pixels before the next upload is ready.
test.each(['webgl2', 'webgpu'] as const)('pending %s navigation replacement preserves acknowledged pixels at the live camera', async backend => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const h = harness(false)
  const first = { x: -12.125, y: 7.375, zoom: 2 }
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 1, view: first } }
  h.render({ backend, view: first })
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1))
  worker.calls[0].resolve({ gpuTile: backend === 'webgpu' ? 101 : undefined })
  await flushRasterWork()
  let compositor = surfaceParts(h.render({ backend, view: first })).compositor
  const old = compositor.props.items.find((item: any) => item.tile.viewportPreview).tile
  compositor.props.onReady(old.key, old.serial, false)
  compositor = surfaceParts(h.render({ backend, view: first })).compositor
  expect(compositor.props.items.find((item: any) => item.tile === old)?.active).toBe(true)
  const next = { x: -38.875, y: 20.125, zoom: 1.75 }
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 2, view: next } }
  h.render({ backend, view: next })
  await vi.waitFor(() => expect(worker.calls).toHaveLength(2))
  worker.calls[1].resolve() // bytes/bitmap transport still waiting for display upload
  await flushRasterWork()
  const live = { x: -40.25, y: 21.5, zoom: 1.7 }
  compositor = surfaceParts(h.render({ backend, view: next, requestedView: live })).compositor
  expect(compositor.props.view).toEqual(live)
  expect(compositor.props.items.find((item: any) => item.tile === old)?.active).toBe(true)
  const replacement = compositor.props.items.find((item: any) => item.tile.viewportPreview && item.tile !== old).tile
  expect(replacement.key).not.toBe(old.key)
  expect(compositor.props.items.find((item: any) => item.tile === replacement)?.active).toBe(false)
  compositor.props.onReady(replacement.key, replacement.serial, false)
  compositor = surfaceParts(h.render({ backend, view: next, requestedView: live })).compositor
  expect(compositor.props.items.find((item: any) => item.tile === replacement)?.active).toBe(true)
  expect(compositor.props.items.find((item: any) => item.tile === old)?.active).toBe(false)
})

test('repeated viewport extents of one navigation sample cannot replace an uploading capture', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  const h = harness(false), view = { x: -.25, y: .75, zoom: 2 }
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 1, view } }
  const captures: any[] = []
  for (const width of [800, 900, 800]) {
    h.render({ backend: 'webgl2', view, width }); await flushRasterWork()
    const compositor = surfaceParts(h.render({ backend: 'webgl2', view, width })).compositor
    const capture = compositor.props.items.at(-1).tile
    captures.push(capture)
    compositor.props.onReady(capture.key, capture.serial, false)
  }
  expect(new Set(captures.map(tile => tile.key)).size).toBe(3)
  const compositor = surfaceParts(h.render({ backend: 'webgl2', view, width: 800 })).compositor
  expect(captures.every(capture => compositor.props.items.some((item: any) => item.tile === capture))).toBe(true)
  expect(compositor.props.items.filter((item: any) => item.active).map((item: any) => item.tile)).toEqual([captures[2]])
})

test('navigation history remains byte-budgeted during a long gesture', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const h = harness(false)
  let compositor: any
  for (let sequence = 1; sequence <= 80; sequence++) {
    const view = { x: sequence / 8, y: -sequence / 4, zoom: 2 + sequence / 100 }
    worker.navigation = { active: true, suspended: false, sample: { active: true, sequence, view } }
    h.render({ backend: 'webgl2', view })
    await vi.waitFor(() => expect(worker.calls).toHaveLength(sequence))
    worker.calls.at(-1).resolve({ gpuTile: sequence })
    await flushRasterWork()
    compositor = surfaceParts(h.render({ backend: 'webgl2', view })).compositor
    const capture = compositor.props.items.at(-1).tile
    compositor.props.onReady(capture.key, capture.serial, false)
  }
  expect(worker.calls).toHaveLength(80)
  expect(compositor.props.items.length).toBeGreaterThan(1)
  expect(compositor.props.items.length).toBeLessThan(80)
  expect(compositor.props.items.at(-1).tile.serial).toBe(80)
  expect(compositor.props.items.some((item: any) => item.tile.serial === 1)).toBe(false)
  const released = worker.clients[0].releasePresented.mock.calls.flatMap((args: any[]) => args[0])
  expect(released).toContain(1)
  expect(released).not.toContain(80)
  expect(new Set(released).size).toBe(released.length)
})


test.each(['document', 'page', 'epoch'] as const)('a pending navigation capture cannot survive a %s contract change', async change => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  const h = harness(false), view = { x: -.25, y: .75, zoom: 2 }
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 1, view } }
  h.render({ backend: 'webgl2', view })
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1))
  const override = change === 'document' ? { document: blank('replacement') } :
    change === 'page' ? { pageId: 'another-page' } : { presentationEpoch: 1 }
  h.render({ backend: 'webgl2', view, ...override })
  const close = vi.fn()
  worker.calls[0].resolve({ gpuTile: 301, bitmap: { close } })
  await flushRasterWork()
  const compositor = surfaceParts(h.render({ backend: 'webgl2', view, ...override })).compositor
  expect(compositor.props.items.some((item: any) => item.tile.gpuTile === 301)).toBe(false)
  expect(worker.clients[0].releasePresented).toHaveBeenCalledWith([301])
  expect(close).toHaveBeenCalledTimes(1)
})

test('overlapping captures with translucent scene pixels never double-compose during handoff', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  const h = harness(false), view = { x: -.25, y: .75, zoom: 2 }
  let compositor: any
  for (const sequence of [1, 2]) {
    worker.navigation = { active: true, suspended: false, sample: { active: true, sequence, view } }
    h.render({ backend: 'webgl2', view }); await flushRasterWork()
    compositor = surfaceParts(h.render({ backend: 'webgl2', view })).compositor
    const capture = compositor.props.items.at(-1).tile
    compositor.props.onReady(capture.key, capture.serial, false)
  }
  compositor = surfaceParts(h.render({ backend: 'webgl2', view })).compositor
  // Production navigation captures include the opaque page background, even
  // when authored nodes are translucent. They are replacement planes, not
  // independently alpha-blended scene fragments.
  expect(worker.calls.every(call => call.options.transparent === false)).toBe(true)
  expect(compositor.props.items.every((item: any) => !item.blend)).toBe(true)
  const draws = compositeDrawPlan(compositor.props.items, view, 1024, 512)
  expect(draws).toHaveLength(1)
  expect(draws[0].item.tile.serial).toBe(2)
  expect(draws[0].clip).toEqual({ left: 0, top: 0, right: 1024, bottom: 512 })
})

test('page A → B → A reuses bounded mounted pixels without another raster request', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  const h = harness()
  h.doc.pages.push({ ...h.doc.pages[0], id: 'page-b', name: 'B', children: [] })
  h.render()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1))
  worker.calls[0].resolve()
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  let { compositor } = surfaceParts(h.render())
  const original = compositor.props.items.map((item: any) => item.tile)
  h.render({ pageId: 'page-b' })
  ;({ compositor } = surfaceParts(h.render({ pageId: 'page-b' })))
  expect(compositor.props.items.filter((item: any) => original.includes(item.tile)).every((item: any) => !item.active)).toBe(true)
  const before = worker.calls.length
  h.render()
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  const restored = surfaceParts(h.render())
  expect(restored.compositor.props.items.map((item: any) => item.tile)).toEqual(original)
  expect(restored.wrapper.props['data-page-cache-hits']).toBe(1)
  expect(worker.calls).toHaveLength(before)
  expect(worker.clients).toHaveLength(1)
})

test('inactive page pixels are discarded on an edit, including undo/font/resource replacements', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  const h = harness()
  h.doc.pages.push({ ...h.doc.pages[0], id: 'page-b', name: 'B', children: [] })
  h.render()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1)); worker.calls[0].resolve()
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  h.render({ pageId: 'page-b' })
  const changed = { ...h.doc, fonts: {} }
  h.render({ pageId: 'page-b', document: changed })
  const next = surfaceParts(h.render({ document: changed }))
  expect(next.wrapper.props['data-page-cache-bytes']).toBe(0)
  expect(next.compositor.props.items.some((item: any) => item.tile.document === h.doc)).toBe(false)
})

test('fast zoom-out prefers the wider phase-native viewport while the new wide capture is delayed', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const h = harness(false)
  for (const [sequence, zoom] of [[1, .25], [2, 4]]) {
    const view = { x: 0, y: 0, zoom }
    worker.navigation = { active: true, suspended: false, sample: { active: true, sequence, view } }
    h.render({ backend: 'webgl2', view }); await flushRasterWork()
    const compositor = surfaceParts(h.render({ backend: 'webgl2', view })).compositor
    const capture = compositor.props.items.at(-1).tile
    compositor.props.onReady(capture.key, capture.serial, false)
  }
  const view = { x: 0, y: 0, zoom: .25 }
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 3, view } }
  const output = h.render({ backend: 'webgl2', view })
  await vi.waitFor(() => expect(worker.calls).toHaveLength(3)) // leave capture 3 blocked
  const { compositor, wrapper } = surfaceParts(output)
  expect(wrapper.props['data-detail-ready']).toBe('false')
  const draws = compositeDrawPlan(compositor.props.items, view, 1024, 512)
  const area = draws.reduce((sum, row) => sum + (row.clip.right - row.clip.left) * (row.clip.bottom - row.clip.top), 0)
  expect(area).toBe(1024 * 512)
  expect(draws.some(row => row.item.tile.zoom === .25)).toBe(true)
  expect(draws.every(row => row.item.tile.zoom === .25)).toBe(true)
  const quality=presentedFragmentQuality(draws.map(row=>({
    ...compositeRasterQuad(row.placement,row.clip,1024,512,1)!,
    sourceWidth:row.item.tile.width,sourceHeight:row.item.tile.height,
  })),1024,512)
  expect(quality.nativeCoverageComplete).toBe(true)
  expect(quality.nativePhaseCoverage).toBe(1)
})

// A pinned whole-page overview proves geometry coverage, not navigation-tier
// sampling quality. It must remain visible without suppressing the next sample.
test('coarse filtered-page overview cannot indefinitely suppress navigation-tier refresh', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  const overview: RasterTile = { key: 'overview:coarse', x: -1, y: -1, width: 514, height: 514, zoom: 1 / 32 }
  const h = harness([overview]), blur = makeNode('rectangle')
  blur.effects = [makeEffect('blur')]
  h.doc.nodes[blur.id] = blur; h.doc.pages[0].children.push(blur.id)
  const view = { x: 0, y: 0, zoom: 1 }
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 1, view } }
  h.render({ backend: 'webgl2', view })
  await vi.waitFor(() => expect(worker.calls.some(call => call.options.livePreview && call.options.renderIntent === 'preview')).toBe(true))
  const { compositor, wrapper } = surfaceParts(h.render({ backend: 'webgl2', view }))
  expect(compositor.props.items.find((item: any) => item.tile.key === overview.key)?.active).toBe(true)
  expect(wrapper.props['data-detail-ready']).toBe('false')
})

test('settled native repair refines coarse-only edges before an already-sharp center', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  const bounds = { x: 0, y: 0, width: 1536, height: 512 }
  worker.plan = planTiles(bounds, 1)
  const center = worker.plan.find(tile => tile.x === 511)!
  const overview: RasterTile = { key: 'overview:coarse', x: 0, y: 0, width: 48, height: 16, zoom: 1 / 32, gutter: 0 }
  const h = harness([overview, { ...center, key: 'old-sharp-center' }])
  h.render({ backend: 'webgl2', width: bounds.width, height: bounds.height, view: { x: 0, y: 0, zoom: 1 } })
  // Startup/coverage requests can precede native repair. Resolve those actual
  // requests instead of assuming that the second call is a tile fill.
  await vi.waitFor(async()=>{
    await flushRasterWork()
    expect(worker.calls.some(call=>call.options.renderIntent==='canvas'&&call.options.tileViewport?.length)).toBe(true)
  })
  const repair=worker.calls.find(call=>call.options.renderIntent==='canvas'&&call.options.tileViewport?.length)!
  const ordered = repair.options.tileViewport as RasterTile[]
  expect(ordered.at(-1)?.key).toBe(center.key)
  expect(ordered).toHaveLength(worker.plan.length)
  expect(ordered.every(tile => tile.zoom === 1)).toBe(true)
  expect(repair.options.renderIntent).toBe('canvas')
})

const compileBudget = () => markRenderFailure(new Error('PREVIEW_BUDGET: GPU surface budget exceeded'), { failureCategory: 3, failureCode: 64, failureStage: 5 })
test('budget latch suppresses same sampled target despite thirteen changing live inputs, then admits changed target', async () => {
 vi.stubGlobal('WebGL2RenderingContext', class {})
 const h=harness(false), sample={x: -18431.35,y: -17471.41,zoom:31.913}
 worker.navigation={active:true,suspended:false,sample:{active:true,sequence:1,view:sample}}
 h.render({backend:'webgl2',view:sample}); await vi.waitFor(()=>expect(worker.calls).toHaveLength(1))
 worker.calls[0].reject(compileBudget()); await settleRejected()
 for(let i=1;i<=13;i++){h.render({backend:'webgl2',view:{...sample,x:sample.x+i}});await settleRejected();if(worker.calls.length>i){worker.calls.at(-1).reject(compileBudget());await settleRejected()}}
 expect(worker.calls).toHaveLength(1)
 const next={...sample,x:sample.x+20}
 worker.navigation={active:true,suspended:false,sample:{active:true,sequence:2,view:next}}
 h.render({backend:'webgl2',view:next});await vi.waitFor(()=>expect(worker.calls).toHaveLength(2))
})
test('budget latch cannot poison final exact fill after navigation exit', async () => {
 vi.stubGlobal('WebGL2RenderingContext', class {})
 const h=harness(false), view={x:0,y:0,zoom:32}
 worker.navigation={active:true,suspended:false,sample:{active:true,sequence:1,view}}
 h.render({backend:'webgl2',view});await vi.waitFor(()=>expect(worker.calls).toHaveLength(1))
 worker.calls[0].reject(compileBudget());await settleRejected()
 worker.navigation={active:false,suspended:false,sample:undefined}
 h.render({backend:'webgl2',view});await vi.waitFor(()=>expect(worker.calls).toHaveLength(2))
 expect(worker.calls[1].options.livePreview).not.toBe(true)
})

async function settleRejected(){for(let i=0;i<32;i++)await Promise.resolve()}

test('old navigation rejection cannot clear newer admission or its budget latch', async () => {
 vi.stubGlobal('WebGL2RenderingContext', class {})
 const h=harness(false), first={x:0,y:0,zoom:32},next={x:10,y:0,zoom:32}
 worker.navigation={active:true,suspended:false,sample:{active:true,sequence:1,view:first}}
 h.render({backend:'webgl2',view:first});await vi.waitFor(()=>expect(worker.calls).toHaveLength(1))
 worker.navigation={active:true,suspended:false,sample:{active:true,sequence:2,view:next}}
 h.render({backend:'webgl2',view:next});await settleRejected()
 worker.calls[0].reject(compileBudget());await settleRejected()
 expect(worker.calls).toHaveLength(2)
 h.render({backend:'webgl2',view:{...next,x:11}});await settleRejected()
 expect(worker.calls).toHaveLength(2)
 worker.calls[1].reject(compileBudget());await settleRejected()
 h.render({backend:'webgl2',view:{...next,x:12}});await settleRejected()
 expect(worker.calls).toHaveLength(2)
})
test.each(['document','fonts','epoch'] as const)('failed navigation budget is invalidated by %s',async change=>{
 vi.stubGlobal('WebGL2RenderingContext', class {})
 const h=harness(false),view={x:0,y:0,zoom:32}
 worker.navigation={active:true,suspended:false,sample:{active:true,sequence:1,view}}
 h.render({backend:'webgl2',view});await vi.waitFor(()=>expect(worker.calls).toHaveLength(1))
 worker.calls[0].reject(compileBudget());await settleRejected()
 const override=change==='document'?{document:blank('new')}:change==='fonts'?{document:{...h.doc,fonts:{...h.doc.fonts}}}:{presentationEpoch:1}
 h.render({backend:'webgl2',view,...override});await vi.waitFor(()=>expect(worker.calls).toHaveLength(2))
})


test('real Editor page switching drives Surface reuse without new raster work or a new worker', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  const doc = blank('real page switch'), second = blank('second').pages[0]
  doc.pages.push(second)
  const editor = new Editor(doc), first = editor.state.page
  const h = surfaceHarness(true, editor.snapshot().doc); harnesses.push(h)
  const render = () => h.render({ document: editor.snapshot().doc, pageId: editor.state.page })
  try {
    render(); await vi.waitFor(() => expect(worker.calls).toHaveLength(1)); worker.calls[0].resolve()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    const original = surfaceParts(render()).compositor.props.items.map((item: any) => item.tile)
    editor.switchPage(second.id); render(); render()
    const before = worker.calls.length
    editor.switchPage(first); render()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    const restored = surfaceParts(render())
    expect(restored.compositor.props.items.map((item: any) => item.tile)).toEqual(original)
    expect(restored.wrapper.props['data-page-cache-hits']).toBe(1)
    expect(worker.calls).toHaveLength(before); expect(worker.clients).toHaveLength(1)
    expect(editor.canUndo).toBe(false)
  } finally { editor.dispose() }
})



test('a cold 3200% capture yields to a fourfold zoom-out before coverage is ready',async()=>{
  vi.stubGlobal('WebGL2RenderingContext', class {})
  vi.stubGlobal('navigator',{gpu:{}})
  vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{})
  const h=harness(false),first={x:0,y:0,zoom:32},next={x:0,y:0,zoom:1}
  worker.navigation={active:true,suspended:false,sample:{active:true,sequence:1,view:first}}
  h.render({backend:'webgpu',view:first});await settleRejected()
  const running=worker.calls[0]
  worker.navigation={active:true,suspended:false,sample:{active:true,sequence:2,view:next}}
  h.render({backend:'webgpu',view:next});await settleRejected()
  expect(running.signal.aborted).toBe(true)
  expect(worker.calls).toHaveLength(1)
  const close=vi.fn();running.resolve({gpuTile:1818,bitmap:{close}});await settleRejected()
  expect(close).toHaveBeenCalledOnce()
  expect(worker.calls).toHaveLength(2)
  expect(worker.calls[1].options.view).toEqual(next)
  expect(surfaceParts(h.render({backend:'webgpu',view:next})).compositor.props.items.some((item:any)=>item.tile.gpuTile===1818)).toBe(false)
})

test.each(['webgl2', 'webgpu'] as const)('pending %s preview survives raw pan and later samples, then starts only the latest waiting camera', async backend => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  vi.stubGlobal('navigator', { gpu: {} })
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {})
  const h = harness(false), first = { x: 0, y: 0, zoom: 32 }
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 1, view: first } }
  h.render({ backend, view: first }); await settleRejected()
  expect(worker.calls).toHaveLength(1)
  const signal = worker.calls[0].signal as AbortSignal
  expect(signal.aborted).toBe(false)
  h.render({ backend, view: { ...first, x: 10 } }); await settleRejected()
  expect(signal.aborted).toBe(false)
  expect(worker.calls).toHaveLength(1)
  let latest = first
  for (let sequence = 2; sequence <= 200; sequence++) {
    latest = { x: sequence, y: -sequence / 2, zoom: sequence % 2 ? 16 : 32 }
    worker.navigation = { active: true, suspended: false, sample: { active: true, sequence, view: latest } }
    h.render({ backend, view: latest }); await settleRejected()
    expect(signal.aborted).toBe(false)
    expect(worker.calls).toHaveLength(1)
  }
  worker.calls[0].resolve({ gpuTile: 818 }); await settleRejected()
  expect(worker.calls).toHaveLength(2)
  expect(worker.calls[1].options.view).toEqual(latest)
  expect(worker.calls[1].signal.aborted).toBe(false)
  const output = surfaceParts(h.render({ backend, view: latest }))
  const previous = output.compositor.props.items.find((item: any) => item.tile.gpuTile === 818).tile
  expect({ x: previous.x, y: previous.y, zoom: previous.zoom }).toEqual({ x: -first.x, y: -first.y, zoom: first.zoom })
  if (backend === 'webgpu') expect(previous.viewportCache.identity.view).toEqual(first)
  expect(output.compositor.props.view).toEqual(latest)
  expect(output.compositor.props.settledDocument).toBeUndefined()
  expect(output.wrapper.props['data-detail-ready']).toBe('false')
  expect(worker.clients[0].releasePresented).not.toHaveBeenCalledWith([818])
  worker.calls[1].resolve({ gpuTile: 819 }); await settleRejected()
  h.render({ backend, view: latest }); await settleRejected()
  expect(worker.calls).toHaveLength(2)
})

test.each(['edit', 'undo', 'fonts', 'page', 'epoch', 'dpr', 'extent', 'pause', 'hidden', 'suspended'] as const)(
  'a running and queued navigation capture lose ownership on %s, releasing a late result exactly once', async change => {
    vi.stubGlobal('WebGL2RenderingContext', class {})
    const h = harness(false), first = { x: -.25, y: .75, zoom: 2 }, next = { ...first, x: -20 }
    const base = { backend: 'webgl2', view: first }
    worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 1, view: first } }
    h.render(base); await settleRejected()
    const pending = worker.calls[0]
    worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 2, view: next } }
    h.render({ ...base, view: next }); await settleRejected()
    expect(pending.signal.aborted).toBe(false)
    let override: Record<string, unknown> = {}
    if (change === 'edit' || change === 'undo') override = { document: { ...h.doc, nodes: { ...h.doc.nodes } } }
    if (change === 'fonts') override = { document: { ...h.doc, fonts: { ...h.doc.fonts } } }
    if (change === 'page') override = { pageId: 'replacement-page' }
    if (change === 'epoch') override = { presentationEpoch: 1 }
    if (change === 'dpr') worker.dpr = 2
    if (change === 'extent') override = { width: 500 }
    if (change === 'pause') override = { paused: true }
    if (change === 'hidden') override = { visible: false }
    if (change === 'suspended') worker.navigation = { active: false, suspended: true, sample: undefined }
    h.render({ ...base, view: next, ...override }); await settleRejected()
    expect(pending.signal.aborted).toBe(true)
    const close = vi.fn()
    pending.resolve({ bitmap: { close }, gpuTile: 820 }); await settleRejected()
    const output = surfaceParts(h.render({ ...base, view: next, ...override }))
    expect(output.compositor.props.items.some((item: any) => item.tile.gpuTile === 820)).toBe(false)
    expect(close).toHaveBeenCalledOnce()
    expect(worker.clients[0].releasePresented.mock.calls.flatMap((args: any[]) => args[0]).filter((id: number) => id === 820))
      .toHaveLength(1)
  })

test('a changed acknowledged GPU owner cancels the running navigation capture before its late texture can publish', async () => {
  const { h, second } = await navigationReturnFixture()
  const latest = { ...second, view: { ...second.view, zoom: 32 } }
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 3, view: latest.view } }
  h.render(latest); await settleRejected()
  const pending = worker.calls[2]
  expect(pending.signal.aborted).toBe(false)
  const compositor = surfaceParts(h.render(latest)).compositor
  compositor.props.onPresented({ view: latest.view, width: latest.width, height: latest.height,
    dpr: worker.dpr, interaction: false, ids: [] }, undefined,
    { client: worker.clients[0], deviceWorkerScope: 11, deviceIncarnation: 2, deviceOwner: 2 })
  expect(pending.signal.aborted).toBe(true)
  const close = vi.fn()
  pending.resolve({ bitmap: { close }, gpuTile: 821 }); await settleRejected()
  const output = surfaceParts(h.render(latest))
  expect(output.compositor.props.items.some((item: any) => item.tile.gpuTile === 821)).toBe(false)
  expect(close).toHaveBeenCalledOnce()
  expect(worker.clients[0].releasePresented.mock.calls.flatMap((args: any[]) => args[0]).filter((id: number) => id === 821))
    .toHaveLength(1)
})

test('a completed old-camera capture under cache pressure cannot evict the held frame or borrow the latest foreground reserve', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {})
  // Real admission arithmetic, without allocating fake 128 MiB pixels. The
  // transport double supplies only handles; these two held sources consume
  // almost all of the production 128 MiB steady viewport allowance.
  const h = harness([
    { key: '4:0:0:0:0', x: -1, y: -1, width: 5760, height: 5760, zoom: 4 },
    { key: '4:0:0:1:0', x: 511, y: -1, width: 514, height: 514, zoom: 4 },
  ])
  const base = { backend: 'webgl2', view: { x: 0, y: 0, zoom: 4 } }, onFallback = vi.fn()
  h.render({ ...base, onFallback }); await flushRasterWork(); await settleRejected()
  const held = surfaceParts(h.render({ ...base, onFallback })).compositor.props.items.map((item: any) => item.tile)
  expect(surfaceParts(h.render({ ...base, onFallback })).wrapper.props['data-frame-publication']).toBe('complete')
  const first = { x: -100, y: 20, zoom: 32 }, latest = { x: -200, y: 40, zoom: 16 }
  const initialCalls = worker.calls.length
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 1, view: first } }
  h.render({ ...base, view: first, onFallback }); await settleRejected()
  const running = worker.calls[initialCalls]
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 2, view: latest } }
  h.render({ ...base, view: latest, onFallback }); await settleRejected()
  expect(running.signal.aborted).toBe(false)
  const close = vi.fn()
  running.resolve({ gpuTile: 822, bitmap: { close } }); await settleRejected()
  let current = surfaceParts(h.render({ ...base, view: latest, onFallback }))
  expect(current.compositor.props.items.some((item: any) => item.tile.gpuTile === 822)).toBe(false)
  expect(held.every((source: any) => current.compositor.props.items.some((item: any) => item.tile === source))).toBe(true)
  expect(close).toHaveBeenCalledOnce()
  expect(worker.calls).toHaveLength(initialCalls + 2)
  worker.calls.at(-1).resolve({ gpuTile: 823 }); await settleRejected()
  current = surfaceParts(h.render({ ...base, view: latest, onFallback }))
  expect(current.compositor.props.items.some((item: any) => item.tile.gpuTile === 823)).toBe(true)
  expect(held.every((source: any) => current.compositor.props.items.some((item: any) => item.tile === source))).toBe(true)
  expect(onFallback).not.toHaveBeenCalled()
  expect(worker.clients[0].releasePresented.mock.calls.flatMap((args: any[]) => args[0]).filter((id: number) => id === 822))
    .toHaveLength(1)
})

/** Use the real parent hook graph, mailbox, density helpers and tile geometry.
 * Raster transport and child presentation remain controlled doubles: these
 * assertions prove work admission, not actual wheel timing or sharp pixels. */
function nativeNavigationHost() {
  vi.stubEnv('VITE_DESIGN_NATIVE_NAVIGATION', '1'); vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', '1')
  vi.stubGlobal('WebGL2RenderingContext', class {}); vi.stubGlobal('navigator', { gpu: {} })
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {})
  Object.assign(worker.policy, { desktopFullMath: true, desktopDisplay: true }); worker.dpr = 2
}

test.each(['0','1'])('same-phase native pan repairs exposed tiles without recapturing the complete viewport (native=%s)',async native=>{
  nativeNavigationHost();vi.stubEnv('VITE_DESIGN_NATIVE_NAVIGATION',native);worker.dpr=1;worker.dynamicPlan=true
  const first={x:.25,y:.75,zoom:4},width=1024,height=512
  const bounds={x:-first.x/first.zoom,y:-first.y/first.zoom,width:width/first.zoom,height:height/first.zoom}
  const seeds=planTiles(bounds,4,256,{x:.25,y:.75}).map((tile,index)=>({...tile,gpuTile:18000+index}))
  const h=harness(seeds),options={width,height,view:first,rasterProfile:'figmaSubpixel'}
  h.render(options);await flushRasterWork()
  const ready=surfaceParts(h.render(options)).compositor
  ready.props.onPresented({view:first,width,height,dpr:1,interaction:false,ids:seeds.map(tile=>tile.gpuTile)},undefined,
    {client:worker.clients[0],deviceWorkerScope:11,deviceIncarnation:1,deviceOwner:1})
  expect(surfaceParts(h.render(options)).wrapper.props['data-frame-publication']).toBe('complete')
  const before=worker.calls.length,next={...options,view:{...first,x:first.x-20,y:first.y-10}}
  worker.cameraMoving=true
  worker.navigation={active:true,suspended:false,sample:{active:true,sequence:1,view:next.view}}
  h.render(next);await settleRejected()
  expect(worker.calls.length).toBeGreaterThan(before)
  expect(worker.calls.slice(before).every(call=>!call.options.livePreview&&Array.isArray(call.options.tileViewport))).toBe(true)
  expect(worker.calls[before].options.tileViewport.length).toBeGreaterThan(0)
  const old=new Set(seeds.map(tile=>tile.key))
  expect(worker.calls[before].options.tileViewport.every((tile:RasterTile)=>!old.has(tile.key))).toBe(true)
})

test.each([['0', '0', false], ['1', '0', false], ['0', '1', false], ['true', '1', false],
  ['1', 'true', false], ['1', '1', true]] as const)('native navigation requires strict flags %s/%s and retains physical DPR', async (native, clamp, expected) => {
  nativeNavigationHost(); vi.stubEnv('VITE_DESIGN_NATIVE_NAVIGATION', native); vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', clamp)
  const h = harness(false), view = { x: -.125, y: .375, zoom: 32 }
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 1, view } }
  const output = surfaceParts(h.render({ width: 855, height: 888, view, rasterProfile: 'figmaSubpixel' }))
  await settleRejected()
  expect(output.wrapper.props['data-native-navigation']).toBe(String(expected))
  expect(worker.navigationFrameSampling.at(-1)).toBe(expected)
  expect(worker.calls).toHaveLength(1)
  // Normal zoom now requests physical density on the ordinary path as well;
  // the experimental scheduling/capture-handoff flags stay independently off.
  const ratio = 2
  expect(worker.calls[0].options.width).toBe(855 * ratio); expect(worker.calls[0].options.height).toBe(888 * ratio)
  expect(worker.calls[0].options.view).toEqual({ x: view.x * ratio, y: view.y * ratio, zoom: view.zoom * ratio })
  expect(worker.calls[0].options.tileViewport).toBeUndefined()
  expect(worker.calls[0].options.renderIntent).toBe('preview')
  expect(worker.calls[0].options.previewTileFallback).toBe(true)
})

test.each(['cpu', 'webgl2', 'hdr', 'grid', 'checkerboard', 'pixelPreview', 'figmaSoftware', 'object-edit',
  'desktop-display-disabled', 'desktop-math-disabled'] as const)('native navigation does not cross the %s quality boundary', async boundary => {
  nativeNavigationHost()
  const h = harness(false), view = { x: 0, y: 0, zoom: 32 }
  const options: any = { view, rasterProfile: 'figmaSubpixel' }
  if (boundary === 'cpu' || boundary === 'webgl2') options.backend = boundary
  if (boundary === 'hdr') worker.policy.hdrCompositing = true
  if (boundary === 'grid') options.grid = true
  if (boundary === 'checkerboard') options.checkerboard = true
  if (boundary === 'pixelPreview') options.pixelPreview = 1
  if (boundary === 'figmaSoftware') options.rasterProfile = 'figmaSoftware'
  if (boundary === 'object-edit') options.interaction = { document: h.doc, selection: [], active: true,
    epoch: 0, control: { current: null }, onReady() {} }
  if (boundary === 'desktop-display-disabled') worker.policy.desktopDisplay = false
  if (boundary === 'desktop-math-disabled') worker.policy.desktopFullMath = false
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 1, view } }
  const output = surfaceParts(h.render(options)); await settleRejected()
  expect(output.wrapper.props['data-native-navigation']).toBe('false')
  expect(worker.navigationFrameSampling.at(-1)).toBe(false)
  expect(worker.calls.every(call => call.options.previewTileFallback === undefined)).toBe(true)
})

test('native regional fallback keeps the complete held image until its replacement upload is ready', async () => {
  nativeNavigationHost()
  const h = harness(false), first = { x: -.125, y: .375, zoom: 32 }, next = { x: -17.25, y: 12.125, zoom: 16 }
  const options = { width: 855, height: 888, rasterProfile: 'figmaSubpixel' }
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 1, view: first } }
  h.render({ ...options, view: first }); await settleRejected()
  const firstBitmap = { close: vi.fn() }
  worker.calls[0].resolve({ bitmap: firstBitmap, previewLane: 'regional-fallback' }); await settleRejected()
  let compositor = surfaceParts(h.render({ ...options, view: first })).compositor
  const held = compositor.props.items.find((item: any) => item.tile.bitmap === firstBitmap).tile
  compositor.props.onReady(held.key, held.serial, false)
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 2, view: next } }
  compositor = surfaceParts(h.render({ ...options, view: next })).compositor; await settleRejected()
  expect(worker.calls[1].options.previewTileFallback).toBe(true)
  expect(worker.calls[1].options.view).toEqual({ x: next.x * 2, y: next.y * 2, zoom: next.zoom * 2 })
  expect(compositor.props.items.find((item: any) => item.tile === held)?.active).toBe(true)
  expect(firstBitmap.close).not.toHaveBeenCalled()
  // Transport resolves only after the worker's complete private assembly;
  // this surface still withholds it while the child imports the bitmap.
  const completeBitmap = { close: vi.fn() }
  worker.calls[1].resolve({ bitmap: completeBitmap, previewLane: 'regional-fallback' }); await settleRejected()
  compositor = surfaceParts(h.render({ ...options, view: next })).compositor
  const replacement = compositor.props.items.find((item: any) => item.tile.bitmap === completeBitmap).tile
  expect(compositor.props.items.find((item: any) => item.tile === replacement)?.active).toBe(false)
  expect(compositor.props.items.find((item: any) => item.tile === held)?.active).toBe(true)
  compositor.props.onReady(replacement.key, replacement.serial, false)
  compositor = surfaceParts(h.render({ ...options, view: next })).compositor
  expect(compositor.props.items.find((item: any) => item.tile === replacement)?.active).toBe(true)
  expect(replacement.viewportCache.identity.view).toEqual(worker.calls[1].options.view)
  expect(replacement.width).toBe(1710); expect(replacement.height).toBe(1776)
})

test('native regional fallback preserves one running job and only the latest waiting camera', async () => {
  nativeNavigationHost()
  const h = harness(false), first = { x: -.125, y: .375, zoom: 32 }
  const options = { width: 855, height: 888, rasterProfile: 'figmaSubpixel' }
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 1, view: first } }
  h.render({ ...options, view: first }); await settleRejected()
  const running = worker.calls[0]
  let latest = first
  for (let sequence = 2; sequence <= 6; sequence++) {
    latest = { x: sequence / 8, y: -sequence / 4, zoom: sequence % 2 ? 16 : 32 }
    worker.navigation = { active: true, suspended: false, sample: { active: true, sequence, view: latest } }
    h.render({ ...options, view: latest }); await settleRejected()
  }
  expect(worker.calls).toHaveLength(1); expect(running.signal.aborted).toBe(false)
  const oldBitmap = { close: vi.fn() }
  running.resolve({ bitmap: oldBitmap, previewLane: 'regional-fallback' }); await settleRejected()
  expect(worker.calls).toHaveLength(2)
  expect(worker.calls[1].options.previewTileFallback).toBe(true)
  expect(worker.calls[1].options.view).toEqual({ x: latest.x * 2, y: latest.y * 2, zoom: latest.zoom * 2 })
  const output = surfaceParts(h.render({ ...options, view: latest }))
  const old = output.compositor.props.items.find((item: any) => item.tile.bitmap === oldBitmap).tile
  expect(old.viewportCache.identity.view).toEqual(running.options.view)
  expect({ x: old.x, y: old.y, zoom: old.zoom }).toEqual({ x: -first.x * 2, y: -first.y * 2, zoom: first.zoom * 2 })
  expect(output.compositor.props.view).toEqual(latest)
  expect(output.wrapper.props['data-detail-ready']).toBe('false')
  expect(oldBitmap.close).not.toHaveBeenCalled()
})

test.each(['page', 'epoch'] as const)('native regional fallback cannot publish after its %s owner changes', async change => {
  nativeNavigationHost()
  const h = harness(false), view = { x: -.125, y: .375, zoom: 32 }
  const options = { width: 855, height: 888, view, rasterProfile: 'figmaSubpixel' }
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 1, view } }
  h.render(options); await settleRejected()
  const running = worker.calls[0]
  const changed = change === 'page' ? { pageId: 'another-page' } : { presentationEpoch: 1 }
  h.render({ ...options, ...changed }); await settleRejected()
  expect(running.signal.aborted).toBe(true)
  const bitmap = { close: vi.fn() }
  running.resolve({ bitmap, previewLane: 'regional-fallback' }); await settleRejected()
  const output = surfaceParts(h.render({ ...options, ...changed }))
  expect(output.compositor.props.items.some((item: any) => item.tile.bitmap === bitmap)).toBe(false)
  expect(bitmap.close).toHaveBeenCalledOnce()
})

test('native navigation budget rejection cannot resubmit a lower-density preview', async () => {
  nativeNavigationHost()
  const h = harness(false), view = { x: -.125, y: .375, zoom: 32 }, onFallback = vi.fn()
  const options = { width: 855, height: 888, view, rasterProfile: 'figmaSubpixel', onFallback }
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 1, view } }
  h.render(options); await settleRejected()
  expect(worker.calls[0].options.width).toBe(1710)
  worker.calls[0].reject(compileBudget()); await settleRejected()
  const output = surfaceParts(h.render(options)); await settleRejected()
  expect(worker.calls).toHaveLength(1)
  expect(output.wrapper.props['data-detail-ready']).toBe('false'); expect(onFallback).not.toHaveBeenCalled()
  const next = { ...options, view: { ...view, x: -10 } }
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 2, view: next.view } }
  h.render(next); await settleRejected()
  expect(worker.calls).toHaveLength(2); expect(worker.calls[1].options.width).toBe(1710)
})

function sharpSurfaceHost() {
  vi.stubEnv('VITE_DESIGN_SHARP_ZOOM', '1')
  vi.stubGlobal('WebGL2RenderingContext', class {})
  vi.stubGlobal('navigator', { gpu: {} })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  Object.assign(worker.policy, { desktopFullMath: true, desktopDisplay: true })
  worker.dpr = 2; worker.dynamicPlan = true; worker.zooming = true; worker.cameraMoving = true
}

test('gesture headroom routes adjacent filtered zooms to the same canonical tile density and repairs exact phase at quiet', async () => {
  sharpSurfaceHost()
  vi.stubEnv('VITE_DESIGN_SHARP_ZOOM', '0')
  vi.stubEnv('VITE_DESIGN_GESTURE_DENSITY_HEADROOM', '1')
  worker.forceLod = true
  const h = harness(false), blur = makeNode('rectangle')
  blur.effects = [makeEffect('blur')]
  h.doc.nodes[blur.id] = blur; h.doc.pages[0].children.push(blur.id)
  const options = { width: 256, height: 128, rasterProfile: 'figmaSubpixel' }
  const views = [{ x: -.125, y: .375, zoom: .51 }, { x: -.125, y: .375, zoom: .55 }]
  // A cold document's separate one-time startup preview is outside this
  // navigation routing contract. Finish it before the first moving input.
  worker.zooming = false; worker.cameraMoving = false
  h.render({ ...options, view: { ...views[0], zoom: .5 } })
  await flushRasterWork(); await settleRejected()
  worker.zooming = true; worker.cameraMoving = true
  const densities: number[] = [], cameras: any[] = [], tileKeys: string[][] = []
  for (let i = 0; i < views.length; i++) {
    const view = views[i], before = worker.calls.length
    worker.navigation = { active: true, suspended: false, sample: { active: true, view, sequence: i + 1 } }
    const output = h.render({ ...options, view })
    await flushRasterWork(); await settleRejected()
    const calls = worker.calls.slice(before).filter(call => call.options.tileViewport?.length)
    expect(calls.length).toBeGreaterThan(0)
    expect(worker.calls.slice(before).every(call => call.options.renderIntent === 'canvas')).toBe(true)
    for (const call of calls) {
      expect(call.options.view).toEqual({ x: 0, y: 0,
        zoom: 2 ** ((Math.ceil(Math.log2(view.zoom * worker.dpr) * 4) + 1) / 4) })
      expect(call.options.tileViewport.every((tile: RasterTile) => tile.zoom >= view.zoom * worker.dpr)).toBe(true)
    }
    densities.push(calls[0].options.view.zoom); cameras.push(calls[0].options.view)
    tileKeys.push(calls.flatMap(call => call.options.tileViewport.map((tile: RasterTile) => tile.key)))
    const { wrapper } = surfaceParts(output)
    expect(wrapper.props['data-navigation-zoom-active']).toBe('false')
    expect(wrapper.props['data-motion-preview']).toBe('false')
    expect(wrapper.props['data-lod-scale']).toBe(0)
    expect(wrapper.props['data-raster-phase-exact']).toBe('false')
    expect(wrapper.props['data-detail-ready']).toBe('false')
  }
  expect(densities[1]).toBe(densities[0]); expect(cameras[1]).toEqual(cameras[0])
  expect(tileKeys[1].every(key => tileKeys[0].includes(key))).toBe(true)
  expect(worker.navigationEnabled.every(enabled => !enabled)).toBe(true)
  const beforeQuiet = worker.calls.length
  worker.zooming = false; worker.cameraMoving = false
  const quiet = h.render({ ...options, view: views[1] })
  await flushRasterWork(); await settleRejected()
  const repair = worker.calls.slice(beforeQuiet).find(call => call.options.tileViewport?.length)
  expect(repair).toBeDefined()
  expect(repair.options.view).toEqual({ x: -.25, y: .75, zoom: 1.1 })
  expect(repair.options.tileViewport.every((tile: RasterTile) => tile.zoom === 1.1 && tile.phaseX === .75 && tile.phaseY === .75)).toBe(true)
  expect(surfaceParts(quiet).wrapper.props['data-raster-phase-exact']).toBe('true')
  // Planning is exact now; controlled transport has not produced/presented pixels.
  expect(surfaceParts(quiet).wrapper.props['data-detail-ready']).toBe('false')
})

test('fixed world gesture capture shares adjacent inputs and still queues native repair after real sharp quiet', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
  try {
    vi.stubEnv('VITE_DESIGN_GESTURE_DENSITY_HEADROOM', '1')
    const { h, first, request } = await sequentialSurface(), before = worker.calls.length
    const expectedScale = 2 ** ((Math.ceil(Math.log2(first.view.zoom * worker.dpr) * 4) + 1) / 4)
    expect(request.options.view).toEqual({ x: 0, y: 0, zoom: expectedScale })
    expect(request.options.width).toBe(896); expect(request.options.height).toBe(512)
    const adjacent = { ...first, view: { x: 0, y: 0, zoom: 1.02 } }
    h.render(adjacent); await settleRejected()
    expect(worker.calls).toHaveLength(before); expect(request.signal.aborted).toBe(false)
    // The next ceil-rung boundary remains within the same capture's headroom.
    // Quiet must release that speculative density and return to native tiles.
    const boundary = { ...first, view: { x: 0, y: 0, zoom: 2 ** .25 } }
    h.render(boundary); await settleRejected()
    expect(worker.calls).toHaveLength(before)
    worker.cameraMoving = false
    await vi.advanceTimersByTimeAsync(101)
    h.render(boundary); await settleRejected()
    request.resolve({ gpuTile: 1702 }); await settleRejected()
    h.render(boundary); await settleRejected()
    const final = worker.calls.slice(before).find(call => call.options.tileViewport?.length)
    expect(final).toBeDefined()
    expect(final.options.renderIntent).toBe('canvas')
    expect(final.options.sequentialViewport).toBeUndefined()
    expect(final.options.view.zoom).toBe(boundary.view.zoom * worker.dpr)
    expect(final.options.tileViewport.every((tile: RasterTile) => tile.zoom === boundary.view.zoom * worker.dpr)).toBe(true)
  } finally { vi.useRealTimers() }
})

test.each(['pixel', 'grid', 'checkerboard', 'hdr'] as const)('gesture headroom leaves the mounted %s route identical to its flag-off control', async reason => {
  sharpSurfaceHost()
  vi.stubEnv('VITE_DESIGN_SHARP_ZOOM', '0')
  vi.stubEnv('VITE_DESIGN_GESTURE_DENSITY_HEADROOM', '1')
  if (reason === 'hdr') worker.policy.hdrCompositing = true
  const h = harness(false), view = { x: .125, y: -.375, zoom: 1.01 }
  worker.navigation = { active: true, suspended: false, sample: { active: true, view, sequence: 1 } }
  const options = { view, width: 256, height: 128, rasterProfile: 'figmaSubpixel',
    ...(reason === 'pixel' ? { pixelPreview: 1 } : reason === 'grid' ? { grid: true } :
      reason === 'checkerboard' ? { checkerboard: true } : {}) }
  h.render(options); await flushRasterWork(); await settleRejected()
  const first = worker.calls.slice(), before = worker.calls.length
  expect(first.some(call => call.options.tileViewport?.length)).toBe(true)
  vi.stubEnv('VITE_DESIGN_GESTURE_DENSITY_HEADROOM', '0')
  const reference = harness(false)
  reference.render(options); await flushRasterWork(); await settleRejected()
  const project = (calls: any[]) => calls.filter(call => call.options.tileViewport?.length).map(call => ({
    view: call.options.view, tiles: call.options.tileViewport, rasterProfile: call.options.rasterProfile,
    pixelPreview: call.options.pixelPreview, grid: call.options.grid, checkerboard: call.options.checkerboard,
    renderIntent: call.options.renderIntent, livePreview: call.options.livePreview,
  }))
  expect(project(worker.calls.slice(before))).toEqual(project(first))
})

test('eligible filtered desktop wheel inputs schedule screen-density tiles instead of the one-megapixel navigation preview', async () => {
  sharpSurfaceHost(); worker.forceLod = true
  const h = harness(false), blur = makeNode('rectangle')
  blur.effects = [makeEffect('blur')]
  h.doc.nodes[blur.id] = blur; h.doc.pages[0].children.push(blur.id)
  let sequence = 0
  for (const zoom of [.025, .51, 4.01, 8.1, 4.01]) {
    const view = { x: 0, y: 0, zoom }, before = worker.calls.length
    worker.navigation = { active: true, suspended: false, sample: { active: true, view, sequence: ++sequence } }
    const output = h.render({ view, width: 256, height: 128, rasterProfile: 'figmaSubpixel',
      overview: { x: 0, y: 0, width: 20000, height: 10000 } })
    await flushRasterWork()
    await vi.waitFor(() => expect(worker.calls.slice(before).some(call => call.options.tileViewport?.length)).toBe(true))
    const requests = worker.calls.slice(before)
    expect(requests.every(call => call.options.renderIntent === 'canvas' && Array.isArray(call.options.tileViewport))).toBe(true)
    for (const call of requests.filter(call => call.options.tileViewport.length)) {
      expect(call.options.view.zoom).toBeGreaterThanOrEqual(zoom * worker.dpr)
      expect(call.options.view.zoom / (zoom * worker.dpr)).toBeLessThanOrEqual(2 ** (1 / 8) + 1e-12)
      expect(call.options.tileViewport.every((tile: RasterTile) => tile.zoom === call.options.view.zoom)).toBe(true)
      expect(call.options.rasterProfile).toBe('figmaSubpixel')
    }
    const { wrapper } = surfaceParts(output)
    expect(wrapper.props['data-navigation-zoom-active']).toBe('false')
    expect(wrapper.props['data-motion-preview']).toBe('false')
    expect(wrapper.props['data-lod-scale']).toBe(0)
  }
  expect(worker.navigationEnabled.every(enabled => !enabled)).toBe(true)
  expect(worker.calls.some(call => call.options.livePreview || call.options.renderIntent === 'preview')).toBe(false)
  expect(worker.maintenance).toHaveLength(0)
})

test.each(['display', 'working', 'compile'] as const)('sharp headroom %s pressure retries only at the original DPR and does not loop after native failure', async kind => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
  try {
  sharpSurfaceHost()
  const h = harness(false), view = { x: 0, y: 0, zoom: 1.01 }, onRenderFailure = vi.fn()
  worker.navigation = { active: true, suspended: false, sample: { active: true, view, sequence: 1 } }
  const options = { view, width: 256, height: 128, rasterProfile: 'figmaSubpixel', onRenderFailure }
  // A fresh mount is intentionally quiet. Complete an initial native frame,
  // then change zoom through the real useSharpZoomActivity hook. Drain only
  // microtasks so the 100ms quiet timer cannot expire during admission checks.
  h.render({ ...options, view: { ...view, zoom: 1 } })
  await flushRasterWork(); await settleRejected()
  expect(worker.calls[0].options.tileViewport).toEqual([])
  expect(worker.calls.some(call => call.options.tileViewport?.length)).toBe(true)
  const baselineCalls = worker.calls.length
  worker.plannedScales.length = 0
  h.render(options); await settleRejected()
  expect(worker.calls).toHaveLength(baselineCalls + 1)
  const ahead = worker.calls[baselineCalls].options.view.zoom
  expect(ahead).toBeGreaterThan(view.zoom * worker.dpr)
  const pressure = () => kind === 'display' ? Error('GPU display resident budget exceeded') :
    kind === 'compile' ? compileBudget() : markRenderFailure(Error('GPU 表面内存预算超限'),
      { failureCategory: 3, failureStage: 13, failureCode: 200 })
  worker.calls[baselineCalls].reject(pressure()); await settleRejected()
  expect(onRenderFailure).not.toHaveBeenCalled()
  h.render(options); await settleRejected()
  expect(worker.calls).toHaveLength(baselineCalls + 2)
  const native = worker.calls[baselineCalls + 1]
  expect(native.options.renderIntent).toBe('canvas')
  expect(native.options.tileViewport.length).toBeGreaterThan(0)
  expect(native.options.view.zoom).toBe(view.zoom * worker.dpr)
  expect(native.options.tileViewport.every((tile: RasterTile) => tile.zoom === view.zoom * worker.dpr)).toBe(true)
  expect(worker.plannedScales).toEqual([ahead, view.zoom * worker.dpr])
  native.reject(pressure()); await settleRejected()
  expect(onRenderFailure).toHaveBeenCalledTimes(1)
  for (let i = 0; i < 16; i++) { h.render(options); await settleRejected() }
  expect(worker.calls).toHaveLength(baselineCalls + 2)
  expect(worker.plannedScales).toEqual([ahead, view.zoom * worker.dpr])
  expect(worker.calls.some(call => call.options.livePreview)).toBe(false)
  } finally { vi.useRealTimers() }
})

test.each(['flag-off', 'web-policy', 'nonresident', 'cpu-policy', 'software-profile'] as const)(
  'sharp zoom leaves the existing optional-navigation path unchanged for %s', async reason => {
    sharpSurfaceHost()
    if (reason === 'flag-off') vi.stubEnv('VITE_DESIGN_SHARP_ZOOM', '0')
    if (reason === 'web-policy') worker.policy.desktopDisplay = false
    if (reason === 'nonresident') vi.stubGlobal('navigator', {})
    if (reason === 'cpu-policy') worker.policy.cpuOnly = true
    const h = harness(false), view = { x: 0, y: 0, zoom: 1.01 }
    const rasterProfile = reason === 'software-profile' ? 'figmaSoftware' : 'figmaSubpixel'
    worker.navigation = { active: true, suspended: false, sample: { active: true, view, sequence: 1 } }
    h.render({ view, width: 256, height: 128, rasterProfile })
    await vi.waitFor(() => expect(worker.calls).toHaveLength(1))
    expect(worker.navigationEnabled.at(-1)).toBe(true)
    expect(worker.calls[0].options.renderIntent).toBe('preview')
    expect(worker.calls[0].options.livePreview).toBe(true)
    expect(worker.calls[0].options.tileViewport).toBeUndefined()
    expect(worker.calls[0].options.rasterProfile).toBe(rasterProfile)
    expect(worker.plannedScales).toEqual([])
  },
)

test.each(['pixel', 'grid', 'checkerboard', 'hdr'] as const)('sharp zoom leaves the existing %s route identical to a flag-off control', async reason => {
  sharpSurfaceHost()
  if (reason === 'hdr') worker.policy.hdrCompositing = true
  const h = harness(false), view = { x: .125, y: -.375, zoom: 1.01 }
  worker.navigation = { active: true, suspended: false, sample: { active: true, view, sequence: 1 } }
  const options = { view, width: 256, height: 128, rasterProfile: 'figmaSubpixel',
    ...(reason === 'pixel' ? { pixelPreview: 1 } : reason === 'grid' ? { grid: true } :
      reason === 'checkerboard' ? { checkerboard: true } : {}) }
  h.render(options)
  await flushRasterWork()
  await vi.waitFor(() => expect(worker.calls.some(call => call.options.tileViewport?.length)).toBe(true))
  expect(worker.navigationEnabled.at(-1)).toBe(false)
  expect(worker.calls.some(call => call.options.livePreview)).toBe(false)
  const admitted = worker.calls.filter(call => call.options.tileViewport?.length)
  for (const call of admitted) {
    if (reason !== 'hdr') expect(call.options.view.zoom).toBe(view.zoom * worker.dpr)
    expect(call.options.rasterProfile).toBe('figmaSubpixel')
  }
  // Existing HDR/nonmanaged motion may use its old half-octave ladder. This
  // feature must preserve that route, not silently impose a new HDR policy.
  const before = worker.calls.length, reference = harness(false)
  vi.stubEnv('VITE_DESIGN_SHARP_ZOOM', '0')
  reference.render(options); await flushRasterWork()
  await vi.waitFor(() => expect(worker.calls.slice(before).some(call => call.options.tileViewport?.length)).toBe(true))
  const project = (calls: any[]) => calls.filter(call => call.options.tileViewport?.length).map(call => ({
    view: call.options.view, tiles: call.options.tileViewport, rasterProfile: call.options.rasterProfile,
    pixelPreview: call.options.pixelPreview, grid: call.options.grid, checkerboard: call.options.checkerboard,
    renderIntent: call.options.renderIntent,
  }))
  expect(project(worker.calls.slice(before))).toEqual(project(admitted))
})

/** Parent hooks and ownership only. Deferred worker outputs are controlled;
 * these do not establish GPU memory, quality, clarity or timing acceptance. */
async function sequentialSurface() {
  sharpSurfaceHost(); vi.stubEnv('VITE_DESIGN_SEQUENTIAL_DISPLAY', '1')
  const h = harness(false), initial = { x: 0, y: 0, zoom: 1 }
  const options = { view: initial, width: 256, height: 128, rasterProfile: 'figmaSubpixel' }
  h.render(options); await flushRasterWork(); await settleRejected()
  const first = { ...options, view: { ...initial, zoom: 1.01 } }
  h.render(first); await settleRejected()
  const request = worker.calls.at(-1)
  expect(request.options.sequentialViewport).toBe(true)
  return { h, first, request }
}

test('sequential whole-viewport capture stays native and same-bucket input retains valid work with a live presentation plan', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
  try {
    const { h, first, request } = await sequentialSurface(), before = worker.calls.length
    expect(request.options.renderIntent).toBe('preview'); expect(request.options.livePreview).toBe(true)
    expect(request.options.tileViewport).toBeUndefined()
    expect(request.options.width).toBeGreaterThanOrEqual(first.width * worker.dpr)
    expect(request.options.height).toBeGreaterThanOrEqual(first.height * worker.dpr)
    const latest = { ...first, view: { x: 0, y: 0, zoom: 1.02 } }
    h.render(latest); await settleRejected()
    expect(worker.calls).toHaveLength(before); expect(request.signal.aborted).toBe(false)
    request.resolve({ gpuTile: 701 }); await settleRejected()
    const { compositor } = surfaceParts(h.render(latest))
    const tile = compositor.props.items.find((item: any) => item.tile.gpuTile === 701).tile
    compositor.props.onReady(tile.key, tile.serial, false)
    const ready = surfaceParts(h.render(latest)).compositor
    expect(ready.props.view).toEqual(latest.view)
    expect(ready.props.items.some((item: any) => item.tile.gpuTile === 701 && item.active)).toBe(true)
    await settleRejected()
    expect(worker.calls.length).toBeGreaterThan(before) // Completion wakes the latest camera once.
    worker.calls.at(-1).resolve({ gpuTile: 705 }); await settleRejected()
    const successor = surfaceParts(h.render(latest)).compositor
    const latestTile = successor.props.items.find((item: any) => item.tile.gpuTile === 705).tile
    successor.props.onReady(latestTile.key, latestTile.serial, false)
    const settled = surfaceParts(h.render(latest)).compositor
    expect(settled.props.settledDocument).toBe(h.doc)
    settled.props.onPresented({ view: latest.view, width: first.width, height: first.height, dpr: worker.dpr,
      interaction: false, ids: [705] })
    expect(surfaceParts(h.render(latest)).wrapper.props['data-frame-publication']).toBe('complete')
  } finally { vi.useRealTimers() }
})

test('quiet final input schedules exact native repair while a previous sequential capture is still in flight', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
  try {
    const { h, first, request } = await sequentialSurface(), before = worker.calls.length
    // Exact bucket boundary: quiet changes neither density nor raster phase.
    // The explicit zooming dependency must still start the final native plan.
    const latest = { ...first, view: { x: 0, y: 0, zoom: 2 ** (1 / 8) } }
    h.render(latest); await settleRejected()
    expect(worker.calls).toHaveLength(before)
    await vi.advanceTimersByTimeAsync(101)
    h.render(latest); await settleRejected()
    // The mailbox remains serialized until old work settles, but the quiet
    // effect has queued the final native plan without needing another input.
    request.resolve({ gpuTile: 702 }); await settleRejected()
    h.render(latest); await settleRejected()
    const final = worker.calls.slice(before).find(call => call.options.tileViewport?.length)
    expect(final).toBeDefined()
    expect(final.options.view.zoom).toBe(latest.view.zoom * worker.dpr)
    expect(final.options.sequentialViewport).toBeUndefined()
    expect(final.options.tileViewport.every((tile: RasterTile) => tile.zoom === latest.view.zoom * worker.dpr)).toBe(true)
  } finally { vi.useRealTimers() }
})

test('crossing several density buckets keeps one running capture and replaces only the latest queued goal', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
  try {
    const { h, first, request } = await sequentialSurface(), before = worker.calls.length
    let latest = first
    for (const zoom of [1.02, 1.2, 2.1, 1.3, 1.6]) {
      latest = { ...first, view: { x: 0, y: 0, zoom } }
      h.render(latest); await settleRejected()
      expect(request.signal.aborted).toBe(false)
      expect(worker.calls).toHaveLength(before)
    }
    request.resolve({ gpuTile: 706 }); await settleRejected()
    let compositor = surfaceParts(h.render(latest)).compositor
    const oldTile = compositor.props.items.find((item: any) => item.tile.gpuTile === 706).tile
    compositor.props.onReady(oldTile.key, oldTile.serial, false)
    ;({ compositor } = surfaceParts(h.render(latest)))
    // Same-content old pixels remain available as coverage, but their actual
    // density is below this camera and cannot certify a clear completed frame.
    expect(compositor.props.items.some((item: any) => item.tile.gpuTile === 706 && item.active)).toBe(true)
    expect(compositor.props.settledDocument).toBeUndefined()
    expect(surfaceParts(h.render(latest)).wrapper.props['data-detail-ready']).toBe('false')
    await settleRejected()
    expect(worker.calls).toHaveLength(before + 1)
    const successor = worker.calls.at(-1)
    expect(successor.options.sequentialViewport).toBe(true)
    expect(successor.options.view.zoom).toBeGreaterThanOrEqual(latest.view.zoom * worker.dpr)
    expect(successor.options.view.zoom).toBeLessThanOrEqual(latest.view.zoom * worker.dpr * 2 ** (1 / 8) + 1e-12)
    expect(worker.clients[0].releasePresented).not.toHaveBeenCalledWith([706])
  } finally { vi.useRealTimers() }
})

test('a density-crossing capture may finish after quiet and retain pixels while the final native plan starts', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
  try {
    const { h, first, request } = await sequentialSurface(), before = worker.calls.length
    const latest = { ...first, view: { x: 0, y: 0, zoom: 1.2 } }
    h.render(latest); await settleRejected()
    expect(request.signal.aborted).toBe(false); expect(worker.calls).toHaveLength(before)
    await vi.advanceTimersByTimeAsync(101)
    h.render(latest); await settleRejected()
    expect(request.signal.aborted).toBe(false)
    request.resolve({ gpuTile: 707 }); await settleRejected()
    const compositor = surfaceParts(h.render(latest)).compositor
    expect(compositor.props.items.some((item: any) => item.tile.gpuTile === 707)).toBe(true)
    expect(compositor.props.settledDocument).toBeUndefined()
    await settleRejected()
    const final = worker.calls.slice(before).find(call => call.options.tileViewport?.length)
    expect(final).toBeDefined(); expect(final.options.sequentialViewport).toBeUndefined()
    expect(final.options.view.zoom).toBe(latest.view.zoom * worker.dpr)
    expect(worker.calls.slice(before).every(call => !call.options.sequentialViewport)).toBe(true)
    expect(worker.clients[0].releasePresented).not.toHaveBeenCalledWith([707])
  } finally { vi.useRealTimers() }
})

test('an exact rejected sequential capture stays on native tiles while a new same-density camera may retry', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
  try {
    const { h, first, request } = await sequentialSurface()
    const onRenderFailure = vi.fn(), before = worker.calls.length
    request.reject(Error('SEQUENTIAL_DISPLAY_UNSUPPORTED')); await settleRejected()
    expect(worker.calls.slice(before).some(call => call.options.tileViewport?.length)).toBe(true)
    await flushRasterWork(); await settleRejected()
    worker.cameraMoving = false // Rerun the same capture without changing its camera or density.
    h.render({ ...first, onRenderFailure }); await settleRejected()
    expect(worker.calls.filter(call => call.options.sequentialViewport)).toHaveLength(1)
    expect(onRenderFailure).not.toHaveBeenCalled()
    await flushRasterWork(); await settleRejected()
    h.render({ ...first, onRenderFailure, view: { ...first.view, x: -1 } }); await settleRejected()
    expect(worker.calls.filter(call => call.options.sequentialViewport)).toHaveLength(2)
    const moved = worker.calls.at(-1)
    expect(moved.options.sequentialViewport).toBe(true)
    expect(moved.options.view.zoom).toBe(request.options.view.zoom)
    expect(moved.options.view.x).not.toBe(request.options.view.x)
    moved.reject(Error('SEQUENTIAL_DISPLAY_UNSUPPORTED')); await settleRejected()
    await flushRasterWork(); await settleRejected()
    h.render({ ...first, onRenderFailure }); await settleRejected()
    expect(worker.calls.filter(call => call.options.sequentialViewport)).toHaveLength(2)
    expect(onRenderFailure).not.toHaveBeenCalled()
  } finally { vi.useRealTimers() }
})

test('sequential capability rejection history is bounded to the latest 64 exact captures', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
  try {
    const { h, first, request } = await sequentialSurface()
    let current = request
    for (let i = 0; i < 65; i++) {
      current.reject(Error('SEQUENTIAL_DISPLAY_UNSUPPORTED')); await settleRejected()
      await flushRasterWork(); await settleRejected()
      if (i < 64) {
        h.render({ ...first, view: { ...first.view, x: -i - 1 } }); await settleRejected()
        current = worker.calls.at(-1)
        expect(current.options.sequentialViewport).toBe(true)
      }
    }
    expect(worker.calls.filter(call => call.options.sequentialViewport)).toHaveLength(65)
    h.render(first); await settleRejected()
    expect(worker.calls.filter(call => call.options.sequentialViewport)).toHaveLength(66)
    expect(worker.calls.at(-1).options.view).toEqual(request.options.view)
  } finally { vi.useRealTimers() }
})

test('a real sequential device failure stays in the existing failure path', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
  try {
    const { h, first, request } = await sequentialSurface(), onRenderFailure = vi.fn()
    h.render({ ...first, onRenderFailure })
    const before = worker.calls.length
    request.reject(Error('GPU device lost: SEQUENTIAL_DISPLAY_UNSUPPORTED')); await settleRejected()
    expect(onRenderFailure).toHaveBeenCalledTimes(1)
    expect(worker.calls).toHaveLength(before)
  } finally { vi.useRealTimers() }
})

test('same-camera coalescing cannot strand native fallback after sequential capability rejection', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
  try {
    const { h, first, request } = await sequentialSurface(), before = worker.calls.length
    worker.cameraMoving = false // Effect changes while the sharp quiet interval is still active.
    h.render(first); await settleRejected()
    expect(worker.calls).toHaveLength(before)
    request.reject(Error('SEQUENTIAL_DISPLAY_UNSUPPORTED')); await settleRejected()
    h.render(first); await settleRejected()
    expect(worker.calls.filter(call => call.options.sequentialViewport)).toHaveLength(1)
    expect(worker.calls.slice(before).some(call => call.options.tileViewport?.length)).toBe(true)
  } finally { vi.useRealTimers() }
})

test('a moving-camera capability rejection gives a real native batch a turn before another optional capture', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
  try {
    const { h, first, request } = await sequentialSurface(), before = worker.calls.length
    const latest = { ...first, view: { x: -2, y: 0, zoom: 1.2 } }
    h.render(latest); await settleRejected()
    request.reject(Error('SEQUENTIAL_DISPLAY_UNSUPPORTED')); await settleRejected()
    h.render(latest); await settleRejected()
    // Synchronization, if still needed, is not itself the owed raster batch.
    for (const call of worker.calls.slice(before).filter(call => call.options.tileViewport?.length === 0)) call.resolve()
    await settleRejected()
    const repair = worker.calls.slice(before).find(call => call.options.tileViewport?.length)
    expect(repair).toBeDefined(); expect(repair.options.sequentialViewport).toBeUndefined()
    expect(repair.options.renderIntent).toBe('canvas')
    const cancellations = worker.clients[0].cancelTileFill.mock.calls.length
    for (const zoom of [1.3, 1.6, 2.1]) {
      h.render({ ...latest, view: { ...latest.view, zoom } }); await settleRejected()
      expect(worker.calls.filter(call => call.options.sequentialViewport)).toHaveLength(1)
      expect(worker.clients[0].cancelTileFill).toHaveBeenCalledTimes(cancellations)
    }
    repair.resolve(); await settleRejected()
    h.render({ ...latest, view: { ...latest.view, zoom: 2.1 } }); await settleRejected()
    expect(worker.calls.length).toBeGreaterThan(before)
  } finally { vi.useRealTimers() }
})

test('a pending whole capture replaces obsolete native-plan protection even before it owns visible pixels', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
  try {
    const { h, first } = await sequentialSurface()
    const protection = h.residentSets().find(set => [...set].some(key => key.startsWith('sequential-viewport:')))
    expect(protection).toBeDefined(); expect(protection!.size).toBe(1)
    expect(h.keys.some(key => protection!.has(key))).toBe(false)
    h.render({ ...first, view: { ...first.view, x: -1000, zoom: 2 } }); await settleRejected()
    // The one immutable pending result stays protected as useful history;
    // the previous native plan's keys do not accumulate alongside it.
    const pending = h.residentSets().find(set => [...set].some(key => key.startsWith('sequential-viewport:')))
    expect(pending).toEqual(protection)
    expect(surfaceParts(h.render({ ...first, view: { ...first.view, x: -1000, zoom: 2 } })).wrapper.props['data-detail-ready']).toBe('false')
  } finally { vi.useRealTimers() }
})

test('the original whole-viewport candidate does not submit while the surface is hidden', async () => {
  sharpSurfaceHost(); vi.stubEnv('VITE_DESIGN_ORIGINAL_VIEWPORT_CAPTURE', '1'); vi.stubEnv('VITE_DESIGN_SEQUENTIAL_DISPLAY', '0')
  const h = harness(false), options = { view: { x: 0, y: 0, zoom: 1.01 }, width: 256, height: 128,
    rasterProfile: 'figmaSubpixel', visible: false }
  h.render(options); await settleRejected()
  expect(worker.calls).toHaveLength(0)
  h.render({ ...options, visible: true }); await settleRejected()
  expect(worker.calls.length).toBeGreaterThan(0)
})

test.each(['width', 'height', 'dpr', 'pause', 'visibility', 'suspend'] as const)(
  'sequential %s cancellation cannot leave a dead pending owner blocking a replacement', async change => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
    try {
      const { h, first, request } = await sequentialSurface(), before = worker.calls.length
      const override = change === 'width' ? { width: first.width + 64 } : change === 'height' ? { height: first.height + 32 } :
        change === 'pause' ? { paused: true } : change === 'visibility' ? { visible: false } : {}
      if (change === 'dpr') worker.dpr = 3
      if (change === 'suspend') worker.navigation.suspended = true
      h.render({ ...first, ...override }); await settleRejected()
      expect(request.signal.aborted).toBe(true)
      request.resolve({ gpuTile: 703 }); await settleRejected()
      if (change === 'pause' || change === 'visibility' || change === 'suspend') {
        expect(worker.calls).toHaveLength(before)
        worker.navigation.suspended = false
        h.render({ ...first, visible: true, paused: false }); await settleRejected()
      }
      const replacement = worker.calls.slice(before).find(call => call.options.sequentialViewport)
      expect(replacement).toBeDefined(); expect(replacement.signal.aborted).toBe(false)
      expect(worker.clients[0].releasePresented).toHaveBeenCalledWith([703])
      expect(replacement.options.width).toBeGreaterThanOrEqual((override.width || first.width) * worker.dpr)
      expect(replacement.options.height).toBeGreaterThanOrEqual((override.height || first.height) * worker.dpr)
    } finally { vi.useRealTimers() }
  },
)

test('a sequential capture from an older authored document can never become current display coverage', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
  try {
    const { h, first, request } = await sequentialSurface()
    const changed = { ...h.doc, nodes: { ...h.doc.nodes }, name: 'edited while capture pending' }
    const options = { ...first, document: changed }
    h.render(options); await settleRejected()
    expect(request.signal.aborted).toBe(true)
    request.resolve({ gpuTile: 708 }); await settleRejected()
    const compositor = surfaceParts(h.render(options)).compositor
    expect(worker.clients[0].releasePresented).toHaveBeenCalledWith([708])
    expect(compositor.props.items.some((item: any) => item.tile.gpuTile === 708)).toBe(false)
    expect(compositor.props.settledDocument).toBeUndefined()
  } finally { vi.useRealTimers() }
})

test('unmount cancels a pending sequential capture and never publishes its late payload', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
  try {
    const { h, request } = await sequentialSurface(), before = worker.calls.length
    h.dispose(); expect(request.signal.aborted).toBe(true)
    request.resolve({ gpuTile: 704 }); await settleRejected()
    expect(worker.calls).toHaveLength(before)
    expect(worker.clients[0].releasePresented).toHaveBeenCalledWith([704])
  } finally { vi.useRealTimers() }
})

// Cold zoom-out acceptance here is orchestration/geometry only. No child GPU
// compositor, texture pixels or physical display completion is simulated.
async function highZoomCoverageFixture() {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {})
  worker.dynamicPlan = true
  const seeds = planTiles({ x: 0, y: 0, width: 1024 / 32, height: 512 / 32 }, 32)
  const h = harness(seeds), options = { backend: 'webgl2', view: { x: 0, y: 0, zoom: 32 } }
  h.render(options); await flushRasterWork()
  expect(surfaceParts(h.render(options)).wrapper.props['data-frame-publication']).toBe('complete')
  return { h, options }
}

test.each([1, 2, 3, 4, 5])('cold 32x dwell → %ix admits bounded coverage despite intersecting old pixels, then native repair', async zoom => {
  const { h, options } = await highZoomCoverageFixture()
  const next = { ...options, view: { x: 0, y: 0, zoom } }, before = worker.calls.length
  let parts = surfaceParts(h.render(next))
  await vi.waitFor(() => expect(worker.calls).toHaveLength(before + 1))
  const capture = worker.calls[before]
  expect(capture.options.livePreview).toBe(true)
  expect(capture.options.renderIntent).toBe('preview')
  expect(capture.options.width * capture.options.height).toBeLessThanOrEqual(1_050_000)
  const old = parts.compositor.props.items.filter((item: any) => item.active)
  expect(old.length).toBeGreaterThan(0)
  const rows = compositeDrawPlan(old, next.view, 1024, 512)
  expect(rows.reduce((sum, row) => sum + (row.clip.right - row.clip.left) * (row.clip.bottom - row.clip.top), 0)).toBeLessThan(1024 * 512)
  expect(parts.wrapper.props['data-detail-ready']).toBe('false')
  capture.resolve(); await settleRejected()
  await vi.waitFor(() => expect(worker.calls.length).toBeGreaterThan(before + 1))
  expect(worker.calls[before + 1].options.renderIntent).toBe('canvas')
  parts = surfaceParts(h.render(next))
  const tile = parts.compositor.props.items.find((item: any) => item.tile.key.startsWith('coverage-preview:')).tile
  // Arrival alone neither removes the old crop nor certifies full display.
  expect(parts.compositor.props.items.find((item: any) => item.tile === tile).active).toBe(false)
  parts.compositor.props.onReady(tile.key, tile.serial, false)
  parts = surfaceParts(h.render(next))
  const covered = compositeDrawPlan(parts.compositor.props.items, next.view, 1024, 512)
  expect(covered.reduce((sum, row) => sum + (row.clip.right - row.clip.left) * (row.clip.bottom - row.clip.top), 0)).toBe(1024 * 512)
  expect(parts.wrapper.props['data-detail-ready']).toBe('false')
})

test('running zoom-out coverage survives quiet and is not duplicated while importing before native repair', async () => {
  const { h, options } = await highZoomCoverageFixture(), before = worker.calls.length
  const next = { ...options, view: { x: 0, y: 0, zoom: 2 } }
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 1, view: next.view } }
  h.render(next); await vi.waitFor(() => expect(worker.calls).toHaveLength(before + 1))
  const running = worker.calls[before], cancellations = worker.clients[0].cancelPreview.mock.calls.length
  worker.navigation = { active: false, suspended: false, sample: undefined }
  h.render(next); await settleRejected()
  expect(running.signal.aborted).toBe(false)
  expect(worker.clients[0].cancelPreview).toHaveBeenCalledTimes(cancellations)
  running.resolve(); await settleRejected()
  await vi.waitFor(() => expect(worker.calls.length).toBeGreaterThan(before + 1))
  expect(worker.calls[before + 1].options.renderIntent).toBe('canvas')
  expect(worker.calls.slice(before).filter(call => call.options.livePreview)).toHaveLength(1)
  expect(surfaceParts(h.render(next)).compositor.props.items.some((item: any) => item.tile.viewportPreview)).toBe(true)
})

test('rapid zoom-out reversal supersedes waiting coverage without cancelling useful running pixels', async () => {
  const { h, options } = await highZoomCoverageFixture(), before = worker.calls.length
  for (const [sequence, zoom] of [[1, 1], [2, 5], [3, 2]]) {
    const next = { ...options, view: { x: 0, y: 0, zoom } }
    worker.navigation = { active: true, suspended: false, sample: { active: true, sequence, view: next.view } }
    h.render(next); await settleRejected()
  }
  expect(worker.calls).toHaveLength(before + 1)
  expect(worker.calls[before].signal.aborted).toBe(false)
  worker.calls[before].resolve(); await settleRejected()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(before + 2))
  expect(worker.calls[before + 1].options.view.zoom).toBe(2)
})

test.each(['document', 'page', 'session', 'paused'] as const)('late running zoom-out coverage cannot cross %s invalidation', async kind => {
  const { h, options } = await highZoomCoverageFixture(), before = worker.calls.length
  const next = { ...options, view: { x: 0, y: 0, zoom: 2 } }
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 1, view: next.view } }
  h.render(next); await vi.waitFor(() => expect(worker.calls).toHaveLength(before + 1))
  const running = worker.calls[before], close = vi.fn()
  const changed = { ...next, ...(kind === 'document' ? { document: { ...h.doc, nodes: { ...h.doc.nodes } } } :
    kind === 'page' ? { pageId: 'different-page' } : kind === 'session' ? { presentationEpoch: 1 } : { paused: true }) }
  h.render(changed)
  expect(running.signal.aborted).toBe(true)
  running.resolve({ bitmap: { close }, gpuTile: 8821 }); await settleRejected()
  expect(close).toHaveBeenCalledOnce()
  expect(worker.clients[0].releasePresented).toHaveBeenCalledWith([8821])
  expect(surfaceParts(h.render(changed)).compositor.props.items.some((item: any) => item.tile.gpuTile === 8821)).toBe(false)
})


test('a large pan during an active shrink sample draws the live camera, not the stale sample', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const h = harness(false)
  const shrunk = { x: 0, y: 0, zoom: 1 }
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 1, view: shrunk } }
  h.render({ backend: 'webgl2', view: shrunk })
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1))
  const running = worker.calls[0]
  expect(running.options.livePreview).toBe(true)
  expect(running.options.view).toMatchObject({ x: 0, y: 0, zoom: 1 })
  // The 160 ms sample is still the pre-pan camera. A short move must not restart it.
  h.render({ backend: 'webgl2', view: { x: -40, y: 0, zoom: 1 } })
  await settleRejected()
  expect(running.signal.aborted).toBe(false)
  expect(worker.calls).toHaveLength(1)
  const panned = { x: -800, y: 40, zoom: 1 }
  h.render({ backend: 'webgl2', view: panned })
  await settleRejected()
  expect(running.signal.aborted).toBe(true)
  const close = vi.fn()
  running.resolve({ bitmap: { close }, gpuTile: 61 })
  await settleRejected()
  expect(close).toHaveBeenCalledOnce()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(2))
  const live = worker.calls[1]
  expect(live.signal.aborted).toBe(false)
  expect(live.options.view).toMatchObject({ x: panned.x, y: panned.y, zoom: panned.zoom })
  live.resolve({ gpuTile: 62 })
  await flushRasterWork()
  const tile = surfaceParts(h.render({ backend: 'webgl2', view: panned })).compositor.props.items
    .map((item: any) => item.tile).find((item: any) => item.gpuTile === 62)
  expect(tile).toMatchObject({ x: -panned.x, y: -panned.y, zoom: 1 })
  expect(tile.previewSource.view).toEqual(panned)
  expect(surfaceParts(h.render({ backend: 'webgl2', view: panned })).compositor.props.items
    .some((item: any) => item.tile.gpuTile === 61)).toBe(false)
})

test('a long pan while the zoom sample still lags draws the live camera', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const h = harness(false)
  const sampled = { x: 0, y: 0, zoom: 2 }
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 1, view: sampled } }
  h.render({ backend: 'webgl2', view: sampled })
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1))
  const running = worker.calls[0]
  expect(running.options.livePreview).toBe(true)
  expect(running.options.view.zoom).toBe(2)
  // The sample has not published the zoom-out. The old picture is still inside it.
  const zoomed = { x: 256, y: 128, zoom: 1 }
  h.render({ backend: 'webgl2', view: zoomed })
  await settleRejected()
  expect(running.signal.aborted).toBe(false)
  expect(worker.calls).toHaveLength(1)
  const panned = { x: -800, y: 40, zoom: 1 }
  h.render({ backend: 'webgl2', view: panned })
  await settleRejected()
  expect(running.signal.aborted).toBe(true)
  const close = vi.fn()
  running.resolve({ bitmap: { close }, gpuTile: 61 })
  await settleRejected()
  expect(close).toHaveBeenCalledOnce()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(2))
  expect(worker.calls[1].signal.aborted).toBe(false)
  expect(worker.calls[1].options.view).toMatchObject(panned)
  worker.calls[1].resolve({ gpuTile: 62 })
  await flushRasterWork()
  const tile = surfaceParts(h.render({ backend: 'webgl2', view: panned })).compositor.props.items
    .map((item: any) => item.tile).find((item: any) => item.gpuTile === 62)
  expect(tile.previewSource.view).toEqual(panned)
})

test('a large pan after zoom-out yields the capture that misses the new viewport', async () => {
  const { h, options } = await highZoomCoverageFixture(), before = worker.calls.length
  const zoomed = { ...options, view: { x: 0, y: 0, zoom: 2 } }
  h.render(zoomed)
  await vi.waitFor(() => expect(worker.calls).toHaveLength(before + 1))
  const running = worker.calls[before]
  const held = surfaceParts(h.render(zoomed)).compositor.props.items.filter((item: any) => item.active)
  expect(held.length).toBeGreaterThan(0)
  const panned = { ...zoomed, view: { x: -700, y: 0, zoom: 2 } }
  h.render(panned)
  await settleRejected()
  expect(running.signal?.aborted).toBe(true)
  expect(surfaceParts(h.render(panned)).compositor.props.items.length).toBeGreaterThan(0)
  running.resolve()
  await vi.waitFor(() => expect(worker.calls.length).toBeGreaterThan(before + 1))
  const next = worker.calls.slice(before + 1).find((call: any) => call.options.livePreview && call.options.view?.x === -700)
  expect(next).toBeTruthy()
})

test('zoom-out continuity targets the latest requested viewport, not only its sampled camera', async () => {
  const { h, options } = await highZoomCoverageFixture(), before = worker.calls.length
  const next = { ...options, view: { x: 0, y: 0, zoom: 2 }, requestedView: { x: -25.25, y: 10.125, zoom: 1 } }
  h.render(next); await vi.waitFor(() => expect(worker.calls).toHaveLength(before + 1))
  expect(worker.calls[before].options.view).toEqual(next.requestedView)
  expect(surfaceParts(h.render(next)).wrapper.props['data-detail-ready']).toBe('false')
})

test('zoom-out coverage budget rejection immediately resumes native repair without a blur retry ladder', async () => {
  const { h, options } = await highZoomCoverageFixture(), before = worker.calls.length
  const next = { ...options, view: { x: 0, y: 0, zoom: 1 } }
  h.render(next); await vi.waitFor(() => expect(worker.calls).toHaveLength(before + 1))
  worker.calls[before].reject(Error('GPU surface budget exceeded')); await settleRejected()
  await vi.waitFor(() => expect(worker.calls.length).toBeGreaterThan(before + 1))
  expect(worker.calls[before + 1].options.renderIntent).toBe('canvas')
  expect(worker.calls.slice(before).filter(call => call.options.livePreview)).toHaveLength(1)
  expect(surfaceParts(h.render(next)).compositor.props.items.some((item: any) => item.active && item.tile.zoom === 32)).toBe(true)
})


test('device replacement discards a late settled coverage result and wakes current-view repair', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {}); vi.stubGlobal('navigator', { gpu: {} })
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {})
  worker.dynamicPlan = true
  const seeds = planTiles({ x: 0, y: 0, width: 1024 / 32, height: 512 / 32 }, 32).map((tile, index) => ({ ...tile, gpuTile: 8900 + index }))
  const h = harness(seeds), initial = { backend: 'webgpu', view: { x: 0, y: 0, zoom: 32 } }
  h.render(initial); await flushRasterWork()
  let parts = surfaceParts(h.render(initial))
  const owner = { client: worker.clients[0], deviceWorkerScope: 11, deviceIncarnation: 1, deviceOwner: 1 }
  parts.compositor.props.onPresented({ view: initial.view, width: 1024, height: 512, dpr: 1,
    interaction: false, ids: seeds.map(tile => tile.gpuTile) }, undefined, owner)
  h.render(initial)
  const next = { ...initial, view: { x: 0, y: 0, zoom: 1 } }, before = worker.calls.length
  h.render(next); await vi.waitFor(() => expect(worker.calls).toHaveLength(before + 1))
  expect(worker.calls[before].options.livePreview).toBe(true)
  parts = surfaceParts(h.render(next))
  parts.compositor.props.onPresented({ view: next.view, width: 1024, height: 512, dpr: 1,
    interaction: false, ids: [] }, undefined, { ...owner, deviceIncarnation: 2, deviceOwner: 2 })
  h.render(next)
  const close = vi.fn()
  worker.calls[before].resolve({ bitmap: { close }, gpuTile: 8999 }); await settleRejected()
  expect(close).toHaveBeenCalledOnce()
  expect(worker.clients[0].releasePresented).toHaveBeenCalledWith([8999])
  expect(surfaceParts(h.render(next)).compositor.props.items.some((item: any) => item.tile.gpuTile === 8999)).toBe(false)
  await vi.waitFor(() => expect(worker.calls.length).toBeGreaterThan(before + 1))
  expect(worker.calls[before + 1].options.view.zoom).toBe(1)
})

async function editedViewportPreviewFixture(background = '#ff0000') {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  vi.stubGlobal('navigator', { gpu: {} })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const old = { key: 'old-exact-32x', x: 0, y: 0, width: 1024, height: 512, zoom: 32, gutter: 0, gpuTile: 110 }
  worker.plan = [old]
  const h = harness([old]), previous = { backend: 'webgpu', view: { x: 0, y: 0, zoom: 32 } }
  h.render(previous)
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1))
  worker.calls[0].resolve(); await settleRejected()
  const oldFrame = surfaceParts(h.render(previous)).compositor
  oldFrame.props.onPresented({ view: previous.view, width: 1024, height: 512, dpr: 1, interaction: false, ids: [110] }, undefined,
    { client: worker.clients[0], deviceWorkerScope: 11, deviceIncarnation: 1, deviceOwner: 1 })
  expect(surfaceParts(h.render(previous)).wrapper.props['data-frame-publication']).toBe('complete')
  const translucent = makeNode('rectangle'); translucent.opacity = .5
  const document = { ...h.doc, nodes: { ...h.doc.nodes, [translucent.id]: translucent },
    pages: h.doc.pages.map(page => ({ ...page, background, children: [...page.children, translucent.id] })) }
  const next = { ...previous, document, view: { x: 0, y: 0, zoom: .04 } }
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 1, view: next.view } }
  h.render(next)
  await vi.waitFor(() => expect(worker.calls).toHaveLength(2))
  expect(worker.calls[1].options.transparent).toBe(false)
  expect(worker.calls[1].options.renderIntent).toBe('preview')
  worker.calls[1].resolve({ backend: 'webgpu', gpuTile: 111 }); await settleRejected()
  let parts = surfaceParts(h.render(next))
  const preview = parts.compositor.props.items.find((item: any) => item.tile.viewportPreview).tile
  parts.compositor.props.onReady(preview.key, preview.serial, false)
  parts = surfaceParts(h.render(next))
  return { h, next, preview, parts, document, old }
}

test('a complete current-revision viewport preview replaces obsolete32x pixels before exact tile completion', async () => {
  const { next, preview, parts, document } = await editedViewportPreviewFixture()
  expect(parts.wrapper.props['data-detail-ready']).toBe('false')
  const draws = compositeDrawPlan(parts.compositor.props.items, next.view, 1024, 512)
  expect(draws.some(row => row.item.tile === preview)).toBe(true)
  expect(draws.every(row => (row.item.tile as any).document === document)).toBe(true)
  // Full viewport composition contains translucent nodes and page background.
  // The old revision must contribute no fragment or double alpha.
  expect(draws.reduce((area, row) => area + (row.clip.right - row.clip.left) * (row.clip.bottom - row.clip.top), 0)).toBe(1024 * 512)
  expect(parts.compositor.props.presentation.document).toBe(document)
  expect(parts.compositor.props.presentation.preview).toBe(true)
})


const acknowledgeRevisionPreview = (fixture: Awaited<ReturnType<typeof editedViewportPreviewFixture>>, change: any = {}) => {
  const { next, parts, preview } = fixture
  parts.compositor.props.onPresented({ view: next.view, width: 1024, height: 512, dpr: 1,
    interaction: false, ids: [preview.gpuTile], ...change.frame },
    change.source ?? parts.compositor.props.presentation,
    { client: worker.clients[0], deviceWorkerScope: 11, deviceIncarnation: 1, deviceOwner: 1, ...change.device })
}

test('current-revision preview activates only after the actual matching ACK and never certifies exact quality', async () => {
  const f = await editedViewportPreviewFixture()
  expect(f.parts.wrapper.props['data-revision']).toBe(1)
  expect(worker.clients[0].releasePresented.mock.calls.flat(2)).not.toContain(f.old.gpuTile)
  acknowledgeRevisionPreview(f)
  const accepted = surfaceParts(f.h.render(f.next))
  expect(accepted.wrapper.props['data-revision']).toBe(2)
  expect(accepted.wrapper.props['data-frame-publication']).toBe('preview')
  expect(accepted.wrapper.props['data-detail-ready']).toBe('false')
  expect(accepted.wrapper.props['data-native-pixel-ready']).toBe('false')
  expect(accepted.compositor.props.presentation.document).toBe(f.document)
  expect(accepted.compositor.props.presentation.preview).toBe(true)
  // A later camera can reproject this already-ACKed current revision, but it
  // cannot upgrade its sampling quality or go back to obsolete32x content.
  const moving = { ...f.next, view: { x: 4, y: 2, zoom: .05 } }
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 2, view: moving.view } }
  const later = surfaceParts(f.h.render(moving))
  expect(later.compositor.props.items.filter((item: any) => item.active).every((item: any) => item.tile.document === f.document)).toBe(true)
  expect(later.wrapper.props['data-native-pixel-ready']).toBe('false')
})

test.each(['partial', 'camera', 'revision', 'document', 'contract', 'client', 'generation', 'device', 'precision', 'profile', 'unready', 'backend'] as const)(
  'new-revision atomic preview rejects %s admission mismatch', async mismatch => {
    const f = await editedViewportPreviewFixture(), p = f.preview
    if (mismatch === 'partial') p.width /= 2
    if (mismatch === 'camera') p.previewSource = { ...p.previewSource, view: { ...p.previewSource.view, x: 1 } }
    if (mismatch === 'revision') p.revision++
    if (mismatch === 'document') p.document = f.h.doc
    if (mismatch === 'contract') p.previewSource = { ...p.previewSource, contract: {} }
    if (mismatch === 'client') p.previewSource = { ...p.previewSource, client: {} }
    if (mismatch === 'generation') p.previewSource = { ...p.previewSource, generation: 999 }
    if (mismatch === 'device') p.previewSource = { ...p.previewSource, device: '11/1/99' }
    if (mismatch === 'precision') p.previewSource = { ...p.previewSource, precision: 'other' }
    if (mismatch === 'profile') p.previewSource = { ...p.previewSource, profile: 'other' }
    if (mismatch === 'unready') f.parts.compositor.props.onGone(p.key, p.serial)
    if (mismatch === 'backend') p.backend = 'webgl2'
    const rejected = surfaceParts(f.h.render(f.next))
    expect(rejected.compositor.props.items.find((item: any) => item.tile === p)?.active).toBe(false)
    expect(rejected.wrapper.props['data-revision']).toBe(1)
    expect(rejected.wrapper.props['data-detail-ready']).toBe('false')
  })

test.each(['camera', 'handle', 'interaction', 'source', 'source-page', 'source-epoch', 'source-exact', 'generation', 'device', 'stale-owner'] as const)(
  'new-revision preview never publishes a mismatched %s ACK', async mismatch => {
    const f = await editedViewportPreviewFixture()
    const change: any = {}
    if (mismatch === 'camera') change.frame = { view: { ...f.next.view, zoom: .05 } }
    if (mismatch === 'handle') change.frame = { ids: [f.old.gpuTile] }
    if (mismatch === 'interaction') change.frame = { interaction: true }
    if (mismatch === 'source') change.source = { ...f.parts.compositor.props.presentation, document: f.h.doc }
    if (mismatch === 'source-page') change.source = { ...f.parts.compositor.props.presentation, pageId: 'another-page' }
    if (mismatch === 'source-epoch') change.source = { ...f.parts.compositor.props.presentation, epoch: 999 }
    if (mismatch === 'source-exact') change.source = { ...f.parts.compositor.props.presentation, preview: false }
    if (mismatch === 'generation') f.preview.previewSource = { ...f.preview.previewSource, generation: 999 }
    if (mismatch === 'device') change.device = { deviceOwner: 2 }
    const newer = { ...f.next, document: { ...f.document, nodes: { ...f.document.nodes } } }
    if (mismatch === 'stale-owner') f.h.render(newer)
    acknowledgeRevisionPreview(f, change)
    const rejected = surfaceParts(f.h.render(mismatch === 'stale-owner' ? newer : f.next))
    expect(rejected.wrapper.props['data-revision']).not.toBe(2)
    expect(rejected.wrapper.props['data-native-pixel-ready']).toBe('false')
  })


test('transparent current-revision viewport replaces old color without drawing both revisions', async () => {
  const f = await editedViewportPreviewFixture('#00000000')
  const draws = compositeDrawPlan(f.parts.compositor.props.items, f.next.view, 1024, 512)
  expect(draws).toHaveLength(1)
  expect(draws[0].item.tile).toBe(f.preview)
  expect(draws[0].item.blend).not.toBe(true)
  // A transparent sample in this replacement leaves the cleared target
  // transparent. No old-revision color is submitted underneath to leak back.
  expect(f.parts.compositor.props.items.filter((item: any) => item.active).map((item: any) => item.tile.gpuTile)).toEqual([111])
  expect(f.parts.wrapper.props['data-revision']).toBe(1) // Old handles still held before ACK.
  acknowledgeRevisionPreview(f)
  expect(surfaceParts(f.h.render(f.next)).wrapper.props['data-revision']).toBe(2)
})

test.each(['0','1'])('cold resident preview repairs by replacement while exact tiles are incomplete (progressive=%s)', async flag => {
  vi.stubEnv('VITE_DESIGN_PROGRESSIVE_NATIVE_REPAIR',flag)
  vi.stubGlobal('WebGL2RenderingContext', class {})
  vi.stubGlobal('navigator', { gpu: {} })
  worker.plan = planTiles({ x: 0, y: 0, width: 512, height: 256 }, 4)
  const h = harness(false), options = { backend: 'webgpu', width: 2048, height: 1024, view: { x: 0, y: 0, zoom: 4 } }
  h.render(options)
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1)); worker.calls[0].resolve()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(2)); worker.calls[1].resolve({ backend: 'webgpu', gpuTile: 121 })
  await vi.waitFor(() => expect(worker.calls).toHaveLength(3))
  let parts = surfaceParts(h.render(options))
  const preview = parts.compositor.props.items.find((item: any) => item.tile.viewportPreview).tile
  expect(preview.previewSource.device).toBeUndefined()
  parts.compositor.props.onReady(preview.key, preview.serial, false)
  parts = surfaceParts(h.render(options))
  expect(parts.wrapper.props['data-revision']).toBe(0)
  expect(parts.compositor.props.presentation.preview).toBe(true)
  const device = { client: worker.clients[0], deviceWorkerScope: 11, deviceIncarnation: 1, deviceOwner: 1 }
  parts.compositor.props.onPresented({ view: options.view, width: options.width, height: options.height,
    dpr: 1, interaction: false, ids: [121] }, parts.compositor.props.presentation, device)
  parts = surfaceParts(h.render(options))
  expect(parts.wrapper.props['data-revision']).toBe(1)
  expect(parts.wrapper.props['data-frame-publication']).toBe('preview')
  expect(parts.wrapper.props['data-detail-ready']).toBe('false')
  expect(parts.compositor.props.presentation.preview).toBe(true)
  const first = worker.calls[2].options.tileViewport[0]
  worker.calls[2].progress({ ...first, bytes: new Uint8Array(), backend: 'webgpu', gpuTile: 122, cached: false })
  parts = surfaceParts(h.render(options))
  const fine = parts.compositor.props.items.find((item: any) => item.tile.gpuTile === 122).tile
  parts.compositor.props.onReady(fine.key, fine.serial, false)
  parts = surfaceParts(h.render(options))
  const draws = compositeDrawPlan(parts.compositor.props.items, options.view, options.width, options.height)
  expect(draws.some(row => row.item.tile === fine)).toBe(flag==='1')
  expect(draws.some(row => row.item.tile === preview)).toBe(true)
  expect(draws.every(row => row.item.blend !== true)).toBe(true)
  // Replacement clips, not source-over of the same translucent content twice.
  expect(draws.reduce((area, row) => area + (row.clip.right - row.clip.left) * (row.clip.bottom - row.clip.top), 0)).toBe(options.width * options.height)
  expect(parts.wrapper.props['data-detail-ready']).toBe('false')
  expect(parts.wrapper.props['data-native-pixel-ready']).toBe('false')
  // Actual GPU imports become ready individually. Only the last upload
  // activates the exact cohort; its presentation receipt is still pending.
  const targets = worker.plan!.filter(tile => tile.key !== first.key)
  const ids = [122]
  for (const [index, tile] of targets.entries()) {
    const id = 123 + index
    ids.push(id)
    worker.calls[2].progress({ ...tile, bytes: new Uint8Array(), backend: 'webgpu', gpuTile: id, cached: false })
    parts = surfaceParts(h.render(options))
    const imported = parts.compositor.props.items.find((item: any) => item.tile.gpuTile === id).tile
    parts.compositor.props.onReady(imported.key, imported.serial, false)
    parts = surfaceParts(h.render(options))
    const current = parts.compositor.props.items.filter((item: any) => item.active).map((item: any) => item.tile.gpuTile)
    expect(new Set(current)).toEqual(new Set(index + 1 === targets.length ? ids : flag==='1'?[121,...ids]:[121]))
  }
  expect(parts.wrapper.props['data-detail-ready']).toBe('false')
})

test.each(['0','1',undefined])('quiet native repair does not redraw a covering coarse frame first (mode=%s)',async flag=>{
  nativeNavigationHost();vi.stubEnv('VITE_DESIGN_NATIVE_NAVIGATION','0');vi.stubEnv('VITE_DESIGN_PROGRESSIVE_NATIVE_REPAIR',flag)
  worker.dynamicPlan=true
  const first={x:0,y:0,zoom:2},size={width:512,height:256}
  const seeds=planTiles({x:0,y:0,width:256,height:128},4).map((tile,index)=>({...tile,gpuTile:19000+index}))
  const h=harness(seeds),options={...size,view:first,rasterProfile:'figmaSubpixel'}
  h.render(options);await flushRasterWork()
  const ready=surfaceParts(h.render(options)).compositor
  ready.props.onPresented({view:first,...size,dpr:2,interaction:false,ids:seeds.map(t=>t.gpuTile)},undefined,
    {client:worker.clients[0],deviceWorkerScope:11,deviceIncarnation:1,deviceOwner:1})
  h.render(options);const before=worker.calls.length
  const next={...options,view:{...first,zoom:8}}
  h.render(next);await vi.waitFor(()=>expect(worker.calls.length).toBeGreaterThan(before))
  const request=worker.calls[before]
  if(flag!=='0'){
    expect(request.options.renderIntent).toBe('canvas');expect(request.options.tileViewport.length).toBeGreaterThan(0)
    expect(request.options.tileViewport.every((tile:RasterTile)=>tile.zoom===16)).toBe(true)
  }else expect(request.options.livePreview).toBe(true)
  expect(surfaceParts(h.render(next)).wrapper.props['data-detail-ready']).toBe('false')
})

test('whole-page translation fills original native world misses through the bounded existing canvas owner',async()=>{
  vi.stubGlobal('WebGL2RenderingContext',class {});vi.stubGlobal('navigator',{gpu:{}})
  Object.assign(worker.policy,{desktopFullMath:true,desktopDisplay:true});worker.dpr=2;worker.dynamicPlan=true
  const seeds=planTiles({x:0,y:0,width:128,height:128},2).map((tile,i)=>({...tile,gpuTile:700+i}))
  const h=harness(seeds),options:any={backend:'webgpu',width:128,height:128,view:{x:0,y:0,zoom:1}}
  h.render(options);await flushRasterWork()
  let parts=surfaceParts(h.render(options))
  parts.compositor.props.onPresented({view:options.view,width:128,height:128,dpr:2,interaction:false,ids:seeds.map(tile=>tile.gpuTile)},
    parts.compositor.props.presentation,{client:worker.clients[0],deviceWorkerScope:11,deviceIncarnation:1,deviceOwner:1})
  options.interaction={document:h.doc,selection:['selected'],active:true,epoch:1,control:{current:null},onReady(){}}
  h.render(options);await flushRasterWork();parts=surfaceParts(h.render(options))
  const before=worker.calls.length,failed=vi.fn()
  expect(parts.compositor.props.onTranslatedCoverage(h.doc,{x:256,y:0},1,failed)).toBe(true)
  await vi.waitFor(()=>expect(worker.calls).toHaveLength(before+1))
  const request=worker.calls.at(-1)
  expect(request.document).toBe(h.doc);expect(request.options.view.zoom).toBe(2)
  expect(request.options.tileViewport.every((tile:RasterTile)=>tile.x<0&&tile.zoom===2)).toBe(true)
  expect(request.options.retainInteractionGraph).toBeUndefined()
  expect(request.options.livePreview).not.toBe(true)
  expect(parts.compositor.props.onTranslatedCoverage({...h.doc},{x:256,y:0},2,failed)).toBe(false)
  expect(parts.compositor.props.onTranslatedCoverage(h.doc,{x:.1,y:0},2,failed)).toBe(false)
  for(let i=2;i<50;i++)expect(parts.compositor.props.onTranslatedCoverage(h.doc,{x:256,y:0},i,failed)).toBe(true)
  expect(worker.calls).toHaveLength(before+1)
  request.resolve();await flushRasterWork();expect(failed).not.toHaveBeenCalled()
})

test('covering navigation history cannot globally cancel an in-flight native refinement',async()=>{
  nativeNavigationHost();vi.stubEnv('VITE_DESIGN_NATIVE_NAVIGATION','0');vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX','0')
  worker.dynamicPlan=true
  const doc=blank(),blur=makeNode('rectangle');blur.effects=[makeEffect('blur')];doc.nodes[blur.id]=blur;doc.pages[0].children=[blur.id]
  const seeds=planTiles({x:0,y:0,width:512,height:256},2).map((tile,i)=>({...tile,gpuTile:19000+i}))
  const h=harness(seeds,doc),base={width:512,height:256,view:{x:0,y:0,zoom:1},rasterProfile:'figmaSubpixel'}
  h.render(base);await flushRasterWork()
  let parts=surfaceParts(h.render(base)),device={client:worker.clients[0],deviceWorkerScope:11,deviceIncarnation:1,deviceOwner:1}
  parts.compositor.props.onPresented({view:base.view,width:512,height:256,dpr:2,interaction:false,ids:seeds.map(tile=>tile.gpuTile)},parts.compositor.props.presentation,device)
  h.render(base);worker.zooming=true;worker.cameraMoving=true
  const first={...base,view:{x:0,y:0,zoom:2}}
  worker.navigation={active:true,suspended:false,sample:{active:true,sequence:1,view:first.view}}
  h.render(first);await settleRejected()
  const native=worker.calls.at(-1)
  expect(native.options.tileViewport).toHaveLength(1);expect(native.options.view.zoom).toBe(4)
  const left=(native.options.tileViewport[0].x+1)/4,top=(native.options.tileViewport[0].y+1)/4
  const second={...base,view:{x:-left*4,y:-top*4,zoom:4}}
  worker.navigation={active:true,suspended:false,sample:{active:true,sequence:2,view:second.view}}
  h.render(second);await settleRejected()
  const fine={...native.options.tileViewport[0],gpuTile:19100,bytes:new Uint8Array(),backend:'webgpu',cached:false}
  native.progress(fine)
  parts=surfaceParts(h.render(second));const entry=parts.compositor.props.items.find((i:any)=>i.tile.gpuTile===19100).tile
  parts.compositor.props.onReady(entry.key,entry.serial,false)
  parts=surfaceParts(h.render(second));parts.compositor.props.onPresented({view:second.view,width:512,height:256,dpr:2,interaction:false,ids:[19100]},parts.compositor.props.presentation,device)
  const cancellations=worker.clients[0].cancelPreview.mock.calls.length
  h.render({...second,view:{x:-left*4.1,y:-top*4.1,zoom:4.1}});await settleRejected()
  expect(worker.clients[0].cancelPreview).toHaveBeenCalledTimes(cancellations)
  native.resolve();await settleRejected()
})

test.each(['same','camera','dpr','epoch','policy','document','device'] as const)('a committed edit with an acknowledged viewport selects native repair only for the same contract: %s',async change=>{
  nativeNavigationHost();vi.stubEnv('VITE_DESIGN_NATIVE_NAVIGATION','0');vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX','0')
  worker.dynamicPlan=true
  const doc=blank(),item=makeNode('rectangle');doc.nodes[item.id]=item;doc.pages[0].children=[item.id]
  const seeds=planTiles({x:0,y:0,width:512,height:256},2).map((tile,i)=>({...tile,gpuTile:19500+i}))
  const h=harness(seeds,doc),base={width:512,height:256,view:{x:0,y:0,zoom:1},rasterProfile:'figmaSubpixel'}
  h.render(base);await flushRasterWork()
  let parts=surfaceParts(h.render(base))
  const device={client:worker.clients[0],deviceWorkerScope:11,deviceIncarnation:1,deviceOwner:1}
  parts.compositor.props.onPresented({view:base.view,width:512,height:256,dpr:2,interaction:false,ids:seeds.map(tile=>tile.gpuTile)},parts.compositor.props.presentation,device)
  parts=surfaceParts(h.render(base));expect(parts.wrapper.props['data-detail-ready']).toBe('true')
  const before=worker.calls.length,next={...doc,nodes:{...doc.nodes,[item.id]:{...item,opacity:.5}}},edit:any={...base,document:next}
  if(change==='camera')edit.view={...base.view,x:-512}
  if(change==='dpr')worker.dpr=3
  if(change==='epoch')edit.presentationEpoch=1
  if(change==='policy')edit.rasterProfile='analytic'
  if(change==='document')edit.document={...next,id:'another-document'}
  if(change==='device')parts.compositor.props.onPresented({view:base.view,width:512,height:256,dpr:2,interaction:false,ids:[]},undefined,{...device,deviceOwner:2})
  h.render(edit);await settleRejected()
  expect(worker.calls[before].options.tileViewport).toEqual([])
  worker.clients[0].onDamage({full:true});worker.calls[before].resolve();await settleRejected()
  if(change==='same'){
    expect(worker.calls[before+1].options.livePreview).not.toBe(true)
    expect(worker.calls[before+1].options.renderIntent).toBe('canvas')
    expect(worker.calls[before+1].options.tileViewport.length).toBeGreaterThan(0)
  }else expect(worker.calls[before+1].options.livePreview).toBe(true)
  parts=surfaceParts(h.render(edit));expect(parts.wrapper.props['data-detail-ready']).toBe('false')
  if(change==='same')expect(worker.clients[0].releasePresented.mock.calls.flat(2)).not.toContain(19500)
})

test('continuous zoom keeps shown residents when a matching preview arrives and the wheel moves again', async () => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  vi.stubGlobal('navigator', { gpu: {} })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const seeds = [
    { key: '4:0:0:0:0', x: -1, y: -1, width: 514, height: 514, zoom: 4, gpuTile: 11 },
    { key: '4:0:0:1:0', x: 511, y: -1, width: 514, height: 514, zoom: 4, gpuTile: 12 },
  ]
  const h = harness(seeds)
  const settled = { backend: 'webgpu' as const, width: 1024, height: 512, view: { x: 0, y: 0, zoom: 4 } }
  h.render(settled)
  await flushRasterWork()
  let parts = surfaceParts(h.render(settled))
  const device = { client: worker.clients[0], deviceWorkerScope: 11, deviceIncarnation: 1, deviceOwner: 1 }
  parts.compositor.props.onPresented({ view: settled.view, width: 1024, height: 512, dpr: 1, interaction: false, ids: [11, 12] },
    parts.compositor.props.presentation, device)
  parts = surfaceParts(h.render(settled))
  expect(parts.wrapper.props['data-frame-publication']).toBe('complete')
  expect(parts.compositor.props.items.filter((item: any) => item.active).map((item: any) => item.tile.gpuTile).sort()).toEqual([11, 12])
  const zoomed = { ...settled, view: { x: -20, y: 8, zoom: 4.2 } }
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 1, view: zoomed.view } }
  worker.zooming = true
  h.render(zoomed)
  await vi.waitFor(() => expect(worker.calls.some((call: any) => call.options.renderIntent === 'preview' && call.options.view.zoom === zoomed.view.zoom)).toBe(true))
  const previewCall = [...worker.calls].reverse().find((call: any) => call.options.renderIntent === 'preview')
  previewCall.resolve({ gpuTile: 50, backend: 'webgpu' })
  await flushRasterWork()
  parts = surfaceParts(h.render(zoomed))
  const preview = parts.compositor.props.items.find((item: any) => item.tile.gpuTile === 50)
  expect(preview?.tile.viewportPreview).toBe(true)
  parts.compositor.props.onReady(preview.tile.key, preview.tile.serial, false)
  parts = surfaceParts(h.render(zoomed))
  const active = parts.compositor.props.items.filter((item: any) => item.active)
  expect(active.some((item: any) => item.tile.gpuTile === 11)).toBe(true)
  expect(active.some((item: any) => item.tile.gpuTile === 12)).toBe(true)
  const draws = compositeDrawPlan(parts.compositor.props.items, zoomed.view, zoomed.width, zoomed.height)
  const area = draws.reduce((sum, row) => sum + (row.clip.right - row.clip.left) * (row.clip.bottom - row.clip.top), 0)
  expect(area).toBe(zoomed.width * zoomed.height)
  expect(draws.every(row => (row.item.tile as { document?: object }).document === h.doc)).toBe(true)
  const covered = compositeDrawPlan(parts.compositor.props.items.filter((item: any) => item.tile.gpuTile === 11 || item.tile.gpuTile === 12), zoomed.view, zoomed.width, zoomed.height)
    .reduce((sum, row) => sum + (row.clip.right - row.clip.left) * (row.clip.bottom - row.clip.top), 0)
  expect(draws.filter(row => (row.item.tile as { gpuTile?: number }).gpuTile === 11 || (row.item.tile as { gpuTile?: number }).gpuTile === 12)
    .reduce((sum, row) => sum + (row.clip.right - row.clip.left) * (row.clip.bottom - row.clip.top), 0)).toBe(covered)
  const later = { ...zoomed, view: { x: -48, y: 16, zoom: 4.6 } }
  worker.navigation = { active: true, suspended: false, sample: { active: true, sequence: 2, view: later.view } }
  parts = surfaceParts(h.render(later))
  const still = parts.compositor.props.items.filter((item: any) => item.active)
  expect(still.some((item: any) => item.tile.gpuTile === 11)).toBe(true)
  expect(still.some((item: any) => item.tile.gpuTile === 12)).toBe(true)
  const laterDraws = compositeDrawPlan(parts.compositor.props.items, later.view, later.width, later.height)
  const laterResidents = compositeDrawPlan(parts.compositor.props.items.filter((item: any) => item.tile.gpuTile === 11 || item.tile.gpuTile === 12), later.view, later.width, later.height)
  const paint = (rows: typeof laterDraws) => rows.reduce((sum, row) => sum + (row.clip.right - row.clip.left) * (row.clip.bottom - row.clip.top), 0)
  expect(paint(laterDraws.filter(row => (row.item.tile as { gpuTile?: number }).gpuTile === 11 || (row.item.tile as { gpuTile?: number }).gpuTile === 12))).toBe(paint(laterResidents))
})
