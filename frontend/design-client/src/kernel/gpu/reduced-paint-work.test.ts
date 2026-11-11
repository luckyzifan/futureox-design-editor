import {afterEach,expect,test,vi} from 'vitest'
import {GpuRenderer} from './renderer'
import {WebGpuDriver} from './webgpu'
import {paint} from '../../model'
import {bindScenePlan,opaqueSolidRuns,boundedPaintGroup} from './scene-index'
import {compiled_scene_plan_json} from '../../generated/design-kernel/design_kernel'
import type {GpuNode,GpuScene,Rect,Texture} from './types'
import {gradientFieldMaximumStop,gradientFusionWorthwhile} from './gradient-paint-over'
import {CoverageCache} from './coverage-cache'

afterEach(()=>vi.unstubAllEnvs())
const bounds={x:0,y:0,w:64,h:64}
const leaf=(id:string,kind='solid'):GpuNode=>({id,rect:bounds,matrix:[1,0,0,1,0,0],inverse:[1,0,0,1,0,0],size:[64,64],
 fill:{first:0,count:3,rule:'nonzero',rect:bounds,sampleCount:4,area:{first:0,count:7},opaqueRect:bounds},
 fills:[{...paint('#3478ab'),kind:kind as any,stops:[{offset:0,color:'#123456'},{offset:1,color:'#abcdef'}]}],
 strokes:[],effects:[],children:[],mask:false,clip:false,opacity:1,blend:'normal'})
