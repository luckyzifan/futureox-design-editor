// Production driver/renderer lifecycle methods; controlled GPU boundary, no GPU timings or pixels.
import { afterEach, expect, test, vi } from 'vitest'
import { WebGpuDriver } from './webgpu'
import { renderFailureFields } from '../render-failure-telemetry'
import { GpuRenderer } from './renderer'
import type { ExactImageTable, Texture } from './types'
import { setGpuDiagnosticSink } from '../../../../design-desktop/src/render-terminal-diagnostics.mjs'
afterEach(() => { setGpuDiagnosticSink(undefined); vi.unstubAllGlobals(); vi.unstubAllEnvs() })
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
function fixture() {
  vi.stubEnv('VITE_DESIGN_RESIDENT_FILTER_SCRATCH', '0')
  vi.stubGlobal('OffscreenCanvas', class { width = 8; height = 8 })
  const fences: { resolve(): void; reject(error: Error): void }[] = []
  const source = { width: 8, height: 8, bytes: 1024, resource: {}, finitePixels: true } as Texture
  let captureId = 0
  const encoder = { finish: () => ({}), beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }) }
  const device = { queue: { submit: vi.fn(), onSubmittedWorkDone: vi.fn(() => new Promise<void>((resolve, reject) => fences.push({ resolve, reject }))) },
    popErrorScope: vi.fn(async () => null), createCommandEncoder: () => encoder }
  const driver = new WebGpuDriver(true), raw = driver as any
  Object.assign(raw, { device, encoder, resourceEpoch: 1, frameScopeOpen: true, captureDisplay: true,
    presenter: { capture: () => ({ id: ++captureId, texture: {} }), release: vi.fn() },
    bindingCache: { view: () => ({}) }, bind: () => ({ group: {}, offsets: [] }), uploadUniforms() {},
    shrinkCapacities: vi.fn(), initialized: true })
  const renderer = new GpuRenderer(driver, true, true, undefined, false, false, 256) as any
  renderer.scene = {}; renderer.bytes = source.bytes
  const add = (bytes = 1024, image = source) => {
    const table = { width: 8, height: 8, bytes, resource: {} } as ExactImageTable, storage = { destroy: vi.fn() }
    raw.imageTables.set(table, { storage, image, retired: false }); renderer.bytes += bytes
    return { table, storage }
  }
  const finish = async (resident = true) => {
    raw.encoder = encoder; raw.frameScopeOpen = true
    const before = driver.scratchBytes
    try { return await driver.finish(source, { x: 0, y: 0, w: 8, h: 8 }, 8, 8, false, undefined, resident) }
    finally { renderer.bytes += driver.scratchBytes - before }
  }
  return { driver, raw, renderer, source, add, finish, reclaim: () => renderer.reclaimScratch(), fences, device }
}
test('resident image-table finish returns a GPU handle before completion while real renderer ledger stays pinned', async () => {
  const f = fixture(), { table, storage } = f.add(); let returned = false
  const finishing = f.finish().then(result => { returned = true; return result }); await tick()
  expect(returned).toBe(true) // Old production finish blocks here on reason11.
  expect((await finishing).gpuTile).toBe(1); expect(f.driver.completedResourceEpoch).toBe(0)
  expect(f.driver.scratchBytes).toBe(table.bytes); expect(f.driver.hasActiveImageTableSource(f.source)).toBe(true)
  expect(f.renderer.bytes).toBe(f.source.bytes + table.bytes); expect(storage.destroy).not.toHaveBeenCalled()
  f.fences[0].resolve(); await tick(); expect(f.driver.completedResourceEpoch).toBe(1)
  expect(f.driver.scratchBytes).toBe(table.bytes); expect(storage.destroy).not.toHaveBeenCalled()
  await f.reclaim(); expect(storage.destroy).toHaveBeenCalledOnce(); expect(f.driver.scratchBytes).toBe(0)
  expect(f.renderer.bytes).toBe(f.source.bytes); expect(f.driver.hasActiveImageTableSource(f.source)).toBe(false)
  await f.reclaim(); expect(storage.destroy).toHaveBeenCalledOnce(); expect(f.renderer.bytes).toBe(f.source.bytes)
})
test('snapshot excludes later frames and three deferred batches retain periodic backpressure', async () => {
  const f = fixture(), entries = []
  for (let i = 1; i <= 3; i++) { f.raw.resourceEpoch = i; entries.push(f.add()); await f.finish() }
  expect(f.fences).toHaveLength(3)
  f.raw.resourceEpoch = 4; const fourth = f.add(); let returned = false
  const finishing = f.finish().then(() => { returned = true }); await tick()
  expect(returned).toBe(false); expect(f.fences).toHaveLength(4)
  // Avoid concurrent renderer accounting sections; mark only until finish exits.
  f.fences[0].resolve(); await tick()
  expect(entries[0].storage.destroy).not.toHaveBeenCalled(); expect(fourth.storage.destroy).not.toHaveBeenCalled()
  f.fences[3].resolve(); await finishing
  expect(f.driver.scratchBytes).toBe(0); expect(f.driver.completedResourceEpoch).toBe(4)
  expect(f.renderer.bytes).toBe(f.source.bytes)
  for (const fence of f.fences) fence.resolve(); await tick(); await f.reclaim()
  for (const entry of [...entries, fourth]) expect(entry.storage.destroy).toHaveBeenCalledOnce()
})
test.each(['scratch', 'source', 'nonresident'] as const)('%s limit keeps a synchronous boundary', async kind => {
  const f = fixture(), image = kind === 'source' ? { ...f.source, bytes: 64 * 1024 * 1024 } : f.source
  const { storage } = f.add(kind === 'scratch' ? 64 * 1024 * 1024 : 1024, image)
  let returned = false; const finishing = f.finish(kind !== 'nonresident').then(() => { returned = true })
  await tick(); expect(returned).toBe(false); expect(storage.destroy).not.toHaveBeenCalled()
  f.fences[0].resolve(); await finishing; expect(storage.destroy).toHaveBeenCalledOnce(); expect(f.driver.scratchBytes).toBe(0)
})
test('rejected asynchronous completion keeps bytes, surfaces failure and allows proven abort cleanup', async () => {
  const f = fixture(), { table, storage } = f.add(); await f.finish()
  f.fences[0].reject(Error('injected queue rejection')); await tick()
  expect(f.driver.scratchBytes).toBe(table.bytes); expect(f.driver.completedResourceEpoch).toBe(0)
  expect(storage.destroy).not.toHaveBeenCalled(); await expect(f.reclaim()).rejects.toThrow('injected queue rejection')
  expect(f.renderer.bytes).toBe(f.source.bytes + table.bytes)
  const before = f.driver.scratchBytes, abort = f.driver.abortFrameAndReleaseFilterScratch('cancel'); await tick()
  expect(storage.destroy).not.toHaveBeenCalled(); f.fences[1].resolve(); await abort
  f.renderer.bytes += f.driver.scratchBytes - before
  expect(storage.destroy).toHaveBeenCalledOnce(); expect(f.renderer.bytes).toBe(f.source.bytes); await f.reclaim()
})
test('lost completion cannot certify retirement; explicit teardown prevents late callback reuse', async () => {
  const f = fixture(), { table, storage } = f.add(); await f.finish()
  f.raw.lost = true; f.fences[0].resolve(); await tick()
  expect(f.driver.completedResourceEpoch).toBe(0); expect(f.driver.scratchBytes).toBe(table.bytes)
  expect(storage.destroy).not.toHaveBeenCalled(); f.raw.releaseImageTables()
  expect(storage.destroy).toHaveBeenCalledOnce(); expect(f.driver.scratchBytes).toBe(0)
  f.raw.lost = false; await f.reclaim(); expect(storage.destroy).toHaveBeenCalledOnce()
})
test('first completion collects only its immutable snapshot, not later frame tables', async () => {
  const f = fixture(), first = f.add(); await f.finish()
  f.raw.resourceEpoch = 2; const second = f.add(); await f.finish()
  f.fences[0].resolve(); await tick(); await f.reclaim()
  expect(first.storage.destroy).toHaveBeenCalledOnce(); expect(second.storage.destroy).not.toHaveBeenCalled()
  expect(f.driver.scratchBytes).toBe(second.table.bytes); expect(f.driver.hasActiveImageTableSource(f.source)).toBe(true)
  expect(f.renderer.bytes).toBe(f.source.bytes + second.table.bytes); expect(f.driver.completedResourceEpoch).toBe(1)
  f.fences[1].resolve(); await tick(); await f.reclaim()
  expect(second.storage.destroy).toHaveBeenCalledOnce(); expect(f.renderer.bytes).toBe(f.source.bytes)
})
test('aggregate bytes force a completion, but a shared source is counted only once', async () => {
  const f = fixture(); f.source.bytes = 32 * 1024 * 1024
  f.renderer.bytes = f.source.bytes
  f.add(16 * 1024 * 1024); await f.finish()
  f.raw.resourceEpoch = 2; f.add(16 * 1024 * 1024); await f.finish() // exactly 64 MiB total, not 96
  f.raw.resourceEpoch = 3; f.add(1024); let returned = false
  const finishing = f.finish().then(() => { returned = true }); await tick(); expect(returned).toBe(false)
  f.fences[2].resolve(); await finishing; expect(f.driver.scratchBytes).toBe(0)
  f.fences[0].resolve(); f.fences[1].resolve(); await tick(); expect(f.renderer.bytes).toBe(f.source.bytes)
})
test('in-flight transient targets retain the synchronous path; unfenced frames never shrink geometry', async () => {
  const f = fixture(); const entry = f.add(); f.raw.transientBytes = 128
  let returned = false; const finishing = f.finish().then(() => { returned = true }); await tick()
  expect(returned).toBe(false); expect(entry.storage.destroy).not.toHaveBeenCalled()
  f.fences[0].resolve(); await finishing; expect(f.raw.shrinkCapacities).toHaveBeenCalledOnce()
  f.raw.resourceEpoch = 2; f.add(); await f.finish()
  expect(f.raw.shrinkCapacities).toHaveBeenCalledOnce(); f.fences[1].resolve(); await tick(); await f.reclaim()
})
test('async fence trace freezes owner/submit range, is not CPU-blocking wait stats, and releases only on collection', async () => {
  const f = fixture(), records: { event: string; fields: any }[] = []
  setGpuDiagnosticSink((event, fields) => records.push({ event, fields }))
  const { table } = f.add(); await f.finish()
  expect(f.driver.stats().queueWaits.reasons['image-table-scratch'].started).toBe(0)
  expect(records.find(record => record.event === 'gpu-submit')?.fields).toMatchObject({ deviceSubmitSequence: 1, drawCalls: 1, deviceSubmitTableCount: 1 })
  const start = records.find(record => record.event === 'fence' && record.fields.deviceFencePhase === 1)!.fields
  expect(start).toMatchObject({ deviceFenceAsync: 1, deviceFenceSubmitFirst: 1, deviceFenceSubmitLast: 1,
    deviceRetiringScratchBytes: table.bytes, deviceRetiringSourceBytes: f.source.bytes, deviceGpuTimingEnabled: 0 })
  f.raw.resourceEpoch = 2; f.add(); await f.finish()
  f.fences[0].resolve(); await tick()
  const end = records.find(record => record.event === 'fence' && record.fields.deviceFencePhase === 2)!.fields
  expect(end.deviceFenceId).toBe(start.deviceFenceId); expect(end.deviceFenceSubmitLast).toBe(1)
  expect(end.deviceFenceResourceEpoch).toBe(1); expect(end.deviceFenceOutcome).toBe(1)
  expect(records.some(record => record.event === 'gpu-retirement')).toBe(false)
  await f.reclaim()
  expect(records.find(record => record.event === 'gpu-retirement')?.fields).toMatchObject({ deviceRetirementPhase: 1, deviceRetirementReleasedBytes: table.bytes })
  f.fences[1].resolve(); await tick(); await f.reclaim()
})
test.each(['target', 'msaa'] as const)('%s scratch remains physically owned and charged until finish completion', async kind => {
  const f = fixture(), table = f.add(), destroy = vi.fn()
  const texture = { width: 2, height: 2, bytes: 64, resource: { destroy } } as unknown as Texture
  if (kind === 'target') { f.raw.textures.add(texture); f.raw.transientTargets.push(texture) }
  else { f.raw.transient.push(texture.resource); f.raw.msaa.set('2:2', { color: texture.resource }) }
  f.raw.transientBytes = texture.bytes
  let returned = false; const finishing = f.finish().then(() => { returned = true }); await tick()
  expect(returned).toBe(false); expect(destroy).not.toHaveBeenCalled(); expect(table.storage.destroy).not.toHaveBeenCalled()
  expect(f.raw.transientBytes).toBe(64)
  if (kind === 'target') expect(f.raw.transientTargets).toContain(texture)
  else expect(f.raw.transient).toContain(texture.resource)
  f.fences[0].resolve(); await finishing
  expect(destroy).toHaveBeenCalledOnce(); expect(table.storage.destroy).toHaveBeenCalledOnce()
  expect(f.raw.transientBytes).toBe(0); expect(f.raw.transientTargets).toHaveLength(0)
  expect(f.raw.transient).toHaveLength(0); expect(f.raw.msaa.size).toBe(0)
})
test('actual due 60-frame geometry shrink preserves old buffers until a real finish boundary', async () => {
  const f = fixture(), destroyVertex = vi.fn(), destroyCurve = vi.fn()
  vi.stubGlobal('GPUBufferUsage', { VERTEX: 1, COPY_DST: 2, STORAGE: 4, COPY_SRC: 8 })
  Object.assign(f.device, { createBuffer: vi.fn((descriptor: unknown) => ({ ...descriptor as object, destroy: vi.fn() })) })
  Object.assign(f.raw, { vertices: { destroy: destroyVertex }, vertexCapacity: 4096, vertexShrink: { frames: 60, maxDemand: 256 },
    curves: { destroy: destroyCurve }, curveCapacity: 4096, curveShrink: { frames: 60, maxDemand: 16 } })
  delete f.raw.shrinkCapacities
  f.add(); await f.finish()
  expect(destroyVertex).not.toHaveBeenCalled(); expect(destroyCurve).not.toHaveBeenCalled()
  expect(f.raw.vertexCapacity).toBe(4096); expect(f.raw.curveCapacity).toBe(4096)
  f.raw.resourceEpoch = 2; f.add(); f.raw.transientBytes = 1
  const finishing = f.finish(); await tick()
  expect(destroyVertex).not.toHaveBeenCalled(); expect(destroyCurve).not.toHaveBeenCalled()
  f.fences[1].resolve(); await finishing
  expect(destroyVertex).toHaveBeenCalledOnce(); expect(destroyCurve).toHaveBeenCalledOnce()
  expect(f.raw.vertexCapacity).toBe(256); expect(f.raw.curveCapacity).toBe(16)
  f.fences[0].resolve(); await tick()
})
test('req209-sized pressure keeps free-but-used pool alive until real admission completion, then fits without raising budget', async () => {
  const f = fixture(), pool: Texture[] = [], required = 5_017_992
  f.renderer.frameBudget = 1_073_741_824
  f.renderer.bytes = 1_071_617_564
  let completed = false
  for (let i = 0; i < 33; i++) {
    const bytes = i < 32 ? 25_470_526 : 25_470_540
    const texture = { width: i + 1, height: 1, bytes, resource: { destroy: vi.fn(() => expect(completed).toBe(true)) } } as unknown as Texture
    pool.push(texture); f.raw.textures.add(texture); f.renderer.free.set(`${i + 1}:1`, [texture]); f.renderer.used.add(texture)
    f.renderer.poolReleaseEpoch.set(texture, f.driver.resourceEpoch)
  }
  // Production checkpoint still submits; the test supplies only its encoder.
  f.raw.submitCommands = () => f.raw.submitQueue({})
  const before = f.renderer.bytes, reclaiming = f.renderer.reclaimScratch(required); await tick()
  expect(f.renderer.bytes).toBe(before); expect(f.fences).toHaveLength(1)
  expect(pool.every(texture => !(texture.resource as any).destroy.mock.calls.length)).toBe(true)
  completed = true; f.fences[0].resolve(); await reclaiming
  expect(f.renderer.bytes + required).toBeLessThanOrEqual(f.renderer.frameBudget)
  expect(f.renderer.frameBudget).toBe(1_073_741_824)
  expect(pool.some(texture => (texture.resource as any).destroy.mock.calls.length)).toBe(true)
})
test.each(['vertex', 'curve', 'arena'] as const)('real begin %s replacement waits for pending image submission first', async kind => {
  const f = fixture(), vertex = { size: 256, destroy: vi.fn() }, curve = { size: 16, destroy: vi.fn() }
  vi.stubGlobal('GPUBufferUsage', { VERTEX: 1, COPY_DST: 2, STORAGE: 4, COPY_SRC: 8 })
  Object.assign(f.device, { createBuffer: vi.fn((descriptor: unknown) => ({ ...descriptor as object, destroy: vi.fn() })), pushErrorScope: vi.fn() })
  Object.assign(f.device.queue, { writeBuffer: vi.fn() })
  f.raw.bindingCache.begin = vi.fn()
  Object.assign(f.raw, { vertices: vertex, vertexCapacity: 256, curves: curve, curveCapacity: 16 })
  f.add(); await f.finish()
  if (kind === 'arena') f.raw.scenePrograms = [{ first: 0, count: 1, fingerprint: [1, 2] }]
  const vertices = new Float32Array(kind === 'vertex' ? 128 : 0), curves = new Float32Array(kind === 'curve' ? 128 : 4)
  let began = false
  const prepare = (async () => {
    const before = f.driver.scratchBytes
    try { await f.driver.prepareFrameResources(vertices, curves) }
    finally { f.renderer.bytes += f.driver.scratchBytes - before }
    f.driver.begin(vertices, curves); began = true
  })()
  await tick(); expect(began).toBe(false); expect(f.fences).toHaveLength(2)
  expect(vertex.destroy).not.toHaveBeenCalled(); expect(curve.destroy).not.toHaveBeenCalled()
  expect(f.raw.vertexCapacity).toBe(256); expect(f.raw.curveCapacity).toBe(16)
  f.fences[1].resolve(); await prepare
  expect(began).toBe(true); expect(f.driver.scratchBytes).toBe(0); expect(f.renderer.bytes).toBe(f.source.bytes)
  if (kind === 'vertex') expect(vertex.destroy).toHaveBeenCalledOnce()
  else expect(curve.destroy).toHaveBeenCalledOnce()
  f.fences[0].resolve(); await tick(); expect(f.driver.completedResourceEpoch).toBe(1)
})
test('finish preview allocation itself prevents deferred retirement until its shown target completes', async () => {
  const f = fixture(), destroy = vi.fn(), shown = { width: 8, height: 8, bytes: 1024, resource: { destroy } } as unknown as Texture
  f.add(); f.raw.create = vi.fn(() => { f.raw.textures.add(shown); return shown }); f.raw.pass = vi.fn()
  let returned = false
  const finishing = f.driver.finish(f.source, { x: 0, y: 0, w: 8, h: 8 }, 8, 8, false,
    { scale: 1, sourceWidth: 8, sourceHeight: 8 } as any).then(() => { returned = true })
  await tick(); expect(f.raw.create).toHaveBeenCalledWith(8, 8); expect(returned).toBe(false)
  expect(f.raw.transientTargets).toContain(shown); expect(f.raw.transientBytes).toBe(shown.bytes)
  expect(destroy).not.toHaveBeenCalled(); f.fences[0].resolve(); await finishing
  expect(destroy).toHaveBeenCalledOnce(); expect(f.raw.transientBytes).toBe(0)
})
test('routine trace is sampled while slow and failed completions retain frozen range and skipped counts', async () => {
  const f = fixture(), records: { event: string; fields: any }[] = []
  setGpuDiagnosticSink((event, fields) => records.push({ event, fields }))
  for (let i = 0; i < 64; i++) f.raw.submitQueue({})
  expect(records.filter(record => record.event === 'gpu-submit')).toHaveLength(2)
  f.raw.fenceSequence = 1
  const now = vi.spyOn(performance, 'now').mockReturnValue(0)
  const short = f.raw.waitForQueue('periodic'); f.fences[0].resolve(); await short
  expect(records.some(record => record.event === 'fence')).toBe(false)
  const slow = f.raw.waitForQueue('periodic'); now.mockReturnValue(40); f.fences[1].resolve(); await slow
  const failed = f.raw.waitForQueue('admission'); f.fences[2].reject(Error('test failure'))
  await expect(failed).rejects.toThrow('test failure')
  const ends = records.filter(record => record.event === 'fence')
  expect(ends).toHaveLength(2)
  expect(ends[0].fields).toMatchObject({ deviceFencePhase: 2, deviceFenceOutcome: 1, queueWaitMs: 40,
    deviceFenceSubmitLast: 64, deviceSubmitTraceSkipped: 62, deviceFenceTraceSkipped: 1 })
  expect(ends[1].fields.deviceFenceOutcome).toBe(2)
  now.mockRestore()
})
test.each(['dispose', 'generation', 'device'] as const)('geometry preparation never certifies or resumes begin after %s changes the pending boundary', async kind => {
  const f = fixture(), vertex = { destroy: vi.fn() }, table = f.add()
  Object.assign(f.raw, { vertices: vertex, vertexCapacity: 16 })
  await f.finish()
  let began = false
  const preparation = (async () => {
    await f.driver.prepareFrameResources(new Float32Array(128))
    began = true
  })()
  await tick(); expect(f.fences).toHaveLength(2)
  if (kind === 'dispose') {
    f.raw.bindingCache.clear = vi.fn(); f.raw.destroyDeviceNow = vi.fn()
    f.driver.dispose()
  } else if (kind === 'generation') f.raw.submittedBoundaryGeneration++
  else f.raw.device = { queue: {} }
  f.fences[1].resolve()
  await expect(preparation).rejects.toThrow('boundary owner changed')
  expect(began).toBe(false); expect(f.driver.completedResourceEpoch).toBe(0)
  expect(table.storage.destroy).not.toHaveBeenCalled(); expect(vertex.destroy).not.toHaveBeenCalled()
  expect(f.driver.scratchBytes).toBe(table.table.bytes)
  f.raw.releaseImageTables(); f.fences[0].resolve(); await tick()
  expect(table.storage.destroy).toHaveBeenCalledOnce(); expect(f.driver.completedResourceEpoch).toBe(0)
})

