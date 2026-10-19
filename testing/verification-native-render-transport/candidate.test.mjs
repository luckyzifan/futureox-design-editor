import test from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { NativeRenderFrame, encodeCandidate, MAX_METADATA_BYTES, MAX_RGBA_BYTES } from './candidate-frame.mjs'
const identity={session:'session-owned',id:1,kind:'frame'}
const raw=Uint8Array.from({length:96},(_,i)=>(i*71)%256)
const metadata={...identity,type:'frame',width:6,height:4,encoding:'rgba8',stats:{label:'中文',frames:1}}
const wire=()=>Buffer.concat(encodeCandidate(metadata,raw))
function parse(bytes=wire(), id=identity){const frame=new NativeRenderFrame();frame.append(bytes);return frame.decode(id)}
test('exact pixels, dimensions, stats and tight owned allocation across every split',()=>{
 const bytes=wire()
 for(let split=0;split<=bytes.length;split++){
  const frame=new NativeRenderFrame(); frame.append(bytes.subarray(0,split));frame.append(bytes.subarray(split))
  const result=frame.decode(identity);assert.deepEqual(result.rgba,raw);assert.deepEqual(result.stats,metadata.stats)
  assert.equal(result.rgba.byteOffset,0);assert.equal(result.rgba.buffer.byteLength,raw.length)
  assert.notEqual(result.rgba.buffer,bytes.buffer)
 }
 const frame=new NativeRenderFrame();for(const byte of bytes)frame.append(Buffer.from([byte]));assert.deepEqual(frame.decode(identity).rgba,raw)
})
test('metadata sequence, type, dimensions and encoding reject corruption before pixels',()=>{
 for(const patch of [{session:'other'},{id:2},{type:'stats'},{encoding:'future'},{width:7},{height:0},{width:.5},{rgba:'bogus'}]){
  const changed={...metadata,...patch};if(patch.rgba)continue
  assert.throws(()=>parse(Buffer.concat(encodeCandidate(changed,raw))))
 }
 assert.throws(()=>parse(wire(),{...identity,id:2}))
})
test('unknown magic, excessive lengths, incomplete/trailing bytes and malformed metadata reject',()=>{
 const bytes=wire(),wrong=Buffer.from(bytes);wrong.write('FRB2');assert.throws(()=>parse(wrong),/protocol/)
 for(const [offset,value] of [[4,MAX_METADATA_BYTES+1],[8,MAX_RGBA_BYTES+1],[4,0]]){const bad=Buffer.from(bytes);bad.writeUInt32LE(value,offset);assert.throws(()=>parse(bad),/limit/)}
 for(let len=0;len<bytes.length;len++)assert.throws(()=>parse(bytes.subarray(0,len)),/Incomplete/)
 assert.throws(()=>parse(Buffer.concat([bytes,Buffer.from([0])])),/Unexpected/)
 const bad=Buffer.from(bytes);bad[12]=33;assert.throws(()=>parse(bad))
})
test('control replies preserve scoped errors and prohibit binary payload',()=>{
 for(const type of ['loaded','stats','error']){
  const meta={session:identity.session,id:identity.id,type,stats:{ok:true},message:'bad options'}
  const expected={...identity,kind:type==='error'?'frame':type}
  assert.deepEqual(parse(Buffer.concat(encodeCandidate(meta)),expected),meta)
  assert.throws(()=>parse(Buffer.concat(encodeCandidate(meta,raw)),expected),/payload/)
 }
})
test('real Worker transfers exact buffer with sender detach and independent repeat decode',async()=>{
 const worker=new Worker(`import {parentPort,workerData} from 'node:worker_threads';import {NativeRenderFrame} from ${JSON.stringify(new URL('./candidate-frame.mjs',import.meta.url).href)};const frame=new NativeRenderFrame();frame.append(Buffer.from(workerData.wire));const reply=frame.decode(workerData.identity);parentPort.postMessage({reply},[reply.rgba.buffer]);parentPort.postMessage({detached:reply.rgba.byteLength===0,repeat:frame.decode(workerData.identity).rgba});`,{eval:true,workerData:{wire:wire(),identity}})
 const messages=[];await new Promise((resolve,reject)=>{worker.on('message',msg=>messages.push(msg));worker.on('error',reject);worker.on('exit',code=>code?reject(Error(String(code))):resolve())})
 assert.equal(messages[1].detached,true);assert.deepEqual(messages[0].reply.rgba,raw);assert.deepEqual(messages[1].repeat,raw)
 assert.equal(messages[0].reply.rgba.buffer.byteLength,raw.length)
})
