import { afterEach, expect, test, vi } from 'vitest'
import { sanitizeFields, setGpuDiagnosticSink } from '../../../../design-desktop/src/render-terminal-diagnostics.mjs'
import { GpuRenderer } from './renderer'
import type { Driver, Texture } from './types'
const MiB=1024*1024
afterEach(()=>{vi.unstubAllEnvs();setGpuDiagnosticSink(undefined)})
function fixture(transientBytes=3*MiB) {
  let boundary: Promise<void>=Promise.resolve()
  const driver={name:'webgpu',managed:true,captureDisplay:true,scratchBytes:0,
    resourceEpoch:12,completedResourceEpoch:11,
    rasterPacing: false, captureAdmissionCompletion: vi.fn<() => (() => boolean) | undefined>(() => undefined),
    checkpoint:vi.fn(async()=>{await boundary}),destroy:vi.fn()}
  const renderer=new GpuRenderer(driver as unknown as Driver) as any
  renderer.scene={};renderer.bytes=400*MiB
  const pool={width:1024,height:5120,bytes:80*MiB,resource:{}} as Texture
  const coordinate={width:256,height:transientBytes/4096,bytes:transientBytes,resource:{}} as Texture
  renderer.free.set('1024:5120',[pool]);renderer.coordinateMaps.add(coordinate)
  return {renderer,driver,pool,coordinate,setBoundary:(p:Promise<void>)=>{boundary=p}}
}
function retained(f:ReturnType<typeof fixture>) {
  expect(f.driver.destroy).not.toHaveBeenCalled()
  expect(f.renderer.bytes).toBe(400*MiB)
  expect(f.renderer.coordinateMaps.has(f.coordinate)).toBe(true)
  expect(f.renderer.free.get('1024:5120')).toEqual([f.pool])
  expect(f.driver.resourceEpoch).toBe(12);expect(f.driver.completedResourceEpoch).toBe(11)
}
test('native display mode defers eight small no-pressure maintenance calls without granting completion',async()=>{
  const f=fixture()
  for(let i=0;i<8;i++){await f.renderer.reclaimScratch();retained(f)}
  expect(f.driver.checkpoint).not.toHaveBeenCalled()
  expect(f.renderer.maintenanceResidency.count).toBe(8)
})
test('ninth eligible call waits before releasing transient ownership and resets only after completion',async()=>{
  const f=fixture()
  for(let i=0;i<8;i++)await f.renderer.reclaimScratch()
  let complete!:()=>void;f.setBoundary(new Promise<void>(r=>complete=r))
  const pending=f.renderer.reclaimScratch()
  expect(f.driver.checkpoint).toHaveBeenCalledTimes(1);retained(f)
  expect(f.renderer.maintenanceResidency.count).toBe(8)
  complete();await pending
  expect(f.driver.destroy).toHaveBeenCalledWith(f.coordinate)
  expect(f.renderer.coordinateMaps.has(f.coordinate)).toBe(false)
  expect(f.renderer.free.get('1024:5120')).toEqual([f.pool])
  expect(f.renderer.maintenanceResidency.count).toBe(0)
})
test('failed ninth boundary preserves all charged resources and does not reset the deferral quota',async()=>{
  const f=fixture();for(let i=0;i<8;i++)await f.renderer.reclaimScratch()
  f.driver.checkpoint.mockImplementationOnce(async()=>{throw Error('device lost')})
  await expect(f.renderer.reclaimScratch()).rejects.toThrow('device lost')
  retained(f);expect(f.renderer.maintenanceResidency.count).toBe(8)
})
test.each([1,700*MiB])('requested allocation %s retains its real admission fence',async required=>{
  const f=fixture();let complete!:()=>void
  f.setBoundary(new Promise<void>(r=>complete=r))
  const pending=f.renderer.reclaimScratch(required)
  expect(f.driver.checkpoint).toHaveBeenCalledTimes(1);retained(f)
  complete();await pending
})
test('large transient cohort still fences even in native display mode',async()=>{
  const f=fixture(65*MiB);let complete!:()=>void
  f.setBoundary(new Promise<void>(r=>complete=r))
  const pending=f.renderer.reclaimScratch()
  expect(f.driver.checkpoint).toHaveBeenCalledTimes(1);retained(f)
  complete();await pending
})
test('uncompleted external capture/readback readers retain their coordinate and ancestor handles during deferral',async()=>{
  const f=fixture(),ancestor={width:1,height:1,bytes:16,resource:{}} as Texture
  f.renderer.busy.add(ancestor)
  // Model pending consumers, not GPU pixels: a deferred maintenance call
  // cannot release either source or certify that these reads completed.
  let finishRead!:()=>void;const read=new Promise<void>(r=>finishRead=r)
  const observed=read.then(()=>[f.renderer.coordinateMaps.has(f.coordinate),f.renderer.busy.has(ancestor)])
  await f.renderer.reclaimScratch();retained(f)
  expect(f.driver.checkpoint).not.toHaveBeenCalled();finishRead()
  expect(await observed).toEqual([true,true])
})
test('unknown completion epoch remains conservative in display capture mode',async()=>{
  const f=fixture();delete (f.driver as any).completedResourceEpoch
  let complete!:()=>void;f.setBoundary(new Promise<void>(r=>complete=r))
  const pending=f.renderer.reclaimScratch()
  expect(f.driver.checkpoint).toHaveBeenCalledTimes(1)
  expect(f.driver.destroy).not.toHaveBeenCalled();expect(f.renderer.bytes).toBe(400*MiB)
  complete();await pending
})
test('cancellation before maintenance preserves resources without a new fence',async()=>{
  const f=fixture();f.renderer.frameCurrent=()=>false
  await expect(f.renderer.reclaimScratch()).rejects.toThrow('PREVIEW_CANCELLED')
  retained(f);expect(f.driver.checkpoint).not.toHaveBeenCalled()
})

