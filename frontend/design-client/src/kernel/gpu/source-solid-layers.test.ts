import {afterEach,expect,test,vi} from 'vitest'
import {sourceDisplayProgram,sourceSolidLayer,sourceSolidLayerDisplay} from './source-solid-layers'
import {GpuRenderer} from './renderer'
import type {Driver,GpuNode,GpuScene,Texture} from './types'
afterEach(()=>vi.unstubAllEnvs())
const colour=()=>[.125,.25,.5,1]
function node(id='leaf'):GpuNode{return {id,rect:{x:4,y:8,w:12,h:10},size:[12,10],matrix:[1,0,0,1,4,8],inverse:[1,0,0,1,-4,-8],
  fill:{count:6,area:{first:0,count:7},rect:{x:4,y:8,w:12,h:10},sampleCount:4},
  fills:[{kind:'solid',color:'#ffffff',opacity:1,visible:true,blend:'normal',stops:[]}],
  strokes:[],effects:[],children:[],opacity:1,blend:'normal'} as unknown as GpuNode}
function scene():GpuScene{return{sourceImageDisplay:true,coherentSamples:true,colorManagement:{documentSpace:'srgb'},
  view:{x:0,y:0,zoom:.125},output:{x:0,y:0,w:514,h:514}} as GpuScene}
