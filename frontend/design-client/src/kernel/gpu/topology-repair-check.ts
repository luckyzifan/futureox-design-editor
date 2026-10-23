// Owned validation page: actual production kernels/drivers, no GPU mocks.
import {initializePicking} from '../picking'
import {VectorEngine} from '../../generated/design-kernel/design_kernel'
import {createGpu} from './factory'
import {decodeScenePacket} from './scene-packet'
import {renderRuntimeEvidence} from '../runtime-evidence'
const report:{status:string;runtime?:unknown;cases:unknown[];error?:string}={status:'running',cases:[]}
const output=document.querySelector('#results')!
const publish=async()=>{output.textContent=JSON.stringify(report,null,2);await fetch('/__render_report',{method:'POST',body:JSON.stringify(report)})}
const color={documentSpace:'srgb' as const,referenceWhiteNits:203,peakLuminanceNits:1000}
function fixture(count:number,kind:string,width=48,height=32){return {schemaVersion:16,id:'gradient-stop-oracle',name:'gradient-stop-oracle',colorManagement:color,
 pages:[{id:'p',name:'p',children:['n'],background:'#000000'}],nodes:{n:{id:'n',kind:'rectangle',width,height,fills:[{kind,color:'#000000',opacity:.73,angle:23.75,
 stops:Array.from({length:count},(_,i)=>({offset:i===18&&count>32?17/(count-1):i/(count-1),color:`color(srgb-linear ${i%3===0?2.25:-.125} ${i%5/4} ${i%7/6} / ${.25+(i%4)/4})`}))}]}}}}
const compare=(a:Float32Array,b:Float32Array)=>{if(a.length!==b.length)throw Error('Pixel extent mismatch');const x=new Uint32Array(a.buffer,a.byteOffset,a.length),y=new Uint32Array(b.buffer,b.byteOffset,b.length);let mismatches=0;for(let i=0;i<x.length;i++)mismatches+=Number(x[i]!==y[i]);return{words:x.length,mismatches}}
try{
 report.runtime=await renderRuntimeEvidence();await initializePicking()
 for(const backend of ['webgpu','webgl2'] as const){
  const gpu=await createGpu(backend,true,false,color,undefined,false,true)
  try{for(const kind of ['linear','radial'])for(const count of [32,36,64]){
   const kernel=new VectorEngine();try{
    const doc=fixture(count,kind),options=JSON.stringify({pageId:'p',width:48,height:32,view:{x:0,y:0,zoom:1},transparent:true,grid:false,rasterProfile:'figmaSubpixel'})
    kernel.load_document(JSON.stringify(doc));const scene=decodeScenePacket(kernel.compile_gpu_packet(options))
    const pixels=(await gpu.render(scene,true,false)).linear;if(!pixels)throw Error('Missing GPU linear pixels')
    const expected=kernel.render_linear(options),difference=compare(pixels,expected)
    report.cases.push({backend,kind,count,...difference,description:gpu.driver.description});await publish()
    if(difference.mismatches)throw Error(`Float oracle mismatch: ${backend}/${kind}/${count}`)
   }finally{kernel.free()}
  }}finally{gpu.dispose()}
 }
 // Same driver/policy and scene; replace only the candidate chunk hook for
 // the dense control. Raw float comparison also catches origin/phase mistakes.
 const kernel=new VectorEngine()
 try{
  kernel.load_document(JSON.stringify(fixture(36,'radial',600,512)))
  const scene=decodeScenePacket(kernel.compile_gpu_packet(JSON.stringify({pageId:'p',width:600,height:512,view:{x:.125,y:-.375,zoom:1},transparent:true,grid:false,rasterProfile:'figmaSubpixel'})))
  const samples:Float32Array[]=[]
  for(const chunked of [false,true]){
   const gpu=await createGpu('webgpu',true,false,color,undefined,false,true);gpu.driver.captureDisplay=true
   const internal=gpu as any;let calls=0;const original=internal.paintWithCooperativeGradient.bind(gpu)
   internal.paintWithCooperativeGradient=(n:unknown,p:unknown,m:unknown)=>{calls++;return chunked?original(n,p,m):internal.paint(n,p,m,undefined,true)}
   try{const pixels=(await gpu.render(scene,true,false)).linear;if(!pixels||!calls)throw Error('Gradient chunk lane not reached');samples.push(pixels.slice());report.cases.push({name:'chunk-lane',chunked,calls})}finally{gpu.dispose()}
  }
  const difference=compare(samples[0],samples[1]);report.cases.push({name:'chunk-vs-dense',...difference});await publish();if(difference.mismatches)throw Error('Chunked gradient changed float pixels')
  for(const chunked of [false,true]){
   const gpu=await createGpu('webgpu',true,false,color,undefined,false,true);gpu.driver.captureDisplay=true
   const internal=gpu as any,original=internal.paintWithCooperativeGradient.bind(gpu),upload=gpu.driver.uploadLinear!.bind(gpu.driver)
   let current=true,calls=0,fullUploads=0
   gpu.driver.uploadLinear=(values,w,h)=>{if(w*h>262144)fullUploads++;return upload(values,w,h)}
   internal.paintWithCooperativeGradient=(n:unknown,p:unknown,m:unknown)=>{
    calls++
    // Inject the cancellation at the first actual task yield, with an expired
    // existing encoding deadline. This is not an input-to-photon timing test.
    internal.encodeYield.deadline=-Infinity
    const checkpoint=internal.encodeYield.checkpoint.bind(internal.encodeYield)
    internal.encodeYield.checkpoint=(enabled:boolean)=>{const pause=checkpoint(enabled);return pause?.then(()=>{current=false})}
    return chunked?original(n,p,m):internal.paint(n,p,m,undefined,true)
   }
   let cancelled=false
   try{await gpu.render(scene,true,false,()=>current)}catch(error){if(!String(error).includes('PREVIEW_CANCELLED'))throw error;cancelled=true}
   finally{gpu.dispose()}
   report.cases.push({name:'cancel-at-first-yield',chunked,calls,fullUploads,cancelled});await publish()
   if(!calls||!cancelled||chunked&&fullUploads!==0||!chunked&&fullUploads===0)throw Error('Cancellation negative control did not distinguish chunked work')
  }
 }finally{kernel.free()}
 report.status='passed';await publish()
}catch(error){report.status='failed';report.error=String(error);await publish()}
