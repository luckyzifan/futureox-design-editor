import React from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { blank, node as makeNode, effect as makeEffect } from '../model'
import { ProgressiveSurfaceImpl } from './ProgressiveSurface'
import { NavigationZoom } from './navigation-zoom'
import { compositeDrawPlan } from './gpu/composite-draw-plan'
import { planTiles, type RasterTile } from './tile-cache'
import { prioritizeTileFill } from './tile-scheduler'
import { tileBatchPrepareViewport } from './tile-prepare-viewport'

const worker = vi.hoisted(() => ({ clients: [] as any[], calls: [] as any[], maintenance: [] as any[],
  plannedScales: [] as number[], plannedPhases: [] as { x: number; y: number }[],
  plan: undefined as RasterTile[] | undefined,
  zooming: false, cameraMoving: undefined as boolean | undefined, forceLod: false,
  navigation: { active: false, suspended: false, sample: undefined as any } }))
vi.mock('./use-navigation-zoom', () => ({ useNavigationZoom: () => worker.navigation }))
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
  renderExecutionPolicy: { hdrCompositing: false },
  KernelClient: class {
    onDamage?: (damage: unknown) => void
    cancelPreview = vi.fn()
    cancelTileFill = vi.fn()
    dispose = vi.fn()
    constructor() { worker.clients.push(this) }
    releasePresented = vi.fn()
    render(document: unknown, options: any, ...args: any[]) {
      return new Promise((resolve, reject) => worker.calls.push({ document, options, reject, progress: args[5], resolve: (extra = {}) => resolve({
        milliseconds: 0, compileMs: 0, graphMs: 0, finishMs: 0, checkpointMs: 0,
        bytes: new Uint8Array(), backend: 'webgpu', ...extra,
      }) }))
    }
  },
}))
vi.mock('./module', () => ({ initializeKernelModule: async () => {} }))
vi.mock('./tile-plan-aligned', () => {
  const planTilesAligned = (_bounds?: unknown, scale?: number) => worker.plan ?? (worker.forceLod && scale === .125
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
      const viewport = planTilesAligned().map(tile => !phase.x && !phase.y ? tile : { ...tile,
        key: `${tile.key}/phase:${phase.x}:${phase.y}`, phaseX: phase.x, phaseY: phase.y })
      return { viewport, rim: [], cacheLimitSkipped: 0 }
    },
  }
})
vi.mock('./presentation', async importOriginal => ({
  ...await importOriginal<any>(), useDevicePixelRatio: () => 1,
  useDisplayCapability: () => undefined,
}))

/** Run the production surface's hooks/effects with already painted residents.
 * Worker synchronization is deliberately controllable so stale/cancelled
 * completions can be ordered adversarially. No raster results are invented. */
function surfaceHarness(seedResidents: boolean | RasterTile[] = true) {
  const doc = blank('resident document'), states: any[] = [], refs: any[] = [], memos: any[] = []
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
  return { doc, keys, render, dispose }
}

const harnesses: ReturnType<typeof surfaceHarness>[] = []
const harness = (seedResidents: boolean | RasterTile[] = true) => { const value = surfaceHarness(seedResidents); harnesses.push(value); return value }
afterEach(() => {
  for (const h of harnesses) h.dispose()
  harnesses.length = 0; worker.calls.length = 0; worker.clients.length = 0
  worker.zooming = false
  worker.cameraMoving = undefined; worker.plannedScales.length = 0; worker.plannedPhases.length = 0
  worker.plan = undefined
  worker.navigation = { active: false, suspended: false, sample: undefined }
  worker.forceLod = false; worker.maintenance.length = 0
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
  expect(worker.maintenance[0].jobs.every((tile: any) => tile.key.startsWith('overview:'))).toBe(true)
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

test('zoom with covering residents requests missing native tiles before another viewport preview', async () => {
  worker.zooming = true
  vi.stubGlobal('WebGL2RenderingContext', class {})
  vi.stubGlobal('navigator', { gpu: {} })
  const h = harness(); h.render({ width: 512, view: { x: -512, y: 0, zoom: 4 } })
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1))
  worker.clients[0].onDamage({ full: false, bounds: [0, 0, 10, 10] })
  worker.calls[0].resolve()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(2))
  expect(worker.calls[1].options.livePreview).not.toBe(true)
  expect(worker.calls[1].options.tileViewport.map((tile: any) => tile.key)).toEqual([h.keys[0]])
})

test('partly exposed views repair native tiles without a serial full-scene preview', async () => {
  worker.zooming = true
  vi.stubGlobal('WebGL2RenderingContext', class {})
  vi.stubGlobal('navigator', { gpu: {} })
  const h = harness(); h.render()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1))
  worker.clients[0].onDamage({ full: false, bounds: [0, 0, 10, 10] })
  worker.calls[0].resolve()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(2))
  expect(worker.calls[1].options.livePreview).not.toBe(true)
  expect(worker.calls[1].options.tileViewport.map((tile: any) => tile.key)).toEqual([h.keys[0]])
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

test('normal zoom fills native pixels during motion without a reduced-density preview', async () => {
  worker.zooming = true; worker.forceLod = true
  vi.stubGlobal('WebGL2RenderingContext', class {})
  vi.stubGlobal('navigator', { gpu: {} })
  const h = harness(); h.render()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(1))
  worker.clients[0].onDamage({ full: true }); worker.calls[0].resolve()
  await vi.waitFor(() => expect(worker.calls).toHaveLength(2))
  expect(worker.calls[1].options.livePreview).not.toBe(true)
  expect(worker.calls[1].options.renderIntent).toBe('canvas')
  expect(worker.calls[1].options.tileViewport.map((tile:any) => tile.key)).toEqual(h.keys)
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
  const view = { x: 0, y: 0, zoom: 8 }
  worker.navigation = { active: true, suspended: false, sample: { active: true, view, sequence: 1 } }
  h.render({ backend: 'webgl2', view }); await flushRasterWork()
  expect(worker.calls).toHaveLength(before)
  expect(worker.plannedScales).toEqual([])
  worker.navigation = { active: false, suspended: false, sample: undefined }
  h.render({ backend: 'webgl2', view }); await flushRasterWork()
  expect(worker.plannedScales).toEqual([8])
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
  const running = worker.calls[1]
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
  await Promise.resolve(); await Promise.resolve()
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
  expect(compositor.props.items.find((item: any) => item.tile === old)?.active).toBe(true)
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
  for (const capture of captures)
    expect(compositor.props.items.find((item: any) => item.tile === capture)?.active).toBe(true)
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

test('fast zoom-out keeps the wider sampled viewport while the new wide capture is delayed', async () => {
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
  expect(draws.some(row => row.item.tile.zoom === 4)).toBe(true)
})
