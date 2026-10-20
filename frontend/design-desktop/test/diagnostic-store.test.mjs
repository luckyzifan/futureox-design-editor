import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {createDiagnosticStore, browserDiagnosticAdapter, installDiagnosticHooks, DIAGNOSTIC_LIMIT, DIAGNOSTIC_BYTES, classifyDiagnostic, parseDiagnostics} from '../src/diagnostic-store.mjs'
import {diagnosticFileAdapter} from '../src/diagnostic-file.mjs'
const opts = {random:()=>new Uint32Array([1,2]), delay:60000}

test('CPU: real local file survives store recreation and exports only approved schema', async t => {
 const dir=await mkdtemp(path.join(tmpdir(),'design-diagnostics-')); t.after(()=>rm(dir,{recursive:true,force:true}))
 const adapter=diagnosticFileAdapter(dir), store=createDiagnosticStore({...opts,adapter}); await store.ready
 const id=store.record({component:'import',code:'INVALID_DATA',message:'secret document',stack:'/home/private',token:'abc',requestId:'private-token'})
 await store.flush(); const again=createDiagnosticStore({...opts,adapter}); await again.ready
 assert.equal(again.snapshot().records[0].requestId,id); assert.equal(again.snapshot().records[0].code,'INVALID_DATA')
 const exported=again.exportJSON(); assert.ok(!exported.includes('secret'));assert.ok(!exported.includes('private'));assert.ok(!exported.includes('token'))
 assert.equal(JSON.parse(await readFile(path.join(dir,'local-errors-v1.json'),'utf8')).records.length,1)
})
test('mock browser storage: reload, storm retention, bounded serialized bytes', async()=>{
 const values=new Map();let writes=0
 const adapter=browserDiagnosticAdapter(()=>({getItem:key=>values.get(key)??null,setItem:(key,value)=>{writes++;values.set(key,value)}}))
 const store=createDiagnosticStore({...opts,adapter});await store.ready
 for(let i=0;i<2000;i++)store.record({component:'workspace',code:'STORAGE_ERROR'})
 await store.flush();assert.equal(writes,1);assert.equal(store.snapshot().records.length,DIAGNOSTIC_LIMIT);assert.equal(store.snapshot().dropped,1744)
 assert.ok([...values.values()][0].length<DIAGNOSTIC_BYTES)
 const reload=createDiagnosticStore({...opts,adapter});await reload.ready;assert.equal(reload.snapshot().dropped,1744)
 assert.equal(JSON.parse(reload.exportJSON()).records.length,256)
})
test('CPU: corrupt and oversized storage stays usable; invalid schema is rejected',async()=>{
 for(const raw of ['not json','{"schema":2,"records":[]}', 'x'.repeat(DIAGNOSTIC_BYTES+1)]){
  let saved
  const store=createDiagnosticStore({...opts,adapter:{read:()=>raw,write:value=>{saved=value}}});await store.ready
  assert.equal(store.snapshot().status,'session-only');store.record({code:'TIMEOUT'});await store.flush();assert.equal(parseDiagnostics(saved).records[0].code,'TIMEOUT')
 }
 assert.throws(()=>parseDiagnostics(JSON.stringify({schema:1,records:Array(257).fill({})})))
})
test('CPU: disk read is bounded and validates again at write boundary',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'design-diagnostics-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const adapter=diagnosticFileAdapter(dir)
 await writeFile(path.join(dir,'local-errors-v1.json'),'x'.repeat(DIAGNOSTIC_BYTES+1));await assert.rejects(adapter.read())
 await assert.rejects(adapter.write('broken'))
 await adapter.write(JSON.stringify({schema:1,records:[{code:'TIMEOUT',component:'/private/path',message:'secret',requestId:'secret'}]}))
 const text=await adapter.read();assert.ok(!text.includes('private'));assert.ok(!text.includes('secret'))
})
test('CPU: denied storage causes no retries or recursive error records',async()=>{
 let writes=0
 const store=createDiagnosticStore({...opts,delay:1,adapter:{read:()=>{throw Error('denied')},write:()=>{writes++;throw Error('quota')}}})
 await store.ready;store.record({code:'STORAGE_ERROR'});await store.flush();await new Promise(r=>setTimeout(r,15))
 assert.equal(writes,1);assert.equal(store.snapshot().records.length,1);assert.equal(store.snapshot().status,'session-only')
})
test('CPU: slow writer uses one in-flight snapshot and coalesces burst',async()=>{
 let release, writes=0,active=0,max=0
 const adapter={read:()=>null,write:async()=>{writes++;active++;max=Math.max(max,active);await new Promise(r=>{release=r});active--}}
 const store=createDiagnosticStore({...opts,adapter});await store.ready;store.record({code:'TIMEOUT'})
 const first=store.flush();await new Promise(r=>setImmediate(r))
 for(let i=0;i<1000;i++)store.record({code:'TIMEOUT'})
 assert.equal(writes,1);release();await first
 const second=store.flush();await new Promise(r=>setImmediate(r));release();await second
 assert.equal(writes,2);assert.equal(max,1);assert.equal(store.snapshot().records.length,256)
})
test('mock browser events: uncaught/rejection capture and pagehide flush; cleanup removes hooks',async()=>{
 const target=new EventTarget();let raw
 const store=createDiagnosticStore({...opts,adapter:{read:()=>null,write:value=>{raw=value}}});await store.ready
 const remove=installDiagnosticHooks(target,store)
 const error=new Event('error');error.error={name:'QuotaExceededError',message:'secret'};target.dispatchEvent(error)
 const rejection=new Event('unhandledrejection');rejection.reason='token-secret';target.dispatchEvent(rejection)
 target.dispatchEvent(new Event('pagehide'));await store.flush()
 assert.deepEqual(JSON.parse(raw).records.map(x=>x.code),['QUOTA_EXCEEDED','UNHANDLED_REJECTION'])
 remove();target.dispatchEvent(new Event('error'));assert.equal(store.snapshot().records.length,2)
 assert.equal(classifyDiagnostic({name:'SecurityError'}),'PERMISSION_DENIED')
})
test('CPU: errors during initial read merge with prior records, hostile error getters cannot recurse', async()=>{
 let load, raw
 const store=createDiagnosticStore({...opts,adapter:{read:()=>new Promise(resolve=>{load=resolve}),write:value=>{raw=value}}})
 await new Promise(resolve=>setImmediate(resolve))
 store.record({component:'runtime',code:'UNCAUGHT_ERROR'})
 load(JSON.stringify({schema:1,dropped:4,records:[{time:1,component:'import',code:'INVALID_DATA'}]}))
 await store.ready;await store.flush()
 assert.deepEqual(JSON.parse(raw).records.map(row=>row.code),['INVALID_DATA','UNCAUGHT_ERROR'])
 assert.equal(store.snapshot().dropped,4)
 assert.equal(classifyDiagnostic(new Proxy({}, {get(){throw Error('hostile')}})),'OPERATION_FAILED')
 assert.equal(classifyDiagnostic({name:'__proto__'}),'OPERATION_FAILED')
})
