import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MessageChannel } from 'node:worker_threads'
import {createRenderDiagnostics,renderRequestCategories,renderResultReason,sanitizeRecord,sanitizeFields,snapshotResourceFields,PREFIX,setGpuDiagnosticSink,recordGpuDiagnostic} from '../src/render-terminal-diagnostics.mjs'
test('schema rejects arbitrary content, nonfinite numbers and forged enums',()=>{
  const secret={text:'private document',path:'/private/file',url:'https://secret',stack:'credential',images:['image'],requestId:4,zoom:NaN,width:Infinity,cached:true}
  assert.deepEqual(sanitizeFields(secret),{requestId:4,cached:1})
  assert.equal(sanitizeRecord({...secret,v:1,event:'private',source:'worker',session:1,seq:1,at:1}),null)
  const result=sanitizeRecord({...secret,v:1,event:'tile',source:'worker',session:1,seq:1,at:1})
  assert.deepEqual(result,{v:1,session:1,source:'worker',seq:1,at:1,event:'tile',requestId:4,cached:1})
})
test('disabled path never reads clocks, schedules, serializes payloads, or emits',()=>{
  const fail=()=>{throw Error('disabled side effect')}
  const d=createRenderDiagnostics({sink:fail,now:fail,schedule:fail})
  d.record('request',new Proxy({},{get:fail}));d.close()
})
test('storm is bounded and latest samples plus suppressed counts are retained',()=>{
  const rows=[];let flush;let timers=0
  const d=createRenderDiagnostics({enabled:true,session:1,sink:r=>rows.push(r),now:()=>10,schedule:f=>{flush=f;timers++;return 1},cancel:()=>{}})
  for(let n=0;n<10000;n++)d.record('camera-request',{sequence:n,x:n,text:'never emit'})
  assert.equal(rows.length,8);assert.equal(timers,1)
  flush();assert.equal(rows.length,10);assert.equal(rows[8].suppressed,9992)
  assert.equal(rows[9].sequence,9999);assert.equal(rows[9].sampleCount,9992)
  assert(!JSON.stringify(rows).includes('never emit'));d.close()
})
test('worker structured clone → renderer validation → terminal validation keeps correlation',async()=>{
  const {port1,port2}=new MessageChannel()
  const received=new Promise(resolve=>port2.once('message',data=>{
    const renderer=sanitizeRecord(data.renderDiagnostic)
    const line=PREFIX+JSON.stringify(renderer)
    resolve(sanitizeRecord(JSON.parse(line.slice(PREFIX.length))))
  }))
  const d=createRenderDiagnostics({enabled:true,source:'worker',session:42,sink:r=>port1.postMessage({renderDiagnostic:r}),now:()=>123})
  setGpuDiagnosticSink((event,fields)=>d.record(event,fields))
  recordGpuDiagnostic('fence',{requestId:7,sequence:9,queueWaitMs:12,reasonCode:3,secret:'hidden'})
  const row=await received;assert.equal(row.session,42);assert.equal(row.requestId,7);assert.equal(row.source,'worker');assert.equal(row.at,123);assert(!('secret'in row))
  setGpuDiagnosticSink(undefined);d.close();port1.close();port2.close()
})
test('Electron activation and worker relay are explicitly gated; no added GPU wait',()=>{
  const main=readFileSync(new URL('../src/main.mjs',import.meta.url),'utf8')
  const client=readFileSync(new URL('../../design-client/src/kernel/client.ts',import.meta.url),'utf8')
  const worker=readFileSync(new URL('../../design-client/src/kernel/render-worker.ts',import.meta.url),'utf8')
  assert(main.includes("!app.isPackaged && ['1','detail'].includes(process.env.CORE_RENDER_DIAGNOSTICS)"))
  assert(main.includes('sanitizeBatch(value.batch)'))
  assert(client.includes("if (this.terminalDiagnostics.enabled) worker.postMessage({command:'terminal-diagnostics'"))
  assert(client.includes('record.session === this.diagnosticSession'))
  assert(worker.includes('sink:record=>self.postMessage({renderDiagnostic:record})'))
})

