// Read-only accounting of actual harness and bounded Electron diagnostics.
import {readFile,writeFile} from 'node:fs/promises'
import path from 'node:path'
const directory=process.argv[2]
if(!directory)throw Error('run directory required')
const run=JSON.parse(await readFile(path.join(directory,'results.json'),'utf8'))
const events=[]
for(const line of (await readFile(path.join(directory,'host-stdout.log'),'utf8')).split('\n')){
 const marker=line.indexOf('[render-diag] ')
 if(marker<0)continue
 try{events.push(...(JSON.parse(line.slice(marker+14)).batch||[]))}catch{}
}
const total=(rows,key)=>rows.reduce((sum,row)=>sum+(Number.isFinite(row[key])?row[key]:0),0)
const stages=run.stages.map(stage=>{
 const rows=events.filter(event=>event.at>=stage.wallStart&&event.at<=stage.wallEnd)
 const tiles=rows.filter(event=>event.event==='tile')
 const requests=[...new Set(rows.filter(event=>event.event==='queue-start').map(event=>event.requestId))]
 return {
  name:stage.name,totalMs:stage.totalMs,actionMs:stage.actionMs,
  afterActionToReadyMs:stage.totalMs-stage.actionMs,
  ready:stage.settled.ok,rafMaxMs:stage.raf.max,rafOver50:stage.raf.over50,
  // rAF measures UI callbacks, not content updates or physical presentation.
  tiles:tiles.length,firstTileMs:tiles.length?tiles[0].at-stage.wallStart:null,
  fieldBuildMs:total(tiles,'fieldBuildElapsedMs'),
  fieldBuilds:total(tiles,'materialFieldBuilds'),
  fieldUploadBytes:total(tiles,'materialFieldUploadBytes'),
  passPixelVisits:total(tiles,'encodedPassPixels'),
  horizontalHits:total(tiles,'horizontalFilterHits'),
  horizontalRows:total(tiles,'horizontalFilterRows'),
  horizontalPixels:total(tiles,'horizontalFilterPixels'),
  prefixAcceptedLines:total(rows.filter(row=>row.event==='prefix'),'acceptedLines'),
  prefixDeclinedLines:total(rows.filter(row=>row.event==='prefix'),'declinedLines'),
  requests:requests.map(id=>{
   const start=rows.find(row=>row.event==='queue-start'&&row.requestId===id)
   const end=rows.find(row=>row.event==='queue-end'&&row.requestId===id)
   const parts=tiles.filter(row=>row.requestId===id)
   return {id,startMs:start.at-stage.wallStart,durationMs:end?.durationMs,tiles:parts.length,
    order:parts.map(row=>({index:row.tileSourceIndex,order:row.tileOrderIndex,x:row.x,y:row.y,
     horizontalRows:row.horizontalFilterRows,nextIndex:row.tileColumnNextIndex}))}
  })
 }
})
const summary={status:run.status,fixture:run.fixture,fixtureSha256:run.fixtureSha256,
 startedAt:run.startedAt,sampling:run.sampling,diagnostics:run.diagnostics,
 errors:run.errors,stages,editChanged:run.extended?.edit?.changed,
 undoRestoredCompleteDocument:run.extended?.edit?.undoRestoredCompleteDocument,
 limits:'UI callback intervals are not displayed content FPS. Queue completion includes scheduling and other GPU clients; it is not exclusive shader execution.'}
await writeFile(path.join(directory,'run-summary.json'),JSON.stringify(summary,null,2)+'\n')
console.log(JSON.stringify({...summary,stages:stages.map(({requests,...stage})=>stage)},null,2))
