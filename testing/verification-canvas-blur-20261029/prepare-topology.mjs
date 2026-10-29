import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {Sidecar} from '../../frontend/design-desktop/src/sidecar.mjs'
const root=process.cwd(),out=process.argv[2]
if(!out||!path.isAbsolute(out))throw Error('New absolute output required')
await fs.mkdir(out)
const source='/Users/Apple/Downloads/拓扑素材.sketch',binary=path.join(root,'design-studio/target/desktop-dev/futureox-design-desktop-backend')
const inventory=JSON.parse(await fs.readFile('/tmp/futureox-topology-blur-inputs-20261029/inventory.json','utf8'))
const hash=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex')
const original=await hash(source)
if(original!==inventory.sha256)throw Error('Original changed')
const backend=new Sidecar(binary,path.join(out,'recovery'),{timeoutMs:120000})
const manifest={source,sourceHash:original,binaryHash:await hash(binary),cases:[],status:'running'}
try{
 const opened=await backend.request('large.open',{path:source,documentId:randomUUID(),sessionEpoch:1})
 const request={owner:opened.owner,expectedRevision:opened.revision}
 const pages=await backend.request('large.children',{...request,canvasOnly:true,limit:200})
 await fs.writeFile(path.join(out,'pages.json'),JSON.stringify(pages,null,2))
 for(const family of ['blur:type3','blur:type1','blurs:type0','innerShadows','shadows','blur:type0']){
  const candidates=inventory.roots.filter(r=>r.effects[family]&&r.nodes>=20&&r.nodes<=3000).sort((a,b)=>a.nodes-b.nodes)
  const target=candidates[0];if(!target)throw Error('No representative '+family)
  const found=await backend.request('large.children',{...request,query:target.id,limit:10})
  const entries=found.items||found.children||found.entries
  const item=entries?.find(r=>r.id===target.id)
  if(!item)throw Error('Indexed source root missing '+JSON.stringify(found))
  console.log('converting',family,target.name,target.nodes)
  const selected={...request,key:item.key},scene=await backend.request('large.scene',selected)
  const data=Buffer.alloc(scene.bytes)
  for(let offset=0;offset<data.length;){
   const part=await backend.request('large.sceneRead',{...selected,offset})
   const bytes=Buffer.from(part.data,'base64');if(!bytes.length||part.hash!==scene.hash)throw Error('Invalid scene chunk')
   bytes.copy(data,offset);offset+=bytes.length
  }
  if(createHash('sha256').update(data).digest('hex')!==scene.hash)throw Error('Scene hash mismatch')
  const name=family.replaceAll(':','-'),file=name+'.json';await fs.writeFile(path.join(out,file),data)
  const doc=JSON.parse(data),effects={}
  for(const n of Object.values(doc.nodes))for(const fx of n.effects||[])if(fx.visible)effects[fx.kind]=(effects[fx.kind]||0)+1
  manifest.cases.push({name,file,target,bytes:data.length,hash:scene.hash,nodes:Object.keys(doc.nodes).length,effects})
  await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2))
 }
 manifest.status='passed'
}catch(error){manifest.status='failed';manifest.error=String(error);process.exitCode=1}
finally{await backend.stop();manifest.sourceUnchanged=original===await hash(source);await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify(manifest.cases.map(c=>({name:c.name,nodes:c.nodes,effects:c.effects}))),manifest.error||'')}
