import {readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {decodeScenePacket} from '../../frontend/design-client/src/kernel/gpu/scene-packet'
const [left,right,out]=process.argv.slice(2)
if(!left||!right||!out)throw Error('Usage: bun compare-packets.ts LEFT_DIR RIGHT_DIR REPORT')
const sha=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex'),results=[]
for(let i=0;i<3;i++){
 const scenes=await Promise.all([left,right].map(async dir=>decodeScenePacket(new Uint8Array(await readFile(`${dir}/packet-${i}.fgsc`)))))
 const signatures=scenes.map(({vertices,curves,...scene})=>({scene:sha(JSON.stringify(scene,(_key,v)=>typeof v==='number'&&(Object.is(v,-0)||!Number.isFinite(v))?`number:${Object.is(v,-0)?'-0':String(v)}`:v)),vertices:sha(new Uint8Array(vertices.buffer,vertices.byteOffset,vertices.byteLength)),curves:sha(new Uint8Array(curves.buffer,curves.byteOffset,curves.byteLength))}))
 results.push({tile:i,nodes:Object.keys(scenes[0].nodes).length,signatures,equal:JSON.stringify(signatures[0])===JSON.stringify(signatures[1])})
}
await writeFile(out,JSON.stringify({scope:'Decoded complete render semantics and exact f32 geometry bytes; private transport scope excluded',results},null,2))
if(results.some(r=>!r.equal))throw Error('Compiled semantic or program-byte mismatch')
console.log(JSON.stringify(results.map(r=>({tile:r.tile,nodes:r.nodes,equal:r.equal}))))
