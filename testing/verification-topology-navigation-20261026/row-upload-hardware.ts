import {initializeKernelModule}from '../../frontend/design-client/src/kernel/module'
import {ImageRowDecoder,VectorEngine}from '../../frontend/design-client/src/generated/design-kernel/design_kernel'
import {blank}from '../../frontend/design-client/src/model'
import {WebGpuDriver}from '../../frontend/design-client/src/kernel/gpu/webgpu'
import {GpuRenderer}from '../../frontend/design-client/src/kernel/gpu/renderer'
import {managedSceneImageLoader}from '../../frontend/design-client/src/kernel/scene-image-hydration'
import {DecodedImageCache,createDecodedImageOwner,decodedImageScope}from '../../frontend/design-client/src/kernel/decoded-image-cache'
const report:any={status:'running',scope:'hardware texture readback, complete f32 words; native row/full-color equivalence separately covered by Rust tests; no GUI FPS claim',cases:[]}
const publish=async()=>{document.querySelector('#results')!.textContent=JSON.stringify(report,null,2);await fetch('/row-report',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(report)})}
try{
 await initializeKernelModule();const adapter=await navigator.gpu.requestAdapter();if(!adapter||adapter.info.isFallbackAdapter)throw Error('Hardware adapter unavailable')
 report.adapter={vendor:adapter.info.vendor,architecture:adapter.info.architecture,fallback:adapter.info.isFallbackAdapter};await publish()
 {
  const driver=await WebGpuDriver.create(true,false,true,true,false)
  try{
   driver.begin(new Float32Array());const width=73,height=67,values=Float32Array.from({length:width*height*4},(_,i)=>i%4===3?(i%255)/255:((i*19)%113-56)/17)
   values[0]=-0;values[7]=1e-30
   function* rows(){for(let y=0;y<height;y+=17){const h=Math.min(17,height-y);yield {y,height:h,pixels:values.slice(y*width*4,(y+h)*width*4)}}}
   const original=driver.uploadLinear(values,width,height),streamed=driver.uploadLinearRows(width,height,rows())
   const a=await driver.readSurface(original),b=await driver.readSurface(streamed),av=new Uint32Array(a.buffer),bv=new Uint32Array(b.buffer)
   let differences=0;for(let i=0;i<av.length;i++)if(av[i]!==bv[i])differences++
   report.cases.push({case:'full-versus-row-upload',width,height,words:av.length,differences});if(differences)throw Error('Row upload changed bits')
  }finally{driver.dispose()}
 }
 await publish()
 const bytes=new Uint8Array(await(await fetch('/source-image.png')).arrayBuffer())
 report.sourceSha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('')
 let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384))
 const uri='data:image/png;base64,'+btoa(binary),engine=new VectorEngine(),doc=blank()
 doc.schemaVersion=3;doc.rasterProfile='figma';doc.colorManagement={documentSpace:'srgb',referenceWhiteNits:203,peakLuminanceNits:1000};engine.load_document(JSON.stringify(doc))
 try{engine.image_linear(uri);throw Error('Legacy whole-image guard unexpectedly lifted')}catch(error){if(!String(error).includes('Decoded image budget exceeded'))throw error;report.legacyFullDecodeRejected=true}
 const settings=engine.color_settings(),owner=createDecodedImageOwner(),cache=new DecodedImageCache()
 const loader=managedSceneImageLoader(cache,()=>({kernel:engine,scope:decodedImageScope(owner,settings),settings,current:()=>true,ownerCurrent:()=>true,resourceOwner:owner}),{key:async()=>undefined,read:async()=>undefined,write(){throw Error('Stream must not persist an empty decoded image')}})
 const driver=await WebGpuDriver.create(true,false,true,true,false),renderer=new GpuRenderer(driver,true,false,loader)as any
 try{
  driver.begin(new Float32Array());renderer.scene={floatCompositing:true,colorManagement:doc.colorManagement,view:{x:0,y:0,zoom:1}}
  let strips=0,maxStripBytes=0;const write=driver.uploadAtlasLinear.bind(driver)
  driver.uploadAtlasLinear=(...args:any[])=>{strips++;maxStripBytes=Math.max(maxStripBytes,args[5].byteLength);return write(...args as Parameters<typeof write>)}
  const started=performance.now(),surface=renderer.imageFor(uri),actual=await driver.readSurface(surface.texture),bits=new Uint32Array(actual.buffer,actual.byteOffset,actual.length)
  const expected=new ImageRowDecoder(uri,settings);let at=0,differences=0
  try{for(;;){const part=expected.next_rows();if(!part.length)break;const words=new Uint32Array(part.buffer,part.byteOffset,part.length);for(let i=0;i<words.length;i++)if(words[i]!==bits[at+i])differences++;at+=words.length}}finally{expected.free()}
  if(at!==bits.length||differences||strips<2||maxStripBytes>4*1024*1024)throw Error('Incomplete or changed real PNG upload')
  report.cases.push({case:'real-topology-PNG',width:surface.rect.w,height:surface.rect.h,words:at,differences,strips,maxStripBytes,wallMs:performance.now()-started})
 }finally{renderer.dispose();engine.free()}
 report.status='passed'
}catch(error){report.status='failed';report.error=String(error)}
await publish()
