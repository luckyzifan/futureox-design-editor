import {initializeKernelModule} from '../../frontend/design-client/src/kernel/module'
import {VectorEngine} from '../../frontend/design-client/src/generated/design-kernel/design_kernel'
import {blank,node,paint,stroke,effect} from '../../frontend/design-client/src/model'
import {WebGpuDriver} from '../../frontend/design-client/src/kernel/gpu/webgpu'
import {GpuRenderer} from '../../frontend/design-client/src/kernel/gpu/renderer'
const report:any={status:'running',scope:'real native geometry + hardware full render: original four-plane graph versus bounded stroked shadow source; float-bit comparison',cases:[]}
const publish=async()=>{document.querySelector('#results')!.textContent=JSON.stringify(report,null,2);await fetch('/stroke-report',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(report)})}
try{
 await initializeKernelModule();const adapter=await navigator.gpu.requestAdapter();if(!adapter||adapter.info.isFallbackAdapter)throw Error('Hardware adapter unavailable')
 report.adapter={vendor:adapter.info.vendor,architecture:adapter.info.architecture,fallback:adapter.info.isFallbackAdapter}
 const font=new Uint8Array(await(await fetch('/fonts/NotoSansSC.ttf')).arrayBuffer())
 for(const kind of ['rectangle','ellipse'] as const)for(const align of ['center','inside','outside'] as const){
  const doc=blank(),shape=node(kind,12.25,16.5,70.5,45.75);doc.schemaVersion=3;doc.rasterProfile='figma';doc.colorManagement={documentSpace:'srgb',referenceWhiteNits:203,peakLuminanceNits:1000}
  shape.fills=[{...paint('#257bad'),opacity:.61}];shape.strokes=[{...stroke('#de421b',5.25),align}];shape.effects=[{...effect('shadow'),radius:64,x:10.125,y:-15.375,opacity:.43}]
  doc.nodes[shape.id]=shape;doc.pages[0].children=[shape.id]
  const engine=new VectorEngine();engine.load_font(font);engine.load_document(JSON.stringify(doc))
  const raw=engine.compile_gpu(JSON.stringify({pageId:doc.pages[0].id,width:64,height:64,view:{x:-.125,y:.375,zoom:1},gpuViewport:{x:16,y:16,w:64,h:64},rasterProfile:'figmaSubpixel'}));engine.free()
  const outputs:Float32Array[]=[],runs:any[]=[]
  for(const candidate of [false,true]){
   report.current={kind,align,candidate};await publish()
   const driver=await WebGpuDriver.create(true,false,true,true,false),renderer=new GpuRenderer(driver,candidate,false) as any
   try{
    const scene=JSON.parse(raw);scene.vertices=new Float32Array(scene.vertices);scene.curves=new Float32Array(scene.curves)
    let streamed=0;const stream=renderer.streamIsolatedFilter.bind(renderer)
    renderer.streamIsolatedFilter=async(...args:any[])=>{const out=await stream(...args);if(out)streamed++;return out}
    const started=performance.now(),result=await renderer.render(scene,true,false)
    if(!result.linear)throw Error('Missing actual float readback')
    outputs.push(result.linear);runs.push({candidate,streamed,wallMs:performance.now()-started,drawCalls:driver.drawCalls,peakTextureBytes:result.peakTextureBytes})
   }catch(error){report.deviceFailure={kind,align,candidate,errors:[...((driver as any).errors||[])]};throw error}finally{renderer.dispose()}
  }
  const bits=outputs.map(a=>new Uint32Array(a.buffer,a.byteOffset,a.length));let differences=0
  for(let i=0;i<bits[0].length;i++)if(bits[0][i]!==bits[1][i])differences++
  report.cases.push({kind,align,words:bits[0].length,differences,runs});await publish()
  if(differences)throw Error('Stroke source pixels changed')
  if(!runs[1].streamed)throw Error('Stroked stream not exercised')
 }
 report.status='passed'
}catch(error){report.status='failed';report.error=String(error)}
await publish()
