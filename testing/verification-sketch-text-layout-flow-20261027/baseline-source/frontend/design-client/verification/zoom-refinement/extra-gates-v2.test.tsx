// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { blank } from '../../src/model'
import { readFile } from 'node:fs/promises'
import { URL as FileURL } from 'node:url'

const state = vi.hoisted(() => ({ signals: [] as any[], workers: [] as any[], active: true, sequence: 1, real: false, sampleView: undefined as any, pending: [] as any[], clients: [] as any[], composites: [] as any[] }))
vi.mock('../../src/kernel/module', async original => {
  const actual = await original<any>()
  return { ...actual, initializeKernelModule: async () => {
    if (state.real) await actual.initializeKernelModule(new Uint8Array(await readFile(
      new FileURL('../../public/kernel/design_kernel_bg.wasm', import.meta.url))))
  } }
})
vi.mock('../../src/kernel/canvas-effect-sampling', async original => {
  const actual = await original<any>()
  return { pageHasFilteredContent: (...args: any[]) => state.real ? actual.pageHasFilteredContent(...args) : true }
})
vi.mock('../../src/kernel/tile-plan-aligned', async original => {
  const actual = await original<any>()
  return { tilePrefetchRingsFromHost: () => 0,
  planTilesAligned: (bounds: any, zoom: number, _limit: number, phase = { x: 0, y: 0 }) => {
    if (state.real) return actual.planTilesAligned(bounds, zoom, _limit, phase)
    const x = Math.floor((bounds.x + bounds.width / 2) * zoom / 512) * 512 - 1
    const y = Math.floor((bounds.y + bounds.height / 2) * zoom / 512) * 512 - 1
    return [0, 512, -512].map(dx => ({ key: `${zoom}:${phase.x}:${phase.y}:${x + dx}:${y}`,
      x: x + dx, y, width: 514, height: 514, gutter: 1, zoom, phaseX: phase.x, phaseY: phase.y }))
  },
  planTilesWithPrefetchRim: (bounds: any, zoom: number, _limit: number, phase = { x: 0, y: 0 }) => {
    if (state.real) return actual.planTilesWithPrefetchRim(bounds, zoom, _limit, phase)
    return { viewport: [{ key: `${zoom}:${phase.x}:${phase.y}:-1:-1`, x: -1, y: -1,
      width: 514, height: 514, gutter: 1, zoom, phaseX: phase.x, phaseY: phase.y }], rim: [], cacheLimitSkipped: 0 }
  },
} })
vi.mock('../../src/kernel/use-navigation-zoom', () => ({ useNavigationZoom: (view: any, _identity: string, enabled: boolean) => ({
  active: enabled && state.active, suspended: false, panEnabled: true,
  sample: enabled && state.active ? { sequence: state.sequence, view: state.sampleView || view } : undefined,
}) }))
vi.mock('../../src/kernel/use-raster-density', () => ({ useRasterDensity: (density: number) => density }))
vi.mock('../../src/kernel/use-zoom-activity', () => ({ useZoomActivity: () => false, useCameraActivity: () => true }))
vi.mock('../../src/kernel/presentation', async original => ({ ...await original<any>(), useDevicePixelRatio: () => 2, useDisplayCapability: () => undefined }))
vi.mock('../../src/kernel/ResidentCompositeSurface', () => ({ ResidentCompositeSurface: (props: any) => { state.composites.push(props); return null } }))
vi.mock('../../src/kernel/TileCompositeSurface', () => ({ TileCompositeSurface: () => null }))

beforeEach(() => {
  state.signals = []; state.workers = []; state.active = true; state.sequence = 1; state.real = false; state.sampleView = undefined; state.pending = []; state.clients = []; state.composites = []
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('WebGL2RenderingContext', function () {})
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: {} })
  vi.stubEnv('VITE_DESIGN_NATIVE_NAVIGATION', '0'); vi.stubEnv('VITE_DESIGN_SHARP_ZOOM', '0'); vi.stubEnv('VITE_DESIGN_GESTURE_DENSITY_HEADROOM', '0')
})
afterEach(() => { vi.restoreAllMocks(); delete (window as any).coreDesktop; vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); delete (navigator as any).gpu })

