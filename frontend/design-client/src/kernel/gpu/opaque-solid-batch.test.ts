import {expect,test,vi} from 'vitest'
import {WebGpuDriver} from './webgpu'
import {ResidentPrograms} from './resident-programs'
import {SampleOnlyAreaPrograms} from './sample-only-area-programs'
import type {PathMesh} from './types'

function fixture(){
  const path:PathMesh={first:0,count:3,rule:'nonzero',sampleCount:4,rect:{x:-13,y:29,w:8,h:2},area:{first:0,count:7,fingerprint:[11,12]}}
  const source=new Float32Array(28);source.set([4,0,8,2,0,8,0,0,0,2,0,0])
  const arena=new ResidentPrograms(),resident=arena.plan(source,[path.area!])!,buffer={},proof=new SampleOnlyAreaPrograms()
  proof.bind(resident.words,resident.offsets,[path.area!],buffer,1)
  const driver:any=Object.assign(Object.create(WebGpuDriver.prototype),{opaqueSolidRequested:true,opaqueSolidPipeline:{},curves:buffer,
    resourceEpoch:1,opaqueSolidBatches:new WeakMap(),sampleOnlyPrograms:proof,programOffsets:resident.offsets,
    solidData:new Float32Array(20*8),solidOffset:0,solidRanges:new Map(),opaqueSolidDraws:0,drawSolidInstances:vi.fn()})
  const nodes=Array.from({length:8},()=>({path,bounds:path.rect})),target={width:8,height:2}
  const prepare=()=>driver.prepareOpaqueSolids(nodes,path.rect,[.2,.4,-0,1])
  return {driver,path,nodes,target,prepare}
}
test('batch retains private input bytes and uses all four original coverage phases',()=>{
  const f=fixture(),batch=f.prepare();expect(batch).toMatchObject({count:8,pixels:128});expect(Object.isFrozen(batch)).toBe(true)
  f.path.rect.x=99
  for(let i=0;i<4;i++)expect(f.driver.drawOpaqueSolids(batch,f.target,i)).toBe(true)
  expect(f.driver.drawSolidInstances).toHaveBeenCalledTimes(4)
  const calls=f.driver.drawSolidInstances.mock.calls
  expect(calls.map((c:any[])=>c[1][37])).toEqual([0,1,2,3]);expect(calls[0][2][0]).toBe(-13)
  expect(Object.is(calls[0][2][14],-0)).toBe(false)
})
test('capacity, incomplete sample proof, nonfinite and translucent colors fall back before GPU commands',()=>{
  const f=fixture();f.driver.solidOffset=20;expect(f.prepare()).toBeUndefined();f.driver.solidOffset=0
  for(const color of [[1,1,1,.9],[NaN,1,1,1],[Infinity,1,1,1],[1e40,1,1,1]])
    expect(f.driver.prepareOpaqueSolids(f.nodes,f.path.rect,color)).toBeUndefined()
  f.path.sampleCount=16;expect(f.prepare()).toBeUndefined();f.path.sampleCount=4
  f.path.rect.x+=.1;expect(f.prepare()).toBeUndefined()
  expect(f.driver.drawSolidInstances).not.toHaveBeenCalled()
})
test('foreign handles, expired frames, changed programs, loss and exhausted arena cannot submit',()=>{
  const f=fixture(),batch=f.prepare()
  expect(f.driver.drawOpaqueSolids({...batch},f.target,0)).toBe(false)
  for(const sample of [-1,.5,4,NaN])expect(f.driver.drawOpaqueSolids(batch,f.target,sample)).toBe(false)
  expect(f.driver.drawOpaqueSolids(batch,{width:9,height:2},0)).toBe(false)
  for(const [key,value]of [['resourceEpoch',2],['curves',{}],['lost',true],['disposed',true],['solidOffset',20]] as const){
    const old=f.driver[key];f.driver[key]=value;expect(f.driver.drawOpaqueSolids(batch,f.target,0)).toBe(false);f.driver[key]=old
  }
  expect(f.driver.drawSolidInstances).not.toHaveBeenCalled()
})
