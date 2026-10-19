import test from 'node:test'
import assert from 'node:assert/strict'
import { NativePreparationFrame } from '../src/preparation-frame.mjs'

function header(metadata,binary){
 const bytes=Buffer.alloc(12)
 bytes.write('FPR1');bytes.writeUInt32LE(metadata,4);bytes.writeUInt32LE(binary,8)
 return bytes
}
function encode(reply,payload=Buffer.alloc(0)){
 const metadata=Buffer.from(JSON.stringify(reply))
 return Buffer.concat([header(metadata.length,payload.length),metadata,payload])
}
function decode(parts,id=7){
 const frame=new NativePreparationFrame()
 for(let index=0;index<parts.length;index++)assert.equal(frame.append(parts[index]),index===parts.length-1)
 return frame.decode(id)
}

test('FPR1 metadata and payload survive every split boundary, including UTF-8 and header fields',()=>{
 const expected={id:7,encoding:'u8',label:'中文 😀',value:null}
 const payload=Buffer.from([0,1,127,128,254,255]),wire=encode(expected,payload)
 for(let split=1;split<wire.length;split++){
  const {reply,transfers}=decode([wire.subarray(0,split),wire.subarray(split)])
  assert.deepEqual(reply,{id:7,label:expected.label,value:new Uint8Array(payload)})
  assert.deepEqual(transfers,[reply.value.buffer])
 }
 const {reply}=decode([...wire].map(byte=>Buffer.from([byte])))
 assert.deepEqual(reply.value,new Uint8Array(payload))
})

test('FPR1 float payload uses aligned owned storage even when wire bytes have an odd offset',()=>{
 const payload=Buffer.alloc(20),values=[0,-0,1.25,-512.5,Number.POSITIVE_INFINITY]
 values.forEach((value,index)=>payload.writeFloatLE(value,index*4))
 const wire=encode({id:7,encoding:'f32'},payload)
 assert.notEqual((wire.length-payload.length)%4,0)
 const {reply,transfers}=decode([wire.subarray(0,3),wire.subarray(3,13),wire.subarray(13,wire.length-7),wire.subarray(wire.length-7)])
 assert.ok(reply.value instanceof Float32Array)
 assert.equal(reply.value.byteOffset,0)
 assert.deepEqual([...reply.value],values)
 assert.equal(transfers[0].byteLength,payload.length)
})

test('FPR1 large fragmented payload never joins the full frame',t=>{
 const payload=Buffer.alloc(1024*1024+17)
 for(let index=0;index<payload.length;index++)payload[index]=(index*31)&255
 const wire=encode({id:7,encoding:'u8',label:'fragmented'},payload)
 const metadataLength=wire.readUInt32LE(4),parts=[wire.subarray(0,1)]
 for(let start=1;start<wire.length;start+=16381)parts.push(wire.subarray(start,start+16381))
 const allocated=[],allocate=Buffer.allocUnsafe
 t.mock.method(Buffer,'concat',()=>{throw Error('Full frame concatenation is forbidden')})
 t.mock.method(Buffer,'allocUnsafe',size=>{allocated.push(size);return allocate(size)})
 const {reply}=decode(parts)
 assert.deepEqual(reply.value,new Uint8Array(payload))
 assert.ok(allocated.every(size=>size<=Math.max(12,metadataLength)))
})

test('FPR1 transfer owns exactly the payload and does not detach or expose a pooled source slab',()=>{
 const wire=encode({id:7,encoding:'u8'},Buffer.from([3,5,7,11]))
 const slab=Buffer.allocUnsafe(1024).fill(0xa5),source=slab.subarray(91,91+wire.length)
 source.set(wire)
 const original=Buffer.from(slab),{reply,transfers}=decode([source])
 assert.notEqual(reply.value.buffer,source.buffer)
 assert.equal(reply.value.byteOffset,0)
 assert.equal(reply.value.buffer.byteLength,4)
 const transferred=structuredClone(reply,{transfer:transfers})
 assert.equal(reply.value.buffer.byteLength,0)
 assert.deepEqual(transferred.value,new Uint8Array([3,5,7,11]))
 assert.deepEqual(slab,original)
 source.fill(0)
 assert.deepEqual(transferred.value,new Uint8Array([3,5,7,11]))
})

