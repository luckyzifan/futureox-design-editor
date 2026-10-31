import { afterEach, expect, test, vi } from 'vitest'
import { GpuRenderer, type Surface } from './renderer'
import { WebGpuDriver } from './webgpu'
import { painterStageBox } from './painter-stage'
import { paint } from '../../model'
import type { Driver, GpuNode, Rect, Texture } from './types'

afterEach(()=>vi.unstubAllEnvs())
function rendererFixture(){
  vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX','1')
  const words=new Map<Texture,Uint32Array>()
  const create=(width:number,height:number)=>{const t={width,height,bytes:width*height*16,resource:{}} as Texture;words.set(t,new Uint32Array(width*height*4));return t}
  const copy=vi.fn((target:Texture,source:Texture,r:Rect,to:[number,number])=>{
    for(let row=0;row<r.h;row++)words.get(target)!.set(words.get(source)!.subarray(((r.y+row)*source.width+r.x)*4,((r.y+row)*source.width+r.x+r.w)*4),((to[1]+row)*target.width+to[0])*4)
  })
  const driver={name:'webgpu',managed:true,constantTextureSampling:true,zeroTextureSampling:true,create,createBinaryCoverage:create,
    copyColorRegion:copy,clear(){},destroy:vi.fn(),pass:vi.fn(),begin:vi.fn(),prepareScene:vi.fn()}
  const renderer=new GpuRenderer(driver as unknown as Driver) as any
  renderer.scene={extent:{x:-32,y:-32,w:128,h:128},rootInputBox:[-20,-10,96,80],coherentSamples:true}
  renderer.reclaimScratch=vi.fn(async()=>{})
  const input=renderer.acquire({x:-20,y:-10,w:96,h:80}) as Surface
  const data=words.get(input.texture)!
  for(let i=0;i<data.length;i++)data[i]=[0x80000000,0x7f7fffff,0x80000001,0x7fc12345,0x3f800001][i%5]
  const targets=[input,...Array.from({length:3},()=>renderer.retain(input))] as Surface[]
  return{renderer,driver,words,input,targets}
}
test('complete painter suffix preserves bits and aliases without intersecting child geometry',async()=>{
  const f=rendererFixture(),out=await f.renderer.cropPainterTargets(f.targets,[0,0,8,6]) as Surface[]
  expect(f.driver.copyColorRegion).toHaveBeenCalledTimes(1)
  expect(f.driver.copyColorRegion.mock.calls[0].slice(2)).toEqual([{x:20,y:10,w:8,h:6},[0,0]])
  expect(out.every(plane=>plane.texture===out[0].texture)).toBe(true)
  expect(f.renderer.aliases.get(out[0].texture)).toBe(4)
  expect(f.renderer.busy.has(f.input.texture)).toBe(false)
  const before=f.words.get(f.input.texture)!,after=f.words.get(out[0].texture)!
  for(let row=0;row<6;row++)expect(after.subarray(row*8*4,(row+1)*8*4)).toEqual(before.subarray(((10+row)*96+20)*4,((10+row)*96+28)*4))
  f.renderer.release(...out)
  expect(f.renderer.busy.size).toBe(0)
})
test('native suffix merge writes a smaller target while keeping original input addresses and shared owners', () => {
  const f = rendererFixture(); vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', '0')
  vi.stubEnv('VITE_DESIGN_PARENT_SUFFIX', '1')
  const output = f.renderer.suffixRect(f.input, { suffixBox: [0, 0, 8, 6] })
  const source = f.renderer.acquire({ x: -12, y: -3, w: 40, h: 32 })
  const out = f.renderer.merge(source, f.input, 'normal', 1, undefined, output) as Surface
  expect(out.rect).toEqual({ x: 0, y: 0, w: 8, h: 6 })
  expect(f.driver.copyColorRegion).not.toHaveBeenCalled()
  const u = f.driver.pass.mock.calls.at(-1)![1]
  expect([...u.slice(4, 12)]).toEqual([-12, -3, 40, 32, -20, -10, 96, 80])
  expect(f.renderer.aliases.get(f.input.texture)).toBe(3)
  expect(f.renderer.busy.has(source.texture)).toBe(true)
  f.renderer.release(out, source, ...f.targets.slice(1)); expect(f.renderer.busy.size).toBe(0)
})
test('native suffix cannot grow an already narrowed target or alter retained interaction captures', () => {
  const f = rendererFixture(); vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', '0')
  vi.stubEnv('VITE_DESIGN_PARENT_SUFFIX', '1')
  expect(f.renderer.suffixRect(f.input, { suffixBox: [-21, 0, 8, 6] })).toBeUndefined()
  f.renderer.scene.interactionRetained = true
  expect(f.renderer.suffixRect(f.input, { suffixBox: [0, 0, 8, 6] })).toBeUndefined()
  expect(f.driver.copyColorRegion).not.toHaveBeenCalled()
  expect(f.renderer.aliases.get(f.input.texture)).toBe(4)
})
test('native suffix cancellation keeps every old prefix owner until normal frame retirement', () => {
  const f = rendererFixture(); vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', '0')
  f.renderer.frameCurrent = () => false
  expect(() => f.renderer.merge(f.input, f.targets[1], 'normal', 1, undefined, { x: 0, y: 0, w: 8, h: 6 })).toThrow('PREVIEW_CANCELLED')
  expect(f.driver.copyColorRegion).not.toHaveBeenCalled()
  expect(f.renderer.aliases.get(f.input.texture)).toBe(4)
})
test('same physical texture at different logical phases receives independent exact crops',async()=>{
  const f=rendererFixture();f.targets[2].rect={...f.input.rect,x:-19};f.targets[3].rect={...f.input.rect,x:-19}
  const out=await f.renderer.cropPainterTargets(f.targets,[0,0,8,6]) as Surface[]
  expect(f.driver.copyColorRegion).toHaveBeenCalledTimes(2)
  expect(out[0].texture).toBe(out[1].texture);expect(out[2].texture).toBe(out[3].texture)
  expect(out[0].texture).not.toBe(out[2].texture)
  expect(f.words.get(out[0].texture)).not.toEqual(f.words.get(out[2].texture))
})
test('constant logical crops keep one physical texel and never copy unallocated coordinates',async()=>{
  const f=rendererFixture();f.input.texture.uniformColor=true
  const out=await f.renderer.cropPainterTargets(f.targets,[0,0,8,6]) as Surface[]
  expect(f.driver.copyColorRegion).not.toHaveBeenCalled()
  expect(out.every(plane=>plane.texture===f.input.texture&&plane.rect.w===8&&plane.rect.h===6)).toBe(true)
  expect(f.renderer.aliases.get(f.input.texture)).toBe(4)
})
test('a superseding request after admission encodes no copy and retains all prefix owners',async()=>{
  const f=rendererFixture();let current=true
  f.renderer.frameCurrent=()=>current;f.renderer.reclaimScratch=async()=>{current=false}
  await expect(f.renderer.cropPainterTargets(f.targets,[0,0,8,6])).rejects.toThrow('PREVIEW_CANCELLED')
  expect(f.driver.copyColorRegion).not.toHaveBeenCalled();expect(f.renderer.aliases.get(f.input.texture)).toBe(4)
  expect(f.renderer.busy.has(f.input.texture)).toBe(true)
})
test('disabled stages ignore optional metadata; invalid active suffixes fail before ownership changes',async()=>{
  const f=rendererFixture()
  vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX','0')
  expect(await f.renderer.cropPainterTargets(f.targets,[0,0,8,6])).toBe(f.targets)
  vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX','1')
  await expect(f.renderer.cropPainterTargets(f.targets,[-24,0,8,6])).rejects.toThrow('exceeds its prefix')
  expect(f.driver.copyColorRegion).not.toHaveBeenCalled();expect(f.renderer.aliases.get(f.input.texture)).toBe(4)
  for(const invalid of [[0,0,0,8],[0,0,8.5,8],[NaN,0,8,8],[0,0,16385,1],[1000000,0,8,8]])
    expect(()=>painterStageBox(invalid,f.renderer.scene.extent)).toThrow('native painter stage')
})
test('only exact four-sample full coverage is stored as a bounded constant mask',()=>{
  const f=rendererFixture(),r={x:0,y:0,w:8,h:6},header=1+r.h*4,curves=new Float32Array((header+r.h*4*3)*4)
  curves.set([3,1,r.w,r.h]);for(let row=0;row<r.h*4;row++){
    curves.set([header+row*3,1,0,0],4+row*4);curves.set([0,r.w,0,0],(header+row*3)*4)
  }
  f.renderer.scene.curves=curves
  const node={id:'frame',rect:r,fill:{count:3,rect:r,sampleCount:4,area:{first:0,count:curves.length/4}}} as GpuNode
  const mask=f.renderer.nodeMask(node) as Surface
  expect(mask.rect).toBe(r);expect(mask.texture.width).toBe(1);expect(mask.texture.height).toBe(1);expect(mask.texture.uniformColor).toBe(true)
  expect(f.driver.pass.mock.calls[0][1].slice(0,4)).toEqual(new Float32Array([0,0,1,1]))
  const g=rendererFixture();g.renderer.scene.curves=curves.slice();g.renderer.scene.curves[(header+2*3)*4]=1
  g.renderer.mask=vi.fn(()=>({partial:true}))
  expect(g.renderer.nodeMask(node)).toEqual({partial:true})
  expect(g.driver.pass).not.toHaveBeenCalled()
})
test('native integer opaqueRect can certify a full four-phase constant mask without interpreting header4 as tag3', () => {
  const f = rendererFixture(), r = { x: 4, y: 8, w: 24, h: 16 }
  const n = { id: 'native-rectangle', rect: r, fill: { rect: r, opaqueRect: { ...r }, count: 3, sampleCount: 4 } } as GpuNode
  f.renderer.sampleIndex = 0
  const mask = f.renderer.nodeMask(n) as Surface
  expect(mask.rect).toBe(r); expect(mask.texture.width).toBe(1); expect(mask.texture.height).toBe(1)
  expect(mask.texture.uniformColor).toBe(true); expect(f.driver.pass.mock.calls[0][1][16]).toBe(12)
})
test.each(['partial', 'fractional', 'sample-count', 'unselected', 'off'] as const)('%s opaqueRect cannot create a compact all-one certificate', mode => {
  const f = rendererFixture(), r = { x: 4, y: 8, w: 24, h: 16 }
  const n = { id: 'native-rectangle', rect: r, fill: { rect: r, opaqueRect: { ...r }, count: 3, sampleCount: 4 } } as GpuNode
  f.renderer.sampleIndex = mode === 'unselected' ? undefined : 0
  if (mode === 'partial') n.fill.opaqueRect!.w--
  if (mode === 'fractional') n.fill.opaqueRect!.x -= .25
  if (mode === 'sample-count') n.fill.sampleCount = 16
  if (mode === 'off') vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', '0')
  f.renderer.mask = vi.fn(() => ({ ordinary: true }))
  expect(f.renderer.nodeMask(n)).toEqual({ ordinary: true }); expect(f.driver.pass).not.toHaveBeenCalled()
})
test('backdrop consumes its wide four-plane prefix before cropping the complete parent suffix',async()=>{
  const f=rendererFixture(),events:string[]=[],run=f.renderer.run.bind(f.renderer)
  f.renderer.run=(mode:number,r:Rect,inputs:Surface[],...rest:any[])=>{
    if(mode===26){events.push('capture');expect(inputs).toBe(f.targets);expect(inputs.every(s=>s.rect.w===96)).toBe(true)}
    if(mode===25){events.push('replace');expect(r).toEqual({x:0,y:0,w:8,h:6})}
    return run(mode,r,inputs,...rest)
  }
  const copy=f.driver.copyColorRegion.getMockImplementation()!
  f.driver.copyColorRegion.mockImplementation((...args)=>{events.push('crop');return copy(...args)})
  f.renderer.blurBackdropRegion=async()=>{events.push('filter');return f.renderer.acquire({x:0,y:0,w:8,h:6})}
  const node={id:'background',rect:{x:0,y:0,w:8,h:6},backdropBox:[-20,-10,96,80],postCompositeBox:[0,0,8,6],
    matrix:[1,0,0,1,0,0],children:[],fills:[],strokes:[],effects:[],opaqueCoverage:true,blend:'normal',opacity:1} as unknown as GpuNode
  const result=await f.renderer.drawBackdropLeaf(node,f.targets,undefined,{kind:'background-blur',radius:32,visible:true})
  expect(events.indexOf('capture')).toBeLessThan(events.indexOf('filter'))
  expect(events.indexOf('filter')).toBeLessThan(events.indexOf('crop'))
  expect(events.indexOf('crop')).toBeLessThan(events.indexOf('replace'))
  expect(f.driver.copyColorRegion).toHaveBeenCalledTimes(1)
  expect(result.every((surface:Surface)=>surface.rect.w===8&&surface.rect.h===6)).toBe(true)
})
test('root rendering allocates its certified input and resolves only the requested output',async()=>{
  const f=rendererFixture(),run=f.renderer.run.bind(f.renderer),regions:{mode:number;rect:Rect}[]=[]
  f.renderer.run=(mode:number,r:Rect,...args:any[])=>{regions.push({mode,rect:{...r}});return run(mode,r,...args)}
  f.renderer.loadImages=async()=>{}
  Object.assign(f.driver,{begin(){},finish:vi.fn(async()=>({})),prepareScene:async()=>{},drawCalls:0,triangles:0})
  await f.renderer.renderAttempt({...f.renderer.scene,version:8,width:8,height:6,output:{x:0,y:0,w:8,h:6},
    rootInputBox:[-2,-2,12,10],background:'#ffffff',transparent:false,grid:true,
    view:{x:0,y:0,zoom:1},roots:[],nodes:{},vertices:[],floatCompositing:true},false,false)
  expect(regions.find(row=>row.mode===12)?.rect).toEqual({x:-2,y:-2,w:12,h:10})
  expect(regions.find(row=>row.mode===23)?.rect).toEqual({x:0,y:0,w:8,h:6})
  expect(regions.every(row=>row.rect.w<128&&row.rect.h<128)).toBe(true)
})
test('isolated child input may be wider than its final colors while the parent suffix preserves outside pixels',async()=>{
  const f=rendererFixture(),draw=f.renderer.drawBundle.bind(f.renderer)
  const node={id:'frame',rect:{x:-16,y:-8,w:80,h:72},childrenInputBox:[-16,-8,80,72],postCompositeBox:[-20,-10,96,80],
    matrix:[1,0,0,1,0,0],fill:{count:0},children:['child'],fills:[],strokes:[],effects:[],blend:'normal',opacity:1} as unknown as GpuNode
  f.renderer.scene.nodes={frame:node};f.renderer.scene.curves=[]
  f.renderer.independentSamples=()=>true // The stage must bypass this old shortcut.
  f.renderer.drawNode=vi.fn(()=>{throw Error('isolated child input was bypassed')})
  f.renderer.drawBundle=vi.fn(async(_ids:string[],targets:Surface[])=>{
    expect(targets.every(target=>target.rect.w===80&&target.rect.h===72)).toBe(true)
    return f.renderer.cropPainterTargets(targets,[0,0,8,6])
  })
  const result=await draw(['frame'],f.targets)
  expect(f.renderer.drawBundle).toHaveBeenCalledOnce()
  expect(f.renderer.drawNode).not.toHaveBeenCalled()
  expect(result.every((target:Surface)=>target.rect.w===96&&target.rect.h===80)).toBe(true)
})
test('a consumed current-frame horizontal plane obtains real completion before a new large merge allocation',async()=>{
  let complete!:()=>void,completed=false
  const create=vi.fn((width:number,height:number)=>({width,height,bytes:width*height*16,resource:{}} as Texture))
  const driver={name:'webgpu',managed:true,resourceEpoch:7,completedResourceEpoch:6,scratchBytes:0,create,
    checkpoint:vi.fn(async()=>{await new Promise<void>(resolve=>{complete=resolve});completed=true}),
    destroy:vi.fn(()=>{expect(completed).toBe(true)})}
  const renderer=new GpuRenderer(driver as unknown as Driver, true, true, undefined, false, false, 256) as any
  renderer.scene={};renderer.bytes=241675840
  const horizontal=create(2428,3658)
  renderer.free.set('2428:3658',[horizontal]);renderer.used.add(horizontal);renderer.poolReleaseEpoch.set(horizontal,7)
  expect(renderer.overBudget(2428*2428*16)).toBe(true)
  expect(driver.destroy).not.toHaveBeenCalled()
  const admission=renderer.reclaimForSurface({x:-1182,y:-222,w:2428,h:2428})
  expect(driver.checkpoint).toHaveBeenCalledOnce();expect(driver.destroy).not.toHaveBeenCalled()
  complete();await admission
  expect(driver.destroy).toHaveBeenCalledExactlyOnceWith(horizontal)
  expect(driver.completedResourceEpoch).toBe(6) // No forged current-frame epoch.
  const destination=renderer.acquire({x:-1182,y:-222,w:2428,h:2428})
  expect(destination.texture.width).toBe(2428)
  expect(renderer.bytes).toBeLessThanOrEqual(256*1024*1024)
})
test('a partial solid leaf obtains real headroom for its full paint target instead of failing on a differently sized free plane',async()=>{
  let complete!:()=>void,completed=false
  const create=(width:number,height:number)=>({width,height,bytes:width*height*16,resource:{}} as Texture)
  const driver={name:'webgpu',managed:true,exactSolidPaintOver:true,resourceEpoch:7,completedResourceEpoch:6,scratchBytes:0,create,
    checkpoint:vi.fn(async()=>{await new Promise<void>(resolve=>{complete=resolve});completed=true}),
    destroy:vi.fn(()=>expect(completed).toBe(true)),pass:vi.fn()}
  const renderer=new GpuRenderer(driver as unknown as Driver, true, true, undefined, false, false, 256) as any
  renderer.scene={};renderer.bytes=191288256
  const free=create(2428,2428);renderer.free.set('2428:2428',[free]);renderer.used.add(free);renderer.poolReleaseEpoch.set(free,7)
  const dst={texture:create(1,1),rect:{x:-1182,y:-222,w:2402,h:2428}} as Surface
  dst.texture.transparentZero=true;renderer.busy.add(dst.texture);renderer.aliases.set(dst.texture,5)
  const n={rect:{x:-100,y:20,w:1285,h:417},matrix:[1,0,0,1,0,0],inverse:[1,0,0,1,0,0],size:[1285,417]} as GpuNode
  const mask={texture:create(1283,416),rect:{x:-99,y:20,w:1283,h:416}} as Surface
  const solid=paint('#8f755f')
  expect(renderer.overBudget(2402*2428*16)).toBe(true)
  const admission=renderer.reclaimForPaintOver(n,solid,mask,dst)
  expect(admission).toBeInstanceOf(Promise);expect(driver.checkpoint).toHaveBeenCalledOnce();expect(driver.destroy).not.toHaveBeenCalled()
  complete();await admission
  const out=renderer.paintOver(n,solid,mask,dst) as Surface
  expect(driver.destroy).toHaveBeenCalledExactlyOnceWith(free)
  expect(driver.pass.mock.calls.at(-1)![1][16]).toBe(47)
  expect(out.rect).toEqual(dst.rect);expect(renderer.bytes).toBeLessThanOrEqual(256*1024*1024)
  expect(renderer.aliases.get(dst.texture)).toBe(4)
})
test('paint admission keeps existing constants, one-texel fills and small regional saves out of whole-target pressure',()=>{
  const f=rendererFixture(),{renderer}=f
  renderer.allowSolidBatch=false
  renderer.bytes=255*1024*1024
  const dst={texture:{width:2402,height:2428,bytes:2402*2428*16,resource:{}} as Texture,
    rect:{x:0,y:0,w:2402,h:2428}} as Surface
  const n={rect:dst.rect,opaqueCoverage:true,matrix:[1,0,0,1,0,0],inverse:[1,0,0,1,0,0],size:[2402,2428]} as GpuNode
  const solid=paint('#8f755f'),mask={texture:{width:1,height:1,bytes:4,resource:{}} as Texture,rect:dst.rect}
  // Existing opaque-solid path uses the already-admitted uniform protocol.
  expect(renderer.reclaimForPaintOver(n,solid,mask,dst)).toBeUndefined()
  expect(renderer.reclaimScratch).not.toHaveBeenCalled()
  renderer.constantTargets.set(renderer.constantTargetKey(dst.rect, solid.color),{texture:dst.texture,rect:dst.rect})
  expect(renderer.reclaimForPaintOver(n,solid,mask,dst)).toBeUndefined()
  expect(renderer.reclaimScratch).not.toHaveBeenCalled()
  renderer.constantTargets.clear();Object.assign(f.driver,{exactSolidPaintOver:true})
  n.opaqueCoverage=false;n.rect={x:20,y:30,w:16,h:12};mask.rect=n.rect
  expect(renderer.reclaimForPaintOver(n,solid,mask,dst)).toBeUndefined()
  expect(renderer.reclaimScratch).not.toHaveBeenCalled()
})

