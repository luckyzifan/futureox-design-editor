import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MessageChannel } from 'node:worker_threads'
import {createRenderDiagnostics,sanitizeRecord,sanitizeFields,PREFIX,setGpuDiagnosticSink,recordGpuDiagnostic} from '../src/render-terminal-diagnostics.mjs'
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
  assert(main.includes("!app.isPackaged && process.env.CORE_RENDER_DIAGNOSTICS === '1'"))
  assert(main.includes('sanitizeRecord(JSON.parse(message.slice(PREFIX.length)))'))
  assert(client.includes("if (this.terminalDiagnostics.enabled) worker.postMessage({command:'terminal-diagnostics'"))
  assert(client.includes('record.session === this.diagnosticSession'))
  assert(worker.includes('sink:record=>self.postMessage({renderDiagnostic:record})'))
})
