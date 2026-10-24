import { initializePicking } from '../../frontend/design-client/src/kernel/picking'
import { VectorEngine } from '../../frontend/design-client/src/generated/design-kernel/design_kernel'
import { createGpu } from '../../frontend/design-client/src/kernel/gpu/factory'
// @ts-expect-error isolated Vite reference loader; never imported by the product
import { createGpu as createReference } from '../../frontend/design-client/src/kernel/gpu/factory.ts?reference'
import { decodeScenePacket } from '../../frontend/design-client/src/kernel/gpu/scene-packet'
import { FrameResources } from '../../frontend/design-client/src/kernel/gpu/frame-resources'
import { renderRuntimeEvidence } from '../../frontend/design-client/src/kernel/runtime-evidence'
import { managedSceneImageLoader } from '../../frontend/design-client/src/kernel/scene-image-hydration'
import { DecodedImageCache, createDecodedImageOwner, decodedImageScope } from '../../frontend/design-client/src/kernel/decoded-image-cache'
const report:any={status:'running',scope:'previous renderer + JSON scene oracle versus current renderer + frame-resource transport; actual device target readback; no GUI/latency claim',cases:[]}
const publish=async()=>{(window as any).__tileReport=report;document.querySelector('#results')!.textContent=JSON.stringify({status:report.status,error:report.error});await fetch('/__render_report',{method:'POST',body:JSON.stringify(report)})}
const compare=(a:Float32Array|Uint8Array,b:Float32Array|Uint8Array)=>{
  if(a.constructor!==b.constructor||a.byteLength!==b.byteLength)throw Error('Output type/extent changed')
  const x=new Uint32Array(a.buffer,a.byteOffset,a.byteLength/4),y=new Uint32Array(b.buffer,b.byteOffset,b.byteLength/4)
  let mismatches=0;for(let i=0;i<x.length;i++)mismatches+=Number(x[i]!==y[i]);return {words:x.length,mismatches}
}
try{
  await initializePicking();report.runtime=await renderRuntimeEvidence()
  const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw Error('No hardware adapter')
  report.adapter={vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,fallback:adapter.info.isFallbackAdapter}
  if(adapter.info.isFallbackAdapter)throw Error('Software adapter cannot satisfy hardware gate')
  const font=new Uint8Array(await(await fetch('/fonts/NotoSansSC.ttf')).arrayBuffer()),fixtures=await(await fetch('/fixtures.json')).json()
  for(const fixture of fixtures){
    const document=await(await fetch('/'+fixture.file)).json(),kernel=new VectorEngine(),store=new FrameResources();let alive=true
    try{
      kernel.load_font(font);kernel.load_document(JSON.stringify(document));kernel.bind_frame_scene_scope('hardware/'+fixture.file)
      const settings=kernel.color_settings(),scope=decodedImageScope(createDecodedImageOwner(),settings)
      const context={kernel,settings,scope,current:()=>alive,ownerCurrent:()=>alive}
      const loader=managedSceneImageLoader(new DecodedImageCache(),()=>context,{key:async()=>undefined,read:async()=>undefined,write(){}})
      for(const sample of fixture.samples){
        const options={pageId:document.pages[0].id,width:1710,height:1672,view:sample.view,transparent:false,grid:false,rasterProfile:fixture.rasterProfile||'figmaSubpixel',gpuViewport:sample.region}
        const reference=JSON.parse(kernel.compile_gpu(JSON.stringify(options))),record:any={fixture:fixture.file,sample,runs:[]}
        report.cases.push(record);await publish()
        const backends=new URL(location.href).searchParams.get('backend')==='webgpu'?['webgpu'] as const:['webgpu','webgl2'] as const
        for(const backend of backends){
          let expected:Float32Array|Uint8Array|undefined
          for(const variant of ['reference','frame'] as const){
            const factory=variant==='reference'?createReference:createGpu
            const gpu=await factory(backend,true,true,reference.colorManagement,loader,false,!!(reference.colorManagement||reference.floatCompositing))
            try{
              for(let iteration=0;iteration<3;iteration++){
                let scene=reference,packetBytes=0,payloadBytes=0
                if(variant==='frame'){
                  const lease=store.capture()
                  try{const packet=kernel.compile_gpu_packet(JSON.stringify({...options,frameResources:lease.acknowledgement}));packetBytes=packet.length;payloadBytes=new DataView(packet.buffer,packet.byteOffset).getUint32(20,true);scene=decodeScenePacket(packet,store,lease)}finally{lease.release()}
                  if(JSON.stringify({...scene,vertices:[],curves:[]})!==JSON.stringify({...reference,vertices:[],curves:[]})) {
                    // Resource binding insertion order is not a paint order.
                    const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v
                    if(JSON.stringify(canonical({...scene,vertices:[],curves:[]}))!==JSON.stringify(canonical({...reference,vertices:[],curves:[]})))throw Error('Compiled metadata changed')
                  }
                  for(const key of ['vertices','curves'] as const)if(compare(scene[key],new Float32Array(reference[key]||[])).mismatches)throw Error('Compiled geometry changed')
                }
                const result=await gpu.render(scene,true,false),pixels=result.linear||result.bytes
                if(!pixels?.length)throw Error('Missing hardware readback');expected??=pixels.slice()
                const diff=compare(pixels,expected);record.runs.push({backend,variant,iteration,packetBytes,payloadBytes,...diff,graphMs:result.graphMs,finishMs:result.finishMs,workingBytes:result.workingTextureBytes})
                await publish();if(diff.mismatches)throw Error('Hardware output bits changed')
              }
            }finally{gpu.dispose()}
          }
        }
      }
    }finally{alive=false;kernel.free()}
  }
  report.status='passed'
}catch(error){report.status='failed';report.error=String(error)}
await publish()
