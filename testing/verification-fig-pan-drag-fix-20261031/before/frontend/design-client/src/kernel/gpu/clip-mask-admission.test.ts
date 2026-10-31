import { expect, test, vi } from 'vitest'
import { GpuRenderer } from './renderer'
import type { Driver, Texture } from './types'

const MiB=1024*1024
function fixture(){
  let complete!:()=>void,covered=false,current=true
  const create=(width:number,height:number):Texture=>({width,height,bytes:width*height*16,resource:{}})
  const driver={name:'webgpu',managed:true,captureDisplay:true,scratchBytes:0,resourceEpoch:3,completedResourceEpoch:2,
    create,clear:vi.fn(),pass:vi.fn(),destroy:vi.fn(()=>expect(covered).toBe(true)),
    checkpoint:vi.fn(async()=>{await new Promise<void>(resolve=>{complete=resolve});covered=true})}
  const renderer=new GpuRenderer(driver as unknown as Driver,true,false) as any
  const bounds={x:0,y:0,w:512,h:512}
  renderer.scene={extent:bounds,coherentSamples:true,nodes:{clip:{id:'clip',rect:bounds,opacity:1,blend:'normal',passthrough:true,
    clip:true,children:[],fills:[],strokes:[],effects:[]}},roots:['clip']}
  renderer.frameBudget=40*MiB;renderer.frameCurrent=()=>current
  const targets=Array.from({length:4},()=>renderer.acquire(bounds))
  const pooled=create(1024,1536);renderer.free.set('1024:1536',[pooled]);renderer.used.add(pooled)
  renderer.poolReleaseEpoch.set(pooled,3);renderer.bytes+=pooled.bytes
  renderer.yieldEncoding=()=>undefined
  // Geometry is already prepared; the production drawBundle, four combines,
  // allocation, pool accounting and completion fence remain under test.
  renderer.nodeMask=()=>targets[renderer.sampleIndex]
  return {renderer,driver,targets,pooled,complete:()=>complete(),cancel:()=>{current=false}}
}

test('nested four-sample clipping admits the entire simultaneous mask group before allocating it',async()=>{
  const f=fixture(),pending=f.renderer.drawBundle(['clip'],f.targets,f.targets)
  // Observe rejection without creating an unhandled rejection on the baseline.
  const outcome=pending.then((value:unknown)=>({value}), (error:unknown)=>({error}))
  for(let i=0;i<40&&!f.driver.checkpoint.mock.calls.length;i++)await Promise.resolve()
  if(!f.driver.checkpoint.mock.calls.length)expect(String((await outcome as {error?:unknown}).error)).toContain('GPU 表面内存预算超限')
  expect(f.driver.checkpoint).toHaveBeenCalledOnce()
  expect(f.driver.pass).not.toHaveBeenCalled();expect(f.driver.destroy).not.toHaveBeenCalled()
  f.complete();const result=await outcome
  expect(result).not.toHaveProperty('error')
  expect(f.driver.pass).toHaveBeenCalledTimes(4)
  expect(f.driver.destroy).toHaveBeenCalledExactlyOnceWith(f.pooled)
  expect(f.renderer.bytes).toBe(32*MiB)
  expect(f.targets.every((s:any)=>f.renderer.busy.has(s.texture))).toBe(true)
})

test('cancelling clip-mask admission does not encode a partial replacement group',async()=>{
  const f=fixture(),pending=f.renderer.drawBundle(['clip'],f.targets,f.targets)
  const outcome=pending.then(()=>undefined,(error:unknown)=>error)
  for(let i=0;i<40&&!f.driver.checkpoint.mock.calls.length;i++)await Promise.resolve()
  if(!f.driver.checkpoint.mock.calls.length)expect(String(await outcome)).toContain('GPU 表面内存预算超限')
  expect(f.driver.checkpoint).toHaveBeenCalledOnce()
  f.cancel();f.complete()
  expect(String(await outcome)).toContain('PREVIEW_CANCELLED')
  expect(f.driver.pass).not.toHaveBeenCalled()
  expect(f.targets.every((s:any)=>f.renderer.busy.has(s.texture))).toBe(true)
})
