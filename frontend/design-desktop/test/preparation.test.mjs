import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { inflateSync } from 'node:zlib'
import { MessageChannel } from 'node:worker_threads'
import { NativePreparation, PreparationAdmission, registerNativePreparation, bindPosePreparationPort, poseReplyTransfers } from '../src/preparation.mjs'
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

test('large incremental codec receipts carry compact exact JSON', async () => {
 const codec = new NativePreparation(undefined, undefined, true)
 const document = { name: '画板😀', data: '带引号"\ud800'.repeat(160_000), nodes: {} }
 const receipt = { owner: 'fixture', base: 0, sequence: 1, install: true,
  fieldOrder: Object.keys(document), nodeOrder: [], fields: Object.entries(document).filter(([key]) => key !== 'nodes'), nodes: [] }
 try {
  const reply = await codec.request({ lane: 'canvas', method: 'serialize_delta', args: [receipt] })
  assert.equal(reply.error, undefined)
  assert.equal(reply.value.json, undefined)
  assert.ok(reply.value.documentDeflate instanceof Uint8Array)
  assert.equal(inflateSync(reply.value.documentDeflate).toString('utf8'), JSON.stringify(document))
  assert.equal(reply.value.owner, 'fixture')
  assert.equal(reply.value.sequence, 1)
 } finally {
  await codec.close()
 }
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
 const port=new EventEmitter(),sent=[],transfers=[],jobs=[],cancels=[]
 let resolve,valid=true,retired=0
 Object.assign(port,{start(){},close(){this.emit('close')},postMessage(value,transfer){sent.push(value);transfers.push(transfer||[])}})
 const worker={request(request){jobs.push(request);return new Promise(done=>{resolve=done})},cancel:id=>cancels.push(id)}
 bindPosePreparationPort(port,worker,()=>valid,()=>{retired++;valid=false})
 const send=data=>port.emit('message',{data})
 send({id:1,lane:'canvas',method:'compile_gpu_packet',args:['{}']});assert.match(sent.at(-1).error,/Invalid/)
 send({id:2,lane:'interaction',method:'load_document',args:['x']});assert.equal(jobs.length,0)
 const packet={id:3,lane:'interaction',method:'compile_gpu_packet',args:['{}'],cancellable:true};send(packet)
 send({...packet,id:4});assert.equal(jobs.length,1);send({cancel:2});send({cancel:3});assert.deepEqual(cancels,[3])
 const packetBytes=new Uint8Array([3]);resolve({value:packetBytes});await new Promise(done=>setImmediate(done));assert.equal(sent.at(-1).value[0],3);assert.deepEqual(transfers.at(-1),[]);assert.equal(packetBytes.byteLength,1)
 send(packet);assert.match(sent.at(-1).error,/Invalid/);assert.equal(jobs.length,1)
 const patch={id:5,lane:'interaction',method:'apply_document_patch_with_damage',args:['{"fields":{},"nodes":{}}']}
 send({...patch,lane:'canvas'});assert.match(sent.at(-1).error,/Invalid/)
 send({...patch,args:[patch.args[0],{expectedBaseReceipt:{}}]});assert.match(sent.at(-1).error,/Invalid/)
 send(patch);assert.equal(jobs.length,2);assert.equal(jobs.at(-1).method,patch.method)
 resolve({value:'paint damage'});await new Promise(done=>setImmediate(done));assert.equal(sent.at(-1).value,'paint damage');assert.deepEqual(transfers.at(-1),[])
 send({...packet,id:6});port.close();assert.equal(retired,1)
 const count=sent.length;resolve({value:new Uint8Array([6])});await new Promise(done=>setImmediate(done));assert.equal(sent.length,count)
})

