import {initializePicking} from '../../frontend/design-client/src/kernel/picking'
import {VectorEngine} from '../../frontend/design-client/src/generated/design-kernel/design_kernel'
import {createGpu} from '../../frontend/design-client/src/kernel/gpu/factory'
import {decodeScenePacket} from '../../frontend/design-client/src/kernel/gpu/scene-packet'
import {ResidentPresenter} from '../../frontend/design-client/src/kernel/gpu/resident-presenter'
import {managedSceneImageLoader} from '../../frontend/design-client/src/kernel/scene-image-hydration'
import {DecodedImageCache,createDecodedImageOwner,decodedImageScope} from '../../frontend/design-client/src/kernel/decoded-image-cache'
const report:any={status:'running',scope:'same WebGPU producer: resident presenter versus ImageBitmap transfer to a separate WebGPU presentation device; exact displayed RGBA, not timing or fresh-motion certification',cases:[]}
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
   for(const route of ['resident','bitmap']){
    const gpu=await createGpu('webgpu',true,true,scene.colorManagement,loader,false,!!(scene.colorManagement||scene.floatCompositing))
    let isolated:ResidentPresenter|undefined,presentationDevice:GPUDevice|undefined
    try{
     gpu.driver.captureDisplay=route==='resident'
     if(route==='resident'){gpu.driver.captureDisplay=true;gpu.driver.attachPresenter!(new OffscreenCanvas(128,128),()=>{})}
     const result=await gpu.render(scene,false,true)
     if(route==='bitmap'){
      if(!result.bitmap)throw Error('Missing actual ImageBitmap')
      const presentationAdapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});if(!presentationAdapter||presentationAdapter.info.isFallbackAdapter)throw Error('Hardware presentation adapter required');presentationDevice=await presentationAdapter.requestDevice()
      isolated=new ResidentPresenter(presentationDevice,new OffscreenCanvas(128,128),navigator.gpu.getPreferredCanvasFormat(),()=>{})
      const slot=isolated.import(result.bitmap)
      for(let i=0;i<views.length;i++){
       isolated.draw({items:[item(slot)],view:views[i],width:128,height:128,dpr:1})
       const {bitmap}=await isolated.captureContentBitmap();let actual
       try{actual=pixels(bitmap)}finally{bitmap.close()}
       const reference=expected[i];let differences=0
       for(let j=0;j<actual.length;j++)differences+=Number(actual[j]!==reference[j])
       report.cases.push({fixture:fixture.file,sample,transparent,view:views[i],bytes:actual.length,differences});await publish()
       if(differences)throw Error('Presentation transport changed output bytes')
      }
      isolated.release([slot])
     }else{
      if(!result.gpuTile)throw Error('Missing resident capture')
      for(const view of views){gpu.driver.presentFrame!({items:[item(result.gpuTile)],view,width:128,height:128,dpr:1});const {bitmap}=await gpu.driver.captureContentBitmap!();try{expected.push(pixels(bitmap))}finally{bitmap.close()}}
      gpu.driver.releasePresented!([result.gpuTile])
     }
    }finally{isolated?.dispose();presentationDevice?.destroy();gpu.dispose()}
   }
  }}finally{alive=false;kernel.free()}
 }
 report.status='passed'
}catch(error){report.status='failed';report.error=String(error)}
await publish()
