import {readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {decodeScenePacket} from '../../frontend/design-client/src/kernel/gpu/scene-packet'
const [left,right,out]=process.argv.slice(2)
if(!left||!right||!out)throw Error('Two five-packet directories and a fresh report required')
const hash=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex'),results=[]
for(let i=0;i<5;i++){
 const [a,b]=await Promise.all([left,right].map(async d=>decodeScenePacket(new Uint8Array(await readFile(`${d}/packet-${i}.fgsc`)))))
 const signature=({vertices,curves,pagePaintRects,...scene}:typeof a)=>({
  scene:hash(JSON.stringify(scene,(_k,v)=>typeof v==='number'&&(Object.is(v,-0)||!Number.isFinite(v))?`number:${Object.is(v,-0)?'-0':String(v)}`:v)),
  vertices:hash(new Uint8Array(vertices.buffer,vertices.byteOffset,vertices.byteLength)),
  curves:hash(new Uint8Array(curves.buffer,curves.byteOffset,curves.byteLength))})
 const before=signature(a),after=signature(b),r=a.output||{x:0,y:0,w:a.width,h:a.height}
 const prior=a.pagePaintRects,next=b.pagePaintRects
 const proof=prior===undefined?next===undefined:next===undefined
  ?prior.some(p=>p[0]<=r.x&&p[1]<=r.y&&p[2]>=r.x+r.w&&p[3]>=r.y+r.h)
  :next.length===prior.length&&next.every((p,j)=>p.every(Number.isFinite)&&p[0]<=prior[j][0]&&p[1]<=prior[j][1]&&p[2]>=prior[j][2]&&p[3]>=prior[j][3])
 results.push({tile:i,before,after,drawingEqual:JSON.stringify(before)===JSON.stringify(after),
  backgroundProofConservative:proof,proofChange:next===undefined&&prior!==undefined?'declined-covered-output':JSON.stringify(prior)===JSON.stringify(next)?'unchanged':'widened'})
}
await writeFile(out,JSON.stringify({scope:'Exact drawing semantics and f32 geometry. Optional background support may only widen, or decline when the old support covers the whole output; never accepted as different painted pixels.',results},null,2))
if(results.some(r=>!r.drawingEqual||!r.backgroundProofConservative))throw Error('Drawing or background proof regression')
console.log(JSON.stringify(results.map(({tile,drawingEqual,backgroundProofConservative,proofChange})=>({tile,drawingEqual,backgroundProofConservative,proofChange}))))
