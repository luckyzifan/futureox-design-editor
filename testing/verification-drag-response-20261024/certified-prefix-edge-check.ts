import {initializePicking} from '../../frontend/design-client/src/kernel/picking'
import {WebGpuDriver} from '../../frontend/design-client/src/kernel/gpu/webgpu'
import {parameters,type GpuScene} from '../../frontend/design-client/src/kernel/gpu/types'
import {PREFIX_SCRATCH_BYTES} from '../../frontend/design-client/src/kernel/gpu/texture-prefix'
import {rational_tent_kernel_rgba,certified_tent_kernel_rgba} from '../../frontend/design-client/src/generated/design-kernel/design_kernel'
const report:any={status:'running',scope:'actual Apple WebGPU float words; native coefficient/resource proof and Q64 interval versus original full filter; no GUI/latency claim',cases:[]}
const publish=async()=>{(window as any).__tileReport=report;document.querySelector('#results')!.textContent=JSON.stringify({status:report.status,error:report.error});await fetch('/__render_report',{method:'POST',body:JSON.stringify(report)})}
let driver:WebGpuDriver|undefined
try{
 await initializePicking();const adapter=await navigator.gpu.requestAdapter();if(!adapter||adapter.info.isFallbackAdapter)throw Error('Hardware WebGPU required')
 report.adapter={vendor:adapter.info.vendor,architecture:adapter.info.architecture,fallback:adapter.info.isFallbackAdapter}
 driver=await WebGpuDriver.create(true,true,true,true,false)
 await driver.prepareScene({width:7,height:5,view:{x:0,y:0,zoom:1},background:'#fff',nodes:{},roots:[],vertices:[],curves:[],coherentSamples:true}as unknown as GpuScene)
 await driver.prepareFilters(true)
 const d=driver as any,policy=d.prefixPolicy,pair=d.certifiedTentPair
 for(const radius of [32,33.75523176884158,63.25,128.1927301,511.99999999,512]){
  for(const shape of ['gradient','signed-hdr','subnormal','wide','nan'])for(const axis of [0,1])for(const clamp of [false,true]){
   const w=33,h=13,values=new Float32Array(w*h*4),bits=new Uint32Array(values.buffer)
   for(let i=0;i<values.length;i++){
    if(shape==='gradient')values[i]=(i%29)/29
    else if(shape==='signed-hdr')bits[i]=((i&1)<<31)|((210+i%7)<<23)|(i*7919&0x7fffff)
    else if(shape==='subnormal')bits[i]=((i&1)<<31)|(i*7919&0x7fffff)
    else if(shape==='wide')bits[i]=i%11===0?0x7f7fffff:1
    else values[i]=i%17===0?NaN:(i%29)/29
   }
   const sourceRect={x:-3.25,y:7.75,w,h},targetRect={x:sourceRect.x+5.125,y:sourceRect.y+2.125,w:7,h:5}
   const row:any={radius,shape,axis,clamp,runs:[]};report.cases.push(row);let expected:Uint32Array|undefined
   for(const variant of ['reference','candidate']){
    d.certifiedTentPair=variant==='reference'?()=>false:pair
    d.prefixPolicy=variant==='reference'?()=>false:policy
    driver.begin(new Float32Array())
    const source=driver.uploadLinear(shape==='nan'?values.map(v=>Number.isFinite(v)?v:0):values,w,h),target=driver.create(7,5)
    if(shape==='nan'){
     // Authored/material uploads correctly reject NaN. Model an intermediate
     // GPU surface instead, invalidating the same certificates as a GPU write.
     d.invalidateTextureCertificates(source)
     d.device.queue.writeTexture({texture:source.resource},values,{bytesPerRow:w*16},[w,h])
    }
    delete source.opaqueAlpha
    const rb=rational_tent_kernel_rgba(radius),cb=certified_tent_kernel_rgba(radius)
    const rational=driver.uploadExactTentKernel(rb,rb.length/4,1,'rational-tent',radius)
    const certificate=driver.uploadExactTentKernel(cb,cb.length/4,1,'certified-tent',radius)
    try{
     const u=parameters(targetRect,sourceRect);u[16]=22;u[36]=radius;u[37]=axis;u[38]=Number(clamp)
     driver.prepareFilterPass(target,u,[source,rational,certificate],15,{kind:'tent',radius},PREFIX_SCRATCH_BYTES)
     const before=d.certifiedTentPasses
     driver.pass(target,u,[source,rational,certificate],undefined,15,{kind:'tent',radius})
     const result=await driver.finish(target,targetRect,7,5,true,undefined,false,targetRect)
     if(!result.linear)throw Error('Missing floating output')
     const actual=new Uint32Array(result.linear.buffer,result.linear.byteOffset,result.linear.length)
     expected??=actual.slice();let mismatches=0;for(let i=0;i<actual.length;i++)mismatches+=Number(actual[i]!==expected[i])
     row.runs.push({variant,mismatches,words:actual.length,certifiedTentPasses:d.certifiedTentPasses-before,stats:driver.stats().queueWaits})
     if(mismatches)throw Error(`Float bits changed in ${JSON.stringify({radius,shape,axis,clamp})}`)
     if(variant==='candidate'&&d.certifiedTentPasses===before)throw Error('Candidate dispatch was not exercised')
    }finally{for(const t of [source,target,rational,certificate])driver.destroy(t)}
   }
   await publish()
  }
 }
 d.prefixPolicy=policy;d.certifiedTentPair=pair;report.status='passed'
}catch(error){report.status='failed';report.error=String(error)}finally{driver?.dispose()}
await publish()
