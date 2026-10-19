// All framing, JSON and binary conversion run in this Node worker, outside the
// renderer and main event loop. The owned Rust child performs CPU preparation.
import { parentPort, workerData } from 'node:worker_threads'
import { spawn } from 'node:child_process'
import { NativePreparationFrame } from './preparation-frame.mjs'
const child=spawn(workerData.binary,['--font',workerData.font],{stdio:['pipe','pipe','ignore'],shell:false,
  env:Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(ELECTRON_|NODE_OPTIONS$|LD_PRELOAD$|DYLD_)/.test(k)))})
const queue=[];let active,queuedBytes=0,frame=new NativePreparationFrame(),stopped=false
function fail(error){
 if(stopped)return;stopped=true
 parentPort.postMessage({fatal:error.message||String(error)})
 child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),2000);timer.unref()
 child.once('close',()=>{clearTimeout(timer);parentPort.close()})
}
function next(){
 if(stopped||active||!queue.length)return
 active=queue.shift()
 child.stdin.write(active.bytes,error=>{if(error)fail(error)})
}
child.on('error',fail)
child.on('exit',(code,signal)=>{if(!stopped){stopped=true;parentPort.postMessage({fatal:`Native preparation exited (${code??signal})`})}parentPort.close()})
child.stdin.on('error',fail);child.stdout.on('error',fail)
child.stdout.on('data',part=>{
 try{
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
   const value=JSON.stringify(message.args[0])
   if(typeof value!=='string'||Buffer.byteLength(value)>32*1024*1024)throw Error('Serialized document exceeds 32 MiB')
   parentPort.postMessage({id:message.id,reply:{id:message.id,value}});return
  }
  const bytes=Buffer.from(JSON.stringify(message)+'\n')
  if(stopped||queue.length>=32||bytes.length>68*1024*1024||queuedBytes+bytes.length>96*1024*1024)
   throw Error('Native preparation request budget exceeded')
  queue.push({id:message.id,bytes});queuedBytes+=bytes.length;next()
 }catch(error){parentPort.postMessage({id:message.id,reply:{id:message.id,error:error.message}})}
})
parentPort.on('close',()=>{if(!stopped)child.kill('SIGTERM')})
