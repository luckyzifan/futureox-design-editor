import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MessageChannel } from 'node:worker_threads'
import {createRenderDiagnostics,renderRequestCategories,renderResultReason,sanitizeRecord,sanitizeFields,PREFIX,setGpuDiagnosticSink,recordGpuDiagnostic} from '../src/render-terminal-diagnostics.mjs'
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
