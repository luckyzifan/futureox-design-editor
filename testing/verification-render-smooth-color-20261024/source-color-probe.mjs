import{Sidecar}from'../../frontend/design-desktop/src/sidecar.mjs'
import{mkdirSync,writeFileSync,mkdtempSync}from'node:fs'
import{tmpdir}from'node:os'
import{randomUUID}from'node:crypto'
import path from'node:path'
const out=path.resolve('testing/verification-render-smooth-color-20261024'),root=mkdtempSync(path.join(tmpdir(),'render-color-source-'))
writeFileSync(path.join(out,'source-probe-root.txt'),root)
const client=new Sidecar(path.resolve('frontend/design-desktop/dist/sidecar/futureox-design-desktop-backend'),path.join(root,'profile'))
try{
 const status=await client.request('large.open',{path:'/Users/Apple/Downloads/拓扑素材.sketch',documentId:randomUUID(),sessionEpoch:1});const owner={owner:status.owner,expectedRevision:status.revision};const rows=[]
 for(const query of ['140x140pt 30个','01-底座']){
  const result=await client.request('large.children',{...owner,query,offset:0,limit:100});rows.push(...result.items)
 }
 writeFileSync(path.join(out,'color-source-rows.json'),JSON.stringify(rows,null,2))
 for(const row of rows){const raw=await client.request('large.read',{...owner,key:row.key});writeFileSync(path.join(root,'source-'+row.key.replace(':','-')+'.json'),raw.json);console.log(JSON.stringify({key:row.key,id:row.id,name:row.name,bytes:row.bytes,raw:raw.json.slice(0,900),omitted:raw.omittedFields}))}
}finally{await client.stop()}
