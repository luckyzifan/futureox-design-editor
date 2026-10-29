import { initializeKernelModule } from '../../frontend/design-client/src/kernel/module'
import { motion_blur_kernel, zoom_blur_coordinates } from '../../frontend/design-client/src/generated/design-kernel/design_kernel'
import { WebGpuDriver } from '../../frontend/design-client/src/kernel/gpu/webgpu'
import { parameters, type GpuScene, type Texture } from '../../frontend/design-client/src/kernel/gpu/types'
const report:any={status:'running',cases:[],timings:[],scope:'Native motion/zoom coordinate tables, isolated real Metal operator; synthetic boundary inputs supplement topology scenes.'}
async function publish(){document.querySelector('#result')!.textContent=JSON.stringify(report,null,2);await fetch('/report',{method:'POST',body:JSON.stringify(report)})}
const median=(v:number[])=>[...v].sort((a,b)=>a-b)[Math.floor(v.length/2)]
const encode=(v:number)=>{v=Math.max(0,Math.min(1,v));return v<=.0031308?v*12.92:1.055*v**(1/2.4)-.055}
function pixels(kind:string,w:number,h:number){const a=new Float32Array(w*h*4),bits=new Uint32Array(a.buffer);for(let i=0;i<a.length;i++){
 const alpha=((Math.floor(i/4)*13)%29)/28;a[i]=i%4===3?alpha:((i*17)%97)/96*alpha
 if(kind==='zero')a[i]=0;if(kind==='signed')a[i]=-.25-a[i];if(kind==='max')bits[i]=0x7f7fffff;if(kind==='nonfinite')bits[i]=i%3?0x7f800000:0x7fc01234
}return a}
function diff(a:Float32Array,b:Float32Array){let bits=0,max=0,alpha=0,nonfinite=0;const aa=new Uint32Array(a.buffer,a.byteOffset,a.length),bb=new Uint32Array(b.buffer,b.byteOffset,b.length)
 for(let i=0;i<a.length;i++){if(aa[i]!==bb[i])bits++;if(!Number.isFinite(a[i])||!Number.isFinite(b[i])){if(aa[i]!==bb[i])nonfinite++;continue}
  if(i%4===3)alpha=Math.max(alpha,Math.abs(a[i]-b[i]));else for(const bg of [0,1]){const j=i-i%4+3;max=Math.max(max,Math.abs(encode(a[i]+bg*(1-a[j]))-encode(b[i]+bg*(1-b[j]))))}}
 return {bits,max,alpha,nonfinite}}
try{
 await initializeKernelModule();const adapter=await navigator.gpu.requestAdapter();if(!adapter||adapter.info.isFallbackAdapter)throw Error('Hardware required')
 report.adapter={vendor:adapter.info.vendor,architecture:adapter.info.architecture,fallback:adapter.info.isFallbackAdapter}
 const driver=await WebGpuDriver.create(true,false,true,true,false)
 async function run(kind:string,amount:number,angle:number,input:Float32Array,w:number,h:number,candidate:boolean,hdr=false){
  driver.hdr=hdr
  const mode=kind==='motion'?61:62,rect={x:-13,y:27,w,h}
  const node:any={id:'n',rect,matrix:[1,0,0,1,0,0],size:[w,h],fill:{first:0,count:0,rect,rule:'nonzero'},strokes:[],fills:[],children:[],blend:'normal',opacity:1,effects:[{kind:kind+'-blur',visible:true}]}
  await driver.prepareScene({nodes:{n:node},roots:['n'],integratedBlur:false,canvasBlurApproximation:candidate} as unknown as GpuScene,true)
  driver.begin(new Float32Array());const owned:Texture[]=[],own=(t:Texture)=>{owned.push(t);return t}
  try{
   const finite=input.every(Number.isFinite),source=own(finite?driver.uploadLinear(input,w,h):driver.create(w,h)),target=own(driver.create(w,h))
   if(!finite)(driver as any).device.queue.writeTexture({texture:source.resource},input,{bytesPerRow:w*16,rowsPerImage:h},[w,h])
   const data=kind==='motion'?motion_blur_kernel(amount,angle,new Float64Array([1,0,0,1,0,0])):
     zoom_blur_coordinates(JSON.stringify({amount,center:[.35,.65]}),new Float64Array([1,0,0,1,-13,27]),new Float64Array([w,h]),JSON.stringify(rect))
   const kernel=own(driver.uploadParameters(data,256,data.length/1024)),u=parameters(rect,rect,{x:0,y:0,w:kernel.width,h:kernel.height});u[16]=mode
   const start=performance.now();driver.pass(target,u,[source,kernel]);const result=await driver.finish(target,rect,w,h,true,undefined,false,rect)
   if(!result.linear)throw Error('No spatial pixels')
   return {values:result.linear,wallMs:performance.now()-start,passes:kind==='motion'?driver.canvasMotionBlurPasses:driver.canvasZoomBlurPasses}
  }finally{for(const t of owned)driver.destroy(t)}
 }
 try{
  for(const kind of ['motion','zoom'])for(const amount of kind==='motion'?[1,8,32]:[1,12,60])for(const angle of kind==='motion'?[0,37,90]:[0])for(const pattern of ['normal','zero','signed','max','nonfinite']){
   report.current={kind,amount,angle,pattern};await publish();const w=33,h=17,input=pixels(pattern,w,h)
   const a=await run(kind,amount,angle,input,w,h,false),b=await run(kind,amount,angle,input,w,h,true),d=diff(a.values,b.values)
   report.cases.push({...report.current,...d,passes:b.passes})
   if(b.passes!==1||d.nonfinite||d.max>=1/255||d.alpha>=1/255||['signed','max','nonfinite'].includes(pattern)&&d.bits)throw Error('Spatial numeric gate failed')
  }
  for(const kind of ['motion','zoom']){const input=pixels('normal',33,17),a=await run(kind,8,37,input,33,17,false,true),b=await run(kind,8,37,input,33,17,true,true),d=diff(a.values,b.values)
   report.cases.push({kind,variant:'HDR',...d,passes:b.passes});if(d.bits||b.passes)throw Error('HDR spatial output changed')}
  for(const [kind,amount]of [['motion',8],['motion',32],['zoom',12]] as const){const input=pixels('normal',128,64),times:number[][]=[[],[]]
   for(let round=0;round<4;round++)for(const side of round%2?[1,0]:[0,1]){const r=await run(kind,amount,37,input,128,64,!!side);if(round)times[side].push(r.wallMs)}
   const controlMs=median(times[0]),candidateMs=median(times[1]);report.timings.push({kind,amount,times,controlMs,candidateMs,improvement:1-candidateMs/controlMs});await publish()
  }
  report.status='passed'
 }finally{driver.dispose()}
}catch(error){report.status='failed';report.error=String(error);report.stack=error instanceof Error?error.stack:undefined}
await publish()