const driver={name:'webgpu',managed:true,hdr:false,displayMath:false} as Driver
test.each([undefined,'1'])('bounded source solid batching keeps exact outputs and other backends on their original paths (%s)',flag=>{
  vi.stubEnv('VITE_DESIGN_SOURCE_SOLID_LAYERS',flag)
  expect(sourceSolidLayerDisplay(scene(),driver,true)).toBe(true)
  expect(sourceSolidLayerDisplay(scene(),driver,false)).toBe(false)
  for(const change of [{name:'cpu'},{name:'webgl2'},{managed:false},{hdr:true},{displayMath:true}] as Partial<Driver>[])
    expect(sourceSolidLayerDisplay(scene(),{...driver,...change},true)).toBe(false)
  for(const change of [{sourceImageDisplay:false},{coherentSamples:false},{softwareRaster:true},{interactionRetained:true},
    {resolve:{}},{presentation:{}},{colorManagement:{documentSpace:'display-p3'}},{output:{x:0,y:0,w:515,h:514}},
    {view:{x:0,y:0,zoom:.50001}},{view:{x:0,y:0,zoom:0}}] as Partial<GpuScene>[])
    expect(sourceSolidLayerDisplay({...scene(),...change},driver,true)).toBe(false)
  vi.stubEnv('VITE_DESIGN_SOURCE_SOLID_LAYERS','0')
  expect(sourceSolidLayerDisplay(scene(),driver,true)).toBe(false)
})
test('opaque source programs preserve original four phase offsets and decline unknown paint dependencies',()=>{
  const n=node(),p=sourceSolidLayer(n,()=>29,colour)!
  expect(p.data.map(d=>d[0])).toEqual([0,1,2,3]);expect(p.data[0][12]).toBe(29);expect(p.fields).toEqual([])
  for(const align of ['inside','outside','center'] as const){
    const outlined={...n,strokes:[{path:n.fill,paint:n.fills[0],align}]} as GpuNode
    expect(sourceSolidLayer(outlined,()=>29,colour)).toBeDefined()
    expect(sourceSolidLayer({...outlined,fills:[]},()=>29,colour)).toBeDefined()
    outlined.strokes[0]={...outlined.strokes[0],paint:{...n.fills[0],opacity:.9}}
    expect(sourceSolidLayer(outlined,()=>29,colour)).toBeUndefined()
  }
  expect(sourceSolidLayer(n,()=>undefined,colour)).toBeUndefined()
  expect(sourceSolidLayer(n,()=>29,()=>[0,0,0,.999])).toBeUndefined()
  for(const change of [{opacity:.9},{blend:'multiply'},{mask:true},{maskId:'mask'},{children:['child']},{clip:true},
    {opticalPrefixNext:'backdrop'},{effects:[{kind:'blur',visible:true}]},{strokes:[{}]},
    {fills:[{...n.fills[0],opacity:.5}]},{fills:[{...n.fills[0],kind:'linear'}]}] as Partial<GpuNode>[])
    expect(sourceSolidLayer({...n,...change},()=>29,colour)).toBeUndefined()
})
test('renderer batches in painter order, binds each actual binary clip and retains soft-mask fallback',async()=>{
  const r=new GpuRenderer({...driver,sourceLayersReady:true,sourceProgramOffset:()=>29} as Driver) as any
  r.sourceSolidLayers=true;r.scene={nodes:{a:node('a'),b:node('b'),stop:{...node('stop'),effects:[{kind:'blur',visible:true,radius:2}]}}}
  r.color=()=>[.125,.25,.5];r.alpha=()=>1
  const texture={binaryCoverage:true} as Texture,rect={x:0,y:0,w:32,h:32}
  const targets=Array.from({length:4},()=>({texture:{},rect})),clip=targets.map(()=>({texture,rect}))
  const packets:Float32Array[]=[]
  r.composeSourceProgram=vi.fn(async(mode:number,target:any,inputs:any[],region:any,write:(u:Float32Array)=>void)=>{
    expect(mode).toBe(76);expect(inputs).toHaveLength(1);expect(inputs[0].texture).toBe(texture)
    expect(region).toEqual({x:4,y:8,w:12,h:10})
    const u=new Float32Array(256);write(u);packets.push(u);return target
  })
  const result=await r.drawSourceSolidLayers(['a','b','stop'],0,targets,[0,1,2,3],clip)
  expect(result.end).toBe(2);expect(packets).toHaveLength(4)
  for(let i=0;i<4;i++){expect(packets[i][17]).toBe(2);expect(packets[i][18]).toBe(1);expect(packets[i][20]).toBe(i);expect(Array.from(packets[i].slice(8,12))).toEqual([0,0,32,32])}
  clip[0]={texture:{} as Texture,rect}
  expect(await r.drawSourceSolidLayers(['a'],0,targets,[0,1,2,3],clip)).toBeUndefined()
  r.interactionCapturing=true
  expect(await r.drawSourceSolidLayers(['a'],0,targets,[0,1,2,3])).toBeUndefined()
})
test('partial opacity and translucent strokes join the viewport batch; sampled effects do not',()=>{
  const plain=node(),translucent={...plain,id:'fade',opacity:.5} as GpuNode
  const faded=sourceDisplayProgram(translucent,()=>29,colour)
  expect(sourceSolidLayer(translucent,()=>29,colour)).toBeUndefined()
  expect(faded?.data[0][1]).toBe(.5)
  const stroke={...plain,id:'stroke',strokes:[{path:plain.fill,paint:{...plain.fills[0],opacity:.4},align:'center'}]} as GpuNode
  expect(sourceSolidLayer(stroke,()=>29,colour)).toBeUndefined()
  expect(sourceDisplayProgram(stroke,()=>29,colour)?.fields).toEqual([])
  const shadow={...plain,effects:[{kind:'inner-shadow',visible:true,radius:2,spread:0,x:0,y:0,color:'#ffffff',opacity:1}],
    sourceFilterField:{factor:2,effectIndex:0,sharpHalo:0,radius:1,gaussian:false,input:plain.rect,output:plain.rect,masks:[]}} as unknown as GpuNode
  expect(sourceDisplayProgram(shadow,()=>29,colour)).toBeUndefined()
  expect(sourceDisplayProgram({...plain,opticalPrefixNext:'next'},()=>29,colour)).toBeUndefined()
  expect(sourceDisplayProgram({...plain,effects:[{kind:'blur',visible:true,radius:2}]} as unknown as GpuNode,()=>29,colour)).toBeUndefined()
})
test('opaque source leaves stop on the uniform budget',async()=>{
  const r=new GpuRenderer({...driver,sourceLayersReady:true,sourceProgramOffset:()=>29} as Driver) as any
  r.sourceSolidLayers=true
  const nodes:Record<string,GpuNode>={}
  const ids:string[]=[]
  for(let i=0;i<12;i++){const id=`n${i}`;ids.push(id);nodes[id]=node(id)}
  r.scene={nodes}
  r.color=()=>[.125,.25,.5];r.alpha=()=>1
  const rect={x:0,y:0,w:32,h:32}
  const targets=Array.from({length:4},()=>({texture:{},rect}))
  let count=0
  r.composeSourceProgram=vi.fn(async(_mode:number,target:any,_inputs:any[],_region:any,write:(u:Float32Array)=>void)=>{
    const u=new Float32Array(256);write(u);count=u[17];return target
  })
  const result=await r.drawSourceSolidLayers(ids,0,targets,[0,1,2,3])
  expect(result.end).toBe(count)
  expect(count).toBe(7)
})
