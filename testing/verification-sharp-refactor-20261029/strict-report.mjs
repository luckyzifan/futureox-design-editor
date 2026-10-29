import {sameCamera} from './report-contract.mjs'
const finite=n=>typeof n==='number'&&Number.isFinite(n)
export function canReusePresented(last,target,lastChangeAt,latest,width,height,dpr){
 return !!last?.complete&&finite(last.at)&&last.at>=lastChangeAt&&
  last.frame?.presentationId===latest?.presentationId&&sameCamera(last.frame.view,target)&&
  last.frame.width===width&&last.frame.height===height&&last.frame.dpr===dpr
}
const p95=values=>values.length?[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1]:null
/** Software ACK is a diagnostic proxy, never a physical-pixel P95 certificate.
 * The readback timestamp is taken after getImageData, before PNG/hash/file IO.
 * A no-op final camera cannot erase time since the last real camera change. */
export function evaluateStrict(report,config){
 const target=config.latencyAcceptance
 if(target?.latestVisibleFrameP95Ms!==33||target?.stopToNativeReadyMs!==100||target?.maximumMotionUpscale!==1)
  throw Error('Confirmed strict thresholds are absent or changed')
 const cases=[],failures=[]
 if(report.assessment?.status==='FAIL')failures.push('consistency-failed')
 for(const spec of config.cases.filter(c=>c.motion)){
  const row=report.samples.find(r=>r.id===spec.id),errors=[]
  if(row?.status!=='complete'){cases.push({id:spec.id,status:'FAIL',failures:['incomplete']});failures.push(spec.id+':incomplete');continue}
  const pixelMs=finite(row.readyPixels?.pixelsAvailableAt)&&finite(row.effectiveFinalInputAt)
   ?row.readyPixels.pixelsAvailableAt-row.effectiveFinalInputAt:null
  if(!finite(pixelMs)||pixelMs<0)errors.push('pixel-readback-timing-unproved')
  else if(pixelMs>target.stopToNativeReadyMs)errors.push('stop-to-native-pixels-over-100ms')
  const upscale=row.motionQuality?.maxUpscale
  if(!finite(upscale)||!row.motionQuality.samples)errors.push('motion-density-unproved')
  else if(upscale>1+1e-10)errors.push('motion-upscales-resident-pixels')
  const inputs=(row.inputs||[]).filter(i=>i.changed!==false)
  const submissions=(row.presentations||[]).filter(p=>p.presented&&finite(p.at))
  const delays=[];let missing=0
  for(let i=0;i<inputs.length;i++){
   const first=submissions.find(p=>p.at>=inputs[i].at&&inputs.slice(i).some(n=>n.at<=p.at&&sameCamera(n.view,p.presented.view)))
   if(first)delays.push(first.at-inputs[i].at);else missing++
  }
  const proxy=p95(delays)
  cases.push({id:spec.id,status:errors.length?'FAIL':'INCOMPLETE',failures:errors,
   effectiveFinalInputAt:row.effectiveFinalInputAt,stopToNativePixelReadbackMs:pixelMs,
   maximumMotionUpscale:upscale,acknowledgementProxy:{p95Ms:proxy,samples:delays.length,missing,
    status:missing||proxy===null?'UNPROVED':proxy>33?'OVER_TARGET':'WITHIN_TARGET',certifiesVisiblePixels:false}})
  failures.push(...errors.map(e=>spec.id+':'+e))
 }
 return {status:failures.length?'FAIL':'INCOMPLETE',target,cases,failures,
  unmeasured:['latest-visible-pixel P95 (ACK proxy is not pixels)','all motion frames: white holes and stale contents','physical scanout'],
  scope:'Confirmed 33/100 ms targets. Cold start excluded. Explicit failures and incomplete measurements cannot become PASS.'}
}
