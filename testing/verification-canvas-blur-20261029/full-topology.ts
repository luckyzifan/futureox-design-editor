import { initializeKernelModule } from '../../frontend/design-client/src/kernel/module'
import { VectorEngine } from '../../frontend/design-client/src/generated/design-kernel/design_kernel'
import { effect } from '../../frontend/design-client/src/model'
import { WebGpuDriver } from '../../frontend/design-client/src/kernel/gpu/webgpu'
import { GpuRenderer } from '../../frontend/design-client/src/kernel/gpu/renderer'
import { managedSceneImageLoader } from '../../frontend/design-client/src/kernel/scene-image-hydration'
import { DecodedImageCache, createDecodedImageOwner, decodedImageScope } from '../../frontend/design-client/src/kernel/decoded-image-cache'
import { decodeScenePacket } from '../../frontend/design-client/src/kernel/gpu/scene-packet'
const report: any = { status: 'running', scope: 'Full 306-root topology source snapshot, actual native viewport packets, hardware display graph. CPU source/load/compile recorded separately; not physical input-to-screen latency.', cases: [], timings: [] }
async function publish() { document.querySelector('#result')!.textContent = JSON.stringify(report, null, 2); await fetch('/report', { method: 'POST', body: JSON.stringify(report) }) }
const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]
const encode = (v: number) => { v = Math.min(1, Math.max(0, v)); return v <= .0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - .055 }
function difference(a: Float32Array, b: Float32Array) {
  let changedBits = 0, maxEncoded = 0, maxAlpha = 0, nonfinite = 0
  const aa = new Uint32Array(a.buffer, a.byteOffset, a.length), bb = new Uint32Array(b.buffer, b.byteOffset, b.length)
  for (let i = 0; i < a.length; i++) {
    if (aa[i] !== bb[i]) changedBits++
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) { if (aa[i] !== bb[i]) nonfinite++; continue }
    if (i % 4 === 3) maxAlpha = Math.max(maxAlpha, Math.abs(a[i] - b[i]))
    else for (const background of [0, 1]) {
      const alpha = i - i % 4 + 3
      maxEncoded = Math.max(maxEncoded, Math.abs(encode(a[i] + background * (1 - a[alpha])) - encode(b[i] + background * (1 - b[alpha]))))
    }
  }
  return { changedBits, maxEncoded, maxAlpha, nonfinite }
}
function preview(outputs: Float32Array[], width: number, height: number, name: string) {
  const section = document.createElement('section'); section.textContent = name; const pair = document.createElement('div'); pair.className = 'pair'; section.append(pair)
  for (const values of outputs) {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; pair.append(canvas)
    const bytes = new Uint8ClampedArray(values.length)
    for (let i = 0; i < values.length; i += 4) { for (let c = 0; c < 3; c++) bytes[i + c] = Math.round(encode(values[i + c] + 1 - values[i + 3]) * 255); bytes[i + 3] = 255 }
    canvas.getContext('2d')!.putImageData(new ImageData(bytes, width, height), 0, 0)
  }
  document.querySelector('#previews')!.append(section)
}
const mul = (a: number[], b: number[]) => [a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]]
try {
  await initializeKernelModule()
  const adapter=await navigator.gpu.requestAdapter();if(!adapter||adapter.info.isFallbackAdapter)throw Error('Hardware required')
  report.adapter={vendor:adapter.info.vendor,architecture:adapter.info.architecture,fallback:adapter.info.isFallbackAdapter}
  const manifest=await(await fetch('/full-topology/manifest.json')).json();report.source=manifest
  if(manifest.status!=='passed'||!manifest.sourceUnchanged)throw Error('Full source preparation failed')
  const context=await(await fetch('/topology-inputs/shadows.json')).text(),kernel=new VectorEngine();kernel.load_document(context)
  const owner=createDecodedImageOwner(),settings=kernel.color_settings()
  try {for(const packet of manifest.packets){
    report.current=packet.root.name;await publish()
    const bytes=new Uint8Array(await(await fetch('/full-topology/'+packet.file)).arrayBuffer())
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('')
    if(hash!==packet.hash)throw Error('Full-source packet hash mismatch')
    const decoded=decodeScenePacket(bytes),pair:any[]=[],row:any={name:packet.root.name,options:packet.options,nodes:Object.keys(decoded.nodes).length,runs:[[],[]]};report.cases.push(row)
    try{
      for(const enabled of [false,true]){
        const loader=managedSceneImageLoader(new DecodedImageCache(),()=>({kernel,scope:decodedImageScope(owner,settings),settings,current:()=>true,ownerCurrent:()=>true,resourceOwner:owner}),{key:async()=>undefined,read:async()=>undefined,write:()=>{}})
        const driver=await WebGpuDriver.create(true,false,true,true,false),renderer=new GpuRenderer(driver,true,false,loader) as any
        renderer.canvasBlurEnabled=enabled;const finish=driver.finish.bind(driver)
        driver.finish=(t,r,w,h,_readback,presentation,present,output)=>finish(t,r,w,h,true,presentation,present,output)
        pair.push({driver,renderer})
      }
      const outputs:Float32Array[]=[]
      for(let round=0;round<5;round++)for(const side of round%2?[1,0]:[0,1]){
        const start=performance.now(),result=await pair[side].renderer.render({...decoded},false,true),wallMs=performance.now()-start
        if(!result.linear)throw Error('Missing full-source pixels');result.bitmap?.close()
        const r={wallMs,graphMs:result.graphMs,finishMs:result.finishMs,draws:result.drawCalls,pixels:result.passPixels,peakBytes:result.peakTextureBytes,blur:pair[side].driver.canvasBlurPasses,motion:pair[side].driver.canvasMotionBlurPasses,zoom:pair[side].driver.canvasZoomBlurPasses}
        if(round===0)(row.cold??=[])[side]=r;if(round===1)outputs[side]=result.linear;if(round>=2)row.runs[side].push(r);await publish()
      }
      row.difference=difference(outputs[0],outputs[1]);preview(outputs,packet.options.width,packet.options.height,row.name)
      if(row.difference.nonfinite||row.difference.maxEncoded>=1/255||row.difference.maxAlpha>=1/255)throw Error('Full-source quality gate failed')
      row.nonuniformChannels=outputs[0].reduce((n,v,i)=>n+Number(Math.abs(v-outputs[0][i%4])>.01),0)
      if(row.nonuniformChannels<1000)throw Error('Full source viewport does not exercise a visible edge')
      const exact:Float32Array[]=[]
      for(const side of [0,1]){const result=await pair[side].renderer.render({...decoded},true,false);exact[side]=result.linear;if(pair[side].driver.canvasBlurPasses||pair[side].driver.canvasMotionBlurPasses||pair[side].driver.canvasZoomBlurPasses)throw Error('Approximate exact-output path')}
      row.exactOutput=difference(exact[0],exact[1]);if(row.exactOutput.changedBits)throw Error('Full-source exact output changed')
      const controlMs=median(row.runs[0].map((r:any)=>r.wallMs)),candidateMs=median(row.runs[1].map((r:any)=>r.wallMs))
      report.timings.push({name:row.name,controlMs,candidateMs,improvement:1-candidateMs/controlMs,counters:row.runs[1][0]});row.status='passed';await publish()
    }catch(error){row.status='failed';row.error=String(error);await publish()}finally{for(const {renderer}of pair)renderer.dispose()}
  }}finally{kernel.free()}
  report.status=report.cases.every((row:any)=>row.status==='passed')?'passed':'failed'
}catch(error){report.status='failed';report.error=String(error);report.stack=error instanceof Error?error.stack:undefined}
await publish()
