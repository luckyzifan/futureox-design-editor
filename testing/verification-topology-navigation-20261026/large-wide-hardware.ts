import {initializeKernelModule} from '../../frontend/design-client/src/kernel/module'
import {rational_tent_kernel_rgba,rational_large_tent_kernel_rgba} from '../../frontend/design-client/src/generated/design-kernel/design_kernel'
import {WebGpuDriver} from '../../frontend/design-client/src/kernel/gpu/webgpu'
import {GpuRenderer} from '../../frontend/design-client/src/kernel/gpu/renderer'
const report:any={status:'running',configuration:{wide:import.meta.env.VITE_DESIGN_WIDE_RATIONAL_PREFIX,largeWide:import.meta.env.VITE_DESIGN_WIDE_RATIONAL_PREFIX_LARGE,largeShadow:import.meta.env.VITE_DESIGN_LARGE_SHADOW_TENT,wholeTent:import.meta.env.VITE_DESIGN_EXACT_WHOLE_TENT_2048,boundedShadow:import.meta.env.VITE_DESIGN_BOUNDED_SHADOW_TENT??'default'},scope:'large original rational kernels: scalar exact shader versus 256-bit prefix, actual float readback; no editor FPS claim',cases:[]}
const publish=async()=>{document.querySelector('#results')!.textContent=JSON.stringify(report,null,2);await fetch('/oracle-report',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(report)})}
try{
 await initializeKernelModule()
 const adapter=await navigator.gpu.requestAdapter();if(!adapter||adapter.info.isFallbackAdapter)throw Error('Hardware adapter unavailable')
 report.adapter={vendor:adapter.info.vendor,architecture:adapter.info.architecture,fallback:adapter.info.isFallbackAdapter};await publish()
 for(const [width,height,radius,range,outputX,outputWidth]of [
  [65,3,513.00000000001,'regular',0,65],
  [3072,8,1360.058160514733,'regular',1280,514],
  [514,16,2047.9999999999998,'regular',0,514],
  [128,8,777.1760917227046,'extreme',0,128],
  [128,8,777.1760917227046,'nonfinite',0,128],
  [514,32,1243.4817467563274,'alpha',0,514],
  [5000,8,2240,'regular',2240,514],
  [5000,8,2240.125,'alpha',2240,514],
  [65,3,4096,'regular',0,65],
 ] as const){
  const outputs:Float32Array[]=[],runs:any[]=[]
  for(const candidate of [false,true]){
   const driver=await WebGpuDriver.create(true,false,true,true,false),renderer=new GpuRenderer(driver,true,false) as any
   try{
    report.current={width,height,radius,range,candidate};await publish()
    await driver.prepareFilters(true);driver.begin(new Float32Array())
    const rect={x:0,y:0,w:width,h:height},outputRect={x:outputX,y:0,w:outputWidth,h:height}
    renderer.scene={integratedBlur:true,extent:rect,width,height,view:{x:0,y:0,zoom:1},roots:[],nodes:{}}
    renderer.prefixAllowed=candidate
    let dispatches=0,wideDispatches=0
    const prefix=(driver as any).prefix,encode=prefix.encode.bind(prefix)
    prefix.encode=(...args:any[])=>{dispatches++;if(args[13]===true)wideDispatches++;return encode(...args)}
    const data=Float32Array.from({length:width*height*4},(_,i)=>range==='alpha'?(i%4===3?(i%17)/16:0):i%4===3?1:i%17===0?1e-8:Math.fround(((i*19)%43-21)/8))
    if(range==='extreme'){data[0]=1.401298464324817e-45;data[4]=1e30;data[8]=-1e30}
    if(range==='nonfinite'){data[0]=NaN;data[4]=Infinity;data[8]=-Infinity}
    const texture=range==='nonfinite'?driver.create(width,height):driver.uploadLinear(data,width,height)
    if(range==='nonfinite')(driver as any).device.queue.writeTexture({texture:texture.resource},data,{bytesPerRow:width*16},[width,height])
    renderer.busy.add(texture);renderer.bytes+=texture.bytes;renderer.aliases.set(texture,1)
    const started=performance.now(),horizontal=renderer.exactTentAxis({texture,rect},radius,0,outputRect,undefined,false,false,false,range==='alpha'?8:15,radius>2048,true)
    const output=renderer.exactTentAxis(horizontal,radius,1,outputRect,undefined,false,false,false,range==='alpha'?8:15,radius>2048,true)
    outputs.push(await driver.readSurface(output.texture))
    const wallMs=performance.now()-started
    const counters=prefix.scratchBytes?await prefix.counters((driver as any).device.createCommandEncoder()):undefined
    runs.push({candidate,dispatches,wideDispatches,wallMs,counters,scratch:prefix.scratchBytes})
    await driver.abortFrameAndReleaseFilterScratch()
   }catch(error){report.deviceFailure={width,height,radius,range,candidate,errors:[...((driver as any).errors||[])],lost:driver.lost};throw error}finally{renderer.dispose()}
  }
  const bits=outputs.map(a=>new Uint32Array(a.buffer,a.byteOffset,a.length));let differences=0
  for(let i=0;i<bits[0].length;i++)if(bits[0][i]!==bits[1][i])differences++
  const packet=radius>2048?rational_large_tent_kernel_rgba(radius):rational_tent_kernel_rgba(radius),coefficientWords=new DataView(packet.buffer).getUint32(0,true)
  report.cases.push({width,height,radius,range,outputX,outputWidth,coefficientWords,packetBytes:packet.byteLength,words:bits[0].length,differences,runs});await publish()
  if(differences)throw Error('Wide rational pixels changed')
  if((range==='regular'||range==='alpha')&&(!runs[1].dispatches||!runs[1].counters?.acceptedLines))throw Error('Large wide path not exercised')
 }
 report.status='passed'
}catch(error){report.status='failed';report.error=String(error)}
await publish()
