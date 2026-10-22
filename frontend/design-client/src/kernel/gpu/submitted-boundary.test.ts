import { expect, test, vi } from 'vitest'
import { WebGpuDriver } from './webgpu'

function fixture() {
  let complete!: () => void, reject!: (error: Error) => void
  const waiting = new Promise<void>((resolve, fail) => { complete = resolve; reject = fail })
  const finish = vi.fn(() => { throw Error('Command encoding already finished') })
  const oldStorage = { destroy: vi.fn() }, laterStorage = { destroy: vi.fn() }
  const oldTable = { bytes: 64 }, laterTable = { bytes: 128 }
  const driver = Object.assign(Object.create(WebGpuDriver.prototype), {
    initialized: true, disposed: false, lost: false, submittedBoundaryReady: true, submittedBoundaryGeneration: 3,
    frameScopeOpen: false, resourceEpoch: 5, completedResourceEpoch: 4, errors: [],
    encoder: { finish }, device: {}, byteTentLeases: new Map(),
    imageTables: new Map([[oldTable, { retired: true, storage: oldStorage }], [laterTable, { retired: false, storage: laterStorage }]]),
    submitCommands: vi.fn(() => { finish() }), waitForQueue: vi.fn(() => waiting),
  }) as WebGpuDriver
  return { driver, finish, oldTable, laterTable, oldStorage, laterStorage, complete, reject }
}

test('between-frame completion waits already-submitted work without finishing or submitting the consumed encoder', async () => {
  const f = fixture(), pending = f.driver.waitForSubmittedWork()
  expect(f.finish).not.toHaveBeenCalled(); expect((f.driver as any).submitCommands).not.toHaveBeenCalled()
  expect(f.oldStorage.destroy).not.toHaveBeenCalled(); expect(f.driver.retiredImageTableBytes).toBe(64)
  ;(f.driver as any).imageTables.get(f.laterTable).retired = true
  f.complete(); await pending
  expect(f.oldStorage.destroy).toHaveBeenCalledTimes(1); expect(f.laterStorage.destroy).not.toHaveBeenCalled()
  expect(f.driver.retiredImageTableBytes).toBe(128); expect(f.driver.completedResourceEpoch).toBe(4)
  expect(f.finish).not.toHaveBeenCalled()
})

test('the prior in-frame checkpoint would try to finish the consumed encoder and is not a pre-begin fallback', async () => {
  const f = fixture()
  await expect(f.driver.checkpoint()).rejects.toThrow('Command encoding already finished')
  expect(f.finish).toHaveBeenCalledTimes(1); expect((f.driver as any).waitForQueue).not.toHaveBeenCalled()
  expect(f.oldStorage.destroy).not.toHaveBeenCalled()
})

test.each(['frame-open', 'unknown-state', 'initializing', 'disposed', 'lost', 'active-pass'] as const)(
  'an unsupported %s state grants no submitted boundary or retirement', async mode => {
    const f = fixture(), d = f.driver as any
    if (mode === 'frame-open') d.frameScopeOpen = true
    if (mode === 'unknown-state') d.submittedBoundaryReady = false
    if (mode === 'initializing') d.initialized = false
    if (mode === 'disposed') d.disposed = true
    if (mode === 'lost') d.lost = true
    if (mode === 'active-pass') d.activeOver = {}
    await expect(f.driver.waitForSubmittedWork()).rejects.toThrow('requires an ended frame')
    expect(d.waitForQueue).not.toHaveBeenCalled(); expect(f.oldStorage.destroy).not.toHaveBeenCalled()
    expect(f.finish).not.toHaveBeenCalled()
  })

test.each(['begin', 'dispose', 'device-loss', 'new-ended-frame'] as const)(
  '%s while awaiting a submitted boundary cannot credit the stale snapshot', async mode => {
    const f = fixture(), d = f.driver as any, pending = f.driver.waitForSubmittedWork()
    d.submittedBoundaryGeneration++
    if (mode === 'begin') { d.submittedBoundaryReady = false; d.frameScopeOpen = true }
    if (mode === 'dispose') { d.submittedBoundaryReady = false; d.disposed = true }
    if (mode === 'device-loss') { d.submittedBoundaryReady = false; d.lost = true }
    f.complete(); await expect(pending).rejects.toThrow('owner changed')
    expect(f.oldStorage.destroy).not.toHaveBeenCalled(); expect(f.driver.retiredImageTableBytes).toBe(64)
    expect(f.driver.completedResourceEpoch).toBe(4); expect(f.finish).not.toHaveBeenCalled()
    if (mode === 'new-ended-frame') expect(d.submittedBoundaryReady).toBe(true)
  })

test('a rejected queue boundary retains table ownership and fails closed for this ended-frame generation', async () => {
  const f = fixture(), pending = f.driver.waitForSubmittedWork()
  f.reject(Error('queue completion rejected'))
  await expect(pending).rejects.toThrow('queue completion rejected')
  expect(f.oldStorage.destroy).not.toHaveBeenCalled(); expect(f.driver.retiredImageTableBytes).toBe(64)
  expect((f.driver as any).submittedBoundaryReady).toBe(false)
  await expect(f.driver.waitForSubmittedWork()).rejects.toThrow('requires an ended frame')
  expect(f.finish).not.toHaveBeenCalled()
})
