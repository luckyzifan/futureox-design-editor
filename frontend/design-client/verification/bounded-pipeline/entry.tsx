import React,{useState} from 'react'
import {createRoot} from 'react-dom/client'
import {flushSync} from 'react-dom'
import {NativeSourceSurface as Baseline} from './baseline'
import {NativeSourceSurface as Candidate,type NativeSourceStatus} from '../../src/kernel/NativeSourceSurface'
import {desktopBridge,type SourceCanvasSnapshot,type LargeDocumentStatus} from '../../src/desktop'
import {initializeKernelModule} from '../../src/kernel/module'
import {KernelClient,activeKernelClients,type KernelOptions} from '../../src/kernel/client'
import {renderRuntimeEvidence,renderDeviceEvidence} from '../../src/kernel/runtime-evidence'

const width=800,height=600,wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
type Sample={id:string;start:number;sourceReadyAt?:number;firstVisibleAt?:number;readyAt?:number;active:number;maxActive:number;requests:any[];status?:string;[key:string]:any}
const original=KernelClient.prototype.renderSource
let sample:Sample|undefined,stopped=false,resetSurface:()=>void=()=>{},cancelRun:(()=>void)|undefined
KernelClient.prototype.renderSource=function(source,options,receive,signal){
 const row=sample,at=performance.now(),tiles=options.tileViewport?.length??0
 if(row&&tiles){row.active++;row.maxActive=Math.max(row.maxActive,row.active)}
 const result=original.call(this,source,options,receive,signal)
 return result.then(value=>{
  if(row){if(!tiles)row.sourceReadyAt=performance.now();row.requests.push({tiles,wallMs:performance.now()-at,backend:value.backend,
   pipelineWallMs:value.pipelineWallMs,preparationWaitMs:value.preparationWaitMs,overlappedPreparations:value.overlappedPreparations,
   compileMs:value.compileMs,graphMs:value.graphMs,finishMs:value.finishMs,checkpointMs:value.checkpointMs,drawCalls:value.drawCalls,
   peakTextureBytes:value.peakTextureBytes,workingTextureBytes:value.workingTextureBytes,frameResourceBytes:value.frameResourceBytes})}
  return value
 },error=>{row?.requests.push({tiles,wallMs:performance.now()-at,error:String(error)});throw error})
 .finally(()=>{if(row&&tiles)row.active--})
}
const hex=(bytes:ArrayBuffer)=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('')
async function capture(index:number,variant:string){
 const client=activeKernelClients()[0];if(!client)throw Error('Missing active source renderer')
 const {bitmap,frame}=await client.captureContentBitmap()
 const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d',{willReadFrequently:true})!
 ctx.drawImage(bitmap,0,0);bitmap.close()
 const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data
 let changedPixels=0;for(let i=4;i<pixels.length;i+=4)if(pixels[i]!==pixels[0]||pixels[i+1]!==pixels[1]||pixels[i+2]!==pixels[2]||pixels[i+3]!==pixels[3])changedPixels++
 const sha256=hex(await crypto.subtle.digest('SHA-256',pixels))
 const response=await fetch(`/__precision_image?name=pose-${index}-${variant==='A'?'live':'fresh'}`,{method:'POST',body:await canvas.convertToBlob({type:'image/png'})})
 if(!response.ok)throw Error('Could not persist GPU pixel result')
 return {width:canvas.width,height:canvas.height,sha256,changedPixels,frame}
}

