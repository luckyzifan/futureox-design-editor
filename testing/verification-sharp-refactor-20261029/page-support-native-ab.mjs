import fs from 'node:fs/promises'
import path from 'node:path'
import {spawn} from 'node:child_process'
const [baseline,candidate,snapshot,out]=process.argv.slice(2)
if(!out)throw Error('Usage: node native-ab.mjs OLD_BINARY NEW_BINARY SNAPSHOT FRESH_OUT')
await fs.mkdir(out);const rows=[]
for(const id of ['A1','B1','B2','A2','A3','B3']){
 const dir=path.join(out,id),binary=id[0]==='A'?baseline:candidate
 const child=spawn(process.execPath,['testing/verification-sharp-refactor-20261029/profile-native-page-support.mjs',binary,snapshot,dir,'timing','true'],{stdio:['ignore','pipe','pipe']})
 let log='';for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>log+=bytes)
 const code=await new Promise(resolve=>child.once('close',resolve));await fs.writeFile(path.join(out,id+'.log'),log)
 if(code!==0)throw Error(`Native ${id} failed: ${code}`)
 const report=JSON.parse(await fs.readFile(path.join(dir,'report.json'),'utf8'));if(report.results.some(r=>r.error))throw Error(`${id} compile failed`)
 const row={id,loadMs:report.results[0].ms,compileMs:report.results.filter(r=>r.stage==='compile').map(r=>r.ms)};rows.push(row);console.log(JSON.stringify(row))
 await fs.writeFile(path.join(out,'progress.json'),JSON.stringify(rows,null,2))
}
const median=values=>values.slice().sort((a,b)=>a-b)[Math.floor(values.length/2)]
const old=median(rows.filter(r=>r.id[0]==='A').map(r=>median(r.compileMs.slice(1)))),next=median(rows.filter(r=>r.id[0]==='B').map(r=>median(r.compileMs.slice(1))))
await fs.writeFile(path.join(out,'summary.json'),JSON.stringify({rows,baselineMedianMs:old,candidateMedianMs:next,improvement:1-next/old,scope:'Production-policy warm new-camera native preparation with gpuPageBackground=true (19/64/32/8 after initial8), median within each run then 3 alternating pairs; cold/load separately retained; no profiler or GPU time claim'},null,2))
console.log(JSON.stringify({baselineMedianMs:old,candidateMedianMs:next,improvement:1-next/old}))
