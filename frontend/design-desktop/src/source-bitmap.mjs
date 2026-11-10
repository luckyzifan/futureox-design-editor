import path from 'node:path'
import {open,realpath} from 'node:fs/promises'
import {Readable} from 'node:stream'
import {Worker} from 'node:worker_threads'
let service, sequence=0
const requests=new Map()
// unref only when no sample is queued. A short-lived node --test loop otherwise
// looks idle and cancels the still-pending reply. Electron can still exit once
// the queue is empty.
function pinSampler(){if(service)requests.size?service.ref():service.unref()}
function sample(file,iw,ih,body,pairs){
 if(requests.size>=8)throw Error('Source sampler busy')
 if(!service){
  const worker=new Worker(new URL('./source-bitmap-samples.mjs',import.meta.url));service=worker
  const lost=()=>{if(service!==worker)return;service=undefined;for(const job of requests.values())job.reject(Error('Source sampler stopped'));requests.clear()}
  worker.on('error',lost);worker.on('exit',lost)
  worker.on('message',result=>{const job=requests.get(result.id);if(!job)return;requests.delete(result.id);pinSampler();if(result.error)job.reject(Error('Source sample unavailable'));else job.resolve(result.buffer)})
 }
 const id=++sequence
 return new Promise((resolve,reject)=>{requests.set(id,{resolve,reject});pinSampler();try{service.postMessage({id,file,iw,ih,body,pairs})}catch(e){requests.delete(id);pinSampler();reject(e)}})
}
export async function serveSourceBitmap(request,active,root) {
 const url=new URL(request.url), match=/^\/source-image\/([a-zA-Z0-9-]{1,160})\/([a-f0-9]{64}-([1-9]\d{0,8})x([1-9]\d{0,8}))\.png$/.exec(url.pathname)
 if(!match||!active(match[1])||(url.search&&url.search!=='?samples=1'&&url.search!=='?samples=1&pairs=1')||request.method!=='GET'&&request.method!=='POST')return new Response('Forbidden',{status:403})
 const full=path.resolve(root,'large-documents',match[1],'bitmaps',match[2]+(request.method==='GET'?'.png':'.rgba'))
 if(await realpath(full)!==await realpath(root)+full.slice(path.resolve(root).length))return new Response('Forbidden',{status:403})
 if(request.method==='POST'){
   if(!url.search.startsWith('?samples=1'))return new Response(null,{status:403})
   const reader=request.body?.getReader();if(!reader)return new Response(null,{status:400})
   let bytes=0;const chunks=[]
   for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>65544){await reader.cancel();return new Response(null,{status:413})}chunks.push(value)}
   const pixels=await sample(full,Number(match[3]),Number(match[4]),Buffer.concat(chunks,bytes),url.search.endsWith('&pairs=1'))
   if(!active(match[1]))return new Response(null,{status:409})
   return new Response(pixels,{headers:{'Content-Type':'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}})
 }
 const file=await open(full,'r')
 if(!active(match[1])){await file.close();return new Response(null,{status:409})}
 return new Response(Readable.toWeb(file.createReadStream()),{headers:{'Content-Type':'image/png','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}})
}
