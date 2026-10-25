import {initializePicking} from '../../frontend/design-client/src/kernel/picking'
import {VectorEngine} from '../../frontend/design-client/src/generated/design-kernel/design_kernel'
import {createGpu} from '../../frontend/design-client/src/kernel/gpu/factory'
import {decodeScenePacket} from '../../frontend/design-client/src/kernel/gpu/scene-packet'
// @ts-expect-error private reference loader
import {createGpu as createReference} from '../../frontend/design-client/src/kernel/gpu/factory.ts?reference'
import {managedSceneImageLoader} from '../../frontend/design-client/src/kernel/scene-image-hydration'
import {DecodedImageCache,createDecodedImageOwner,decodedImageScope} from '../../frontend/design-client/src/kernel/decoded-image-cache'
const report:any={status:'running',scope:'same WebGPU producer: shared-device presenter versus new presentation-only-device driver; exact displayed RGBA, not timing or fresh-motion certification',cases:[]}
const publish=async()=>{(window as any).__tileReport=report;document.querySelector('#results')!.textContent=JSON.stringify({status:report.status,error:report.error});await fetch('/__render_report',{method:'POST',body:JSON.stringify(report)})}
const pixels=(source:CanvasImageSource)=>{const c=new OffscreenCanvas(128,128),ctx=c.getContext('2d')!;ctx.drawImage(source,0,0);return ctx.getImageData(0,0,128,128).data}
try{
 await initializePicking();const adapter=await navigator.gpu.requestAdapter();if(!adapter||adapter.info.isFallbackAdapter)throw Error('Hardware adapter required')
 report.adapter={vendor:adapter.info.vendor,architecture:adapter.info.architecture,fallback:adapter.info.isFallbackAdapter}
 const fixtures=await(await fetch('/fixtures.json')).json(),font=new Uint8Array(await(await fetch('/fonts/NotoSansSC.ttf')).arrayBuffer())
 for(const fixture of fixtures){
  const doc=await(await fetch('/'+fixture.file)).json(),kernel=new VectorEngine();let alive=true
  kernel.load_font(font);kernel.load_document(JSON.stringify(doc))
  const settings=kernel.color_settings(),context={kernel,settings,scope:decodedImageScope(createDecodedImageOwner(),settings),current:()=>alive,ownerCurrent:()=>alive}
  const loader=managedSceneImageLoader(new DecodedImageCache(),()=>context,{key:async()=>undefined,read:async()=>undefined,write(){}})
  try{for(const sample of fixture.samples)for(const transparent of [false,true]){
   const scene=decodeScenePacket(kernel.compile_gpu_packet(JSON.stringify({pageId:doc.pages[0].id,width:1710,height:1672,view:sample.view,
    transparent,grid:false,rasterProfile:fixture.rasterProfile||'figmaSubpixel',gpuViewport:sample.region})))
   const views=[{x:0,y:0,zoom:1},{x:3,y:-2,zoom:1},{x:0,y:0,zoom:1.3}],expected:Uint8ClampedArray[]=[]
   const item=(serial:number)=>({active:true,layer:0,gutter:0,tile:{key:String(serial),serial,gpuTile:serial,x:-64,y:-64,width:sample.region.w,height:sample.region.h,zoom:1}})
   for(const route of ['reference','candidate']){
    const gpu=await (route==='reference'?createReference:createGpu)('webgpu',true,true,scene.colorManagement,loader,false,!!(scene.colorManagement||scene.floatCompositing))
    
    try{
     gpu.driver.captureDisplay=true;gpu.driver.attachPresenter!(new OffscreenCanvas(128,128),()=>{})
     const result=await gpu.render(scene,false,true)
     if(!result.gpuTile)throw Error('Missing actual resident output')
     const split=(gpu.driver.stats?.() as any).separatePresentationDevice
     if(split!==Number(route==='candidate'))throw Error('Wrong presentation-device mode')
     for(let i=0;i<views.length;i++){
       gpu.driver.presentFrame!({items:[item(result.gpuTile)],view:views[i],width:128,height:128,dpr:1})
       const {bitmap}=await gpu.driver.captureContentBitmap!();let actual
       try{actual=pixels(bitmap)}finally{bitmap.close()}
       if(route==='reference')expected.push(actual)
       else{let differences=0;for(let j=0;j<actual.length;j++)differences+=Number(actual[j]!==expected[i][j])
         report.cases.push({fixture:fixture.file,sample,transparent,view:views[i],separatePresentationDevice:split,bytes:actual.length,differences});await publish()
         if(differences)throw Error('Display-device driver changed bytes')
       }
     }
     gpu.driver.releasePresented!([result.gpuTile])
    }finally{gpu.dispose()}
   }
  }}finally{alive=false;kernel.free()}
 }
 const lostGpu=await createGpu('webgpu'),device=(lostGpu.driver as any).device,display=(lostGpu.driver as any).presentationDevice
 if(!display||display===device)throw Error('Missing independent presentation device')
 display.destroy();await device.lost;await Promise.resolve()
 if(!(lostGpu.driver as any).terminal)throw Error('Lost display did not retire producer')
 lostGpu.dispose();report.displayLossRetiresProducer=true
 report.status='passed'
}catch(error){report.status='failed';report.error=String(error)}
await publish()
