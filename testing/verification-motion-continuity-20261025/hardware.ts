import {initializeKernelModule} from '../../frontend/design-client/src/kernel/module'
import {VectorEngine} from '../../frontend/design-client/src/generated/design-kernel/design_kernel'
import {createGpu} from '../../frontend/design-client/src/kernel/gpu/factory'
import {decodeScenePacket} from '../../frontend/design-client/src/kernel/gpu/scene-packet'
const report:any={status:'running',scope:'actual WebGPU float pixels in the declared interaction window; no physical scanout or whole-editor claim',cases:[]}
const publish=()=>{(window as any).__report=report;document.querySelector('#results')!.textContent=JSON.stringify(report)}
try{
 await initializeKernelModule()
 const adapter=await navigator.gpu.requestAdapter();if(!adapter||adapter.info.isFallbackAdapter)throw Error('Hardware adapter unavailable')
 report.adapter={vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,fallback:adapter.info.isFallbackAdapter}
 const color={documentSpace:'srgb' as const,referenceWhiteNits:203,peakLuminanceNits:1000}
 for(const background of ['#ffffff','#f2f2f2','color(srgb 2.5 -0.25 0.5 / 0.75)'])for(const transparent of [false,true]){
  const engine=new VectorEngine(),outputs:Float32Array[]=[]
  try{
   engine.load_document(JSON.stringify({schemaVersion:3,id:'background',name:'background',colorManagement:color,
    pages:[{id:'p',name:'p',background,children:[]}],nodes:{}}))
   const scene=decodeScenePacket(engine.compile_gpu_packet(JSON.stringify({pageId:'p',width:96,height:96,
    view:{x:.125,y:.375,zoom:1},rasterProfile:'figmaSubpixel',transparent})))
   for(const interaction of [false,true]){
    const renderer=await createGpu('webgpu',true,false,color,undefined,false,true)
    try{
     const input=interaction?{...scene,interactionRetained:true,nativeInteraction:true,interactionWindow:{x:16,y:16,w:32,h:32}}:scene
     const result=await renderer.render(input,true,false)
     if(!result.linear)throw Error('No actual float readback')
     outputs.push(result.linear)
    }finally{renderer.dispose()}
   }
   const words=outputs.map(a=>new Uint32Array(a.buffer,a.byteOffset,a.length));let differences=0,alphaZero=0
   for(let y=16;y<48;y++)for(let x=16;x<48;x++)for(let c=0;c<4;c++){
    const i=(y*96+x)*4+c;if(words[0][i]!==words[1][i])differences++
    if(c===3&&outputs[1][i]===0)alphaZero++
   }
   report.cases.push({background,transparent,comparedWords:4096,differences,alphaZero});publish()
   if(differences||!transparent&&alphaZero)throw Error('Interaction background pixels differ')
  }finally{engine.free()}
 }
 report.status='passed'
}catch(error){report.status='failed';report.error=String(error)}
publish()
