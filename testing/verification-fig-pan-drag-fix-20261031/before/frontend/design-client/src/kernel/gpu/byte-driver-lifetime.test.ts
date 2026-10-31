import { afterEach, expect, test, vi } from 'vitest'
import { WebGpuDriver } from './webgpu'
import { ByteTentPrefix, ByteTentPrefixLease, planByteTentPrefix, type ByteTentOptions } from './byte-tent-prefix'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers() })
const options = (): ByteTentOptions => ({ radius: 1920, axis: 0,
  source: { x: -1927, y: -2567, w: 3918, h: 2633 }, output: { x: -2, y: -2567, w: 68, h: 2633 } })
function fixture(managed = false) {
  vi.stubEnv('VITE_DESIGN_BYTE_TENT_PREFIX', '1'); vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', '1')
  vi.stubGlobal('OffscreenCanvas', class { width = 1; height = 1 })
  vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16, COPY_SRC: 1, COPY_DST: 2 })
  vi.stubGlobal('GPUBufferUsage', { STORAGE: 128, VERTEX: 32, COPY_SRC: 4, COPY_DST: 8 })
  const encoders: any[] = [], waits: { resolve: () => void; reject: (error: Error) => void }[] = []
  const newEncoder = () => {
    const encoder = { finish: vi.fn(() => ({ encoder })), beginRenderPass: vi.fn(() => ({ end: vi.fn() })) }
    encoders.push(encoder); return encoder
  }
  const device = {
    limits: { maxTextureDimension2D: 16384 },
    queue: { submit: vi.fn(), writeBuffer: vi.fn(), onSubmittedWorkDone: vi.fn(() => new Promise<void>((resolve, reject) => waits.push({ resolve, reject }))) },
    createTexture: vi.fn((d: any) => ({ width: d.size[0], height: d.size[1], format: d.format, usage: d.usage,
      sampleCount: 1, dimension: '2d', depthOrArrayLayers: 1, createView: () => ({}), destroy: vi.fn() })),
    createBuffer: vi.fn((d: any) => ({ size: d.size, destroy: vi.fn() })),
    createCommandEncoder: vi.fn(newEncoder), destroy: vi.fn(), pushErrorScope: vi.fn(), popErrorScope: vi.fn(async () => null),
  }
  const driver = new WebGpuDriver(managed) as any
  Object.assign(driver, { device, encoder: newEncoder(), resourceEpoch: 5, completedResourceEpoch: 4 })
  const allocated: { lease: ByteTentPrefixLease; destroy: ReturnType<typeof vi.fn> }[] = []
  const pipeline = { encode: vi.fn((_encoder: unknown, _source: unknown, _target: unknown, input: ByteTentOptions) => {
    const destroy = vi.fn(), lease = new ByteTentPrefixLease(planByteTentPrefix(input)!, [{ destroy } as any])
    allocated.push({ lease, destroy }); return lease
  }) }
  const prepare = vi.spyOn(ByteTentPrefix, 'create').mockResolvedValue(pipeline as unknown as ByteTentPrefix)
  const p = options(), source = driver.create(p.source.w, p.source.h), target = driver.create(p.output.w, p.output.h)
  const encode = () => driver.encodeByteTentAlpha(target, source, p, 4 * 1024 * 1024)
  return { driver, device, encoders, waits, pipeline, prepare, allocated, source, target, p, encode }
}

