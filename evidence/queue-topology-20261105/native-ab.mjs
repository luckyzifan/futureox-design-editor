// Fresh native owner per run. Keep the preparation executable as the sole variable.
import fs from 'node:fs/promises'
import {createHash} from 'node:crypto'
import path from 'node:path'
import {NativePreparation} from '../../frontend/design-desktop/src/preparation.mjs'
const [snapshot,requests,binA,binB,out]=process.argv.slice(2)
const descriptor=JSON.parse(await fs.readFile(snapshot)),lines=(await fs.readFile(requests,'utf8')).trim().split('\n').map(JSON.parse),seen=new Set()
const options=[]
for(const request of lines){const o={...(request.options??request)},k=JSON.stringify(o.captureViewport??o.gpuViewport);if(seen.has(k))continue;seen.add(k);delete o.frameResources;options.push(o)}
const rows=[]
for(const arm of 'ABBAAB'){
 const prep=new NativePreparation(arm==='A'?binA:binB,path.resolve('frontend/design-client/public/fonts/NotoSansSC.ttf'))
 try{const loaded=await prep.loadSourceSnapshot(descriptor);if(loaded.error)throw Error(loaded.error)
  const samples=[]
  for(const [i,o] of options.entries()){
   const start=performance.now(),r=await prep.request({lane:'canvas',method:'compile_gpu_packet',args:[JSON.stringify(o)]}),wall=performance.now()-start
   if(r.error)throw Error(r.error)
   const bytes=Buffer.from(r.value),hash=createHash('sha256').update(bytes).digest('hex')
   if(rows.length<4) await fs.writeFile(out+'.'+rows.length+'-'+arm+'-'+i+'.pkt',bytes)
   samples.push({tile:i,wall,bytes:bytes.length,hash,mode:r.compileStats?.sourceDemand?.mode,prepared:r.compileStats?.preparedNodes,reuses:r.compileStats?.prepareReuses})
  }
  rows.push({arm,samples});await fs.writeFile(out,JSON.stringify(rows,null,2)+'\n')
 }finally{await prep.close()}
}