test('pending geometry admission keeps device loss classified as category4/code31', async () => {
  const f = fixture(); f.add()
  Object.assign(f.raw, { vertices: { destroy: vi.fn() }, vertexCapacity: 16 })
  await f.finish()
  const preparation = f.driver.prepareFrameResources(new Float32Array(128))
  await tick(); f.raw.lost = true; f.fences[1].resolve()
  const error = await preparation.catch(error => error)
  expect(renderFailureFields(error)).toMatchObject({ failureCategory: 4, failureCode: 31 })
  expect(f.driver.completedResourceEpoch).toBe(0)
  f.raw.releaseImageTables(); f.fences[0].resolve(); await tick()
})

// Admission candidate: actual prepare/begin/finish methods, mocked queue and
// descriptor buffers only. This proves scheduling/ownership, not GPU pixels.
async function warmProgramFixture() {
  const f = fixture(), curves = new Float32Array(new Uint32Array([0x80000000, 0x7fc00001, 3, 4]).buffer)
  vi.stubGlobal('GPUBufferUsage', { VERTEX: 1, COPY_DST: 2, STORAGE: 4, COPY_SRC: 8 })
  Object.assign(f.device, { createBuffer: vi.fn((descriptor: any) => ({ ...descriptor, destroy: vi.fn() })), pushErrorScope: vi.fn() })
  Object.assign(f.device.queue, { writeBuffer: vi.fn() })
  f.raw.bindingCache.begin = vi.fn()
  f.raw.scenePrograms = [{ first: 0, count: 1, fingerprint: [7, 8] }]
  f.driver.begin(new Float32Array(0), curves)
  const entry = f.add(); await f.finish()
  return { ...f, curves, entry }
}
test('warm exact geometry hits prepare and begin without waiting for unrelated pending queue work', async () => {
  const f = await warmProgramFixture(), writes = (f.device.queue as any).writeBuffer.mock.calls.length
  const curve = f.raw.curves, vertex = f.raw.vertices, epoch = f.driver.completedResourceEpoch
  let prepared = false
  const preparation = f.driver.prepareFrameResources(new Float32Array(0), f.curves).then(() => { prepared = true })
  await tick()
  try {
    expect(prepared).toBe(true)
    expect(f.fences).toHaveLength(1) // Only the already-owned async table fence.
    expect(f.driver.completedResourceEpoch).toBe(epoch)
    expect(f.driver.scratchBytes).toBe(f.entry.table.bytes)
    expect(f.driver.hasActiveImageTableSource(f.source)).toBe(true)
    expect(f.entry.storage.destroy).not.toHaveBeenCalled()
    f.driver.begin(new Float32Array(0), f.curves)
    expect(f.raw.curves).toBe(curve); expect(f.raw.vertices).toBe(vertex)
    expect(curve.destroy).not.toHaveBeenCalled(); expect(vertex.destroy).not.toHaveBeenCalled()
    expect((f.device.queue as any).writeBuffer.mock.calls).toHaveLength(writes)
    expect(f.raw.programHits).toBe(1); expect(f.raw.geometryUploadBytes).toBe(0)
    expect(f.driver.completedResourceEpoch).toBe(epoch)
  } finally { for (const fence of f.fences) fence.resolve(); await preparation; await tick() }
})

