// @ts-expect-error jsdom runtime dependency
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'

const calls = vi.hoisted(() => ({ requests: 0, attached: 0, presented: 0, frames: 0, keys: [] as string[],defer:false,pending:[] as (()=>void)[] }))
vi.mock('./client', () => ({
  backendPreference: () => 'cpu',
  renderExecutionPolicy: { desktopFullMath: true, desktopDisplay: true, cpuOnly: true, hdrCompositing: false },
  KernelClient: class {
    onPresentation?: unknown
    renderSource(_source: unknown, options: { tileViewport?: { key: string; x: number; y: number; width: number; height: number; zoom: number; gutter?: number }[] }, progress?: (tile: object) => void) {
      calls.requests++
      const tile = options.tileViewport?.[0]
      if (tile) calls.keys.push(tile.key)
      if (!tile) return Promise.resolve({ bytes: new Uint8Array() })
      const deliver=()=>progress?.({
        ...tile,
        bytes: new Uint8Array(tile.width * tile.height * 4),
        bitmap: { close() {} },
        backend: 'cpu',
        description: 'cpu tile',
        milliseconds: 1,
        cached: false,
      })
      if(calls.defer)return new Promise(resolve=>calls.pending.push(()=>{deliver();resolve({bytes:new Uint8Array()})}))
      deliver()
      return Promise.resolve({ bytes: new Uint8Array() })
    }
    attachPresentation() { calls.attached++ }
    present() { calls.presented++ }
    releasePresented() {}
    dispose() {}
  },
}))
vi.mock('./presentation', () => ({ useDevicePixelRatio: () => 1 }))
vi.mock('./tile-plan-aligned', () => {
  const planTilesAligned = (_bounds: unknown, zoom: number) =>
    [{ key: `tile:${zoom}`, x: 0, y: 0, width: 514, height: 514, zoom, gutter: 1 }]
  return { planTilesAligned, planTilesWithPrefetchRim: (bounds: unknown, zoom: number) => ({
    viewport: planTilesAligned(bounds, zoom), rim: [], cacheLimitSkipped: 0,
  }) }
})

import { NativeSourceSurface, type NativeSourceStatus } from './NativeSourceSurface'
import type { SourceCanvasSnapshot } from '../desktop'

test('cpu-only source overview draws bitmap tiles without a gpu texture or a full-frame attach', async () => {
  const dom = new JSDOM('<div id="root"></div>')
  const drawImage = vi.fn()
  const contexts:string[]=[]
  dom.window.HTMLCanvasElement.prototype.getContext = (type:string) => {
    contexts.push(type)
    return type==='2d' ? {setTransform(){},fillRect(){},drawImage} : null
  }
  for (const name of ['window', 'document', 'navigator'] as const) vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    calls.frames++
    queueMicrotask(() => fn(0))
    return calls.frames
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const root = createRoot(document.getElementById('root')!)
  const source: SourceCanvasSnapshot = {
    owner: { documentId: 'source', sessionEpoch: 1 }, revision: 0, token: 'source-token',
    bytes: 113 * 1024 * 1024, nodes: 18000, roots: 420, pageId: 'page', stageId: 'stage',
    bounds: { x: 0, y: 0, width: 24000, height: 16000 }, warnings: [], rasterProfile: 'analytic', colorManaged: false,
  }
  const statuses: NativeSourceStatus[] = []
  const receipts:{preview?:boolean;complete:boolean;regions:unknown}[]=[]
  try {
    calls.requests = 0
    calls.attached = 0
    calls.presented = 0
    calls.keys = []
    calls.defer=true
    await act(async () => root.render(<NativeSourceSurface source={source} view={{ x: 12, y: 8, zoom: 0.05 }} width={800} height={600} onStatus={status => statuses.push(status)} onPresented={(frame,complete,regions)=>receipts.push({preview:frame.preview,complete,regions})} />))
    // The pasteboard can be painted before a delayed CPU worker returns any
    // content. That receipt cannot punch holes through other source previews.
    await act(async()=>{await vi.waitFor(()=>expect(receipts.some(frame=>frame.preview&&!frame.complete)).toBe(true))})
    expect(receipts.every(frame=>!frame.complete&&frame.regions===undefined)).toBe(true)
    await act(async()=>{calls.defer=false;for(const deliver of calls.pending.splice(0))deliver()})
    // Motion coverage remains a preview until the quiet camera requests its native lattice.
    await act(async () => { await vi.waitFor(() => expect(statuses.at(-1)?.phase, JSON.stringify(statuses)).toBe('ready')) })
    expect(drawImage).toHaveBeenCalled()
    expect(contexts).not.toContain('bitmaprenderer')
    expect(calls.attached).toBe(0)
    expect(calls.presented).toBe(0)
    expect(calls.requests).toBeGreaterThanOrEqual(2)
    expect(statuses.some(status => status.phase === 'error')).toBe(false)
    expect(statuses.at(-1)).toMatchObject({ phase: 'ready', done: 1, total: 1, sharp: true, view: { x: 12, y: 8, zoom: 0.05 } })
    expect(receipts.some(frame=>frame.complete&&!frame.preview)).toBe(true)
    expect(dom.window.document.querySelector('.kernel-status')?.textContent).toBe('CPU · 已显示')
  } finally {
    calls.defer=false;calls.pending=[]
    await act(async () => root.unmount())
    dom.window.close()
    vi.unstubAllGlobals()
  }
})

test('cpu-only pan of a zoomed-out artboard paints the coarse page tile into the strip', async () => {
  const dom = new JSDOM('<div id="root"></div>')
  dom.window.HTMLCanvasElement.prototype.getContext = (type: string) => type === '2d' ? { setTransform() {}, fillRect() {}, drawImage() {}, putImageData() {} } : null
  for (const name of ['window', 'document', 'navigator'] as const) vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { calls.frames++; queueMicrotask(() => fn(0)); return calls.frames })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const root = createRoot(document.getElementById('root')!)
  const source: SourceCanvasSnapshot = {
    owner: { documentId: 'source', sessionEpoch: 1 }, revision: 0, token: 'source-token',
    bytes: 1000, nodes: 753, roots: 1, pageId: 'page', stageId: 'stage',
    bounds: { x: 0, y: 0, width: 400, height: 220 }, warnings: [], rasterProfile: 'figma', colorManaged: true,
  }
  const presented: { x: number; y: number; zoom: number }[] = []
  calls.keys = []
  try {
    const paint = (view: { x: number; y: number; zoom: number }) => root.render(<NativeSourceSurface source={source} view={view} width={1000} height={700} onPresented={frame => presented.push(frame.view)} />)
    await act(async () => paint({ x: 460, y: 300, zoom: 0.08 }))
    await act(async () => { await vi.waitFor(() => expect(calls.keys.some(key => key.startsWith('navigation-overview:'))).toBe(true)) })
    await act(async () => paint({ x: 180, y: 300, zoom: 0.08 }))
    await act(async () => { await vi.waitFor(() => expect(dom.window.document.querySelector('.native-source-content')?.getAttribute('data-source-coverage-extend')).toBe('pan')) })
    expect(presented.some(view => view.zoom === 0.08 && view.x === 180)).toBe(true)
    expect(dom.window.document.querySelector('.native-source-surface')?.style.clipPath ?? '').toBe('')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    vi.unstubAllGlobals()
  }
})
