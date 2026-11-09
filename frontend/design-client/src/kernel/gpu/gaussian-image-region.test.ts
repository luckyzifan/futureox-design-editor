import { expect, test, vi } from 'vitest'
import { GpuRenderer } from './renderer'
import type { Driver, GpuNode, Rect, Texture } from './types'
import type { Surface } from './renderer'

test.each([false,true])('image Gaussian strips retain phase/coordinate ownership and cancel cleanly (cancel=%s)',async(cancel)=>{
  let sequence=0
  const driver={managed:true,name:'webgpu',supportsGaussianRegions:()=>true,copyRegion:vi.fn(),mask:vi.fn(),
    create:(width:number,height:number)=>({width,height,bytes:width*height*16,resource:{id:++sequence}} as unknown as Texture),
    createBinaryCoverage:(width:number,height:number)=>({width,height,bytes:width*height*4,binaryCoverage:true,resource:{id:++sequence}} as unknown as Texture),
    clear(){},destroy(){},dispose(){}} as unknown as Driver
  const renderer=new GpuRenderer(driver,true,false) as any
  const output={x:0,y:0,w:24,h:96},source={x:-6,y:-6,w:36,h:108},paint={kind:'image',visible:true,opacity:1,image:'owned-image',blend:'normal'}
  const node={id:'image',rect:source,matrix:[-1,0,0,1,100.125,0],size:[120,100],children:[],strokes:[],fills:[paint],
    fill:{count:3,area:{first:0,count:1},rect:source},effects:[{kind:'gaussian-blur',radius:600,visible:true}],
    gaussianRegion:{source,output,radii:[2,2,2]}} as unknown as GpuNode
  renderer.scene={coherentSamples:true};renderer.curveBits=new Uint32Array(new Float32Array([3]).buffer)
  renderer.reclaimForSurface=async()=>{};renderer.yieldEncoding=async()=>{}
  renderer.filterKernel=()=>({texture:{width:1,height:1,bytes:16,resource:{}},rect:{x:0,y:0,w:1,h:1}})
  const resolved:number[]=[],seen:{paint:object;sample:number;rect:Rect}[]=[]
  renderer.run=(mode:number,r:Rect,_inputs:Surface[],configure?:(u:Float32Array)=>void)=>{
    const u=new Float32Array(256);configure?.(u)
    if(mode===48)resolved.push(u[17])
    return renderer.acquire(r)
  }
  renderer.paintOver=(n:GpuNode,p:object,_mask:Surface,layer:Surface)=>{
    seen.push({paint:p,sample:renderer.sampleIndex,rect:n.rect})
    renderer.setImageGrid(p,renderer.sampleIndex,layer)
    if(cancel&&seen.length===2)throw Error('PREVIEW_CANCELLED')
    return layer
  }
  if(cancel){
    try{
      await expect(renderer.streamedGaussian(node)).rejects.toThrow('PREVIEW_CANCELLED')
      expect(renderer.imageGrids.size).toBe(0)
      expect(renderer.busy.size).toBe(0)
      expect(renderer.sampleIndex).toBeUndefined()
      expect(renderer.interactionCapturing).toBe(false)
    }finally{renderer.dispose()}
    return
  }
  const result=await renderer.streamedGaussian(node)
  try{
    expect(result.rect).toEqual(output)
    expect(resolved).toEqual([0,1,2,3,0,1,2,3])
    expect(new Set(seen.slice(0,4).map(x=>x.paint)).size).toBe(1)
    expect(seen[0].paint).not.toBe(seen[4].paint)
    expect(seen.every(x=>x.paint!==paint)).toBe(true)
    expect(seen[0].rect).toEqual({...source,h:64})
    expect(seen[4].rect).toEqual({...source,y:58,h:44})
    expect(renderer.imageGrids.size).toBe(0)
    expect(node.fills).toEqual([paint])
  }finally{renderer.release(result);renderer.dispose()}
})