test.each(['miss', 'collision', 'growth', 'gpu-invalid', 'arena-inactive', 'arena-capacity', 'vertex-growth'] as const)
  ('%s keeps the real admission fence and source ownership', async kind => {
    const f = await warmProgramFixture(), oldCurve = f.raw.curves, oldVertex = f.raw.vertices
    let curves = f.curves, vertices = new Float32Array(0)
    if (kind === 'miss') f.raw.scenePrograms = [{ first: 0, count: 1, fingerprint: [9, 10] }]
    if (kind === 'collision') { curves = new Float32Array(f.curves); curves[3] = 999 }
    if (kind === 'growth') {
      curves = new Float32Array(5000); f.raw.scenePrograms = [{ first: 0, count: 1250, fingerprint: [9, 10] }]
    }
    if (kind === 'gpu-invalid') f.raw.programGpuValid = false
    if (kind === 'arena-inactive') f.raw.programArenaActive = false
    if (kind === 'arena-capacity') f.raw.curveCapacity = 16
    if (kind === 'vertex-growth') vertices = new Float32Array(128)
    let returned = false
    const preparation = f.driver.prepareFrameResources(vertices, curves).then(() => { returned = true })
    await tick(); expect(returned).toBe(false); expect(f.fences).toHaveLength(2)
    expect(f.entry.storage.destroy).not.toHaveBeenCalled()
    expect(oldCurve.destroy).not.toHaveBeenCalled(); expect(oldVertex.destroy).not.toHaveBeenCalled()
    expect(f.driver.completedResourceEpoch).toBe(0)
    // Resolving the older observer is not completion of the newer admission fence.
    f.fences[0].resolve(); await tick(); expect(returned).toBe(false)
    expect(f.entry.storage.destroy).not.toHaveBeenCalled()
    f.fences[1].resolve(); await preparation
    expect(f.entry.storage.destroy).toHaveBeenCalledOnce()
    expect(f.driver.completedResourceEpoch).toBe(2)
  })

