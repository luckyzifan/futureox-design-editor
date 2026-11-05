import {expect,test,vi} from 'vitest'
import {GpuRenderer} from './renderer'
import type {SourceFilterField} from './types'

const rect={x:4,y:-3,w:128,h:96}
const field:SourceFilterField={factor:8,effectIndex:0,sharpHalo:0,radius:4,gaussian:false,input:rect,output:rect,masks:[]}
const shadow={kind:'inner-shadow',spread:0,visible:true}
async function evaluate(plan:SourceFilterField,effects=[shadow],current=true){
  // Stop at the first real raster operation. A source plan which needs its
  // group/prefix/coverage must reach it, even when its own mask array is empty.
  const sentinel=Error('ordinary raster'),zero={texture:{transparentZero:true,width:1,height:1},rect}
  const owner={driver:{zeroTextureSampling:true,sourceImageLimit:8192},sourceTileOcclusion:true,allowSolidBatch:false,
    checkFrameCurrent:()=>{if(!current)throw Error('PREVIEW_CANCELLED')},
    empty:vi.fn(()=>zero),release(){},drawBundle:()=>{throw sentinel},run:()=>{throw sentinel},
    applySampleEffects:()=>{throw sentinel},reclaimForSurface:()=>{throw sentinel}}
  return (GpuRenderer.prototype as any).sampleSourceFilter.call(owner,
    {effects,matrix:[1,0,0,1,0,0],inverse:[1,0,0,1,0,0],sourceFilterField:plan},plan)
}
test('only a validated empty shadow with no group, spread or preceding effect borrows zero',async()=>{
  expect((await evaluate(field)).texture.width).toBe(1)
  for(const [plan,effects] of [
    [{...field,groupRoots:['visible-source']},[shadow]], [{...field,effectIndex:1},[shadow,shadow]],
    [{...field,masks:[{opacity:1,path:{count:0,rect}}]},[shadow]],
    [field,[{...shadow,spread:3}]], [field,[{...shadow,kind:'gaussian-blur'}]],
    [{...field,output:{...rect,w:16384}},[shadow]],
  ] as [SourceFilterField,typeof shadow[]][])await expect(evaluate(plan,effects)).rejects.toThrow('ordinary raster')
  await expect(evaluate({...field,factor:3})).rejects.toThrow('Invalid source shadow sampling window')
  await expect(evaluate(field,[shadow],false)).rejects.toThrow('PREVIEW_CANCELLED')
})
