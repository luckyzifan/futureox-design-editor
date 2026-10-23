// All framing, JSON and binary conversion run in this Node worker, outside the
// renderer and main event loop. The owned Rust child performs CPU preparation.
import { parentPort, workerData } from 'node:worker_threads'
import { spawn } from 'node:child_process'
import { NativePreparationFrame } from './preparation-frame.mjs'
import { DOCUMENT_BYTE_LIMIT, DOCUMENT_TRANSFER_BYTES, documentChildEnvironment, assertDocumentSerialization } from './document-capacity.mjs'
import { documentWrites } from './document-transport.mjs'
const child=spawn(workerData.binary,['--font',workerData.font],{stdio:['pipe','pipe','ignore'],shell:false,
  env:documentChildEnvironment(Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(ELECTRON_|NODE_OPTIONS$|LD_PRELOAD$|DYLD_)/.test(k))))})
const queue=[];let active,queuedBytes=0,frame=new NativePreparationFrame(),stopped=false
function fail(error){
 if(stopped)return;stopped=true
 parentPort.postMessage({fatal:error.message||String(error)})
 child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),2000);timer.unref()
 child.once('close',()=>{clearTimeout(timer);parentPort.close()})
}
function progress(job,boundaryCode){
 if(!job?.diagnostics)return
 const elapsed=performance.now()-job.receivedAt
 parentPort.postMessage({id:job.id,progress:{boundaryCode,...(elapsed<=120000?{boundaryDurationMs:elapsed}:{})}})
}
function next(){
 if(stopped||active||!queue.length)return
 active=queue.shift()
 progress(active,10)
 const writing=active
 const frames=documentWrites(writing.bytes,String(writing.id),68*1024*1024)
 const send=()=>{
  if(stopped||active!==writing)return
  const item=frames.next();if(item.done)return
  const accepted=child.stdin.write(item.value,error=>{if(error)fail(error)})
  if(accepted)setImmediate(send);else child.stdin.once('drain',send)
 }
 send()
}
child.on('error',fail)
child.on('exit',(code,signal)=>{if(!stopped){stopped=true;parentPort.postMessage({fatal:`Native preparation exited (${code??signal})`})}parentPort.close()})
child.stdin.on('error',fail);child.stdout.on('error',fail)
child.stdout.on('data',part=>{
 try{
  if(active&&!active.firstByte){active.firstByte=true;progress(active,11)}
  if(!frame.append(part))return
  if(!active)throw Error('Unexpected native preparation frame')
  const {reply,transfers}=frame.decode(active.id)
  parentPort.postMessage({id:active.id,reply},transfers)
  queuedBytes-=active.bytes.length
  active=undefined;frame=new NativePreparationFrame();next()
 }catch(error){fail(error)}
})
parentPort.on('message',message=>{
 if(message.stop){fail(Error('Native preparation closed'));return}
 try{
  if(message.method==='serialize'){
   if(stopped||message.args.length!==1)throw Error('Invalid serialization request')
   assertDocumentSerialization(message.args[0])
   const value=JSON.stringify(message.args[0])
   if(typeof value!=='string'||Buffer.byteLength(value)>DOCUMENT_BYTE_LIMIT)throw Error('Serialized document exceeds the available working-memory allowance')
   parentPort.postMessage({id:message.id,reply:{id:message.id,value}});return
  }
  // Trace control never enters the strict Rust request or document payload.
  const {diagnostics,...request}=message
  const receivedAt=performance.now()
  progress({id:message.id,diagnostics,receivedAt},9)
  assertDocumentSerialization(request,DOCUMENT_TRANSFER_BYTES)
  const bytes=Buffer.from(JSON.stringify(request))
  if(stopped||queue.length>=32||bytes.length>DOCUMENT_TRANSFER_BYTES||queuedBytes+bytes.length>DOCUMENT_TRANSFER_BYTES+8*1024*1024)
   throw Error('Native preparation request budget exceeded')
  queue.push({id:message.id,bytes,diagnostics,receivedAt});queuedBytes+=bytes.length;next()
 }catch(error){parentPort.postMessage({id:message.id,reply:{id:message.id,error:error.message}})}
})
parentPort.on('close',()=>{if(!stopped)child.kill('SIGTERM')})
