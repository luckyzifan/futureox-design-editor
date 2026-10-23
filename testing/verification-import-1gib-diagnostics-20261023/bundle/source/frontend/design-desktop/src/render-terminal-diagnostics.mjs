import { sanitizeFailureAllocation } from './render-failure-allocation.mjs'
import { sanitizeRuntimeConfiguration } from './render-runtime-configuration.mjs'
import { producerIdentityFields, sanitizeProducerIdentity } from './render-diagnostic-identity.mjs'
// Strict scalar allowlist shared by worker, renderer and terminal. Never stringify a render payload.
const tileCostLimits = {imageAxisFields:1e9,imageFieldBytes:1e12,displayImageSourcePasses:1e9,nestedPrefixHits:1e9,nestedPrefixBuilds:1e9,nestedPrefixBytes:67108864,staticImageBlurEligible:1e9,staticImageBlurHits:1e9,staticImageBlurPixels:1e12,staticImageBlurBytes:17825792,staticImageBlurEntries:1,wholeFilterAxes:1e9,opaqueTentPasses:1e9,imageXTableBuilds:1e6,imageXTablePixels:1e12,imageXTableBytes:41943040,tileCacheDecision:5,tileCostSamples:2048,costSamplesOmitted:1e9,tileCostUnavailable:63,tileCostCapped:1,outputPixelVisits:1e12,sourcePixelVisits:1e12,sourcePixelAreaMax:1e9,supportRectExpansionMax:1e7,packetNodeVisits:1e9,sampledPacketNodeVisits:1e9,effectBlurVisits:1e9,effectBackdropVisits:1e9,effectShadowVisits:1e9,effectOtherVisits:1e9,costScanOmittedNodes:1e9,costScanOmittedEffects:1e9,encodedPassPixels:1e15,fieldBuildElapsedMs:120000,graphNonCheckpointElapsedMs:120000,materialFieldBuilds:1e9,materialFieldHits:1e9,materialFieldUploadBytes:1e12,tileDrawCalls:1e9,tileCommandSubmissions:1e9,horizontalFilterHits:1e9,horizontalFilterRows:1e12,horizontalFilterPixels:1e12}
export const PREFIX = '[render-diag] '
// Maintenance residency decisions contain scalar accounting only, no document payload.
Object.assign(tileCostLimits, { maintenanceDecision:6, mandatoryReasonBits:63, maintenanceDeferredCount:8, maintenanceRetiredBytes:17179869184, maintenanceRetiredCount:256,
 maintenancePoolBytes:17179869184, maintenanceTransientBytes:17179869184,
 maintenanceWorkingBytes:17179869184, maintenanceBudgetBytes:17179869184,
 maintenanceRequiredBytes:17179869184 })
const tileOrderLimits = {tileSourceIndex:[0,255],tileOrderIndex:[0,255],tileColumnNextIndex:[-1,255],
 tileColumnReordered:[0,1],tileColumnDeltaY:[-1e7,1e7],filterColumnPlans:[0,256],filterColumnReorders:[0,256]}
const events = new Set(['cpu-stage','gpu-retirement','gpu-submit','handoff-trace','pose-lifecycle','canvas-action','grid-state','frame-window','operation','request','result','tile','camera-request','camera-submit','compile','hydrate','queue-start','queue-end','cancel','stale-drop','error','gpu-exit','renderer-exit','cache','summary','start','filter','prefix','fence','camera-input','queue-enqueue','compile-start','hydrate-start','prepare-wait','viewport-state','skip','cache-invalidate','preparation','load-stage','failure-summary','device-lifecycle','runtime-config','failure-origin'])
const failureLimits = {failureMaterialFieldBuilds:1e9,failureMaterialFieldUploadBytes:1e12,failureImageAxisFields:1e9,failureImageFieldBytes:1e12,failureOriginCode:7,failureBuildKind:9,failureBoundaryStage:13,failureThrownKind:10,lastFailureBoundaryStage:13,lastFailureThrownKind:10,lastFailureClassCode:7,diagnosticProducerVersion:1,failureDictionaryVersion:2,failureBudgetAvailable:1,failureRequestedBytes:17179869184,failureWorkingBytes:17179869184,failureBudgetBytes:17179869184,failureAllocationWidth:1e9,failureAllocationHeight:1e9,failureCoherent:1,failureCategory:6,lastFailureCategory:6,failureStage:13,lastFailureStage:13,
 failureCode:255,lastFailureCode:255,errorClassCode:7,rendererCode:3,compileAttempts:65535,hydrateAttempts:65535,graphAttempts:65535,fallbackAttempts:65535,failureAttempts:65535}