test.each(['words', 'path', 'arena-reset', 'gpu-invalid', 'capacity', 'vertex-growth', 'generation', 'device', 'buffer', 'scope', 'over', 'lost', 'disposed'] as const)
  ('a %s change after warm preparation cannot mutate or enter the new frame', async kind => {
    const f = await warmProgramFixture(), beforeEpoch = f.driver.resourceEpoch
    await f.driver.prepareFrameResources(new Float32Array(0), f.curves)
    let vertices = new Float32Array(0)
    if (kind === 'words') new Uint32Array(f.curves.buffer)[0] ^= 1
    if (kind === 'path') f.raw.scenePrograms[0].fingerprint[0]++
    if (kind === 'arena-reset') f.raw.programArena.reset()
    if (kind === 'gpu-invalid') f.raw.programGpuValid = false
    if (kind === 'capacity') f.raw.curveCapacity = 16
    if (kind === 'vertex-growth') vertices = new Float32Array(128)
    if (kind === 'generation') f.raw.submittedBoundaryGeneration++
    if (kind === 'device') f.raw.device = { queue: {} }
    if (kind === 'buffer') f.raw.curves = { size: f.raw.curveCapacity, destroy: vi.fn() }
    if (kind === 'scope') f.raw.frameScopeOpen = true
    if (kind === 'over') f.raw.activeOver = {}
    if (kind === 'lost') f.raw.lost = true
    if (kind === 'disposed') f.raw.disposed = true
    const writes = (f.device.queue as any).writeBuffer.mock.calls.length
    const discard = vi.spyOn(f.raw, 'discardByteTentEncoder')
    expect(() => f.driver.begin(vertices, f.curves)).toThrow(kind === 'lost' || kind === 'disposed' ? /设备已丢失/ : /Geometry preparation/)
    expect(f.driver.resourceEpoch).toBe(beforeEpoch)
    expect(discard).not.toHaveBeenCalled()
    expect((f.device.queue as any).writeBuffer.mock.calls).toHaveLength(writes)
    expect(f.entry.storage.destroy).not.toHaveBeenCalled()
    for (const fence of f.fences) fence.resolve(); await tick()
  })

