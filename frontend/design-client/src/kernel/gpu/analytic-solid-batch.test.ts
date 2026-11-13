import {afterEach,expect,test,vi} from 'vitest'
import {GpuRenderer} from './renderer'
import {analyticGradientFieldFromSamples,analyticGradientLeaf,analyticSolidBrushes,analyticSolidLeaf,acceptAnalyticGradientBatch,planAnalyticSolidBatches,packAnalyticGradients,packAnalyticSolids,ANALYTIC_GRADIENT_FLOATS,ANALYTIC_SOLID_FLOATS} from './analytic-solid-batch'
import {gradient_sampling_axes,gradient_sampling_grid} from '../../generated/design-kernel/design_kernel'
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
  expect(packed[6]).toBe(0)
  expect(packed[7]).toBe(0)
  expect(packed[21]).toBe(0)
  expect(packed[22]).toBe(0)
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

function stroked(id:string,x:number,align:'center'|'inside'|'outside'='center'){
  const node=leaf(id,x)
  node.rect={x,y:0,w:4,h:4}
  node.strokes=[{align,path:{first:0,count:3,rule:'nonzero',area:{first:0,count:4},rect:{x,y:0,w:4,h:4}},
    paint:{id:`${id}-stroke`,kind:'solid',color:'#112233',opacity:1,visible:true,blend:'normal',angle:0,fit:'cover',stops:[]}}]
  return node
}
test('a solid fill and its stroke stay in one batch, including inside and outside alignment',()=>{
  const color=()=>[0.2,0.4,0.6] as const,channel=()=>1
  const center=analyticSolidBrushes(stroked('a',0),bounds,8,color,channel)!
  const inside=analyticSolidBrushes(stroked('b',0,'inside'),bounds,8,color,channel)!
  const outside=analyticSolidBrushes(stroked('c',0,'outside'),bounds,8,color,channel)!
  const border=stroked('d',0,'outside');border.fills=[]
  const shape=analyticSolidBrushes(border,bounds,8,color,channel)!
  expect(center.map(item=>[item.role??0,item.clip??0])).toEqual([[0,0],[0,0]])
  expect(inside.map(item=>[item.role??0,item.clip??0])).toEqual([[1,0],[0,2]])
  expect(outside.map(item=>[item.role??0,item.clip??0])).toEqual([[1,0],[0,3]])
  expect(shape.map(item=>[item.role??0,item.clip??0])).toEqual([[2,0],[0,3]])
  expect(analyticSolidBrushes(leaf('plain',0),bounds,8,color,channel)).toBeUndefined()
  const gradient=stroked('g',0);gradient.strokes[0].paint.kind='linear' as 'solid'
  expect(analyticSolidBrushes(gradient,bounds,8,color,channel)).toBeUndefined()
  const near=analyticSolidBrushes(stroked('n',1),bounds,8,color,channel)!
  const far=analyticSolidBrushes(stroked('f',20),bounds,8,color,channel)!
  for(const item of near)item.group=2
  for(const item of far)item.group=2
  const area=bounds.w*bounds.h
  expect(planAnalyticSolidBatches([...center,...near],area).map(batch=>batch.items.length)).toEqual([2,2])
  expect(planAnalyticSolidBatches([...center,...far],area).map(batch=>batch.items.map(item=>item.group))).toEqual([[1,1,2,2]])
  const words=packAnalyticSolids(inside)
  expect(words[6]).toBe(0)
  expect(words[21]).toBe(1)
  expect(words[22]).toBe(1)
  expect(words[24+6]).toBe(2)
  expect(words[24+22]).toBe(0)
})

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


