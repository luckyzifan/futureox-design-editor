import {expect, test, vi} from 'vitest'
import {WebGpuDriver} from './webgpu'
import {DENSE_PAINT_MODE} from './dense-paint-shader'
import {parameters, type Texture} from './types'

function fixture() {
  const rect={x:17,y:-3,w:8,h:6}
  const make=()=>({width:8,height:6,bytes:768,resource:{format:'rgba32float',width:8,height:6}} as unknown as Texture)
  const a=make(), b=make(), atlas=make(), source=make()
  const renderPass={setPipeline:vi.fn(),setBindGroup:vi.fn(),draw:vi.fn(),end:vi.fn()}
  const beginRenderPass=vi.fn(()=>renderPass)
  const driver=Object.assign(Object.create(WebGpuDriver.prototype),{
    densePairPipeline:{},curves:{},disposed:false,lost:false,textures:new Set([a,b,atlas,source]),
    byteTentTextures:new WeakMap([a,b].map(t=>[t,{resource:t.resource,format:'rgba32float'}])),
    closeOver:vi.fn(),invalidateTextureCertificates:vi.fn(),bind:()=>({group:{},offsets:[0]}),
    bindingCache:{view:(v:unknown)=>v},encoder:{beginRenderPass},noteDraw:vi.fn(),triangles:0,
  }) as WebGpuDriver
  const u=parameters(rect,rect,rect,rect)
  u.set([DENSE_PAINT_MODE,1,2,0,0],16)
  return {a,b,atlas,source,u,driver,beginRenderPass,renderPass}
}

test('two distinct color attachments can read one immutable backdrop',()=>{
  const {a,b,atlas,source,u,driver,renderPass,beginRenderPass}=fixture()
  expect(driver.drawDensePair([a,b],[source,source],atlas,u)).toBe(true)
  expect(beginRenderPass).toHaveBeenCalledOnce()
  expect(renderPass.draw).toHaveBeenCalledWith(3)
  expect(renderPass.end).toHaveBeenCalledOnce()
})

test('reject aliasing, invalid phases or program addresses, and a changed physical extent before encoding',()=>{
  const {a,b,atlas,source,u,driver,beginRenderPass}=fixture()
  expect(driver.drawDensePair([a,a],[source,source],atlas,u)).toBe(false)
  expect(driver.drawDensePair([a,b],[a,source],atlas,u)).toBe(false)
  u[18]=1
  expect(driver.drawDensePair([a,b],[source,source],atlas,u)).toBe(false)
  u[18]=0;u[20]=48
  expect(driver.drawDensePair([a,b],[source,source],atlas,u)).toBe(false)
  u[20]=0
  Object.defineProperty(b.resource,'height',{value:7})
  expect(driver.drawDensePair([a,b],[source,source],atlas,u)).toBe(false)
  expect(beginRenderPass).not.toHaveBeenCalled()
})
