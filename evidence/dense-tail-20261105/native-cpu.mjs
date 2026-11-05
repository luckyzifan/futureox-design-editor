// Parent work (JSON parsing/IPC) is intentionally not counted as Rust CPU.
// Obtain the actual child on this owner, compare calibrated Darwin CPU and wall
// on the same 23 requests, with their genuine speculative ACK coverage.
import fs from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {spawn,execFileSync} from 'node:child_process'
import {createInterface} from 'node:readline'
import {once} from 'node:events'
import assert from 'node:assert/strict'
import {NativePreparation} from '../../frontend/design-desktop/src/preparation.mjs'
const [root,out]=process.argv.slice(2),w=path.resolve(root)
const {decodeFrameValue}=await import(pathToFileURL(path.join(w,'tooljs/frame-wire.js')))
const store=JSON.parse(await fs.readFile(path.join(w,'snap/store.json'),'utf8'))
const qs=(await fs.readFile(path.join(w,'cold-requests.ndjson'),'utf8')).trim().split('\n').map(JSON.parse)
const meter=spawn(path.join(w,'process-meter'),[],{stdio:['pipe','pipe','inherit']}),wait=[]
createInterface({input:meter.stdout}).on('line',s=>wait.shift()(JSON.parse(s)))
const read=pid=>new Promise(resolve=>{wait.push(resolve);meter.stdin.write(pid+'\n')})
const rows=[]
try{
 for(const arm of 'ABBAABBAABBA'){
  const prep=new NativePreparation(path.join(w,arm==='A'?'A':'frozen-B','bin/design-prepare'),path.resolve('frontend/design-client/public/fonts/NotoSansSC.ttf'))
  try{assert(!(await prep.loadSourceSnapshot(store)).error)
   const ids=execFileSync('pgrep',['-P',String(process.pid),'design-prepare'],{encoding:'utf8'}).trim().split('\n');assert.equal(ids.length,1)
   const pid=Number(ids[0]),samples=[];let scope=''
   for(const [i,b] of qs.entries()){
    const opts={...b,frameResources:{...b.frameResources,scope}}
    const a=await read(pid),t=performance.now(),r=await prep.request({lane:'canvas',method:'compile_gpu_packet',args:[JSON.stringify(opts)]}),ms=performance.now()-t,z=await read(pid)
    assert(!r.error && a&&z);const data=Buffer.from(r.value.buffer,r.value.byteOffset,r.value.byteLength)
    if(!i)scope=decodeFrameValue(data.subarray(24,24+data.readUInt32LE(8))).resourceScope
    samples.push({ms,userMs:(z[0]-a[0])/1e6,kernelMs:(z[1]-a[1])/1e6,pageins:z[2]-a[2],footprint:z[3],bytes:data.length})
   }
   rows.push({arm,samples});await fs.writeFile(out,JSON.stringify(rows,null,2)+'\n')
  }finally{await prep.close()}
 }
}finally{meter.stdin.end();await once(meter,'exit')}