function Check(){
 const [label,setLabel]=useState('选择真实 Sketch。仅复制读取，不修改原文件。'),[source,setSource]=useState<SourceCanvasSnapshot>(),[opened,setOpened]=useState<LargeDocumentStatus>()
 const [surface,setSurface]=useState<React.ReactNode>(),[busy,setBusy]=useState(false),[summary,setSummary]=useState<any>()
 resetSurface=()=>flushSync(()=>setSurface(undefined))
 const publish=async(value:any)=>{
  flushSync(()=>setSummary({...value}));console.log('GPU PIPELINE REPORT '+JSON.stringify(value))
  const result=await fetch('/__render_report',{method:'POST',body:JSON.stringify(value)})
  if(!result.ok)throw Error('Could not persist performance report')
 }
 const load=async()=>{
  setBusy(true);setLabel('正在索引并生成原生源快照…')
  try{
   await initializeKernelModule();const bridge=desktopBridge()!.largeDocument!
   if(opened){resetSurface();await bridge.close({owner:opened.owner,expectedRevision:opened.revision});setSource(undefined)}
   const start=performance.now(),file=await bridge.open()
   if(file.status!=='ok')throw Error(file.status==='error'?file.message:'已取消选择')
   setOpened(file)
   const result=await bridge.canvasSnapshot({owner:file.owner,expectedRevision:file.revision})
   if(result.status!=='ok')throw Error(result.status==='error'?result.message:'已取消快照')
   setSource(result);setSummary({status:'loaded',name:file.name,nodes:result.nodes,roots:result.roots,importAndSnapshotMs:performance.now()-start})
   setLabel(`已载入 ${file.name}：${result.nodes} 节点、${result.roots} 素材。`)
  }catch(error){setLabel(String(error));await publish({status:'load-error',error:String(error)})}finally{setBusy(false)}
 }
 const run=async(topology:boolean)=>{
  if(!source||!opened)return
  stopped=false;setBusy(true)
  const bridge=desktopBridge()!.largeDocument!,report:any={status:'running',name:opened.name,nodes:source.nodes,roots:source.roots,width,height,runtime:await renderRuntimeEvidence(),samples:[],scope:'production NativeSourceSurface + native preparation + hardware GPU; presentation ACK and target readback, not physical scanout'}
  try{
   const config=await (await fetch('/__render_fixture')).json()
   const catalog=await bridge.canvasLayout({owner:opened.owner,expectedRevision:opened.revision,offset:0,limit:1})
   if(catalog.status!=='ok'||!catalog.items.length)throw Error('Missing source catalogue')
   const bounds=catalog.items[0].placed,z=Math.min((width-64)/bounds.width,(height-64)/bounds.height)
   const view=topology?config.topologyView:{zoom:z,x:(width-bounds.width*z)/2-bounds.x*z,y:(height-bounds.height*z)/2-bounds.y*z}
   report.view=view;report.caseId=topology?'topology-icon-400':'first-artboard-fit';report.catalogueFirst={name:catalog.items[0].name,placed:bounds};await publish(report)
   const order:string[]=config.runs
   for(let index=0;index<order.length;index++){
    if(stopped)throw Error('用户停止测试')
    const id=order[index],variant=id[0],Component=variant==='A'?Baseline:Candidate
    setLabel(`${id} / ${order.length}：${variant==='A'?'原始单块':'有限两块流水线'}，等待完整清晰画面…`)
    const row:Sample={id,start:performance.now(),active:0,maxActive:0,requests:[]};sample=row
    await new Promise<void>((resolve,reject)=>{
     const timer=setTimeout(()=>reject(Error('固定测试等待超过 10 分钟')),600000)
     cancelRun=()=>{clearTimeout(timer);reject(Error('用户停止测试'))}
     const status=(value:NativeSourceStatus)=>{if(value.phase==='error'){clearTimeout(timer);reject(Error(value.error))}}
     flushSync(()=>setSurface(<Component key={id} source={source} view={view} width={width} height={height} onStatus={status}
      onPresented={(_frame,complete)=>{row.firstVisibleAt??=performance.now();if(complete&&row.readyAt===undefined){row.readyAt=performance.now();clearTimeout(timer);resolve()}}}/>))
    })
    // Readback and device metadata are outside the timed render interval.
    while(row.active)await wait(10)
    row.totalMs=row.readyAt!-row.start;row.renderReadyMs=row.readyAt!-(row.sourceReadyAt??row.start)
    row.firstVisibleMs=row.firstVisibleAt!-(row.sourceReadyAt??row.start)
    row.sourceLoadMs=(row.sourceReadyAt??row.start)-row.start
    row.pixels=await capture(index,variant);row.devices=await renderDeviceEvidence()
    if(row.pixels.changedPixels<1000)throw Error('参考视口缺少足够非背景像素，不能计作性能样本')
    row.status='complete';report.samples.push(row);await publish(report)
    sample=undefined;resetSurface();await wait(250)
   }
   const measured=report.samples.filter((r:any)=>!r.id.includes('warm')),median=(v:number[])=>v.slice().sort((a,b)=>a-b)[Math.floor(v.length/2)]
   const a=measured.filter((r:any)=>r.id[0]==='A'),b=measured.filter((r:any)=>r.id[0]==='B')
   report.baselineMedianMs=median(a.map((r:any)=>r.renderReadyMs));report.candidateMedianMs=median(b.map((r:any)=>r.renderReadyMs))
   report.improvement=1-report.candidateMedianMs/report.baselineMedianMs
   report.pixelHashesMatch=new Set(report.samples.map((r:any)=>r.pixels.sha256)).size===1
   report.maxRasterRequests=Math.max(...report.samples.map((r:any)=>r.maxActive))
   report.status='complete';setLabel(`对照完成：原始 ${report.baselineMedianMs.toFixed(1)}ms，候选 ${report.candidateMedianMs.toFixed(1)}ms，变化 ${(report.improvement*100).toFixed(1)}%。`)
  }catch(error){report.status='failed';report.error=String(error);if(sample)report.incompleteSample=sample;setLabel(String(error))}
  finally{sample=undefined;cancelRun=undefined;resetSurface();setBusy(false);await publish(report)}
 }
 const cancellationCheck=async()=>{
  if(!source||!opened)return
  setBusy(true);const report:any={status:'running-cancellation',name:opened.name,runtime:await renderRuntimeEvidence(),errors:[]}
  let target={x:0,y:0,zoom:1},ready:(()=>void)|undefined
  const render=()=>flushSync(()=>setSurface(<Candidate key="cancellation-check" source={source} view={target} width={width} height={height}
   onStatus={status=>{if(status.phase==='error')report.errors.push(status.error)}}
   onPresented={(frame,complete)=>{if(complete&&frame.view.x===target.x&&frame.view.y===target.y&&frame.view.zoom===target.zoom)ready?.()}}/>))
  const settle=()=>new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('Cancellation recovery did not settle')),120000)
   ready=()=>{clearTimeout(timer);ready=undefined;resolve()};cancelRun=()=>{clearTimeout(timer);reject(Error('用户停止测试'))};render()
  })
  try{
   const bridge=desktopBridge()!.largeDocument!,catalog=await bridge.canvasLayout({owner:opened.owner,expectedRevision:opened.revision,offset:0,limit:1})
   if(catalog.status!=='ok'||!catalog.items.length)throw Error('Missing catalogue')
   const b=catalog.items[0].placed,z=Math.min((width-64)/b.width,(height-64)/b.height),center={x:b.x+b.width/2,y:b.y+b.height/2}
   const camera=(zoom:number)=>({zoom,x:width/2-center.x*zoom,y:height/2-center.y*zoom})
   target=camera(z);setLabel('取消验证：建立当前精确参考画面…')
   const row:Sample={id:'cancellation',start:performance.now(),active:0,maxActive:0,requests:[]};sample=row
   await settle();report.before=await capture(100,'A')
   setLabel('取消验证：快速放大、反向缩放，再返回原视口…')
   const started=performance.now();target=camera(z*16);render();await wait(80)
   target=camera(z*4);render();await wait(80)
   target=camera(z);await settle();report.returnToReadyMs=performance.now()-started
   await wait(500);report.after=await capture(100,'B');report.requests=row.requests
   report.maxRasterRequests=row.maxActive;report.cancelledRequests=row.requests.filter(value=>value.error?.includes('PREVIEW_CANCELLED')).length
   report.device=await renderDeviceEvidence();report.pixelsIdentical=report.before.sha256===report.after.sha256
   if(report.errors.length||!report.pixelsIdentical||report.cancelledRequests<1||row.maxActive>1)throw Error('Cancellation ownership/pixel checks failed')
   report.status='cancellation-pass';setLabel('取消验证通过：过期任务已取消，返回后的像素与原精确画面一致。')
  }catch(error){report.status='cancellation-failed';report.error=String(error);setLabel(String(error))}
  finally{sample=undefined;cancelRun=undefined;resetSurface();setBusy(false);await publish(report)}
 }
 return <main style={{fontFamily:'system-ui',padding:16,background:'#f4f5f7',minHeight:'100vh'}}>
  <h2 style={{margin:'0 0 12px'}}>有限流水线 · 实机 A/B 对照</h2>
  <div style={{display:'flex',gap:12}}><button disabled={busy} onClick={()=>void load()}>打开真实 Sketch</button>
   <button disabled={busy||!source} onClick={()=>void run(true)}>拓扑入库图标 · 400% 对照</button>
   <button disabled={busy||!source} onClick={()=>void run(false)}>首素材适配 · 对照</button>
   <button disabled={busy||!source} onClick={()=>void cancellationCheck()}>快速变向取消验证</button>
   <button disabled={!busy} onClick={()=>{stopped=true;cancelRun?.();resetSurface();void desktopBridge()?.largeDocument?.cancel()}}>停止</button></div>
  <p role="status">{label}</p>
  <div style={{position:'relative',width,height,background:'#ddd',overflow:'hidden'}}>{surface}</div>
  <pre style={{fontSize:12,whiteSpace:'pre-wrap',maxHeight:180,overflow:'auto'}}>{summary?JSON.stringify({status:summary.status,nodes:summary.nodes,runs:summary.samples?.map((row:any)=>({id:row.id,renderMs:row.renderReadyMs,firstVisibleMs:row.firstVisibleMs,overlapped:row.requests.reduce((n:number,r:any)=>n+(r.overlappedPreparations??0),0)})),improvement:summary.improvement,pixelHashesMatch:summary.pixelHashesMatch,error:summary.error},null,2):''}</pre>
 </main>
}
createRoot(document.getElementById('root')!).render(<Check/> )
