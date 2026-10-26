import {initializeKernelModule} from '../../frontend/design-client/src/kernel/module'
import {rational_tent_kernel_rgba} from '../../frontend/design-client/src/generated/design-kernel/design_kernel'
import {WebGpuDriver} from '../../frontend/design-client/src/kernel/gpu/webgpu'
import {GpuRenderer} from '../../frontend/design-client/src/kernel/gpu/renderer'
const report:any={status:'running',scope:'exact original rational filter versus wider weighted prefix; original coefficient bytes and 4 MiB scratch, actual hardware float readback',cases:[]}
const publish=()=>{(window as any).__report=report;document.querySelector('#results')!.textContent=JSON.stringify(report)}
try{
 await initializeKernelModule()
 const adapter=await navigator.gpu.requestAdapter();if(!adapter||adapter.info.isFallbackAdapter)throw Error('Hardware adapter unavailable')
 report.adapter={vendor:adapter.info.vendor,architecture:adapter.info.architecture,fallback:adapter.info.isFallbackAdapter};publish()
 for(const [width,height,radius,range,clamp]of [
  [65,3,32.00000000000004,'regular',false],[65,5,48.1234567890123,'regular',false],
  [7,33,127.99999999999999,'regular',false],[31,7,511.99999999999994,'regular',false],
  [65,3,48.1234567890123,'extreme',false],[33,7,48.1234567890123,'nonfinite',false],
  [65,3,48.1234567890123,'regular',true],
  [1024,16,128.1234567890123,'regular',false],
  [514,32,255.9876543210987,'regular',false],
  [514,514,255.9876543210987,'regular',false],
 ] as const){
  const outputs:Float32Array[]=[],runs:any[]=[]
  for(const candidate of [false,true]){
   const driver=await WebGpuDriver.create(true,false,true,true,false),renderer=new GpuRenderer(driver,true,false) as any
   try{
    await driver.prepareFilters(true);driver.begin(new Float32Array())
    const rect={x:0,y:0,w:width,h:height}
    renderer.scene={integratedBlur:true,extent:rect,width,height,view:{x:0,y:0,zoom:1},roots:[],nodes:{}}
    renderer.prefixAllowed=candidate
    let dispatches=0
    const prefix=(driver as any).prefix,encode=prefix.encode.bind(prefix)
    prefix.encode=(...args:any[])=>{if(args[13]===true)dispatches++;return encode(...args)}
    const data=Float32Array.from({length:width*height*4},(_,i)=>i%4===3?1:i%17===0?1e-8:Math.fround(((i*19)%43-21)/8))
    if(range==='extreme'){data[0]=1.401298464324817e-45;data[4]=1e30;data[8]=-1e30}
    if(range==='nonfinite'){data[0]=NaN;data[4]=Infinity;data[8]=-Infinity}
    // Nonfinite values model a computed GPU intermediate. Material uploads
    // correctly reject them; this fixture does not change that admission.
    const texture=range==='nonfinite'?driver.create(width,height):driver.uploadLinear(data,width,height)
    if(range==='nonfinite')(driver as any).device.queue.writeTexture({texture:texture.resource},data,{bytesPerRow:width*16},[width,height])
    renderer.busy.add(texture);renderer.bytes+=texture.bytes;renderer.aliases.set(texture,1)
    const started=performance.now(),output=await renderer.blur({texture,rect},radius/2,clamp,false,false)
    outputs.push(await driver.readSurface(output.texture))
    const wallMs=performance.now()-started
    const counters=prefix.scratchBytes?await prefix.counters((driver as any).device.createCommandEncoder()):undefined
    runs.push({candidate,dispatches,wallMs,counters,scratch:prefix.scratchBytes})
    await driver.abortFrameAndReleaseFilterScratch()
   }finally{renderer.dispose()}
  }
  const bits=outputs.map(a=>new Uint32Array(a.buffer,a.byteOffset,a.length));let differences=0
  for(let i=0;i<bits[0].length;i++)if(bits[0][i]!==bits[1][i])differences++
  const coefficientWords=new DataView(rational_tent_kernel_rgba(radius).buffer).getUint32(0,true)
  report.cases.push({width,height,radius,range,clamp,coefficientWords,words:bits[0].length,differences,runs});publish()
  if(differences)throw Error('Wide rational pixels changed')
  if(range==='regular'&&(!clamp||import.meta.env.VITE_DESIGN_EXACT_CLAMP_PREFIX==='1')&&(!runs[1].dispatches||!runs[1].counters?.acceptedLines))throw Error('Wide path not exercised')
 }
 report.status='passed'
}catch(error){report.status='failed';report.error=String(error)}
publish()
