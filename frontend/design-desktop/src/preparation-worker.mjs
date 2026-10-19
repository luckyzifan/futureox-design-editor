// All framing, JSON and binary conversion run in this Node worker, outside the
// renderer and main event loop. The owned Rust child performs CPU preparation.
import { parentPort, workerData } from 'node:worker_threads'
import { spawn } from 'node:child_process'
const child=spawn(workerData.binary,['--font',workerData.font],{stdio:['pipe','pipe','ignore'],shell:false,
  env:Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(ELECTRON_|NODE_OPTIONS$|LD_PRELOAD$|DYLD_)/.test(k)))})
const queue=[];let active,queuedBytes=0,parts=[],received=0,expected,stopped=false
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
  received+=part.length;if(received>130*1024*1024)throw Error('Native preparation frame exceeds limit')
  parts.push(part)
  if(!expected&&received>=12){
   const header=parts.length===1?parts[0]:Buffer.concat(parts,received)
   if(header.toString('ascii',0,4)!=='FPR1')throw Error('Invalid native preparation protocol')
   const metadata=header.readUInt32LE(4),binary=header.readUInt32LE(8)
   if(metadata>2*1024*1024||binary>128*1024*1024)throw Error('Native preparation payload exceeds limit')
   expected={metadata,binary,total:12+metadata+binary}
  }
  if(!expected||received<expected.total)return
  if(received!==expected.total||!active)throw Error('Unexpected native preparation frame')
  const frame=Buffer.concat(parts,received),reply=JSON.parse(frame.toString('utf8',12,12+expected.metadata))
  if(reply.id!==active.id)throw Error('Native preparation sequence mismatch')
  const transfers=[]
  if(reply.encoding){
   const bytes=new Uint8Array(expected.binary);bytes.set(frame.subarray(12+expected.metadata))
   if(reply.encoding==='f32'){
    if(bytes.length%4)throw Error('Misaligned native float payload')
    // Supported Electron targets are little endian; the wire remains LE.
    reply.value=new Float32Array(bytes.buffer)
   }else if(reply.encoding==='u8')reply.value=bytes
   else throw Error('Unknown native preparation encoding')
   transfers.push(bytes.buffer)
  }
  delete reply.encoding
  parentPort.postMessage({id:active.id,reply},transfers)
  queuedBytes-=active.bytes.length
  active=undefined;parts=[];received=0;expected=undefined;next()
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
