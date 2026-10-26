import {readFile,writeFile} from 'node:fs/promises'
import path from 'node:path'
const dir=process.argv[2],report=JSON.parse(await readFile(path.join(dir,'report.json'),'utf8'))
const seen=new Set(),rows=[]
for(const line of (await readFile(path.join(dir,'host.log'),'utf8')).split('\n')){
 const marker=line.indexOf('[render-diag] ');if(marker<0)continue
 let message;try{message=JSON.parse(line.slice(marker+14))}catch{continue}
 for(const row of message.batch||[message]){
  const id=[row.source,row.session,row.seq].join(':');if(seen.has(id))continue;seen.add(id);rows.push(row)
 }
}
const start=report.motionStart??report.phases?.[0]?.start??Infinity
const end=report.motionEnd??report.finalSettled??report.phases?.at(-1)?.ended??-Infinity
let deliveredPointerUp
if(report.phases?.length){
 try{
  const probe=JSON.parse(await readFile(path.join(dir,report.phases.at(-1).label+'-frames.json'),'utf8'))
  const up=probe.events.filter(event=>event.type==='pointerup').at(-1)
  if(up)deliveredPointerUp=probe.origin+up.t
 }catch{}
}
const motion=rows.filter(row=>row.at>=start&&row.at<=end)
const submits=motion.filter(row=>row.event==='camera-submit'&&row.compositorFrames!==undefined)
const measured=submits.filter(row=>row.coverageMeasured===1)
const key=(row,alpha=false)=>[row.deviceWorkerScope,row.deviceIncarnation,alpha?row.alphaFrame:row.compositorFrames].join(':')
const actual=new Set(submits.map(row=>key(row)))
const alpha=rows.filter(row=>row.event==='frame-alpha'&&actual.has(key(row,true)))
const invalidAlpha=alpha.filter(row=>row.alphaProbeCode!==0)
const failures=motion.filter(row=>row.event==='failure-origin'&&row.failureCategory>1)
const maximum=(list,key)=>list.length?Math.max(...list.map(row=>row[key]??0)):null
const minimum=(list,key)=>list.length?Math.min(...list.map(row=>row[key]??0)):null
const result={scope:'owned foreground GUI, native inputs, compositor submissions and hardware target Alpha; screencast enabled when recorded; not physical scanout',
 status:report.status,start,end,submits:submits.length,measured:measured.length,
 minCoverage:minimum(measured,'coverage'),minSharpCoverage:minimum(measured,'sharpCoverage'),minNativePhaseCoverage:minimum(measured,'nativePhaseCoverage'),
 maxUpscale:maximum(measured,'maxUpscale'),alphaFrames:alpha.length,invalidAlpha:invalidAlpha.length,
 transparentFrames:alpha.filter(row=>row.alphaZeroPixels>0).length,maxTransparentPixels:maximum(alpha,'alphaZeroPixels'),
 failures:failures.map(row=>({request:row.requestId,category:row.failureCategory,code:row.failureCode,stage:row.failureStage,callsite:row.failureAllocationCallsite,
 shaderMode:row.failureAllocationPassMode?row.failureAllocationPassMode-1:undefined})),
 convergenceMs:report.motionEnd&&report.inputStopped?report.motionEnd-report.inputStopped:report.finalSettled&&report.finalInputStopped?report.finalSettled-report.finalInputStopped:undefined,
 deliveredPointerUpToSettledMs:deliveredPointerUp!==undefined&&report.finalSettled?report.finalSettled-deliveredPointerUp:undefined,
 phases:report.phases?.map(phase=>({label:phase.label,settleMs:phase.ended-phase.stopped,events:phase.events})),
 maxPipelineMs:maximum(motion.filter(row=>row.event==='result'),'pipelineWallMs'),maxGraphMs:maximum(motion.filter(row=>row.event==='result'),'graphMs'),
 maxTileMs:maximum(motion.filter(row=>row.event==='tile'),'milliseconds'),
 error:report.error}
result.coverageGate=report.status==='captured'&&measured.length>0&&result.minCoverage===1&&result.minNativePhaseCoverage===1&&result.maxUpscale<=1&&
 alpha.length>0&&!invalidAlpha.length&&!result.transparentFrames&&!failures.length?'PASS':'FAIL'
// Alpha and density can remain perfect while an old backing is held for many
// seconds. Neither compositor submission nor this harness's settle wait proves
// that the displayed object followed every physical input. Preserve that gap.
result.poseLatencyGate='NOT_MEASURED'
result.physicalLatencyGate='BLOCKED_THRESHOLD_UNREGISTERED'
result.motionGate=result.coverageGate==='FAIL'?'FAIL':'INCOMPLETE'
await writeFile(path.join(dir,'quality.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
