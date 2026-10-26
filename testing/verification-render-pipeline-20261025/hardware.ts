import { initializeKernelModule } from '../../frontend/design-client/src/kernel/module'
import { VectorEngine } from '../../frontend/design-client/src/generated/design-kernel/design_kernel'
import { WebGpuDriver } from '../../frontend/design-client/src/kernel/gpu/webgpu'
import { GpuRenderer } from '../../frontend/design-client/src/kernel/gpu/renderer'
import { createGpu } from '../../frontend/design-client/src/kernel/gpu/factory'
import { decodeScenePacket } from '../../frontend/design-client/src/kernel/gpu/scene-packet'
const report:any={status:'running',scope:'actual hardware target float readback, not whole-editor or physical presentation',cases:[]}
const publish=()=>{(window as any).__report=report;document.querySelector('#results')!.textContent=JSON.stringify(report)}
const compare=(a:Float32Array,b:Float32Array)=>{
  if(a.byteLength!==b.byteLength)throw Error('Changed output size')
  const x=new Uint32Array(a.buffer,a.byteOffset,a.length),y=new Uint32Array(b.buffer,b.byteOffset,b.length)
  let differences=0;for(let i=0;i<x.length;i++)if(x[i]!==y[i])differences++
  return {words:x.length,differences}
}
try{
  await initializeKernelModule()
  const adapter=await navigator.gpu.requestAdapter();if(!adapter||adapter.info.isFallbackAdapter)throw Error('Hardware WebGPU adapter unavailable')
  report.adapter={vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,fallback:adapter.info.isFallbackAdapter};publish()
  for(const [width,height,radius]of [[65,3,513],[3,65,1177.43901234567],[7,5,2048]])for(const clamp of [false,true]){
    const outputs:Float32Array[]=[]
    for(const banded of [false,true]){
      const driver=await WebGpuDriver.create(true,false,true,true,false)
      const renderer=new GpuRenderer(driver,true,false) as any
      try{
        await driver.prepareFilters(true);driver.begin(new Float32Array())
        const rect={x:-30,y:50,w:width,h:height}
        renderer.scene={integratedBlur:true,interactionRetained:banded,extent:rect,width,height,view:{x:0,y:0,zoom:1},roots:[],nodes:{}}
        renderer.prefixAllowed=false
        const values=Float32Array.from({length:width*height*4},(_,i)=>i%4===3?1:i%17===0?-0:i%19===0?1.401298464324817e-45:Math.fround(((i*17)%37-18)/7))
        const texture=driver.uploadLinear(values,width,height)
        renderer.busy.add(texture);renderer.bytes+=texture.bytes;renderer.aliases.set(texture,1)
        const output=await renderer.blur({texture,rect},radius/2,clamp,false,false,banded)
        outputs.push(await driver.readSurface(output.texture))
        await driver.abortFrameAndReleaseFilterScratch()
      }finally{renderer.dispose()}
    }
    const diff=compare(outputs[0],outputs[1]);report.cases.push({kind:'retained-exact-bands',width,height,radius,clamp,...diff});publish()
    if(diff.differences)throw Error('Exact band pixels changed')
  }
  const color={documentSpace:'srgb' as const,referenceWhiteNits:203,peakLuminanceNits:1000}
  const ids=Array.from({length:24},(_,i)=>'n'+i),nodes:any={root:{id:'root',kind:'group',width:80,height:60,children:ids}}
  ids.forEach((id,i)=>nodes[id]={id,kind:'ellipse',width:24,height:24,transform:[1,0,0,1,4+(i%8)*4,4+Math.floor(i/8)*10],
    fills:[{kind:'solid',color:i>=8&&i<16?'#0066ff':'#ff2200'}]})
  const engine=new VectorEngine()
  try{
    engine.load_document(JSON.stringify({schemaVersion:3,id:'d',name:'d',colorManagement:color,pages:[{id:'p',name:'p',background:'#ffffff',children:['root']}],nodes}))
    const scene=decodeScenePacket(engine.compile_gpu_packet(JSON.stringify({pageId:'p',width:80,height:60,view:{x:.125,y:.375,zoom:1},rasterProfile:'figmaSubpixel',transparent:true})))
    const outputs:Float32Array[]=[],counts:number[]=[]
    for(const candidate of [false,true]){
      const renderer=await createGpu('webgpu',true,true,color,undefined,false,true)
      if(!candidate)(renderer as any).drawOpaqueGroup=async()=>undefined
      try{outputs.push((await renderer.render(scene,true,false)).linear!);counts.push((renderer.driver as any).opaqueSolidDraws||0)}finally{renderer.dispose()}
    }
    const diff=compare(outputs[0],outputs[1]);report.cases.push({kind:'ordered-multicolor-batch',counts,...diff});publish()
    if(diff.differences||counts[0]!==0||counts[1]<12)throw Error('Opaque runs did not preserve pixels or exercise batching')
  }finally{engine.free()}
  report.status='passed'
}catch(error){report.status='failed';report.error=String(error)}
publish()
