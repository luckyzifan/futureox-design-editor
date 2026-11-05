// Reconstruct standalone packets from actual desktop requests: omit only the prior worker's frame-resource receipts.
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {NativePreparation} from '../../frontend/design-desktop/src/preparation.mjs'
const [capture,bin,out]=process.argv.slice(2)
await fs.mkdir(out,{recursive:true})
const p=new NativePreparation(bin,path.resolve('frontend/design-client/public/fonts/NotoSansSC.ttf'))
try{
 const d=JSON.parse(await fs.readFile(path.join(capture,'store.json')))
 const loaded=await p.loadSourceSnapshot(d);if(loaded.error)throw Error(loaded.error)
 const seen=new Set(),rows=[]
 for(const line of (await fs.readFile(path.join(capture,'requests.ndjson'),'utf8')).trim().split('\n')){
  const o=JSON.parse(line),r=o.captureViewport,key=[r.x,r.y,r.w,r.h].join('_');if(seen.has(key))continue
  seen.add(key);delete o.frameResources
  const a=await p.request({lane:'canvas',method:'compile_gpu_packet',args:[JSON.stringify(o)]})
  if(a.error||!a.value?.byteLength)throw Error(a.error||'Empty reply')
  const data=Buffer.from(a.value),tile='high_'+key
  await fs.writeFile(path.join(out,tile+'.pkt'),data)
  rows.push({tile,options:o,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')})
 }
 await fs.writeFile(path.join(out,'high-requests.json'),JSON.stringify(rows,null,2)+'\n')
}finally{await p.close()}
