import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { NativePreparation, registerNativePreparation } from '../src/preparation.mjs'

test('native transport admits negotiated derivation methods without weakening the method allowlist', async () => {
 const messages=[]
 // Exercise the real request validator and queue bookkeeping without spawning
 // a child. Application errors stay ordinary replies; IPC failure is separate.
 const owner=Object.assign(Object.create(NativePreparation.prototype),{
  pending:new Map(),sequence:0,closed:false,diagnostics:{enabled:false},
  worker:{postMessage:message=>messages.push(message)}
 })
 const finish=(id,reply)=>{
  const pending=owner.pending.get(id)
  clearTimeout(pending.timer);owner.pending.delete(id);pending.resolve(reply)
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

test('local document codec roundtrips UTF-8 and rejects oversized/invalid input without poisoning later jobs',async()=>{
 const codec=new NativePreparation(undefined,undefined,true)
 const call=(method,value)=>codec.request({lane:'canvas',method,args:[value]})
 try{
  const document={id:'d',name:'中文 😀',text:'\n"\\',values:[-0,1e-20],nodes:{}}
  const encoded=(await call('serialize',document)).value
  assert.equal(encoded,JSON.stringify(document))
  assert.deepEqual((await call('parse',encoded)).value,JSON.parse(JSON.stringify(document)))
  assert.ok((await call('parse','{')).error)
  assert.match((await call('serialize','x'.repeat(32*1024*1024))).error,/32 MiB/)
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
