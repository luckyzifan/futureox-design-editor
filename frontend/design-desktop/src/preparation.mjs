import { Worker } from 'node:worker_threads'
import { documentChildEnvironment, DOCUMENT_TRANSFER_BYTES, assertDocumentSerialization } from './document-capacity.mjs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { createRenderDiagnostics, PREFIX } from './render-terminal-diagnostics.mjs'
import { rendererHostMethods } from './preparation-protocol.mjs'
// Renderer-visible names come from preparation-methods-v1.ts. Private source
// snapshots stay on loadSourceSnapshot, and codec names stay in the Node worker.
const methods=rendererHostMethods()
const sourceSnapshotRequests=new WeakSet()
const cpuRenderMethods=new Set(['render_linear','render_png','render_color_png','render_region_png','render_cpu_frame'])
// A single host-wide ledger includes every preparation/codec session. A close
// rejects callers immediately but holds their leases until the worker exits:
// rejecting a promise does not free a clone already queued in another thread.
export class PreparationAdmission {
 constructor(limit=DOCUMENT_TRANSFER_BYTES+8*1024*1024){this.limit=limit;this.bytes=0}
 reserve(bytes){
  if(!Number.isSafeInteger(bytes)||bytes<0||bytes>this.limit-this.bytes)throw Error('Native preparation request budget exceeded')
  this.bytes+=bytes;let released=false
  return ()=>{if(!released){released=true;this.bytes-=bytes}}
 }
}
const sharedAdmission=new PreparationAdmission()
export class NativePreparation {
 loadSourceSnapshot(descriptor){
  const request={lane:'canvas',method:'load_source_snapshot',args:[descriptor]}
  sourceSnapshotRequests.add(request)
  return this.request(request)
 }
 constructor(binary,font,codecOnly=false,admission=sharedAdmission){
  this.pending=new Map();this.sequence=0;this.closed=false;this.admission=admission;this.reservations=new Set();this.sourceLanes=new Set()
  // Host has its own clock/session/sequence. Correlation uses preparationId and
  // requestId only; never subtract host timestamps from renderer performance.now.
  this.diagnostics=createRenderDiagnostics({enabled:['1','detail'].includes(process.env.CORE_RENDER_DIAGNOSTICS),detail:process.env.CORE_RENDER_DIAGNOSTICS==='detail',source:'host',session:Math.floor(Math.random()*1e12),sink:record=>console.log(PREFIX+JSON.stringify(record))})
  this.worker=new Worker(new URL(codecOnly?'./document-codec-worker.mjs':'./preparation-worker.mjs',import.meta.url),{workerData:{binary,font},env:documentChildEnvironment(process.env)})
  this.done=new Promise(resolve=>this.worker.once('exit',()=>{this.releaseAll();resolve()}))
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
   this.pending.delete(message.id);clearTimeout(pending.timer);this.release(pending.release);pending.resolve(message.reply)
  })
  this.worker.on('error',error=>this.close(error))
  this.worker.on('exit',()=>this.close(Error('Native preparation worker exited')))
 }
 request(request,sourceBitmaps){
  if(this.closed)return Promise.reject(Error('Native preparation closed'))
  const sourceSnapshot=!!request&&sourceSnapshotRequests.has(request)
  if(sourceSnapshot)sourceSnapshotRequests.delete(request)
  if(!request||!['canvas','interaction'].includes(request.lane)||(!methods.has(request.method)&&!sourceSnapshot)||!Array.isArray(request.args)||request.args.length>3)
   return Promise.reject(Error('Invalid native preparation request'))
  if(this.pending.size>=32||this.sequence>=0xffffffff)return Promise.reject(Error('Native preparation queue or sequence limit exceeded'))
  if(request.cancellationId!==undefined&&(request.method!=='compile_gpu_packet'||!Number.isSafeInteger(request.cancellationId)||request.cancellationId<=0||
    [...this.pending.values()].some(p=>p.cancellationId===request.cancellationId)))return Promise.reject(Error('Invalid preparation cancellation owner'))
  const id=this.sequence+1
  const input=request.diagnostics
  const diagnostic=this.diagnostics.enabled&&input&&Number.isSafeInteger(input.originChannelId)&&input.originChannelId>=0&&input.originChannelId<=0xffffffffffff&&Number.isSafeInteger(input.requestId)&&input.requestId>=0&&Number.isSafeInteger(input.preparationId)&&input.preparationId>0
   ?{originChannelId:input.originChannelId,requestId:input.requestId,preparationId:input.preparationId}:undefined
  const message={id,lane:request.lane,method:request.method,args:request.args,...(sourceBitmaps?{sourceBitmaps}:{}),...(diagnostic?{diagnostics:true}:{})}
  let release
  try{
   // Count the complete posted envelope, including ID and diagnostic flag,
   // before serializing or cloning, across every preparation/codec session.
   const bytes=assertDocumentSerialization(message,DOCUMENT_TRANSFER_BYTES)
   release=this.admission.reserve(bytes)
  }catch(error){return Promise.reject(error)}
  this.reservations.add(release)
  this.sequence=id
  return new Promise((resolve,reject)=>{
   const sourceWork=sourceSnapshot||request.method!=='load_document'&&(this.sourceLanes?.has(request.lane)||request.method==='derive_document_v1'&&this.sourceLanes?.has('canvas'))
   // Source scenes and exact region exports are bounded by their respective
   // native work and allocation limits. Closing the owned session stops its child.
   const timer=sourceWork||request.method==='render_region_png'?undefined:setTimeout(()=>this.close(Error('Native preparation timed out')),120000)
   const complete=reply=>{
    if(!reply.error){
     this.sourceLanes??=new Set()
     if(sourceSnapshot||request.method==='derive_document_v1'&&this.sourceLanes.has('canvas'))this.sourceLanes.add(request.lane)
     else if(request.method==='load_document'||request.method==='derive_document_v1')this.sourceLanes.delete(request.lane)
    }
    resolve(reply)
   }
   this.pending.set(id,{resolve:complete,reject,timer,diagnostic,release,method:request.method,cancellationId:request.cancellationId})
   if(diagnostic)this.diagnostics.record('preparation',{...diagnostic,phase:5,backendCode:2,boundaryCode:8})
   try{this.worker.postMessage(message)}
   catch(error){this.pending.delete(id);clearTimeout(timer);this.release(release);reject(error)}
  })
 }
 cancel(cancellationId){
  if(!Number.isSafeInteger(cancellationId)||cancellationId<=0)throw Error('Invalid preparation cancellation')
  if(this.closed)return
  for(const [id,pending]of this.pending)if(pending.method==='compile_gpu_packet'&&pending.cancellationId===cancellationId){
   this.worker.postMessage({cancel:id});break
  }
 }
 release(release){release();this.reservations.delete(release)}
 releaseAll(){for(const release of this.reservations)release();this.reservations.clear()}
 close(error=Error('Native preparation closed')){
  if(this.closed)return this.done;this.closed=true
  for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error)}this.pending.clear()
  this.diagnostics.flush();this.diagnostics.close()
  try{this.worker.postMessage({stop:true})}catch{void this.worker.terminate()}
  return this.done
 }
}
/** The renderer owns its existing preparation process. Only real pose mutations
 * and packets cross this port, in the same physical queue as ordinary calls. */