test('queue rejection between warm preparation and begin retains all retired owners', async () => {
  const f = await warmProgramFixture()
  await f.driver.prepareFrameResources(new Float32Array(0), f.curves)
  f.fences[0].reject(Error('late image queue rejection')); await tick()
  const beforeEpoch = f.driver.resourceEpoch
  expect(() => f.driver.begin(new Float32Array(0), f.curves)).toThrow('late image queue rejection')
  expect(f.driver.resourceEpoch).toBe(beforeEpoch); expect(f.driver.completedResourceEpoch).toBe(0)
  expect(f.entry.storage.destroy).not.toHaveBeenCalled()
  expect(f.driver.hasActiveImageTableSource(f.source)).toBe(true)
  expect(f.driver.scratchBytes).toBe(f.entry.table.bytes)
})

test('miss admission rejection cannot collect retired tables or certify completion', async () => {
  const f = await warmProgramFixture(); f.raw.programGpuValid = false
  const preparation = f.driver.prepareFrameResources(new Float32Array(0), f.curves)
  await tick(); f.fences[1].reject(Error('admission queue rejection'))
  await expect(preparation).rejects.toThrow('admission queue rejection')
  expect(f.driver.completedResourceEpoch).toBe(0); expect(f.entry.storage.destroy).not.toHaveBeenCalled()
  expect(f.driver.hasActiveImageTableSource(f.source)).toBe(true)
  f.fences[0].resolve(); await tick()
})

