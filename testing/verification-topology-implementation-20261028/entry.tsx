import React,{useEffect,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {flushSync} from 'react-dom'
import {NativeSourceSurface,type NativeSourceStatus} from '../../frontend/design-client/src/kernel/NativeSourceSurface'
import {desktopBridge,type SourceCanvasSnapshot} from '../../frontend/design-client/src/desktop'
import {initializeKernelModule} from '../../frontend/design-client/src/kernel/module'
import {KernelClient,activeKernelClients} from '../../frontend/design-client/src/kernel/client'
import {renderRuntimeEvidence,renderDeviceEvidence} from '../../frontend/design-client/src/kernel/runtime-evidence'
import {evaluateReport,countRenderStalls} from './report-contract.mjs'

type Camera={x:number;y:number;zoom:number}
type Sample={id:string;start:number;target:Camera;active:number;maxActive:number;requests:any[];presentations:any[];errors:string[];stalls:any[];[key:string]:any}
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
const original=KernelClient.prototype.renderSource, owners=new WeakMap<KernelClient,Sample>(),wrapped=new WeakSet<KernelClient>()
let current:Sample|undefined
const numeric=(value:any)=>Object.fromEntries(Object.entries(value).filter(([,v])=>typeof v==='number'||typeof v==='boolean'||typeof v==='string'))
KernelClient.prototype.renderSource=function(source,options,receive,signal){
 const row=current,at=performance.now(),tiles=options.tileViewport?.length??0
 if(row)owners.set(this,row)
 if(!wrapped.has(this)){
  wrapped.add(this);const next=this.onPresentation
  this.onPresentation=stats=>{
   const owner=owners.get(this)
   if(owner){owner.presentations.push({at:performance.now()-owner.start,...numeric(stats),presented:stats.presented});if(stats.error)owner.errors.push(String(stats.error))}
   next?.(stats)
  }
 }
 if(row&&tiles){row.active++;row.maxActive=Math.max(row.maxActive,row.active)}
 return original.call(this,source,options,tile=>{
  if(row){row.firstTileAt??=performance.now();row.tiles.push({at:performance.now()-row.start,...numeric(tile)})}
  receive?.(tile)
 },signal).then(result=>{
  if(row){if(!tiles)row.sourceReadyAt=performance.now();row.requests.push({tiles,wallMs:performance.now()-at,...numeric(result)})}
  return result
 },error=>{row?.requests.push({tiles,wallMs:performance.now()-at,error:String(error)});throw error})
 .finally(()=>{if(row&&tiles)row.active--})
}
async function capture(index:number){
 const client=activeKernelClients()[0];if(!client)throw Error('Missing production source client')
 const {bitmap,frame}=await client.captureContentBitmap(),canvas=new OffscreenCanvas(bitmap.width,bitmap.height)
 const ctx=canvas.getContext('2d',{willReadFrequently:true})!;ctx.drawImage(bitmap,0,0);bitmap.close()
 const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data
 let changedPixels=0,transparentPixels=0
 for(let i=0;i<pixels.length;i+=4){if(pixels[i+3]!==255)transparentPixels++;if(pixels[i]!==pixels[0]||pixels[i+1]!==pixels[1]||pixels[i+2]!==pixels[2]||pixels[i+3]!==pixels[3])changedPixels++}
 const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',pixels)),sha256=Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('')
 const response=await fetch(`/__precision_image?name=pose-${index}-live`,{method:'POST',body:await canvas.convertToBlob({type:'image/png'})})
 if(!response.ok)throw Error('Pixel evidence write failed')
 return {width:canvas.width,height:canvas.height,sha256,changedPixels,transparentPixels,frame}
}
function Check(){
 const [surface,setSurface]=useState<React.ReactNode>(),[label,setLabel]=useState('准备固定真实文件测试…'),[summary,setSummary]=useState('')
 useEffect(()=>{let alive=true,raf=0,last=performance.now(),stop=false
  const tick=(now:number)=>{if(current&&now-last>250)current.stalls.push({at:now-current.start,gapMs:now-last,visible:document.visibilityState==='visible',stage:current.measurementStage});last=now;if(alive)raf=requestAnimationFrame(tick)}
  raf=requestAnimationFrame(tick)
  async function run(){
   const config=await(await fetch('/__render_fixture')).json(),{width,height}=config.viewport
   const report:any={format:1,status:'running',startedAt:new Date().toISOString(),config,runtime:await renderRuntimeEvidence(),samples:[],
    scope:'Production native source importer/compiler/Surface/WebGPU; deterministic camera props. Target bitmap + ACK, not trusted OS input or physical scanout.'}
   const publish=async()=>{setSummary(JSON.stringify({status:report.status,samples:report.samples.map((r:any)=>({id:r.id,status:r.status,totalMs:r.totalMs,renderReadyMs:r.renderReadyMs,error:r.error})),assessment:report.assessment},null,2));const r=await fetch('/__render_report',{method:'POST',body:JSON.stringify(report)});if(!r.ok)throw Error('Report write failed')}
   let opened:any
   try{
    await publish();setLabel('正在真实导入下载目录的拓扑 Sketch，并生成完整源快照…')
    await initializeKernelModule();const bridge=desktopBridge()!.largeDocument!,at=performance.now()
    opened=await bridge.open();if(opened.status!=='ok')throw Error(opened.message||'Source selection cancelled')
    const importedAt=performance.now(),source=await bridge.canvasSnapshot({owner:opened.owner,expectedRevision:opened.revision})
    if(source.status!=='ok')throw Error(source.message||'Snapshot cancelled')
    report.source={name:opened.name,nodes:source.nodes,roots:source.roots,bounds:source.bounds,importMs:importedAt-at,snapshotMs:performance.now()-importedAt,indexedObjects:opened.indexedObjects}
    const catalog:any[]=[]
    for(let offset=0;;){const result=await bridge.canvasLayout({owner:opened.owner,expectedRevision:opened.revision,offset,limit:200});if(result.status!=='ok')throw Error('Catalogue failed');catalog.push(...result.items);if(!result.hasMore)break;offset+=result.items.length}
    report.catalogue={total:catalog.length,first:catalog[0]};await publish()
    if(source.roots!==config.sourceRoots||catalog.length!==config.sourceRoots)throw Error('Full source count mismatch')
    const camera=(zoom:number):Camera=>({zoom,x:width/2-config.worldCenter.x*zoom,y:height/2-config.worldCenter.y*zoom})
    const bounds=source.bounds,fit=Math.min((width-64)/bounds.width,(height-64)/bounds.height)
    const views:Record<string,Camera>={overview:{zoom:fit,x:(width-bounds.width*fit)/2-bounds.x*fit,y:(height-bounds.height*fit)/2-bounds.y*fit},'detail-3200':camera(32),'fractional-125':{...camera(1.25),x:camera(1.25).x+.25,y:camera(1.25).y+.375}}
    for(let index=0;index<config.runs.length&&!stop;index++){
     const id=config.runs[index],row:Sample={id,start:performance.now(),target:views[id]||camera(4),active:0,maxActive:0,requests:[],tiles:[],presentations:[],errors:[],stalls:[],status:'running',measurementStage:'render'}
     current=row;report.samples.push(row);setLabel(`${index+1}/${config.runs.length} · ${id} · 等待当前密度完整呈现`)
     let resolveReady:(()=>void)|undefined,rejectReady:((error:Error)=>void)|undefined
     const render=()=>flushSync(()=>setSurface(<NativeSourceSurface key={id} source={source as SourceCanvasSnapshot} view={row.target} width={width} height={height}
      onStatus={(status:NativeSourceStatus)=>{row.lastStatus=status;if(status.phase==='error'){row.errors.push(status.error||'Render failure');rejectReady?.(Error(status.error))}}}
      onPresented={(frame,complete)=>{row.firstVisibleAt??=performance.now();if(complete&&['x','y','zoom'].every(k=>(frame.view as any)[k]===(row.target as any)[k])&&frame.dpr===devicePixelRatio&&frame.width===width&&frame.height===height){row.lastCompleteAt=performance.now();if(resolveReady){row.readyAt=row.lastCompleteAt;resolveReady()}}}}/>))
     const settle=()=>new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{resolveReady=undefined;rejectReady=undefined;reject(Error('Fixed observation timeout'))},config.timeoutMs);resolveReady=()=>{clearTimeout(timer);resolveReady=undefined;rejectReady=undefined;resolve()};rejectReady=error=>{clearTimeout(timer);resolveReady=undefined;rejectReady=undefined;reject(error)};render()})
     try{
      await publish();await settle()
      if(id==='motion-return'){
       row.initialReadyMs=row.readyAt-row.start;row.motionStartedAt=performance.now();row.inputs=[];row.measurementStage='motion'
       for(let step=1;step<=config.motion.steps;step++){
        const fraction=step/config.motion.steps,triangle=fraction<=.5?fraction*2:(1-fraction)*2
        row.target=camera(config.motion.zoomFrom*(config.motion.zoomPeak/config.motion.zoomFrom)**triangle)
        row.inputs.push({at:performance.now()-row.start,view:{...row.target}});render();await delay(config.motion.intervalMs)
       }
       row.target=camera(4);row.motionStoppedAt=performance.now();await settle();row.stopToReadyMs=row.readyAt-row.motionStoppedAt
      }
      row.measurementStage='drain';while(row.active)await delay(10);row.afterReadyDrainMs=performance.now()-row.readyAt
      row.totalMs=row.readyAt-row.start;row.renderReadyMs=row.readyAt-(row.sourceReadyAt??row.start)
      row.sourceLoadMs=(row.sourceReadyAt??row.start)-row.start;row.firstVisibleMs=row.firstVisibleAt-(row.sourceReadyAt??row.start)
      row.measurementStage='readback';row.pixels=await capture(index);row.devices=await renderDeviceEvidence();row.status='complete'
      const quality=row.presentations.filter(p=>Number.isFinite(p.maxUpscale))
      row.qualitySummary={samples:quality.length,maxUpscale:quality.length?Math.max(...quality.map(p=>p.maxUpscale)):null,minCoverage:quality.length?Math.min(...quality.map(p=>p.coverage??1)):null,last:quality.at(-1)}
      row.visibleUiStalls=countRenderStalls(row.stalls)
      console.log('GPU TOPOLOGY CASE '+JSON.stringify({id,status:row.status,totalMs:row.totalMs,renderReadyMs:row.renderReadyMs,stopToReadyMs:row.stopToReadyMs,pixels:row.pixels.sha256}))
      // Permit the owned Electron host to capture a GUI screenshot after the
      // timed interval. This delay is excluded from all render measurements.
      await delay(350)
     }catch(error){row.status='failed';row.error=String(error);row.observedMs=performance.now()-row.start;row.sourceLoadMs=row.sourceReadyAt===undefined?undefined:row.sourceReadyAt-row.start;row.firstVisibleMs=row.firstVisibleAt===undefined?undefined:row.firstVisibleAt-(row.sourceReadyAt??row.start);console.log('GPU TOPOLOGY CASE '+JSON.stringify({id,status:row.status,error:row.error}))}
     finally{current=undefined;flushSync(()=>setSurface(undefined));await delay(500);await publish()}
    }
    report.assessment=evaluateReport(report,config);report.status=report.assessment.status==='PASS'?'baseline-complete':'baseline-failed'
   }catch(error){report.status='failed';report.error=String(error)}
   finally{
    current=undefined;flushSync(()=>setSurface(undefined))
    if(opened?.status==='ok')try{await desktopBridge()!.largeDocument!.close({owner:opened.owner,expectedRevision:opened.revision})}catch(error){report.closeError=String(error)}
    report.finishedAt=new Date().toISOString();setLabel(`基线测试结束：${report.status}`);await publish();console.log('GPU TOPOLOGY_TEST_DONE '+JSON.stringify({status:report.status}))
   }
  }
  void run().catch(error=>{setLabel(String(error));console.log('GPU TOPOLOGY_TEST_DONE '+JSON.stringify({status:'harness-error',error:String(error)}))})
  return()=>{alive=false;stop=true;cancelAnimationFrame(raf)}
 },[])
 return <main style={{fontFamily:'system-ui',padding:16,background:'#f4f5f7',minHeight:'100vh'}}><h2>拓扑真实文件 · 修改前基线</h2><p role="status">{label}</p><div style={{position:'relative',width:800,height:600,overflow:'hidden',background:'#ddd'}}>{surface}</div><pre style={{fontSize:11,maxHeight:180,overflow:'auto'}}>{summary}</pre></main>
}
createRoot(document.getElementById('root')!).render(<Check/> )
