import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { NativePreparation, PreparationAdmission, registerNativePreparation, bindPosePreparationPort } from '../src/preparation.mjs'
import { DOCUMENT_BYTE_LIMIT } from '../src/document-capacity.mjs'

test('host admits the shared interaction pose query without admitting unknown methods or private snapshots', async () => {
 const messages=[]
 const owner=Object.assign(Object.create(NativePreparation.prototype),{
  pending:new Map(),sequence:0,closed:false,admission:new PreparationAdmission(),reservations:new Set(),diagnostics:{enabled:false},
  worker:{postMessage:message=>messages.push(message)}
 })
 const pose=owner.request({lane:'interaction',method:'interaction_pose_damage',args:['{"n":[1,0,0,1,2,3]}']})
 assert.equal(messages[0].method,'interaction_pose_damage')
 assert.equal(messages[0].lane,'interaction')
 assert.equal(owner.sequence,1)
 const pending=owner.pending.get(1)
 clearTimeout(pending.timer);owner.pending.delete(1);owner.release(pending.release);pending.resolve({id:1,value:'{"full":false}'})
 assert.equal((await pose).value,'{"full":false}')
 await assert.rejects(owner.request({lane:'interaction',method:'not-a-method',args:[]}),/Invalid native preparation request/)
 await assert.rejects(owner.request({lane:'untrusted-lane',method:'interaction_pose_damage',args:['{}']}),/Invalid native preparation request/)
 await assert.rejects(owner.request({lane:'canvas',method:'load_source_snapshot',args:[{}]}),/Invalid native preparation request/)
 assert.equal(messages.length,1)
 assert.equal(owner.sequence,1)
 assert.equal(owner.pending.size,0)
 assert.equal(owner.reservations.size,0)
})

test('native transport admits negotiated derivation methods without weakening the method allowlist', async () => {
 const messages=[]
 // Exercise the real request validator and queue bookkeeping without spawning
 // a child. Application errors stay ordinary replies; IPC failure is separate.
 const owner=Object.assign(Object.create(NativePreparation.prototype),{
  pending:new Map(),sequence:0,closed:false,admission:new PreparationAdmission(),reservations:new Set(),diagnostics:{enabled:false},
  worker:{postMessage:message=>messages.push(message)}
 })
 const finish=(id,reply)=>{
  const pending=owner.pending.get(id)
  clearTimeout(pending.timer);owner.pending.delete(id);owner.release(pending.release);pending.resolve(reply)
 }
 const capability=owner.request({lane:'canvas',method:'preparation_capabilities_v1',args:[]})
 assert.equal(messages[0].method,'preparation_capabilities_v1')
 finish(1,{id:1,error:'Unknown preparation method'})
 assert.equal((await capability).error,'Unknown preparation method')
 assert.equal(owner.closed,false)
 const request={operationId:1,baseReceipt:{protocol:1},target:'interaction',expectedTarget:null,delta:[]}
 const derive=owner.request({lane:'interaction',method:'derive_document_v1',args:[request]})
 assert.deepEqual(messages[1].args,[request])
 const receipt={protocol:1,nonce:'opaque'}
 finish(2,{id:2,value:null,stateReceipt:receipt,documentFork:true})
 assert.deepEqual(await derive,{id:2,value:null,stateReceipt:receipt,documentFork:true})
 await assert.rejects(owner.request({lane:'interaction',method:'arbitrary_method',args:[]}),/Invalid native preparation request/)
 assert.equal(owner.pending.size,0)
})

test('source file descriptors enter preparation only through a private host request',async()=>{
 const messages=[]
 const owner=Object.assign(Object.create(NativePreparation.prototype),{pending:new Map(),sequence:0,closed:false,
  admission:new PreparationAdmission(),reservations:new Set(),diagnostics:{enabled:false},worker:{postMessage:message=>messages.push(message)}})
 const descriptor={path:'/owned/cache/canvas-native-0.scene',store:{generation:'source:1:0',documentId:'source',bytes:600*1024**2,nodes:124447,footerHash:Array(32).fill(42)},documentId:'source',pageId:'page',stageId:'stage',nodes:124447}
 await assert.rejects(owner.request({lane:'canvas',method:'load_source_snapshot',args:[descriptor]}),/Invalid native preparation request/)
 assert.equal(messages.length,0)
 const pending=owner.loadSourceSnapshot(descriptor)
 assert.equal(messages[0].method,'load_source_snapshot');assert.deepEqual(messages[0].args,[descriptor])
 assert.equal(owner.pending.get(1).timer,undefined)
 const job=owner.pending.get(1);clearTimeout(job.timer);owner.pending.delete(1);owner.release(job.release);job.resolve({id:1,stateReceipt:{nonce:'owned'}})
 assert.deepEqual(await pending,{id:1,stateReceipt:{nonce:'owned'}})
 const compile=owner.request({lane:'canvas',method:'compile_gpu_packet',args:['{}']})
 const compilation=owner.pending.get(2);assert.equal(compilation.timer,undefined)
 owner.pending.delete(2);owner.release(compilation.release);compilation.resolve({id:2,value:'packet'});await compile
 const ordinary=owner.request({lane:'canvas',method:'load_document',args:['{}']})
 const loaded=owner.pending.get(3);assert.notEqual(loaded.timer,undefined);clearTimeout(loaded.timer)
 owner.pending.delete(3);owner.release(loaded.release);loaded.resolve({id:3,value:null});await ordinary
 assert.equal(owner.sourceLanes.has('canvas'),false)
 await assert.rejects(owner.request({lane:'canvas',method:'load_source_snapshot',args:[descriptor]}),/Invalid/)
})

