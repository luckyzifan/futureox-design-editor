import {afterEach,expect,test,vi} from 'vitest'
import {GpuRenderer} from './renderer'
import {analyticSolidLeaf,planAnalyticSolidBatches,packAnalyticSolids,ANALYTIC_SOLID_FLOATS} from './analytic-solid-batch'
import {sourcePainterOrder} from './opaque-painter-prefix'
import type {GpuNode,GpuScene,Rect,Texture} from './types'

afterEach(()=>vi.unstubAllEnvs())

const bounds={x:0,y:0,w:128,h:32}
function leaf(id:string,x:number,kind:'area'|'gradient'='area'):GpuNode{
  const rect={x,y:0,w:2,h:2}
  return {id,rect,size:[2,2],matrix:[1,0,0,1,x,0],inverse:[1,0,0,1,-x,0],
    fill:{count:3,area:kind==='area'?{first:0,count:4}:undefined,rect,sampleCount:4,rule:'nonzero'},
    fills:[{kind:kind==='area'?'solid':'linear',color:'#3478ab',opacity:1,visible:true,blend:'normal',stops:[{offset:0,color:'#111111'},{offset:1,color:'#222222'}]}],
    strokes:[],effects:[],children:[],opacity:1,blend:'normal'} as unknown as GpuNode
}
function group(id:string,children:string[]):GpuNode{
  return {id,rect:bounds,size:[128,32],matrix:[1,0,0,1,0,0],inverse:[1,0,0,1,0,0],
    fill:{count:0,rect:bounds},fills:[],strokes:[],effects:[],children,opacity:1,blend:'normal'} as unknown as GpuNode
}

test('neutral wrappers above the old 4096 visit cap still flatten on the analytic tile path',()=>{
  const nodes:Record<string,GpuNode>={}
  const ids:string[]=[]
  for(let i=0;i<5000;i++){
    const leafId=`l${i}`,groupId=`g${i}`
    nodes[leafId]=leaf(leafId,0)
    nodes[groupId]=group(groupId,[leafId])
    ids.push(groupId)
  }
  const scene={nodes} as GpuScene
  expect(sourcePainterOrder(scene,ids,bounds).filter(id=>id.startsWith('l')).length).toBeLessThan(5000)
  expect(sourcePainterOrder(scene,ids,bounds,20000).filter(id=>id.startsWith('g'))).toEqual([])
  expect(sourcePainterOrder(scene,ids,bounds,20000).filter(id=>id.startsWith('l'))).toHaveLength(5000)
})

test('area solids pack the original program index and split when footprints touch',()=>{
  const a=analyticSolidLeaf(leaf('a',0),bounds,8,()=>[0.2,0.4,0.6],()=>1)!
  const b=analyticSolidLeaf(leaf('b',2),bounds,8,()=>[0.2,0.4,0.6],()=>1)!
  const apart=analyticSolidLeaf(leaf('c',8),bounds,8,()=>[0.2,0.4,0.6],()=>1)!
  expect(a.program).toEqual({kind:'area',first:0,count:4})
  expect(analyticSolidLeaf(leaf('g',0,'gradient'),bounds,8,()=>[0,0,0],()=>1)).toBeUndefined()
  expect(analyticSolidLeaf({...leaf('h',0),opacity:.5} as GpuNode,bounds,8,()=>[0,0,0],()=>1)).toBeUndefined()
  const packed=packAnalyticSolids([a])
  expect(packed).toHaveLength(ANALYTIC_SOLID_FLOATS)
  expect(packed[4]).toBe(0)
  expect(packed[7]).toBe(0)
  const touching=planAnalyticSolidBatches([a,b,apart],bounds.w*bounds.h)
  expect(touching.map(batch=>batch.items.map(item=>item.write.x))).toEqual([[0],[2,8]])
})

