import { expect, test, vi } from 'vitest'
import { GpuRenderer } from './renderer'
import { bindScenePlan } from './scene-index'
import type { Driver, Texture } from './types'
const MiB=1024*1024

test('root cache admission is rechecked after drawing expands the live working set',async()=>{
  let covered=false
  const driver={name:'webgpu',managed:true,captureDisplay:true,scratchBytes:0,resourceEpoch:3,completedResourceEpoch:2,
    create:(width:number,height:number):Texture=>({width,height,bytes:width*height*16,resource:{}}),
    clear:vi.fn(),pass:vi.fn(),destroy:vi.fn(()=>expect(covered).toBe(true)),checkpoint:vi.fn(async()=>{covered=true})}
  const renderer=new GpuRenderer(driver as unknown as Driver,true,false) as any
  const region={x:0,y:0,w:512,h:512},small={x:0,y:0,w:1,h:1}
  const root={id:'root',rect:region,opacity:1,blend:'normal',children:[],fills:[],strokes:[],effects:[]}
  renderer.scene={extent:region,nodes:{root},roots:['root'],interactionRetained:true,coherentSamples:true,interactionSelection:['root']}
  bindScenePlan(renderer.scene,{version:1,nodes:['root'],roots:['root'],parents:[],rootFor:[['root','root']],unknownEffectSubtrees:[],imageUses:[],features:0})
  renderer.frameBudget=40*MiB+128;renderer.frameCurrent=()=>true
  const targets=Array.from({length:4},()=>renderer.acquire(small))
  renderer.drawBundle=vi.fn(async(_ids:unknown,initial:any[])=>{
    const output=Array.from({length:4},()=>renderer.acquire(region))
    const scratch=renderer.acquire({x:0,y:0,w:1280,h:1024})
    renderer.release(...initial,scratch)
    return output
  })
  const result=await renderer.drawInteractionRoots(targets)
  expect(result).toHaveLength(4)
  expect(renderer.interactionRoots.size).toBe(0)
  expect(driver.pass.mock.calls.every((call:any[])=>call[1][16]===3)).toBe(true)
  expect(renderer.workingBytes).toBeLessThanOrEqual(renderer.frameBudget)
  expect(renderer.interactionBytes).toBe(0)
})
