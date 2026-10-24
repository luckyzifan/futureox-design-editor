import{initializePicking}from'../../frontend/design-client/src/kernel/picking'
import{VectorEngine}from'../../frontend/design-client/src/generated/design-kernel/design_kernel'
import{createGpu}from'../../frontend/design-client/src/kernel/gpu/factory'
import{decodeScenePacket}from'../../frontend/design-client/src/kernel/gpu/scene-packet'
import{SceneDeltaDecoder}from'../../frontend/design-client/src/kernel/gpu/scene-delta'
import{reuseExactSceneSources}from'../../frontend/design-client/src/kernel/gpu/exact-scene-reuse'
import{renderRuntimeEvidence}from'../../frontend/design-client/src/kernel/runtime-evidence'
const report:any={status:'running',cases:[]};const publish=async()=>{document.querySelector('#results')!.textContent=JSON.stringify(report,null,2);await fetch('/__render_report',{method:'POST',body:JSON.stringify(report)})}
const color={documentSpace:'srgb' as const,referenceWhiteNits:203,peakLuminanceNits:1000}
const compare=(a:Float32Array,b:Float32Array)=>{const x=new Uint32Array(a.buffer,a.byteOffset,a.length),y=new Uint32Array(b.buffer,b.byteOffset,b.length);if(x.length!==y.length)throw Error('Extent mismatch');let mismatches=0;for(let i=0;i<x.length;i++)mismatches+=Number(x[i]!==y[i]);return{words:x.length,mismatches}}
function doc(angle:number){return{schemaVersion:16,id:'axes',name:'axes',colorManagement:color,pages:[{id:'p',name:'p',background:'#ffffff',children:['n']}],nodes:{n:{id:'n',kind:'rectangle',width:96,height:80,fills:[{kind:'linear',color:'#000000',opacity:.73,angle,stops:Array.from({length:36},(_,i)=>({offset:i===18?17/35:i/35,color:`color(srgb-linear ${i%3===0?2.25:-.125} ${i%5/4} ${i%7/6} / ${.25+(i%4)/4})`}))}]}}}}
try{
 await initializePicking();report.runtime=await renderRuntimeEvidence();
 for(const backend of ['webgpu','webgl2']as const){for(const angle of [0,90,23.75]){
  const kernel=new VectorEngine();try{
   kernel.load_document(JSON.stringify(doc(angle)));const options=JSON.stringify({pageId:'p',width:96,height:80,view:{x:0,y:0,zoom:1},grid:false,transparent:false,rasterProfile:'figmaSubpixel'}),scene=decodeScenePacket(kernel.compile_gpu_packet(options)),oracle=kernel.render_linear(options),outputs:Float32Array[]=[]
   for(const compact of [false,true]){const gpu=await createGpu(backend,true,false,color,undefined,false,true),internal=gpu as any;let uploads=0,hits=0;const upload=gpu.driver.uploadLinear!.bind(gpu.driver);gpu.driver.uploadLinear=(values,w,h)=>{uploads+=values.byteLength;return upload(values,w,h)}
    const axis=internal.gradientAxisGrid.bind(gpu);internal.gradientAxisGrid=(...args:unknown[])=>{const result=compact?axis(...args):undefined;hits+=Number(!!result);return result}
    try{const result=await gpu.render(scene,true,false);if(!result.linear)throw Error('No float result');outputs.push(result.linear.slice());const difference=compare(result.linear,oracle);report.cases.push({backend,angle,compact,uploads,hits,...difference});if(difference.mismatches)throw Error('CPU parameter/color mismatch')}finally{gpu.dispose()}
   }
   if(compare(outputs[0],outputs[1]).mismatches)throw Error('Compact field changed pixels');await publish()
  }finally{kernel.free()}
 }}
 // The production delta decoder and source reuse consume native partial
 // compiles. Every pose is compared with a separately compiled full scene.
 for(const backend of ['webgpu','webgl2']as const){
  const value=doc(90);value.nodes={} as any;value.pages[0].children=[]
  for(let i=0;i<40;i++){const id='n'+i;value.pages[0].children.push(id);(value.nodes as any)[id]={...doc(90).nodes.n,id,width:6,height:5,transform:[1,0,0,1,(i%10)*8,Math.floor(i/10)*8]}}
  const kernel=new VectorEngine(),decoder=new SceneDeltaDecoder(),gpu=await createGpu(backend,true,false,color,undefined,false,true)
  try{
   kernel.load_document(JSON.stringify(value));const options=JSON.stringify({pageId:'p',width:96,height:80,view:{x:.125,y:.375,zoom:1},grid:false,transparent:false,rasterProfile:'figmaSubpixel'})
   let previous:any=decoder.decode(kernel.compile_gpu_scene_update(options,true));await gpu.render(previous,true,false)
   for(const transform of [[1,0,0,1,11.375,12.125],[.8,.6,-.6,.8,20,20],[1,0,0,1,200,200],[1,0,0,1,0,0]]){
    if(!kernel.apply_interaction_transforms(JSON.stringify({n0:transform})))throw Error('Native transform rejected')
    const packet=kernel.compile_gpu_scene_update(options,false),view=new DataView(packet.buffer,packet.byteOffset,packet.byteLength),metadata=JSON.parse(new TextDecoder().decode(packet.subarray(24,24+view.getUint32(8,true))))
    if(Object.keys(metadata.nodes).length>1)throw Error('Static nodes recompiled')
    const next=reuseExactSceneSources(previous,decoder.decode(packet)),result=await gpu.render(next,true,false)
    const fullGpu=await createGpu(backend,true,false,color,undefined,false,true)
    try{const full=await fullGpu.render(decodeScenePacket(kernel.compile_gpu_packet(options)),true,false),difference=compare(result.linear!,full.linear!)
     report.cases.push({name:'partial-transform',backend,transform,updatedNodes:Object.keys(metadata.nodes).length,bytes:packet.byteLength,...difference});await publish();if(difference.mismatches)throw Error('Partial transform pixels differ')
    }finally{fullGpu.dispose()}
    previous=next
   }
  }finally{gpu.dispose();kernel.free()}
 }
 // Actual native gradient border: its black fallback must never replace
 // the translucent blue stops. This document is emitted by the Rust importer.
 const border=await(await fetch('/border-scene.json')).json(),borderKernel=new VectorEngine()
 try{
  borderKernel.load_document(JSON.stringify(border));const node=border.nodes[border.pages[0].children[0]]
  if(!node.strokes.some((s:any)=>s.paint.kind==='linear'))throw Error('Native gradient border was flattened')
  const options=JSON.stringify({pageId:border.pages[0].id,width:Math.ceil(node.width),height:Math.ceil(node.height),view:{x:-node.transform[4],y:-node.transform[5],zoom:1},grid:false,transparent:false,rasterProfile:'figmaSubpixel'})
  const scene=decodeScenePacket(borderKernel.compile_gpu_packet(options)),oracle=borderKernel.render_linear(options)
  for(const backend of ['webgpu','webgl2']as const){const gpu=await createGpu(backend,true,false,color,undefined,false,true);try{
   const result=await gpu.render(scene,true,false),difference=compare(result.linear!,oracle)
   report.cases.push({name:'actual-native-gradient-border',backend,...difference});await publish();if(difference.mismatches)throw Error('Native gradient border pixels differ')
  }finally{gpu.dispose()}}
 }finally{borderKernel.free()}
 // The actual source icon exercises compound holes, transparency and blur.
 const icon=await(await fetch('/__render_fixture')).json(),kernel=new VectorEngine();try{
  kernel.load_document(JSON.stringify(icon));const options=JSON.stringify({pageId:icon.pages[0].id,width:140,height:140,view:{x:-120,y:-80,zoom:1},grid:false,transparent:false,rasterProfile:'figma'}),scene=decodeScenePacket(kernel.compile_gpu_packet(options)),oracle=kernel.render_linear(options)
  for(const backend of ['webgpu','webgl2']as const){const gpu=await createGpu(backend,true,false,color,undefined,false,true);try{const result=await gpu.render(scene,true,false);const difference=compare(result.linear!,oracle);report.cases.push({name:'actual-source-icon',backend,...difference});await publish();if(difference.mismatches)throw Error('Actual icon CPU/GPU mismatch')}finally{gpu.dispose()}}
 }finally{kernel.free()}
 // Test the final resident display encoding, not only linear readback.
 for(const hex of ['#0f5eff','#009cff','#808080']){
  const kernel=new VectorEngine(),value=doc(0);(value.nodes.n.fills as any)=[{kind:'solid',color:hex,opacity:1}];value.nodes.n.width=8;value.nodes.n.height=8
  const gpu=await createGpu('webgpu',true,false,color,undefined,false,true);try{
   kernel.load_document(JSON.stringify(value));const scene=decodeScenePacket(kernel.compile_gpu_packet(JSON.stringify({pageId:'p',width:8,height:8,view:{x:0,y:0,zoom:1},grid:false,transparent:false,rasterProfile:'figma'})))
   gpu.driver.attachPresenter!(new OffscreenCanvas(8,8),()=>{});gpu.driver.captureDisplay=true;const result=await gpu.render(scene,false,true);if(!result.gpuTile)throw Error('No resident capture')
   gpu.driver.presentFrame!({items:[{tile:{gpuTile:result.gpuTile,key:'test',x:0,y:0,width:8,height:8,zoom:1,gutter:0,serial:1},active:true,layer:1}],view:{x:0,y:0,zoom:1},width:8,height:8,dpr:1,linearBlend:true,backgroundLinear:[1,1,1,1]})
   const {bitmap}=await gpu.driver.captureContentBitmap!(),canvas=new OffscreenCanvas(8,8),ctx=canvas.getContext('2d',{colorSpace:'srgb'})!;ctx.drawImage(bitmap,0,0);bitmap.close();const actual=Array.from(ctx.getImageData(4,4,1,1).data),expected=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)).concat(255)
   report.cases.push({name:'resident-display-color',hex,actual,expected});await publish();if(actual.some((v,i)=>v!==expected[i]))throw Error('Final display encoding mismatch')
  }finally{gpu.dispose();kernel.free()}
 }
 report.status='passed';await publish()
}catch(error){report.status='failed';report.error=String(error);await publish()}
