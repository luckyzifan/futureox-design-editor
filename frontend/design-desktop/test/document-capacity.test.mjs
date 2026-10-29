import test from 'node:test'
import assert from 'node:assert/strict'
import { selectDocumentMemoryBytes, DOCUMENT_BYTE_LIMIT, macosAvailableMemoryBytes } from '../src/document-capacity.mjs'
import { documentFromString } from '../src/security.mjs'
import { documentFrames, documentWrites, DocumentFrameAssembler, DOCUMENT_CHUNK_BYTES } from '../src/document-transport.mjs'
const MIB=1024*1024
test('macOS counts reclaimable inactive memory without double-counting other queues',()=>{
 const sample='Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100.\nPages inactive: 200.\nPages speculative: 75.\nPages occupied by compressor: 999999.\n'
 assert.equal(macosAvailableMemoryBytes(sample),300*16384)
 assert.equal(macosAvailableMemoryBytes(sample.replace('16384','4096')),300*4096)
 assert.equal(macosAvailableMemoryBytes(sample.replace('200.','18446744073709551615.')),undefined)
 assert.equal(macosAvailableMemoryBytes(sample.replace('Pages inactive:','absent:')),undefined)
 assert.equal(macosAvailableMemoryBytes(sample.replace('16384','5000')),undefined)
 assert.equal(macosAvailableMemoryBytes('unavailable'),undefined)
})
test('ordinary stream writes borrow the whole payload instead of copying it to add a newline',()=>{
 for(const length of [0,1,4096,MIB]){
  const bytes=Buffer.alloc(length,42)
  const writes=documentWrites(bytes,'ordinary',MIB)
  assert.equal(writes.next().value,bytes)
  assert.deepEqual(writes.next().value,Buffer.from('\n'))
  assert.equal(writes.next().done,true)
 }
})
test('stream writes keep multipart wire bytes and sequence unchanged beyond the frame boundary',()=>{
 const bytes=Buffer.alloc(MIB+19,42)
 assert.deepEqual([...documentWrites(bytes,'chunked',MIB)],[...documentFrames(bytes,'chunked',MIB)])
})
test('startup capacity reflects available memory and cgroup constraints, not a document business quota',()=>{
 assert.equal(selectDocumentMemoryBytes({total:16*1024*MIB,available:3*1024*MIB}),1536*MIB)
 assert.equal(selectDocumentMemoryBytes({total:16*1024*MIB,available:3*1024*MIB,constrained:1024*MIB}),512*MIB)
 assert.equal(selectDocumentMemoryBytes({}),512*MIB)
 assert.throws(()=>selectDocumentMemoryBytes({total:1024*MIB,available:512*MIB,configured:String(512*MIB)}))
 assert.throws(()=>selectDocumentMemoryBytes({configured:'Infinity'}))
})
test('the desktop parser accepts a valid document above the former 32 MiB product cap',()=>{
 assert.ok(DOCUMENT_BYTE_LIMIT>33*MIB,'test requires at least 528 MiB admitted working memory')
 const text=JSON.stringify({payload:'x'.repeat(33*MIB)})
 assert.equal(documentFromString(text).payload.length,33*MIB)
})
test('multipart wire chunks roundtrip beyond an independent frame boundary, including split UTF-8',()=>{
 const bytes=Buffer.from('雪\\"'.repeat(300000))
 const frames=[...documentFrames(bytes,'document-one',MIB)]
 assert.ok(frames.length>1)
 const assembler=new DocumentFrameAssembler(bytes.length)
 let result
 for(const frame of frames){assert.ok(frame.length<2*MIB);result=assembler.accept(frame)}
 assert.deepEqual(result,bytes)
 assert.equal(assembler.active,undefined)
})
test('oversized totals, reordered/replayed chunks, interruption and noncanonical encodings fail before publication',()=>{
 const bytes=Buffer.alloc(DOCUMENT_CHUNK_BYTES+19,42)
 const frames=[...documentFrames(bytes,'one',MIB)]
 const assembler=new DocumentFrameAssembler(bytes.length)
 assert.throws(()=>new DocumentFrameAssembler(bytes.length-1).accept(frames[0]))
 assert.equal(assembler.accept(frames[0]),undefined)
 assert.throws(()=>assembler.accept(frames[0]))
 assert.throws(()=>assembler.accept(Buffer.from('{"id":"interrupted"}')))
 assembler.clear();assert.equal(assembler.active,undefined)
 assert.throws(()=>assembler.accept(frames[1]))
 const malformed=JSON.parse(frames[0]);malformed.desktopChunk.data='AAAA!'
 assert.throws(()=>new DocumentFrameAssembler(bytes.length).accept(Buffer.from(JSON.stringify(malformed))))
})

test('plain JSON preflight counts escaping/UTF-8 exactly and rejects oversize before serialization',async()=>{
 const {assertDocumentSerialization}=await import('../src/document-capacity.mjs')
 const shared={unicode:'雪𐐀\ud800\udc00\ud800\udfff\n\t\u0001\\"',number:-0}
 for(const value of [{a:shared,b:shared,omit:undefined},[null,undefined,false,NaN,1e30],{}]){
  const expected=Buffer.byteLength(JSON.stringify(value))
  assert.equal(assertDocumentSerialization(value,expected),expected)
  assert.throws(()=>assertDocumentSerialization(value,expected-1))
 }
 const cyclic={};cyclic.self=cyclic;assert.throws(()=>assertDocumentSerialization(cyclic))
})