const qualityLimits = {qualitySequence: 0xffffffff, qualityRevision: 0xffffffff, documentRevision: 0xffffffff}
const poseLifecycleLimits = {poseEpoch:1e9,poseSampleKind:3,posePendingCapped:1,poseStage:8,poseReason:13,poseSequence:1000000000.0,poseGesture:1000000000.0,poseDocumentGeneration:1000000000.0,poseActive:1,poseReady:1,poseDeferred:1,poseSubmittedCount:1000000000.0,poseSampledCount:1000000000.0,poseAckCount:1000000000.0,poseAcceptedCount:1000000000.0,poseRejectedCount:1000000000.0,poseEvictedCount:1000000000.0,posePendingCount:180,poseOldestAgeMs:600000}
const handoffLimits = {handoffOwner:1e9,handoffSequence:1e9,handoffDecision:8,handoffReason:8,handoffDropped:1e9,handoffRingDropped:1e9,handoffSourceOrder:1e9,handoffFloor:1e9,handoffSampleOrder:1e9,handoffSampleKnown:1,handoffOwnerKind:2,handoffPreviousOwnerKind:2,handoffGesture:4,handoffActive:1}
const diagnosticLimits = {cpuSpanId:1e9,cpuParentSpanId:1e9,cpuStageCode:37,cpuPhase:2,cpuSkipped:1e9,cpuDurationCapped:1,cpuOutcome:1,...handoffLimits,...poseLifecycleLimits,originChannelId: 0xffffffffffff, backendCode: 2, boundaryCode: 16, boundaryDurationMs: 120000}
const resourceLimits = {importBytes:2**32,importFormat:11,importMode:2,poseSubmittedSequence:1e9,posePresentedSequence:1e9,poseFallbackReason:9,poseLatencyMs:600000,actionRingDropped:1e9,actionPendingEvicted:1e9,submitIntervalCount:1e9,constraintEnabled:1,inputPhase:9,fieldFamily:11,inputValid:1,expectedWidthComparison:3,expectedHeightComparison:3,aspectRatioComparison:3,layoutConstraintAccepted:1,proposalResolvedComparison:3,actionOwner:1000000000000.0,actionId:1000000000.0,actionCode:73,actionSource:7,actionSession:1000000000.0,actionStartRevision:1000000000.0,actionFinalRevision:1000000000.0,actionPhase:2,actionOutcome:7,actionReason:17,modifiers:15,toolCode:64,hitCount:1000000.0,hitDepth:1000000.0,selectionBefore:1000000.0,selectionAfter:1000000.0,lockedCount:1000000.0,commandCode:1024,inputSamples:1000000000.0,sampleUpdates:1000000000.0,coalescedSamples:1000000000.0,thresholdPassed:1,motionObserved:1,snapEnabled:1,snapChanged:1,constraintChanged:1,proposalChanged:1,resolvedChanged:1,committedChanged:1,intentResolvedComparison:3,resolvedCommittedComparison:3,selectionChanged:1,routeSupported:1,geometrySupported:1,operationOwner:1e12,operationPresentation:1,operationId:1e9,operationSession:1e9,operationPhase:4,operationCategory:6,operationOutcome:5,authoredRevision:1e9,startRevision:1e9,targetCount:1e9,previewAttempts:1e9,previewAccepted:1e9,fullPayloadBytes:32*1024*1024,derivationReasonCode:4,sourceCodeUnits:32*1024*1024,embeddedFontCount:32,embeddedFontCodeUnits:32*28*1024*1024}
// Reclaim-kind bits: pool=1, uploads=2, coordinates=4, images=8, retired image tables=16.
const surfaceCacheLimits = {surfaceProposedBytes:17179869184,surfaceBudgetBytes:536870912,surfaceSteadyBudgetBytes:536870912,
 surfaceTotalBudgetBytes:536870912,surfaceReserveBytes:536870912,surfaceHeldCount:4096,surfaceUsedCount:4096,
 surfacePinnedCount:4096,surfaceIncomingBytes:17179869184,surfaceRejected:1,surfaceTotalBytes:536870912,surfaceHighWaterBytes:536870912}
