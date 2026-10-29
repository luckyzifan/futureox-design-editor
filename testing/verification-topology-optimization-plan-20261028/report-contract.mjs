/** This validates observable evidence, not renderer internals or visual fidelity. */
export const countRenderStalls=stalls=>stalls.filter(s=>s.visible&&['render','motion','drain'].includes(s.stage)).length
export function evaluateReport(report, config) {
 const failures=[]
 if(report.source?.roots!==config.sourceRoots)failures.push('source-root-count')
 if(!report.source?.nodes||config.sourceNodes!==undefined&&report.source.nodes!==config.sourceNodes)failures.push('source-node-count')
 for(const id of config.runs){
  const row=report.samples?.find(r=>r.id===id)
  if(!row||row.status!=='complete'){failures.push(`${id}:incomplete`);continue}
  if(row.maxActive>config.guards.maxRasterRequests)failures.push(`${id}:concurrency`)
  if(row.requests.some(r=>r.tiles>config.guards.maxTilesPerRequest))failures.push(`${id}:batch-size`)
  if(row.errors?.length)failures.push(`${id}:render-error`)
  if(row.visibleUiStalls>0)failures.push(`${id}:ui-stall`)
  if(Number.isFinite(row.motionStoppedAt)&&Math.abs(row.readyAt-row.motionStoppedAt-row.stopToReadyMs)>1e-6)failures.push(`${id}:timing-inconsistent`)
  if(row.pixels?.changedPixels<config.guards.minChangedPixels||!row.pixels?.sha256)failures.push(`${id}:blank`)
  const frame=row.pixels?.frame
  if(!frame||['x','y','zoom'].some(k=>frame.view?.[k]!==row.target[k])||frame.dpr!==report.runtime?.dpr)failures.push(`${id}:stale-pixels`)
  if(row.pixels?.width!==Math.ceil(config.viewport.width*report.runtime.dpr)||row.pixels?.height!==Math.ceil(config.viewport.height*report.runtime.dpr))failures.push(`${id}:pixel-size`)
  if(!row.requests.some(r=>r.tiles>0&&r.backend==='webgpu'&&!r.error))failures.push(`${id}:backend-unproved`)
  const final=row.qualitySummary?.last
  if(!final||final.nativeCoverageComplete!==true||!(final.maxUpscale<=1+1e-10))failures.push(`${id}:final-density-unproved`)
 }
 const same=report.samples?.filter(r=>['local-400-cold','local-400-repeat-1','local-400-repeat-2','motion-return'].includes(r.id)&&r.status==='complete')||[]
 if(same.length!==4||new Set(same.map(r=>r.pixels?.sha256)).size!==1)failures.push('same-view-pixels')
 return {status:failures.length?'FAIL':'PASS',failures,scope:'Full source ownership, current final GPU bitmap and repeatability; not independent Figma fidelity or physical GUI timing',g2Latency:'BLOCKED: numerical acceptance target not established'}
}