test('older pool completion still cannot bypass current required-admission wait in the baseline policy', async () => {
  const f = fixture(), MiB = 1024 * 1024
  f.driver.resourceEpoch = 2; f.driver.completedResourceEpoch = 1
  f.renderer.frameBudget = 64 * MiB; f.renderer.bytes = 60 * MiB
  const destroy = vi.fn(), texture = { width: 2048, height: 512, bytes: 16 * MiB, resource: { destroy } } as unknown as Texture
  f.raw.textures.add(texture); f.renderer.free.set('2048:512', [texture])
  f.renderer.poolReleaseEpoch.set(texture, 1)
  f.raw.submitCommands = () => f.raw.submitQueue({})
  let returned = false
  const reclaim = f.renderer.reclaimScratch(8 * MiB).then(() => { returned = true })
  await tick()
  expect(returned).toBe(false); expect(f.fences).toHaveLength(1)
  expect(destroy).not.toHaveBeenCalled(); expect(f.renderer.bytes).toBe(60 * MiB)
  f.fences[0].resolve(); await reclaim
  expect(destroy).toHaveBeenCalledOnce(); expect(f.renderer.bytes).toBe(44 * MiB)
  expect(f.driver.completedResourceEpoch).toBe(1); expect(f.renderer.frameBudget).toBe(64 * MiB)
})

test.each(['prepare','begin'] as const)('warm geometry preserves pending validation errors before %s', async phase => {
  const f = await warmProgramFixture()
  if (phase === 'begin') await f.driver.prepareFrameResources(new Float32Array(0), f.curves)
  f.raw.errors.push('pending validation failure')
  const epoch = f.driver.resourceEpoch
  if (phase === 'prepare') await expect(f.driver.prepareFrameResources(new Float32Array(0), f.curves)).rejects.toThrow('pending validation failure')
  else expect(() => f.driver.begin(new Float32Array(0), f.curves)).toThrow('pending validation failure')
  expect(f.driver.resourceEpoch).toBe(epoch); expect(f.entry.storage.destroy).not.toHaveBeenCalled()
  f.fences[0].resolve(); await tick()
})
test('warm geometry preserves device-loss failure category before beginning', async () => {
  const f = await warmProgramFixture()
  await f.driver.prepareFrameResources(new Float32Array(0), f.curves)
  f.raw.lost = true
  let error: unknown
  try { f.driver.begin(new Float32Array(0), f.curves) } catch (caught) { error = caught }
  expect(renderFailureFields(error)).toMatchObject({ failureCategory: 4, failureCode: 30 })
  f.fences[0].resolve(); await tick()
})