const admissionLimits = {...surfaceCacheLimits,admissionRetiredKinds:31,admissionRetiredUploadCount:1000000,admissionCoordinateCount:1000000,admissionKind: 1, admissionPressure: 1, admissionRequiredBytes: 17179869184, admissionWorkingBytes: 17179869184, admissionBudgetBytes: 17179869184, admissionReclaimableBytes: 17179869184, admissionPoolBytes: 17179869184, admissionPoolCount: 1000000, admissionUploadCount: 1000000, admissionImageCount: 1000000}
const scalarLimits = {cpuDurationMs:120000,cpuWaitMs:120000,bridgeBoundaryAt:1e15,bridgeDeliveryMs:120000,softwareRateValid:1,submitSpanCapped:1,windowCapped:1,uiIntervalCapped:1,submitIntervalCapped:1,inputPresentCapped:1,pendingInputAgeCapped:1,submitSampleSpanMs:120000,"uncorrelatedSubmits":1000000000,"pendingInputAgeMs":120000,"actionDurationMs": 1000000000.0, "windowMs": 120000, "uiFrames": 1000000000.0, "uiFps": 1000000000.0, "uiIntervalP95Ms": 120000, "uiIntervalMaxMs": 120000, "uiLongFrames": 1000000000.0, "uiStalls": 1000000000.0, "softwareSubmits": 1000000000.0, "softwareSubmitHz": 1000000000.0, "submitIntervalP95Ms": 120000, "submitIntervalMaxMs": 120000, "inputPresentCount": 1000000000.0, "inputPresentP95Ms": 120000, "inputPresentMaxMs": 120000, "staleCameraSubmits": 1000000000.0, "outOfOrderSubmits": 1000000000.0, "transformMismatch": 1000000000.0, "phaseChanges": 1000000000.0, "sameCameraSubmits": 1000000000.0, "changedCameraSubmits": 1000000000.0, "windowResetReason": 3, "gridKind": 5, "gridVisible": 1, "gridSpacingClass": 3, "gridPhaseMatch": 1, "gridAlignmentMatch": 1, "gridRedrawReason": 3, "gridStale": 1, "gridCount": 1000000000.0}
const deviceLimits = {deviceSubmitTraceSkipped:4294967295,deviceFenceTraceSkipped:4294967295,deviceRetirementTraceSkipped:4294967295,deviceFenceGeometryReason:7,deviceSubmitTableCount:1e6,deviceSubmitTableWidthMax:1e9,deviceSubmitTableHeightMax:1e9,
 deviceRetirementPhase:3,deviceRetirementTableCount:1e6,deviceRetirementReleasedBytes:17179869184,deviceSubmitSequence:4294967295,deviceCompletedSubmitSequence:4294967295,
 deviceFenceId:4294967295,deviceFenceSubmitFirst:4294967295,deviceFenceSubmitLast:4294967295,
 deviceFenceAsync:1,deviceFencePhase:2,deviceFenceOutcome:3,deviceGpuTimingEnabled:1,
 deviceRetirementBatchCount:3,deviceRetiringScratchBytes:17179869184,deviceRetiringSourceBytes:17179869184,"deviceWorkerScope":281474976710655,"deviceIncarnation":4294967295,"deviceCurrentIncarnation":4294967295,"deviceOwner":4294967295,"deviceScope":2,"devicePhase":14,"deviceLostReason":2,"deviceCallbackDisposition":4,"deviceRecoveryId":4294967295,"deviceRecoveryKind":4,"devicePreviousIncarnation":4294967295,"deviceCounterMask":15,"devicePendingCaptures":1000000,"devicePendingReadbacks":1000000,"devicePendingCapturePayloadBytes":17179869184,"deviceLogicalPayloadBytes":17179869184,"deviceRetiringPayloadBytes":17179869184,"deviceFenceResourceEpoch":4294967295,"deviceFenceCompletedResourceEpoch":4294967295}
