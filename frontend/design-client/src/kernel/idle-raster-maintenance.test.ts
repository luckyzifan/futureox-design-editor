import { expect, test, vi } from 'vitest'
import { scheduleRasterMaintenance, type MaintenanceDriver } from './idle-raster-maintenance'

function clock() {
  const delay = new Set<() => void>(), idle = new Set<() => void>()
  const add = (queue: Set<() => void>, run: () => void) => { queue.add(run); return () => { queue.delete(run) } }
  const driver: MaintenanceDriver = { delay: run => add(delay, run), idle: run => add(idle, run) }
  const fire = (queue: Set<() => void>) => { const jobs = [...queue]; queue.clear(); jobs.forEach(run => run()) }
  return { driver, delay, idle, advance: () => fire(delay), opportunity: () => fire(idle) }
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }

test('overview starts only after quiet and idle, admitting one tile at a time', async () => {
  const c = clock(), submit = vi.fn(async () => {}), error = vi.fn()
  const cancel = scheduleRasterMaintenance([1, 2, 3], submit, () => true, error, c.driver)
  expect(submit).not.toHaveBeenCalled()
  c.advance(); await flush(); expect(submit).not.toHaveBeenCalled()
  c.opportunity(); await flush(); expect(submit.mock.calls).toEqual([[1]])
  c.opportunity(); await flush(); expect(submit).toHaveBeenCalledTimes(1)
  c.advance(); c.opportunity(); await flush(); expect(submit.mock.calls).toEqual([[1], [2]])
  cancel(); c.advance(); c.opportunity(); await flush()
  expect(submit).toHaveBeenCalledTimes(2); expect(error).not.toHaveBeenCalled()
})

test.each(['delay', 'idle', 'running'] as const)('navigation cancels %s work and never starts a successor', async phase => {
  const c = clock(), error = vi.fn()
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  let current = true
  const submit = vi.fn(() => pending)
  const cancel = scheduleRasterMaintenance([1, 2], submit, () => current, error, c.driver)
  if (phase !== 'delay') c.advance()
  if (phase === 'running') { c.opportunity(); await flush() }
  current = false; cancel(); finish(); c.advance(); c.opportunity(); await flush()
  expect(submit).toHaveBeenCalledTimes(phase === 'running' ? 1 : 0)
  expect(error).not.toHaveBeenCalled(); expect(c.delay.size + c.idle.size).toBe(0)
})

test('maintenance failure is reported once without retrying a write or continuing the queue', async () => {
  const c = clock(), error = vi.fn(), failure = Error('GPU budget'), submit = vi.fn(async () => { throw failure })
  scheduleRasterMaintenance([1, 2], submit, () => true, error, c.driver)
  c.advance(); c.opportunity(); await flush(); c.advance(); c.opportunity(); await flush()
  expect(error).toHaveBeenCalledWith(failure); expect(submit).toHaveBeenCalledTimes(1)
})