test.each(['missing-byte', 'false-byte', 'missing-clamp', 'false-clamp', 'managed'] as const)('the %s gate declines before pipeline allocation or recording', async gate => {
  const f = fixture(gate === 'managed')
  if (gate === 'missing-byte') vi.stubEnv('VITE_DESIGN_BYTE_TENT_PREFIX', undefined)
  if (gate === 'false-byte') vi.stubEnv('VITE_DESIGN_BYTE_TENT_PREFIX', 'true')
  if (gate === 'missing-clamp') vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', undefined)
  if (gate === 'false-clamp') vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', 'true')
  expect(await f.driver.prepareByteTent()).toBe(false); expect(f.encode()).toBe(false)
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.pipeline.encode).not.toHaveBeenCalled(); expect(f.driver.scratchBytes).toBe(0)
})
test('preparation is coalesced, retryable on failure and owns no hidden scratch', async () => {
  const f = fixture()
  f.prepare.mockRejectedValueOnce(Error('pipeline failed'))
  await expect(f.driver.prepareByteTent()).rejects.toThrow('pipeline failed')
  expect(f.driver.scratchBytes).toBe(0)
  expect(await Promise.all([f.driver.prepareByteTent(), f.driver.prepareByteTent()])).toEqual([true, true])
  expect(f.prepare).toHaveBeenCalledTimes(2); expect(f.driver.scratchBytes).toBe(0)
})
test.each(['unprepared', 'foreign', 'resource-changed', 'destroyed', 'alias', 'format', 'dimensions', 'samples', 'usage', 'fractional', 'budget'] as const)('%s rejection changes no encoder, target proof or scratch', async mode => {
  const f = fixture()
  if (mode !== 'unprepared') await f.driver.prepareByteTent()
  let source = f.source, target = f.target, p = f.p, available = 4 * 1024 * 1024
  if (mode === 'foreign') source = { ...source }
  if (mode === 'resource-changed') source.resource = { ...source.resource }
  if (mode === 'destroyed') f.driver.destroy(source)
  if (mode === 'alias') target = source
  if (mode === 'format') source.resource.format = 'r8unorm'
  if (mode === 'dimensions') source.resource.width--
  if (mode === 'samples') source.resource.sampleCount = 4
  if (mode === 'usage') source.resource.usage = 0
  if (mode === 'fractional') p = { ...p, radius: 1920.25 }
  if (mode === 'budget') available = planByteTentPrefix(p)!.bytes - 1
  target.finitePixels = true
  const old = f.driver.encoder, close = vi.spyOn(f.driver, 'closeOver')
  expect(f.driver.encodeByteTentAlpha(target, source, p, available)).toBe(false)
  expect(f.driver.encoder).toBe(old); expect(close).not.toHaveBeenCalled()
  expect(target.finitePixels).toBe(true); expect(f.pipeline.encode).not.toHaveBeenCalled(); expect(f.driver.scratchBytes).toBe(0)
})
test.each(['complete', 'reject', 'device-change', 'lost'])('raster queue pacing %s never retires live frame scratch', async outcome => {
  const f = fixture(); await f.driver.prepareByteTent(); f.encode()
  const bytes = f.driver.scratchBytes
  const pending = f.driver.yieldRasterQueue()
  const assertion = outcome === 'complete' ? expect(pending).resolves.toBeUndefined() : expect(pending).rejects.toThrow()
  expect(f.device.queue.submit).toHaveBeenCalledOnce()
  expect(f.driver.scratchBytes).toBe(bytes)
  if (outcome === 'device-change') f.driver.device = { ...f.device }
  if (outcome === 'lost') f.driver.lost = true
  if (outcome === 'reject') f.waits[0].reject(Error('queue rejected'))
  else f.waits[0].resolve()
  await assertion
  expect(f.driver.resourceEpoch).toBe(5)
  expect(f.driver.completedResourceEpoch).toBe(4)
  expect(f.driver.scratchBytes).toBe(bytes)
  expect(f.allocated.every(x => !x.destroy.mock.calls.length)).toBe(true)
})

