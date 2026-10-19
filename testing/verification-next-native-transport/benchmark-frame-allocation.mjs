import {performance} from 'node:perf_hooks'
import { NativePreparationFrame as Before } from './frame-baseline.mjs'
import { NativePreparationFrame as After } from './candidate-frame-allocation.mjs'
import assert from 'node:assert/strict'
const records=[]
for(const mib of [4,16,64,128]){
 const bytes=mib*1024*1024,metadata=Buffer.from(JSON.stringify({id:7,encoding:'u8'})),header=Buffer.alloc(12)
 header.write('FPR1');header.writeUInt32LE(metadata.length,4);header.writeUInt32LE(bytes,8)
 const parts=[header,metadata]
 for(let offset=0;offset<bytes;offset+=65536)parts.push(Buffer.alloc(Math.min(65536,bytes-offset),0x37))
 for(let i=0;i<36;i++){
  for(const kind of i%2?['after','before']:['before','after']){
   global.gc?.()
   const Frame=kind==='before'?Before:After,frame=new Frame()
   for(const part of parts)frame.append(part)
   const start=performance.now(),{reply,transfers}=frame.decode(7),decodeMs=performance.now()-start
   assert.equal(reply.value.byteLength,bytes)
   assert.equal(reply.value.buffer.byteLength,bytes)
   assert.equal(reply.value.byteOffset,0)
   for(let j=0;j<reply.value.length;j+=65536)assert.equal(reply.value[j],0x37)
   const moved=structuredClone(reply,{transfer:transfers})
   assert.equal(reply.value.buffer.byteLength,0)
   assert.equal(moved.value.at(-1),0x37)
   if(i>=5)records.push({mib,iteration:i-5,kind,decodeMs})
  }
 }
}
const summary=Object.fromEntries([4,16,64,128].map(mib=>[mib,Object.fromEntries(['before','after'].map(kind=>{const values=records.filter(r=>r.mib===mib&&r.kind===kind).map(r=>r.decodeMs).sort((a,b)=>a-b);return [kind,{medianMs:values[15],p95Ms:values[29]}]}))]))
console.log(JSON.stringify({candidateStatus:'NOT SHIPPED',note:'Alternating decoder-only benchmark, identical reused 64-KiB chunks, forced GC between samples, first five pairs warmup. Neither Electron IPC nor end-to-end rendering.',summary,records},null,2))