const fields = new Set(('importBytes importFormat importMode poseSubmittedSequence posePresentedSequence poseFallbackReason poseLatencyMs actionRingDropped actionPendingEvicted softwareRateValid submitSpanCapped windowCapped uiIntervalCapped submitIntervalCapped inputPresentCapped pendingInputAgeCapped submitIntervalCount submitSampleSpanMs constraintEnabled uncorrelatedSubmits pendingInputAgeMs inputPhase fieldFamily inputValid expectedWidthComparison expectedHeightComparison aspectRatioComparison layoutConstraintAccepted proposalResolvedComparison actionOwner actionId actionCode actionSource actionSession actionStartRevision actionFinalRevision actionPhase actionOutcome actionReason modifiers toolCode hitCount hitDepth selectionBefore selectionAfter lockedCount commandCode inputSamples sampleUpdates coalescedSamples thresholdPassed motionObserved snapEnabled snapChanged constraintChanged proposalChanged resolvedChanged committedChanged intentResolvedComparison resolvedCommittedComparison selectionChanged routeSupported geometrySupported actionDurationMs windowMs uiFrames uiFps uiIntervalP95Ms uiIntervalMaxMs uiLongFrames uiStalls softwareSubmits softwareSubmitHz submitIntervalP95Ms submitIntervalMaxMs inputPresentCount inputPresentP95Ms inputPresentMaxMs staleCameraSubmits outOfOrderSubmits transformMismatch phaseChanges sameCameraSubmits changedCameraSubmits windowResetReason gridKind gridVisible gridSpacingClass gridPhaseMatch gridAlignmentMatch gridRedrawReason gridStale gridCount failureCategory lastFailureCategory failureStage lastFailureStage failureCode lastFailureCode errorClassCode rendererCode compileAttempts hydrateAttempts graphAttempts fallbackAttempts failureAttempts failureCountsCapped recovered admissionKind admissionPressure admissionRequiredBytes admissionWorkingBytes admissionBudgetBytes admissionReclaimableBytes admissionPoolBytes admissionPoolCount admissionUploadCount admissionImageCount retainNativePanPhase cameraDependent samplingMode dpr qualitySequence qualityRevision documentRevision qualityTerminal operationOwner operationPresentation operationId operationSession operationPhase operationCategory operationOutcome authoredRevision startRevision targetCount previewAttempts previewAccepted originChannelId backendCode boundaryCode boundaryDurationMs derivationAdmitted derivationFallback fullPayloadBytes derivationReasonCode sourceCodeUnits embeddedFontCount embeddedFontCodeUnits preparationId methodCode activePreparationId documentFork documentEnvelope retainInteractionGraph interactionNative interactionOwner interactionGeneration interactionBranch purpose commandCode renderIntent preview finalRequest readback png coverageTiles livePreview tileViewport requestId sequence x y zoom width height milliseconds compileMs graphMs finishMs checkpointMs loadMs renderMs pipelineWallMs preparationWaitMs previewTiles tileCacheHits certifiedTileHits tileCacheBytes tileCacheEvictions drawCalls triangles peakTextureBytes workingTextureBytes missingTextureCount compositorFrames compositorTiles compositorDraws durationMs waitMs count sampleCount suppressed cached cameraFallback reasonCode exitCode quitRequested permitClose resourceEpoch completedResourceEpoch radius mode ms oldConfig newConfig channel acceptedLines declinedLines acceptedPixels narrowLines availableBytes scratchBytes mapMs queueWaitMs coverage sharpCoverage nativePhaseCoverage maxUpscale pixelCoverageComplete nativeCoverageComplete inputSequence inputAt inputTimeOrigin inputAgeMs deltaX deltaY deltaMode inputKind generation fillGeneration pageToken state phase navigating targetDensity effectiveDensity finalComplete oldContentAgeMs queueDepth activeRequestId superseded skipped coverageMeasured coverageAt dropped phaseX phaseY sceneReady tileIndex').split(' '))
Object.assign(tileCostLimits, {imageXTablePrograms:4e6,imageXTableDuplicateBytesSaved:17179869184,
 backdropRegionBuilds:1e9,backdropRegionSourcePixels:1e12,backdropRegionResultPixels:1e12,
 displayTentRadiusPasses:1e9,displayTentRadiusPixels:1e12})
for (const key of [...Object.keys(tileCostLimits), ...Object.keys(admissionLimits)]) fields.add(key)
for (const key of Object.keys(failureLimits)) fields.add(key)
for (const key of [...Object.keys(poseLifecycleLimits),...Object.keys(handoffLimits)]) fields.add(key)
for (const key of Object.keys(deviceLimits)) fields.add(key)
for (const key of ['cpuSpanId','cpuParentSpanId','cpuStageCode','cpuPhase','cpuSkipped','cpuDurationCapped','cpuOutcome','cpuDurationMs','cpuWaitMs','bridgeBoundaryAt','bridgeDeliveryMs']) fields.add(key)
for (const key of Object.keys(tileOrderLimits)) fields.add(key)
const imageFieldRegionLimits = {imageFieldCallsite:7,imageFieldStage:5,imageFieldOutcome:3,imageFieldAxes:2,imageFieldSample:4,imageFieldLevel:32,
 imageFieldWidth:1e9,imageFieldHeight:1e9,imageFieldSourceWidth:1e9,imageFieldSourceHeight:1e9,imageFieldDenseBytes:1e16,
imageFieldRegionPath:2,imageFieldRegionOutcome:2,imageFieldRegionCount:1e9,
 imageFieldRegionBytes:1e12,imageFieldRegionMaxBytes:67108864,imageFieldRegionMaxWidth:16384,imageFieldRegionMaxHeight:256,imageFieldRegionSample:4}
