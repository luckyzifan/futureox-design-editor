import { expect, test, vi } from 'vitest'
import { QueueWaitStats, queueWaitReasons } from './queue-wait-stats'

test('deferred completion is a CPU wait, not a submit acknowledgement or GPU timestamp', async () => {
  let time = 10, resolve!: () => void
  const stats = new QueueWaitStats(true, () => time)
  stats.submit(() => {})
  const wait = stats.wait('periodic', () => new Promise<void>(done => { resolve = done }), () => false)
  expect(stats.snapshot(4, 0)).toMatchObject({ submitCalls: 1, started: 1, pending: 1, completed: 0, cpuWaitMs: 0, pendingResourceEpochs: 4 })
  time = 35; resolve(); await wait
  const snapshot = stats.snapshot(4, 4)
  expect(snapshot).toMatchObject({ metric: 'cpu-queue-completion-wait', completed: 1, pending: 0, cpuWaitMs: 25, maxCpuWaitMs: 25, pendingResourceEpochs: 0 })
  expect(snapshot.reasons.periodic.cpuWaitMs).toBe(25)
  expect(snapshot.histogram.counts).toEqual([0, 0, 0, 0, 1, 0, 0, 0])
})

test('rejections, synchronous throws and device loss remain observable without swallowing errors', async () => {
  const stats = new QueueWaitStats(true, () => 0), failure = Error('private payload must never enter telemetry')
  expect(() => stats.submit(() => { throw failure })).toThrow(failure)
  await expect(stats.wait('admission', () => Promise.reject(failure), () => true)).rejects.toBe(failure)
  await expect(stats.wait('cancel', () => { throw failure }, () => false)).rejects.toBe(failure)
  const value = stats.snapshot(5, 4)
  expect(value).toMatchObject({ submitCalls: 0, submitFailures: 1, rejected: 2, pending: 0, deviceLost: 1, pendingResourceEpochs: 1 })
  expect(value.reasons.admission).toMatchObject({ rejected: 1, deviceLost: 1 })
  expect(JSON.stringify(value)).not.toContain('private')
})

test('disabled timing reads no clock; fixed counters and histogram remain bounded and snapshot/export copies are isolated', async () => {
  const now = vi.fn(() => 10), stats = new QueueWaitStats(false, now)
  for (let index = 0; index < 2000; index++) await stats.wait('checkpoint', async () => {}, () => false)
  expect(now).not.toHaveBeenCalled()
  const first = stats.snapshot(2, 1)
  expect(first.started).toBe(2000)
  expect(first.cpuWaitMs).toBe(0)
  expect(first.histogram.counts).toHaveLength(8)
  expect(Object.keys(first.reasons)).toEqual([...queueWaitReasons])
  const exported = JSON.parse(JSON.stringify(first))
  expect(exported).toEqual(first)
  first.histogram.counts.fill(99); first.reasons.checkpoint.started = 99
  expect(stats.snapshot(2, 1).reasons.checkpoint.started).toBe(2000)
  expect(stats.snapshot(2, 1).histogram.counts).toEqual(Array(8).fill(0))
})
