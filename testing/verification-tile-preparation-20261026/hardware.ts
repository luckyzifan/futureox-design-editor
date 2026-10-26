import { initializeKernelModule } from '/@fs/Users/Apple/.codex/worktrees/tile-shared-preparation/design-kernel/frontend/design-client/src/kernel/module.ts'
import { VectorEngine } from '/@fs/Users/Apple/.codex/worktrees/tile-shared-preparation/design-kernel/frontend/design-client/src/generated/design-kernel/design_kernel.js'
import { createGpu } from '/@fs/Users/Apple/.codex/worktrees/tile-shared-preparation/design-kernel/frontend/design-client/src/kernel/gpu/factory.ts'
import { decodeScenePacket } from '/@fs/Users/Apple/.codex/worktrees/tile-shared-preparation/design-kernel/frontend/design-client/src/kernel/gpu/scene-packet.ts'
import { recoverFailedTileRenderer } from '/@fs/Users/Apple/.codex/worktrees/tile-shared-preparation/design-kernel/frontend/design-client/src/kernel/tile-failure.ts'
const report:any={status:'running',scope:'actual hardware RGBA32F target readback; no physical scanout claim',cases:[]}
const publish=()=>{(window as any).__report=report;document.querySelector('#results')!.textContent=JSON.stringify(report)}
const compare=(a:Float32Array,b:Float32Array)=>{
  if(a.byteLength!==b.byteLength)throw Error('Output size changed')
  const x=new Uint32Array(a.buffer,a.byteOffset,a.length),y=new Uint32Array(b.buffer,b.byteOffset,b.length)
  let differences=0;for(let i=0;i<x.length;i++)if(x[i]!==y[i])differences++
  return {words:x.length,differences}
}
try{
  await initializeKernelModule()
  const adapter=await navigator.gpu.requestAdapter();if(!adapter||adapter.info.isFallbackAdapter)throw Error('No hardware WebGPU adapter')
  report.adapter={vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,fallback:adapter.info.isFallbackAdapter};publish()
  const color={documentSpace:'srgb' as const,referenceWhiteNits:203,peakLuminanceNits:1000}
  const ids=Array.from({length:100},(_,i)=>'r'+i),doc:any={schemaVersion:3,id:'d',name:'d',colorManagement:color,
    pages:[{id:'p',name:'p',background:'#ffffff',children:ids}],nodes:Object.fromEntries(ids.map((id,i)=>{
      const a=(i+1)*.0001
      return [id,{id,kind:'rectangle',width:512,height:512,transform:[Math.cos(a),Math.sin(a),-Math.sin(a),Math.cos(a),30,20],
        fills:[{kind:'solid',color:i%2?'#123456':'#bb6622',opacity:.6}]}]
    }))}
  const engine=new VectorEngine(),renderer=await createGpu('webgpu',true,false,color,undefined,false,true)
  const options={pageId:'p',width:514,height:514,view:{x:.25,y:.5,zoom:1},rasterProfile:'figmaSubpixel',prepareViewport:{x:0,y:0,w:600,h:600}}
  const compile=(crop:{x:number;y:number;w:number;h:number})=>decodeScenePacket(engine.compile_gpu_packet(JSON.stringify({...options,width:crop.w,height:crop.h,gpuViewport:crop})))
  try{
    engine.load_document(JSON.stringify(doc))
    await renderer.render(compile({x:0,y:0,w:64,h:64}),true,false)
    let failure:unknown
    try{compile({x:0,y:0,w:514,h:514})}catch(error){failure=error}
    if(!failure)throw Error('Expected unchanged program admission')
    let invalidated=false
    if(!await recoverFailedTileRenderer(failure,renderer,()=>{invalidated=true},false,true)||invalidated)throw Error('Preparation retired GPU resources')
    for(const crop of [{x:0,y:0,w:514,h:257},{x:0,y:257,w:514,h:257}]){
      const scene=compile(crop),fresh=await createGpu('webgpu',true,false,color,undefined,false,true)
      try{
        const actual=(await renderer.render(scene,true,false)).linear!,expected=(await fresh.render(scene,true,false)).linear!
        const diff=compare(actual,expected);report.cases.push({kind:'retained-after-rejected-crop',crop,...diff});publish()
        if(diff.differences)throw Error('Retained cache changed float pixels')
      }finally{fresh.dispose()}
    }
    doc.nodes.r50.transform=[1,0,0,1,32.25,22.5]
    engine.apply_interaction_transforms(JSON.stringify({r50:doc.nodes.r50.transform}))
    const freshEngine=new VectorEngine(),fresh=await createGpu('webgpu',true,false,color,undefined,false,true)
    try{
      freshEngine.load_document(JSON.stringify(doc));const crop={x:0,y:0,w:514,h:257}
      const actual=(await renderer.render(compile(crop),true,false)).linear!
      const scene=decodeScenePacket(freshEngine.compile_gpu_packet(JSON.stringify({...options,width:crop.w,height:crop.h,gpuViewport:crop})))
      const expected=(await fresh.render(scene,true,false)).linear!,diff=compare(actual,expected)
      report.cases.push({kind:'local-edit-after-rejected-crop',...diff});publish();if(diff.differences)throw Error('Local invalidation changed float pixels')
    }finally{fresh.dispose();freshEngine.free()}
  }finally{renderer.dispose();engine.free()}
  report.status='passed'
}catch(error){report.status='failed';report.error=String(error)}
publish()