test('FPR1 copied payloads stay independent across replies and source mutations',()=>{
 const first=encode({id:7,encoding:'u8'},Buffer.from([1,2,3]))
 const second=encode({id:8,encoding:'u8'},Buffer.from([4,5,6]))
 const a=decode([first]).reply,b=decode([second],8).reply
 first.fill(0);second.fill(0);a.value[0]=99
 assert.deepEqual(a.value,new Uint8Array([99,2,3]))
 assert.deepEqual(b.value,new Uint8Array([4,5,6]))
})

test('FPR1 metadata-only errors and empty binary values retain their wire types',()=>{
 const metadata=decode([encode({id:7,error:'invalid document'})])
 assert.deepEqual(metadata,{reply:{id:7,error:'invalid document'},transfers:[]})
 for(const encoding of ['u8','f32']){
  const {reply,transfers}=decode([encode({id:7,encoding})])
  assert.ok(reply.value instanceof (encoding==='u8'?Uint8Array:Float32Array))
  assert.equal(reply.value.length,0)
  assert.deepEqual(transfers,[reply.value.buffer])
 }
})

test('FPR1 waits for incomplete headers, metadata and binary without decoding them',()=>{
 const wire=encode({id:7,encoding:'u8'},Buffer.from([1,2,3,4])),frame=new NativePreparationFrame()
 assert.equal(frame.append(wire.subarray(0,11)),false)
 assert.throws(()=>frame.decode(7),/Unexpected native preparation frame/)
 assert.equal(frame.append(wire.subarray(11,wire.length-1)),false)
 assert.throws(()=>frame.decode(7),/Unexpected native preparation frame/)
 assert.equal(frame.append(wire.subarray(wire.length-1)),true)
 assert.deepEqual(frame.decode(7).reply.value,new Uint8Array([1,2,3,4]))
})

test('FPR1 rejects invalid and fragmented magic before any payload assembly',()=>{
 const bytes=header(2,0);bytes.write('BAD!')
 assert.throws(()=>decode([bytes]),/Invalid native preparation protocol/)
 const frame=new NativePreparationFrame()
 assert.equal(frame.append(bytes.subarray(0,7)),false)
 assert.throws(()=>frame.append(bytes.subarray(7)),/Invalid native preparation protocol/)
})

test('FPR1 rejects announced metadata/binary budgets using only the header',()=>{
 for(const bytes of [header(2*1024*1024+1,0),header(0,128*1024*1024+1)]){
  const frame=new NativePreparationFrame()
  assert.throws(()=>frame.append(bytes),/Native preparation payload exceeds limit/)
 }
})

test('FPR1 retains the total received-byte budget',()=>{
 const frame=new NativePreparationFrame()
 // allocUnsafe does not initialize a 130 MiB test fixture; the size is rejected
 // before the parser reads or retains any bytes from it.
 assert.throws(()=>frame.append(Buffer.allocUnsafe(130*1024*1024+1)),/Native preparation frame exceeds limit/)
 assert.equal(frame.parts.length,0)
})

test('FPR1 rejects surplus bytes and concatenated replies instead of accepting out-of-order work',()=>{
 const wire=encode({id:7,value:true})
 for(const tail of [Buffer.from([0]),wire]){
  assert.throws(()=>decode([Buffer.concat([wire,tail])]),/Unexpected native preparation frame/)
 }
 const frame=new NativePreparationFrame()
 assert.equal(frame.append(wire),true)
 assert.throws(()=>frame.append(Buffer.from([0])),/Unexpected native preparation frame/)
})

test('FPR1 rejects malformed JSON, sequence mismatches, unknown encodings and misaligned floats',()=>{
 const invalidMetadata=Buffer.from('{not-json')
 assert.throws(()=>decode([Buffer.concat([header(invalidMetadata.length,0),invalidMetadata])]),SyntaxError)
 assert.throws(()=>decode([encode({id:8,encoding:'u8'},Buffer.from([1]))]),/Native preparation sequence mismatch/)
 assert.throws(()=>decode([encode({id:7,encoding:'other'},Buffer.from([1]))]),/Unknown native preparation encoding/)
 assert.throws(()=>decode([encode({id:7,encoding:'f32'},Buffer.from([1,2,3]))]),/Misaligned native float payload/)
})