test.each(['rgba8unorm','rgba32float'])('owned %s color stage copies encode no float arithmetic and revoke only target proofs',format=>{
  const source={width:96,height:80,bytes:96*80*(format==='rgba8unorm'?4:16),resource:{width:96,height:80,format}} as unknown as Texture
  const target={width:8,height:6,bytes:8*6*(format==='rgba8unorm'?4:16),resource:{width:8,height:6,format},finitePixels:true,uniformColor:true} as unknown as Texture
  const copy=vi.fn(),driver=Object.assign(Object.create(WebGpuDriver.prototype),{textures:new Set([source,target]),replayParameterTextures:new Set(),closeOver:vi.fn(),encoder:{copyTextureToTexture:copy}}) as WebGpuDriver
  driver.copyColorRegion(target,source,{x:20,y:10,w:8,h:6},[0,0])
  expect(copy).toHaveBeenCalledExactlyOnceWith({texture:source.resource,origin:[20,10]},{texture:target.resource,origin:[0,0]},[8,6])
  expect(target.finitePixels).toBeUndefined();expect(target.uniformColor).toBeUndefined()
  for(const [from,r,to]of [[{...source},{x:0,y:0,w:8,h:6},[0,0]],[source,{x:90,y:0,w:8,h:6},[0,0]],[source,{x:0,y:0,w:8,h:6},[1,0]]]as const)
    expect(()=>driver.copyColorRegion(target,from as Texture,r,[...to])).toThrow('native painter color copy')
  expect(copy).toHaveBeenCalledOnce()
})

