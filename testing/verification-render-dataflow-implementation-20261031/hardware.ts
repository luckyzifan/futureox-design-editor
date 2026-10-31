import { initializeKernelModule } from '../../frontend/design-client/src/kernel/module'
import { VectorEngine, rational_tent_kernel_rgba, rational_large_tent_kernel_rgba, rational_box_kernel_rgba } from '../../frontend/design-client/src/generated/design-kernel/design_kernel'
import { WebGpuDriver } from '../../frontend/design-client/src/kernel/gpu/webgpu'
import { WebGpuDriver as BaselineDriver } from './baseline-webgpu'
import { parameters } from '../../frontend/design-client/src/kernel/gpu/types'
import { exactFilterPacketLayout } from '../../frontend/design-client/src/kernel/gpu/exact-filter-packet-layout'
import { RenderKernel } from '../../frontend/design-client/src/kernel/render-kernel'
import { decodeScenePacket } from '../../frontend/design-client/src/kernel/gpu/scene-packet'
import { GpuRenderer } from '../../frontend/design-client/src/kernel/gpu/renderer'
import { managedSceneImageLoader } from '../../frontend/design-client/src/kernel/scene-image-hydration'
import { DecodedImageCache, createDecodedImageOwner, decodedImageScope } from '../../frontend/design-client/src/kernel/decoded-image-cache'

