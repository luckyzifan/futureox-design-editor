// Strict scalar allowlist shared by worker, renderer and terminal. Never stringify a render payload.
export const PREFIX = '[render-diag] '
const events = new Set(['request','result','tile','camera-request','camera-submit','compile','hydrate','queue-start','queue-end','cancel','stale-drop','error','gpu-exit','renderer-exit','cache','summary','start','filter','prefix','fence'])
const fields = new Set(('requestId sequence x y zoom width height milliseconds compileMs graphMs finishMs checkpointMs loadMs renderMs pipelineWallMs preparationWaitMs previewTiles tileCacheHits certifiedTileHits tileCacheBytes tileCacheEvictions drawCalls triangles peakTextureBytes workingTextureBytes missingTextureCount compositorFrames compositorTiles compositorDraws durationMs waitMs count sampleCount suppressed cached cameraFallback reasonCode exitCode quitRequested permitClose resourceEpoch completedResourceEpoch radius mode ms oldConfig newConfig channel acceptedLines declinedLines acceptedPixels availableBytes scratchBytes mapMs queueWaitMs coverage sharpCoverage nativePhaseCoverage maxUpscale pixelCoverageComplete nativeCoverageComplete').split(' '))
export function sanitizeFields(value) {
  const out = {}
  if (!value || typeof value !== 'object') return out
  for (const key of fields) {
    const v = value[key]
    if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e15) out[key] = v
    else if (typeof v === 'boolean') out[key] = v ? 1 : 0
  }
  return out
}
export function sanitizeRecord(value) {
  if (!value || value.v !== 1 || !events.has(value.event) || !['main','worker','host'].includes(value.source)) return null
  if (!['session','seq','at'].every(k => Number.isFinite(value[k]) && value[k] >= 0 && value[k] <= 1e15)) return null
  return {v:1, session:value.session, source:value.source, seq:value.seq, at:value.at, event:value.event, ...sanitizeFields(value)}
}
export function createRenderDiagnostics({enabled=false, session=0, source='main', sink=()=>{}, now=()=>Date.now(), schedule=setTimeout, cancel=clearTimeout}={}) {
  let seq=0, timer, emitted=0, suppressed=0
  const aggregates=new Map()
  function output(event, values) { const record=sanitizeRecord({v:1,session,source,seq:++seq,at:now(),event,...sanitizeFields(values)}); if(record) {try{sink(record)}catch{}} }
  function flush() {
    timer=undefined
    if (suppressed) output('summary',{suppressed})
    for (const [event, row] of aggregates) output(event,{...row.last,sampleCount:row.count})
    aggregates.clear(); emitted=0; suppressed=0
  }
  return {
    enabled,
    record(event, values={}) {
      if (!enabled || !events.has(event)) return
      if (timer===undefined) timer=schedule(flush,1000)
      // At most 8 immediate records plus one latest/count per fixed event kind each second.
      if (emitted++ < 8) output(event,values)
      else {suppressed++;const row=aggregates.get(event);aggregates.set(event,{count:(row?.count||0)+1,last:sanitizeFields(values)})}
    },
    flush() {if(timer!==undefined)cancel(timer);flush()},
    close() {if(timer!==undefined)cancel(timer);timer=undefined;aggregates.clear()},
  }
}
let gpuSink
export function setGpuDiagnosticSink(sink) { gpuSink=sink }
export function recordGpuDiagnostic(event, fields) { if(gpuSink) gpuSink(event,fields) }
export function gpuDiagnosticsEnabled() { return !!gpuSink }
