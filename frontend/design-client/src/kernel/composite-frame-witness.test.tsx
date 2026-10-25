// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { blank, node } from '../model'
import { ResidentCompositeSurface } from './ResidentCompositeSurface'
import { CompositeFrameWitness } from './composite-frame-witness'
import { visibleCompositeContributors, type CompositeCacheFrame, type CompositeCacheTile } from './composite-cache-use'
import { planTileAdmission } from './tile-admission'
import type { CompositeItem } from './gpu/tile-compositor'
import type { InteractionProps } from './interaction-layers'

// Real React parent/child layout order, actual ResidentCompositeSurface and
// PageTranslation. Only GPU transport and unrelated interaction/content work
// are controlled; these tests make no GPU or pixel-quality claim.
vi.mock('./content-plane', () => ({ registerContentPlane: () => () => {} }))
vi.mock('./interaction-renderer', () => ({ InteractionRenderer: class {
  tiles=[]; ready=false; lastSampleMs=0; lastSampleCompileMs=0; lastSampleGraphMs=0
  dispose() {} prepare() {} items() { return null }
} }))
const mounted: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of mounted) await dispose(); mounted.length = 0; vi.unstubAllGlobals() })

test('staged/abandoned render tokens and late prior callbacks cannot replace the committed complete frame', () => {
  const witness = new CompositeFrameWitness<{ camera: number; device: string; items: number[] }>()
  const first = {}, abandoned = {}, second = {}, a = { camera: 0, device: 'one', items: [1] },
    b = { camera: 10, device: 'two', items: [2] }
  witness.stage(first, a); expect(witness.current).toBeNull()
  witness.commit(first); expect(witness.current).toBe(a)
  witness.stage(abandoned, { camera: 99, device: 'abandoned', items: [99] })
  witness.stage(second, b); expect(witness.current).toBe(a)
  witness.commit(second); expect(witness.current).toBe(b)
  witness.stage(first, a); expect(witness.current).toBe(b)
  const moved = { ...b, items: [3] }
  witness.stage(second, moved); expect(witness.current).toBe(moved)
  witness.commit({}, null); expect(witness.current).toBeNull()
})

function harness() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLCanvasElement', 'Node', 'Event'])
    vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  HTMLCanvasElement.prototype.transferControlToOffscreen = vi.fn(() => ({} as OffscreenCanvas))
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  mounted.push(async () => { await act(async () => root.unmount()); dom.window.close() })
  const doc = blank(), board = node('frame', 0, 0, 200, 100)
  doc.nodes[board.id] = board; doc.pages[0].children = [board.id]
  const client = { attachPresentation: vi.fn(), present: vi.fn(), releasePresented: vi.fn(), presentationDiagnosticsEnabled: () => false }
  const deviceKey = 'worker/device/owner', witness = new CompositeFrameWitness<CompositeCacheFrame<CompositeCacheTile>>()
  const makeTile = (key: string, x: number, gpuTile: number): CompositeCacheTile => ({ key, x, y: 0,
    width: 100, height: 100, zoom: 1, gutter: 0, serial: gpuTile, gpuTile, bytes: new Uint8Array(),
    document: doc, revision: 1, residentDevice: { client, key: deviceKey } })
  const near = makeTile('near', 0, 1), translated = makeTile('translated', 100, 2), cold = makeTile('cold', 300, 3)
  const live = new Map([near, translated, cold].map(tile => [tile.key, tile])), ready = new Set(live.keys())
  const interaction: InteractionProps = { document: doc, selection: [board.id], active: false, epoch: 1,
    control: { current: null }, onReady() {} }
  const items = [near, translated, cold].map(tile => ({ tile, active: tile === near, gutter: 0, layer: 3 }))
  const stagedCallbacks: Array<(items: readonly CompositeItem[]) => void> = []
  const order: Array<{ phase: string; priorX: number | null }> = []
  function Parent({ x = 0 }: { x?: number }) {
    const owner = { document: doc, revision: 1, pageId: doc.pages[0].id, epoch: 0, backend: 'webgpu', client,
      resident: true, deviceKey, visible: true, view: { x, y: 0, zoom: 1 }, width: 100, height: 100, dpr: 2 }
    const queued = (actual: readonly CompositeItem[]) => {
      order.push({ phase: 'child', priorX: witness.current?.view.x ?? null })
      witness.stage(owner, { ...owner, items: actual.map(item => ({ ...item, tile: item.tile as CompositeCacheTile })) })
    }
    stagedCallbacks.push(queued)
    useLayoutEffect(() => { order.push({ phase: 'parent', priorX: witness.current?.view.x ?? null }); witness.commit(owner) })
    return <ResidentCompositeSurface client={client as any} items={items} view={owner.view} width={100} height={100} dpr={2}
      pageId={owner.pageId} rasterProfile="analytic" backend="webgpu" sourceDocument={doc} contentRevision={owner.revision} translationItems={items}
      allowPageTranslation interaction={interaction} settledDocument={doc} onReady={() => {}} onGone={() => {}}
      onFailure={message => { throw Error(message) }} presentation={null} onCompositeItems={queued}/>
  }
  return { doc, board, client, witness, near, translated, cold, live, ready, interaction, order, items, stagedCallbacks,
    render: async (x = 0) => { await act(async () => root.render(<Parent x={x}/>)) } }
}

