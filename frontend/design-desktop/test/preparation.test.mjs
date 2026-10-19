import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { NativePreparation, registerNativePreparation } from '../src/preparation.mjs'

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
