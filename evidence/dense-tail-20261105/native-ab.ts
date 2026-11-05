// bun executes the real Rust process, through the desktop framing worker. Restore
// each captured ACK range in its new private owner; verify it was actually sent.
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import assert from 'node:assert/strict'
import {NativePreparation} from '../../frontend/design-desktop/src/preparation.mjs'
import {decodeFrameValue} from '../../frontend/design-client/src/kernel/gpu/frame-wire'
const [dir,exeA,exeB,out]=process.argv.slice(2)
const store=JSON.parse(await fs.readFile(path.join(dir,'snap/store.json'),'utf8'))
const requests=(await fs.readFile(path.join(dir,'cold-requests.ndjson'),'utf8')).trim().split('\n').map(v=>JSON.parse(v))
const rows=[],oracles=[],sha=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex')
for(const [run,arm] of [...'ABBAABBA'].entries()){
 const p=new NativePreparation(arm==='A'?exeA:exeB,path.resolve('frontend/design-client/public/fonts/NotoSansSC.ttf'))
 try{
  assert(!(await p.loadSourceSnapshot(store)).error)
  const samples=[],sent=new Set<number>();let scope='';const packets:Buffer[]=[]
  for(const [i,base] of requests.entries()){
   const o={...base,frameResources:{...base.frameResources,scope}},ranges=o.frameResources.ranges||[]
   for (const [lo,hi] of ranges) for(let j=lo;j<=hi;j++)assert(sent.has(j),'unearned ACK '+j)
   const start=performance.now(),reply=await p.request({lane:'canvas',method:'compile_gpu_packet',args:[JSON.stringify(o)]}),ms=performance.now()-start
   assert.ifError(reply.error);const b=Buffer.from(reply.value.buffer,reply.value.byteOffset,reply.value.byteLength),n=b.readUInt32LE(8),geometry=(24+n+3)&~3,body=geometry+4*(b.readUInt32LE(12)+b.readUInt32LE(16))
   const metadata=decodeFrameValue(b.subarray(24,24+n)) as any
   if(i)assert.equal(metadata.resourceScope,scope);else scope=metadata.resourceScope
   for(let k=body;k<b.length;){const id=b.readUInt32LE(k),len=b.readUInt32LE(k+5);sent.add(id);k+=9+len;assert(k<=b.length)}
   samples.push({i,ms,bytes:b.length,statistics:reply.compileStats?.sourceDemand?.timingUs})
   if(run<2)packets.push(b)
  }
  if(packets.length)for(const [i,b] of packets.entries()){
   const n=b.readUInt32LE(8),geom=(24+n+3)&~3,md=decodeFrameValue(b.subarray(24,24+n)) as any
   delete md.resourceScope
   const obj={metadata:JSON.stringify(md),geometryAndResources:sha(b.subarray(geom)),length:b.length}
   if(!run)oracles[i]=obj;else assert(isDeepStrictEqual(obj,oracles[i]),'different payloads for crop '+i)
  }
  rows.push({arm,samples})
  await fs.writeFile(out,JSON.stringify({rows,geometryAndResourcesEqual:oracles.map(v=>v.geometryAndResources)},null,2)+'\n')
 }finally{await p.close()}
}
