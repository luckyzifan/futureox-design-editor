/** CPU-only scheduling contracts. Geometry bounds and the asynchronous raster
 * transport are explicit doubles; no pixels or GPU-quality results are asserted. */
import { afterEach, expect, test, vi } from 'vitest'
import { InteractionRenderer } from './interaction-renderer'
import type { DesignDocument } from '../model'
import type { InteractionProps } from './interaction-layers'

const transport = vi.hoisted(() => ({ jobs: [] as any[] }))
vi.mock('./client', () => ({ KernelClient: class {
  cancelPreview() {}
  dispose() {}
  render(_document: unknown, options: any) {
    return new Promise(resolve => transport.jobs.push({ options,
      resolve: () => resolve({ bytes: new Uint8Array(options.width * options.height * 4) }) }))
  }
} }))
vi.mock('../geometry', async original => ({
  ...await original<any>(),
  scene() { throw Error('Unexpected geometry path in density scheduling contract') },
  unionBounds() { throw Error('Unexpected geometry path in density scheduling contract') },
}))
vi.mock('./interaction-layers', async original => ({
  ...await original<any>(),
  planInteractionLayers: (document: unknown, pageId: string, ids: string[]) => ({ document, pageId, ids,
    layers: [{ document, bounds: { x: 0, y: 0, width: 2, height: 2 }, moving: 'selected' }] }),
  interactionOffsets: (plan: any, document: any) => new Map(plan.ids.map((id: string) => [id, {
    x: document.nodes[id].transform[4] - plan.document.nodes[id].transform[4],
    y: document.nodes[id].transform[5] - plan.document.nodes[id].transform[5],
  }])),
  interactionPatchedOffsets: (plan: any, _document: any, patches: any) => new Map(plan.ids.map((id: string) => [id, {
    x: patches[id].transform[4] - plan.document.nodes[id].transform[4],
    y: patches[id].transform[5] - plan.document.nodes[id].transform[5],
  }])),
  interactionPatchedDocument: (document: any) => document,
  pageBackdropPadding: () => 0,
}))
const owners: InteractionRenderer[] = []
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); transport.jobs.length = 0 })
function fixture(zoom: number, dpr: number) {
  const document = { id: 'synthetic-density-contract', nodes: {
    selected: { transform: [1, 0, 0, 1, 0, 0] },
  } } as unknown as DesignDocument
  const props: InteractionProps = { document, selection: ['selected'], active: false,
    epoch: 1, control: { current: null }, onReady() {} }
  const owner = new InteractionRenderer(() => {}); owners.push(owner)
  const prepare = (nextZoom = zoom, nextDpr = dpr) => owner.prepare(props, 'page',
    { x: 0, y: 0, zoom: nextZoom }, nextDpr, 'analytic', 'webgpu')
  prepare()
  return { owner, prepare, document }
}

test.each([1, 2])('31x to 32x refreshes retained drag pixels at DPR %i', async dpr => {
  const { owner, prepare, document } = fixture(31, dpr)
  expect(transport.jobs[0].options.view.zoom).toBe(31 * dpr)
  transport.jobs[0].resolve(); await vi.waitFor(() => expect(owner.ready).toBe(true))
  // Keep this density-only double on the retained integer-pixel fast path.
  // Fractional poses intentionally enter the separately tested live geometry path.
  owner.control.apply(document, { selected: { transform: [1, 0, 0, 1, 1, 1] } })
  prepare(32)
  expect(transport.jobs).toHaveLength(2)
  expect(transport.jobs[1].options.view.zoom).toBe(32 * dpr)
  transport.jobs[1].resolve()
  await vi.waitFor(() => expect(owner.tiles[0].zoom).toBe(32 * dpr))
  expect(owner.control.isActive()).toBe(true)
})

test('a 31x pending warm request cannot suppress the newer 32x capture', async () => {
  const { owner, prepare } = fixture(31, 2)
  prepare(32)
  expect(transport.jobs).toHaveLength(1)
  transport.jobs[0].resolve()
  await vi.waitFor(() => expect(transport.jobs).toHaveLength(2))
  expect(transport.jobs[1].options.view.zoom).toBe(64)
  transport.jobs[1].resolve(); await vi.waitFor(() => expect(owner.tiles[0].zoom).toBe(64))
})

test('a zoom storm keeps one active warm-up and one latest-density refresh', async () => {
  const { owner, prepare } = fixture(31, 2)
  for (let i = 1; i <= 200; i++) prepare(31 + i / 200)
  expect(transport.jobs).toHaveLength(1)
  transport.jobs[0].resolve()
  await vi.waitFor(() => expect(transport.jobs).toHaveLength(2))
  expect(transport.jobs[1].options.view.zoom).toBe(64)
  transport.jobs[1].resolve(); await vi.waitFor(() => expect(owner.tiles[0].zoom).toBe(64))
  expect(transport.jobs).toHaveLength(2)
})

test('a reversal cancels a queued higher-density warm-up', async () => {
  const { owner, prepare } = fixture(31, 2)
  prepare(32); prepare(30)
  transport.jobs[0].resolve(); await vi.waitFor(() => expect(owner.ready).toBe(true))
  expect(transport.jobs).toHaveLength(1)
})

test('identical pending native-density requests still coalesce', () => {
  const { prepare } = fixture(32, 2)
  prepare(); prepare()
  expect(transport.jobs).toHaveLength(1)
})

test('small DPR increases refresh retained native pixels without a 25 percent threshold', async () => {
  const { owner, prepare } = fixture(32, 1.75)
  transport.jobs[0].resolve(); await vi.waitFor(() => expect(owner.ready).toBe(true))
  prepare(32, 2)
  expect(transport.jobs).toHaveLength(2)
  expect(transport.jobs[1].options.view.zoom).toBe(64)
})

test('low-zoom navigation keeps its bounded hysteresis policy', async () => {
  const { owner, prepare } = fixture(.2, 1)
  transport.jobs[0].resolve(); await vi.waitFor(() => expect(owner.ready).toBe(true))
  prepare(.21)
  expect(transport.jobs).toHaveLength(1)
})

test('zooming out reuses a sharper retained layer', async () => {
  const { owner, prepare } = fixture(32, 2)
  transport.jobs[0].resolve(); await vi.waitFor(() => expect(owner.ready).toBe(true))
  prepare(31)
  expect(transport.jobs).toHaveLength(1)
})