const report:any={status:'running',cases:[],scope:'Hardware exact before/after output for setup and CPU scene handoff; not whole-editor latency.'}
async function publish(){document.querySelector('#result')!.textContent=JSON.stringify(report,null,2);await fetch('/report',{method:'POST',body:JSON.stringify(report)})}
function same(a:Float32Array,b:Float32Array){
 if(a.length!==b.length)throw Error('Pixel count changed')
 const aa=new Uint32Array(a.buffer,a.byteOffset,a.length),bb=new Uint32Array(b.buffer,b.byteOffset,b.length)
 let changed=0;for(let i=0;i<aa.length;i++)if(aa[i]!==bb[i])changed++
 if(changed)throw Error(`Float output changed: ${changed} words`)
 return {words:aa.length,changed}
}
function preview(values:Float32Array,label:string,linear:boolean){
 const group=document.createElement('div');group.textContent=label
 const canvas=document.createElement('canvas');canvas.width=192;canvas.height=128
 const bytes=new Uint8ClampedArray(values.length)
 for(let i=0;i<values.length;i+=4){for(let c=0;c<3;c++){
  const v=Math.max(0,Math.min(1,values[i+c]+1-values[i+3]))
  bytes[i+c]=Math.round(255*(linear?(v<=.0031308?12.92*v:1.055*v**(1/2.4)-.055):v))
 }bytes[i+3]=255}
 canvas.getContext('2d')!.putImageData(new ImageData(bytes,192,128),0,0);group.append(canvas);document.querySelector('#previews')!.append(group)
}
try{
 await initializeKernelModule();const adapter=await navigator.gpu.requestAdapter()
 if(!adapter||adapter.info.isFallbackAdapter)throw Error('Hardware GPU required')
 report.adapter={vendor:adapter.info.vendor,architecture:adapter.info.architecture,fallback:adapter.info.isFallbackAdapter};await publish()
 const drivers:any[]=[]
 try{
  for(const Driver of [BaselineDriver,WebGpuDriver]){
   const driver:any=await Driver.create(true,false,true,true,false),created:any[]=[]
   const make=driver.device.createRenderPipelineAsync.bind(driver.device)
   driver.device.createRenderPipelineAsync=(d:any)=>{created.push({entry:d.fragment.entryPoint,channel:d.fragment.constants?.FILTER_CHANNEL,format:d.fragment.targets[0].format});return make(d)}
   const started=performance.now()
   await driver.prepareScene({nodes:{},integratedBlur:true,canvasBlurApproximation:true},true);await driver.prepareFilters(false)
   drivers.push(driver);(report.setup??=[]).push({created,filters:created.filter(p=>p.entry==='fragment'||p.entry==='fragmentRgba'),coldMs:performance.now()-started})
  }
  if(report.setup[0].filters.length!==11||report.setup[1].filters.length!==8||report.setup[0].created.length-report.setup[1].created.length!==3)throw Error('Expected removal of exactly three unused filter pipelines')
  async function run(driver:any,c:any){
   driver.hdr=!!c.hdr
   await driver.prepareScene({nodes:{},integratedBlur:true,canvasBlurApproximation:!c.hdr},true)
   driver.begin(new Float32Array());const w=65,h=17,source=new Float32Array(w*h*4)
   for(let i=0;i<source.length;i+=4){const alpha=((i/4*13)%17)/16;for(let k=0;k<3;k++)source[i+k]=((i*7+k*37)%251)/250*alpha;source[i+3]=alpha}
   if(c.hdr)for(let i=0;i<source.length;i+=4)source[i]*=4
   const owned:any[]=[],own=(t:any)=>{owned.push(t);return t}
   try{
    const input=own(driver.uploadLinear(source,w,h)),a=own(c.scalar?driver.createScalarCoverage(w,h):driver.create(w,h)),b=own(c.scalar?driver.createScalarCoverage(w,h):driver.create(w,h))
    const bytes=c.box?rational_box_kernel_rgba(c.radius):c.radius>2048?rational_large_tent_kernel_rgba(c.radius):rational_tent_kernel_rgba(c.radius)
    const layout=c.radius>2048?exactFilterPacketLayout(bytes.length/4,driver.boundedShadowPacketMaxDimension):undefined
    const kernel=own(layout?driver.uploadBoundedShadowKernel(bytes,layout.width,layout.height,c.radius):driver.uploadRgba8(bytes,bytes.length/4,1))
    const rect={x:c.fractional ? .25 : -13,y:c.fractional?-.375:27,w,h}
    for(const axis of [0,1]){const u=parameters(rect,rect,{x:0,y:0,w:kernel.width,h:1});u[16]=22;u.set([c.radius,axis,Number(!!c.clamp),c.box?2:1],36)
     driver.pass(axis?b:a,u,[axis?a:input,kernel],undefined,c.channels??15,c.box?undefined:{kind:'tent',radius:c.radius})}
    const result=await driver.finish(b,rect,w,h,true,undefined,false,rect)
    if(!result.linear)throw Error('Missing float output')
    return {values:result.linear,passes:driver.canvasBlurPasses,draws:driver.drawCalls}
   }finally{for(const t of owned)driver.destroy(t)}
  }
  const cases:any[]=[]
  for(const radius of [.3,38.25948715209961,2048])for(const clamp of [false,true])cases.push({radius,clamp})
  for(const radius of [1,9,38,512])cases.push({radius,box:true})
  for(const scalar of [false,true])for(const radius of [16,2240.125,4096])for(const fractional of [false,true])cases.push({radius,scalar,fractional,channels:8})
  cases.push({radius:38.25,hdr:true})
  for(const c of cases){report.current=c;await publish();const a=await run(drivers[0],c),b=await run(drivers[1],c)
   if(!a.values.some(v=>v>0))throw Error('Empty control')
   report.cases.push({...c,...same(a.values,b.values),passes:[a.passes,b.passes],draws:[a.draws,b.draws]})}
 }finally{for(const driver of drivers)driver.dispose()}
 const font=new Uint8Array(await(await fetch('/fonts/NotoSansSC.ttf')).arrayBuffer())
 for(const name of ['117','fig']){
  const raw=await(await fetch(`/real-inputs/${name}.json`)).text(),doc=JSON.parse(raw)
  const engine=new VectorEngine();engine.load_font(font);const kernel=new RenderKernel(engine,'canvas')
  await kernel.load_document(raw)
  const board=doc.pages.flatMap((p:any)=>p.children.map((id:string)=>doc.nodes[id])).find((n:any)=>n?.name===(name==='117'?'117':'01_Dashboard')&&n.kind==='frame')
  if(!board)throw Error('Missing real board')
  const pageId=doc.pages.find((p:any)=>p.children.includes(board.id)).id
  const options=JSON.stringify({pageId,width:192,height:128,view:{x:-board.transform[4]-(name==='117'?600:240)-.125,y:-board.transform[5]-(name==='117'?100:50)+.375,zoom:1},rasterProfile:name==='117'?'figmaSubpixel':doc.rasterProfile||'analytic',transparent:true})
  const sceneA=decodeScenePacket(await kernel.compile_gpu_packet(options)),handoff=(await kernel.prepare_gpu_scene(options)).consume()
  const settings=kernel.color_settings(),owner=createDecodedImageOwner(),outputs:Float32Array[]=[]
  try{for(const scene of [sceneA,decodeScenePacket(handoff)]){
   const loader=managedSceneImageLoader(new DecodedImageCache(),()=>({kernel,scope:decodedImageScope(owner,settings),settings,current:()=>true,ownerCurrent:()=>true,resourceOwner:owner}),{key:async()=>undefined,read:async()=>undefined,write:()=>{}})
   const driver=await WebGpuDriver.create(true,false,!!doc.colorManagement,true,false),renderer=new GpuRenderer(driver,true,false,loader)
   try{const result=await renderer.render(scene,true,false);if(!result.linear)throw Error('Missing full graph pixels');outputs.push(result.linear)}finally{renderer.dispose()}
  }
  if(!outputs[0].some((v,i)=>i%4===3&&v>.1))throw Error('Empty real scene')
  report.cases.push({source:name,nodes:Object.keys(sceneA.nodes).length,transport:handoff.transport,...same(outputs[0],outputs[1])})
  outputs.forEach((values,index)=>preview(values,`${name} ${index?'scene handoff':'transport packet'}`,!!doc.colorManagement))
  }finally{engine.free()}
 }
 report.status='passed'
}catch(error){report.status='failed';report.error=String(error);report.stack=error instanceof Error?error.stack:undefined}
await publish()