test('actual imperative page translation protects only its transformed visible source under later delivery pressure', async () => {
  const h = harness(), original = JSON.stringify(h.doc)
  await h.render()
  expect(h.order.slice(0, 2).map(entry => entry.phase)).toEqual(['child', 'parent'])
  expect(h.order[0].priorX).toBeNull()
  const normal = h.witness.current!
  expect(visibleCompositeContributors(normal, normal, h.live, h.ready)).toEqual(new Set([h.near]))
  expect(h.interaction.control.current).not.toBeNull()
  await act(async () => {
    h.interaction.control.current!.apply(h.doc, { [h.board.id]: { transform: [1, 0, 0, 1, -100, 0] } })
  })
  const actual = h.witness.current!
  expect(actual).not.toBe(normal)
  const used = visibleCompositeContributors(actual, actual, h.live, h.ready)
  expect(used).toEqual(new Set([h.translated]))
  const incoming = { ...h.cold, key: 'new-delivery', gpuTile: 4, serial: 4 }
  const next = planTileAdmission(h.live, incoming, { budget: 80_000, used, held: [], pinned: key => key === incoming.key })
  expect([...next.map.keys()]).toEqual(['translated', 'new-delivery'])
  // The former ordinary-page witness would keep near and evict the moving
  // source: this is a negative control of the actual reported ownership.
  const former = planTileAdmission(h.live, incoming, { budget: 80_000,
    used: visibleCompositeContributors(normal, normal, h.live, h.ready), held: [], pinned: key => key === incoming.key })
  expect(former.map.has(h.translated.key)).toBe(false)
  expect(h.client.present.mock.calls.at(-1)![0].items.find((item: any) => item.tile.gpuTile === 2).placement.left).toBe(0)
  expect(JSON.stringify(h.doc)).toBe(original)
  h.translated.residentDevice = { client: h.client, key: 'replaced-device' }
  expect(visibleCompositeContributors(actual, actual, h.live, h.ready).size).toBe(0)
})

test('a new real parent/child layout commits its camera atomically and ignores a late old child callback', async () => {
  const h = harness()
  await h.render()
  const old = h.stagedCallbacks[0], first = h.witness.current!
  h.order.length = 0
  await h.render(-10)
  expect(h.order.slice(0, 2)).toEqual([{ phase: 'child', priorX: 0 }, { phase: 'parent', priorX: 0 }])
  const next = h.witness.current!
  expect(next).not.toBe(first); expect(next.view.x).toBe(-10); expect(next.dpr).toBe(2)
  old(h.items)
  expect(h.witness.current).toBe(next)
})
