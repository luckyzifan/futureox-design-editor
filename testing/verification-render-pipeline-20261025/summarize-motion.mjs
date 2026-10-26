import {readFile,writeFile} from 'node:fs/promises'
import {createReadStream} from 'node:fs'
import {createInterface} from 'node:readline'
import path from 'node:path'
const directory=process.argv[2],report=JSON.parse(await readFile(path.join(directory,'report.json'),'utf8'))
const submits=[],failures=[],seen=new Set()
for await(const line of createInterface({input:createReadStream(path.join(directory,'host.log')),crlfDelay:Infinity})){
  const at=line.indexOf('[render-diag] ');if(at<0)continue
  let value;try{value=JSON.parse(line.slice(at+14))}catch{continue}
  for(const row of value.batch||[value]){
    if(!(row.at>=report.motionStart&&row.at<=report.motionEnd))continue
    const key=[row.source,row.session,row.seq].join(':');if(seen.has(key))continue;seen.add(key)
    if(row.event==='camera-submit'&&row.coverageMeasured===1)submits.push(row)
    if(['failure-origin','failure-summary','error'].includes(row.event)&&(row.failureCategory??row.lastFailureCategory??0)>1)failures.push(row)
  }
}
const maximum=key=>submits.length?Math.max(...submits.map(r=>r[key]??0)):null
const minimum=key=>submits.length?Math.min(...submits.map(r=>r[key]??0)):null
const summary={scope:'native-input replay and measured compositor submission coverage, plus saved GUI PNGs; no physical scanout claim',
  reportStatus:report.status,inputs:report.inputs?.length??0,trusted:report.inputs?.every(e=>e.trusted)??false,
  submittedSamples:submits.length,minCoverage:minimum('coverage'),minNativePhaseCoverage:minimum('nativePhaseCoverage'),
  maxUpscale:maximum('maxUpscale'),dispatchStoppedToConvergenceMs:report.motionEnd&&report.inputStopped?report.motionEnd-report.inputStopped:null,
  failures:failures.map(row=>({requestId:row.requestId,code:row.failureCode??row.lastFailureCode,category:row.failureCategory??row.lastFailureCategory})),
  error:report.error,frames:report.frames?.length??0}
summary.status=report.status==='captured'&&summary.inputs===160&&summary.trusted&&submits.length&&summary.minCoverage===1&&summary.minNativePhaseCoverage===1&&summary.maxUpscale<=1&&!failures.length?'PASS':'FAIL'
await writeFile(path.join(directory,'quality.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary))