test('multiple axis jobs are charged and submitted together; a rejected completion preserves every lease', async () => {
  const f = fixture(); await f.driver.prepareByteTent()
  expect(f.encode()).toBe(true); expect(f.encode()).toBe(true)
  const bytes = f.allocated.reduce((sum, x) => sum + x.lease.bytes, 0)
  expect(f.driver.scratchBytes).toBe(bytes); expect(f.driver.frameScratchBytes).toBe(bytes)
  const first = f.driver.checkpoint('admission')
  expect(f.device.queue.submit).toHaveBeenCalledOnce(); expect(f.allocated.every(x => !x.destroy.mock.calls.length)).toBe(true)
  f.waits[0].reject(Error('uncertain queue'))
  await expect(first).rejects.toThrow('uncertain queue')
  expect(f.driver.scratchBytes).toBe(bytes)
  const retry = f.driver.checkpoint('admission'); f.waits[1].resolve(); await retry
  expect(f.driver.scratchBytes).toBe(0); expect(f.allocated.every(x => x.destroy.mock.calls.length === 1)).toBe(true)
})
test('an old completed-pool hint cannot retire newly submitted byte scratch', async () => {
  const f = fixture(); await f.driver.prepareByteTent(); f.encode()
  const bytes = f.driver.scratchBytes
  await f.driver.checkpoint('admission', undefined, 4)
  expect(f.waits).toHaveLength(0); expect(f.driver.scratchBytes).toBe(bytes)
  const actual = f.driver.checkpoint('admission'); f.waits[0].resolve(); await actual
  expect(f.driver.scratchBytes).toBe(0)
})
test('a covered checkpoint snapshot cannot free a later encoder generation', async () => {
  const f = fixture(); await f.driver.prepareByteTent(); f.encode()
  const first = f.driver.checkpoint('admission')
  f.encode(); const laterBytes = f.allocated[1].lease.bytes
  f.driver.submitCommands()
  f.waits[0].resolve(); await first
  expect(f.allocated[0].destroy).toHaveBeenCalledOnce(); expect(f.allocated[1].destroy).not.toHaveBeenCalled()
  expect(f.driver.scratchBytes).toBe(laterBytes)
  const next = f.driver.checkpoint(); f.waits[1].resolve(); await next
  expect(f.driver.scratchBytes).toBe(0)
})
test('a partial encode abandons the whole encoder and poisons submission until an explicit restart', async () => {
  const f = fixture(); await f.driver.prepareByteTent(); f.encode()
  const old = f.driver.encoder
  f.pipeline.encode.mockImplementationOnce(() => { throw Error('partial byte commands') })
  expect(f.encode).toThrow('partial byte commands')
  expect(f.driver.encoder).not.toBe(old); expect(old.finish).not.toHaveBeenCalled()
  expect(f.allocated[0].destroy).toHaveBeenCalledOnce(); expect(f.driver.scratchBytes).toBe(0)
  expect(() => f.driver.submitCommands()).toThrow('restart the frame')
  expect(f.device.queue.submit).not.toHaveBeenCalled()
  f.driver.begin(new Float32Array(0))
  expect(f.encode()).toBe(true)
})
test('uncertain submit keeps bytes and cancellation discards only the unsubmitted generation', async () => {
  const f = fixture(); await f.driver.prepareByteTent(); f.encode()
  const bytes = f.driver.scratchBytes
  f.device.queue.submit.mockImplementationOnce(() => { throw Error('submit uncertain') })
  expect(() => f.driver.submitCommands()).toThrow('submit uncertain')
  expect(f.driver.scratchBytes).toBe(bytes); expect(f.allocated[0].destroy).not.toHaveBeenCalled()
  expect(f.encode).toThrow('restart the frame')
  // A restarted encoder may record another job before cancellation.
  f.driver.begin(new Float32Array(0)); f.encode()
  const cancel = f.driver.abortFrameAndReleaseFilterScratch('cancel')
  expect(f.allocated[1].destroy).toHaveBeenCalledOnce(); expect(f.allocated[0].destroy).not.toHaveBeenCalled()
  f.waits[0].reject(Error('cancel fence failed')); await expect(cancel).rejects.toThrow('cancel fence failed')
  expect(f.driver.scratchBytes).toBe(bytes)
  const retry = f.driver.abortFrameAndReleaseFilterScratch('cancel'); f.waits[1].resolve(); await retry
  expect(f.driver.scratchBytes).toBe(0)
})
test('submitPending includes a byte-only encoder even with an empty shared uniform arena', async () => {
  const f = fixture(); await f.driver.prepareByteTent(); f.encode()
  expect(f.driver.offset).toBe(0)
  f.driver.submitPending(); expect(f.device.queue.submit).toHaveBeenCalledOnce()
  expect(() => f.allocated[0].lease.discardUnsubmitted()).toThrow('already retiring')
})
test('an encoder finish failure abandons unsubmitted byte scratch and prohibits continuing the partial frame', async () => {
  const f = fixture(); await f.driver.prepareByteTent(); f.encode()
  const old = f.driver.encoder
  old.finish.mockImplementationOnce(() => { throw Error('encoder invalid') })
  expect(() => f.driver.submitCommands()).toThrow('encoder invalid')
  expect(f.driver.encoder).not.toBe(old); expect(f.driver.scratchBytes).toBe(0)
  expect(f.allocated[0].destroy).toHaveBeenCalledOnce(); expect(f.device.queue.submit).not.toHaveBeenCalled()
  expect(f.encode).toThrow('restart the frame')
})
test('finish submits its own encoder, fences byte scratch, and only then changes its ledger', async () => {
  const f = fixture(); await f.driver.prepareByteTent(); f.encode()
  const old = f.driver.encoder, bytes = f.driver.scratchBytes
  const finished = f.driver.finish(f.target, f.p.output, f.p.output.w, f.p.output.h, false, undefined, false)
  expect(old.finish).toHaveBeenCalledOnce(); expect(f.device.queue.submit).toHaveBeenCalledOnce()
  expect(f.driver.scratchBytes).toBe(bytes); f.waits[0].resolve(); await finished
  expect(f.driver.scratchBytes).toBe(0); expect(f.allocated[0].destroy).toHaveBeenCalledOnce()
})
test('a rejected finish completion retains submitted scratch until a later covered abort', async () => {
  const f = fixture(); await f.driver.prepareByteTent(); f.encode()
  const bytes = f.driver.scratchBytes
  const finished = f.driver.finish(f.target, f.p.output, f.p.output.w, f.p.output.h, false, undefined, false)
  f.waits[0].reject(Error('finish uncertain')); await expect(finished).rejects.toThrow('finish uncertain')
  expect(f.driver.scratchBytes).toBe(bytes); expect(f.allocated[0].destroy).not.toHaveBeenCalled()
  const abort = f.driver.abortFrameAndReleaseFilterScratch(); f.waits[1].resolve(); await abort
  expect(f.driver.scratchBytes).toBe(0)
})
test('a failed park is observed immediately, retains submitted bytes, and a later revive tears down instead of trusting it', async () => {
  vi.useFakeTimers()
  const f = fixture(); await f.driver.prepareByteTent(); f.encode(); f.driver.submitCommands()
  f.driver.initialized = true; f.driver.poolKey = 'byte-test'
  const bytes = f.driver.scratchBytes
  f.driver.dispose()
  const parked = (WebGpuDriver as any).parkedDriver
  expect(parked).toBeDefined(); f.waits[0].reject(Error('park uncertain'))
  await expect(parked.settled).rejects.toThrow('park uncertain')
  expect(f.driver.scratchBytes).toBe(bytes); expect(f.device.destroy).not.toHaveBeenCalled()
  expect(await (WebGpuDriver as any).reviveParked('byte-test')).toBeUndefined()
  expect(f.device.destroy).toHaveBeenCalledOnce(); expect(f.driver.scratchBytes).toBe(0)
  expect(f.allocated[0].destroy).toHaveBeenCalledOnce()
})
test('a failed parked fence keeps its ledger until explicit timer device teardown, not a fabricated completion', async () => {
  vi.useFakeTimers()
  const f = fixture(); await f.driver.prepareByteTent(); f.encode(); f.driver.submitCommands()
  f.driver.initialized = true; f.driver.poolKey = 'byte-timer-test'; f.driver.dispose()
  const parked = (WebGpuDriver as any).parkedDriver
  f.waits[0].reject(Error('park failed')); await expect(parked.settled).rejects.toThrow('park failed')
  expect(f.driver.scratchBytes).toBeGreaterThan(0)
  await vi.advanceTimersByTimeAsync(30000)
  expect(f.device.destroy).toHaveBeenCalledOnce(); expect(f.driver.scratchBytes).toBe(0)
  expect(f.allocated[0].destroy).toHaveBeenCalledOnce()
})
test('dispose immediately observes a failed park without erasing its later rejected cleanup result', async () => {
  const unhandled = vi.fn(); process.on('unhandledRejection', unhandled)
  const f = fixture()
  try {
    await f.driver.prepareByteTent(); f.encode(); f.driver.submitCommands()
    f.driver.initialized = true; f.driver.poolKey = 'byte-unhandled-test'; f.driver.dispose()
    const parked = (WebGpuDriver as any).parkedDriver
    f.waits[0].reject(Error('park uncertain before a future revive'))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(unhandled).not.toHaveBeenCalled()
    await expect(parked.settled).rejects.toThrow('park uncertain before a future revive')
    expect(f.driver.scratchBytes).toBeGreaterThan(0)
    clearTimeout(parked.reaper); (WebGpuDriver as any).parkedDriver = undefined
    f.driver.destroyDeviceNow()
  } finally { process.off('unhandledRejection', unhandled) }
})
test('a successful park discards its unsubmitted encoder but retires submitted jobs only after its fence', async () => {
  vi.useFakeTimers()
  const f = fixture(); await f.driver.prepareByteTent(); f.encode(); f.driver.submitCommands(); f.encode()
  f.driver.initialized = true; f.driver.poolKey = 'byte-success-test'; f.driver.dispose()
  const parked = (WebGpuDriver as any).parkedDriver
  expect(f.allocated[1].destroy).toHaveBeenCalledOnce(); expect(f.allocated[0].destroy).not.toHaveBeenCalled()
  f.waits[0].resolve(); await parked.settled
  expect(f.driver.scratchBytes).toBe(0); expect(f.allocated[0].destroy).toHaveBeenCalledOnce()
  clearTimeout(parked.reaper); (WebGpuDriver as any).parkedDriver = undefined
  f.driver.destroyDeviceNow(); expect(f.allocated[0].destroy).toHaveBeenCalledOnce()
})
test('device loss and subsequent teardown dispose byte scratch exactly once', async () => {
  const f = fixture(); await f.driver.prepareByteTent(); f.encode(); f.driver.submitCommands()
  f.driver.lost = true; f.driver.releaseLostResources()
  expect(f.driver.scratchBytes).toBe(0); expect(f.allocated[0].destroy).toHaveBeenCalledOnce()
  f.driver.destroyDeviceNow(); expect(f.allocated[0].destroy).toHaveBeenCalledOnce()
})
