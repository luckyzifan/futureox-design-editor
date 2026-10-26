import {readFile,writeFile} from 'node:fs/promises'
import path from 'node:path'
const run=process.argv[2],report=JSON.parse(await readFile(path.join(run,'report.json'),'utf8'))
const rows=[],seen=new Set()
for(const line of (await readFile(path.join(run,'host.log'),'utf8')).split('\n')){
  const start=line.indexOf('[render-diag] ');if(start<0)continue
  let message;try{message=JSON.parse(line.slice(start+14))}catch{continue}
  for(const row of message.batch||[message]){
    const key=[row.source,row.session,row.seq].join(':');if(seen.has(key))continue;seen.add(key);rows.push(row)
  }
}
const edits=(report.localEdits||[]).map((edit,index)=>{
  const events=rows.filter(row=>row.at>=edit.start&&row.at<=edit.end),tiles=events.filter(row=>row.event==='tile')
  const sum=key=>tiles.reduce((sum,row)=>sum+(Number(row[key])||0),0)
  const competing=(report.competition||[]).filter(row=>row.at>=edit.start-1000&&row.at<=edit.end+1000)
  const blur=(report.foregroundEvents||[]).filter(row=>row.at>=edit.start&&row.at<=edit.end&&(!row.focused||row.visible!=='visible'))
  const previous=edit.priorRevision??(index?report.localEdits[index-1].diagnostics.requestedRevision:report.initialDiagnostics?.requestedRevision)
  const currentRevision=Number(edit.diagnostics.requestedRevision)>Number(previous)&&edit.diagnostics.revision===edit.diagnostics.requestedRevision
  const mutationObserved=edit.damage.some(row=>row.channel==='canvas')&&currentRevision
  return {value:edit.value,elapsedMs:edit.elapsedMs,damage:edit.damage.map(row=>row.damage),
    viewportTilesSubmitted:Number(edit.diagnostics.tileScheduleOnscreen),tiles:tiles.length,drawCalls:sum('tileDrawCalls'),
    compileMs:sum('compileMs'),graphMs:sum('graphMs'),checkpointMs:sum('checkpointMs'),
    failures:events.filter(row=>row.event==='failure-origin'&&row.failureCategory>1),
    uiStalls:events.filter(row=>row.event==='frame-window').reduce((sum,row)=>sum+(row.uiStalls||0),0),
    competing,blur,mutationObserved,performanceAdmissible:!report.pixelQaOnly&&mutationObserved&&competing.length===0&&blur.length===0}
})
const output={status:report.status,pixelQaOnly:!!report.pixelQaOnly,host:report.host,kind:report.kind,target:report.target,camera:report.camera,
  preparation:report.preparation,undoRedoExact:report.undoRedoExact,reopenedMaterialExact:report.reopenedMaterialExact,
  savedFile:report.savedFile,edits,error:report.error,
  semantics:'Foreground GUI UI-edit start to existing exact-content readiness (includes harness settle check); draw/tile counters, not physical scanout or GPU timestamp. Screenshots are outside timing.'}
await writeFile(path.join(run,'analysis.json'),JSON.stringify(output,null,2)+'\n')
console.log(JSON.stringify({status:output.status,edits:edits.map(({elapsedMs,viewportTilesSubmitted,drawCalls,performanceAdmissible})=>({elapsedMs,viewportTilesSubmitted,drawCalls,performanceAdmissible}))}))