test('detail retains event timestamps and request lifecycle in batched bounded ring',()=>{
  const batches=[];let flush;let time=10
  const d=createRenderDiagnostics({enabled:true,detail:true,session:2,source:'worker',now:()=>time++,batchSink:b=>batches.push(b),schedule:f=>{flush=f;return 1},cancel:()=>{}})
  for(const event of ['queue-enqueue','queue-start','compile-start','compile','prepare-wait','queue-end'])d.record(event,{requestId:9})
  assert.equal(batches.length,0);flush()
  assert.deepEqual(batches[0].map(r=>r.event),['queue-enqueue','queue-start','compile-start','compile','prepare-wait','queue-end'])
  assert.deepEqual(batches[0].map(r=>r.at),[10,11,12,13,14,15])
  batches.length=0
  for(let i=0;i<2000;i++)d.record('camera-input',{inputSequence:i,path:'secret'})
  flush();const rows=batches.flat();assert.equal(rows.length,513);assert(batches.every(b=>b.length<=64))
  assert.equal(rows.at(-1).dropped,1488);assert.equal(rows[0].inputSequence,1488)
  assert(!JSON.stringify(rows).includes('secret'));d.close()
})
test('detail enables bounded production coverage measurement without enabling GPU profiling',()=>{
  const presenter=readFileSync(new URL('../../design-client/src/kernel/gpu/resident-presenter.ts',import.meta.url),'utf8')
  assert(presenter.includes('gpuDiagnosticsDetail() && coverageAt-this.diagnosticCoverageAt>=250'))
  assert(presenter.includes('coverageMeasured:measureCoverage'))
  assert(presenter.includes('measureCoverage ? physicalCoverage'))
})

test('request purpose is scalar and separates transient, settled, coverage and readback work',()=>{
  const transient=renderRequestCategories({options:{renderIntent:'preview',livePreview:true,pageId:'secret'},channel:'interaction',document:'secret'})
  assert.equal(transient.purpose,1);assert.equal(transient.channel,1);assert.equal(transient.preview,true);assert.equal(transient.finalRequest,false)
  const settled=renderRequestCategories({options:{renderIntent:'settled',tileViewport:[],coverageTiles:true},readback:true})
  assert.equal(settled.purpose,2);assert.equal(settled.finalRequest,true);assert.equal(settled.tileViewport,true);assert.equal(settled.coverageTiles,true);assert.equal(settled.readback,true)
  assert.equal(renderRequestCategories({options:{},png:true}).purpose,4)
  assert.equal(renderRequestCategories({command:'gpu-memory'}).commandCode,5)
  assert.equal(renderRequestCategories({command:'untrusted-label'}).commandCode,0)
  assert.equal(renderRequestCategories({command:'gpu-memory'}).channel,2)
  assert(!JSON.stringify(transient).includes('secret'))
  assert.equal(sanitizeFields(transient).purpose,1)
})
test('only exact cancellation sentinel is intentional cancellation',()=>{
  assert.equal(renderResultReason('PREVIEW_CANCELLED'),5)
  assert.equal(renderResultReason('GPU lost'),1)
  assert.equal(renderResultReason('error PREVIEW_CANCELLED elsewhere'),1)
  assert.equal(renderResultReason(undefined),0)
})

test('capture and physical preparation detail remains numeric and excludes authored content',()=>{
  const fields=renderRequestCategories({document:'private',options:{renderIntent:'preview',livePreview:true,
    retainInteractionGraph:true,interactionNative:true,interactionOwner:2,interactionGeneration:3,interactionBranch:1}})
  assert.equal(fields.documentEnvelope,1);assert.equal(fields.retainInteractionGraph,true)
  assert.equal(fields.interactionNative,true);assert.equal(fields.interactionOwner,2);assert.equal(fields.interactionGeneration,3)
  const row=sanitizeRecord({v:1,session:1,seq:1,at:1,source:'worker',event:'preparation',requestId:9,
    preparationId:10,methodCode:3,activePreparationId:10,phase:4,durationMs:20,documentFork:true,document:'secret'})
  assert.equal(row.methodCode,3);assert.equal(row.documentFork,1);assert(!('document'in row))
  assert.equal(sanitizeRecord({...row,event:'load-stage',phase:2}).phase,2)
})

