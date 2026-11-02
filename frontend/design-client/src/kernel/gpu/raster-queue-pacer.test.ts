import { expect, test, vi } from 'vitest'
import { RasterQueuePacer } from './raster-queue-pacer'

function fence() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
test('one slice runs without waiting; high water waits only for the older prefix', async () => {
  const p = new RasterQueuePacer(), a = fence(), b = fence()
  await p.yield(1, 0, () => a.promise)
  let continued = false
  const next = p.yield(2, 0, () => b.promise).then(() => { continued = true })
  await Promise.resolve(); expect(continued).toBe(false)
  a.resolve(); await next
  expect(continued).toBe(true)
  // The newer slice and any later presentation are still pending.
  b.resolve()
})
test('completed prefixes need no redundant observation or device-wide wait', async () => {
  const p = new RasterQueuePacer(), observe = vi.fn(async () => {})
  await p.yield(12, 12, observe)
  expect(observe).not.toHaveBeenCalled()
  await p.yield(13, 12, observe)
  await p.yield(13, 13, observe)
  expect(observe).toHaveBeenCalledOnce()
})
test('background completion failure is retained and cannot become success or an unhandled rejection', async () => {
  const p = new RasterQueuePacer(), a = fence(), error = Error('device queue rejected')
  await p.yield(1, 0, () => a.promise)
  a.reject(error); await Promise.resolve()
  await expect(p.yield(2, 0, () => Promise.resolve())).rejects.toBe(error)
})
test('high-water failures propagate and synchronous observation errors are retained', async () => {
  const p = new RasterQueuePacer(), error = Error('queue lost')
  await expect(p.yield(2, 0, () => { throw error })).rejects.toBe(error)
})