export function bindPosePreparationPort(port,worker,current,retire){
 let active=0,last=0,closed=false
 const fatal=error=>{
  if(!closed&&current())port.postMessage({fatal:String(error)})
  closed=true;retire();port.close()
 }
 port.on('message',async({data})=>{
  if(closed)return
  if(!current()||worker.closed){fatal('Terminal preparation session closed');return}
  if(data?.cancel!==undefined){if(active&&data.cancel===active)worker.cancel(active);return}
  const {id,lane,method,args,cancellable,diagnostics}=data??{}
  if(active||!Number.isSafeInteger(id)||id<=last||lane!=='interaction'||
     !['apply_interaction_transforms','compile_gpu_packet'].includes(method)||
     !Array.isArray(args)||args.length!==1||typeof args[0]!=='string'){
   port.postMessage({id,error:'Invalid terminal preparation request'});return
  }
  active=last=id
  try{
   if(diagnostics)port.postMessage({id,progress:{backendCode:2,boundaryCode:1}})
   const reply=await worker.request({lane,method,args,
    ...(diagnostics?{diagnostics:{...diagnostics,preparationId:id}}:{}),
    ...(method==='compile_gpu_packet'&&cancellable?{cancellationId:id}:{})})
   if(!closed&&current())port.postMessage({...reply,id})
  }catch(error){if(!closed&&current())fatal(error)}finally{active=0}
 })
 port.on('close',()=>{closed=true;if(active&&current())retire()})
 port.start();port.postMessage({terminalReady:true})
}

