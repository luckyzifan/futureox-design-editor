// Strict scalar allowlist shared by worker, renderer and terminal. Never stringify a render payload.
export const PREFIX = '[render-diag] '
const events = new Set(['operation','request','result','tile','camera-request','camera-submit','compile','hydrate','queue-start','queue-end','cancel','stale-drop','error','gpu-exit','renderer-exit','cache','summary','start','filter','prefix','fence','camera-input','queue-enqueue','compile-start','hydrate-start','prepare-wait','viewport-state','skip','cache-invalidate','preparation','load-stage'])
const qualityLimits = {qualitySequence: 0xffffffff, qualityRevision: 0xffffffff, documentRevision: 0xffffffff}
const diagnosticLimits = {originChannelId: 0xffffffffffff, backendCode: 2, boundaryCode: 16, boundaryDurationMs: 120000}
const resourceLimits = {operationOwner:1e12,operationPresentation:1,operationId:1e9,operationSession:1e9,operationPhase:4,operationCategory:6,operationOutcome:5,authoredRevision:1e9,startRevision:1e9,targetCount:1e9,previewAttempts:1e9,previewAccepted:1e9,fullPayloadBytes:32*1024*1024,derivationReasonCode:4,sourceCodeUnits:32*1024*1024,embeddedFontCount:32,embeddedFontCodeUnits:32*28*1024*1024}
const fields = new Set(('retainNativePanPhase cameraDependent samplingMode dpr qualitySequence qualityRevision documentRevision qualityTerminal operationOwner operationPresentation operationId operationSession operationPhase operationCategory operationOutcome authoredRevision startRevision targetCount previewAttempts previewAccepted originChannelId backendCode boundaryCode boundaryDurationMs derivationAdmitted derivationFallback fullPayloadBytes derivationReasonCode sourceCodeUnits embeddedFontCount embeddedFontCodeUnits preparationId methodCode activePreparationId documentFork documentEnvelope retainInteractionGraph interactionNative interactionOwner interactionGeneration interactionBranch purpose commandCode renderIntent preview finalRequest readback png coverageTiles livePreview tileViewport requestId sequence x y zoom width height milliseconds compileMs graphMs finishMs checkpointMs loadMs renderMs pipelineWallMs preparationWaitMs previewTiles tileCacheHits certifiedTileHits tileCacheBytes tileCacheEvictions drawCalls triangles peakTextureBytes workingTextureBytes missingTextureCount compositorFrames compositorTiles compositorDraws durationMs waitMs count sampleCount suppressed cached cameraFallback reasonCode exitCode quitRequested permitClose resourceEpoch completedResourceEpoch radius mode ms oldConfig newConfig channel acceptedLines declinedLines acceptedPixels availableBytes scratchBytes mapMs queueWaitMs coverage sharpCoverage nativePhaseCoverage maxUpscale pixelCoverageComplete nativeCoverageComplete inputSequence inputAt inputTimeOrigin inputAgeMs deltaX deltaY deltaMode inputKind generation fillGeneration pageToken state phase navigating targetDensity effectiveDensity finalComplete oldContentAgeMs queueDepth activeRequestId superseded skipped coverageMeasured coverageAt dropped phaseX phaseY sceneReady tileIndex').split(' '))
export function sanitizeFields(value) {
  const out = {}
  if (!value || typeof value !== 'object') return out
  for (const key of fields) {
    const v = value[key]
    if (key === 'dpr') { if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 64) out[key]=v; continue }
    if (Object.hasOwn(qualityLimits,key)) {
      if (Number.isSafeInteger(v) && v >= 0 && v <= qualityLimits[key]) out[key]=v
      continue
    }
    if (key === 'retainNativePanPhase' || key === 'cameraDependent') {
      if (typeof v === 'boolean' || v === 0 || v === 1) out[key]=Number(v)
      continue
    }
    // Sampling geometry only: 1=native, 2=density-cache. Never accept strings.
    if (key === 'samplingMode') { if (v === 1 || v === 2) out[key]=v; continue }
    if (key === 'qualityTerminal') { if (typeof v === 'boolean' || v === 0 || v === 1) out[key]=Number(v); continue }
    if (key==='derivationAdmitted' || key==='derivationFallback') {
      if (typeof v==='boolean') out[key]=v?1:0
      else if (v===0 || v===1) out[key]=v
      continue
    }
    if (Object.hasOwn(diagnosticLimits,key)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= diagnosticLimits[key] && (key === 'boundaryDurationMs' || Number.isInteger(v))) out[key]=v
      continue
    }
    if (Object.hasOwn(resourceLimits,key)) {
      if (Number.isSafeInteger(v) && v>=((key==='operationId'||key==='operationPhase')?1:0) && v<=resourceLimits[key]) out[key]=v
      continue
    }
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
export function createRenderDiagnostics({enabled=false, detail=false, session=0, source='main', sink=()=>{}, batchSink,  now=()=>Date.now(), schedule=setTimeout, cancel=clearTimeout}={}) {
  let seq=0, timer, emitted=0, suppressed=0
  const aggregates=new Map()
  const ring=[]; let dropped=0
  function output(event, values) { const record=sanitizeRecord({v:1,session,source,seq:++seq,at:now(),event,...sanitizeFields(values)}); if(record) {try{sink(record)}catch{}} }
  function flush() {
    timer=undefined
    if(detail) {
      if(dropped) ring.push(sanitizeRecord({v:1,session,source,seq:++seq,at:now(),event:'summary',dropped}))
      for(let i=0;i<ring.length;i+=64) { const batch=ring.slice(i,i+64); try{if(batchSink)batchSink(batch);else for(const row of batch)sink(row)}catch{} }
      ring.length=0;dropped=0;return
    }
    if (suppressed) output('summary',{suppressed})
    for (const [event, row] of aggregates) output(event,{...row.last,sampleCount:row.count})
    aggregates.clear(); emitted=0; suppressed=0
  }
  return {
    enabled, detail,
    record(event, values={}) {
      if (!enabled || !events.has(event)) return
      if (timer===undefined) timer=schedule(flush,detail?250:1000)
      if(detail) {
        const row=sanitizeRecord({v:1,session,source,seq:++seq,at:now(),event,...sanitizeFields(values)})
        if(ring.length>=512){ring.shift();dropped++}
        if(row)ring.push(row)
        return
      }
      // At most 8 immediate records plus one latest/count per fixed event kind each second.
      if (emitted++ < 8) output(event,values)
      else {suppressed++;const row=aggregates.get(event);aggregates.set(event,{count:(row?.count||0)+1,last:sanitizeFields(values)})}
    },
    flush() {if(timer!==undefined)cancel(timer);flush()},
    close() {if(timer!==undefined)cancel(timer);timer=undefined;aggregates.clear();ring.length=0},
  }
}
let gpuSink
export function setGpuDiagnosticSink(sink) { gpuSink=sink }
export function recordGpuDiagnostic(event, fields) { if(gpuSink) gpuSink(event,fields) }
export function gpuDiagnosticsEnabled() { return !!gpuSink }