test('DETAIL resource context is bounded numeric metadata, never resource content',()=>{
  assert.deepEqual(snapshotResourceFields(123,undefined),{sourceCodeUnits:123,embeddedFontCount:0,embeddedFontCodeUnits:0})
  assert.deepEqual(snapshotResourceFields(123,{privateFontName:{data:'private-payload'}}),{sourceCodeUnits:123,embeddedFontCount:1,embeddedFontCodeUnits:15})
  assert.deepEqual(sanitizeFields({sourceCodeUnits:-1,embeddedFontCount:33,embeddedFontCodeUnits:Infinity}),{})
  assert.deepEqual(sanitizeFields({sourceCodeUnits:32*1024*1024+1,embeddedFontCount:1.5,embeddedFontCodeUnits:true}),{})
  assert.deepEqual(snapshotResourceFields(123,Object.fromEntries(Array.from({length:33},(_,i)=>[i,{data:''}]))),{sourceCodeUnits:123})
  assert.deepEqual(snapshotResourceFields(123,{a:{data:null}}),{sourceCodeUnits:123})
  const worker=readFileSync(new URL('../../design-client/src/kernel/render-worker.ts',import.meta.url),'utf8')
  assert(worker.includes('terminalDiagnostics.detail\n          ? snapshotResourceFields(request.document.length, laneState.interactionDocument.fonts) : {}'))
})

 test('derivation telemetry admits bounded counts and categories without receipts or authored data',()=>{
  assert.deepEqual(sanitizeFields({derivationAdmitted:true,fullPayloadBytes:0,derivationFallback:false,derivationReasonCode:2,baseReceipt:'secret',document:'private'}),
   {derivationAdmitted:1,derivationFallback:0,fullPayloadBytes:0,derivationReasonCode:2})
  for(const bad of [-1,0.5,Infinity,'0',null,undefined])
   assert.deepEqual(sanitizeFields({fullPayloadBytes:bad,derivationReasonCode:bad}),{})
  assert.deepEqual(sanitizeFields({derivationAdmitted:2,derivationFallback:'true',fullPayloadBytes:32*1024*1024+1,derivationReasonCode:5}),{})
 })

test('pan eligibility is bounded numeric metadata, never document/profile content', () => {
  assert.deepEqual(sanitizeFields({ retainNativePanPhase: true, cameraDependent: false, samplingMode: 1,
    qualityRevision: 5, pageToken: 2, dpr: 2, document: { private: true }, profile: 'private content' }),
    { retainNativePanPhase: 1, cameraDependent: 0, samplingMode: 1, dpr: 2, qualityRevision: 5, pageToken: 2 })
  assert.deepEqual(sanitizeFields({ retainNativePanPhase: 0, cameraDependent: 1, samplingMode: 2 }),
    { retainNativePanPhase: 0, cameraDependent: 1, samplingMode: 2 })
})
test('pan eligibility rejects out-of-range numbers, strings, objects and nonfinite values', () => {
  for (const value of [-1, 2, .5, Infinity, NaN, 'true', {}, null])
    assert.deepEqual(sanitizeFields({ retainNativePanPhase: value, cameraDependent: value }), {})
  for (const value of [0, -1, 3, 1.5, Infinity, NaN, 'native', true, {}, null])
    assert.deepEqual(sanitizeFields({ samplingMode: value }), {})
})
test('existing viewport-state detail stream carries eligibility without another event', () => {
  const rows = [], scheduled = []
  const recorder = createRenderDiagnostics({ enabled: true, detail: true, session: 1, source: 'main',
    now: () => 10, schedule: fn => { scheduled.push(fn); return 1 }, cancel: () => {}, sink: row => rows.push(row) })
  recorder.record('viewport-state', { retainNativePanPhase: true, cameraDependent: false, samplingMode: 1 })
  assert.equal(scheduled.length, 1)
  recorder.flush()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].event, 'viewport-state')
  assert.equal(rows[0].retainNativePanPhase, 1)
})