beforeEach(async () => {
  vi.stubEnv('VITE_DESIGN_PREPARATION_WORKER', '0')
  Object.defineProperty(window, 'coreDesktop', { configurable: true,
    value: { version: 1, renderPolicy: { cpuOnly: false } } })
  class WorkerStub {
    messages: any[] = []; onmessage?: (event: any) => void
    constructor() { state.workers.push(this) }
    postMessage(message: any) {
      this.messages.push(message)
      if (message.id && !message.command) state.pending.push({ ...message, worker: this })
    }
    reply(data: any) { this.onmessage?.({ data }) }
    terminate() {}
  }
  vi.stubGlobal('Worker', WorkerStub)
  const { KernelClient } = await import('../../src/kernel/client')
  const original = KernelClient.prototype.render
  vi.spyOn(KernelClient.prototype, 'render').mockImplementation(function(this: any, ...args: any[]) {
    if (!state.clients.includes(this)) state.clients.push(this)
    state.signals.push(args[8])
    return original.apply(this, args as any)
  })
  vi.spyOn(KernelClient.prototype, 'cancelPreview')
  vi.spyOn(KernelClient.prototype, 'releasePresented')
})
async function fixture(zoom = 32, document = blank()) {
  const { ProgressiveSurfaceImpl } = await import('../../src/kernel/ProgressiveSurface')
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
  const commitSync = (extra: any = {}) => { props = { ...props, ...extra }; flushSync(() => root.render(<ProgressiveSurfaceImpl {...props} />)) }
  return { render, commitSync, root, container, get props() { return props } }
}


const turns = async () => { await act(async () => { for (let i=0;i<8;i++) await Promise.resolve() }) }
const finishCapture = async (index: number, gpuTile: number) => {
  await act(async () => state.pending[index].worker.reply({ id: state.pending[index].id, buffer: new ArrayBuffer(0), gpuTile,
    backend: 'webgpu', milliseconds: 1 }))
}
const acknowledgeCapture = async (gpuTile: number) => {
  let p = state.composites.at(-1), item = p.items.find((i: any) => i.tile.gpuTile === gpuTile)
  expect(item).toBeDefined()
  await act(async () => p.onReady(item.tile.key, item.tile.serial, false))
  p = state.composites.at(-1)
  const device = { client: state.clients[0], deviceWorkerScope: 1, deviceIncarnation: 1, deviceOwner: 1 }
  await act(async () => p.onPresented({ ids: [gpuTile], view: p.view, width: p.width,
    height: p.height, dpr: p.dpr, interaction: false }, p.presentation, device))
}


const enableNative = (native: boolean) => {
  vi.stubEnv('VITE_DESIGN_NATIVE_NAVIGATION', native ? '1' : '0')
  vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', '1')
}
const assertLane = (f: any, native: boolean) => {
  expect(f.container.querySelector('[data-native-navigation]')?.getAttribute('data-native-navigation')).toBe(String(native))
}
const seedAndStartOld = async (native: boolean) => {
  enableNative(native)
  const f = await fixture(.5)
  assertLane(f, native)
  await finishCapture(0, 101); await acknowledgeCapture(101)
  state.sequence++; await f.render({ view: { x: 0, y: 0, zoom: 32 } })
  await vi.waitFor(() => expect(state.pending).toHaveLength(2))
  return f
}
const lateOld = async (old: any, gpuTile: number) => {
  const bitmap = { close: vi.fn() }
  await act(async () => old.worker.reply({ id: old.id, gpuTile, bitmap,
    buffer: new ArrayBuffer(0), backend: 'webgpu', milliseconds: 1 }))
  return bitmap
}

