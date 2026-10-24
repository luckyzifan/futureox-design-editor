import {Sidecar} from '../../frontend/design-desktop/src/sidecar.mjs'
import {readFileSync,writeFileSync,mkdirSync}from'node:fs'
import path from'node:path'
import {randomUUID,createHash}from'node:crypto'
const m=JSON.parse(readFileSync(new URL('./owned-gui-identity.json',import.meta.url),'utf8'))
const root=path.join(m.own,'source-fixtures');mkdirSync(root,{recursive:true})
const binary=path.join(m.host,'dist/sidecar/futureox-design-desktop-backend')
const sidecar=new Sidecar(binary,path.join(root,'profile'));const records=[]
try{
 const status=await sidecar.request('large.open',{path:'/Users/Apple/Downloads/拓扑素材.sketch',documentId:randomUUID(),sessionEpoch:1});const owner={owner:status.owner,expectedRevision:status.revision}
 for(const key of ['1:5','1:32480','1:81474']){
  const at=performance.now(),meta=await sidecar.request('large.scene',{...owner,key});const pieces=[];let offset=0
  while(offset<meta.bytes){const reply=await sidecar.request('large.sceneRead',{...owner,key,offset});const bytes=Buffer.from(reply.data,'base64');pieces.push(bytes);offset+=bytes.length}
  const bytes=Buffer.concat(pieces);if(createHash('sha256').update(bytes).digest('hex')!==meta.hash)throw Error('scene digest mismatch')
  const file=path.join(root,key.replace(':','-')+'.json');writeFileSync(file,bytes)
  const document=JSON.parse(bytes);records.push({key,file,bytes:bytes.length,sha256:meta.hash,nodes:meta.nodes,ms:performance.now()-at,maxStops:Math.max(...Object.values(document.nodes).flatMap(n=>[...n.fills,...n.strokes.map(s=>s.paint)].map(p=>p.stops.length)))})
 }
 writeFileSync(new URL('./source-fixtures.json',import.meta.url),JSON.stringify({scope:'real source via native sidecar; no GUI or GPU claim',sourceSha256:'b70f04948a8729d99224d94cd5328ad67673aa20d7c17d11bba3986c151c6c12',records},null,2)+'\n');console.log(JSON.stringify(records))
}finally{await sidecar.stop()}
