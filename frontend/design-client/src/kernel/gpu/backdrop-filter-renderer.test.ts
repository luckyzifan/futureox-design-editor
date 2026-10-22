import { afterEach, expect, test, vi } from 'vitest'
import { GpuRenderer, type Surface } from './renderer'
import type { Driver, GpuNode, Rect, Texture } from './types'

afterEach(()=>vi.unstubAllEnvs())
function fixture(){
  vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX','1')
  const driver={name:'webgpu',managed:true,scratchBytes:0,create:(width:number,height:number)=>
    ({width,height,bytes:width*height*16,resource:{}} as Texture),copyRegion:vi.fn(),clear(){},destroy:vi.fn()}
  const renderer=new GpuRenderer(driver as unknown as Driver) as any
  renderer.scene={integratedBlur:true}
  renderer.reclaimScratch=vi.fn(async()=>{})
  renderer.yieldEncoding=()=>undefined
  renderer.blur=vi.fn(()=>{throw Error('old-full-capture')})
  renderer.exactTentAxis=vi.fn((_input:Surface,_radius:number,_axis:number,output:Rect)=>renderer.acquire(output))
  const input=renderer.acquire({x:-1797.8828125,y:964.162109375,w:3659,h:1857})
  const node={rect:{x:-1797,y:-837,w:3658,h:3658},backdropOutputBox:[-2,958,68,68]} as GpuNode
  return{renderer,driver,input,node,run:()=>renderer.blurBackdropRegion(input,1177.21484375/2,node)}
}
test('native-consumer backdrop uses bounded bit-preserving strips and keeps original capture phase/clamp',async()=>{
  const f=fixture(),result=await f.run()
  expect(result.rect).toEqual({x:-4.8828125,y:964.162109375,w:73,h:64})
  expect(f.renderer.backdropConsumptionRect(f.node,result)).toEqual({x:-2,y:958,w:68,h:68})
  expect(f.renderer.blur).not.toHaveBeenCalled()
  expect(f.renderer.exactTentAxis).toHaveBeenCalledTimes(32)
  expect(f.driver.copyRegion).toHaveBeenCalledTimes(32)
  for(const call of f.renderer.exactTentAxis.mock.calls){
    expect(call[1]).toBe(1177.21484375);expect(call[5]).toBe(true)
    expect(Math.min(call[3].w,call[3].h)).toBeLessThanOrEqual(64)
  }
  expect(f.renderer.backdropRegionBuilds).toBe(1)
  expect(f.renderer.bytes).toBeLessThan(112*1024*1024)
  f.renderer.release(result)
  expect([...f.renderer.busy]).toEqual([f.input.texture])
})
test('cancellation after an awaited admission encodes no stale next strip and releases only private outputs',async()=>{
  const f=fixture();let current=true,calls=0
  f.renderer.frameCurrent=()=>current
  f.renderer.reclaimScratch=vi.fn(async()=>{if(++calls===3)current=false})
  await expect(f.run()).rejects.toThrow('PREVIEW_CANCELLED')
  expect(f.renderer.exactTentAxis).toHaveBeenCalledTimes(1)
  expect([...f.renderer.busy]).toEqual([f.input.texture])
  expect(f.driver.destroy).not.toHaveBeenCalled()
  expect(f.renderer.backdropRegionBuilds).toBe(0)
})
test.each(['disabled','no-certificate','invalid-phase','interaction'] as const)('unsupported %s retains old exact full-capture path',async kind=>{
  const f=fixture()
  if(kind==='disabled')vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX','0')
  if(kind==='no-certificate')delete f.node.backdropOutputBox
  if(kind==='invalid-phase'){
    f.input.rect.x=-9280.606143;f.input.rect.w=16000
    f.node.backdropOutputBox=[-1280,958,64,68]
  }
  if(kind==='interaction')f.renderer.scene.interactionRetained=true
  await expect(f.run()).rejects.toThrow('old-full-capture')
  expect(f.renderer.exactTentAxis).not.toHaveBeenCalled()
  expect(f.driver.copyRegion).not.toHaveBeenCalled()
})
