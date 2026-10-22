import { expect, test, vi } from 'vitest'
import { NativeNavigationHandoff, reusableNativeNavigationPreview } from './native-navigation-handoff'
import { captureViewportPreview, viewportPreviewKey, type ViewportPreviewIdentity } from './viewport-preview-cache'
import { RenderMailbox } from './render-mailbox'

const identity = (): ViewportPreviewIdentity => ({ lane: 'navigation-preview', client: {}, document: {}, revision: 7,
  pageId: 'p', sessionEpoch: 9, dpr: 2, backend: 'webgpu', profile: 'figma', precision: 'four-phase-sdr',
  capability: undefined, width: 200, height: 160, view: { x: -0.25, y: 1.5, zoom: 64 } })
const device = '1/2/3'
function fixture() {
  const request = identity(), owner = new NativeNavigationHandoff(), capture = owner.start(request, device)
  const tile = { key: viewportPreviewKey(request), viewportPreview: true, gpuTile: 99,
    nativeNavigationDevice: device, viewportCache: { ...captureViewportPreview(request), device } }
  return { request, owner, capture, tile }
}

test('quiet/restart replaces one waiter without cancelling or changing the capture camera', () => {
  const f = fixture(), wakes = Array.from({ length: 60 }, () => vi.fn())
  for (const wake of wakes) {
    f.owner.stopWaiting()
    expect(f.owner.matching(f.request, device)).toBe(f.capture)
    expect(f.owner.wait(f.capture, wake)).toBe(true)
  }
  f.owner.finish(f.capture, true)
  expect(wakes.every(wake => wake.mock.calls.length === 0)).toBe(true)
  f.owner.wake(f.capture); f.owner.wake(f.capture)
  expect(wakes.slice(0, -1).every(wake => wake.mock.calls.length === 0)).toBe(true)
  expect(wakes.at(-1)).toHaveBeenCalledOnce()
  expect(f.owner.waitingFor(f.capture)).toBe(false)
  expect(f.capture.identity.view).toEqual(f.request.view)
  expect(f.capture.identity.view).not.toBe(f.request.view)
})
test('delivery failure wakes exactly once; invalidation drops stale callbacks', () => {
  const f = fixture(), wake = vi.fn()
  f.owner.wait(f.capture, wake); f.owner.finish(f.capture, false); f.owner.finish(f.capture, false)
  expect(wake).toHaveBeenCalledOnce(); expect(f.owner.matching(f.request, device)).toBeUndefined()
  const next = f.owner.start(f.request, device), stale = vi.fn()
  f.owner.wait(next, stale); f.owner.invalidate(); f.owner.finish(next, false); f.owner.wake(next)
  expect(stale).not.toHaveBeenCalled(); expect(f.owner.current).toBeUndefined()
})
test('an older completion cannot clear, deliver or wake the newer capture', () => {
  const f = fixture(), next = f.owner.start({ ...f.request, view: { ...f.request.view, x: 10 } }, device), wake = vi.fn()
  f.owner.wait(next, wake); f.owner.finish(f.capture, true); f.owner.wake(f.capture)
  expect(next.state).toBe('running'); expect(f.owner.current).toBe(next); expect(wake).not.toHaveBeenCalled()
})
test.each(['client', 'document', 'revision', 'pageId', 'sessionEpoch', 'dpr', 'backend', 'profile', 'precision',
  'capability', 'width', 'height', 'lane'] as const)('%s changes cannot wait for or reuse an old capture', field => {
  const f = fixture(), changed = { ...f.request }
  if (field === 'client' || field === 'document' || field === 'capability') Object.assign(changed, { [field]: {} })
  else if (field === 'lane') changed.lane = 'sequential-viewport'
  else Object.assign(changed, { [field]: typeof changed[field] === 'number' ? Number(changed[field]) + 1 : `${changed[field]}-new` })
  expect(f.owner.matching(changed, device)).toBeUndefined()
  expect(reusableNativeNavigationPreview(f.tile, changed, true, device)).toBe(false)
})
test.each(['x', 'y', 'zoom'] as const)('camera %s one ULP cannot promote an old frame', axis => {
  const f = fixture(), bits = new BigUint64Array(1), number = new Float64Array(bits.buffer)
  number[0] = f.request.view[axis]; bits[0]++
  const changed = { ...f.request, view: { ...f.request.view, [axis]: number[0] } }
  expect(f.owner.matching(changed, device)).toBeUndefined()
  expect(reusableNativeNavigationPreview(f.tile, changed, true, device)).toBe(false)
})
test('signed zero retains the original camera identity', () => {
  const f = fixture(), request = { ...f.request, view: { ...f.request.view, x: -0 } }
  f.owner.start(request, device)
  expect(f.owner.matching({ ...request, view: { ...request.view, x: 0 } }, device)).toBeUndefined()
})
test('readiness, actual device ACK and the device known at capture are all required', () => {
  const f = fixture()
  expect(reusableNativeNavigationPreview(f.tile, f.request, true, device)).toBe(true)
  expect(reusableNativeNavigationPreview(f.tile, f.request, false, device)).toBe(false)
  expect(reusableNativeNavigationPreview(f.tile, f.request, true, undefined)).toBe(false)
  expect(reusableNativeNavigationPreview(f.tile, f.request, true, '1/2/4')).toBe(false)
  expect(reusableNativeNavigationPreview({ ...f.tile, nativeNavigationDevice: undefined }, f.request, true, device)).toBe(false)
  expect(reusableNativeNavigationPreview({ ...f.tile, viewportCache: captureViewportPreview(f.request) }, f.request, true, device)).toBe(false)
  const unknown = f.owner.start(f.request, undefined)
  expect(f.owner.forIdentity(f.request)).toBe(unknown)
  expect(f.owner.matching(f.request, device)).toBeUndefined()
})
test('quiet discards all queued goals while the single running capture finishes normally', async () => {
  const mailbox = new RenderMailbox(), jobs: number[] = [], cancelled: number[] = []
  let active = true, latest = 0, finish!: () => void
  const first = mailbox.run(() => active, async () => { jobs.push(0); await new Promise<void>(resolve => { finish = resolve }) })
  await Promise.resolve()
  const queued = Array.from({ length: 60 }, (_, i) => {
    latest = i + 1
    return mailbox.run(() => active && latest === i + 1, async () => { jobs.push(i + 1) }).catch(() => { cancelled.push(i + 1) })
  })
  active = false; mailbox.discardSuperseded(); await Promise.all(queued)
  expect(cancelled).toHaveLength(60); expect(jobs).toEqual([0])
  finish(); await first
  expect(jobs).toEqual([0]); expect(cancelled).toHaveLength(60)
})
