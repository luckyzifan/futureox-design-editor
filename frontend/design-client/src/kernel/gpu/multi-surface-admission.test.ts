import { expect, test, vi } from 'vitest'
import { GpuRenderer } from './renderer'
import type { Driver, Texture } from './types'

const MiB=1024*1024
function fixture(indexed=false) {
  let complete!:()=>void, reject!:(error:Error)=>void, current=true, done=false
  const create=(width:number,height:number):Texture=>({width,height,bytes:width*height*16,resource:{}})
  const driver={name:'webgpu',managed:true,scratchBytes:0,resourceEpoch:7,completedResourceEpoch:6,
    create:vi.fn(create),destroy:vi.fn((_texture:Texture)=>expect(done).toBe(true)),
    checkpoint:vi.fn(async()=>{await new Promise<void>((resolve,fail)=>{complete=resolve;reject=fail});done=true})}
  const renderer=new GpuRenderer(driver as unknown as Driver,true,false) as any
  renderer.scene={};renderer.frameBudget=144*MiB;renderer.frameCurrent=()=>current
  const reusable=create(2048,2048),other=create(4096,1024),active=create(1024,1024)
  renderer.bytes=reusable.bytes+other.bytes+active.bytes
  if(indexed){
    renderer.busy.add(reusable);renderer.busy.add(other)
    renderer.release({texture:reusable,rect:{x:0,y:0,w:2048,h:2048}},{texture:other,rect:{x:0,y:0,w:4096,h:1024}})
    expect(renderer.free.capture(renderer.admissionPins).textures).toEqual([reusable,other])
  }else{
    renderer.free.set('2048:2048',[reusable]);renderer.free.set('4096:1024',[other])
    expect(renderer.free.capture(renderer.admissionPins)).toBeUndefined()
  }
  renderer.used.add(reusable);renderer.used.add(other);renderer.used.add(active);renderer.busy.add(active)
  renderer.lastUsed.set(reusable,1);renderer.lastUsed.set(other,2)
  renderer.poolReleaseEpoch.set(reusable,7);renderer.poolReleaseEpoch.set(other,7)
  return {renderer,driver,reusable,other,active,r:{x:0,y:0,w:2048,h:2048},
    complete:()=>complete(),reject:()=>reject(Error('uncertain queue')),cancel:()=>{current=false}}
}

test.each([false,true])('one oldest matching pool surface survives admission for two outputs at the original budget (indexed=%s)',async indexed=>{
  const f=fixture(indexed),pending=f.renderer.reclaimForSurface(f.r,2)
  expect(f.driver.checkpoint).toHaveBeenCalledOnce();expect(f.driver.destroy).not.toHaveBeenCalled()
  f.complete();await pending
  const first=f.renderer.acquire(f.r),second=f.renderer.acquire(f.r)
  expect(first.texture).toBe(f.reusable);expect(second.texture).not.toBe(first.texture)
  expect(f.driver.destroy).toHaveBeenCalledExactlyOnceWith(f.other)
  expect(f.driver.create).toHaveBeenCalledExactlyOnceWith(2048,2048)
  expect(f.renderer.bytes).toBe(144*MiB);expect(f.renderer.frameBudget).toBe(144*MiB)
  expect(f.renderer.admissionPins.size).toBe(0);expect(f.renderer.busy.has(f.active)).toBe(true)
})

test.each([['cancel',false],['cancel',true],['uncertain-fence',false],['uncertain-fence',true]] as const)('multi-copy %s indexed=%s releases only its temporary pins',async (boundary,indexed)=>{
  const f=fixture(indexed),pending=f.renderer.reclaimForSurface(f.r,2)
  expect(f.renderer.admissionPins.has(f.reusable)).toBe(true)
  if(boundary==='cancel'){f.cancel();f.complete()}else f.reject()
  await expect(pending).rejects.toThrow(boundary==='cancel'?'PREVIEW_CANCELLED':'uncertain queue')
  expect(f.renderer.admissionPins.size).toBe(0)
  expect(f.driver.destroy.mock.calls.some(([t])=>t===f.reusable)).toBe(false)
  expect(f.renderer.free.get('2048:2048')).toEqual([f.reusable])
  expect(f.renderer.busy.has(f.active)).toBe(true)
})

test('a caller pin remains owned after nested preflight and complete reuse takes no fence',async()=>{
  const f=fixture();f.renderer.admissionPins.set(f.reusable,3)
  const pending=f.renderer.reclaimForSurface(f.r,2);f.complete();await pending
  expect(f.renderer.admissionPins.get(f.reusable)).toBe(3)
  await f.renderer.reclaimForSurface(f.r,1)
  expect(f.driver.checkpoint).toHaveBeenCalledOnce()
})
