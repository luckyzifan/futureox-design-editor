import React,{useState} from 'react'
import {createRoot} from 'react-dom/client'
import {flushSync} from 'react-dom'
import {NativeSourceSurface as Baseline} from './baseline'
import {NativeSourceSurface as Candidate,type NativeSourceStatus} from '../../src/kernel/NativeSourceSurface'
import {desktopBridge,type SourceCanvasSnapshot,type LargeDocumentStatus} from '../../src/desktop'
import {initializeKernelModule} from '../../src/kernel/module'
import {KernelClient,activeKernelClients} from '../../src/kernel/client'
import {renderRuntimeEvidence,renderDeviceEvidence} from '../../src/kernel/runtime-evidence'
const width=800,height=600,wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
let recording:any
const renderSource=KernelClient.prototype.renderSource
KernelClient.prototype.renderSource=function(source,options,receive,signal){
 const row=recording,stage=row?.stage,start=performance.now(),tiles=options.tileViewport||[],prefetch=tiles.length>0&&tiles.every(t=>t.prefetch)
 if(row&&tiles.length){row.active++;row.maxActive=Math.max(row.maxActive,row.active)}
 return renderSource.call(this,source,options,receive,signal).then(result=>{
  row?.requests.push({start,ms:performance.now()-start,stage,tiles:tiles.length,prefetch,keys:tiles.map(t=>t.key),
   backend:result.backend,compileMs:result.compileMs,graphMs:result.graphMs,finishMs:result.finishMs,checkpointMs:result.checkpointMs,
   drawCalls:result.drawCalls,peakTextureBytes:result.peakTextureBytes,overlappedPreparations:result.overlappedPreparations})
  return result
 },error=>{row?.requests.push({start,ms:performance.now()-start,stage,tiles:tiles.length,prefetch,error:String(error)});throw error})
 .finally(()=>{if(row&&tiles.length)row.active--})
}
let captureIndex=0
async function capture(){
 const client=activeKernelClients()[0];if(!client)throw Error('Missing source client')
 const {bitmap}=await client.captureContentBitmap(),canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d',{willReadFrequently:true})!
 ctx.drawImage(bitmap,0,0);bitmap.close()
 const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data
 let changed=0;for(let i=4;i<pixels.length;i+=4)if(pixels[i]!==pixels[0]||pixels[i+1]!==pixels[1]||pixels[i+2]!==pixels[2]||pixels[i+3]!==pixels[3])changed++
 const sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',pixels))].map(b=>b.toString(16).padStart(2,'0')).join('')
 const file=`pose-${++captureIndex}-${recording?.id[0]==='A'?'live':'fresh'}`
 const response=await fetch(`/__precision_image?name=${file}`,{method:'POST',body:await canvas.convertToBlob({type:'image/png'})})
 if(!response.ok)throw Error('Pixel artifact write failed')
 return {sha256,changed,width:canvas.width,height:canvas.height,file}
}
function Check(){
 const [source,setSource]=useState<SourceCanvasSnapshot>(),[opened,setOpened]=useState<LargeDocumentStatus>()
 const [surface,setSurface]=useState<React.ReactNode>(),[label,setLabel]=useState('Ready to load'),[busy,setBusy]=useState(false),[summary,setSummary]=useState<any>()
 const publish=async(report:any)=>{flushSync(()=>setSummary({...report}));const r=await fetch('/__render_report',{method:'POST',body:JSON.stringify(report)});if(!r.ok)throw Error('Report write failed')}
 const load=async()=>{
  setBusy(true)
  try {
   await initializeKernelModule();const bridge=desktopBridge()!.largeDocument!,file=await bridge.open()
   if(file.status!=='ok')throw Error('Source selection failed');setOpened(file)
   const snapshot=await bridge.canvasSnapshot({owner:file.owner,expectedRevision:file.revision})
   if(snapshot.status!=='ok')throw Error('Source snapshot failed');setSource(snapshot);setLabel(`Loaded ${file.name}: ${snapshot.nodes} nodes`)
  }catch(e){setLabel(String(e))}finally{setBusy(false)}
 }
 const run=async()=>{
  if(!source||!opened)return
  setBusy(true)
  const config=await(await fetch('/__render_fixture')).json(),report:any={status:'running',name:opened.name,nodes:source.nodes,roots:source.roots,width,height,config,runtime:await renderRuntimeEvidence(),samples:[]}
  let idCounter=0
  try {
   for(const id of config.runs as string[]) {
    const Component=id[0]==='A'?Baseline:Candidate,row:any={id,active:0,maxActive:0,stage:'initial',requests:[],poses:[]};recording=row
    let target={...config.view},expectedX=target.x,settled:(()=>void)|undefined,rejectWork:((reason:Error)=>void)|undefined
    const status=(s:NativeSourceStatus)=>{if(s.phase==='error')rejectWork?.(Error(s.error))}
    const show=()=>flushSync(()=>setSurface(<Component key={idCounter} source={source} view={target} width={width} height={height}
     onStatus={status} onPresented={(frame,complete)=>{if(complete&&frame.view.x===expectedX&&frame.view.y===target.y&&frame.view.zoom===target.zoom)settled?.()}}/>))
    const atTarget=(action:()=>void)=>new Promise<void>((resolve,reject)=>{
     const timer=setTimeout(()=>reject(Error('Viewport did not settle within 180 seconds')),180000)
     rejectWork=e=>{clearTimeout(timer);reject(e)};settled=()=>{clearTimeout(timer);settled=undefined;resolve()};action()
    })
    idCounter++;setLabel(`${id}: initial viewport`);const begin=performance.now();await atTarget(show);row.initialMs=performance.now()-begin
    row.stage='idle';await wait(config.idleMs);row.idlePrefetchActive=row.active
    for(const dx of config.pans as number[]) {
     row.stage=`pan:${dx}`;setLabel(`${id}: pan ${dx}`)
     const start=performance.now(),from=target.x,to=config.view.x+dx
     expectedX=to
     // Fixed camera input sequence, same production planner, queues and GPU.
     await atTarget(()=>{void(async()=>{for(let step=1;step<=8;step++){target={...target,x:from+(to-from)*step/8};show();await wait(16)}})()})
     row.poses.push({dx,readyMs:performance.now()-start,pixels:await capture()})
    }
    row.devices=await renderDeviceEvidence()
    row.stage='closing';flushSync(()=>setSurface(undefined));await wait(100)
    row.status='complete';report.samples.push(row);await publish(report);recording=undefined
   }
   report.devices=await renderDeviceEvidence();report.status='complete';setLabel('Complete')
  }catch(e){report.status='failed';report.error=String(e);report.incomplete=recording;setLabel(String(e))}
  finally{flushSync(()=>setSurface(undefined));recording=undefined;setBusy(false);await publish(report)}
 }
 return <main style={{fontFamily:'system-ui',padding:12,background:'#eee'}}>
  <button disabled={busy} onClick={()=>void load()}>Load real source</button>
  <button disabled={busy||!source} onClick={()=>void run()}>Run pan comparison</button>
  <p role="status">{label}</p><div style={{position:'relative',width,height,overflow:'hidden'}}>{surface}</div>
  <pre data-testid="report">{summary?JSON.stringify({status:summary.status,samples:summary.samples?.length,error:summary.error}):''}</pre>
 </main>
}
createRoot(document.getElementById('root')!).render(<Check/> )
