// Isolated paired WASM CPU measurements; no canvas/GPU FPS claim.
// node benchmark-kernel-hotpaths.mjs output.json before-bindings after-bindings
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import os from 'node:os'
import { DOCUMENT_MEMORY_BYTES } from '../../frontend/design-desktop/src/document-capacity.mjs'
const [output,...folders]=process.argv.slice(2)
assert(output&&folders.length)
const sha=x=>createHash('sha256').update(x).digest('hex')
const stats=values=>{const s=[...values].sort((a,b)=>a-b);return {p50Ms:s[Math.floor(s.length/2)],p95Ms:s[Math.floor(s.length*.95)],samples:values}}
const setting=(name,fallback,max)=>{const value=Number(process.env[name]??fallback);assert(Number.isSafeInteger(value)&&value>0&&value<=max);return value}
const samples=setting('CORE_BENCHMARK_SAMPLES',31,31),rounds=setting('CORE_BENCHMARK_ROUNDS',4,4)
const counts=(process.env.CORE_BENCHMARK_COUNTS??'1000,10000').split(',').map(Number)
assert(counts.length&&counts.every(n=>Number.isSafeInteger(n)&&n>0&&n<=20000))
const measure=(fn,batch=1)=>{for(let i=0;i<5;i++)fn();const times=[];for(let i=0;i<samples;i++){const start=performance.now();for(let j=0;j<batch;j++)fn();times.push((performance.now()-start)/batch)}return {...stats(times),batch}}
const font=await readFile(new URL('../../frontend/design-client/public/fonts/NotoSansSC.ttf',import.meta.url))
const variants=[]
for(const folder of folders){
 const wasm=await readFile(resolve(folder,'design_kernel_bg.wasm'))
 const binding=await import(pathToFileURL(resolve(folder,'design_kernel.js')))
 await binding.default({module_or_path:await WebAssembly.compile(wasm)})
 binding.configure_document_capacity(DOCUMENT_MEMORY_BYTES)
 variants.push({folder,wasmSha256:sha(wasm),wasmBytes:wasm.length,binding,rounds:[]})
}
const expected=new Map()
for(let round=0;round<rounds;round++)for(const variant of round%2?[...variants].reverse():variants){
 for(const count of counts){
  const nodes={},children=[]
  for(let i=0;i<count;i++){const id=`node-${String(i).padStart(5,'0')}`;children.push(id);nodes[id]={id,kind:'rectangle',width:5,height:5,transform:[1,0,0,1,(i%100)*8,Math.floor(i/100)*8],fills:[{kind:'solid',color:'#527acc'}],strokes:[{width:.5,paint:{kind:'solid',color:'#203040'}}]}}
  const input=JSON.stringify({schemaVersion:1,id:'benchmark',name:'Hot paths',pages:[{id:'p',name:'Page',children,background:'#ffffff'}],nodes})
  const options=JSON.stringify({pageId:'p',width:96,height:96,view:{x:0,y:0,zoom:1},grid:false})
  const engine=new variant.binding.VectorEngine();engine.load_font(font)
  try{
   engine.bind_frame_scene_scope(`benchmark/${round}/${count}`)
   engine.load_document(input);engine.compile_gpu_packet(options)
   const fork=measure(()=>{const copy=engine.fork_static_render_engine();assert(copy);copy.free()},4)
   const forkEditCompile=measure(()=>{
    const copy=engine.fork_static_render_engine();assert(copy)
    try{
     assert.equal(copy.apply_interaction_transforms(JSON.stringify({'node-00000':[1,0,0,1,1,0]})),true)
     copy.compile_gpu_packet(options)
    }finally{copy.free()}
   })
   const before=JSON.parse(engine.gpu_compile_cache_stats())
   const repeatedStatic=measure(()=>engine.compile_gpu_packet(options),2)
   const afterStatic=JSON.parse(engine.gpu_compile_cache_stats())
   let pose=0
   const singleNodePose=measure(()=>{
    assert.equal(engine.apply_interaction_transforms(JSON.stringify({'node-00000':[1,0,0,1,++pose%2?.125:0,0]})),true)
    engine.compile_gpu_packet(options)
   })
   const afterPose=JSON.parse(engine.gpu_compile_cache_stats())
   assert.equal(engine.apply_interaction_transforms(JSON.stringify({'node-00000':[1,0,0,1,0,0]})),true)
   const packet=engine.compile_gpu_packet(options)
   // Producer scopes/IDs are protocol ownership. Compare the complete scene
   // and pixels across variants; retain each wire hash separately as evidence.
   const hashes={scene:sha(engine.compile_gpu(options)),pixels:sha(engine.render_rgba(options))}
   const oracle=expected.get(count);if(oracle)assert.deepEqual(hashes,oracle);else expected.set(count,hashes)
   variant.rounds.push({round,count,fixtureSha256:sha(input),fork,forkEditCompile,repeatedStatic,singleNodePose,
    counters:{before,afterStatic,afterPose},packetSha256:sha(packet),packetBytes:packet.length,hashes})
  }finally{engine.free()}
 }
}
await writeFile(output,JSON.stringify({kind:'wasm-cpu-hotpaths',configuration:{counts,rounds,samples,warmup:5,memoryBytes:DOCUMENT_MEMORY_BYTES},environment:{node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model},fontSha256:sha(font),variants:variants.map(({binding,...v})=>v)},null,2)+'\n')
console.log(JSON.stringify({output,variants:variants.map(v=>({folder:v.folder,rounds:v.rounds.map(r=>({round:r.round,nodes:r.count,fork:r.fork.p50Ms,forkEditCompile:r.forkEditCompile.p50Ms,repeatedStatic:r.repeatedStatic.p50Ms,singleNodePose:r.singleNodePose.p50Ms}))}))},null,2))