test.each([0,1,700*MiB])('maintenance reason bits distinguish required/pressure from display mode: %s',async required=>{
  const events:any[]=[];setGpuDiagnosticSink((event:string,fields:any)=>{if(event==='cache')events.push(fields)})
  const f=fixture();await f.renderer.reclaimScratch(required)
  const decision=events.find(e=>e.maintenanceDecision!==undefined)
  expect(decision.mandatoryReasonBits).toBe(required===0?0:required===1?1:3)
  expect(sanitizeFields(decision).mandatoryReasonBits).toBe(decision.mandatoryReasonBits)
})
test('maintenance reason bits identify unknown epoch rather than display mode',async()=>{
  const events:any[]=[];setGpuDiagnosticSink((event:string,fields:any)=>{if(event==='cache')events.push(fields)})
  const f=fixture();delete (f.driver as any).resourceEpoch;await f.renderer.reclaimScratch()
  expect(events.find(e=>e.maintenanceDecision!==undefined)).toMatchObject({maintenanceDecision:1,mandatoryReasonBits:32})
})

test('soft trimming uses already-completed free surfaces without fencing this frame', async () => {
  const f = fixture()
  f.renderer.frameBudget = 512 * MiB
  f.renderer.poolReleaseEpoch.set(f.pool, 11)
  f.driver.rasterPacing = true
  await f.renderer.reclaimScratch()
  expect(f.driver.checkpoint).not.toHaveBeenCalled()
  expect(f.driver.destroy).toHaveBeenCalledExactlyOnceWith(f.pool)
  expect(f.renderer.coordinateMaps.has(f.coordinate)).toBe(true)
})

test('soft trimming cannot borrow completion for a surface touched by this frame', async () => {
  const f = fixture()
  f.renderer.frameBudget = 512 * MiB
  f.renderer.poolReleaseEpoch.set(f.pool, 11)
  f.renderer.used.add(f.pool)
  f.driver.rasterPacing = true
  let complete!: () => void
  f.setBoundary(new Promise<void>(resolve => { complete = resolve }))
  const pending = f.renderer.reclaimScratch()
  expect(f.driver.checkpoint).toHaveBeenCalledOnce()
  expect(f.driver.destroy).not.toHaveBeenCalled()
  complete()
  await pending
})

