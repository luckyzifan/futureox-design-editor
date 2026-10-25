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
const report:any={status:'running',scope:'Q64 integer-enclosed prefix versus original exact filters; actual full 117, no pixel tolerance or larger scratch budget',cases:[]}
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
        const options={pageId:document.pages[0].id,width:1710,height:1672,view:sample.view,transparent:false,grid:false,rasterProfile:fixture.rasterProfile||'figmaSubpixel',...(sample.capture?{}:{gpuViewport:sample.region})}
        const reference=JSON.parse(kernel.compile_gpu(JSON.stringify(options))),record:any={fixture:fixture.file,sample,runs:[]}
        report.cases.push(record);await publish()
        const backends=new URL(location.href).searchParams.get('backend')==='webgpu'?['webgpu'] as const:['webgpu','webgl2'] as const
        for(const backend of backends){
          let expected:Float32Array|Uint8Array|undefined
          for(const variant of ['reference','frame'] as const){
            const factory=variant==='reference'?createReference:createGpu
            const gpu=await factory(backend,true,true,reference.colorManagement,loader,false,!!(reference.colorManagement||reference.floatCompositing))
            const driver=gpu.driver as any,pair=driver.certifiedTentPair,prepare=driver.prepareFilters,readings:any[]=[]
            if(variant==='reference')driver.certifiedTentPair=()=>false
            driver.prepareFilters=async(...args:any[])=>{await prepare.apply(driver,args);const prefix=driver.prefix;if(prefix){prefix.__originalRead??=prefix.readCounters.bind(prefix);prefix.readCounters=async()=>{const value=await prefix.__originalRead();readings.push(value);return value}}}
            const counts=new Map<number,{calls:number,pixels:number}>(),pass=gpu.driver.pass.bind(gpu.driver);gpu.driver.pass=(target,u,inputs,region,...args)=>{const c=counts.get(u[16])||{calls:0,pixels:0};c.calls++;c.pixels+=region?region.w*region.h:target.width*target.height;counts.set(u[16],c);return pass(target,u,inputs,region,...args)}
            try{
              for(let iteration=0;iteration<3;iteration++){
                counts.clear();readings.length=0;let scene=reference,packetBytes=0,payloadBytes=0
                if(variant==='frame'){
                  const lease=store.capture()
                  try{const packet=kernel.compile_gpu_packet(JSON.stringify({...options,...(sample.capture?{captureViewport:sample.region}:{}),gpuPainterSupport:backend==='webgpu',frameResources:lease.acknowledgement}));packetBytes=packet.length;payloadBytes=new DataView(packet.buffer,packet.byteOffset).getUint32(20,true);scene=decodeScenePacket(packet,store,lease)}finally{lease.release()}
                  // Native regional plans may change allocations/program guards; the full hardware output remains the exact oracle.
                }
                const result=await gpu.render(scene,true,false),pixels=result.linear||result.rgba
                if(!pixels?.length)throw Error('Missing hardware readback');expected??=pixels.slice()
                const diff=compare(pixels,expected);record.runs.push({backend,variant,iteration,packetBytes,payloadBytes,...diff,graphMs:result.graphMs,finishMs:result.finishMs,prefixReadings:[...readings],certifiedTentPasses:driver.certifiedTentPasses,passTimings:(gpu.driver as any).passTimings,timingSkipped:(gpu.driver as any).timingSkipped,opaqueSolidDraws:(gpu.driver as any).opaqueSolidDraws,passes:[...counts].sort((a,b)=>b[1].pixels-a[1].pixels),workingBytes:result.workingTextureBytes,passPixels:result.passPixels,drawCalls:result.drawCalls})
                await publish();if(variant==='reference'&&driver.certifiedTentPasses)throw Error('Reference entered interval candidate');if(variant==='frame'&&!driver.certifiedTentPasses)throw Error('No interval prefix work exercised');if(diff.mismatches)throw Error('Hardware output bits changed')
              }
            }finally{driver.certifiedTentPair=pair;driver.prepareFilters=prepare;if(driver.prefix?.__originalRead)driver.prefix.readCounters=driver.prefix.__originalRead;gpu.dispose()}
          }
        }
      }
    }finally{alive=false;kernel.free()}
  }
  report.status='passed'
}catch(error){report.status='failed';report.error=String(error)}
await publish()
