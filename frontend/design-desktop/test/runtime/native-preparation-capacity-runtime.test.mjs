// Real host worker -> owned Rust preparation process. No renderer, WASM, binary,
// NDJSON framing or child-lifecycle mock is used by these tests.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { NativePreparation } from '../../src/preparation.mjs'
import { DOCUMENT_BYTE_LIMIT, DOCUMENT_MEMORY_BYTES, documentChildEnvironment } from '../../src/document-capacity.mjs'
const binary=process.env.DESIGN_PREPARE_BINARY
assert.ok(binary,'DESIGN_PREPARE_BINARY must name the freshly built candidate')
const font=fileURLToPath(new URL('../../../design-client/public/fonts/NotoSansSC.ttf',import.meta.url))

test('actual native preparation admits a69MiB document through bounded chunks and releases its host lease',async t=>{
 const size=69*1024*1024
 assert.ok(DOCUMENT_BYTE_LIMIT>size+4096,'test requires sufficient actual startup working-memory admission')
 const document=JSON.stringify({schemaVersion:6,id:'native-large',name:'Large transport',pages:[{id:'p',name:'Page',background:'#ffffff',children:['r']}],nodes:{r:{id:'r',kind:'rectangle',width:20,height:10,transform:[1,0,0,1,0,0],fills:[{kind:'solid',color:'#2277bb'}]}},extensionData:{payload:'x'.repeat(size)}})
 assert.ok(Buffer.byteLength(document)>68*1024*1024)
 t.diagnostic(JSON.stringify({memoryBytes:DOCUMENT_MEMORY_BYTES,maxDocumentBytes:DOCUMENT_BYTE_LIMIT,documentBytes:Buffer.byteLength(document),frameLimitBytes:68*1024*1024,policy:'actual startup memory'}))
 const host=new NativePreparation(binary,font)
 try{
  const reply=await host.request({lane:'canvas',method:'load_document',args:[document]})
  assert.equal(reply.error,undefined)
  assert.ok(reply.stateReceipt)
  assert.equal(host.pending.size,0);assert.equal(host.reservations.size,0)
  const packet=await host.request({lane:'canvas',method:'compile_gpu_packet',args:[JSON.stringify({pageId:'p',width:32,height:32,view:{x:0,y:0,zoom:1},grid:false})]})
  assert.equal(packet.error,undefined);assert.ok(packet.value instanceof Uint8Array)
  const metadataLength=new DataView(packet.value.buffer,packet.value.byteOffset).getUint32(8,true)
  const metadata=JSON.parse(Buffer.from(packet.value.subarray(24,24+metadataLength)).toString('utf8'))
  assert.ok(Object.hasOwn(metadata.nodes,'r'))
  const stats=await host.request({lane:'canvas',method:'stats',args:[]})
  assert.equal(stats.error,undefined);assert.equal(typeof stats.value,'string')
  const small=JSON.stringify({schemaVersion:6,id:'small',name:'Reusable',pages:[{id:'p',name:'Page',background:'#ffffff',children:[]}],nodes:{}})
  assert.equal((await host.request({lane:'canvas',method:'load_document',args:[small]})).error,undefined)
 }finally{await host.close()}
 assert.equal(host.pending.size,0);assert.equal(host.reservations.size,0)
})

test('actual preparation rejects incomplete, replayed and interleaved transfers without a reply',async()=>{
 const payload=Buffer.from(JSON.stringify({id:1,lane:'canvas',method:'stats',args:[]})),split=17
 const chunk=(id,offset,bytes)=>Buffer.from(JSON.stringify({desktopChunk:{version:1,id,total:payload.length,offset,data:bytes.toString('base64')}})+'\n')
 const first=chunk('one',0,payload.subarray(0,split))
 for(const tail of [Buffer.alloc(0),first,chunk('two',split,payload.subarray(split))]){
  const child=spawn(binary,['--font',font],{stdio:['pipe','pipe','pipe'],env:documentChildEnvironment(process.env)})
  let output=0,diagnostic=''
  child.stdout.on('data',part=>{output+=part.length})
  child.stderr.on('data',part=>{diagnostic+=part.toString()})
  const timer=setTimeout(()=>child.kill('SIGKILL'),10000)
  try{
   const ended=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code))})
   child.stdin.end(Buffer.concat([first,tail]))
   assert.notEqual(await ended,0);assert.equal(output,0)
   assert.match(diagnostic,/Incomplete preparation transfer|Invalid desktop document transfer/)
  }finally{clearTimeout(timer);if(child.exitCode===null)child.kill('SIGKILL')}
 }
})