test('local document codec roundtrips UTF-8 and rejects oversized/invalid input without poisoning later jobs',async()=>{
 const codec=new NativePreparation(undefined,undefined,true)
 const call=(method,value)=>codec.request({lane:'canvas',method,args:[value]})
 try{
  const document={id:'d',name:'中文 😀',text:'\n"\\',values:[-0,1e-20],nodes:{}}
  const encoded=(await call('serialize',document)).value
  assert.equal(encoded,JSON.stringify(document))
  assert.deepEqual((await call('parse',encoded)).value,JSON.parse(JSON.stringify(document)))
  assert.ok((await call('parse','{')).error)
  assert.match((await call('serialize','x'.repeat(DOCUMENT_BYTE_LIMIT))).error,/working-memory/)
  assert.deepEqual((await call('parse','{"name":"still usable"}')).value,{name:'still usable'})
 }finally{await codec.close()}
})

test('native document IPC validates the sender and retires codec workers on navigation',async()=>{
 const handlers=new Map(),sender=Object.assign(new EventEmitter(),{id:11})
 const event={sender,allowed:true}
 const stop=registerNativePreparation({handle:(name,fn)=>handlers.set(name,fn)},
  {resourcesRoot:'/unused-in-codec-test',assertSender:e=>{if(!e.allowed)throw Error('Foreign sender')}})
 try{
  await assert.rejects(handlers.get('native-document:encode')({...event,allowed:false},{}),/Foreign sender/)
  assert.equal(await handlers.get('native-document:encode')(event,{name:'owned'}),'{"name":"owned"}')
  sender.emit('did-start-navigation',{},'design-app://index.html',false,true)
  assert.deepEqual(await handlers.get('native-document:decode')(event,'{"name":"new session"}'),{name:'new session'})
  sender.emit('destroyed')
 }finally{await stop()}
})


test('host admission rejects before posting a clone and releases exactly once after replies or send failure',async()=>{
 const admission=new PreparationAdmission(170),messages=[]
 const owner=Object.assign(Object.create(NativePreparation.prototype),{
  pending:new Map(),sequence:0,closed:false,admission,reservations:new Set(),diagnostics:{enabled:false},
  worker:{postMessage:message=>messages.push(message)}
 })
 const call=()=>owner.request({lane:'canvas',method:'serialize',args:['x'.repeat(50)]})
 const first=call();assert.equal(messages.length,1);assert.equal(admission.bytes,Buffer.byteLength(JSON.stringify(messages[0])))
 await assert.rejects(call(),/budget exceeded/);assert.equal(messages.length,1)
 const pending=owner.pending.get(1);clearTimeout(pending.timer);owner.pending.delete(1)
 owner.release(pending.release);owner.release(pending.release);pending.resolve({value:'ok'})
 await first;assert.equal(admission.bytes,0)
 owner.worker.postMessage=()=>{throw Error('clone failed')}
 await assert.rejects(call(),/clone failed/);assert.equal(admission.bytes,0);assert.equal(owner.reservations.size,0)
})

test('host admission is shared across sessions and cancellation retains clones until worker exit',async()=>{
 const admission=new PreparationAdmission(170)
 const codec=new NativePreparation(undefined,undefined,true,admission)
 const second=new NativePreparation(undefined,undefined,true,admission)
 try{
  const first=codec.request({lane:'canvas',method:'serialize',args:['x'.repeat(50)]})
  const rejected=assert.rejects(first,/closed/)
  const exited=codec.close()
  assert.ok(admission.bytes>0)
  await assert.rejects(second.request({lane:'canvas',method:'serialize',args:['x'.repeat(50)]}),/budget exceeded/)
  await rejected;await exited;assert.equal(admission.bytes,0)
  assert.equal((await second.request({lane:'canvas',method:'serialize',args:['usable']})).value,'"usable"')
  assert.equal(admission.bytes,0)
 }finally{await codec.close();await second.close()}
})

test('pose transport binds one native interaction owner and retains the physical cancellation fence',async()=>{
 const port=new EventEmitter(),sent=[],jobs=[],cancels=[]
 let resolve,valid=true,retired=0
 Object.assign(port,{start(){},close(){this.emit('close')},postMessage(value){sent.push(value)}})
 const worker={request(request){jobs.push(request);return new Promise(done=>{resolve=done})},cancel:id=>cancels.push(id)}
 bindPosePreparationPort(port,worker,()=>valid,()=>{retired++;valid=false})
 const send=data=>port.emit('message',{data})
 send({id:1,lane:'canvas',method:'compile_gpu_packet',args:['{}']});assert.match(sent.at(-1).error,/Invalid/)
 send({id:2,lane:'interaction',method:'load_document',args:['x']});assert.equal(jobs.length,0)
 const packet={id:3,lane:'interaction',method:'compile_gpu_packet',args:['{}'],cancellable:true};send(packet)
 send({...packet,id:4});assert.equal(jobs.length,1);send({cancel:2});send({cancel:3});assert.deepEqual(cancels,[3])
 resolve({value:new Uint8Array([3])});await new Promise(done=>setImmediate(done));assert.equal(sent.at(-1).value[0],3)
 send(packet);assert.match(sent.at(-1).error,/Invalid/);assert.equal(jobs.length,1)
 send({...packet,id:5});port.close();assert.equal(retired,1)
 const count=sent.length;resolve({value:new Uint8Array([5])});await new Promise(done=>setImmediate(done));assert.equal(sent.length,count)
})
