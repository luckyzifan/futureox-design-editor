import { afterEach, expect, test, vi } from 'vitest'
import { GpuRenderer } from './renderer'
import type { Driver, Texture } from './types'
import { SurfaceAllocationSite } from '../../../../design-desktop/src/render-surface-ledger.mjs'
import { setGpuDiagnosticSink, sanitizeFields } from '../../../../design-desktop/src/render-terminal-diagnostics.mjs'
import { renderFailureFields } from '../render-failure-telemetry'
import { renderErrorWithBudget } from '../render-diagnostics'
afterEach(()=>setGpuDiagnosticSink(undefined))
const rect=(w:number,h:number)=>({x:0,y:0,w,h})
function setup(){
 const driver={name:'webgpu',managed:true,scratchBytes:0,resourceEpoch:10,completedResourceEpoch:9,
  create:vi.fn((width:number,height:number):Texture=>({width,height,bytes:width*height*16,resource:{} as GPUTexture})),destroy:vi.fn(),clear:vi.fn()} as unknown as Driver
 const renderer=new GpuRenderer(driver) as any;renderer.scene={coherentSamples:true};renderer.frameBudget=512
 return {driver,renderer}
}
function rejected(work:()=>unknown){try{work()}catch(error){return error}throw Error('Expected real allocation rejection')}
test('actual acquire rejection snapshots unique busy/free/used/alias roles before recovery',()=>{
 setGpuDiagnosticSink(()=>{});const {driver,renderer}=setup()
 const a=renderer.acquire(rect(4,4),false,false,SurfaceAllocationSite.passOutput,22)
 renderer.retain(a);renderer.retain(a)
 const b=renderer.acquire(rect(4,2),false,false,SurfaceAllocationSite.empty);renderer.release(b)
 const error=rejected(()=>renderer.acquire(rect(8,8),false,false,SurfaceAllocationSite.boundedImageOutput))
 const fields=renderFailureFields(error)
 expect(fields).toMatchObject({failureCode:20,failureAllocationKind:1,failureAllocationCallsite:8,failureAllocationRole:4,
  failureRequestedBytes:1024,failureWorkingBytes:384,failureBudgetBytes:512,failureSurfaceUniqueCount:2,
  failureSurfaceUniqueBytes:384,failureSurfaceBusyBytes:256,failureSurfaceFreeBytes:128,
  failureSurfaceUsedBytes:384,failureSurfacePinnedBytes:256,failureSurfaceAliasProtectedBytes:256,
  failureSurfacePoolPendingBytes:128,failureSurfaceClass8Bytes:256,failureSurfaceClass7Bytes:128,
  failureSurfaceRole2Bytes:256,failureSurfaceRole1Bytes:128,failureSurfaceLargestPassMode:23,
  failureSurfaceScanTruncated:0,failureSurfaceLedgerResidualBytes:0})
 expect(driver.create).toHaveBeenCalledTimes(2);expect(driver.destroy).not.toHaveBeenCalled()
 renderer.busy.clear();renderer.free.clear();renderer.used.clear();renderer.bytes=0
 expect(renderFailureFields(renderErrorWithBudget(error))).toMatchObject(fields)
 expect(sanitizeFields(fields)).toEqual(fields)
})
test('real run rejection carries requested pass mode before any output was created',()=>{
 setGpuDiagnosticSink(()=>{});const {driver,renderer}=setup()
 const error=rejected(()=>renderer.run(22,rect(8,8),[]))
 expect(renderFailureFields(error)).toMatchObject({failureAllocationCallsite:5,failureAllocationRole:2,failureAllocationPassMode:23})
 expect(driver.create).not.toHaveBeenCalled();expect(driver.destroy).not.toHaveBeenCalled()
})
test('reused pool texture receives a fresh diagnostic role without changing physical allocation',()=>{
 setGpuDiagnosticSink(()=>{});const {driver,renderer}=setup()
 const a=renderer.acquire(rect(4,4),false,false,SurfaceAllocationSite.empty);renderer.release(a)
 const b=renderer.acquire(rect(4,4),false,false,SurfaceAllocationSite.textureReplayOutput)
 expect(b.texture).toBe(a.texture);expect(driver.create).toHaveBeenCalledTimes(1)
 const error=rejected(()=>renderer.acquire(rect(8,8)))
 expect(renderFailureFields(error)).toMatchObject({failureSurfaceUniqueCount:1,failureSurfaceRole7Bytes:256,failureSurfaceLargestCallsite:28})
 expect(renderFailureFields(error)).not.toHaveProperty('failureSurfaceRole1Bytes')
})
test('actual rejection remains authoritative when the optional inventory cannot be read',()=>{
 setGpuDiagnosticSink(()=>{});const {renderer}=setup()
 renderer.busy={size:0,[Symbol.iterator](){throw Error('private document')}}
 const error=rejected(()=>renderer.acquire(rect(8,8),false,false,SurfaceAllocationSite.empty))
 expect(error).toBeInstanceOf(Error)
 expect(renderFailureFields(error)).toMatchObject({failureCode:20,failureRequestedBytes:1024,
  failureAllocationCallsite:2,failureSurfaceScanError:1,failureSurfaceScanTruncated:1})
 expect(JSON.stringify(renderFailureFields(error))).not.toContain('private')
})
test('disabled diagnostics performs neither inventory scan nor allocation metadata writes',()=>{
 const {renderer}=setup();const scan=vi.fn(()=>{throw Error('must not scan')});renderer.surfaceFailureSnapshot=scan
 const set=vi.fn();renderer.surfaceAllocationTags={set}
 renderer.acquire(rect(4,4),false,false,SurfaceAllocationSite.empty)
 const error=rejected(()=>renderer.acquire(rect(8,8)))
 expect(renderFailureFields(error)).toMatchObject({failureCode:20});expect(scan).not.toHaveBeenCalled();expect(set).not.toHaveBeenCalled()
 expect(renderFailureFields(error)).not.toHaveProperty('failureSurfaceSnapshotVersion')
})