test('an event-target pose port moves an exact buffer and keeps a pooled subview', async () => {
  const { port1, port2 } = new MessageChannel()
  const port = new EventEmitter()
  const received = []
  port2.on('message', value => received.push(value))
  Object.assign(port, {
    addEventListener: port1.addEventListener.bind(port1),
    start() { port1.start() },
    close() { this.emit('close'); port1.close(); port2.close() },
    postMessage(value, transfer) { port1.postMessage(value, transfer) },
  })
  port1.on('message', data => port.emit('message', { data }))
  let resolve
  let requested
  const worker = {
    closed: false,
    request() { requested(); return new Promise(done => { resolve = done }) },
    cancel() {},
  }
  try {
    bindPosePreparationPort(port, worker, () => true, () => {})
    await new Promise(done => {
      const check = () => received.length > 0 ? done() : setImmediate(check)
      check()
    })
    assert.equal(received.shift().terminalReady, true)
    const send = async (data, value) => {
      const untilRequested = new Promise(done => { requested = done })
      port2.postMessage(data)
      await untilRequested
      resolve({ value, compileStats: { compilations: 1 } })
      await new Promise(done => {
        const check = () => received.length > 0 ? done() : setImmediate(check)
        check()
      })
      return received.shift()
    }
    const packet = new Uint8Array(256 * 1024)
    packet[0] = 9
    packet[packet.length - 1] = 8
    const owned = packet.buffer
    const reply = await send({ id: 1, lane: 'interaction', method: 'compile_gpu_packet', args: ['{}'] }, packet)
    assert.equal(reply.value[0], 9)
    assert.equal(reply.value[reply.value.byteLength - 1], 8)
    assert.equal(reply.value.byteLength, 256 * 1024)
    assert.equal(reply.compileStats.compilations, 1)
    assert.equal(owned.byteLength, 0)
    const slab = new Uint8Array(128)
    slab[10] = 3
    const view = slab.subarray(8, 12)
    const copied = await send({ id: 2, lane: 'interaction', method: 'compile_gpu_packet', args: ['{}'] }, view)
    assert.deepEqual([...copied.value], [0, 0, 3, 0])
    assert.equal(copied.value.byteOffset, 0)
    assert.equal(copied.value.buffer.byteLength, 4)
    assert.equal(slab.buffer.byteLength, 128)
    assert.equal(slab[10], 3)
    const pool = Buffer.alloc(32, 17)
    const pooled = await send({ id: 3, lane: 'interaction', method: 'compile_gpu_packet', args: ['{}'] }, pool.subarray(5, 8))
    assert.deepEqual(pooled.value, new Uint8Array([17, 17, 17]))
    assert.equal(pooled.value.buffer.byteLength, 3)
    assert.equal(pool.buffer.byteLength, 32)
    const floats = new Float32Array([0, 1.25, -2.5, 0])
    const floatReply = await send({ id: 4, lane: 'interaction', method: 'compile_gpu_packet', args: ['{}'] }, floats.subarray(1, 3))
    assert.deepEqual(floatReply.value, new Float32Array([1.25, -2.5]))
    assert.equal(floatReply.value.buffer.byteLength, 8)
    assert.equal(floats.buffer.byteLength, 16)
    const text = await send({ id: 5, lane: 'interaction', method: 'apply_document_patch_with_damage', args: ['{"fields":{},"nodes":{}}'] }, 'paint damage')
    assert.equal(text.value, 'paint damage')
  } finally { port.close() }
})

test('a desktop pose port delivers an exact buffer when ArrayBuffer transfer is rejected', async () => {
  const port = new EventEmitter()
  const sent = []
  let retired = 0
  Object.assign(port, {
    start() {},
    close() { this.emit('close') },
    postMessage(value, transfer) {
      if (transfer?.some(item => item instanceof ArrayBuffer)) throw new TypeError('Port at index 0 is not a valid port')
      sent.push(value)
    },
  })
  let resolve
  const worker = { closed: false, request() { return new Promise(done => { resolve = done }) }, cancel() {} }
  bindPosePreparationPort(port, worker, () => true, () => { retired++ })
  const packet = new Uint8Array(256 * 1024)
  packet[0] = 9
  packet[packet.length - 1] = 8
  port.emit('message', { data: { id: 1, lane: 'interaction', method: 'compile_gpu_packet', args: ['{}'] } })
  resolve({ value: packet, compileStats: { compilations: 1 } })
  await new Promise(done => setImmediate(done))
  assert.equal(retired, 0)
  assert.equal(sent.some(message => message.fatal), false)
  const reply = sent.at(-1)
  assert.equal(reply.value[0], 9)
  assert.equal(reply.value[reply.value.byteLength - 1], 8)
  assert.equal(reply.value.byteLength, 256 * 1024)
  assert.equal(reply.compileStats.compilations, 1)
  assert.equal(packet.byteLength, 256 * 1024)
  assert.equal(packet[0], 9)
})

test('pose packet buffers move across a message port without a second byte copy', async () => {
  const { port1, port2 } = new MessageChannel()
  const received = new Promise(resolve => port2.once('message', resolve))
  const value = new Uint8Array([9, 8, 7, 6, 5, 4])
  const reply = { id: 7, value }
  port1.postMessage({ ...reply, id: reply.id }, poseReplyTransfers(reply))
  const message = await received
  assert.deepEqual([...message.value], [9, 8, 7, 6, 5, 4])
  assert.equal(value.byteLength, 0)
  port1.close(); port2.close()
})
