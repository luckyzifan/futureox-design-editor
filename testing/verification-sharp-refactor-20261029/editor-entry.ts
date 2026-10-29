import {KernelClient,activeKernelClients} from '../../frontend/design-client/src/kernel/client'
import {renderRuntimeEvidence,renderDeviceEvidence} from '../../frontend/design-client/src/kernel/runtime-evidence'
const observed=new WeakMap<KernelClient,any>(),wrapped=new WeakMap<KernelClient,unknown>()
const original=KernelClient.prototype.present
let measurement:any
KernelClient.prototype.present=function(frame){
 if(this.onPresentation!==wrapped.get(this)){
  const next=this.onPresentation,client=this
  const listener:NonNullable<KernelClient['onPresentation']>=stats=>{
   const row={at:performance.now(),...stats};observed.set(client,row)
   if(measurement){
    if(measurement.presentations.length>=20000)throw Error('Presentation evidence capacity exceeded')
    measurement.presentations.push(row)
   }
   next?.(stats)
  }
  this.onPresentation=listener;wrapped.set(this,listener)
 }
 return original.call(this,frame)
}
const frame=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()))
const camera=()=>{
 const e=document.querySelector<HTMLElement>('.kernel-tiles')
 if(!e)throw Error('Ordinary canvas missing')
 return {x:Number(e.dataset.requestedCameraX),y:Number(e.dataset.requestedCameraY),zoom:Number(e.dataset.requestedCameraZoom)}
}
const equal=(a:any,b:any)=>a&&b&&a.x===b.x&&a.y===b.y&&a.zoom===b.zoom
async function capture(){
 const target=camera(),clients=activeKernelClients().filter(c=>equal(observed.get(c)?.presented?.view,target))
 if(clients.length!==1)throw Error('Ambiguous actual canvas presentation owner')
 const result=await clients[0].captureContentBitmap(),canvas=new OffscreenCanvas(result.bitmap.width,result.bitmap.height)
 const ctx=canvas.getContext('2d',{willReadFrequently:true})!
 ctx.drawImage(result.bitmap,0,0);result.bitmap.close()
 const bytes=ctx.getImageData(0,0,canvas.width,canvas.height).data,pixelsAvailableAt=performance.now()
 if(!equal(result.frame.view,target)||!equal(camera(),target))throw Error('Camera changed during readback')
 const quality=observed.get(clients[0])
 if(quality?.presented?.presentationId!==result.frame.presentationId||quality.maxUpscale!==1||quality.sharpCoverage!==1||quality.nativePhaseCoverage!==1||!quality.nativeCoverageComplete||!quality.pixelCoverageComplete)throw Error('Latest native pixel coverage unproved')
 let transparentPixels=0;for(let i=3;i<bytes.length;i+=4)if(bytes[i]!==255)transparentPixels++
 const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('')
 return {target,frame:result.frame,width:canvas.width,height:canvas.height,pixelsAvailableAt,transparentPixels,sha256,quality:{maxUpscale:quality.maxUpscale,sharpCoverage:quality.sharpCoverage,nativePhaseCoverage:quality.nativePhaseCoverage,nativeCoverageComplete:quality.nativeCoverageComplete,pixelCoverageComplete:quality.pixelCoverageComplete}}
}
document.addEventListener('wheel',event=>{
 if(measurement)measurement.inputs.push({at:performance.now(),trusted:event.isTrusted,dx:event.deltaX,dy:event.deltaY,ctrl:event.ctrlKey})
},true)
;(window as any).__strictNavigation={
 runtime:renderRuntimeEvidence,capture,
 begin:()=>{measurement={startedAt:performance.now(),initial:camera(),inputs:[],presentations:[]}},
 finish:async(expectedInputs:number)=>{
  const current=measurement;if(!current)throw Error('Probe not started')
  const started=performance.now()
  while(current.inputs.length<expectedInputs){if(performance.now()-started>10000)throw Error('Native input delivery timeout');await frame()}
  await frame()
  while(document.querySelector<HTMLElement>('.kernel-tiles')?.dataset.detailReady!=='true'){
   if(document.querySelector('.kernel-status.error'))throw Error('Canvas render failure')
   if(performance.now()-started>180000)throw Error('Native completion timeout')
   await frame()
  }
  current.pixels=await capture();current.captureFinishedAt=performance.now();measurement=undefined
  current.stopToNativePixelsMs=current.pixels.pixelsAvailableAt-current.inputs.at(-1).at
  current.devices=await renderDeviceEvidence()
  current.maximumMotionUpscale=Math.max(...current.presentations.filter((p:any)=>p.at>=current.inputs[0]?.at&&p.at<=current.inputs.at(-1)?.at&&Number.isFinite(p.maxUpscale)).map((p:any)=>p.maxUpscale))
  current.scope='Trusted Electron wheel events; GPU readback after latest ordinary canvas readiness. Presentation callbacks are diagnostic ACKs, not visible-pixel P95.'
  return current
 }
}
void import('../../frontend/design-client/src/main')
