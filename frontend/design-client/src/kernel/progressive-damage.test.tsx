import React from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { blank } from '../model'
import { ProgressiveSurfaceImpl } from './ProgressiveSurface'

const worker = vi.hoisted(() => ({ clients: [] as any[], calls: [] as any[], maintenance: [] as any[], zooming: false, forceLod: false }))
vi.mock('./use-zoom-activity', () => ({ useZoomActivity: () => worker.zooming, useCameraActivity: () => worker.zooming }))
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
    render(document: unknown, options: any) {
      return new Promise(resolve => worker.calls.push({ document, options, resolve: () => resolve({
        milliseconds: 0, compileMs: 0, graphMs: 0, finishMs: 0, checkpointMs: 0,
        bytes: new Uint8Array(), backend: 'webgpu',
      }) }))
    }
  },
}))
vi.mock('./module', () => ({ initializeKernelModule: async () => {} }))
vi.mock('./tile-plan-aligned', () => {
  const planTilesAligned = (_bounds?: unknown, scale?: number) => worker.forceLod && scale === .125
    ? Array.from({ length: 8 }, (_, i) => ({ key: `.5:0:0:${i % 4}:${Math.floor(i / 4)}`,
      x: (i % 4) * 512 - 1, y: Math.floor(i / 4) * 512 - 1, width: 514, height: 514, zoom: .5 })) : [
    { key: '4:0:0:0:0', x: -1, y: -1, width: 514, height: 514, zoom: 4 },
    { key: '4:0:0:1:0', x: 511, y: -1, width: 514, height: 514, zoom: 4 },
  ]
  return {
    planTilesAligned,
    // This harness pins damage/cancellation semantics, not the prefetch rim:
    // rings 0 keeps its plan identical to the pre-rim planner output.
    tilePrefetchRingsFromHost: () => 0,
    planTilesWithPrefetchRim: () => ({ viewport: planTilesAligned(), rim: [], cacheLimitSkipped: 0 }),
  }
})
vi.mock('./presentation', async importOriginal => ({
  ...await importOriginal<any>(), useDevicePixelRatio: () => 1,
  useDisplayCapability: () => undefined,
}))

/** Run the production surface's hooks/effects with already painted residents.
 * Worker synchronization is deliberately controllable so stale/cancelled
 * completions can be ordered adversarially. No raster results are invented. */
function surfaceHarness() {
  const doc = blank('resident document'), states: any[] = [], refs: any[] = [], memos: any[] = []
  const effectSlots: any[] = [], layoutSlots: any[] = []
  const keys = ['4:0:0:0:0', '4:0:0:1:0']
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
        if (value instanceof Map) value = new Map(keys.map((key, i) => [key, {
          key, x: i * 512 - 1, y: -1, width: 514, height: 514, zoom: 4,
          revision: 1, serial: i + 1, document: doc, bytes: new Uint8Array(), backend: 'webgpu',
        }]))
        states[index] = value
      }
      return [states[index], (next: any) => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
    },
    useRef(init: any) {
      const index = refIndex++
      if (!(index in refs)) refs[index] = { current: init instanceof Set ? new Set(keys) : init }
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
const harness = () => { const value = surfaceHarness(); harnesses.push(value); return value }
afterEach(() => {
  for (const h of harnesses) h.dispose()
  harnesses.length = 0; worker.calls.length = 0; worker.clients.length = 0
  worker.zooming = false
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
  expect(worker.calls[1].options.tileViewport.map((tile: any) => tile.key)).toEqual(h.keys)
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
  expect(worker.calls[2].options.tileViewport.map((tile: any) => tile.key)).toEqual(h.keys)
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