test('coordinate maintenance keeps one charged batch and merges later requests before completion', async () => {
  const f = fixture()
  let completed = false
  f.driver.rasterPacing = true
  f.driver.captureAdmissionCompletion = vi.fn(() => () => completed)
  const paint = {}
  f.renderer.imageGrids.set(paint, new Map([[0, { texture: f.coordinate }]]))
  for (let i = 0; i < 12; i++) await f.renderer.reclaimScratch()
  expect(f.driver.captureAdmissionCompletion).toHaveBeenCalledOnce()
  expect(f.driver.checkpoint).not.toHaveBeenCalled()
  expect(f.driver.destroy).not.toHaveBeenCalled()
  expect(f.renderer.bytes).toBe(400 * MiB)
  expect(f.renderer.imageGrids.get(paint)).toBeUndefined()
  expect(f.renderer.retiredUploads).toContain(f.coordinate)

  completed = true
  await f.renderer.reclaimScratch()
  expect(f.driver.destroy).toHaveBeenCalledExactlyOnceWith(f.coordinate)
  expect(f.renderer.retiredUploads).not.toContain(f.coordinate)
  expect(f.renderer.bytes).toBe(397 * MiB)
})

test('real allocation pressure still fences when a coordinate batch is pending', async () => {
  const f = fixture()
  f.driver.rasterPacing = true
  f.driver.captureAdmissionCompletion = vi.fn(() => () => false)
  for (let i = 0; i < 9; i++) await f.renderer.reclaimScratch()
  let complete!: () => void
  f.setBoundary(new Promise<void>(resolve => { complete = resolve }))
  const pending = f.renderer.reclaimScratch(700 * MiB)
  expect(f.driver.checkpoint).toHaveBeenCalledOnce()
  expect(f.driver.destroy).not.toHaveBeenCalled()
  complete()
  await pending
  expect(f.driver.destroy).toHaveBeenCalledWith(f.coordinate)
})

function smallCompletedPool() {
  const f = fixture()
  f.renderer.frameBudget = 512 * MiB
  f.driver.rasterPacing = true
  f.renderer.lastUsed.set(f.pool, 65)
  const small = Array.from({ length: 64 }, (_, index) => {
    const texture = { width: 128, height: 2, bytes: 4096, resource: {} } as Texture
    f.renderer.poolReleaseEpoch.set(texture, 11)
    f.renderer.lastUsed.set(texture, index + 1)
    return texture
  })
  f.renderer.free.set('128:2', [...small])
  return { ...f, small }
}

test('soft trimming retires a full completed resource batch below its byte target', async () => {
  const f = smallCompletedPool()
  await f.renderer.reclaimScratch()
  expect(f.driver.checkpoint).not.toHaveBeenCalled()
  expect(f.driver.destroy.mock.calls.map(call => call[0])).toEqual(f.small)
  expect(f.renderer.free.get('1024:5120')).toEqual([f.pool])
})

test('an incomplete batch below its byte target retains the original fence', async () => {
  const f = smallCompletedPool()
  f.renderer.poolReleaseEpoch.set(f.small[0], 12)
  let complete!: () => void
  f.setBoundary(new Promise<void>(resolve => { complete = resolve }))
  const pending = f.renderer.reclaimScratch()
  expect(f.driver.checkpoint).toHaveBeenCalledOnce()
  expect(f.driver.destroy).not.toHaveBeenCalled()
  complete()
  await pending
})

test('soft trim releases completed pool bytes while a separate coordinate batch stays charged', async () => {
  const f = smallCompletedPool()
  f.renderer.frameBudget = 768 * MiB
  let completed = false
  f.driver.captureAdmissionCompletion = vi.fn(() => () => completed)
  for (let i = 0; i < 9; i++) await f.renderer.reclaimScratch()
  expect(f.renderer.retiredUploads).toContain(f.coordinate)
  expect(f.driver.destroy).not.toHaveBeenCalled()
  f.renderer.frameBudget = 512 * MiB
  await f.renderer.reclaimScratch()
  expect(f.driver.checkpoint).not.toHaveBeenCalled()
  expect(f.driver.destroy.mock.calls.map(call => call[0])).toEqual(f.small)
  expect(f.renderer.retiredUploads).toContain(f.coordinate)
  expect(f.renderer.bytes).toBe(400 * MiB - 64 * 4096)
  completed = true
  await f.renderer.reclaimScratch()
  expect(f.driver.destroy).toHaveBeenLastCalledWith(f.coordinate)
})
