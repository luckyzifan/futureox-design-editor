import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { NativePreparation } from '../../src/preparation.mjs'
import { decodeFrameValue } from '../../../design-client/src/kernel/gpu/frame-wire.ts'
const bindings=process.env.DESIGN_WASM_BINDINGS
  ?pathToFileURL(process.env.DESIGN_WASM_BINDINGS+'/design_kernel.js')
  :new URL('../../../design-client/src/generated/design-kernel/design_kernel.js',import.meta.url)
const {default:initialize,VectorEngine}=await import(bindings)
const core=new URL('../../../../',import.meta.url)
const executable=process.platform==='win32'?'design-prepare.exe':'design-prepare'
const binary=process.env.DESIGN_PREPARE_BINARY||fileURLToPath(new URL(`design-studio/target/debug/${executable}`,core))
const fontPath=fileURLToPath(new URL('frontend/design-client/public/fonts/NotoSansSC.ttf',core))
const wasm=await readFile(process.env.DESIGN_WASM_BINDINGS
  ?process.env.DESIGN_WASM_BINDINGS+'/design_kernel_bg.wasm'
  :new URL('../../../design-client/public/kernel/design_kernel_bg.wasm',import.meta.url))
await initialize({module_or_path:await WebAssembly.compile(wasm)})

function comparableScene(bytes, lane) {
  assert.ok(bytes.byteLength>=24)
  assert.equal(Buffer.from(bytes.subarray(0,4)).toString('ascii'),'FGSC')
  const header=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength)
  assert.equal(header.getUint32(4,true),1)
  const metadataEnd=24+header.getUint32(8,true)
  const geometryStart=Math.ceil(metadataEnd/4)*4
  const resourceStart=geometryStart+4*(header.getUint32(12,true)+header.getUint32(16,true))
  assert.equal(resourceStart+header.getUint32(20,true),bytes.length)
  const {frameSequence,resourceScope,nodeResources,scenePlan,...metadata}=decodeFrameValue(bytes.subarray(24,metadataEnd))
  assert.ok(Number.isSafeInteger(frameSequence)&&frameSequence>0)
  // The native adapter binds packet resources to its live session and lane.
  // The direct WASM reference has no transport owner.
  if(lane){
    const owner=JSON.parse(resourceScope)
    assert.equal(owner.protocol,1)
    assert.equal(owner.lane,lane)
  }else assert.equal(resourceScope,'')
  assert.deepEqual(metadata.roots,['r'])
  const resources=new Map()
  for(let cursor=resourceStart;cursor<bytes.length;){
    assert.ok(bytes.length-cursor>=9)
    const id=header.getUint32(cursor,true),kind=bytes[cursor+4],size=header.getUint32(cursor+5,true)
    cursor+=9
    assert.ok(size<=bytes.length-cursor&&!resources.has(id))
    resources.set(id,{kind,value:decodeFrameValue(bytes.subarray(cursor,cursor+size))})
    cursor+=size
  }
  const plan=resources.get(scenePlan)
  assert.equal(plan?.kind,3)
  assert.equal(resources.size,nodeResources.length+1)
  const nodes=nodeResources.map(([id,resourceId])=>{
    const entry=resources.get(resourceId)
    assert.equal(entry?.kind,2)
    const {node}=entry.value
    assert.equal(node.id,id)
    // Coverage hints hash a platform-sized Rust usize. All geometry bytes
    // and other scene fields must match between native64 and wasm32.
    for(const path of [node.fill,...node.strokes.map(stroke=>stroke.path)])
      if(path.area)delete path.area.fingerprint
    return node
  })
  return {metadata,nodes,plan:plan.value,geometry:bytes.slice(geometryStart,resourceStart)}
}

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
  const [packet,pixels,linear]=await Promise.all([call('compile_gpu_packet',[options]),call('render_cpu_frame',[options]),call('render_linear',[options])])
  const baseline=comparableScene(packet.value,'canvas')
  assert.deepEqual(baseline,comparableScene(reference.compile_gpu_packet(options)))
  assert.deepEqual(pixels.value,reference.render_rgba(options))
  assert.match(linear.error,/requires document color management/)
  for(const value of [packet.value,pixels.value]){
   assert.equal(value.byteOffset,0)
   assert.equal(value.buffer.byteLength,value.byteLength)
  }
  assert.equal((await call('load_document',[JSON.stringify(document)],'interaction')).documentFork,true)
  const moved=JSON.stringify({r:[1,0,0,1,17.375,11]})
  assert.equal((await call('apply_interaction_transforms',[moved],'interaction')).value,true)
  reference.apply_interaction_transforms(moved)
  const translated=comparableScene((await call('compile_gpu_packet',[options],'interaction')).value,'interaction')
  assert.notDeepEqual(translated,baseline)
  assert.deepEqual(translated,comparableScene(reference.compile_gpu_packet(options)))
  assert.deepEqual((await call('compile_gpu_packet',[options])).value,packet.value)
  assert.match((await call('apply_interaction_transforms',[moved])).error,/Invalid interaction/)
  const invalid=await call('load_document',['{}']);assert.ok(invalid.error)
  await call('load_document',[JSON.stringify(document)])
  assert.deepEqual(comparableScene((await call('compile_gpu_packet',[options])).value,'canvas'),baseline)
  const managed=JSON.stringify({...document,schemaVersion:3,colorManagement:{documentSpace:'srgb',referenceWhiteNits:203,peakLuminanceNits:1000}})
  await call('load_document',[managed]);reference.load_document(managed)
  const floatOptions=JSON.stringify({...JSON.parse(options),width:128,height:128})
  const floats=await call('render_linear',[floatOptions])
  assert.equal(floats.error,undefined)
  assert.ok(floats.value instanceof Float32Array)
  assert.deepEqual(floats.value,reference.render_linear(floatOptions))
  assert.equal(floats.value.byteOffset,0)
  assert.equal(floats.value.buffer.byteLength,128*128*4*4)
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
