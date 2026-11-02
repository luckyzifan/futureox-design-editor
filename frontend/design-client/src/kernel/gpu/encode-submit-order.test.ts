/** CPU scheduling checks using the production EncodeYield MessageChannel.
 * The GPU submission endpoint is observed; no GPU or timing claim is made. */
import { afterEach, expect, test, vi } from 'vitest'
import { GpuRenderer } from './renderer'
import type { EncodeYield } from './encode-yield'
import type { Driver } from './types'

const renderers: GpuRenderer[] = []
afterEach(() => {
  renderers.splice(0).forEach(renderer => renderer.dispose())
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function fixture(captureDisplay = true) {
  const events: string[] = []
  let current = true
  const driver = {
    scratchBytes: 0, captureDisplay, drawCalls: 0,
    submitPending: vi.fn(() => { events.push('submit') }),
    dispose: vi.fn(), destroy: vi.fn(),
  } as unknown as Driver
  const renderer = new GpuRenderer(driver)
  renderers.push(renderer)
  const internal = renderer as unknown as {
    encodeYield: EncodeYield
    frameCurrent?: () => boolean
    yieldEncoding(): Promise<void> | undefined
  }
  internal.frameCurrent = () => { events.push(current ? 'current' : 'obsolete'); return current }
  return { driver, internal, events, cancel: () => { current = false } }
}

test('live work submits only after the real task yield and the resumed freshness check', async () => {
  const f = fixture()
  // The first EncodeYield deadline is zero. Its actual MessageChannel, not a
  // substituted checkpoint promise, supplies the following task boundary.
  const pending = f.internal.yieldEncoding()
  expect(pending).toBeInstanceOf(Promise)
  expect(f.events).toEqual(['current'])
  await Promise.resolve().then(() => { f.events.push('control') })
  expect(f.driver.submitPending).not.toHaveBeenCalled()
  await pending
  expect(f.events).toEqual(['current', 'control', 'current', 'submit'])
  expect(f.driver.submitPending).toHaveBeenCalledOnce()
})

test('cancellation received before the yielded task resumes prevents an obsolete GPU submit', async () => {
  const f = fixture()
  const pending = f.internal.yieldEncoding()
  const rejected = expect(pending).rejects.toThrow('PREVIEW_CANCELLED')
  await Promise.resolve().then(() => { f.events.push('cancel'); f.cancel() })
  await rejected
  expect(f.events).toEqual(['current', 'cancel', 'obsolete'])
  expect(f.driver.submitPending).not.toHaveBeenCalled()
  // This method does not free resources or invent a completion boundary.
  expect(f.driver.destroy).not.toHaveBeenCalled()
})

test('an already obsolete frame throws before a task or submission is scheduled', () => {
  const f = fixture(); f.cancel()
  expect(() => f.internal.yieldEncoding()).toThrow('PREVIEW_CANCELLED')
  expect(f.events).toEqual(['obsolete'])
  expect(f.driver.submitPending).not.toHaveBeenCalled()
})

test('the unexpired encoding window keeps the synchronous no-yield path', () => {
  const f = fixture()
  vi.spyOn(performance, 'now').mockReturnValue(100)
  f.internal.encodeYield.begin()
  expect(f.internal.yieldEncoding()).toBeUndefined()
  expect(f.events).toEqual(['current'])
  expect(f.driver.submitPending).not.toHaveBeenCalled()
})

test('a full display command slice yields even when the CPU time window has not expired', async () => {
  const f = fixture()
  vi.spyOn(performance, 'now').mockReturnValue(100)
  f.internal.encodeYield.begin()
  f.driver.rasterPacing = true
  f.driver.drawCalls = 64
  const pending = f.internal.yieldEncoding()
  expect(pending).toBeInstanceOf(Promise)
  await pending
  expect(f.driver.submitPending).toHaveBeenCalledOnce()
  expect(f.internal.yieldEncoding()).toBeUndefined()
})

test('disabled submit still yields and checks cancellation without sending work', async () => {
  vi.stubEnv('VITE_DESIGN_ENCODE_SUBMIT', '0')
  const f = fixture()
  await f.internal.yieldEncoding()
  expect(f.events).toEqual(['current', 'current'])
  expect(f.driver.submitPending).not.toHaveBeenCalled()
})

test('non-display work without a cancellation contract does not acquire a task yield', () => {
  const f = fixture(false)
  f.internal.frameCurrent = undefined
  expect(f.internal.yieldEncoding()).toBeUndefined()
  expect(f.driver.submitPending).not.toHaveBeenCalled()
})

test('submission errors propagate from the resumed task after freshness was checked', async () => {
  const f = fixture(), failure = Error('submission failed')
  vi.mocked(f.driver.submitPending!).mockImplementation(() => {
    f.events.push('submit-error'); throw failure
  })
  const pending = f.internal.yieldEncoding()
  expect(f.events).toEqual(['current'])
  await expect(pending).rejects.toBe(failure)
  expect(f.events).toEqual(['current', 'current', 'submit-error'])
})

test.each([false, true])('canvas queue pacing observes late cancellation=%s before more encoding', async cancelled => {
  vi.stubEnv('VITE_DESIGN_RASTER_BACKPRESSURE', '1')
  const f = fixture()
  ;(f.internal as unknown as { displayBackpressure: boolean }).displayBackpressure = true
  let finish!: () => void
  f.driver.yieldRasterQueue = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  const pending = f.internal.yieldEncoding()
  const outcome = cancelled ? expect(pending).rejects.toThrow('PREVIEW_CANCELLED') : expect(pending).resolves.toBeUndefined()
  await vi.waitFor(() => expect(f.driver.yieldRasterQueue).toHaveBeenCalledOnce())
  expect(f.driver.submitPending).not.toHaveBeenCalled()
  expect(f.driver.destroy).not.toHaveBeenCalled()
  if (cancelled) f.cancel()
  finish(); await outcome
  expect(f.events.at(-1)).toBe(cancelled ? 'obsolete' : 'current')
  expect(f.driver.destroy).not.toHaveBeenCalled()
})

test.each(['disabled', 'non-display', 'submit-disabled'])('queue pacing retains the %s boundary', async boundary => {
  vi.stubEnv('VITE_DESIGN_RASTER_BACKPRESSURE', boundary === 'disabled' ? '0' : '1')
  if (boundary === 'submit-disabled') vi.stubEnv('VITE_DESIGN_ENCODE_SUBMIT', '0')
  const f = fixture(boundary !== 'non-display')
  f.driver.yieldRasterQueue = vi.fn(async () => {})
  await f.internal.yieldEncoding()
  expect(f.driver.yieldRasterQueue).not.toHaveBeenCalled()
  expect(f.driver.submitPending).toHaveBeenCalledTimes(boundary === 'submit-disabled' ? 0 : 1)
})
