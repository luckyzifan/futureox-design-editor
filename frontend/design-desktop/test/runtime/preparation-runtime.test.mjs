import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { NativePreparation } from '../../src/preparation.mjs'
const bindings=process.env.DESIGN_WASM_BINDINGS
  ?pathToFileURL(process.env.DESIGN_WASM_BINDINGS+'/design_kernel.js')
  :new URL('../../../design-client/src/generated/design-kernel/design_kernel.js',import.meta.url)
const {default:initialize,VectorEngine}=await import(bindings)
const core=new URL('../../../../',import.meta.url)
const binary=process.env.DESIGN_PREPARE_BINARY||fileURLToPath(new URL('design-studio/target/debug/design-prepare',core))
const fontPath=fileURLToPath(new URL('frontend/design-client/public/fonts/NotoSansSC.ttf',core))
const wasm=await readFile(process.env.DESIGN_WASM_BINDINGS
  ?process.env.DESIGN_WASM_BINDINGS+'/design_kernel_bg.wasm'
  :new URL('../../../design-client/public/kernel/design_kernel_bg.wasm',import.meta.url))
await initialize({module_or_path:await WebAssembly.compile(wasm)})
test('native host binary matches WASM packets, edits and pixels; queues and retires owned work',async()=>{
 const host=new NativePreparation(binary,fontPath),reference=new VectorEngine()
 const call=(method,args=[],lane='canvas')=>host.request({lane,method,args})
 const options=JSON.stringify({pageId:'p',width:64,height:64,view:{x:.375,y:-.125,zoom:1},grid:false})
 const document={schemaVersion:1,id:'native-preparation',name:'Isolated',pages:[{id:'p',name:'Page',children:['r'],background:'#ffffff'}],nodes:{r:{id:'r',kind:'rectangle',width:30,height:25,transform:[1,0,0,1,10,11],fills:[{kind:'solid',color:'#3b7adc'}]}}}
 try{
  assert.equal((await call('serialize',[document])).value,JSON.stringify(document))
  reference.load_font(await readFile(fontPath));reference.load_document(JSON.stringify(document))
  await call('initialize',[false]);await call('initialize',[false],'interaction')
  assert.equal((await call('load_document',[JSON.stringify(document)])).settings,'null')
  const [packet,pixels]=await Promise.all([call('compile_gpu_packet',[options]),call('render_cpu_frame',[options])])
  // Area fingerprints are acceleration hints from Rust's platform-sized
  // Hash(usize); WASM32 and native64 differ. Compare every other metadata
  // field and the exact binary geometry, then compare rendered pixels.
  const comparable=bytes=>{
   const length=new DataView(bytes.buffer,bytes.byteOffset).getUint32(8,true)
   const metadata=JSON.parse(new TextDecoder().decode(bytes.subarray(24,24+length)))
   for(const node of Object.values(metadata.nodes))for(const path of [node.fill,...node.strokes.map(s=>s.path)])
    if(path.area)delete path.area.fingerprint
   return {metadata,geometry:bytes.slice((24+length+3)&~3)}
  }
  assert.deepEqual(comparable(packet.value),comparable(reference.compile_gpu_packet(options)))
  assert.deepEqual(pixels.value,reference.render_rgba(options))
  assert.equal((await call('load_document',[JSON.stringify(document)],'interaction')).documentFork,true)
  const moved=JSON.stringify({r:[1,0,0,1,17.375,11]})
  assert.equal((await call('apply_interaction_transforms',[moved],'interaction')).value,true)
  reference.apply_interaction_transforms(moved)
  assert.deepEqual(comparable((await call('compile_gpu_packet',[options],'interaction')).value),comparable(reference.compile_gpu_packet(options)))
  assert.deepEqual((await call('compile_gpu_packet',[options])).value,packet.value)
  assert.match((await call('apply_interaction_transforms',[moved])).error,/Invalid interaction/)
  const invalid=await call('load_document',['{}']);assert.ok(invalid.error)
  await call('load_document',[JSON.stringify(document)])
  assert.deepEqual((await call('compile_gpu_packet',[options])).value,packet.value)
  await assert.rejects(call('not-a-method'),/Invalid native preparation/)
 }finally{reference.free();await host.close()}
 await assert.rejects(call('stats'),/closed/)
})
test('closing a native session rejects queued work and waits for its child to exit',async()=>{
 const host=new NativePreparation(binary,fontPath)
 const pending=host.request({lane:'canvas',method:'warm_resources',args:[]})
 const rejected=assert.rejects(pending,/closed/)
 await host.close();await rejected
 assert.equal(host.pending.size,0)
})
test('missing native executable fails promptly and retires the host worker',async()=>{
 const host=new NativePreparation(binary+'-missing',fontPath)
 try{await assert.rejects(host.request({lane:'canvas',method:'warm_resources',args:[]}),/ENOENT/)}
 finally{await host.close()}
})
