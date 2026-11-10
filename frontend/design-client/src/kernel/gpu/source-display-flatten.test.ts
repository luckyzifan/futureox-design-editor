import {afterEach,expect,test,vi} from 'vitest'
import {flattenSourceDisplayList,sourcePainterOrder} from './opaque-painter-prefix'
import {GpuRenderer} from './renderer'
import type {Driver,GpuNode,GpuScene,Rect,Texture} from './types'

afterEach(()=>vi.unstubAllEnvs())
const region:Rect={x:0,y:0,w:32,h:32}
function leaf(id:string,opacity=1):GpuNode{
  return {id,rect:{x:4,y:8,w:12,h:10},size:[12,10],matrix:[1,0,0,1,4,8],inverse:[1,0,0,1,-4,-8],
    fill:{count:6,area:{first:0,count:7},rect:{x:4,y:8,w:12,h:10},sampleCount:4},
    fills:[{kind:'solid',color:'#ffffff',opacity:1,visible:true,blend:'normal',stops:[]}],
    strokes:[],effects:[],children:[],opacity,blend:'normal'} as unknown as GpuNode
}
function wrap(id:string,children:string[],patch:Partial<GpuNode>={}):GpuNode{
  return {...leaf(id),children,fills:[],strokes:[],effects:[],passthrough:true,opacity:1,blend:'normal',clip:false,mask:false,...patch}
}
function scene(nodes:Record<string,GpuNode>):GpuScene{
  return {nodes} as GpuScene
}

test('identity wrappers inline across a full source tree, including past the 4096 detail cap',()=>{
  const nodes:Record<string,GpuNode>={}
  const ids:string[]=[]
  for(let i=0;i<5000;i++){
    nodes['l'+i]=leaf('l'+i)
    nodes['g'+i]=wrap('g'+i,['l'+i])
    ids.push('g'+i)
  }
  const flat=flattenSourceDisplayList(scene(nodes),ids,region)
  expect(flat).toHaveLength(5000)
  expect(flat[0]).toBe('l0')
  expect(flat[4096]).toBe('l4096')
  expect(flat[4999]).toBe('l4999')
  const capped=sourcePainterOrder(scene(nodes),ids,region)
  expect(capped.some(id=>id.startsWith('g'))).toBe(true)
  expect(capped.filter(id=>id.startsWith('l')).length).toBeLessThan(5000)
})

test('backdrop, isolation, partial clips and cycles stay on the ordinary group path',()=>{
  const nodes:Record<string,GpuNode>={
    a:leaf('a'),
    b:leaf('b'),
    blur:leaf('blur'),
    glass:leaf('glass'),
    multiply:leaf('multiply'),
    deep:leaf('deep'),
  }
  nodes.blur.effects=[{kind:'background-blur',visible:true,radius:4} as GpuNode['effects'][number]]
  nodes.glass.effects=[{kind:'glass',visible:true,radius:4} as GpuNode['effects'][number]]
  nodes.multiply.blend='multiply'
  nodes.backdrop=wrap('backdrop',['a','blur'])
  nodes.isolated=wrap('isolated',['b'],{opacity:.5})
  nodes.blend=wrap('blend',['multiply'])
  nodes.partial=wrap('partial',['deep'],{clip:true,fill:{...leaf('partial').fill,opaqueRect:{x:0,y:0,w:4,h:4}}})
  nodes.cycle=wrap('cycle',['cycle'])
  const flat=flattenSourceDisplayList(scene(nodes),['backdrop','isolated','blend','partial','cycle'],region)
  expect(flat).toEqual(['backdrop','isolated','blend','partial','cycle'])
  nodes.covered=wrap('covered',['a'],{clip:true,fill:{...leaf('covered').fill,opaqueRect:{x:-2,y:-2,w:40,h:40}}})
  expect(flattenSourceDisplayList(scene(nodes),['covered'],region)).toEqual(['a'])
})

test('a non-transparent low-zoom tile batches wrapped leaves, including partial opacity',async()=>{
  const nodes:Record<string,GpuNode>={}
  const ids:string[]=[]
  for(let i=0;i<14;i++){
    nodes['l'+i]=leaf('l'+i,i===3?.5:1)
    nodes['g'+i]=wrap('g'+i,['l'+i])
    ids.push('g'+i)
  }
  const driver={name:'webgpu',managed:true,hdr:false,displayMath:false,sourceLayersReady:true,sourceProgramOffset:()=>29} as unknown as Driver
  const renderer=new GpuRenderer(driver) as any
  renderer.sourceSolidLayers=true
  renderer.scene=scene(nodes)
  renderer.color=()=>[.125,.25,.5]
  renderer.alpha=()=>1
  const counts:number[]=[]
  let sawPartial=false
  renderer.composeSourceProgram=vi.fn(async(_mode:number,target:unknown,_inputs:unknown[],_region:unknown,write:(u:Float32Array)=>void)=>{
    const u=new Float32Array(256)
    write(u)
    counts.push(u[17])
    for(let at=20,n=0;n<u[17];n++){
      if(u[at+1]===.5)sawPartial=true
      at+=28
    }
    return target
  })
  const rect={x:0,y:0,w:32,h:32}
  const targets=Array.from({length:4},()=>({texture:{} as Texture,rect}))
  await renderer.drawBundle(ids,targets)
  // One mode-76 draw per phase. Fourteen wrapped leaves are two full uniform
  // batches, not fourteen separate passes. Unflattened wrappers issue 56.
  expect(counts).toEqual([7,7,7,7,7,7,7,7])
  expect(sawPartial).toBe(true)
  expect(counts.length).toBeLessThan(14*4)
})

test('the existing source-group switch still refuses to combine wrappers',async()=>{
  vi.stubEnv('VITE_DESIGN_SOURCE_GROUPS','0')
  const nodes:Record<string,GpuNode>={a:leaf('a'),b:leaf('b'),ga:wrap('ga',['a']),gb:wrap('gb',['b'])}
  const driver={name:'webgpu',managed:true,hdr:false,displayMath:false,sourceLayersReady:true,sourceProgramOffset:()=>29} as unknown as Driver
  const renderer=new GpuRenderer(driver) as any
  renderer.sourceSolidLayers=true
  renderer.scene={...scene(nodes),roots:['ga','gb']}
  renderer.color=()=>[.125,.25,.5]
  renderer.alpha=()=>1
  const counts:number[]=[]
  renderer.composeSourceProgram=vi.fn(async(_mode:number,target:unknown,_inputs:unknown[],_region:unknown,write:(u:Float32Array)=>void)=>{
    const u=new Float32Array(256);write(u);counts.push(u[17]);return target
  })
  const rect={x:0,y:0,w:32,h:32}
  const targets=Array.from({length:4},()=>({texture:{} as Texture,rect}))
  await renderer.drawBundle(['ga','gb'],targets)
  expect(counts).toEqual([1,1,1,1,1,1,1,1])
})
