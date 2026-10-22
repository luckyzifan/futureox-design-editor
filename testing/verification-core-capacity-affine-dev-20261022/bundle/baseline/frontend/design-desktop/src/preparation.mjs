import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { createRenderDiagnostics, PREFIX } from './render-terminal-diagnostics.mjs'
const methods=new Set(['serialize','parse','warm_resources','initialize','load_document','apply_document_patch_with_damage','apply_interaction_transforms',
 'compile_gpu_scene_update','clear_gpu_scene_session','compile_gpu_packet','render_linear','render_png','render_color_png','render_region_png','render_cpu_frame','stats','gpu_memory_breakdown',
 'preparation_capabilities_v1','derive_document_v1'])
export class NativePreparation {
 constructor(binary,font,codecOnly=false){
  this.pending=new Map();this.sequence=0;this.closed=false
  // Host has its own clock/session/sequence. Correlation uses preparationId and
  // requestId only; never subtract host timestamps from renderer performance.now.
  this.diagnostics=createRenderDiagnostics({enabled:['1','detail'].includes(process.env.CORE_RENDER_DIAGNOSTICS),detail:process.env.CORE_RENDER_DIAGNOSTICS==='detail',source:'host',session:Math.floor(Math.random()*1e12),sink:record=>console.log(PREFIX+JSON.stringify(record))})
  this.worker=new Worker(new URL(codecOnly?'./document-codec-worker.mjs':'./preparation-worker.mjs',import.meta.url),{workerData:{binary,font}})
  this.done=new Promise(resolve=>this.worker.once('exit',resolve))
  this.worker.on('message',message=>{
   if(message.fatal){this.close(Error(message.fatal));return}
   const pending=this.pending.get(message.id);if(!pending)return
   if(Object.hasOwn(message,'progress')){
    const progress=message.progress
    if(pending.diagnostic && Number.isInteger(progress?.boundaryCode) && progress.boundaryCode>=8 && progress.boundaryCode<=12){
     const fields={...pending.diagnostic,phase:5,backendCode:2,boundaryCode:progress.boundaryCode}
     if(Number.isFinite(progress.boundaryDurationMs)&&progress.boundaryDurationMs>=0&&progress.boundaryDurationMs<=120000)fields.boundaryDurationMs=progress.boundaryDurationMs
     this.diagnostics.record('preparation',fields)
    }
    return
   }
   if(pending.diagnostic)this.diagnostics.record('preparation',{...pending.diagnostic,phase:5,backendCode:2,boundaryCode:12})
   this.pending.delete(message.id);clearTimeout(pending.timer);pending.resolve(message.reply)
  })
  this.worker.on('error',error=>this.close(error))
  this.worker.on('exit',()=>this.close(Error('Native preparation worker exited')))
 }
 request(request){
  if(this.closed)return Promise.reject(Error('Native preparation closed'))
  if(!request||!['canvas','interaction'].includes(request.lane)||!methods.has(request.method)||!Array.isArray(request.args)||request.args.length>3)
   return Promise.reject(Error('Invalid native preparation request'))
  if(this.pending.size>=32||this.sequence>=0xffffffff)return Promise.reject(Error('Native preparation queue or sequence limit exceeded'))
  const id=++this.sequence
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>this.close(Error('Native preparation timed out')),120000)
   const input=request.diagnostics
   const diagnostic=this.diagnostics.enabled&&input&&Number.isSafeInteger(input.originChannelId)&&input.originChannelId>=0&&input.originChannelId<=0xffffffffffff&&Number.isSafeInteger(input.requestId)&&input.requestId>=0&&Number.isSafeInteger(input.preparationId)&&input.preparationId>0
    ?{originChannelId:input.originChannelId,requestId:input.requestId,preparationId:input.preparationId}:undefined
   this.pending.set(id,{resolve,reject,timer,diagnostic})
   if(diagnostic)this.diagnostics.record('preparation',{...diagnostic,phase:5,backendCode:2,boundaryCode:8})
   try{this.worker.postMessage({id,lane:request.lane,method:request.method,args:request.args,...(diagnostic?{diagnostics:true}:{})})}
   catch(error){this.pending.delete(id);clearTimeout(timer);reject(error)}
  })
 }
 close(error=Error('Native preparation closed')){
  if(this.closed)return this.done;this.closed=true
  for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error)}this.pending.clear()
  this.diagnostics.flush();this.diagnostics.close()
  this.worker.postMessage({stop:true})
  return this.done
 }
}
export function registerNativePreparation(ipcMain,{resourcesRoot,assertSender}){
 const sessions=new Map(),owners=new Set(),retiring=new Set(),codecs=new Map()
 const close=worker=>{const done=worker.close();retiring.add(done);void done.finally(()=>retiring.delete(done));return done}
 const retire=owner=>{for(const [id,s] of sessions)if(s.owner===owner){close(s.worker);sessions.delete(id)}const codec=codecs.get(owner);if(codec){codecs.delete(owner);close(codec)}}
 const observeOwner=event=>{
  const owner=event.sender.id
  if(!owners.has(owner)){
   owners.add(owner)
   event.sender.once('destroyed',()=>{owners.delete(owner);retire(owner)})
   event.sender.on('did-start-navigation',(_event,_url,_inPlace,isMainFrame)=>{if(isMainFrame)retire(owner)})
  }
  return owner
 }
 for(const [name,method] of [['encode','serialize'],['decode','parse']])ipcMain.handle(`native-document:${name}`,async(event,value)=>{
  assertSender(event)
  const owner=observeOwner(event)
  let codec=codecs.get(owner)
  if(!codec||codec.closed){codec=new NativePreparation(undefined,undefined,true);codecs.set(owner,codec)}
  const reply=await codec.request({lane:'canvas',method,args:[value]})
  if(reply.error)throw Error(reply.error)
  return reply.value
 })
 ipcMain.handle('native-preparation:open',event=>{
  assertSender(event)
  if(sessions.size>=4)throw Error('Native preparation session limit exceeded')
  const id=randomUUID(),worker=new NativePreparation(path.join(resourcesRoot,'bin',`design-prepare${process.platform==='win32'?'.exe':''}`),path.join(resourcesRoot,'fonts','NotoSansSC.ttf'))
  const owner=observeOwner(event)
  sessions.set(id,{owner,worker})
  return id
 })
 const session=(event,id)=>{assertSender(event);const s=sessions.get(id);if(!s||s.owner!==event.sender.id)throw Error('Unknown native preparation session');return s}
 ipcMain.handle('native-preparation:request',(event,id,request)=>session(event,id).worker.request(request))
 ipcMain.handle('native-preparation:close',(event,id)=>{const s=session(event,id);sessions.delete(id);return close(s.worker)})
 return ()=>{for(const s of sessions.values())close(s.worker);for(const codec of codecs.values())close(codec);sessions.clear();codecs.clear();return Promise.all([...retiring])}
}