function harness(perGroup=8,groups=4){
  const draws:string[]=[]
  const create=(width:number,height:number)=>({width,height,bytes:width*height*16,resource:{}}) as Texture
  const driver:any={
    name:'webgpu',managed:true,hdr:false,displayMath:false,analyticSolidsReady:true,
    create,clear(){},destroy(){},checkpoint:async()=>{},
    mask(){draws.push('mask')},
    pass(target:Texture,u:Float32Array){draws.push(`pass:${u[16]}`)},
    drawAnalyticSolids(_output:Texture,_source:Texture,_rect:Rect,_clip:Texture|undefined,_clipRect:Rect|undefined,data:Float32Array,count:number){
      draws.push(`batch:${count}:${data.length}`)
      return true
    },
  }
  const renderer=new GpuRenderer(driver,true,false) as any
  const nodes:Record<string,GpuNode>={}
  const groupIds:string[]=[]
  const width=groups*perGroup*4
  const frame={x:0,y:0,w:width,h:32}
  for(let g=0;g<groups;g++){
    const children:string[]=[]
    for(let i=0;i<perGroup;i++){
      const id=`n${g}-${i}`
      children.push(id)
      nodes[id]=leaf(id,(g*perGroup+i)*4)
    }
    const id=`g${g}`
    groupIds.push(id)
    nodes[id]=group(id,children)
    nodes[id].rect=frame
  }
  nodes.stage=group('stage',groupIds)
  nodes.stage.rect=frame
  nodes.stage.blend='pass-through'
  nodes.stage.passthrough=true
  renderer.scene={nodes,roots:['stage'],curves:new Float32Array(32),coherentSamples:false,interactionRetained:false,
    softwareRaster:false,extent:frame,view:{x:0,y:0,zoom:1}} as GpuScene
  renderer.outputFrame={present:true,readback:false}
  renderer.curveBits=new Uint32Array(renderer.scene.curves.buffer)
  renderer.sampleIndex=undefined
  renderer.fastWork.reset(true)
  const target=renderer.acquire(frame)
  return {renderer,driver,draws,target,count:groups*perGroup}
}

test('partial opacity stays outside the fused solid draw',async()=>{
  const on=harness()
  on.renderer.scene.nodes.faint={...leaf('faint',0),opacity:.5}
  on.renderer.scene.nodes.stage.children=[...on.renderer.scene.nodes.stage.children,'faint']
  await on.renderer.drawList(['stage'],on.target)
  expect(on.draws.filter(draw=>draw.startsWith('batch:')).length).toBe(1)
  expect(on.draws.filter(draw=>draw==='mask'||draw.startsWith('pass:')).length).toBeGreaterThan(0)
})
test('analytic topology leaves fuse coverage and paint, and the flag restores the mask path',async()=>{
  const on=harness(16,8)
  const painted=await on.renderer.drawList(['stage'],on.target)
  expect(painted.texture).not.toBe(on.target.texture)
  const count=on.count
  expect(on.draws.filter(draw=>draw.startsWith('batch:')).length).toBe(Math.ceil(count/48))
  expect(on.draws.some(draw=>draw==='mask'||draw.startsWith('pass:'))).toBe(false)
  expect(on.renderer.fastWork.snapshot().analyticSolidNodes).toBe(count)

  vi.stubEnv('VITE_DESIGN_ANALYTIC_SOLID_BATCH','0')
  const off=harness(16,8)
  await off.renderer.drawList(['stage'],off.target)
  expect(off.draws.some(draw=>draw.startsWith('batch:'))).toBe(false)
  const before=off.draws.length
  const after=on.draws.length
  expect(before).toBeGreaterThan(after)
  expect(after).toBe(Math.ceil(count/48))
  console.log(JSON.stringify({scope:'same analytic renderer, 128 area solids in neutral groups, tile-sized target',beforeDraws:before,afterDraws:after,batchedNodes:count}))
})


test('an exhausted analytic arena falls back for the remaining leaves',async()=>{
  const run=harness(8,2)
  let remaining=3
  const draw=run.driver.drawAnalyticSolids
  run.driver.analyticSolidRemaining=()=>remaining
  run.driver.drawAnalyticSolids=(output:Texture,source:Texture,rect:Rect,clip:Texture|undefined,clipRect:Rect|undefined,data:Float32Array,count:number)=>{
    expect(count).toBeLessThanOrEqual(remaining)
    remaining-=count
    return draw(output,source,rect,clip,clipRect,data,count)
  }
  await run.renderer.drawList(['stage'],run.target)
  expect(run.draws.filter(draw=>draw.startsWith('batch:'))).toEqual(['batch:3:72'])
  expect(run.draws.some(draw=>draw==='mask')).toBe(true)
  expect(remaining).toBe(0)
})
