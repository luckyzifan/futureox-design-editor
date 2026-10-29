import { readFileSync, writeFileSync } from 'node:fs'
const records=[]
for(const line of readFileSync(process.argv[2],'utf8').split('\n')){
 if(!line.startsWith('[render-diag] '))continue
 try{const item=JSON.parse(line.slice(14));records.push(...(item.batch||[item]))}catch{}
}
const scalar=(row,keys)=>Object.fromEntries(keys.filter(key=>row[key]!==undefined).map(key=>[key,row[key]]))
const requests=new Map()
for(const row of records){
 const key=row.session+'/'+row.requestId
 if(row.event==='request')requests.set(key,{...scalar(row,['session','requestId','zoom','x','y','at']),tiles:0,drawCalls:0,encodedPassPixels:0,graphMs:0,finishMs:0,checkpointMs:0,peakTextureBytes:0})
 if(row.event==='tile'){
  const item=requests.get(key);if(!item)continue;item.tiles++
  for(const [to,from] of [['drawCalls','tileDrawCalls'],['encodedPassPixels','encodedPassPixels'],['graphMs','graphMs'],['finishMs','finishMs'],['checkpointMs','checkpointMs']])item[to]+=row[from]||0
  item.peakTextureBytes=Math.max(item.peakTextureBytes,row.peakTextureBytes||0)
 }
}
const cpu=Object.fromEntries([40,41].map(stage=>{const values=records.filter(r=>r.cpuStageCode===stage&&r.cpuPhase===2&&typeof r.cpuDurationMs==='number').map(r=>r.cpuDurationMs).sort((a,b)=>a-b);return [stage,{samples:values.length,maxMs:values.at(-1),p95Ms:values[Math.floor(values.length*.95)]}]}))
const out={scope:'Encoded draws; CPU timings and queue completion waits, not GPU timestamp/physical display FPS. Requests may include cancelled or partial work.',cpu,
 failures:records.filter(r=>r.event==='failure-origin'||r.event==='error'&&r.failureCode!==1).map(r=>scalar(r,['at','source','requestId','failureCode','failureCategory','renderResetCode','failureAllocationWidth','failureAllocationHeight','failureAllocationPassMode','textureWidth','textureHeight','textureMaxDimension','textureKernelRadius'])),
 requests:[...requests.values()].filter(r=>r.tiles||r.zoom>32),
 slowFences:records.filter(r=>r.event==='fence'&&r.queueWaitMs>=1000).map(r=>scalar(r,['at','requestId','queueWaitMs','reasonCode','deviceFenceOutcome','deviceFenceSubmitFirst','deviceFenceSubmitLast','drawCalls']))}
const json=JSON.stringify(out,null,2)+'\n';if(process.argv[3])writeFileSync(process.argv[3],json);else process.stdout.write(json)