for (const native of [false, true]) {
  for (const zoom of [1, 5]) test(`native=${native}: quiet ${zoom}x submits exact before old 32x response`, async () => {
    const f = await seedAndStartOld(native)
    try {
      const old=state.pending[1], client=state.clients[0], cancels=client.cancelPreview.mock.calls.length
      state.sequence++; await f.render({view:{x:0,y:0,zoom}})
      state.active=false; await f.render()
      await vi.waitFor(()=>expect(state.pending).toHaveLength(3))
      assertLane(f,native)
      expect(state.signals[1].aborted).toBe(true)
      expect(state.pending[2].options.renderIntent).toBe('canvas')
      expect(state.pending[2].options.view.zoom).toBe(zoom*2)
      expect(old.worker.messages.filter((m:any)=>m.command==='cancel-request').map((m:any)=>m.requestId)).toEqual([old.id])
      expect(client.cancelPreview).toHaveBeenCalledTimes(cancels)
      expect(state.composites.at(-1).items.find((i:any)=>i.tile.gpuTile===101)?.active).toBe(true)
      expect(client.releasePresented.mock.calls.flat(2)).not.toContain(101)
      const bitmap=await lateOld(old,132)
      expect(bitmap.close).toHaveBeenCalledOnce()
      expect(client.releasePresented.mock.calls.flat(2)).toContain(132)
      expect(state.composites.at(-1).items.some((i:any)=>i.tile.gpuTile===132)).toBe(false)
      expect(client.cancelPreview).toHaveBeenCalledTimes(cancels)
      expect(f.container.querySelector('[data-detail-ready="true"]')).toBeNull()
    } finally { await act(async()=>f.root.unmount()) }
  })

  test(`native=${native}: synchronous quiet zoom-out then active old-camera reversal has a live successor`, async () => {
    const f=await seedAndStartOld(native)
    try {
      const old=state.pending[1], client=state.clients[0], cancels=client.cancelPreview.mock.calls.length
      await act(async()=>{
        // Two committed effects in one JavaScript turn. Do not let the old
        // cancellation promise settle before the active same-camera restart.
        state.active=false; f.commitSync({view:{x:0,y:0,zoom:1}})
        expect(state.signals[1].aborted).toBe(true)
        state.active=true; state.sequence++; f.commitSync({view:{x:0,y:0,zoom:32}})
      })
      await turns()
      await vi.waitFor(()=>expect(state.pending).toHaveLength(3),{timeout:250})
      const resumed=state.pending[2], resumedSignal=state.signals[2]
      expect(resumed.id).not.toBe(old.id)
      expect(resumed.options.renderIntent).toBe('preview')
      expect(resumed.options.view).toEqual(old.options.view)
      expect(resumedSignal.aborted).toBe(false)
      const bitmap=await lateOld(old,132)
      expect(bitmap.close).toHaveBeenCalledOnce()
      expect(client.releasePresented.mock.calls.flat(2)).toContain(132)
      expect(resumedSignal.aborted).toBe(false)
      expect(client.cancelPreview).toHaveBeenCalledTimes(cancels)
      expect(state.composites.at(-1).items.find((i:any)=>i.tile.gpuTile===101)?.active).toBe(true)
      // The new request can complete into its own history, without stale A.
      await finishCapture(2,133)
      expect(state.composites.at(-1).items.some((i:any)=>i.tile.gpuTile===133)).toBe(true)
      expect(state.composites.at(-1).items.some((i:any)=>i.tile.gpuTile===132)).toBe(false)
      expect(f.container.querySelector('[data-detail-ready="true"]')).toBeNull()
    } finally { await act(async()=>f.root.unmount()) }
  })

  for (const boundary of ['contract','document','paused','visible','device'] as const)
    test(`native=${native}: ${boundary} invalidation releases old late payload without cancelling successor`,async()=>{
      const f=await seedAndStartOld(native)
      try {
        const old=state.pending[1],client=state.clients[0]
        if(boundary==='device') {
          const p=state.composites.at(-1)
          await act(async()=>p.onPresented({ids:[],view:p.view,width:p.width,height:p.height,dpr:p.dpr,interaction:false},
            undefined,{client,deviceWorkerScope:1,deviceIncarnation:2,deviceOwner:1}))
        } else if(boundary==='document') {
          const document=blank(); await f.render({document,pageId:document.pages[0].id})
        } else await f.render(boundary==='contract'?{presentationEpoch:2}:boundary==='paused'?{paused:true}:{visible:false})
        expect(state.signals[1].aborted).toBe(true)
        const before=old.worker.messages.filter((m:any)=>m.command==='cancel-request').map((m:any)=>m.requestId)
        expect(before).toContain(old.id)
        const bitmap=await lateOld(old,132); await turns()
        expect(bitmap.close).toHaveBeenCalledOnce()
        expect(client.releasePresented.mock.calls.flat(2)).toContain(132)
        expect(state.composites.at(-1).items.some((i:any)=>i.tile.gpuTile===132)).toBe(false)
        expect(old.worker.messages.filter((m:any)=>m.command==='cancel-request').map((m:any)=>m.requestId)).toEqual(before)
        expect(f.container.querySelector('[data-detail-ready="true"]')).toBeNull()
      } finally { await act(async()=>f.root.unmount()) }
    })
}

