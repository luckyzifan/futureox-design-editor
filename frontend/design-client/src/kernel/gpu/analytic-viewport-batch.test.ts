import {afterEach,expect,test,vi} from 'vitest'
import {flattenSourceDisplayList,sourcePainterOrder} from './opaque-painter-prefix'
import {analyticSolidInstances,analyticViewportBatch,rectsOverlap,takeAnalyticSolids} from './analytic-viewport-batch'
import {sourceSolidLayerDisplay} from './source-solid-layers'
import {analyticViewportShader} from './analytic-viewport-shader'
import {GpuRenderer} from './renderer'
import type {Driver,GpuNode,GpuScene,Rect,Texture} from './types'

afterEach(()=>vi.unstubAllEnvs())
const region:Rect={x:0,y:0,w:64,h:64}
const color=()=>[1,0,0] as const
const alpha=()=>1
function leaf(id:string,x=4):GpuNode{
  return {id,rect:{x,y:8,w:10,h:10},size:[10,10],matrix:[1,0,0,1,x,8],inverse:[1,0,0,1,-x,-8],
    fill:{count:6,area:{first:x,count:4},rect:{x,y:8,w:10,h:10},rule:'nonzero'},
    fills:[{kind:'solid',color:'#ff0000',opacity:1,visible:true,blend:'normal',stops:[]}],
    strokes:[],effects:[],children:[],opacity:1,blend:'normal'} as unknown as GpuNode
}
function wrap(id:string,children:string[],patch:Partial<GpuNode>={}):GpuNode{
  return {...leaf(id),children,fills:[],strokes:[],effects:[],passthrough:true,opacity:1,blend:'normal',clip:false,mask:false,...patch}
}
function scene(nodes:Record<string,GpuNode>,extra:Partial<GpuScene>={}):GpuScene{
  return {nodes,coherentSamples:false,...extra} as GpuScene
}
const managed={name:'webgpu',managed:true,hdr:false,displayMath:false} as const

test('analytic float viewports are admitted and the managed sRGB four-phase entry is not',()=>{
  const analytic=scene({})
  const fourPhase={...analytic,coherentSamples:true,colorManagement:{documentSpace:'srgb'},sourceImageDisplay:true,
    view:{x:0,y:0,zoom:.25},output:{x:0,y:0,w:32,h:32}} as GpuScene
  expect(analyticViewportBatch(analytic,managed,true)).toBe(true)
  expect(sourceSolidLayerDisplay(analytic,managed,true)).toBe(false)
  expect(analyticViewportBatch(fourPhase,managed,true)).toBe(false)
  expect(sourceSolidLayerDisplay(fourPhase,managed,true)).toBe(true)
  expect(analyticViewportBatch(analytic,{...managed,managed:false},true)).toBe(false)
  expect(analyticViewportBatch(analytic,managed,false)).toBe(false)
  expect(analyticViewportBatch({...analytic,colorManagement:{documentSpace:'srgb'}} as GpuScene,managed,true)).toBe(false)
  vi.stubEnv('VITE_DESIGN_ANALYTIC_VIEWPORT_BATCH','0')
  expect(analyticViewportBatch(analytic,managed,true)).toBe(false)
})

test('identity wrappers inline across a full analytic tree, including past the 4096 detail cap',()=>{
  const nodes:Record<string,GpuNode>={}
  const ids:string[]=[]
  for(let i=0;i<5000;i++){
    const child=leaf('l'+i,i)
    nodes['l'+i]=child
    nodes['g'+i]={...wrap('g'+i,['l'+i]),rect:{...child.rect}}
    ids.push('g'+i)
  }
  const flat=flattenSourceDisplayList(scene(nodes),ids,region)
  expect(flat).toHaveLength(5000)
  expect(flat[0]).toBe('l0')
  expect(flat[4096]).toBe('l4096')
  const capped=sourcePainterOrder(scene(nodes),ids,region)
  expect(capped.some(id=>id.startsWith('g'))).toBe(true)
  expect(capped.filter(id=>id.startsWith('l')).length).toBeLessThan(5000)
})

test('backdrop, partial clips and cycles stay grouped',()=>{
  const nodes:Record<string,GpuNode>={a:leaf('a'),b:leaf('b'),deep:leaf('deep')}
  nodes.a.effects=[{kind:'background-blur',visible:true,radius:4} as GpuNode['effects'][number]]
  nodes.backdrop=wrap('backdrop',['a'])
  nodes.partial=wrap('partial',['deep'],{clip:true,fill:{...leaf('partial').fill,opaqueRect:{x:0,y:0,w:4,h:4}}})
  nodes.cycle=wrap('cycle',['cycle'])
  expect(flattenSourceDisplayList(scene(nodes),['backdrop','partial','cycle'],region)).toEqual(['backdrop','partial','cycle'])
  nodes.covered=wrap('covered',['b'],{clip:true,fill:{...leaf('covered').fill,opaqueRect:{x:-2,y:-2,w:80,h:80}}})
  expect(flattenSourceDisplayList(scene(nodes),['covered'],region)).toEqual(['b'])
  nodes.wide=leaf('wide',0)
  nodes.wide.rect={x:0,y:0,w:40,h:40}
  nodes.tight=wrap('tight',['wide'])
  nodes.tight.rect={x:8,y:8,w:10,h:10}
  expect(flattenSourceDisplayList(scene(nodes),['tight'],region)).toEqual(['tight'])
})