for (const key of Object.keys(imageFieldRegionLimits)) fields.add(key)
export function sanitizeFields(value) {
  const out = {}
  if (!value || typeof value !== 'object') return out
  for (const key of fields) {
    const v = value[key]
    // Most records contain only a handful of the shared scalar fields. An
    // absent value cannot pass any validator; avoid probing every limit map.
    if (v === undefined) continue
    if (Object.hasOwn(imageFieldRegionLimits,key)) {
      if (Number.isSafeInteger(v) && v >= 0 && v <= imageFieldRegionLimits[key]) out[key] = v
      continue
    }
    if (Object.hasOwn(tileOrderLimits,key)) {
      const [minimum,maximum]=tileOrderLimits[key]
      if (Number.isSafeInteger(v) && v>=minimum && v<=maximum) out[key]=v
      continue
    }
    if (key === 'tileCacheDecision') { if ([0,3,4,5].includes(v)) out[key]=v; continue }
    if (Object.hasOwn(tileCostLimits,key)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= tileCostLimits[key] && (['supportRectExpansionMax','fieldBuildElapsedMs','graphNonCheckpointElapsedMs'].includes(key) || Number.isSafeInteger(v))) out[key]=v
      continue
    }
    if (Object.hasOwn(deviceLimits,key)) { if (Number.isSafeInteger(v) && v >= 0 && v <= deviceLimits[key]) out[key]=v; continue }
    if (Object.hasOwn(admissionLimits,key)) {
      if (Number.isSafeInteger(v) && v >= 0 && v <= admissionLimits[key]) out[key]=v
      continue
    }
    if (Object.hasOwn(failureLimits,key)) { if (Number.isSafeInteger(v) && v>=0 && v<=failureLimits[key]) out[key]=v; continue }
    if (key === 'recovered' || key === 'failureCountsCapped') { if (typeof v === 'boolean' || v===0 || v===1) out[key]=Number(v); continue }
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
    if (Object.hasOwn(scalarLimits,key)) {
      if (typeof v==='number' && Number.isFinite(v) && v>=0 && v<=scalarLimits[key]) out[key]=v
      else if (typeof v==='boolean' && scalarLimits[key]===1) out[key]=v?1:0
      continue
    }
    if (Object.hasOwn(resourceLimits,key)) {
      if (Number.isSafeInteger(v) && v>=((key==='operationId'||key==='operationPhase'||key==='actionId'||key==='actionPhase')?1:0) && v<=resourceLimits[key]) out[key]=v
      continue
    }
    if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e15) out[key] = v
    else if (typeof v === 'boolean') out[key] = v ? 1 : 0
  }
  return { ...out, ...sanitizeRuntimeConfiguration(value), ...sanitizeFailureAllocation(value) }
}
export function sanitizeRecord(value) {
  if (!value || value.v !== 1 || !events.has(value.event) || !['main','worker','host'].includes(value.source)) return null
  if (!['session','seq','at'].every(k => Number.isFinite(value[k]) && value[k] >= 0 && value[k] <= 1e15)) return null
  return {v:1, session:value.session, source:value.source, seq:value.seq, at:value.at, event:value.event, ...sanitizeFields(value), ...sanitizeProducerIdentity(value)}
}
export function createRenderDiagnostics({enabled=false, detail=false, session=0, source='main', sink=()=>{}, batchSink,  now=()=>Date.now(), schedule=setTimeout, cancel=clearTimeout}={}) {
  let seq=0, timer, emitted=0, suppressed=0
  const aggregates=new Map()
  const provenance = event => seq === 0 || ['error','failure-summary','start','summary'].includes(event) ? producerIdentityFields() : {}
  const ring=[]; let dropped=0
  function output(event, values) { const identity=provenance(event); const record=sanitizeRecord({v:1,session,source,seq:++seq,at:now(),event,...sanitizeFields(values),...identity}); if(record) {try{sink(record)}catch{}} }
  function flush() {
    timer=undefined
    if(detail) {
      if(dropped) ring.push(sanitizeRecord({v:1,session,source,seq:++seq,at:now(),event:'summary',dropped,...producerIdentityFields()}))
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
        const identity=provenance(event)
        const row=sanitizeRecord({v:1,session,source,seq:++seq,at:now(),event,...sanitizeFields(values),...identity})
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
let gpuSinkEpoch=0
export function setGpuDiagnosticSink(sink) { gpuSink=sink; gpuSinkEpoch=gpuSinkEpoch>=Number.MAX_SAFE_INTEGER?1:gpuSinkEpoch+1 }
export function gpuDiagnosticEpoch() { return gpuSinkEpoch }
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
