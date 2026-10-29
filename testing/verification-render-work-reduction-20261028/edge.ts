import {initializeKernelModule} from '../../frontend/design-client/src/kernel/module'
import {VectorEngine} from '../../frontend/design-client/src/generated/design-kernel/design_kernel'
import {blank,node,paint} from '../../frontend/design-client/src/model'
import {WebGpuDriver} from '../../frontend/design-client/src/kernel/gpu/webgpu'
import {GpuRenderer} from '../../frontend/design-client/src/kernel/gpu/renderer'
import {setGpuDiagnosticSink} from '../../frontend/design-desktop/src/render-terminal-diagnostics.mjs'
const report:any={status:'running',scope:'actual hardware four-sample/export/HDR-value and nonfinite destination bit comparisons; no physical HDR display claim',cases:[]}
const publish=async()=>{document.querySelector('#results')!.textContent=JSON.stringify(report,null,2);await fetch('/report',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(report)})}
const compare=(a:Float32Array,b:Float32Array)=>{if(a.length!==b.length)throw Error('Readback length mismatch');const x=new Uint32Array(a.buffer,a.byteOffset,a.length),y=new Uint32Array(b.buffer,b.byteOffset,b.length);let diff=0;for(let i=0;i<x.length;i++)if(x[i]!==y[i])diff++;return diff}
function documentFixture(wide=false){const d=blank();d.schemaVersion=20;d.rasterProfile='figmaSubpixel';d.colorManagement={documentSpace:'srgb',referenceWhiteNits:203,peakLuminanceNits:1000};const n=node('rectangle',7.25,8.5,24.5,17.25);n.fills=[paint('#000000','linear')];n.fills[0].stops=[{offset:0,color:'#123456'},{offset:1,color:wide?'color(srgb-linear 3 -0.2 0.7 / 0.8)':'#da8a31'}];const second=node('rectangle',43,34,8,7);second.fills=structuredClone(n.fills);d.nodes[n.id]=n;d.nodes[second.id]=second;d.pages[0].children=[n.id,second.id];return d}
try{
 await initializeKernelModule();setGpuDiagnosticSink(()=>{})
 const adapter=await navigator.gpu.requestAdapter();if(!adapter||adapter.info.isFallbackAdapter)throw Error('Hardware required')
 report.adapter={vendor:adapter.info.vendor,architecture:adapter.info.architecture,fallback:adapter.info.isFallbackAdapter}
 for(const [profile,scale,wide]of [['figma',1,false],['figma',2,false],['figma',3,false],['analytic',1,false],['figmaSubpixel',1,true]] as const){
  const d=documentFixture(wide),engine=new VectorEngine();d.rasterProfile=profile;if(profile==='analytic')delete d.colorManagement;engine.load_document(JSON.stringify(d));const raw=engine.compile_gpu(JSON.stringify({pageId:d.pages[0].id,width:64*scale,height:48*scale,view:{x:0,y:0,zoom:scale},rasterProfile:profile,transparent:true}));engine.free()
  const outputs:Float32Array[]=[],work:any[]=[]
  for(const candidate of [false,true]){
   const driver=await WebGpuDriver.create(true,wide,!!d.colorManagement,true,false),renderer=new GpuRenderer(driver,true,false) as any
   if(!candidate){renderer.constantCoverageEnabled=false;renderer.mixedSolidRunsEnabled=false;Object.defineProperty(driver,'exactGradientPaintOver',{value:false})}
   try{const s=JSON.parse(raw);s.vertices=new Float32Array(s.vertices);s.curves=new Float32Array(s.curves);const r=await renderer.render(s,true,false);if(!r.linear)throw Error('No linear output');outputs.push(r.linear);work.push(r.drawWork)}finally{renderer.dispose()}
  }
  const differences=compare(outputs[0],outputs[1]);report.cases.push({profile,scale,wide,words:outputs[0].length,differences,work});await publish();if(differences)throw Error('Export/HDR value changed')
 }
 // Direct production paintOver routing with a finite gradient and deliberately
 // nonfinite/signed-zero old destination. This catches a missing writable halo.
 for(const shared of [false,true]){
  const outputs:Float32Array[]=[]
  for(const candidate of [false,true]){
   const d=documentFixture(),engine=new VectorEngine();engine.load_document(JSON.stringify(d));const s=JSON.parse(engine.compile_gpu(JSON.stringify({pageId:d.pages[0].id,width:64,height:48,view:{x:0,y:0,zoom:1},rasterProfile:'figmaSubpixel',transparent:true})));engine.free();s.vertices=new Float32Array(s.vertices);s.curves=new Float32Array(s.curves)
   const driver=await WebGpuDriver.create(true,false,true,true,false),renderer=new GpuRenderer(driver,true,false) as any
   if(!candidate)Object.defineProperty(driver,'exactGradientPaintOver',{value:false})
   try{
    await driver.prepareScene(s);driver.begin(s.vertices,s.curves);renderer.scene=s;renderer.curveBits=new Uint32Array(s.curves.buffer);renderer.sampleIndex=0
    const n=s.nodes[d.pages[0].children[0]],mask=await renderer.nodeMask(n,true),values=new Float32Array(64*48*4)
    for(let i=0;i<values.length;i+=4){values.set([.2,.3,.4,1],i)}
    for(const [x,y]of [[6,7],[7,7],[8,8],[20,16],[34,27]])values.set([Infinity,NaN,-0,1],(y*64+x)*4)
    // Production image uploads intentionally reject nonfinite inputs. This
    // private test destination models values produced by earlier GPU effects;
    // it receives no finite-image certificate and is never a document asset.
    const texture=driver.create(64,48)
    ;(driver as any).device.queue.writeTexture({texture:texture.resource},values,{bytesPerRow:64*16,rowsPerImage:48},[64,48])
    const dst={texture,rect:{x:0,y:0,w:64,h:48}};renderer.busy.add(texture);renderer.used.add(texture);renderer.bytes+=texture.bytes
    if(shared)renderer.retain(dst)
    const result=await renderer.paintOver(n,n.fills[0],mask,dst,undefined,true)
    outputs.push(await driver.readSurface(result.texture))
   }finally{renderer.dispose()}
  }
  const differences=compare(outputs[0],outputs[1]);report.cases.push({case:'nonfinite-destination',shared,words:outputs[0].length,differences});await publish();if(differences)throw Error('Destination boundary changed')
 }
 report.status='passed'
}catch(error){report.status='failed';report.error=String(error);report.stack=error instanceof Error?error.stack:undefined}
await publish()