let gpuDetail=false
export function setGpuDiagnosticsDetail(value) {gpuDetail=value===true}
export function gpuDiagnosticsDetail() {return gpuDetail}
export function sanitizeBatch(value) {return Array.isArray(value)&&value.length<=64?value.map(sanitizeRecord).filter(Boolean):[]}

// Requested intent only, never infer completed pixels from these categories.
export function renderRequestCategories(payload) {
  const p=payload&&typeof payload==='object'?payload:{}
  const o=p.options&&typeof p.options==='object'?p.options:{}
  const commands=['display-read-pixel','display-capture-content','display-import','gpu-memory','park-gpu','lose-device','navigation-diagnostic']
  const commandCode=p.command===undefined?1:(commands.includes(p.command)?commands.indexOf(p.command)+2:0)
  const renderIntent=o.renderIntent==='preview'?1:o.renderIntent==='settled'?2:o.renderIntent==='canvas'?3:0
  const isRender=p.command===undefined && !!p.options
  return {documentEnvelope:p.document!==undefined?1:p.documentPatch!==undefined?2:0,retainInteractionGraph:o.retainInteractionGraph===true,interactionNative:o.interactionNative===true,interactionOwner:o.interactionOwner,interactionGeneration:o.interactionGeneration,interactionBranch:o.interactionBranch,commandCode,purpose:!isRender?5:p.png||o.exportRegion?4:renderIntent||0,
    channel:p.channel==='interaction'?1:isRender?0:2,renderIntent,
    preview:!!o.tileViewport||o.livePreview===true,finalRequest:renderIntent===2,
    readback:p.readback===true||p.png===true,png:p.png===true,
    coverageTiles:o.coverageTiles===true,livePreview:o.livePreview===true,tileViewport:!!o.tileViewport}
}
export function renderResultReason(error) { return error === 'PREVIEW_CANCELLED' ? 5 : error ? 1 : 0 }

// Call only in DETAIL mode, with the already-parsed authored snapshot. No
// resource names, payload bytes, node scan, JSON parse, or stringify is needed.
export function snapshotResourceFields(sourceCodeUnits, fonts) {
  const out=sanitizeFields({sourceCodeUnits})
  let count=0, units=0
  if(fonts!==undefined && (!fonts || typeof fonts!=='object' || Array.isArray(fonts))) return out
  for(const key in fonts) {
    if(!Object.hasOwn(fonts,key))continue
    if(++count>32)return out
    const data=fonts[key]?.data
    if(typeof data!=='string')return out
    units+=data.length
    if(units>resourceLimits.embeddedFontCodeUnits)return out
  }
  return {...out,embeddedFontCount:count,embeddedFontCodeUnits:units}
}
