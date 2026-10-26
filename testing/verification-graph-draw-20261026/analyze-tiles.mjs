import {readFile,writeFile} from 'node:fs/promises'
import path from 'node:path'
const directory=process.argv[2],report=JSON.parse(await readFile(path.join(directory,'report.json'),'utf8'))
const start=report.phases[0]?.start,end=report.finalSettled,seen=new Set(),rows=[],allRows=[]
for(const line of (await readFile(path.join(directory,'host.log'),'utf8')).split('\n')){
  if(!line.includes('[render-diag] '))continue
  let message;try{message=JSON.parse(line.split('[render-diag] ')[1])}catch{continue}
  for(const row of message.batch||[message]){
    const key=[row.source,row.session,row.seq].join(':');if(seen.has(key))continue;seen.add(key)
    allRows.push(row);if(row.at>=start&&row.at<=end)rows.push(row)
  }
}
const final=rows.filter(row=>row.event==='result'&&row.previewTiles>=20).at(-1)
if(!final)throw Error('No completed final 20-tile batch')
const tiles=rows.filter(row=>row.event==='tile'&&row.requestId===final.requestId)
if(tiles.length!==20)throw Error(`Expected 20 final tiles, got ${tiles.length}`)
const preparations=report.preparation?.filter(row=>row.diagnostics?.requestId===final.requestId)||[]
const total=key=>tiles.reduce((sum,row)=>sum+(row[key]||0),0)
const boundaries={}
for(const row of rows.filter(row=>row.event==='preparation'&&row.source==='host'&&row.requestId===final.requestId&&row.boundaryDurationMs!==undefined)){
  const key=String(row.boundaryCode);boundaries[key]??=[];boundaries[key].push(row.boundaryDurationMs)
}
const waits=rows.filter(row=>row.event==='prepare-wait'&&row.requestId===final.requestId)
const fences=rows.filter(row=>row.event==='fence'&&row.requestId===final.requestId&&row.queueWaitMs!==undefined)
const frameRows=await Promise.all(report.phases.map(async phase=>JSON.parse(await readFile(path.join(directory,phase.label+'-frames.json'),'utf8'))))
const last=frameRows.at(-1),pointerup=last.origin+last.events.filter(event=>event.type==='pointerup').at(-1).t
const windows=allRows.filter(row=>row.event==='frame-window'&&row.at>=start&&row.at-row.windowMs<=end)
const gaps=frameRows.flatMap(probe=>probe.frames.slice(1).map((frame,i)=>frame.t-probe.frames[i].t))
const result={scope:'real foreground Electron/native preparation/hardware rendering; overlapping elapsed stages, not GPU timestamps or physical scanout',
  requestId:final.requestId,target:report.topologyTarget,camera:report.phases[0].cameraBefore,
  pointerupToSettledMs:end-pointerup,pipelineWallMs:final.pipelineWallMs,
  compileTotalMs:total('compileMs'),exposedPreparationWaitMs:waits.reduce((s,r)=>s+r.waitMs,0),
  graphTotalMs:total('graphMs'),graphCheckpointMs:total('checkpointMs'),graphOtherElapsedMs:total('graphMs')-total('checkpointMs'),
  finishTotalMs:total('finishMs'),materialFieldBuildMs:total('fieldBuildElapsedMs'),materialFieldUploadBytes:total('materialFieldUploadBytes'),
  drawCalls:total('tileDrawCalls'),submissions:total('tileCommandSubmissions'),
  deviceIncarnations:[...new Set(rows.filter(r=>r.requestId===final.requestId&&r.deviceIncarnation!==undefined).map(r=>`${r.deviceWorkerScope}:${r.deviceIncarnation}`))],
  cacheInvalidations:rows.filter(r=>r.requestId===final.requestId&&r.event==='cache-invalidate').length,
  peakTextureBytes:final.peakTextureBytes,workingTextureBytes:final.workingTextureBytes,
  nativeCalls:preparations.length,nativeSuccesses:preparations.filter(r=>r.compileStats).length,nativeRejected:preparations.filter(r=>!r.compileStats),
  boundaries:Object.fromEntries(Object.entries(boundaries).map(([key,v])=>[key,{count:v.length,totalMs:v.reduce((a,b)=>a+b,0),maxMs:Math.max(...v)}])),
  fences:fences.map(r=>({reason:r.reasonCode,waitMs:r.queueWaitMs,pressure:r.admissionPressure,working:r.admissionWorkingBytes})),
  ui:{diagnosticStalls:windows.reduce((s,r)=>s+(r.uiStalls||0),0),diagnosticMaxMs:Math.max(0,...windows.map(r=>r.uiIntervalMaxMs||0)),
    phaseRafStalls:gaps.filter(v=>v>250).length,phaseRafMaxMs:Math.max(0,...gaps),windows},
  tiles:tiles.map(row=>Object.fromEntries(['tileSourceIndex','x','y','milliseconds','compileMs','graphMs','checkpointMs','finishMs',
    'fieldBuildElapsedMs','materialFieldBuilds','materialFieldHits','materialFieldUploadBytes','packetNodeVisits','tileDrawCalls','tileCommandSubmissions'].map(key=>[key,row[key]]))),
  preparation:preparations}
await writeFile(path.join(directory,'tile-breakdown.json'),JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify({...result,tiles:undefined,preparation:undefined,nativeRejected:result.nativeRejected.length,fences:undefined}))
