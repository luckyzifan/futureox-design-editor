// Replay the 23 genuine cold-view requests on a new preparation owner; take wall and stack in separate runs.
import path from 'node:path'
import fs from 'node:fs/promises'
import {spawn,execFileSync} from 'node:child_process'
import {once} from 'node:events'
import {NativePreparation} from '../../frontend/design-desktop/src/preparation.mjs'
const [store,trace,exe,out]=process.argv.slice(2),d=JSON.parse(await fs.readFile(store)),rows=[]
const opts=(await fs.readFile(trace,'utf8')).trim().split('\n').map(JSON.parse)
for(const sampled of [false,true]){
 const prep=new NativePreparation(exe,path.resolve('frontend/design-client/public/fonts/NotoSansSC.ttf'))
 let finish
 try{
  const opened=await prep.loadSourceSnapshot(d);if(opened.error)throw Error(opened.error)
  if(sampled){
   const pid=execFileSync('pgrep',['-P',String(process.pid),'design-prepare'],{encoding:'utf8'}).trim().split('\n')[0]
   const proc=spawn('/usr/bin/sample',[pid,'4','1','-file',out+'.sample'],{stdio:['ignore','ignore','pipe']})
   finish=once(proc,'exit');await once(proc.stderr,'data')
  }
  for(const [index,base] of opts.entries()){
   const o={...base};delete o.frameResources
   const t=performance.now(),v=await prep.request({lane:'canvas',method:'compile_gpu_packet',args:[JSON.stringify(o)]})
   if(v.error)throw Error(v.error)
   rows.push({sampled,index,ms:performance.now()-t,bytes:v.value.byteLength,stats:v.compileStats})
  }
 }finally{if(finish)await finish;await prep.close()}
}
await fs.writeFile(out+'.json',JSON.stringify(rows)+'\n')
