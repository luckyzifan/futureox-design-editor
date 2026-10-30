import { expect, test, vi } from 'vitest'
import { GpuRenderer } from './renderer'
import { bindScenePlan } from './scene-index'
import type { Driver, GpuScene, Texture } from './types'

test.each([false,true])('physical one-texel page background initializes outside the interaction scissor (authored transparent=%s)',async transparent=>{
  const passes:{mode:number;region:unknown;target:Texture;input:Texture[];color:number[]}[]=[]
  const driver={name:'webgpu',managed:true,captureDisplay:true,constantTextureSampling:true,scratchBytes:0,drawCalls:0,triangles:0,
    create:(width:number,height:number):Texture=>({width,height,bytes:width*height*16,resource:{}}),
    destroy:vi.fn(),clear:vi.fn(),begin:vi.fn(),
    pass(target:Texture,u:Float32Array,input:Texture[],region:unknown){passes.push({mode:u[16],region,target,input,color:[...u.slice(48,52)]})},
    finish:vi.fn(async()=>({buffer:new ArrayBuffer(0)})),end:vi.fn()}
  const renderer=new GpuRenderer(driver as unknown as Driver,true,false)
  const scene={version:7,width:96,height:96,extent:{x:0,y:0,w:96,h:96},nodes:{},roots:[],vertices:[],curves:[],colors:{},
    view:{x:0,y:0,zoom:1},background:'#ffffff',transparent,grid:false,checkerboard:false,
    floatCompositing:true,coherentSamples:true,interactionRetained:true,nativeInteraction:true,
    interactionWindow:{x:16,y:16,w:32,h:32}} as unknown as GpuScene
  bindScenePlan(scene,{version:1,nodes:[],roots:[],parents:[],rootFor:[],unknownEffectSubtrees:[],imageUses:[],features:0})
  await (renderer as any).renderAttempt(scene,false,true)
  const background=passes.find(pass=>pass.mode===12)
  expect(background).toBeDefined()
  expect(background!.target.width).toBe(1);expect(background!.target.height).toBe(1)
  expect(background!.region).toBeUndefined()
  expect(background!.color).toEqual([1,1,1,transparent?0:1])
  expect(driver.clear).not.toHaveBeenCalled()
  expect(passes.find(pass=>pass.mode===23)!.input.every(texture=>texture===background!.target)).toBe(true)
})
