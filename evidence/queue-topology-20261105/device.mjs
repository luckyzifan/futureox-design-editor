// Timing uses production graph/queue boundaries. Profiling and float readback are separate passes.
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import {withGpuPage} from '../../testing/verification-effect-work-20261104/gpu-page.mjs'
const [mode,folder,out,...tiles]=process.argv.slice(2)
await withGpuPage(mode.startsWith('profile')?{VITE_DESIGN_QUEUE_WAIT_TIMING:'1'}:{},async page=>{
 page.on('pageerror',e=>console.error(e))
 await page.route('**/__qpacket/*',r=>r.fulfill({path:path.join(folder,path.basename(new URL(r.request().url()).pathname)),contentType:'application/octet-stream'}))
 const rows=[]
 for(const tile of tiles){
  const row=await page.evaluate(async({tile,mode})=>{
   const {initializePicking}=await import('/src/kernel/picking.ts')
   const {VectorEngine}=await import('/src/generated/design-kernel/design_kernel.js')
   const {decodeScenePacket}=await import('/src/kernel/gpu/scene-packet.ts')
   const {createGpu}=await import('/src/kernel/gpu/factory.ts')
   const {managedSceneImageLoader}=await import('/src/kernel/scene-image-hydration.ts')
   const {DecodedImageCache}=await import('/src/kernel/decoded-image-cache.ts')
   const {setGpuDiagnosticSink}=await import('/src/kernel/gpu/qa-diag.ts')
   await initializePicking()
   const bytes=new Uint8Array(await(await fetch('/__qpacket/'+tile+'.pkt')).arrayBuffer())
   const colors=decodeScenePacket(bytes).colorManagement,owners=[]
   const sha=async data=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),b=>b.toString(16).padStart(2,'0')).join('')
   const profile={},now=()=>performance.now()
   function record(key,value=0,n=1){const v=profile[key]??={count:0,total:0,max:0};v.count+=n;v.total+=value;v.max=Math.max(v.max,value)}
   function probe(o){
    const g=o.gpu,d=g.driver
    function wrap(obj,key,fn){const op=obj[key];if(op)obj[key]=function(...args){return fn.call(this,op,args)}}
    wrap(d,'yieldRasterQueue',async function(op,a){const start=now(),seq=d.submissionSequence,completed=d.completedSubmissionSequence,off=d.offset;await op.apply(this,a);record('yield.wall',now()-start);record('yield.previousInFlight',seq-completed);record('yield.pendingUniformSlots',off/1024)})
    wrap(d,'waitForQueue',function(op,a){const start=now(),key='fence.'+(a[2]?'background.':'blocking.')+a[0];return op.apply(this,a).then(v=>{record(key,now()-start);return v})})
    wrap(d,'checkpoint',async function(op,a){const t=now();await op.apply(this,a);record('checkpoint.'+a[0],now()-t);if(a[1]){record('admission.pressure'+a[1].admissionPressure+'.kind'+a[1].admissionRetiredKinds,a[1].admissionReclaimableBytes)}})
    wrap(d,'retireImageTable',function(op,a){const t=now(),result=op.apply(this,a);if(result?.then)return result.then(v=>{record('imageRetire.wall',now()-t);return v});record('imageRetire.sync',now()-t);return result})
    wrap(d,'submitCommands',function(op,a){record('submit.uniformSlots',d.offset/1024);const t=now(),v=op.apply(this,a);record('submit.sync',now()-t);return v})
    wrap(g,'reclaimScratch',function(op,a){const t=now(),v=op.apply(this,a);record('maintenance.syncPrefix',now()-t);return v})
    wrap(g,'acquire',function(op,a){const [r,bi,sc,site,mode]=a,key=(sc?'scalar:':bi?'binary:':'')+r.w+':'+r.h,hit=!!g.free.get(key)?.length;const v=op.apply(this,a);record('surface.'+(hit?'reuse':'new')+'.'+(site??0)+'.'+(mode??-1),v.texture.bytes);return v})
    wrap(d,'noteDraw',function(op,a){record('draw.'+a[0],a[2]||0,a[1]??1);return op.apply(this,a)})
    wrap(d,'drawDensePair',function(op,a){const v=op.apply(this,a);record('pair.driver.'+(v?'ok':'declined'),a[0][0].width*a[0][0].height*2);return v})
    const details=o.details={pairs:[],fields:[],groups:[],fieldPeakPhysicalBytes:0}
    let pair,liveBytes=0
    const fieldLease=new Map(),fieldRefs=new Map()
    wrap(g,'denseBatchPair',async function(op,a){
     const row={phase:a[5],roots:a[4].length,write:a[3],output:[],rejected:[]}
     pair=row;const initial=profile['pair.driver.ok']?.count||0
     try{const v=await op.apply(this,a)
      row.outcome=v?((profile['pair.driver.ok']?.count||0)===initial?'empty':'drawn'):(row.rejected[0]||'placement-or-driver')
      record('pair.batch.'+row.outcome,a[3].w*a[3].h);return v
     }finally{pair=undefined;details.pairs.push(row)}
    })
    for(const [method,reason] of [['drawRegion','drawRegion'],['surfaceNeedsAdmission','admission']])
     wrap(g,method,function(op,a){const v=op.apply(this,a);if(pair&&v)pair.rejected.push(reason);return v})
    wrap(g,'denseEffectPlanes',async function(op,a){const before=profile['pair.driver.ok']?.count||0,v=await op.apply(this,a);record('pair.effect.'+((profile['pair.driver.ok']?.count||0)>before?'paired':'single'),a[0].w*a[0].h);return v})
    wrap(g,'sourceProgramOutput',function(op,a){const v=op.apply(this,a);record('placement.'+a[0]+'.'+v.kind+(a[3]?'Bounded':'Unbounded'),v.output.w*v.output.h);if(pair)pair.output.push({kind:v.kind,rect:v.output});return v})
    wrap(g,'sampleSourceFilter',async function(op,a){
     const start=now(),base=d.drawCalls,plan=a[1],t=await op.apply(this,a),tex=t.texture
     const row={masks:plan.masks.length,groupRoots:plan.groupRoots?.length||0,world:plan.output,physical:[tex.width,tex.height],physicalBytes:tex.bytes,zero:!!tex.transparentZero,draws:d.drawCalls-base,prepareMs:now()-start}
     const old=fieldRefs.get(tex)||0;if(!old)liveBytes+=tex.bytes
     fieldRefs.set(tex,old+1);details.fieldPeakPhysicalBytes=Math.max(details.fieldPeakPhysicalBytes,liveBytes)
     fieldLease.set(t,[row,now()]);details.fields.push(row);return t
    })
    wrap(g,'release',function(op,a){for(const t of a){const held=fieldLease.get(t);if(!held)continue
      fieldLease.delete(t);held[0].leaseMs=now()-held[1];const tex=t.texture,n=fieldRefs.get(tex)-1
      if(n)fieldRefs.set(tex,n);else{fieldRefs.delete(tex);liveBytes-=tex.bytes}
    }return op.apply(this,a)})
    if(o.scene.sourceDetailTile)wrap(g,'drawBundle',function(op,a){details.groups.push({ids:a[0].length,live:a[0].filter(id=>o.scene.nodes[id]).length,uniqueTargets:new Set(a[1].map(v=>v.texture)).size,clip:!!a[2]});return op.apply(this,a)})
    wrap(g,'run',function(op,a){record('run.'+a[0],a[1].w*a[1].h);return op.apply(this,a)})
    setGpuDiagnosticSink((event,fields)=>{if(fields.maintenanceDecision!==undefined)record('maintenance.decision.'+fields.maintenanceDecision,fields.mandatoryReasonBits||0)})
   }
   async function draw(o,read=false){
    globalThis.__qaQueueArm=o.arm
    const d=o.gpu.driver,finish=d.finish
    if(read)d.finish=async function(t,...args){o.raw=await this.readSurface(t);return finish.call(this,t,...args)}
    try{await d.device.queue.onSubmittedWorkDone()
     const t=now(),r=await o.gpu.render(o.scene,false,true,()=>true,undefined,true),returned=now()
     await d.device.queue.onSubmittedWorkDone();const done=now()
     r.bitmap?.close();if(r.gpuTile)d.releasePresented?.([r.gpuTile])
     return {complete:done-t,tail:done-returned,graph:r.graphMs,checkpoint:r.checkpointMs,finish:r.finishMs,draws:r.drawCalls,passes:r.passPixels,peak:r.peakTextureBytes,submits:r.commandSubmissions,fieldUploads:r.materialFieldUploadBytes,
       ...(mode.startsWith('profile')?{drawWork:r.drawWork}:{})}
    }finally{d.finish=finish}
   }
   try{
    for(const arm of mode==='profile'?['A']:mode==='profileB'?['B']:['A','B']){
     globalThis.__qaQueueArm=arm
     const kernel=new VectorEngine()
     kernel.load_document(JSON.stringify({id:'qa',name:'qa',schemaVersion:5,pages:[{id:'p',name:'p',background:'#ffffff',children:[]}],nodes:{},colorManagement:colors}))
     const loader=managedSceneImageLoader(new DecodedImageCache(),()=>({kernel,scope:'qa',settings:JSON.stringify(colors)}),{key:async()=>undefined,read:async()=>undefined,write(){}})
     const gpu=await createGpu('webgpu',true,true,colors,loader,false,true),scene=decodeScenePacket(bytes)
     scene.sourceDetailTile=tile.startsWith('high_');scene.sourceImageDisplay=true;gpu.driver.captureDisplay=true
     owners.push({arm,kernel,gpu,scene,samples:[]})
    }
    const o=owners[0],ret={tile,bytes:bytes.length,packetSha256:await sha(bytes),width:o.scene.width,height:o.scene.height,nodes:Object.keys(o.scene.nodes).length,dense:!!o.scene.densePaint,sourceDetail:o.scene.sourceDetailTile,adapter:o.gpu.driver.device.adapterInfo?.description||o.gpu.driver.device.adapterInfo?.architecture}
    if(mode.startsWith('profile')){await draw(o);probe(o);const d=o.gpu.driver
      const snap=()=>d.queueWaitStats.snapshot(d.resourceEpoch,d.completedResourceEpoch).reasons
      const before=snap(),frame=await draw(o),after=snap()
      const blocking=Object.fromEntries(Object.keys(after).map(k=>[k,{count:after[k].started-before[k].started,wallMs:after[k].cpuWaitMs-before[k].cpuWaitMs}]))
      return {...ret,frame,profile,blocking,details:o.details}}
    for(const owner of owners){await draw(owner,true);await draw(owner)}
    const bits=o=>new Uint32Array(o.raw.buffer,o.raw.byteOffset,o.raw.byteLength/4)
    const a=bits(o),b=bits(owners[1]);let diff=0
    if(a.length!==b.length)throw Error('Float length mismatch')
    for(let i=0;i<a.length;i++)if(a[i]!==b[i])diff++
    const hash=await sha(a);if(diff)throw Error(tile+' differs in '+diff+' channels')
    for(const i of [0,1,1,0,1,0,0,1])owners[i].samples.push(await draw(owners[i]))
    return {...ret,diff,channels:a.length,pixelSha256:hash,arms:owners.map(o=>({arm:o.arm,samples:o.samples}))}
   }finally{setGpuDiagnosticSink(undefined);for(const {gpu,kernel}of owners){gpu.driver.poolKey=undefined;gpu.dispose();kernel.free()}}
  },{tile,mode})
  rows.push(row);assert(row.bytes>0);await fs.writeFile(out,JSON.stringify(rows,null,2)+'\n')
  console.log(tile,mode,row.frame?.complete??row.arms.map(a=>a.samples.map(s=>Math.round(s.complete))))
 }
})
