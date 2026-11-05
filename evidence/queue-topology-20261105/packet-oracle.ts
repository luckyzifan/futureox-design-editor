// Compare the complete decoded scene, including resource-bound nodes and images;
// also compare every geometry byte (preserves float signs/NaN bit patterns).
import fs from 'node:fs'
import {isDeepStrictEqual} from 'node:util'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {decodeScenePacket} from '../../frontend/design-client/src/kernel/gpu/scene-packet'
import {decodeFrameValue} from '../../frontend/design-client/src/kernel/gpu/frame-wire'
const [file,out]=process.argv.slice(2),runs=JSON.parse(fs.readFileSync(file,'utf8')),rows=[]
const digest=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex')
for(const [tile] of runs[0].samples.entries()){
 const read=(run:number)=>{const p=fs.readFileSync(file+'.'+run+'-'+runs[run].arm+'-'+tile+'.pkt')
  const start=Math.ceil((24+p.readUInt32LE(8))/4)*4,end=start+(p.readUInt32LE(12)+p.readUInt32LE(16))*4
  const metadata=decodeFrameValue(p.subarray(24,24+p.readUInt32LE(8))) as Record<string,unknown>
  const {resourceScope,...frame}=metadata
  return {scene:decodeScenePacket(p),geometry:digest(p.subarray(start,end)),resources:digest(p.subarray(end)),
   frame,scope:resourceScope,wire:digest(p),bytes:p.length}}
 const a=read(0)
 const comparisons=[1,2,3].map(run=>{const b=read(run);assert(isDeepStrictEqual(a.scene,b.scene));assert.equal(a.geometry,b.geometry)
  assert.equal(a.resources,b.resources);assert(isDeepStrictEqual(a.frame,b.frame))
  return {arm:runs[run].arm,sceneEqual:true,metadataOutsideOwnerEqual:true,resourcePayloadEqual:true,geometrySha256:b.geometry,scopeEqual:a.scope===b.scope,wireEqual:a.wire===b.wire}})
 rows.push({tile,packetBytes:a.bytes,geometrySha256:a.geometry,resourcePayloadSha256:a.resources,comparisons})
}
fs.writeFileSync(out,JSON.stringify(rows,null,2)+'\n')
