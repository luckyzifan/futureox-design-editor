import { afterEach, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { blank } from '../model'
import { KernelClient } from './client'
import { BitmapRetirement } from './bitmap-retirement'
import { PageResidencyCache } from './page-residency-cache'
import { PresentationOwnership } from './presentation-ownership'
import { NativeNavigationHandoff } from './native-navigation-handoff'
import { viewportPreviewKey, type ViewportPreviewIdentity } from './viewport-preview-cache'
import { estimatedTileResidencyBytes } from './page-memory-policy'
import { isTileAdmissionBudgetError, planTileAdmission, retireRejectedTile, HandledTileDeliveryError,
  replacementTileBudget, tileAdmissionDiagnostic } from './tile-admission'

// Run the production receiving closure, not a copied commit implementation.
// Controlled transport/readiness do not establish GPU or browser performance.
const surface = readFileSync(new URL('./ProgressiveSurface.tsx', import.meta.url), 'utf8')
const receiveSource = surface.slice(surface.indexOf('    const receive = (tile:'), surface.indexOf('    const previewIdentity ='))
const bindings = ['sameContent', 'recordRenderDiagnostic', 'view', 'dpr', 'renderScale', 'rasterTrace', 'doc', 'contract', 'hdrCompositing',
  'serial', 'overviewKeys', 'navigationTiming', 'setStats', 'compositeCacheFrame', 'displayed', 'displayBudget',
  'residencyBudget', 'compositeCacheUse', 'tileRef', 'protectedKeys', 'coverageRetention', 'pageResidency',
  'heldDisplay', 'bitmapRetirement', 'c', 'ready', 'failedTiles', 'presentationOwnership', 'setTiles',
  'planTileAdmission', 'retireRejectedTile', 'HandledTileDeliveryError', 'estimatedTileResidencyBytes',
  'current', 'desired', 'width', 'height', 'residentDisplay', 'replacementTileBudget', 'tileAdmissionDiagnostic', 'cacheAdmission',
  'nativeNavigation', 'nativeNavigationHandoff', 'viewportPreviewKey', 'latestContext']
const receiveFactory = new Function('context', `const {${bindings.join(',')}} = context;
  ${stripTypeScriptTypes(receiveSource.replaceAll('import.meta.env.DEV', 'false'))}; return receive`)
function tile(key: string, gpuTile: number, side = 2) {
  return { key, gpuTile, x: 0, y: 0, width: side, height: side, zoom: 1,
    bytes: new Uint8Array(), bitmap: { close: vi.fn() } as unknown as ImageBitmap,
    backend: 'webgpu', description: '', milliseconds: 0, cached: false }
}
function harness() {
  const a = tile('A', 1), b = tile('B', 2), cold = tile('cold', 3), doc = blank()
  const tileRef = { current: new Map([a, b, cold].map(value => [value.key, value])) }
  const ready = { current: new Set(tileRef.current.keys()) }, failedTiles = { current: new Set(['A']) }
  const bitmapRetirement = new BitmapRetirement()
  const pageResidency = new PageResidencyCache<ReturnType<typeof tile>>(64, 2,
    value => bitmapRetirement.retire([value], tileRef.current.values()), estimatedTileResidencyBytes)
  const inactive = tile('inactive', 40); pageResidency.store('other', [inactive], 16)
  const c = { releasePresented: vi.fn() }, setTiles = vi.fn()
  const context = { sameContent: () => true, recordRenderDiagnostic: vi.fn(), view: { x: 0, y: 0, zoom: 1 },
    dpr: 1, renderScale: 1, hdrCompositing: false, rasterTrace: { current: [] }, doc, contract: { revision: 1 }, serial: { current: 3 },
    overviewKeys: { current: new Set() }, navigationTiming: { current: { firstDetailMs: 0 } }, setStats: vi.fn(),
    compositeCacheFrame: { current: null }, displayed: null, displayBudget: 48, residencyBudget: 64,
    compositeCacheUse: () => new Set(), tileRef, protectedKeys: { current: new Set(['A', 'B']) },
    coverageRetention: { current: { has: () => false } }, pageResidency, heldDisplay: { current: null },
    bitmapRetirement, c, ready, failedTiles, presentationOwnership: { current: new PresentationOwnership() }, setTiles,
    planTileAdmission, retireRejectedTile, HandledTileDeliveryError, estimatedTileResidencyBytes,
    current: () => true, desired: { current: ['A', 'B', 'C', 'D'] }, width: 100, height: 100, residentDisplay: true,
    replacementTileBudget, tileAdmissionDiagnostic,
    nativeNavigation: false, nativeNavigationHandoff: new NativeNavigationHandoff(), viewportPreviewKey,
    latestContext: { current: { view: { x: 0, y: 0, zoom: 1 } } },
    cacheAdmission: { current: { reserveBytes: 0, admissionBudget: 0, activeHighWater: 0, totalHighWater: 0 } } }
  return { a, b, cold, inactive, context, receive: receiveFactory(context) as (incoming: ReturnType<typeof tile>) => void }
}
function rejectedReceive(h: ReturnType<typeof harness>, incoming: ReturnType<typeof tile>) {
  try { h.receive(incoming); throw Error('Expected admission failure') }
  catch (error) { expect(error).toBeInstanceOf(HandledTileDeliveryError); expect(isTileAdmissionBudgetError(error)).toBe(true); return error }
}

test('failed same-key admission preserves live map, ready keys and every earlier bitmap after tentative eviction', () => {
  const h = harness(), { context: c } = h, before = c.tileRef.current, readiness = new Set(c.ready.current)
  const incoming = tile('A', 5, 4), close = incoming.bitmap!.close
  rejectedReceive(h, incoming)
  expect(c.tileRef.current).toBe(before); expect([...before.values()]).toEqual([h.a, h.b, h.cold])
  expect(c.ready.current).toEqual(readiness); expect(c.failedTiles.current).toEqual(new Set(['A']))
  for (const old of [h.a, h.b, h.cold, h.inactive]) expect(old.bitmap!.close).not.toHaveBeenCalled()
  expect(c.pageResidency.values()).toEqual([h.inactive]); expect(c.pageResidency.evictions).toBe(0)
  expect(c.setTiles).not.toHaveBeenCalled(); expect(c.presentationOwnership.current.size).toBe(0)
  expect(close).toHaveBeenCalledOnce(); expect(c.c.releasePresented).toHaveBeenCalledExactlyOnceWith([5])
})

test('only the current exact-camera native waiter may borrow the existing bounded replacement reserve', () => {
  const h = harness(), c = h.context
  c.nativeNavigation = true; c.current = () => false; c.desired.current = []
  const identity: ViewportPreviewIdentity = { lane: 'navigation-preview', client: c.c, document: c.doc,
    revision: 1, pageId: 'p', sessionEpoch: 1, dpr: 1, backend: 'webgpu', profile: 'figma', precision: 'four-phase',
    capability: undefined, width: 100, height: 100, view: { x: 0, y: 0, zoom: 1 } }
  const capture = c.nativeNavigationHandoff.start(identity, '1/2/3')
  c.nativeNavigationHandoff.wait(capture, vi.fn())
  const incoming = { ...tile(viewportPreviewKey(identity), 5), viewportPreview: true }
  expect(() => receiveFactory(c)(incoming)).not.toThrow()
  expect(c.cacheAdmission.current.reserveBytes).toBe(16)
  expect(c.cacheAdmission.current.admissionBudget).toBe(64)
  c.nativeNavigationHandoff.stopWaiting()
  expect(() => receiveFactory(c)({ ...tile(viewportPreviewKey(identity), 6, 4), viewportPreview: true })).not.toThrow()
  expect(c.cacheAdmission.current.reserveBytes).toBe(0)
  expect(c.cacheAdmission.current.admissionBudget).toBe(48)
})

test('an incoming optional capture evicted by bounded admission is not reported as a delivered handoff', () => {
  const h = harness(), c = h.context
  c.displayBudget = 32; c.residencyBudget = 32; c.current = () => false; c.desired.current = []
  const incoming = { ...tile('optional-history', 5), viewportPreview: true }, close = incoming.bitmap!.close
  expect(receiveFactory(c)(incoming)).toBeUndefined()
  expect(c.tileRef.current.has(incoming.key)).toBe(false)
  expect(close).toHaveBeenCalledOnce()
})

test('a later rejected delivery keeps a previously admitted and acknowledged new tile', () => {
  const h = harness(), { context: c } = h, accepted = tile('C', 6)
  c.protectedKeys.current.add('C'); h.receive(accepted)
  c.ready.current.add('C') // Controlled presenter acknowledgement of that actual delivery.
  const committed = c.tileRef.current, value = committed.get('C'), oldCalls = c.setTiles.mock.calls.length
  c.protectedKeys.current.add('D'); const incoming = tile('D', 7, 3)
  rejectedReceive(h, incoming)
  expect(c.tileRef.current).toBe(committed); expect(committed.get('C')).toBe(value)
  expect(c.ready.current).toEqual(new Set(['A', 'B', 'cold', 'C'])); expect(c.setTiles).toHaveBeenCalledTimes(oldCalls)
  expect(value!.bitmap!.close).not.toHaveBeenCalled(); expect(c.presentationOwnership.current.size).toBe(1)
  expect(c.c.releasePresented).toHaveBeenCalledExactlyOnceWith([7])
})

test('rejected aliases keep existing GPU and bitmap owners, including inactive and held owners', () => {
  for (const survivor of ['active', 'inactive', 'held'] as const) {
    const h = harness(), { context: c } = h
    const owner = survivor === 'inactive' ? h.inactive : h.a
    const incoming = { ...tile('A', owner.gpuTile, 4), bitmap: owner.bitmap }
    if (survivor === 'held') (c.heldDisplay as any).current = { residents: new Map([[owner.key, owner]]) }
    const bitmap = owner.bitmap
    rejectedReceive(h, incoming)
    expect(c.tileRef.current.get('A')).toBe(h.a); expect(c.ready.current.has('A')).toBe(true)
    expect(owner.bitmap).toBe(bitmap); expect(bitmap!.close).not.toHaveBeenCalled()
    expect(c.c.releasePresented).not.toHaveBeenCalled()
  }
})

test('bounded retry after pressure rejection can admit replacement without changing the byte allowance', () => {
  const h = harness(), { context: c } = h
  rejectedReceive(h, tile('A', 5, 4))
  const replacement = tile('A', 8)
  h.receive(replacement)
  expect(c.tileRef.current.get('A')?.gpuTile).toBe(8)
  expect(c.ready.current).toEqual(new Set(['B', 'cold']))
  expect(estimatedTileResidencyBytes(c.tileRef.current.values())).toBe(48)
  expect(c.displayBudget).toBe(48); expect(c.pageResidency.bytes).toBe(16)
  expect(h.a.bitmap).toBeUndefined(); expect(h.b.bitmap!.close).not.toHaveBeenCalled()
  expect(c.presentationOwnership.current.size).toBe(1)
})

test('successful active admission trims inactive pressure only after publishing its new payload owner', () => {
  const h = harness(), { context: c } = h, shared = h.inactive.bitmap!
  const incoming = { ...tile('C', 12), bitmap: shared }
  c.protectedKeys.current.add('C'); c.pageResidency.limit = 0
  h.receive(incoming)
  expect(c.pageResidency.size).toBe(0); expect(c.pageResidency.evictions).toBe(1)
  expect(c.tileRef.current.get('C')!.bitmap).toBe(shared)
  expect(shared.close).not.toHaveBeenCalled(); expect(c.setTiles).toHaveBeenCalledOnce()
})

test.each([false, true])('stale document delivery retires only unshared incoming resources (alias=%s)', alias => {
  const h = harness(), { context: c } = h, incoming = tile('stale', alias ? 1 : 13)
  c.sameContent = () => false
  if (alias) incoming.bitmap = h.a.bitmap
  const bitmap = incoming.bitmap!
  // Factory bindings deliberately capture the current document predicate.
  receiveFactory(c)(incoming)
  expect(bitmap.close).toHaveBeenCalledTimes(alias ? 0 : 1)
  expect(c.c.releasePresented.mock.calls).toEqual(alias ? [] : [[[13]]])
  expect(c.ready.current).toEqual(new Set(['A', 'B', 'cold'])); expect(c.setTiles).not.toHaveBeenCalled()
})

test('foreground replacement borrows existing total room and inactive pages yield before the accepted state is published', () => {
  const h = harness(), { context: c } = h, incoming = tile('A', 23, 3)
  h.receive(incoming)
  expect(c.tileRef.current.get('A')?.gpuTile).toBe(23)
  expect(c.cacheAdmission.current.reserveBytes).toBe(16)
  expect(c.cacheAdmission.current.admissionBudget).toBe(64)
  expect(c.cacheAdmission.current.activeHighWater).toBe(52)
  expect(c.cacheAdmission.current.totalHighWater).toBeLessThanOrEqual(64)
  expect(c.pageResidency.size).toBe(0); expect(c.pageResidency.evictions).toBe(1)
  expect(estimatedTileResidencyBytes(c.tileRef.current.values())).toBe(52)
})

test.each(['stale', 'prefetch'] as const)('a rejected optional %s delivery cannot cancel the foreground request', kind => {
  const h = harness(), { context: c } = h
  if (kind === 'stale') c.current = () => false
  const incoming = { ...tile('A', 24, 4), ...(kind === 'prefetch' ? { prefetch: true as const } : {}) }
  const bitmap = incoming.bitmap!, receive = receiveFactory(c)
  expect(() => receive(incoming)).not.toThrow()
  expect(c.tileRef.current.get('A')).toBe(h.a); expect(c.ready.current.has('A')).toBe(true)
  expect(c.cacheAdmission.current.reserveBytes).toBe(0)
  expect(bitmap.close).toHaveBeenCalledOnce(); expect(c.c.releasePresented).toHaveBeenCalledExactlyOnceWith([24])
})

class WorkerStub {
  static instances: WorkerStub[] = []
  messages: any[] = []
  onmessage?: (event: { data: any }) => void
  onerror?: unknown
  constructor() { WorkerStub.instances.push(this) }
  postMessage(message: unknown) { this.messages.push(message) }
  terminate() {}
}
afterEach(() => { vi.unstubAllGlobals(); WorkerStub.instances.length = 0 })
function clientHarness(progress: (incoming: any) => void) {
  vi.stubGlobal('Worker', WorkerStub)
  const client = new KernelClient(), doc = blank(), worker = WorkerStub.instances[0]
  const promise = client.render(doc, { pageId: doc.pages[0].id, width: 2, height: 2,
    view: { x: 0, y: 0, zoom: 1 }, transparent: false, grid: false, tileViewport: [] },
  false, 'cpu', false, false, undefined, progress).catch(error => error)
  return { client, worker, promise, deliver(incoming: ReturnType<typeof tile>) {
    worker.onmessage?.({ data: { id: worker.messages[0].id, tile: { ...incoming, bitmap: undefined }, tileBitmap: incoming.bitmap } })
  } }
}

test.each([false, true])('streamed rejection cleans a new payload once and never retires a live alias (alias=%s)', async alias => {
  const h = harness(), incoming = tile('A', alias ? 1 : 9, 4), bitmap = alias ? h.a.bitmap! : incoming.bitmap!
  incoming.bitmap = bitmap
  const transport = clientHarness(h.receive)
  // The production closure and real client use the same resource owner.
  h.context.c.releasePresented = vi.fn((ids: number[]) => transport.client.releasePresented(ids))
  try {
    transport.deliver(incoming)
    const error = await transport.promise
    expect(error).toBeInstanceOf(HandledTileDeliveryError); expect(isTileAdmissionBudgetError(error)).toBe(true)
    expect(bitmap.close).toHaveBeenCalledTimes(alias ? 0 : 1)
    const releases = transport.worker.messages.filter(message => message.command === 'display-release')
    expect(releases.map(message => message.ids)).toEqual(alias ? [] : [[9]])
    expect(h.context.ready.current.has('A')).toBe(true)
  } finally { transport.client.dispose() }
})

test('unhandled progress failure retains ordinary transport cleanup and request rejection', async () => {
  const failure = Error('synthetic callback failure'), transport = clientHarness(() => { throw failure })
  const incoming = tile('new', 11), bitmap = incoming.bitmap!
  try {
    transport.deliver(incoming)
    expect(await transport.promise).toBe(failure); expect(bitmap.close).toHaveBeenCalledOnce()
    expect(transport.worker.messages.filter(message => message.command === 'display-release').map(message => message.ids)).toEqual([[11]])
    const late = tile('late', 12), lateBitmap = late.bitmap!
    transport.deliver(late)
    expect(lateBitmap.close).toHaveBeenCalledOnce()
    expect(transport.worker.messages.filter(message => message.command === 'display-release').map(message => message.ids)).toEqual([[11], [12]])
  } finally { transport.client.dispose() }
})

test.each(['inactive-trim', 'retired-bitmap'] as const)('post-admission %s failure publishes the accepted map and cannot retire its incoming payload', async stage => {
  const h = harness(), incoming = tile('A', 21), bitmap = incoming.bitmap!, failure = Error(`synthetic ${stage} failure`)
  if (stage === 'inactive-trim') h.context.pageResidency.trim = vi.fn(() => { throw failure })
  else h.a.bitmap!.close = vi.fn(() => { throw failure })
  const transport = clientHarness(h.receive)
  h.context.c.releasePresented = vi.fn((ids: number[]) => transport.client.releasePresented(ids))
  try {
    transport.deliver(incoming)
    const error = await transport.promise
    expect(error).toBeInstanceOf(HandledTileDeliveryError); expect(error.cause).toBe(failure)
    expect(h.context.tileRef.current.get('A')?.gpuTile).toBe(21)
    expect(h.context.setTiles).toHaveBeenCalledExactlyOnceWith(h.context.tileRef.current)
    expect(h.context.presentationOwnership.current.size).toBe(1)
    expect(bitmap.close).not.toHaveBeenCalled(); expect(h.context.c.releasePresented).not.toHaveBeenCalled()
    expect(transport.worker.messages.filter(message => message.command === 'display-release')).toEqual([])
  } finally { transport.client.dispose() }
})