function strokeHarness(count=24){
  const draws:string[]=[]
  const create=(width:number,height:number)=>({width,height,bytes:width*height*16,resource:{}}) as Texture
  const driver:any={
    name:'webgpu',managed:true,hdr:false,displayMath:false,analyticSolidsReady:true,exactSolidPaintOver:true,
    create,clear(){},destroy(){},checkpoint:async()=>{},
    mask(){draws.push('mask')},
    pass(_target:Texture,u:Float32Array){draws.push(`pass:${u[16]}`)},
    drawAnalyticSolids(_output:Texture,_source:Texture,_rect:Rect,_clip:Texture|undefined,_clipRect:Rect|undefined,data:Float32Array,n:number){
      draws.push(`batch:${n}:${data.length}`)
      return true
    },
  }
  const renderer=new GpuRenderer(driver,true,false) as any
  const nodes:Record<string,GpuNode>={}
  const children:string[]=[]
  const frame={x:0,y:0,w:count*8,h:8}
  for(let i=0;i<count;i++){
    const id=`s${i}`
    children.push(id)
    nodes[id]=stroked(id,i*8)
  }
  nodes.stage=group('stage',children)
  nodes.stage.rect=frame
  nodes.stage.blend='pass-through'
  nodes.stage.passthrough=true
  renderer.scene={nodes,roots:['stage'],curves:new Float32Array(32),coherentSamples:false,interactionRetained:false,
    softwareRaster:false,extent:frame,view:{x:0,y:0,zoom:1}} as GpuScene
  renderer.outputFrame={present:true,readback:false}
  renderer.curveBits=new Uint32Array(renderer.scene.curves.buffer)
  renderer.sampleIndex=undefined
  renderer.fastWork.reset(true)
  return {renderer,draws,target:renderer.acquire(frame),count}
}
test('opaque solid strokes fuse into the analytic draw instead of a mask and a paint per brush',async()=>{
  const on=strokeHarness(32)
  await on.renderer.drawList(['stage'],on.target)
  const after=on.draws.length
  expect(on.draws.filter(draw=>draw.startsWith('batch:')).length).toBe(2)
  expect(on.draws.some(draw=>draw==='mask'||draw.startsWith('pass:'))).toBe(false)

  vi.stubEnv('VITE_DESIGN_ANALYTIC_SOLID_BATCH','0')
  const off=strokeHarness(32)
  await off.renderer.drawList(['stage'],off.target)
  expect(off.draws.some(draw=>draw.startsWith('batch:'))).toBe(false)
  const before=off.draws.length
  expect(before).toBeGreaterThan(after)
  console.log(JSON.stringify({scope:'same analytic renderer, 32 stroked solids, mock WebGPU driver, no Metal or device timestamps',beforeDraws:before,afterDraws:after,nodes:on.count}))
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

function gradientNode(id:string,x:number,kind:'linear'|'radial'='linear',w=4){
  const rect={x,y:0,w,h:w}
  return {id,rect,size:[w,w],matrix:[1,0,0,1,x,0],inverse:[1,0,0,1,-x,0],
    fill:{count:3,area:{first:0,count:4},rect,sampleCount:4,rule:'nonzero'},
    fills:[{kind,color:'#3478ab',opacity:1,visible:true,blend:'normal',angle:0,
      stops:[{offset:0,color:'#112233'},{offset:1,color:'#445566'}]}],
    strokes:[],effects:[],children:[],opacity:1,blend:'normal'} as unknown as GpuNode
}
function gradientField(node:GpuNode){
  const paint=node.fills[0]
  const parameters={kind:paint.kind,color:'#000000',angle:paint.angle,transform:paint.transform,
    stops:paint.stops.map(stop=>({offset:stop.offset,color:'#000000'}))}
  const rect=JSON.stringify(node.rect),matrix=new Float64Array(node.matrix),size=new Float64Array(node.size),json=JSON.stringify(parameters)
  return analyticGradientFieldFromSamples(node.rect,paint.kind==='linear'?gradient_sampling_axes(rect,matrix,size,json,4):undefined,
    gradient_sampling_grid(rect,matrix,size,json,4))
}
const gradientValues=()=>new Float32Array(64).map((_,index)=>index%4===2?0.25:index%4===1?1:0)
test('opaque gradient leaves pack the kernel field and reject the old exclusions',()=>{
  const target={x:0,y:0,w:64,h:16}
  let built=0
  const admitted=analyticGradientLeaf(gradientNode('g',0),target,8,()=>[0.2,0.4,0.6],()=>1,()=>{built++;return {width:4,height:4,values:gradientValues()}})!
  expect(built).toBe(1)
  expect(admitted.gradient?.stops.map(stop=>stop.offset)).toEqual([0,1])
  const reversed=gradientNode('rev',0)
  reversed.fills[0].stops=[{offset:1,color:'#445566'},{offset:0,color:'#112233'}]
  const ordered=analyticGradientLeaf(reversed,target,8,()=>[0.2,0.4,0.6],()=>1,()=>({width:4,height:4,values:gradientValues()}))!
  expect(ordered.gradient?.stops.map(stop=>stop.offset)).toEqual([0,1])
  const packed=packAnalyticGradients([admitted])
  expect(acceptAnalyticGradientBatch(packed,1)).toBe(true)
  expect(packed[23]).toBe(4)
  expect(packed[25]).toBe(24)
  expect(packed[26]).toBe(2)
  expect(Array.from(packed.subarray(96,160))).toEqual(Array.from(gradientValues()))
  packed[96]=9
  expect(acceptAnalyticGradientBatch(packed,1)).toBe(false)
  const calls:string[]=[]
  const ask=(node:GpuNode)=>analyticGradientLeaf(node,target,8,()=>[0.2,0.4,0.6],()=>1,()=>{calls.push(node.id);return {width:4,height:4,values:gradientValues()}})
  const faint=gradientNode('faint',0);faint.opacity=.5
  const stroked=gradientNode('stroke',0);stroked.strokes=[{align:'center',path:stroked.fill,paint:stroked.fills[0]}]
  const many=gradientNode('many',0);many.fills[0].stops=Array.from({length:9},(_,index)=>({offset:index/8,color:'#112233'}))
  const huge=gradientNode('huge',0,'radial',80)
  expect(ask(faint)).toBeUndefined()
  expect(ask(stroked)).toBeUndefined()
  expect(ask(many)).toBeUndefined()
  expect(calls).toEqual([])
  expect(gradientField(huge)).toBeUndefined()
  const near=analyticGradientLeaf(gradientNode('near',1),target,8,()=>[0.2,0.4,0.6],()=>1,()=>({width:4,height:4,values:gradientValues()}))!
  const far=analyticGradientLeaf(gradientNode('far',24),target,8,()=>[0.2,0.4,0.6],()=>1,()=>({width:4,height:4,values:gradientValues()}))!
  const area=target.w*target.h
  expect(planAnalyticSolidBatches([admitted,near],area).map(batch=>batch.items.length)).toEqual([1,1])
  expect(planAnalyticSolidBatches([admitted,far],area).map(batch=>batch.items.length)).toEqual([2])
})

function gradientHarness(count=32,kind:'linear'|'radial'='linear'){
  const draws:string[]=[]
  const batches:Float32Array[]=[]
  const create=(width:number,height:number)=>({width,height,bytes:width*height*16,resource:{}}) as Texture
  const upload=(data:Float32Array,width:number,height:number)=>({width,height,bytes:data.byteLength,resource:{}}) as Texture
  const driver:any={
    name:'webgpu',managed:true,hdr:false,displayMath:false,analyticSolidsReady:true,exactGradientPaintOver:true,
    create,uploadLinear:upload,uploadParameters:upload,clear(){},destroy(){},checkpoint:async()=>{},
    mask(){draws.push('mask')},
    pass(_target:Texture,u:Float32Array){draws.push(`pass:${u[16]}`)},
    drawAnalyticSolids(_output:Texture,_source:Texture,_rect:Rect,_clip:Texture|undefined,_clipRect:Rect|undefined,data:Float32Array,n:number,_full:boolean,gradient?:boolean){
      batches.push(data)
      draws.push(`batch:${n}:${data.length}:${gradient?1:0}`)
      return true
    },
  }
  const renderer=new GpuRenderer(driver,true,false) as any
  const nodes:Record<string,GpuNode>={}
  const children:string[]=[]
  const frame={x:0,y:0,w:count*8,h:8}
  for(let i=0;i<count;i++){
    const id=`g${i}`
    children.push(id)
    nodes[id]=gradientNode(id,i*8,kind)
  }
  nodes.stage=group('stage',children)
  nodes.stage.rect=frame
  nodes.stage.blend='pass-through'
  nodes.stage.passthrough=true
  renderer.scene={nodes,roots:['stage'],curves:new Float32Array(32),coherentSamples:false,interactionRetained:false,
    softwareRaster:false,extent:frame,view:{x:0,y:0,zoom:1}} as GpuScene
  renderer.outputFrame={present:true,readback:false}
  renderer.curveBits=new Uint32Array(renderer.scene.curves.buffer)
  renderer.sampleIndex=undefined
  renderer.fastWork.reset(true)
  return {renderer,draws,batches,target:renderer.acquire(frame),count}
}
test('opaque gradients fuse into one analytic draw and the flag restores the mask path',async()=>{
  const on=gradientHarness(32)
  await on.renderer.drawList(['stage'],on.target)
  const after=on.draws.length
  expect(on.draws.filter(draw=>draw.startsWith('batch:'))).toEqual([`batch:32:${on.batches[0].length}:1`])
  expect(on.draws.some(draw=>draw==='mask'||draw.startsWith('pass:'))).toBe(false)
  expect(acceptAnalyticGradientBatch(on.batches[0],32)).toBe(true)
  const expected=gradientField(gradientNode('g0',0))!
  const offset=on.batches[0][25]
  expect(Array.from(on.batches[0].subarray(offset*4,offset*4+expected.values.length))).toEqual(Array.from(expected.values))
  expect(on.renderer.fastWork.snapshot().analyticGradientNodes).toBe(32)

  vi.stubEnv('VITE_DESIGN_ANALYTIC_GRADIENT_BATCH','0')
  const off=gradientHarness(32)
  await off.renderer.drawList(['stage'],off.target)
  expect(off.draws.some(draw=>draw.startsWith('batch:'))).toBe(false)
  const before=off.draws.length
  expect(before).toBeGreaterThan(after)
  expect(off.draws.filter(draw=>draw==='mask').length).toBeGreaterThan(0)
  expect(off.draws.filter(draw=>draw.startsWith('pass:')).length).toBeGreaterThanOrEqual(32)

  vi.stubEnv('VITE_DESIGN_ANALYTIC_GRADIENT_BATCH','1')
  vi.stubEnv('VITE_DESIGN_ANALYTIC_SOLID_BATCH','0')
  const solidOff=gradientHarness(32)
  await solidOff.renderer.drawList(['stage'],solidOff.target)
  expect(solidOff.draws.some(draw=>draw.startsWith('batch:'))).toBe(false)
  expect(solidOff.draws.length).toBeGreaterThan(after)

  vi.stubEnv('VITE_DESIGN_ANALYTIC_SOLID_BATCH','1')
  const wide=gradientHarness(1,'radial')
  wide.renderer.scene.nodes.g0=gradientNode('g0',0,'radial',80)
  wide.renderer.scene.nodes.stage.rect={x:0,y:0,w:80,h:80}
  wide.renderer.scene.extent=wide.renderer.scene.nodes.stage.rect
  const wideTarget=wide.renderer.acquire(wide.renderer.scene.extent)
  await wide.renderer.drawList(['stage'],wideTarget)
  expect(wide.draws.some(draw=>draw.startsWith('batch:'))).toBe(false)
  expect(wide.draws.some(draw=>draw==='mask')).toBe(true)
  const tally=(draws:string[])=>draws.reduce<Record<string,number>>((counts,draw)=>{const key=draw.startsWith('pass:')?draw:draw.startsWith('batch:')?'batch':draw;counts[key]=(counts[key]||0)+1;return counts},{})
  console.log(JSON.stringify({scope:'same analytic renderer, 32 non-overlapping opaque linear gradients, mock WebGPU driver, no Metal or device timestamps',beforeDraws:before,afterDraws:after,beforeKinds:tally(off.draws),afterKinds:tally(on.draws),nodes:on.count,fieldFloats:expected.values.length}))
})
test('small opaque radial gradients use the same fused draw',async()=>{
  const on=gradientHarness(8,'radial')
  await on.renderer.drawList(['stage'],on.target)
  expect(on.draws.filter(draw=>draw.startsWith('batch:'))).toEqual([`batch:8:${on.batches[0].length}:1`])
  expect(acceptAnalyticGradientBatch(on.batches[0],8)).toBe(true)
  const expected=gradientField(gradientNode('g0',0,'radial'))!
  const offset=on.batches[0][25]
  expect(Array.from(on.batches[0].subarray(offset*4,offset*4+expected.values.length))).toEqual(Array.from(expected.values))
  vi.stubEnv('VITE_DESIGN_ANALYTIC_GRADIENT_BATCH','0')
  const off=gradientHarness(8,'radial')
  await off.renderer.drawList(['stage'],off.target)
  expect(off.draws.some(draw=>draw.startsWith('batch:'))).toBe(false)
  expect(off.draws.length).toBeGreaterThan(on.draws.length)
  console.log(JSON.stringify({scope:'same analytic renderer, 8 non-overlapping opaque radial gradients, mock WebGPU driver',beforeDraws:off.draws.length,afterDraws:on.draws.length,fieldFloats:expected.values.length}))
})
