/** Read-only CPU recording of real HDR render-graph uniforms. No GPU device or pixels are created. */
import { readFile,writeFile,mkdtemp,mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
const frozen=process.env.DESIGN_RECORDING_BENCHMARK
if(!frozen) throw new Error('DESIGN_RECORDING_BENCHMARK must name a frozen benchmark containing snapshot/, fixture.fd, and results.json')
const output=process.env.DESIGN_TEST_OUTPUT || await mkdtemp(join(tmpdir(),'forma-corner-eligibility-'))
await mkdir(output,{recursive:true})
const benchmark=JSON.parse(await readFile(join(frozen,'results.json'),'utf8'))
const root=frozen+'/snapshot/frontend/design-client'
const {initSync,VectorEngine}=await import(root+'/src/generated/design-kernel/design_kernel.js')
const {GpuRenderer}=await import(root+'/src/kernel/gpu/renderer.ts')
const {parameters}=await import(root+'/src/kernel/gpu/types.ts')
const {planTiles,devicePixelPhase}=await import(root+'/src/kernel/tile-cache.ts')
const wasm=await readFile(root+'/public/kernel/design_kernel_bg.wasm');initSync({module:wasm})
const font=await readFile(root+'/public/fonts/NotoSansSC.ttf')
const docBytes=await readFile(frozen+'/fixture.fd'), document=JSON.parse(docBytes.toString())
if(!document.colorManagement || document.rasterProfile!=='figma') throw Error('Expected managed Figma fixture')
const kernel=new VectorEngine();kernel.load_font(font);kernel.load_document(JSON.stringify(document))
let sceneInfo:any, serial=0
const rows:any[]=[], allModes=new Map<number,number>(), live=new Set<any>()
let masks=0, nonAreaMasks=0
const texture=(w:number,h:number,binary=false)=>{const t={width:w,height:h,bytes:w*h*(binary?4:16),binaryCoverage:binary,resource:{serial:++serial}};live.add(t);return t}
const record=(target:any,u:Float32Array,inputs:any[],region?:any,finish=false)=>{
 const mode=u[16];allModes.set(mode,(allModes.get(mode)||0)+1)
 if(mode!==0&&mode!==3)return
 const fields=Array.from(u.subarray(0,16))
 const current=fields.every(v=>Number.isInteger(v)&&Math.abs(v)<=1048576)&&u[242]===0
 const unusedRejected=fields.map((v,i)=>({i,v})).filter(({i,v})=>!Number.isInteger(v)||Math.abs(v)>1048576)
 const origins=[0,1,4,5,...(mode===3?[8,9]:[])]
 const originOnly=origins.every(i=>Number.isInteger(u[i])&&Math.abs(u[i])<=1048576)&&u[242]===0
 const phases=[Math.fround(u[0]-u[4]),Math.fround(u[1]-u[5]),...(mode===3?[Math.fround(u[0]-u[8]),Math.fround(u[1]-u[9])]:[])]
 const sharedPhase=phases.every(Number.isInteger)&&origins.every(i=>Math.abs(u[i])<=1048576)&&u[242]===0
 rows.push({...sceneInfo,mode,blend:u[17],finish,current,originOnly,sharedPhase,fields,display:u[242],unusedRejected,
  target:{w:target.width,h:target.height},region:region??null})
}
const driver:any={name:'webgpu',description:'CPU recording driver; no WebGPU device',canvas:{},lost:false,managed:true,linearLight:true,hdr:true,
 certifiedFilter:true,exactSolidPaintOver:true,drawCalls:0,triangles:0,commandSubmissions:0,
 prepareScene:async()=>{},prepareFilters:async()=>{},begin(){this.drawCalls=0},
 create:(w:number,h:number)=>texture(w,h),createBinaryCoverage:(w:number,h:number)=>texture(w,h,true),destroy:(t:any)=>{if(!live.delete(t))throw Error('double-destroy')},
 upload:()=>{throw Error('unexpected bitmap')},uploadParameters:(_v:any,w:number,h:number)=>texture(w,h),
 uploadLinear:(_v:any,w:number,h:number)=>texture(w,h),uploadRgba8:(_v:any,w:number,h:number)=>texture(w,h),
 clear:()=>{},mask:(path:any)=>{masks++;if(!path.area)nonAreaMasks++},
 pass(target:any,u:Float32Array,inputs:any[],region?:any){this.drawCalls++;record(target,u,inputs,region)},
 over(){throw Error('managed over unexpected')},checkpoint:async()=>{},
 async finish(source:any,r:any,w:number,h:number,readback:boolean,_preview:any,_present:any,output:any){
  if(readback){const target=texture(w,h),u=parameters(output??{x:0,y:0,w,h},r);u[16]=0;record(target,u,[source],undefined,true);live.delete(target)}return{}
 },dispose:()=>{live.clear()},loseDeviceForTesting:async()=>{throw Error('no device')}
}
const renderer=new GpuRenderer(driver,true,false)
const frames=[]
try{
 for(const reference of benchmark.rows.filter((r:any)=>r.iteration===0)){
  const {zoom,view,width,height}=reference
  const tiles=planTiles({x:-view.x/zoom,y:-view.y/zoom,width:width/zoom,height:height/zoom},zoom,256,{x:devicePixelPhase(view.x,1),y:devicePixelPhase(view.y,1)})
  if(tiles.length!==reference.tiles) throw Error('Tile plan differs from immutable benchmark')
  const start=performance.now(),before=rows.length
  for(const [index,tile] of tiles.entries()){
   const crop={x:tile.x+Math.floor(view.x),y:tile.y+Math.floor(view.y),w:tile.width,h:tile.height}
   const scene=JSON.parse(kernel.compile_gpu(JSON.stringify({pageId:document.pages[0].id,width:tile.width,height:tile.height,view,transparent:false,grid:true,rasterProfile:'figma',gpuViewport:crop})))
   sceneInfo={zoom,tile:index,crop,extent:scene.extent}
   await renderer.render(scene,true,false)
  }
  const part=rows.slice(before),byMode=Object.fromEntries([0,3].map(mode=>{const m=part.filter(r=>r.mode===mode);return[mode,{passes:m.length,current:m.filter(r=>r.current).length,originOnlyNew:m.filter(r=>!r.current&&r.originOnly).length,sharedPhaseNew:m.filter(r=>!r.current&&r.sharedPhase).length,pixels:m.reduce((n,r)=>n+r.target.w*r.target.h,0)}]}))
  frames.push({zoom,tiles:tiles.length,recordingCpuMs:performance.now()-start,byMode});console.log(JSON.stringify(frames.at(-1)))
 }
}finally{renderer.dispose();kernel.free()}
const hash=(b:any)=>createHash('sha256').update(b).digest('hex')
const result={scope:'Actual immutable HDR fixture and WASM scene compilation, production GpuRenderer with a no-pixel/no-GPU recording Driver. finish mode0 modeled from WebGpuDriver.finish; area mask passes are not eligible modes.',fixtureSha256:hash(docBytes),wasmSha256:hash(wasm),rendererSha256:hash(await readFile(root+'/src/kernel/gpu/renderer.ts')),webgpuSha256:hash(await readFile(root+'/src/kernel/gpu/webgpu.ts')),fontSha256:hash(font),frames,masks,nonAreaMasks,allModes:Object.fromEntries(allModes),misses:rows.filter(r=>!r.current),rows}
if(frames.length!==2)throw Error('Expected exactly two initial camera records')
await writeFile(join(output,'results.json'),JSON.stringify(result))
console.log(JSON.stringify({output,misses:result.misses.length,passes:rows.length}))
