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

test('allocation pressure retires enough completed pool surfaces without a new fence', async () => {
  const { renderer, driver, pool, coordinate } = fixture()
  renderer.coordinateMaps.delete(coordinate)
  renderer.frameBudget = 512 * MiB
  renderer.bytes = 500 * MiB
  const queued = { ...pool, resource: {} }
  const pinned = { ...pool, resource: {} }
  renderer.free.set('1024:5120', [queued, pinned, pool])
  renderer.poolReleaseEpoch.set(queued, 12)
  renderer.poolReleaseEpoch.set(pinned, 11)
  renderer.poolReleaseEpoch.set(pool, 11)
  renderer.admissionPins.set(pinned, 1)

  await renderer.reclaimScratch(48 * MiB)

  expect(driver.checkpoint).not.toHaveBeenCalled()
  expect(driver.destroy.mock.calls).toEqual([[pool]])
  expect(renderer.free.get('1024:5120')).toEqual([queued, pinned])
  expect(renderer.bytes).toBe(420 * MiB)
  expect(driver.completedResourceEpoch).toBe(11)
})

test.each([undefined, 12])('allocation pressure waits when free pool completion is %s', async epoch => {
  const f = fixture()
  f.renderer.coordinateMaps.delete(f.coordinate)
  f.renderer.frameBudget = 512 * MiB
  f.renderer.bytes = 500 * MiB
  if (epoch !== undefined) f.renderer.poolReleaseEpoch.set(f.pool, epoch)
  let complete!: () => void
  f.setBoundary(new Promise<void>(resolve => { complete = resolve }))

  const pending = f.renderer.reclaimScratch(48 * MiB)
  expect(f.driver.checkpoint).toHaveBeenCalledOnce()
  expect(f.driver.destroy).not.toHaveBeenCalled()
  complete()
  await pending
  expect(f.driver.destroy).toHaveBeenCalledWith(f.pool)
})

test('the soft pool watermark reclaims completed surfaces without stalling the current tile', async () => {
  const { renderer, driver, pool, coordinate } = fixture()
  renderer.coordinateMaps.delete(coordinate)
  renderer.residentImageRequest = true
  renderer.frameBudget = 512 * MiB
  renderer.bytes = 465 * MiB
  renderer.free.clear()
  renderer.free.setOwned('1024:5120', [pool])
  renderer.free.added(pool)
  renderer.touch(pool)
  renderer.poolReleaseEpoch.set(pool, 11)

  await renderer.reclaimScratch()

  expect(driver.checkpoint).not.toHaveBeenCalled()
  expect(driver.destroy.mock.calls).toEqual([[pool]])
  expect(renderer.bytes).toBe(385 * MiB)
  expect(driver.completedResourceEpoch).toBe(11)
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