test.each(['json', 'typed', 'off'] as const)('%s curve preparation binds candidate proofs to exactly the uploaded frame snapshot', async mode => {
  const f = rendererFixture(), curves = mode === 'json' ? [3, 1, 8, 6] : new Float32Array([3, 1, 8, 6])
  if (mode === 'off') vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', '0')
  let preparedCurves: unknown
  f.renderer.loadImages = async () => {}
  Object.assign(f.driver, { begin: vi.fn(), finish: vi.fn(async () => ({})), drawCalls: 0, triangles: 0,
    prepareScene: async (scene: any) => { preparedCurves = scene.curves; curves[0] = 99; await Promise.resolve() } })
  await f.renderer.renderAttempt({ ...f.renderer.scene, version: 8, width: 8, height: 6,
    output: { x: 0, y: 0, w: 8, h: 6 }, rootInputBox: [-2, -2, 12, 10], background: '#ffffff',
    transparent: false, grid: true, view: { x: 0, y: 0, zoom: 1 }, roots: [], nodes: {}, vertices: [], curves,
    floatCompositing: true }, false, false)
  const uploaded = f.driver.begin.mock.calls[0][1]
  expect(uploaded[0]).toBe(mode === 'off' ? 99 : 3)
  expect(uploaded).toBe(preparedCurves)
  expect(uploaded === curves).toBe(mode === 'off')
})
test('shared mutable program storage is rejected before candidate preparation or GPU begin', async () => {
  const f = rendererFixture(), curves = new Float32Array(new SharedArrayBuffer(16))
  Object.assign(f.driver, { begin: vi.fn(), prepareScene: vi.fn() })
  await expect(f.renderer.renderAttempt({ ...f.renderer.scene, curves })).rejects.toThrow('unshared snapshot')
  expect(f.driver.prepareScene).not.toHaveBeenCalled(); expect(f.driver.begin).not.toHaveBeenCalled()
})
