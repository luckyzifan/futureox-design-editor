// @ts-expect-error jsdom runtime dependency
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'

const calls = vi.hoisted(() => ({ requests: 0, attached: 0, presented: 0, frames: 0 }))
vi.mock('./client', () => ({
  backendPreference: () => 'cpu',
  renderExecutionPolicy: { desktopFullMath: true, desktopDisplay: true, cpuOnly: true, hdrCompositing: false },
  KernelClient: class {
    onPresentation?: unknown
    renderSource(_source: unknown, options: { tileViewport?: { key: string; x: number; y: number; width: number; height: number; zoom: number; gutter?: number }[] }, progress?: (tile: object) => void) {
      calls.requests++
      const tile = options.tileViewport?.[0]
      if (!tile) return Promise.resolve({ bytes: new Uint8Array() })
      progress?.({
        ...tile,
        bytes: new Uint8Array(tile.width * tile.height * 4),
        bitmap: { close() {} },
        backend: 'cpu',
        description: 'cpu tile',
        milliseconds: 1,
        cached: false,
      })
      return Promise.resolve({ bytes: new Uint8Array() })
    }
    attachPresentation() { calls.attached++ }
    present() { calls.presented++ }
    releasePresented() {}
    dispose() {}
  },
}))
vi.mock('./presentation', () => ({ useDevicePixelRatio: () => 1 }))
vi.mock('./tile-plan-aligned', () => ({
  planTilesWithPrefetchRim: (_bounds: unknown, zoom: number) => ({
    viewport: [{ key: `tile:${zoom}`, x: 0, y: 0, width: 514, height: 514, zoom, gutter: 1 }],
    rim: [],
    cacheLimitSkipped: 0,
  }),
}))

import { NativeSourceSurface, type NativeSourceStatus } from './NativeSourceSurface'
import type { SourceCanvasSnapshot } from '../desktop'

test('cpu-only source overview draws bitmap tiles without a gpu texture or a full-frame attach', async () => {
  const dom = new JSDOM('<div id="root"></div>')
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
  try {
    calls.requests = 0
    calls.attached = 0
    calls.presented = 0
    await act(async () => root.render(<NativeSourceSurface source={source} view={{ x: 12, y: 8, zoom: 0.05 }} width={800} height={600} onStatus={status => statuses.push(status)} />))
    expect(calls.attached).toBe(0)
    expect(calls.presented).toBe(0)
    expect(calls.requests).toBeGreaterThanOrEqual(2)
    expect(statuses.some(status => status.phase === 'error')).toBe(false)
    expect(statuses.at(-1)).toMatchObject({ phase: 'ready', done: 1, total: 1 })
    expect(dom.window.document.querySelector('.kernel-status')?.textContent).toBe('CPU · 已显示')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    vi.unstubAllGlobals()
  }
})
