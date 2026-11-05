// First captured packet in an isolated preparation owner, then the remaining tiles at the same camera.
import fs from 'node:fs/promises'
import path from 'node:path'
import {spawn,execFileSync} from 'node:child_process'
import {once} from 'node:events'
import {NativePreparation} from '../../frontend/design-desktop/src/preparation.mjs'
const [folder,binary,out]=process.argv.slice(2),desc=JSON.parse(await fs.readFile(path.join(folder,'store.json')))
const rows=[],options=(await fs.readFile(path.join(folder,'requests.ndjson'),'utf8')).trim().split('\n').map(l=>JSON.parse(l))
for(const tagged of [false,true]){
 const prep=new NativePreparation(binary,path.resolve('frontend/design-client/public/fonts/NotoSansSC.ttf'))
 let sampler,completed
 try{
  const loaded=await prep.loadSourceSnapshot(desc);if(loaded.error)throw Error(loaded.error)
  if(tagged){
   const pid=execFileSync('pgrep',['-P',String(process.pid),'design-prepare'],{encoding:'utf8'}).trim().split('\n')[0]
   sampler=spawn('/usr/bin/sample',[pid,'2','1','-file',out+'.sample'],{stdio:['ignore','ignore','pipe']})
   completed=once(sampler,'exit');await once(sampler.stderr,'data')
  }
  for(const request of options.slice(0,4)){
   const o={...request};delete o.frameResources
   const start=performance.now(),reply=await prep.request({lane:'canvas',method:'compile_gpu_packet',args:[JSON.stringify(o)]})
   if(reply.error)throw Error(reply.error)
   rows.push({instrumented:tagged,viewport:o.captureViewport,wallMs:performance.now()-start,bytes:reply.value.byteLength,stats:reply.compileStats})
  }
 }finally{if(completed)await completed;await prep.close()}
}
await fs.writeFile(out+'.json',JSON.stringify(rows,null,2)+'\n')