export function registerNativePreparation(ipcMain,{resourcesRoot,assertSender,resolveSourceSnapshot,sourceBitmaps}){
 const sessions=new Map(),owners=new Set(),retiring=new Set(),codecs=new Map()
 const close=worker=>{const done=worker.close();retiring.add(done);void done.finally(()=>retiring.delete(done));return done}
 const retireSession=s=>{s.terminal?.close();return close(s.worker)}
 const retire=owner=>{for(const [id,s] of sessions)if(s.owner===owner){retireSession(s);sessions.delete(id)}const codec=codecs.get(owner);if(codec){codecs.delete(owner);close(codec)}}
 const observeOwner=event=>{
  const owner=event.sender.id
  if(!owners.has(owner)){
   owners.add(owner)
   event.sender.once('destroyed',()=>{owners.delete(owner);retire(owner)})
   event.sender.on('did-start-navigation',(_event,_url,_inPlace,isMainFrame)=>{if(isMainFrame)retire(owner)})
  }
  return owner
 }
 for(const [name,method] of [['encode','serialize'],['encode-incremental','serialize_delta'],['decode','parse']])ipcMain.handle(`native-document:${name}`,async(event,value)=>{
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
 ipcMain.on?.('native-preparation:terminal-port',(event,id)=>{
  let owned
  try { owned=session(event,id) } catch { for(const port of event.ports)port.close();return }
  if(event.ports.length!==1||owned.terminal){for(const port of event.ports)port.close();return}
  owned.terminal=event.ports[0]
  bindPosePreparationPort(owned.terminal,owned.worker,()=>sessions.get(id)===owned,()=>{
   if(sessions.get(id)===owned){sessions.delete(id);void retireSession(owned)}
  })
 })
 ipcMain.handle('native-preparation:cancel',(event,id,cancellationId)=>session(event,id).worker.cancel(cancellationId))
 ipcMain.handle('native-preparation:request',async(event,id,request)=>{
  const owned=session(event,id)
  if(request?.method==='load_source_snapshot'){
   if(!resolveSourceSnapshot||request.lane!=='canvas'||!Array.isArray(request.args)||request.args.length!==1||typeof request.args[0]!=='string'||request.cancellationId!==undefined)
    throw Error('Invalid source canvas capability request')
   const grant=resolveSourceSnapshot(request.args[0],event.sender.id)
   const reply=await owned.worker.loadSourceSnapshot(grant.descriptor)
   grant.assertCurrent()
   return reply
  }
  // The renderer cannot supply a filesystem grant. Bind it only for a CPU
  // render in the original window and discard a reply if its source closed.
  const grant=cpuRenderMethods.has(request?.method)?sourceBitmaps?.(event.sender.id):undefined
  const reply=await owned.worker.request(request,grant)
  if(grant && sourceBitmaps?.(event.sender.id)?.owner!==grant.owner)throw Error('Sketch source changed during export')
  return reply
 })
 ipcMain.handle('native-preparation:close',(event,id)=>{const s=session(event,id);sessions.delete(id);return retireSession(s)})
 return ()=>{for(const s of sessions.values())retireSession(s);for(const codec of codecs.values())close(codec);sessions.clear();codecs.clear();return Promise.all([...retiring])}
}