test('touching rects share no pixel and an overlap ends the run',()=>{
  const left=leaf('left',0),right=leaf('right',10),over=leaf('over',15)
  expect(rectsOverlap(left.rect,right.rect)).toBe(false)
  expect(rectsOverlap(right.rect,over.rect)).toBe(true)
  const run=takeAnalyticSolids([left,right,over],region,color,alpha,8)
  expect(run.count).toBe(2)
  const data=analyticSolidInstances([left,right],run.quads,color,alpha)
  expect(data[4]).toBe(0)
  expect(data[24]).toBe(10)
  expect(data[16]).toBe(0)
  expect(data[18]).toBe(10)
})

test('the analytic shader keeps four-sample area coverage and the managed mode-47 over',()=>{
  expect(analyticViewportShader).toContain('fn cvSampleIndex()->i32{return 0;}')
  expect(analyticViewportShader).toContain('fn areaCoverage(')
  expect(analyticViewportShader).toContain('mulRN4(mulRN4(vec4<f32>(raw.xyz,1.),vec4<f32>(raw.w)),vec4<f32>(info.y))')
  expect(analyticViewportShader).toContain('addRN4(src,mulRN4(dst,vec4<f32>(addRN(1.,-src.a))))')
  expect(analyticViewportShader).not.toContain('sourceSolidLayer')
})

test('wrapped analytic leaves become one disjoint batch instead of one draw per wrapper',async()=>{
  const nodes:Record<string,GpuNode>={}
  const ids:string[]=[]
  for(let i=0;i<8;i++){
    const child=leaf('l'+i,i*12)
    nodes['l'+i]=child
    nodes['g'+i]={...wrap('g'+i,['l'+i]),rect:{...child.rect}}
    ids.push('g'+i)
  }
  const counts:number[]=[]
  const driver={...managed,analyticSolidsReady:true,solidBatchRemaining:()=>100,
    drawAnalyticSolids:(_target:Texture,_source:Texture,_uniforms:Float32Array,data:Float32Array)=>{counts.push(data.length/20);return true},
  } as unknown as Driver
  const renderer=new GpuRenderer(driver) as any
  renderer.analyticViewport=true
  renderer.scene=scene(nodes)
  renderer.copy=()=>({texture:{resource:{},width:8,height:8,bytes:64},rect:{x:0,y:8,w:8,h:11}})
  renderer.release=()=>{}
  renderer.reclaimForSurface=async()=>{}
  const drawn:string[]=[]
  renderer.drawNode=async(id:string,target:unknown)=>{drawn.push(id);return target}
  const wide:Rect={x:0,y:0,w:128,h:64}
  const target={texture:{} as Texture,rect:wide}
  await renderer.drawList(ids,target)
  expect(counts).toEqual([8])
  expect(drawn).toEqual([])
})

test('an overlapping leaf stays on the ordinary path after the disjoint prefix',async()=>{
  const nodes:Record<string,GpuNode>={a:leaf('a',0),b:leaf('b',20),c:leaf('c',24)}
  const counts:number[]=[]
  const driver={...managed,analyticSolidsReady:true,solidBatchRemaining:()=>100,
    drawAnalyticSolids:(_target:Texture,_source:Texture,_uniforms:Float32Array,data:Float32Array)=>{counts.push(data.length/20);return true},
  } as unknown as Driver
  const renderer=new GpuRenderer(driver) as any
  renderer.analyticViewport=true
  renderer.scene=scene(nodes)
  renderer.copy=()=>({texture:{resource:{},width:8,height:8,bytes:64},rect:region})
  renderer.release=()=>{}
  renderer.reclaimForSurface=async()=>{}
  const drawn:string[]=[]
  renderer.drawNode=async(id:string,target:unknown)=>{drawn.push(id);return target}
  await renderer.drawList(['a','b','c'],{texture:{} as Texture,rect:region})
  expect(counts).toEqual([2])
  expect(drawn).toEqual(['c'])
})

test('the source-group switch keeps wrappers on the ordinary path',async()=>{
  vi.stubEnv('VITE_DESIGN_SOURCE_GROUPS','0')
  const nodes:Record<string,GpuNode>={a:leaf('a',0),b:leaf('b',20),ga:wrap('ga',['a']),gb:wrap('gb',['b'])}
  const counts:number[]=[]
  const driver={...managed,analyticSolidsReady:true,solidBatchRemaining:()=>100,
    drawAnalyticSolids:()=>{counts.push(1);return true},
  } as unknown as Driver
  const renderer=new GpuRenderer(driver) as any
  renderer.analyticViewport=true
  renderer.scene=scene(nodes)
  const drawn:string[]=[]
  renderer.drawNode=async(id:string,target:unknown)=>{drawn.push(id);return target}
  await renderer.drawList(['ga','gb'],{texture:{} as Texture,rect:region})
  expect(counts).toEqual([])
  expect(drawn).toEqual(['ga','gb'])
})