for (const boundary of ['contract','document','page','paused','visible','device','new-sample'] as const)
  test(`native reversal wake is fenced by latest ${boundary}`,async()=>{
    const f=await seedAndStartOld(true)
    try {
      const old=state.pending[1],client=state.clients[0]
      let latestPage=f.props.pageId
      await act(async()=>{
        state.active=false; f.commitSync({view:{x:0,y:0,zoom:1}})
        state.active=true; state.sequence++; f.commitSync({view:{x:0,y:0,zoom:32}})
        expect(state.signals[1].aborted).toBe(true)
        expect(state.pending).toHaveLength(2)
        if(boundary==='device') {
          const p=state.composites.at(-1)
          p.onPresented({ids:[],view:p.view,width:p.width,height:p.height,dpr:p.dpr,interaction:false},
            undefined,{client,deviceWorkerScope:1,deviceIncarnation:2,deviceOwner:1})
          f.commitSync()
        } else if(boundary==='document') {
          const document=blank(); latestPage=document.pages[0].id
          f.commitSync({document,pageId:latestPage})
        } else if(boundary==='page') {
          // A pageId scope fence is independent of authored object identity.
          // Worker rendering is deliberately outside this scheduling test.
          latestPage='other-page'; f.commitSync({pageId:latestPage})
        } else if(boundary==='new-sample') {
          state.sequence++; f.commitSync({view:{x:0,y:0,zoom:5}})
        } else f.commitSync(boundary==='contract'?{presentationEpoch:2}:boundary==='paused'?{paused:true}:{visible:false})
      })
      await turns()
      if(boundary==='paused') {
        expect(state.pending).toHaveLength(2)
      } else {
        await vi.waitFor(()=>expect(state.pending).toHaveLength(3),{timeout:250})
        const newest=state.pending[2]
        expect(newest.options.pageId).toBe(latestPage)
        if(boundary==='visible') expect(newest.options.renderIntent).toBe('canvas')
        else {
          expect(newest.options.renderIntent).toBe('preview')
          expect(state.signals[2].aborted).toBe(false)
          expect(newest.options.view.zoom).toBe(boundary==='new-sample'?10:64)
        }
      }
      const before=old.worker.messages.filter((m:any)=>m.command==='cancel-request').map((m:any)=>m.requestId)
      const bitmap=await lateOld(old,132); await turns()
      expect(bitmap.close).toHaveBeenCalledOnce()
      expect(client.releasePresented.mock.calls.flat(2)).toContain(132)
      expect(state.composites.at(-1).items.some((i:any)=>i.tile.gpuTile===132)).toBe(false)
      expect(old.worker.messages.filter((m:any)=>m.command==='cancel-request').map((m:any)=>m.requestId)).toEqual(before)
      expect(state.pending).toHaveLength(boundary==='paused'?2:3)
      expect(f.container.querySelector('[data-detail-ready="true"]')).toBeNull()
    } finally { await act(async()=>f.root.unmount()) }
  })