function fixture(){
 const create=(width:number,height:number,binary=false)=>({width,height,bytes:width*height*(binary?4:16),resource:{},...(binary?{binaryCoverage:true as const}:{})}) as Texture
 const driver:any={name:'webgpu',managed:true,constantTextureSampling:true,zeroTextureSampling:true,exactGradientPaintOver:true,
  create,createBinaryCoverage:(w:number,h:number)=>create(w,h,true),createConstantCoverage:vi.fn(()=>({...create(1,1,true),uniformColor:true})),clear:vi.fn(),pass:vi.fn(),destroy:vi.fn(),checkpoint:vi.fn(async()=>{})}
 const renderer=new GpuRenderer(driver,true,false) as any
 renderer.scene={coherentSamples:true,colorManagement:{documentSpace:'srgb',referenceWhiteNits:203,peakLuminanceNits:1000},curves:new Float32Array(0),extent:bounds,view:{x:0,y:0,zoom:1},nodes:{},roots:[]}
 renderer.sampleIndex=0;renderer.fastWork.reset(true)
 const surface=(r:Rect=bounds,binary=false)=>renderer.acquire(r,binary)
 return {renderer,driver,surface}
}
function mixedScene(){
 const ids=Array.from({length:27},(_,i)=>'n'+i),nodes:any={}
 for(const [i,id]of ids.entries())nodes[id]=leaf(id,i===12?'linear':'solid')
 nodes.n1.opacity=.5 // short 1-node prefix must not suppress later useful runs
 nodes.parent={...leaf('parent'),children:ids,fills:[]}
 const scene={roots:['parent'],nodes} as GpuScene
 return {scene,ids}
}
test('native sparse runs retain both sides of a gradient and do not reorder short spans',()=>{
 const {scene,ids}=mixedScene(),plan=JSON.parse(compiled_scene_plan_json(JSON.stringify(scene)))
 bindScenePlan(scene,plan)
 expect(opaqueSolidRuns(scene,ids)).toEqual([{start:2,end:12,color:'#3478ab'},{start:13,end:27,color:'#3478ab'}])
 expect(boundedPaintGroup(scene,ids)).toBe(true)
 for(const patch of [{effects:[{kind:'blur',visible:true}]},{mask:true},{blend:'multiply'},{children:['n0']},{opacity:Infinity}]){
  const changed=structuredClone(scene);Object.assign(changed.nodes.n12,patch)
  if(patch.opacity===Infinity)continue // invalid JSON numbers are rejected before a compiled scene
  const p=JSON.parse(compiled_scene_plan_json(JSON.stringify(changed)));bindScenePlan(changed,p)
  expect(boundedPaintGroup(changed,changed.nodes.parent.children)).toBe(false)
 }
 const overlap=structuredClone(plan);overlap.opaqueSolidRuns[1][1]=11
 expect(()=>bindScenePlan(scene,overlap)).toThrow('solid run')
})
test('mixed execution alternates ordinary spans and private GPU batches for all four phases',async()=>{
 vi.stubEnv('VITE_DESIGN_MIXED_SOLID_RUNS','1')
 const f=fixture(),{scene,ids}=mixedScene();f.renderer.scene={...f.renderer.scene,...scene}
 const events:any[]=[]
 f.driver.prepareOpaqueSolids=vi.fn((nodes:any[])=>({count:nodes.length,pixels:nodes.length*4096}))
 f.driver.solidBatchRemaining=()=>100
 f.driver.drawOpaqueSolids=vi.fn((batch:any,_t:any,sample:number)=>{events.push(['batch',sample,batch.count]);return true})
 f.renderer.drawList=vi.fn(async(ids:string[],dst:any)=>{events.push(['ordinary',f.renderer.sampleIndex,ids]);return dst})
 const original=f.renderer.emptyBundle(bounds)
 const out=await f.renderer.drawOpaqueGroup(ids,original,[0,1,2,3])
 expect(out).toHaveLength(4)
 for(let phase=0;phase<4;phase++)expect(events.slice(phase*4,phase*4+4)).toEqual([
  ['ordinary',phase,['n0','n1']],['batch',phase,10],['ordinary',phase,['n12']],['batch',phase,14]])
 expect(f.renderer.fastWork.snapshot()).toMatchObject({fastSolidBatches:8,fastSolidNodes:96})
 expect(new Set(out.map((s:any)=>s.texture)).size).toBe(4)
})
test('mixed batches reject nontransparent destinations before prepare or writes',async()=>{
 vi.stubEnv('VITE_DESIGN_MIXED_SOLID_RUNS','1')
 const f=fixture(),{scene,ids}=mixedScene();f.renderer.scene={...f.renderer.scene,...scene}
 f.driver.prepareOpaqueSolids=vi.fn();f.driver.drawOpaqueSolids=vi.fn()
 expect(await f.renderer.drawOpaqueGroup(ids,[f.surface()],[0])).toBeUndefined()
 expect(f.driver.prepareOpaqueSolids).not.toHaveBeenCalled();expect(f.driver.pass).not.toHaveBeenCalled()
})
test('independent constant coverage shares one texel with original logical bounds; partial shapes fall back',()=>{
 vi.stubEnv('VITE_DESIGN_CONSTANT_COVERAGE','1');vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX','0')
 const f=fixture(),a=leaf('a'),b=leaf('b');b.rect={x:20,y:30,w:8,h:8};b.fill={...b.fill,rect:b.rect,opaqueRect:b.rect}
 const first=f.renderer.nodeMask(a),second=f.renderer.nodeMask(b)
 expect(first.texture).toBe(second.texture);expect(second.rect).toBe(b.rect);expect(first.texture.bytes).toBe(4)
 expect(f.driver.pass).not.toHaveBeenCalled();expect(f.driver.createConstantCoverage).toHaveBeenCalledTimes(1)
 f.renderer.mask=vi.fn(()=>({fallback:true}));const partial=leaf('partial');partial.fill.opaqueRect={x:1,y:1,w:2,h:2}
 expect(f.renderer.nodeMask(partial)).toEqual({fallback:true})
 expect(f.renderer.fastWork.snapshot()).toMatchObject({fastCoverageConstant:1,fastCoverageShared:1,fastCoverageRejected:1})
})
test('gradient fusion retains the original field origin and clips only destination writes',async()=>{
 const f=fixture(),n=leaf('gradient','linear');n.rect={x:8,y:10,w:8,h:6};n.fill.rect=n.rect
 const mask=f.surface(n.rect,true),dst=f.surface(),field=f.surface({x:8,y:10,w:8,h:1})
 f.renderer.gradientFieldProofs.set(field.texture,{resource:field.texture.resource,maximumStop:1})
 f.renderer.gradientGrid=vi.fn(()=>field)
 expect(f.renderer.gradientFusionEligible(n,n.fills[0],mask,dst)).toBe(true)
 const out=await f.renderer.paintOver(n,n.fills[0],mask,dst,undefined,true)
 expect(out).toBe(dst)
 expect(f.driver.pass.mock.calls.map((c:any[])=>c[1][16])).toEqual([0,65])
 const call=f.driver.pass.mock.calls[1]
 expect([...call[1].slice(36,40)]).toEqual([8,10,8,6])
 expect(call[2][0]).toBe(mask.texture);expect(call[2][3]).toBe(field.texture)
 expect(call[3]).toEqual({x:7,y:9,w:10,h:8})
 expect(f.renderer.fastWork.snapshot()).toMatchObject({fastGradientFused:1,fastGradientSavedPixels:48,fastRegionalUsed:1})
})
test.each(['fractional','continuous-coverage','wide-color','blend','large-field'])('gradient %s retains the original path',kind=>{
 const f=fixture(),n=leaf('g','linear'),mask=f.surface(bounds,true),dst=f.surface()
 if(kind==='fractional')n.rect={...bounds,x:.25}
 if(kind==='continuous-coverage')delete mask.texture.binaryCoverage
 if(kind==='wide-color'){n.fills[0].color='color(srgb-linear 2 0 0 / 1)';f.renderer.scene.colors={[n.fills[0].color]:[2,0,0,1]}}
 if(kind==='blend')n.fills[0].blend='multiply'
 if(kind==='large-field')n.rect={...bounds,w:1024,h:1024}
 expect(f.renderer.gradientFusionEligible(n,n.fills[0],mask,dst)).toBe(false)
 expect(f.driver.pass).not.toHaveBeenCalled()
})
test('gradient pending admission pins all input owners and cancellation publishes no fused pass',async()=>{
 const f=fixture(),n=leaf('g','linear'),mask=f.surface(bounds,true),dst=f.surface(),field=f.surface()
 f.renderer.gradientFieldProofs.set(field.texture,{resource:field.texture.resource,maximumStop:1})
 f.renderer.gradientGrid=()=>field
 let current=true,finish!:()=>void
 f.renderer.frameCurrent=()=>current;f.renderer.bytes=f.renderer.frameBudget
 f.renderer.reclaimScratch=vi.fn(()=>new Promise<void>(resolve=>{finish=()=>{f.renderer.bytes=0;resolve()}}))
 const pending=f.renderer.paintOver(n,n.fills[0],mask,dst,undefined,true)
 expect(pending).toBeInstanceOf(Promise)
 for(const input of [mask,dst,field])expect(f.renderer.admissionPins.has(input.texture)).toBe(true)
 current=false;finish();await expect(pending).rejects.toThrow('PREVIEW_CANCELLED')
 expect(f.driver.pass).not.toHaveBeenCalled();expect(f.driver.destroy).not.toHaveBeenCalled()
 expect(f.renderer.admissionPins.size).toBe(0)
})
test('gradient field proof rejects invalid indices, nonfinite neighbours and extrapolation',()=>{
 expect(gradientFieldMaximumStop(new Float32Array([0,1,.5,0,-1,-1,0,0]))).toBe(1)
 for(const row of [[0,1,NaN,0],[0,64,.5,0],[.5,1,.5,0],[0,1,1.1,0],[0,1,.5,Infinity]])
  expect(gradientFieldMaximumStop(new Float32Array(row))).toBeUndefined()
})
test('a gradient field from another resource falls back to the actual two-pass path',async()=>{
 const f=fixture(),n=leaf('g','linear'),mask=f.surface(bounds,true),dst=f.surface(),field=f.surface()
 f.renderer.gradientGrid=()=>field
 f.renderer.gradientFieldProofs.set(field.texture,{resource:{},maximumStop:1})
 await f.renderer.paintOver(n,n.fills[0],mask,dst,undefined,true)
 expect(f.driver.pass.mock.calls.map((c:any[])=>c[1][16])).toEqual([2,3])
})
test.each(['solid fill', 'gradient stroke'])('normalized analytic %s composites the full isolation layer in one pass', async kind => {
 const f=fixture(),n=leaf('isolated',kind==='solid fill'?'solid':'linear')
 const mask={...f.surface(),normalizedCoverage:true as const}
 f.renderer.scene={...f.renderer.scene,coherentSamples:false,nodes:{[n.id]:n}}
 f.renderer.outputFrame={present:true,readback:false}
 f.renderer.sampleIndex=undefined
 f.driver.exactSolidPaintOver=true
 f.renderer.fillMask=()=>mask
 f.renderer.mask=()=>mask
 if(kind==='gradient stroke'){
  n.strokes=[{path:n.fill,paint:n.fills[0],align:'center'}];n.fills=[]
  const field=f.surface()
  f.renderer.gradientGrid=()=>field
  f.renderer.gradientFieldProofs.set(field.texture,{resource:field.texture.resource,maximumStop:1})
 }
 const out=await f.renderer.node(n.id,f.surface())
 expect(out.rect).toEqual(bounds)
 expect(f.driver.pass.mock.calls.map((call:any[])=>call[1][16])).toEqual([kind==='solid fill'?47:65])
 expect(f.driver.pass.mock.calls[0][3]).toBeUndefined()
})
test.each(['uncertified coverage','readback'])('analytic gradient with %s retains its paint texture', async kind => {
 const f=fixture(),n=leaf('isolated','linear')
 const mask=f.surface()
 if(kind==='readback')mask.normalizedCoverage=true
 f.renderer.scene={...f.renderer.scene,coherentSamples:false,nodes:{[n.id]:n}}
 f.renderer.outputFrame={present:true,readback:kind==='readback'}
 f.renderer.sampleIndex=undefined
 f.renderer.fillMask=()=>mask
 const field=f.surface()
 f.renderer.gradientGrid=()=>field
 f.renderer.gradientFieldProofs.set(field.texture,{resource:field.texture.resource,maximumStop:1})
 await f.renderer.node(n.id,f.surface())
 expect(f.driver.pass.mock.calls.map((call:any[])=>call[1][16])).toEqual([2,3])
})
test('stroke alignment preserves normalized coverage only with two proved inputs',()=>{
 const f=fixture(),normalized={...f.surface(),normalizedCoverage:true as const}
 expect(f.renderer.combine(normalized,f.surface(bounds,true),bounds,true).normalizedCoverage).toBe(true)
 expect(f.renderer.combine(normalized,f.surface(),bounds,true).normalizedCoverage).toBeUndefined()
})
test('analytic gradient can fuse normalized paint and clip while preserving the normal merge region', async () => {
 const f=fixture(),n=leaf('g','linear')
 n.rect={x:8,y:10,w:8,h:6}
 f.renderer.scene.coherentSamples=false
 f.renderer.outputFrame={present:true,readback:false}
 const mask={...f.surface(n.rect),normalizedCoverage:true as const}
 const clip={...f.surface(bounds),normalizedCoverage:true as const}
 const field=f.surface(n.rect),dst=f.surface()
 f.renderer.gradientGrid=()=>field
 f.renderer.gradientFieldProofs.set(field.texture,{resource:field.texture.resource,maximumStop:1})
 expect(await f.renderer.paintOver(n,n.fills[0],mask,dst,clip,true)).toBe(dst)
 expect(f.driver.pass.mock.calls.map((call:any[])=>call[1][16])).toEqual([0,65])
 expect(f.driver.pass.mock.calls[1][2][1]).toBe(clip.texture)
 expect(f.driver.pass.mock.calls[1][3]).toEqual({x:7,y:9,w:10,h:8})
})
test('coverage miss reasons separate absent keys from unequal exact geometry words without exposing content',()=>{
 const f=fixture(),cache=new CoverageCache(1024,3,vi.fn()),words=new Uint32Array([1,2])
 cache.begin(true);expect(cache.get('shape',words)).toBeUndefined()
 cache.put('shape',words,f.surface({x:0,y:0,w:1,h:1}).texture)
 expect(cache.get('shape',new Uint32Array([1,3]))).toBeUndefined()
 expect(cache.get('shape',words)).toBeDefined()
 expect([cache.missKeys,cache.missWords,cache.hits]).toEqual([1,1,1])
 cache.begin();cache.get('absent',words);expect([cache.missKeys,cache.missWords,cache.hits]).toEqual([0,0,0])
})
test('scene cost screening avoids singleton gradients without authorizing pixels or changing unsupported paint',()=>{
 const a=leaf('a','linear'),b=leaf('b','radial'),scene={nodes:{a},curves:new Float32Array([4,0,1,1])} as unknown as GpuScene
 expect(gradientFusionWorthwhile(scene)).toBe(false)
 scene.nodes.b=b;expect(gradientFusionWorthwhile(scene)).toBe(true)
 b.fills[0].blend='multiply';expect(gradientFusionWorthwhile(scene)).toBe(false)
 b.fills[0].blend='normal';scene.curves=new Float32Array([1,0,1,1]);expect(gradientFusionWorthwhile(scene)).toBe(false)
})
test('constant coverage allocates the promised RGBA8 resource instead of the managed float-image upload',()=>{
 const texture={bytes:4,width:1,height:1,resource:{format:'rgba8unorm'},binaryCoverage:true}
 const driver:any=Object.assign(Object.create(WebGpuDriver.prototype),{managed:true,createBinaryCoverage:vi.fn(()=>texture),
  uploadRgba8:vi.fn(()=>{throw Error('Wrong managed upload path')}),device:{queue:{writeTexture:vi.fn()}}})
 expect(driver.createConstantCoverage()).toBe(texture);expect(texture).toMatchObject({bytes:4,uniformColor:true,binaryCoverage:true})
 expect(driver.createBinaryCoverage).toHaveBeenCalledWith(1,1)
 expect(driver.device.queue.writeTexture.mock.calls[0][1]).toEqual(new Uint8Array([255,255,255,255]))
 expect(driver.uploadRgba8).not.toHaveBeenCalled()
})
